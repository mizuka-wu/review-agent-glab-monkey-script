import { MR_DESCRIPTION_BUDGET_CHARACTERS, formatMrCommits, truncateToBudget } from './context';
import { diffContext } from './diff';
import { enabledRulesOf, type RulePack } from './rule-packs';
import type { FileDiff, MrCommit } from './types';

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
  /** MR 说明：外部 Agent 同样需要需求背景才能判断实现是否符合意图。 */
  description?: string;
  /** MR 提交记录：需求细节常常只写在 commit message 里。 */
  commits?: MrCommit[];
  /** 与设置里的两个开关一致：关掉的那一段连标题都不导出，不留 `(无)` 空块。 */
  includeDescription?: boolean;
  includeCommits?: boolean;
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
    ...(input.includeDescription === false ? [] : [
      '## MR 说明',
      input.description?.trim()
        ? truncateToBudget(input.description.trim(), MR_DESCRIPTION_BUDGET_CHARACTERS)
        : '(无)',
      '',
    ]),
    ...(input.includeCommits === false ? [] : [
      '## MR Commits',
      formatMrCommits(input.commits ?? []) || '(无)',
      '',
    ]),
    '## 参考背景',
    input.background?.trim() || '(无)',
    '',
    '## 输出要求',
    '只输出 JSON 数组，元素字段：title, severity(critical|high|medium|low), category, confidence,',
    'path, line, endLine, existingCode, suggestion, reason, content, evidence:[{path,line,snippet}]。',
    '没有真实问题就输出 []。',
  ].join('\n');
}
