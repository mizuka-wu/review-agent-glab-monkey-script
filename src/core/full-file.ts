import type {
  FullFileOmission,
  FullFileSnapshot,
  FileDiff,
} from './types';

export type FullFileLoader = (path: string, ref: string, signal?: AbortSignal) => Promise<string>;

export interface FullFileLoadOptions {
  maxFiles?: number;
  maxFileCharacters?: number;
  maxTotalCharacters?: number;
}

export interface FullFileLoadResult {
  files: FullFileSnapshot[];
  omitted: FullFileOmission[];
}

export function splitFileLines(content: string) {
  return content.replace(/\r\n/g, '\n').split('\n');
}

export function createFullFileSnapshot(path: string, ref: string, content: string): FullFileSnapshot {
  return { path, ref, content, lines: splitFileLines(content) };
}

function lineGroups(lines: DiffAnchorLine[], padding: number) {
  const groups: { start: number; end: number }[] = [];
  for (const line of lines) {
    const start = Math.max(1, line - padding);
    const end = line + padding;
    const previous = groups.at(-1);
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      groups.push({ start, end });
    }
  }
  return groups;
}

type DiffAnchorLine = number;

export function fullFileContext(file: FileDiff, maxCharacters = 12_000, padding = 8) {
  if (!file.newFileContent) return '';
  const lines = splitFileLines(file.newFileContent);
  const anchors = [...new Set(file.lines.map((line) => line.newLine).filter((line): line is number => Boolean(line)))];
  const groups = anchors.length > 0
    ? lineGroups(anchors, padding)
    : [{ start: 1, end: Math.min(lines.length, padding * 2 + 1) }];
  const chunks: string[] = [];
  let used = 0;

  for (const group of groups) {
    const start = Math.max(1, group.start);
    const end = Math.min(lines.length, group.end);
    if (start > end) continue;
    const chunk = `#### ${file.newPath} L${start}-${end}\n${lines.slice(start - 1, end)
      .map((text, offset) => `${start + offset}: ${text}`)
      .join('\n')}`;
    if (used + chunk.length > maxCharacters) {
      chunks.push(`#### ${file.newPath}\n[full-file context omitted: budget exceeded]`);
      break;
    }
    chunks.push(chunk);
    used += chunk.length;
  }

  return chunks.join('\n\n');
}

export async function loadFullFiles(
  paths: string[],
  ref: string,
  loader: FullFileLoader,
  options: FullFileLoadOptions = {},
  signal?: AbortSignal,
): Promise<FullFileLoadResult> {
  const maxFiles = options.maxFiles ?? 20;
  const maxFileCharacters = options.maxFileCharacters ?? 1_000_000;
  const maxTotalCharacters = options.maxTotalCharacters ?? 2_000_000;
  const files: FullFileSnapshot[] = [];
  const omitted: FullFileOmission[] = [];
  const seen = new Set<string>();

  // Deduplicate and filter paths
  const validPaths: string[] = [];
  for (const rawPath of paths) {
    const path = rawPath.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (validPaths.length >= maxFiles) {
      omitted.push({ path, reason: 'budget', message: '完整文件数量达到上限' });
      continue;
    }
    validPaths.push(path);
  }

  // Load files concurrently with a limit of 5
  const CONCURRENCY = 5;
  const results: { path: string; content?: string; error?: string }[] = [];

  for (let i = 0; i < validPaths.length; i += CONCURRENCY) {
    const batch = validPaths.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (path) => {
        try {
          const content = await loader(path, ref, signal);
          return { path, content };
        } catch (error) {
          if ((error as Error).name === 'AbortError') throw error;
          return { path, error: String(error) };
        }
      }),
    );
    results.push(...batchResults);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  let totalCharacters = 0;
  for (const result of results) {
    if (result.error) {
      omitted.push({ path: result.path, reason: 'read_error', message: result.error });
      continue;
    }
    const content = result.content!;
    if (content.length > maxFileCharacters) {
      omitted.push({ path: result.path, reason: 'too_large', message: `文件超过 ${maxFileCharacters} 字符` });
      continue;
    }
    if (totalCharacters + content.length > maxTotalCharacters) {
      omitted.push({ path: result.path, reason: 'budget', message: '完整文件总预算不足' });
      continue;
    }
    files.push(createFullFileSnapshot(result.path, ref, content));
    totalCharacters += content.length;
  }

  return { files, omitted };
}

export function mergeFullFiles(current: FullFileSnapshot[], additions: FullFileSnapshot[]) {
  const byPath = new Map(current.map((file) => [file.path, file]));
  for (const file of additions) byPath.set(file.path, file);
  return [...byPath.values()];
}
