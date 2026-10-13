import type {
  CodeSelection,
  FileDiff,
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

  return {
    files,
    selection: input.selection,
    background: input.background?.trim() || undefined,
    descriptionCharacters,
    references: input.references ?? [],
    referenceCharacters,
    estimatedCharacters: estimatedCharacters + referenceCharacters + descriptionCharacters,
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
