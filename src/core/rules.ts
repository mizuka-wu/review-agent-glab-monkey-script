import { fingerprintFinding } from './findings';
import type { Finding, FileDiff } from './types';

const testPattern = /(?:\.test\.|\.spec\.|\/__tests__\/|\/tests?\/)/i;

function makeFinding(input: {
  file: FileDiff;
  line: number;
  endLine?: number;
  category: Finding['category'];
  severity: Finding['severity'];
  title: string;
  content: string;
  existingCode: string;
  suggestionCode?: string;
}): Finding {
  const path = input.file.newPath;
  const fingerprint = fingerprintFinding({
    path,
    existingCode: input.existingCode,
    category: input.category,
    title: input.title,
  });
  return {
    id: fingerprint,
    fingerprint,
    path,
    line: input.line,
    endLine: input.endLine ?? input.line,
    side: 'new',
    category: input.category,
    severity: input.severity,
    confidence: 'medium',
    title: input.title,
    content: input.content,
    evidence: [{ path, lines: `L${input.line}`, quote: input.existingCode }],
    existingCode: input.existingCode,
    suggestionCode: input.suggestionCode ?? '',
    comment: `${input.title}\n\n${input.content}`,
    source: 'rule',
    status: 'draft',
  };
}

export function runRuleReview(files: FileDiff[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    for (const line of file.lines.filter((candidate) => candidate.kind === 'added')) {
      const code = line.text;
      const lineNo = line.newLine ?? 1;

      if (/console\.(?:log|debug)\s*\(/.test(code)) {
        findings.push(
          makeFinding({
            file,
            line: lineNo,
            category: 'maintainability',
            severity: 'low',
            title: '新增调试日志可能泄漏运行时信息',
            content: '生产代码中的 console.log/debug 会污染日志，并可能输出用户或令牌信息。建议改用受控 logger 或在合并前移除。',
            existingCode: code,
            suggestionCode: code.replace(/console\.(?:log|debug)/, 'logger.debug'),
          }),
        );
      }

      if (/\b(?:password|api[_-]?key|access[_-]?token|secret)\b\s*[:=]/i.test(code)) {
        findings.push(
          makeFinding({
            file,
            line: lineNo,
            category: 'security',
            severity: 'high',
            title: '代码中疑似硬编码敏感信息',
            content: '新增赋值涉及密码、Token 或 API Key。应从安全配置或密钥管理服务读取，并确认该值没有进入日志和构建产物。',
            existingCode: code,
            suggestionCode: code.replace(/[:=]\s*["'][^"']+["']/, ': process.env.SECRET'),
          }),
        );
      }

      if (/\bany\b|@ts-ignore|catch\s*\([^)]*\)\s*\{\s*\}/.test(code)) {
        findings.push(
          makeFinding({
            file,
            line: lineNo,
            category: 'bug',
            severity: 'medium',
            title: '异常处理或类型边界被弱化',
            content: 'any、@ts-ignore 或空 catch 会隐藏类型错误与失败路径。建议保留精确类型并显式处理异常。',
            existingCode: code,
          }),
        );
      }

      if (/\b(?:TODO|FIXME|HACK)\b/i.test(code)) {
        findings.push(
          makeFinding({
            file,
            line: lineNo,
            category: 'maintainability',
            severity: 'low',
            title: '变更引入未完成标记',
            content: 'TODO/FIXME/HACK 表示实现或修复尚未完成。建议在合并前完成处理，或关联可追踪的问题。',
            existingCode: code,
          }),
        );
      }
    }

    if (file.lines.some((line) => line.kind === 'added') && !testPattern.test(file.newPath)) {
      const hasTestChange = files.some((candidate) => testPattern.test(candidate.newPath));
      if (!hasTestChange) {
        const firstAdded = file.lines.find((line) => line.kind === 'added');
        findings.push(
          makeFinding({
            file,
            line: firstAdded?.newLine ?? 1,
            category: 'test',
            severity: 'low',
            title: '本次实现变更缺少回归测试',
            content: 'Diff 中没有测试文件变更。建议至少覆盖新增分支、失败路径和边界条件。',
            existingCode: firstAdded?.text ?? file.newPath,
          }),
        );
      }
    }
  }

  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) return false;
    seen.add(finding.fingerprint);
    return true;
  });
}
