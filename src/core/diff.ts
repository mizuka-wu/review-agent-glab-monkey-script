import type { DiffLine, FileDiff } from './types';
import { fullFileContext } from './full-file';

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunkId = '';

  for (const rawLine of diff.split(/\r?\n/)) {
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
  generated_file?: boolean;
}): FileDiff {
  return {
    oldPath: input.old_path,
    newPath: input.new_path,
    diff: input.diff ?? '',
    newFile: Boolean(input.new_file),
    deletedFile: Boolean(input.deleted_file),
    renamedFile: Boolean(input.renamed_file),
    lines: parseUnifiedDiff(input.diff ?? ''),
  };
}

export function findDiffLine(
  files: FileDiff[],
  path: string,
  side: 'old' | 'new',
  line: number,
) {
  const file = files.find(
    (candidate) => candidate.newPath === path || candidate.oldPath === path,
  );
  return file?.lines.find((candidate) =>
    side === 'new' ? candidate.newLine === line : candidate.oldLine === line,
  );
}

export function diffContext(files: FileDiff[], maxCharacters = 60_000) {
  const chunks: string[] = [];
  let used = 0;

  for (const file of files) {
    const context = fullFileContext(file);
    const chunk = `### ${file.newPath}\n${file.diff}${context ? `\n\n${context}` : ''}`;
    if (used + chunk.length > maxCharacters) {
      chunks.push(`### ${file.newPath}\n[diff omitted: context budget exceeded]`);
      break;
    }
    chunks.push(chunk);
    used += chunk.length;
  }

  return chunks.join('\n\n');
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
        const headerMatch = file.diff.match(new RegExp(`@@[^@]*${line.hunkId.replace(':', ',')}[^@]*@@[^\\n]*`));
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
