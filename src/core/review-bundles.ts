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
  const pack = (list: FileDiff[]) => {
    let current: FileDiff[] = [];
    let currentChars = 0;
    for (const file of list) {
      const size = fileCharSize(file);
      if (current.length > 0 && (current.length >= maxFiles || currentChars + size > maxChars)) {
        bundles.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(file);
      currentChars += size;
    }
    if (current.length > 0) bundles.push(current);
  };

  // 目录内聚：变更较多的目录独占分组以保持共享上下文；小目录合并打包控制调用数。
  const pool: FileDiff[] = [];
  for (const list of byDir.values()) {
    if (list.length > 2) pack(list);
    else pool.push(...list);
  }
  if (pool.length > 0) pack(pool);
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
