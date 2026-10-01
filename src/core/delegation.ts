import { diffContext } from './diff';
import { enabledRulesOf, type RulePack } from './rule-packs';
import type { FileDiff } from './types';

export interface DelegationMeta {
  project?: string;
  mergeRequestIid?: number;
  headSha?: string;
}

/**
 * Delegation 上下文：文件选择与规则解析已在本地完成，导出给外部 Agent 用其自有模型评审。
 * 输出为 Markdown，末尾给出与本项目 parseModelFindings 兼容的结果 schema。
 */
export function buildDelegationContext(input: {
  files: FileDiff[];
  packs: RulePack[];
  background?: string;
  meta?: DelegationMeta;
}): string {
  const rules = enabledRulesOf(input.packs);
  const fileLines = input.files.map((file) => {
    const added = file.lines.filter((line) => line.kind === 'added').length;
    const removed = file.lines.filter((line) => line.kind === 'removed').length;
    return `- ${file.newPath}（+${added} -${removed}）`;
  });
  const ruleLines = rules.map(({ pack, rule }) =>
    `- [${rule.id}] ${rule.title}（${rule.severity}/${rule.category}，包 ${pack.name}`
    + `${rule.languages?.length ? `，语言 ${rule.languages.join('/')}` : ''}`
    + `${rule.scope ? `，scope ${rule.scope.include?.join(',') ?? '*'}` : ''}）`);
  return [
    '# Review Delegation 上下文',
    '',
    '> 由 Review Agent for GitLab 导出：文件选择与规则解析已完成，请外部模型仅做语义评审并输出 JSON。',
    '',
    '## MR',
    `- project: ${input.meta?.project ?? '(unknown)'}`,
    `- merge_request: !${input.meta?.mergeRequestIid ?? '-'}`,
    `- head: ${input.meta?.headSha ?? '(unknown)'}`,
    '',
    `## 变更文件（${input.files.length}）`,
    ...fileLines,
    '',
    `## 适用规则（${rules.length}）`,
    ...ruleLines,
    '',
    '## Diff 上下文',
    '```diff',
    diffContext(input.files),
    '```',
    '',
    '## 参考背景',
    input.background?.trim() || '(无)',
    '',
    '## 输出要求',
    '只输出 JSON 数组，元素字段：title, severity(critical|high|medium|low), category, confidence,',
    'path, line, endLine, existingCode, suggestion, reason, content, evidence:[{path,line,snippet}]。',
    '没有真实问题就输出 []。',
  ].join('\n');
}
