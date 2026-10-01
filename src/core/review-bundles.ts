import type { FileDiff } from './types';

export interface BundleOptions {
  maxFiles?: number;
  maxChars?: number;
}

export function fileCharSize(file: FileDiff): number {
  return file.diff.length + file.newPath.length;
}

/**
 * 把变更文件按目录聚合成评审分组：同目录文件共享上下文，超过文件数/字符预算时拆分。
 * 小规模变更返回单个分组，保持与单上下文评审一致的行为。
 */
export function groupFilesIntoBundles(files: FileDiff[], options: BundleOptions = {}): FileDiff[][] {
  const maxFiles = options.maxFiles ?? 6;
  const maxChars = options.maxChars ?? 60_000;
  if (files.length === 0) return [];
  const totalChars = files.reduce((sum, file) => sum + fileCharSize(file), 0);
  if (files.length <= maxFiles && totalChars <= maxChars) return [files];

  const byDir = new Map<string, FileDiff[]>();
  for (const file of files) {
    const dir = file.newPath.includes('/') ? file.newPath.slice(0, file.newPath.lastIndexOf('/')) : '(root)';
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }

  const bundles: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length > 0) {
      bundles.push(current);
      current = [];
      currentChars = 0;
    }
  };
  for (const list of byDir.values()) {
    let index = 0;
    while (index < list.length) {
      if (current.length >= maxFiles || currentChars >= maxChars) flush();
      const room = maxFiles - current.length;
      let taken = 0;
      let chars = currentChars;
      while (taken < Math.min(room, list.length - index) && chars + fileCharSize(list[index + taken]) <= maxChars) {
        chars += fileCharSize(list[index + taken]);
        taken += 1;
      }
      if (taken === 0) {
        flush();
        current = [list[index]];
        currentChars = fileCharSize(list[index]);
        index += 1;
        flush();
        continue;
      }
      current.push(...list.slice(index, index + taken));
      currentChars = chars;
      index += taken;
    }
  }
  flush();
  return bundles;
}

/** 受限并发映射：保持结果顺序，失败由调用方在 fn 内处理。 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
