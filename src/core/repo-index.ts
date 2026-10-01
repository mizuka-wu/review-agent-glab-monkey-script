import { debugBus } from './debug-bus';
import type { GitLabAdapter } from './gitlab-adapter';
import { detectLanguage } from './rule-packs';
import { createRepoStore, type RepoStore, type StoreBackend } from './repo-store';
import {
  buildCallChain, buildSymbolIndex, contextForFiles, extractFileSymbols, searchSymbols,
  type CallChainNode, type SymbolIndex, type SymbolSearchResult,
} from './symbols';

/**
 * 仓库索引管理器。GitLab REST 没有符号级 API，因此把每个 ref 的仓库文件
 * 缓存到 OPFS 的独立命名空间（/idx/<ref>/），并用注册表记录所有已缓存的
 * ref：不同 branch / 不同 MR 的索引互不覆盖，可以按需载入、删除和配额清理。
 */

export interface RepoIndexOptions {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  concurrency: number;
  /** 注册表最多保留的索引份数，超出自动清理最旧的。 */
  maxIndexes: number;
}

export const defaultRepoIndexOptions: RepoIndexOptions = {
  maxFiles: 400,
  maxBytes: 12 * 1024 * 1024,
  maxFileBytes: 300 * 1024,
  concurrency: 4,
  maxIndexes: 6,
};

export type RepoIndexState = 'idle' | 'indexing' | 'ready' | 'error';

export interface IndexRecord {
  ref: string;
  label: string;
  projectPath: string;
  indexedAt: string;
  files: number;
  bytes: number;
  symbols: number;
}

export interface RepoIndexStatus {
  state: RepoIndexState;
  backend: StoreBackend;
  /** 当前载入的索引 ref。 */
  ref: string;
  label: string;
  projectPath: string;
  /** 页面当前 head ref；与 ref 不一致说明载入的是其它分支/旧提交。 */
  currentRef: string;
  files: number;
  bytes: number;
  symbols: number;
  refs: number;
  indexedAt?: string;
  progress: { done: number; total: number; current?: string };
  skipped: { files: number; bytes: number };
  registry: IndexRecord[];
  storage: { usage?: number; quota?: number };
  error?: string;
}

const REGISTRY_PATH = '/registry.json';
const SKIP_PATH = /(?:^|\/)(?:node_modules|dist|build|out|target|vendor|\.git|coverage|__snapshots__|\.next|\.gradle|\.idea)\//;
const SKIP_SUFFIX = /\.(?:min\.(?:js|css)|map|svg|png|jpe?g|gif|ico|woff2?|ttf|eot|wasm|pdf|zip)$/i;
const LOCK_FILES = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|gradle\.lockfile)$/i;

function eligible(path: string): boolean {
  if (SKIP_PATH.test(path) || SKIP_SUFFIX.test(path) || LOCK_FILES.test(path)) return false;
  const language = detectLanguage(path);
  return language !== 'other' && language !== 'markdown';
}

function namespaceOf(ref: string): string {
  return `/idx/${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
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
  private options: RepoIndexOptions;
  private abort: AbortController | undefined;

  constructor(
    readonly store: RepoStore,
    options: Partial<RepoIndexOptions> = {},
  ) {
    this.options = { ...defaultRepoIndexOptions, ...options };
    this.statusValue = {
      state: 'idle', backend: store.backend, ref: '', label: '', projectPath: '', currentRef: '',
      files: 0, bytes: 0, symbols: 0, refs: 0,
      progress: { done: 0, total: 0 }, skipped: { files: 0, bytes: 0 },
      registry: [], storage: {},
    };
  }

  get status(): RepoIndexStatus {
    return this.statusValue;
  }

  get ready(): boolean {
    return this.statusValue.state === 'ready' && this.symbolIndex !== null;
  }

  /** 索引与当前 head 是否一致；不一致时仓库上下文不应注入提示词。 */
  get inSync(): boolean {
    return Boolean(this.statusValue.ref) && this.statusValue.ref === this.statusValue.currentRef;
  }

  updateOptions(patch: Partial<RepoIndexOptions>) {
    this.options = { ...this.options, ...patch };
  }

  subscribe(listener: (status: RepoIndexStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<RepoIndexStatus>) {
    this.statusValue = { ...this.statusValue, ...patch };
    for (const listener of this.listeners) listener(this.statusValue);
  }

  markCurrentRef(ref: string) {
    if (this.statusValue.currentRef === ref) return;
    this.emit({ currentRef: ref });
  }

  // --- Registry ---

  /** 读取当前载入索引的全部文件内容（受 maxFiles 限制），供全文件扫描使用。 */
  async readIndexedFiles(): Promise<{ path: string; content: string }[]> {
    const meta = this.symbolIndex as { files?: { path: string }[] } | null;
    if (!meta?.files?.length) return [];
    const namespace = namespaceOf(this.statusValue.ref);
    const limited = meta.files.slice(0, this.options.maxFiles);
    const result: { path: string; content: string }[] = [];
    for (const entry of limited) {
      const content = await this.store.readFile(`${namespace}/files/${entry.path}`);
      if (content) result.push({ path: entry.path, content });
    }
    return result;
  }

  async list(): Promise<IndexRecord[]> {
    const raw = await this.store.readFile(REGISTRY_PATH);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { entries?: IndexRecord[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  private async saveRegistry(entries: IndexRecord[]): Promise<void> {
    await this.store.writeFile(REGISTRY_PATH, JSON.stringify({ version: 1, entries }));
  }

  async refresh(): Promise<void> {
    const registry = await this.list();
    const storage = await this.estimate();
    this.emit({ registry, storage });
  }

  private async estimate(): Promise<{ usage?: number; quota?: number }> {
    try {
      const estimate = await navigator.storage?.estimate?.();
      return estimate ? { usage: estimate.usage, quota: estimate.quota } : {};
    } catch {
      return {};
    }
  }

  // --- Lifecycle ---

  /** 载入某个已缓存 ref 的索引（零网络）。 */
  async activate(ref: string): Promise<boolean> {
    const meta = await this.store.readFile(`${namespaceOf(ref)}/meta.json`);
    if (!meta) return false;
    try {
      const parsed = JSON.parse(meta) as SymbolIndex;
      if (!Array.isArray(parsed.files)) return false;
      const record = (await this.list()).find((entry) => entry.ref === ref);
      this.symbolIndex = parsed;
      this.emit({
        state: 'ready', ref, label: record?.label ?? ref.slice(0, 8),
        projectPath: record?.projectPath ?? this.statusValue.projectPath,
        files: parsed.files.length, symbols: countSymbols(parsed), refs: countRefs(parsed),
        bytes: record?.bytes ?? parsed.files.reduce((total, file) => total + file.bytes, 0),
        indexedAt: parsed.indexedAt, progress: { done: parsed.files.length, total: parsed.files.length },
        error: undefined,
      });
      debugBus.log('info', 'repo-index', `载入本地索引 ${ref.slice(0, 8)}（${parsed.files.length} 文件，零网络）`, record?.label);
      return true;
    } catch {
      return false;
    }
  }

  /** 兼容旧调用：等价于 activate。 */
  restore(ref: string): Promise<boolean> {
    return this.activate(ref);
  }

  async index(
    adapter: GitLabAdapter,
    input: { ref: string; label?: string; projectPath?: string; signal?: AbortSignal },
  ): Promise<RepoIndexStatus> {
    const { ref } = input;
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const namespace = namespaceOf(ref);
    this.emit({
      state: 'indexing', ref: this.statusValue.ref, error: undefined,
      progress: { done: 0, total: 0 }, skipped: { files: 0, bytes: 0 },
    });
    debugBus.log('info', 'repo-index', `开始建立索引 ${ref.slice(0, 8)}（${input.label ?? ''}）`, `存储后端 ${this.store.backend}`);

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
            await this.store.writeFile(`${namespace}/files/${entry.path}`, content);
            loaded.push({ path: entry.path, content });
          } catch {
            skippedFiles += 1;
          }
        }
      });
      await Promise.all(workers);

      const built = buildSymbolIndex({
        ref,
        files: loaded.map((file) => ({ ...extractFileSymbols(file.path, file.content), content: file.content })),
      });
      await this.store.writeFile(`${namespace}/meta.json`, JSON.stringify(built));

      const record: IndexRecord = {
        ref,
        label: input.label ?? ref.slice(0, 8),
        projectPath: input.projectPath ?? this.statusValue.projectPath,
        indexedAt: built.indexedAt,
        files: built.files.length,
        bytes,
        symbols: countSymbols(built),
      };
      const registry = await this.list();
      const pruned = await this.withRegistry([...registry.filter((entry) => entry.ref !== ref), record], ref);

      this.symbolIndex = built;
      this.emit({
        state: 'ready', ref, label: record.label, projectPath: record.projectPath,
        files: record.files, bytes, symbols: record.symbols, refs: countRefs(built),
        indexedAt: record.indexedAt, skipped: { files: skippedFiles, bytes: skippedBytes },
        progress: { done: candidates.length, total: candidates.length },
        registry: pruned, storage: await this.estimate(), error: undefined,
      });
      debugBus.log('info', 'repo-index',
        `索引完成：${record.files} 文件 / ${(bytes / 1024).toFixed(0)} KB / ${record.symbols} 符号 / ${countRefs(built)} 引用`,
        `ref ${ref.slice(0, 8)} · ${record.label} · 缓存 ${pruned.length} 份`);
    } catch (error) {
      const aborted = controller.signal.aborted || (error as Error).name === 'AbortError';
      const message = error instanceof Error ? error.message : String(error);
      this.emit(aborted
        ? { state: this.symbolIndex ? 'ready' : 'idle', error: '索引已取消' }
        : { state: this.symbolIndex ? 'ready' : 'error', error: message });
      debugBus.log(aborted ? 'warn' : 'error', 'repo-index', aborted ? '索引已取消' : `索引失败：${message}`);
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      this.abort = undefined;
    }
    return this.statusValue;
  }

  /** 写入注册表并按 maxIndexes 清理最旧索引（刚写入的永远保留）。 */
  private async withRegistry(entries: IndexRecord[], keepRef?: string): Promise<IndexRecord[]> {
    const sorted = [...entries].sort((a, b) =>
      b.indexedAt.localeCompare(a.indexedAt)
      || (a.ref === keepRef ? -1 : b.ref === keepRef ? 1 : 0));
    const keep = sorted.slice(0, this.options.maxIndexes);
    const dropped = sorted.slice(this.options.maxIndexes).filter((entry) => entry.ref !== keepRef);
    for (const record of dropped) {
      await this.store.removeDir(namespaceOf(record.ref));
      debugBus.log('info', 'repo-index', `配额清理：删除旧索引 ${record.ref.slice(0, 8)}（${record.label}）`);
    }
    await this.saveRegistry(keep);
    return keep;
  }

  async remove(ref: string): Promise<void> {
    await this.store.removeDir(namespaceOf(ref));
    const registry = (await this.list()).filter((entry) => entry.ref !== ref);
    await this.saveRegistry(registry);
    if (this.statusValue.ref === ref) {
      this.symbolIndex = null;
      this.emit({
        state: 'idle', ref: '', label: '', files: 0, bytes: 0, symbols: 0, refs: 0,
        indexedAt: undefined, progress: { done: 0, total: 0 }, registry, storage: await this.estimate(),
      });
    } else {
      this.emit({ registry, storage: await this.estimate() });
    }
    debugBus.log('info', 'repo-index', `已删除索引 ${ref.slice(0, 8)}`);
  }

  async clear(): Promise<void> {
    this.cancel();
    await this.store.removeDir('/idx');
    await this.store.remove(REGISTRY_PATH);
    this.symbolIndex = null;
    this.emit({
      state: 'idle', ref: '', label: '', files: 0, bytes: 0, symbols: 0, refs: 0,
      indexedAt: undefined, progress: { done: 0, total: 0 }, skipped: { files: 0, bytes: 0 },
      registry: [], storage: await this.estimate(), error: undefined,
    });
    debugBus.log('info', 'repo-index', '已清除全部本地索引缓存');
  }

  cancel() {
    this.abort?.abort();
  }

  // --- Queries (against the active namespace) ---

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
    if (!this.statusValue.ref) return Promise.resolve(null);
    return this.store.readFile(`${namespaceOf(this.statusValue.ref)}/files/${path}`);
  }
}

export async function createRepoIndex(options?: Partial<RepoIndexOptions>): Promise<RepoIndex> {
  const store = await createRepoStore('/review-agent');
  // 清理 0.x 单份缓存布局，避免孤儿数据占空间
  if (await store.exists('/meta.json')) {
    await store.removeDir('/files');
    await store.remove('/meta.json');
  }
  const index = new RepoIndex(store, options);
  await index.refresh();
  return index;
}
