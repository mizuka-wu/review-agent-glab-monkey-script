import { diffContext } from './diff';
import type {
  CodeSelection,
  FileDiff,
  ReviewContext,
  ReviewContextFile,
} from './types';

const lockfilePattern = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/i;
const secretPattern = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|key))$/i;
const generatedPattern = /(?:^|\/)(?:dist|build|vendor|node_modules|coverage|target)\/|(?:\.min\.js|\.generated\.|_generated\.|\.lock$)/i;

function isReviewable(file: FileDiff): NonNullable<ReviewContextFile['omittedReason']> | undefined {
  if (file.binary) return 'binary';
  if (file.generated || generatedPattern.test(file.newPath)) return 'generated';
  if (lockfilePattern.test(file.newPath)) return 'lockfile';
  if (secretPattern.test(file.newPath)) return 'secret';
  if (!file.newPath || file.newPath === '/dev/null') return 'unsupported';
  return undefined;
}

export function selectionFile(selection: CodeSelection): FileDiff {
  return {
    oldPath: selection.filePath,
    newPath: selection.filePath,
    diff: selection.text.split('\n').map((line) => `+${line}`).join('\n'),
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    lines: selection.text.split('\n').map((text, index) => ({
      hunkId: 'selection',
      newLine: selection.startLine + index,
      kind: 'added',
      text,
    })),
  };
}

export function buildReviewContext(input: {
  files: FileDiff[];
  selection?: CodeSelection;
  background?: string;
  budgetCharacters?: number;
}): ReviewContext {
  const budgetCharacters = input.budgetCharacters ?? 60_000;
  const sourceFiles = input.files.length > 0 ? input.files : input.selection ? [selectionFile(input.selection)] : [];
  const files: ReviewContextFile[] = [];
  const omittedFiles: ReviewContext['omittedFiles'] = [];
  let estimatedCharacters = 0;

  for (const file of sourceFiles) {
    const reason = isReviewable(file);
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

  return {
    files,
    selection: input.selection,
    background: input.background?.trim() || undefined,
    estimatedCharacters,
    budgetCharacters,
    omittedFiles,
  };
}

export function includedFiles(context: ReviewContext): FileDiff[] {
  return context.files
    .filter((file) => file.included)
    .map(({ included: _included, omittedReason: _omittedReason, ...file }) => file);
}

export function contextText(context: ReviewContext) {
  return diffContext(includedFiles(context), context.budgetCharacters);
}
