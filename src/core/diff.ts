import type { DiffLine, FileDiff } from './types';
import { fullFileContext } from './full-file';

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * diff 末尾的换行会切出一个空串，它不是 diff 行：当成 context 会凭空多出一行
 * （行号 = 最后一个 hunk 行的下一行），拿它发 position 一定被 GitLab 以
 * `line_code can't be blank` 400 拒掉。中间的空串仍按 context 处理——部分 GitLab
 * 版本会把空上下文行的前导空格吃掉。
 */
function diffRows(diff: string): string[] {
  const rows = diff.split(/\r?\n/);
  if (rows.at(-1) === '') rows.pop();
  return rows;
}

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunkId = '';

  for (const rawLine of diffRows(diff)) {
    const header = HUNK_HEADER.exec(rawLine);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunkId = `${header[1]}:${header[3]}`;
      continue;
    }

    if (!hunkId || rawLine === '\\ No newline at end of file') continue;

    if (rawLine.startsWith('+')) {
      lines.push({ hunkId, newLine, kind: 'added', text: rawLine.slice(1) });
      newLine += 1;
    } else if (rawLine.startsWith('-')) {
      lines.push({ hunkId, oldLine, kind: 'removed', text: rawLine.slice(1) });
      oldLine += 1;
    } else if (rawLine.startsWith(' ') || rawLine === '') {
      lines.push({ hunkId, oldLine, newLine, kind: 'context', text: rawLine.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }

  return lines;
}

export function normalizeFileDiff(input: {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  generated_file?: boolean | null;
  collapsed?: boolean | null;
  too_large?: boolean | null;
}): FileDiff {
  return {
    oldPath: input.old_path,
    newPath: input.new_path,
    diff: input.diff ?? '',
    newFile: Boolean(input.new_file),
    deletedFile: Boolean(input.deleted_file),
    renamedFile: Boolean(input.renamed_file),
    generated: Boolean(input.generated_file),
    collapsed: Boolean(input.collapsed),
    tooLarge: Boolean(input.too_large),
    lines: parseUnifiedDiff(input.diff ?? ''),
  };
}

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 仓库根相对路径的候选写法：解码 %2F 之外的转义、去掉 ./ 与重复斜杠，
 * 再补一个剥掉 diff 前缀 a/ b/ 的版本。剥前缀只对「真的存在同名文件」有意义，
 * 所以两种写法都返回，由调用方拿去和 diff 文件表比对。
 */
export function repoPathCandidates(value: string): string[] {
  const base = value.trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map(decodeSegment)
    .join('/');
  if (!base) return [];
  const unprefixed = base.replace(/^([ab])\//, '');
  return unprefixed === base ? [base] : [base, unprefixed];
}

/** 路径是否指同一个文件：候选写法任一相同即算，最后再按大小写不敏感兜底（Windows / macOS 仓库）。 */
export function repoPathEquals(left: string, right: string) {
  const rights = repoPathCandidates(right);
  const lowered = rights.map((item) => item.toLowerCase());
  return repoPathCandidates(left).some(
    (item) => rights.includes(item) || lowered.includes(item.toLowerCase()),
  );
}

export function findDiffLine(
  files: FileDiff[],
  path: string,
  side: 'old' | 'new',
  line: number,
) {
  const file = files.find(
    (candidate) => repoPathEquals(candidate.newPath, path) || repoPathEquals(candidate.oldPath, path),
  );
  return file?.lines.find((candidate) =>
    side === 'new' ? candidate.newLine === line : candidate.oldLine === line,
  );
}

/** 行号标记与内容之间的分隔：空行只有标记，不留悬空的尾随空格。 */
function numberedBody(rawLine: string) {
  const text = rawLine.slice(1);
  return text ? ` ${text}` : '';
}

/**
 * 给 unified diff 的每一行加上显式行号前缀：`+L23 内容`（new 侧）/ `-L17 内容`（old 侧）/ ` L5 内容`（上下文行，标 new 侧）。
 * 模型拿到的原始 diff 里根本没有行号，只能从 @@ 头一行行往下数：多 hunk、长上下文、相似代码时数错是常态，
 * 行号一错就锚不上 diff 行，只能降级成全文评论——这是「很容易没办法行内评论」的主因。
 * hunk 头原样保留；hunk 之外的行（diff --git / index / --- / +++ / \ No newline）不参与编号，也原样透出。
 */
export function numberedDiff(diff: string): string {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  return diffRows(diff).map((rawLine) => {
    const header = HUNK_HEADER.exec(rawLine);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      inHunk = true;
      return rawLine;
    }
    if (!inHunk) return rawLine;

    if (rawLine.startsWith('+')) {
      const numbered = `+L${newLine}${numberedBody(rawLine)}`;
      newLine += 1;
      return numbered;
    }
    if (rawLine.startsWith('-')) {
      const numbered = `-L${oldLine}${numberedBody(rawLine)}`;
      oldLine += 1;
      return numbered;
    }
    if (rawLine.startsWith(' ') || rawLine === '') {
      const numbered = ` L${newLine}${numberedBody(rawLine)}`;
      oldLine += 1;
      newLine += 1;
      return numbered;
    }
    return rawLine;
  }).join('\n');
}

/** 格式说明写在 diff 前面：模型读到第一行代码之前先知道行首的数字是什么、该怎么引用。 */
export const NUMBERED_DIFF_LEGEND =
  '（下面每个文件的 diff 每行行首都带显式行号：`+L23` = 新增行在 new 侧的第 23 行，`-L17` = 删除行在 old 侧的第 17 行，` L5` = 上下文行在 new 侧的第 5 行。line / endLine 直接抄行首的数字，不要从 @@ 头自己推算；existingCode 抄行内容本身，不要带 L 行号前缀。）';

/** 一个文件进模型上下文的字符开销：按真正发出去的带行号 diff 算，行号前缀如实计入预算。 */
export function diffPromptSize(file: FileDiff): number {
  return numberedDiff(file.diff).length + file.newPath.length;
}

export function diffContext(files: FileDiff[], maxCharacters = 60_000) {
  const chunks: string[] = [];
  let used = NUMBERED_DIFF_LEGEND.length + 2;

  for (const file of files) {
    const context = fullFileContext(file);
    const chunk = `### ${file.newPath}\n${numberedDiff(file.diff)}${context ? `\n\n${context}` : ''}`;
    if (used + chunk.length > maxCharacters) {
      chunks.push(`### ${file.newPath}\n[diff omitted: context budget exceeded]`);
      break;
    }
    chunks.push(chunk);
    used += chunk.length;
  }

  return chunks.length > 0 ? `${NUMBERED_DIFF_LEGEND}\n\n${chunks.join('\n\n')}` : '';
}

// --- Hunk extraction ---

export interface DiffHunk {
  fileId: string;
  filePath: string;
  hunkId: string;
  header: string;
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
}

/**
 * Extract individual diff hunks from parsed diff files.
 * Each hunk is a group of changed lines with its @@ header.
 */
export function extractHunks(files: FileDiff[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];

  for (const file of files) {
    const hunkMap = new Map<string, { header: string; lines: DiffLine[] }>();

    for (const line of file.lines) {
      if (!hunkMap.has(line.hunkId)) {
        // Find the @@ header from the raw diff
        // hunkId is "oldStart:newStart", e.g. "1:3"
        const [oldStart, newStart] = line.hunkId.split(':');
        const escapedOld = oldStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedNew = newStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headerPattern = new RegExp(`@@\\s+-${escapedOld}(?:,\\d+)?\\s+\\+${escapedNew}(?:,\\d+)?\\s+@@[^\\n]*`);
        const headerMatch = file.diff.match(headerPattern);
        hunkMap.set(line.hunkId, {
          header: headerMatch?.[0] ?? `@@ ${line.hunkId} @@`,
          lines: [],
        });
      }
      hunkMap.get(line.hunkId)!.lines.push(line);
    }

    for (const [hunkId, data] of hunkMap) {
      hunks.push({
        fileId: `${file.newPath}:${hunkId}`,
        filePath: file.newPath,
        hunkId,
        header: data.header,
        lines: data.lines,
        addedCount: data.lines.filter((l) => l.kind === 'added').length,
        removedCount: data.lines.filter((l) => l.kind === 'removed').length,
      });
    }
  }

  return hunks;
}

/**
 * Build context from specific hunks only (for hunk-level review).
 */
export function hunkContext(hunks: DiffHunk[]): string {
  return hunks.map((hunk) => {
    const diffText = hunk.lines.map((line) => {
      const prefix = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
      return `${prefix}${line.text}`;
    }).join('\n');
    return `### ${hunk.filePath}\n${hunk.header}\n${diffText}`;
  }).join('\n\n');
}
