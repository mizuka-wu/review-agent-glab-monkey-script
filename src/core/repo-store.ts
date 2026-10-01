import { createOPFS } from 'opfs-worker';
import { createOPFSAsync } from 'opfs-worker/async';

/**
 * 仓库文件缓存层。优先用 opfs-worker 的独立 Worker（同步访问句柄，写性能最好，
 * gitlab.com 的 CSP 允许 blob: worker）；Worker 不可用时退回主线程异步 OPFS；
 * 两者都不可用（旧浏览器 / 测试环境）时用内存 Map，功能不降级、只是不持久化。
 */

export type StoreBackend = 'opfs-worker' | 'opfs-async' | 'memory';

interface FileEntry {
  path: string;
  size: number;
}

interface OpfsFacade {
  readFile(path: string): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  clear(path?: string): Promise<void>;
  index(): Promise<Map<string, { size: number }>>;
  dispose(): void;
}

export interface RepoStore {
  readonly backend: StoreBackend;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** 递归列出前缀下所有文件及字节数，用于存储核算。 */
  listFiles(prefix: string): Promise<FileEntry[]>;
  /** 递归删除目录（或单个文件）。 */
  removeDir(path: string): Promise<void>;
  clear(): Promise<void>;
  dispose(): void;
}

function normalize(key: string): string {
  return key.startsWith('/') ? key : `/${key}`;
}

function decode(value: Uint8Array | string): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}

function wrapFacade(backend: StoreBackend, facade: OpfsFacade): RepoStore {
  return {
    backend,
    async readFile(path) {
      try {
        if (!(await facade.exists(path))) return null;
        return decode(await facade.readFile(path));
      } catch {
        return null;
      }
    },
    writeFile(path, content) {
      return facade.writeFile(path, content);
    },
    exists(path) {
      return facade.exists(path);
    },
    remove(path) {
      return facade.remove(path, { force: true });
    },
    async listFiles(prefix) {
      const wanted = normalize(prefix);
      const entries: FileEntry[] = [];
      for (const [key, stat] of await facade.index()) {
        const path = normalize(key);
        if (path === wanted || path.startsWith(`${wanted}/`)) entries.push({ path, size: stat.size });
      }
      return entries;
    },
    removeDir(path) {
      return facade.remove(path, { recursive: true, force: true });
    },
    clear() {
      return facade.clear();
    },
    dispose() {
      facade.dispose();
    },
  };
}

function memoryStore(): RepoStore {
  const files = new Map<string, string>();
  const sizes = new Map<string, number>();
  const drop = (path: string) => {
    files.delete(path);
    sizes.delete(path);
  };
  return {
    backend: 'memory',
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async writeFile(path, content) {
      files.set(path, content);
      sizes.set(path, new TextEncoder().encode(content).length);
    },
    async exists(path) {
      return files.has(path);
    },
    async remove(path) {
      drop(path);
    },
    async listFiles(prefix) {
      const wanted = normalize(prefix);
      const entries: FileEntry[] = [];
      for (const [path, size] of sizes) {
        if (path === wanted || path.startsWith(`${wanted}/`)) entries.push({ path, size });
      }
      return entries;
    },
    async removeDir(path) {
      const wanted = normalize(path);
      for (const key of [...files.keys()]) {
        if (key === wanted || key.startsWith(`${wanted}/`)) drop(key);
      }
    },
    async clear() {
      files.clear();
      sizes.clear();
    },
    dispose() {
      files.clear();
      sizes.clear();
    },
  };
}

export async function createRepoStore(root: string): Promise<RepoStore> {
  const candidates: { backend: StoreBackend; create: () => OpfsFacade }[] = [
    { backend: 'opfs-worker', create: () => createOPFS({ root, hashAlgorithm: false }) as unknown as OpfsFacade },
    { backend: 'opfs-async', create: () => createOPFSAsync({ root, hashAlgorithm: false }) as unknown as OpfsFacade },
  ];

  for (const candidate of candidates) {
    try {
      const facade = candidate.create();
      const probe = '/.review-agent-probe';
      await facade.writeFile(probe, 'ok');
      const text = decode(await facade.readFile(probe));
      if (text !== 'ok') throw new Error('probe mismatch');
      await facade.remove(probe);
      return wrapFacade(candidate.backend, facade);
    } catch {
      // 该后端不可用，尝试下一个
    }
  }
  return memoryStore();
}
