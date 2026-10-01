import { debugBus } from './debug-bus';
import type { GitLabAdapter } from './gitlab-adapter';
import { detectLanguage } from './rule-packs';
import { createRepoStore, type RepoStore, type StoreBackend } from './repo-store';
import {
  buildCallChain, buildSymbolIndex, contextForFiles, extractFileSymbols, searchSymbols,
  type CallChainNode, type SymbolIndex, type SymbolSearchResult,
} from './symbols';

/**
 * 仓库级上下文：GitLab REST 只提供 tree + raw 文件，没有符号索引，
 * 所以把文件缓存到 OPFS 后在本地构建符号表，供符号搜索、调用链和
 * Review 提示词的"Diff 外调用点"上下文使用。
 */

export interface RepoIndexOptions {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  concurrency: number;
}

export const defaultRepoIndexOptions: RepoIndexOptions = {
  maxFiles: 400,
  maxBytes: 12 * 1024 * 1024,
  maxFileBytes: 300 * 1024,
  concurrency: 4,
};

export type RepoIndexState = 'idle' | 'indexing' | 'ready' | 'error';

export interface RepoIndexStatus {
  state: RepoIndexState;
  backend: StoreBackend;
  ref: string;
  files: number;
  bytes: number;
  symbols: number;
  refs: number;
  indexedAt?: string;
  progress: { done: number; total: number; current?: string };
  skipped: { files: number; bytes: number };
  error?: string;
}

const SKIP_PATH = /(?:^|\/)(?:node_modules|dist|build|out|target|vendor|\.git|coverage|__snapshots__|\.next|\.gradle|\.idea)\//;
const SKIP_SUFFIX = /\.(?:min\.(?:js|css)|map|svg|png|jpe?g|gif|ico|woff2?|ttf|eot|wasm|pdf|zip)$/i;
const LOCK_FILES = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|gradle\.lockfile)$/i;

function eligible(path: string): boolean {
  if (SKIP_PATH.test(path) || SKIP_SUFFIX.test(path) || LOCK_FILES.test(path)) return false;
  const language = detectLanguage(path);
  return language !== 'other' && language !== 'markdown';
}

function countSymbols(index: SymbolIndex): number {
  return index.files.reduce((total, file) => total + file.defs.length, 0);
}

function countRefs(index: SymbolIndex): number {
  return Object.values(index.refs).reduce((total, refs) => total + refs.length, 0);
}

export class RepoIndex {
  private statusValue: RepoIndexStatus;
  private readonly listeners = new Set<(status: RepoIndexStatus) => void>();
  private symbolIndex: SymbolIndex | null = null;
  private abort: AbortController | undefined;

  constructor(
    readonly store: RepoStore,
    private options: RepoIndexOptions = defaultRepoIndexOptions,
  ) {
    this.statusValue = {
      state: 'idle', backend: store.backend, ref: '', files: 0, bytes: 0, symbols: 0, refs: 0,
      progress: { done: 0, total: 0 }, skipped: { files: 0, bytes: 0 },
    };
  }

  get status(): RepoIndexStatus {
    return this.statusValue;
  }

  updateOptions(patch: Partial<RepoIndexOptions>) {
    this.options = { ...this.options, ...patch };
  }

  get ready(): boolean {
    return this.statusValue.state === 'ready' && this.symbolIndex !== null;
  }

  subscribe(listener: (status: RepoIndexStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<RepoIndexStatus>) {
    this.statusValue = { ...this.statusValue, ...patch };
    for (const listener of this.listeners) listener(this.statusValue);
  }

  /** 命中同 ref 的已存索引时直接恢复，不重新拉文件。 */
  async restore(ref: string): Promise<boolean> {
    const meta = await this.store.readFile('/meta.json');
    if (!meta) return false;
    try {
      const parsed = JSON.parse(meta) as SymbolIndex;
      if (parsed.ref !== ref || !Array.isArray(parsed.files)) return false;
      this.symbolIndex = parsed;
      debugBus.log('info', 'repo-index', `从本地缓存恢复索引（${parsed.files.length} 文件）`, `ref ${ref.slice(0, 8)}`);
      this.emit({
        state: 'ready', ref, files: parsed.files.length, symbols: countSymbols(parsed),
        refs: countRefs(parsed), bytes: parsed.files.reduce((total, file) => total + file.bytes, 0),
        indexedAt: parsed.indexedAt, progress: { done: parsed.files.length, total: parsed.files.length },
      });
      return true;
    } catch {
      return false;
    }
  }

  async index(adapter: GitLabAdapter, ref: string, signal?: AbortSignal): Promise<RepoIndexStatus> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    this.emit({
      state: 'indexing', ref, error: undefined, files: 0, bytes: 0, symbols: 0, refs: 0,
      progress: { done: 0, total: 0 }, skipped: { files: 0, bytes: 0 },
    });
    debugBus.log('info', 'repo-index', `开始建立仓库索引 ref ${ref.slice(0, 8)}`, `存储后端 ${this.store.backend}`);

    try {
      const tree = await adapter.listTree(ref, { signal: controller.signal });
      const candidates = tree
        .filter((entry) => entry.type === 'blob' && eligible(entry.path))
        .slice(0, this.options.maxFiles);
      this.emit({ progress: { done: 0, total: candidates.length } });

      const loaded: { path: string; content: string }[] = [];
      let bytes = 0;
      let skippedFiles = 0;
      let skippedBytes = 0;
      let cursor = 0;

      const workers = Array.from({ length: Math.min(this.options.concurrency, 8) }, async () => {
        while (cursor < candidates.length) {
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const entry = candidates[cursor];
          cursor += 1;
          this.emit({ progress: { done: cursor, total: candidates.length, current: entry.path } });
          try {
            const content = await adapter.getFile(entry.path, ref);
            if (content.length > this.options.maxFileBytes || bytes + content.length > this.options.maxBytes) {
              skippedFiles += 1;
              skippedBytes += content.length;
              continue;
            }
            bytes += content.length;
            await this.store.writeFile(`/files/${entry.path}`, content);
            loaded.push({ path: entry.path, content });
          } catch {
            skippedFiles += 1;
          }
        }
      });
      await Promise.all(workers);

      const index = buildSymbolIndex({
        ref,
        files: loaded.map((file) => ({ ...extractFileSymbols(file.path, file.content), content: file.content })),
      });
      this.symbolIndex = index;
      await this.store.writeFile('/meta.json', JSON.stringify(index));
      this.emit({
        state: 'ready', files: index.files.length, bytes, symbols: countSymbols(index),
        refs: countRefs(index), indexedAt: index.indexedAt,
        skipped: { files: skippedFiles, bytes: skippedBytes },
        progress: { done: candidates.length, total: candidates.length },
      });
      debugBus.log('info', 'repo-index',
        `索引完成：${index.files.length} 文件 / ${(bytes / 1024).toFixed(0)} KB / ${countSymbols(index)} 符号 / ${countRefs(index)} 引用`,
        `ref ${ref.slice(0, 8)} · 存储 ${this.store.backend} · 跳过 ${skippedFiles} 文件`);
    } catch (error) {
      const aborted = controller.signal.aborted || (error as Error).name === 'AbortError';
      const message = error instanceof Error ? error.message : String(error);
      this.emit(aborted
        ? { state: this.symbolIndex ? 'ready' : 'idle', error: '索引已取消' }
        : { state: this.symbolIndex ? 'ready' : 'error', error: message });
      debugBus.log(aborted ? 'warn' : 'error', 'repo-index', aborted ? '索引已取消' : `索引失败：${message}`);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.abort = undefined;
    }
    return this.statusValue;
  }

  cancel() {
    this.abort?.abort();
  }

  search(query: string, limit = 20): SymbolSearchResult {
    return this.symbolIndex ? searchSymbols(this.symbolIndex, query, limit) : { defs: [], refs: [] };
  }

  callChain(symbol: string, depth = 2): CallChainNode | null {
    return this.symbolIndex ? buildCallChain(this.symbolIndex, symbol, depth) : null;
  }

  contextForFiles(paths: string[], budgetCharacters = 2400): string {
    return this.symbolIndex ? contextForFiles(this.symbolIndex, paths, budgetCharacters) : '';
  }

  readFile(path: string): Promise<string | null> {
    return this.store.readFile(`/files/${path}`);
  }

  async clear(): Promise<void> {
    this.cancel();
    await this.store.clear();
    this.symbolIndex = null;
    this.emit({
      state: 'idle', ref: '', files: 0, bytes: 0, symbols: 0, refs: 0, indexedAt: undefined,
      progress: { done: 0, total: 0 }, skipped: { files: 0, bytes: 0 }, error: undefined,
    });
  }
}

export async function createRepoIndex(options?: Partial<RepoIndexOptions>): Promise<RepoIndex> {
  const store = await createRepoStore('/review-agent');
  return new RepoIndex(store, { ...defaultRepoIndexOptions, ...options });
}
