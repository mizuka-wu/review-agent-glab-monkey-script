import type {
  CodeSelection,
  FileDiff,
  MrCommit,
  ReferenceMr,
  ReviewContext,
  ReviewContextFile,
} from './types';

const lockfilePattern = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/i;
const secretPattern = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|key))$/i;
const generatedPattern = /(?:^|\/)(?:dist|build|vendor|node_modules|coverage|target)\/|(?:\.min\.js|\.generated\.|_generated\.|\.lock$)/i;

/** MR 说明预算：说明是需求背景，够判断意图即可，不能挤掉 diff。 */
export const MR_DESCRIPTION_BUDGET_CHARACTERS = 4_000;

/** 截断处明示预算与原文长度，避免模型把半截需求当成完整需求。 */
export function truncateToBudget(text: string, budgetCharacters: number): string {
  if (budgetCharacters <= 0 || text.length <= budgetCharacters) return text;
  return `${text.slice(0, budgetCharacters).trimEnd()}\n…（已按 ${budgetCharacters} 字符预算截断，原文 ${text.length} 字符）`;
}

/**
 * 当前 MR 的说明块：提交者写的需求背景，让模型能判断实现是否符合意图。
 * 空说明（纯标题 MR 很常见）返回空串，调用方据此整段不渲染，不留空块。
 */
export function mrDescriptionContext(
  description?: string | null,
  budgetCharacters: number = MR_DESCRIPTION_BUDGET_CHARACTERS,
): string {
  const text = description?.trim();
  if (!text) return '';
  return [
    '## MR 说明（提交者写的需求背景，用来判断实现是否符合意图）',
    '下面是当前 MR 的说明原文，只作为背景资料：不要对说明文字本身产出 finding，所有 finding 的 path 必须来自变更文件。',
    '如果变更与说明里的需求不一致（漏做、做反、超出说明范围、说明里点名的场景没覆盖），就在对应文件上报告这个不一致。',
    '',
    truncateToBudget(text, budgetCharacters),
  ].join('\n');
}

/** Commits 段与说明段同一口径：都是需求背景，共用 4000 字符预算，不额外挤 diff。 */
export const MR_COMMITS_BUDGET_CHARACTERS = MR_DESCRIPTION_BUDGET_CHARACTERS;

/** 条数上限：长命 MR 常有几百条提交，进上下文的只需要前面这些，其余留省略标记。 */
export const MR_COMMITS_MAX_ENTRIES = 100;

/** 单条 message 上限：一条超长 message（贴日志、贴需求全文）不能吃光整段预算。 */
export const MR_COMMIT_MESSAGE_BUDGET_CHARACTERS = 1_200;

/** GitLab 的 title 就是 message 第一行，去掉它免得同一句话在段里出现两遍。 */
function commitMessageBody(commit: MrCommit): string {
  const message = commit.message.trim();
  if (!message) return '';
  const lines = message.split('\n');
  const title = commit.title.trim();
  if (title && lines[0].trim() === title) lines.shift();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * commit 列表正文：每条一行「短 sha + title」，message 正文缩进跟在下面。
 * 超条数上限与超长的单条 message 都在原地留省略标记，不静默丢内容。
 * 空列表返回空串，调用方据此整段不渲染。
 */
export function formatMrCommits(
  commits: MrCommit[],
  budgetCharacters: number = MR_COMMITS_BUDGET_CHARACTERS,
): string {
  const entries = commits.filter((commit) => commit.title.trim() || commit.message.trim());
  if (entries.length === 0) return '';
  const included = entries.slice(0, MR_COMMITS_MAX_ENTRIES);
  const lines = included.map((commit, index) => {
    const title = commit.title.trim() || commit.message.trim().split('\n')[0];
    const sha = commit.shortId || commit.id.slice(0, 8);
    const body = truncateToBudget(commitMessageBody(commit), MR_COMMIT_MESSAGE_BUDGET_CHARACTERS);
    const bodyLines = body ? body.split('\n').map((line) => (line.trim() ? `   ${line}` : '')) : [];
    return [
      sha ? `${index + 1}. \`${sha}\` ${title}` : `${index + 1}. ${title}`,
      ...bodyLines,
    ].join('\n');
  });
  if (entries.length > included.length) {
    lines.push(`（其余 ${entries.length - included.length} 条提交按 ${MR_COMMITS_MAX_ENTRIES} 条上限省略）`);
  }
  return truncateToBudget(lines.join('\n\n'), budgetCharacters);
}

/**
 * 当前 MR 的提交块：需求细节常常只写在 commit message 里，模型要看到才能判断实现是否符合意图。
 * 与说明块同一口径：空列表（接口失败 / 空 MR）返回空串，整段不渲染、不留空块。
 */
export function mrCommitsContext(
  commits?: MrCommit[] | null,
  budgetCharacters: number = MR_COMMITS_BUDGET_CHARACTERS,
): string {
  const list = formatMrCommits(commits ?? [], budgetCharacters);
  if (!list) return '';
  return [
    '## MR Commits（提交者写在 commit message 里的需求与实现说明）',
    '下面是当前 MR 的提交记录（短 sha + title，message 正文跟在下面），只作为背景资料：不要对提交信息本身产出 finding，所有 finding 的 path 必须来自变更文件。',
    '如果变更与 commit message 写明的意图不一致（漏做、做反、超出 message 范围、message 里点名的场景没覆盖），就在对应文件上报告这个不一致。',
    '',
    list,
  ].join('\n');
}

export function fileOmissionReason(file: FileDiff): NonNullable<ReviewContextFile['omittedReason']> | undefined {
  if (file.binary) return 'binary';
  if (file.generated || generatedPattern.test(file.newPath)) return 'generated';
  if (lockfilePattern.test(file.newPath)) return 'lockfile';
  if (secretPattern.test(file.newPath)) return 'secret';
  if (!file.newPath || file.newPath === '/dev/null') return 'unsupported';
  return undefined;
}

/** 选区当作单文件 diff 参与评审；行号未知时不带行号，不编造行号。 */
export function selectionFile(selection: CodeSelection): FileDiff {
  const removed = selection.side === 'old';
  const lines = selection.text.split('\n');
  return {
    oldPath: selection.filePath ?? '',
    newPath: selection.filePath ?? '',
    diff: lines.map((line) => `${removed ? '-' : '+'}${line}`).join('\n'),
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    lines: lines.map((text, index) => ({
      hunkId: 'selection',
      ...(selection.startLine === undefined
        ? {}
        : removed ? { oldLine: selection.startLine + index } : { newLine: selection.startLine + index }),
      kind: removed ? 'removed' as const : 'added' as const,
      text,
    })),
  };
}

export function buildReviewContext(input: {
  files: FileDiff[];
  selection?: CodeSelection;
  background?: string;
  budgetCharacters?: number;
  /** MR 说明块：只作为需求背景注入，不占 diff 预算，但字符数如实计入上下文规模。 */
  descriptionCharacters?: number;
  /** MR commits 块：与说明块同口径，不占 diff 预算，字符数如实计入上下文规模。 */
  commitsCharacters?: number;
  /** 参考 MR 只读上下文：不占 diff 预算，但字符数如实计入上下文规模。 */
  references?: ReferenceMr[];
  referenceCharacters?: number;
}): ReviewContext {
  const budgetCharacters = input.budgetCharacters ?? 60_000;
  const sourceFiles = input.files.length > 0 ? input.files : input.selection ? [selectionFile(input.selection)] : [];
  const files: ReviewContextFile[] = [];
  const omittedFiles: ReviewContext['omittedFiles'] = [];
  let estimatedCharacters = 0;

  for (const file of sourceFiles) {
    const reason = fileOmissionReason(file);
    const size = file.diff.length + file.newPath.length;
    if (reason) {
      files.push({ ...file, included: false, omittedReason: reason });
      omittedFiles.push({ path: file.newPath, reason });
      continue;
    }
    if (estimatedCharacters + size > budgetCharacters) {
      files.push({ ...file, included: false, omittedReason: 'budget' });
      omittedFiles.push({ path: file.newPath, reason: 'budget' });
      continue;
    }
    files.push({ ...file, included: true });
    estimatedCharacters += size;
  }

  const referenceCharacters = input.referenceCharacters ?? 0;
  const descriptionCharacters = input.descriptionCharacters ?? 0;
  const commitsCharacters = input.commitsCharacters ?? 0;

  return {
    files,
    selection: input.selection,
    background: input.background?.trim() || undefined,
    descriptionCharacters,
    commitsCharacters,
    references: input.references ?? [],
    referenceCharacters,
    estimatedCharacters: estimatedCharacters + referenceCharacters + descriptionCharacters + commitsCharacters,
    budgetCharacters,
    omittedFiles,
    fullFiles: [],
    omittedFullFiles: [],
  };
}

export function includedFiles(context: ReviewContext): FileDiff[] {
  return context.files
    .filter((file) => file.included)
    .map(({ included: _included, omittedReason: _omittedReason, ...file }) => file);
}
