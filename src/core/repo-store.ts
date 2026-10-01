import { createOPFS } from 'opfs-worker';
import { createOPFSAsync } from 'opfs-worker/async';

/**
 * 仓库文件缓存层。优先用 opfs-worker 的独立 Worker（同步访问句柄，写性能最好，
 * gitlab.com 的 CSP 允许 blob: worker）；Worker 不可用时退回主线程异步 OPFS；
 * 两者都不可用（旧浏览器 / 测试环境）时用内存 Map，功能不降级、只是不持久化。
 */

export type StoreBackend = 'opfs-worker' | 'opfs-async' | 'memory';

interface OpfsFacade {
  readFile(path: string): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  clear(path?: string): Promise<void>;
  dispose(): void;
}

export interface RepoStore {
  readonly backend: StoreBackend;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  clear(): Promise<void>;
  dispose(): void;
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
      return facade.remove(path);
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
  return {
    backend: 'memory',
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async exists(path) {
      return files.has(path);
    },
    async remove(path) {
      files.delete(path);
    },
    async clear() {
      files.clear();
    },
    dispose() {
      files.clear();
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
