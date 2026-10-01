import type { Finding } from './types';

export interface ReflectionVerdict {
  id: string;
  keep: boolean;
  reason: string;
}

export function reflectSystemPrompt(language: 'zh-CN' | 'en-US'): string {
  if (language === 'en-US') {
    return `You are the reflection module of a code review pipeline. For each candidate comment decide keep or drop.
Drop when: it is style preference or speculation without evidence; it repeats another candidate; it targets code outside the change; its location is wrong; it states something the code already handles.
Keep when: it points at a real defect, security risk, or behavioral regression with evidence in the snippet.
Output ONLY a JSON array: [{"id":"...","keep":true|false,"reason":"one sentence"}].`;
  }
  return `你是代码评审管线的反思模块。对每条候选评论判断 keep 或 drop。
drop 条件：纯风格偏好或无证据的猜测；与其他候选重复；指向变更之外的代码；位置错误；所述问题代码实际已处理。
keep 条件：指出真实缺陷、安全风险或行为回归，且片段中有证据。
只输出 JSON 数组：[{"id":"...","keep":true|false,"reason":"一句话"}]。`;
}

export function buildReflectionPayload(findings: Finding[]): string {
  return JSON.stringify(findings.map((finding) => ({
    id: finding.id,
    title: finding.title,
    path: finding.path,
    line: finding.line,
    severity: finding.severity,
    category: finding.category,
    evidence: finding.evidence[0]?.snippet ?? finding.existingCode,
    suggestion: finding.suggestionCode || finding.comment,
  })));
}

export function parseReflectionVerdicts(content: string): ReflectionVerdict[] {
  const candidates = [content, content.slice(content.indexOf('['), content.lastIndexOf(']') + 1)]
    .filter((item) => item.trim().startsWith('['));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!Array.isArray(parsed)) continue;
      const verdicts: ReflectionVerdict[] = [];
      for (const item of parsed) {
        const record = item as { id?: unknown; keep?: unknown; reason?: unknown };
        if (typeof record.id !== 'string' || typeof record.keep !== 'boolean') continue;
        verdicts.push({ id: record.id, keep: record.keep, reason: typeof record.reason === 'string' ? record.reason : '' });
      }
      if (verdicts.length > 0) return verdicts;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return [];
}
