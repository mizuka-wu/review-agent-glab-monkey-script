/**
 * 全局调试总线：core 各模块（GitLab API、模型调用、Agent 循环、仓库索引）
 * 在不依赖 React 的前提下记录日志 / 网络 / 提示词 / 模型请求响应，DebugPanel 订阅展示，
 * 并可一键导出 JSON 用于排查问题。日志跨刷新保留最近一部分。
 */

import { sanitizeLog } from './capabilities';

export type DebugLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DebugLogEntry {
  id: string;
  ts: string;
  level: DebugLevel;
  source: string;
  message: string;
  detail?: string;
}

export interface DebugNetworkEntry {
  id: string;
  ts: string;
  kind: 'gitlab' | 'model' | 'mcp' | 'repo';
  method: string;
  url: string;
  status?: number;
  ms: number;
  bytes?: number;
  error?: string;
  transport?: string;
}

export interface DebugPromptMessage {
  role: string;
  characters: number;
  content: string;
  truncated?: boolean;
}

export interface DebugPromptEntry {
  id: string;
  ts: string;
  stage: string;
  model?: string;
  system?: string;
  messages: DebugPromptMessage[];
  tools?: string[];
  response?: string;
  tokens?: { input: number; output: number };
  error?: string;
}

export interface DebugExchangeChunk {
  index: number;
  kind: 'content' | 'reasoning';
  text: string;
  finishReason?: string;
}

export interface DebugExchangeChunkInput {
  kind: 'content' | 'reasoning';
  text: string;
  finishReason?: string;
}

export interface DebugExchangeRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export interface DebugExchangeResponse {
  status?: number;
  transport: string;
  ms: number;
  body: string;
  truncated: boolean;
  content: string;
  reasoning: string;
  finishReason?: string;
  usage?: { input: number; output: number };
  error?: string;
}

export interface DebugExchangeEntry {
  id: string;
  ts: string;
  stage: string;
  model: string;
  stream: boolean;
  attempt: number;
  request: DebugExchangeRequest;
  response: DebugExchangeResponse;
  chunks: DebugExchangeChunk[];
  droppedChunks: number;
}

/** 调用点采集到的原始往返数据，id / ts / 截断标记由 exchange() 补齐。 */
export interface DebugExchangeInput {
  stage: string;
  model: string;
  stream: boolean;
  attempt: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  status?: number;
  transport: string;
  ms: number;
  responseText: string;
  content: string;
  reasoning: string;
  finishReason?: string;
  usage?: { input: number; output: number };
  chunks: DebugExchangeChunkInput[];
  error?: string;
}

export type DebugSnapshotProvider = () => Record<string, unknown>;

const LOG_LIMIT = 800;
const NETWORK_LIMIT = 300;
const PROMPT_LIMIT = 40;
const MESSAGE_CHAR_CAP = 8000;
const EXCHANGE_LIMIT = 25;
const EXCHANGE_CHAR_CAP = 60000;
const EXCHANGE_CHUNK_LIMIT = 1200;
const PERSIST_KEY = 'review-agent-debug-v1';

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

class DebugBus {
  private logs: DebugLogEntry[] = [];
  private networkEntries: DebugNetworkEntry[] = [];
  private promptEntries: DebugPromptEntry[] = [];
  private exchangeEntries: DebugExchangeEntry[] = [];
  private revision = 0;
  private readonly snapshots = new Set<DebugSnapshotProvider>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private consoleAttached = false;

  constructor() {
    this.restore();
  }

  private seenErrorsAt = Number(typeof localStorage === 'undefined' ? 0 : localStorage.getItem('review-agent-debug-seen-errors') ?? 0);

  /** 尚未被用户查看过的错误日志数（设置/调试标签红点的依据）。 */
  unseenErrorCount(): number {
    return this.getLogs().filter((entry) => entry.level === 'error' && Date.parse(entry.ts) > this.seenErrorsAt).length;
  }

  markErrorsSeen(): void {
    this.seenErrorsAt = Date.now();
    try { localStorage.setItem('review-agent-debug-seen-errors', String(this.seenErrorsAt)); } catch { /* 忽略存储失败 */ }
    this.emitChange();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private nextId(): string {
    this.sequence += 1;
    return `${Date.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  private emitChange() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
    this.schedulePersist();
  }

  /** 单调递增版本号：条目被淘汰时计数不变，DebugPanel 仍需靠它触发重渲染。 */
  getRevision(): number {
    return this.revision;
  }

  log(level: DebugLevel, source: string, message: string, detail?: string) {
    this.logs.push({ id: this.nextId(), ts: new Date().toISOString(), level, source, message, detail });
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.emitChange();
  }

  network(entry: Omit<DebugNetworkEntry, 'id' | 'ts'>) {
    this.networkEntries.push({ ...entry, id: this.nextId(), ts: new Date().toISOString() });
    if (this.networkEntries.length > NETWORK_LIMIT) this.networkEntries.splice(0, this.networkEntries.length - NETWORK_LIMIT);
    this.emitChange();
  }

  prompt(entry: Omit<DebugPromptEntry, 'id' | 'ts' | 'messages'> & { messages: { role: string; content: string }[] }) {
    const messages: DebugPromptMessage[] = entry.messages.map((message) => ({
      role: message.role,
      characters: message.content.length,
      content: message.content.length > MESSAGE_CHAR_CAP
        ? `${message.content.slice(0, MESSAGE_CHAR_CAP)}\n…（截断 ${message.content.length - MESSAGE_CHAR_CAP} 字符）`
        : message.content,
      truncated: message.content.length > MESSAGE_CHAR_CAP,
    }));
    this.promptEntries.push({ ...entry, messages, id: this.nextId(), ts: new Date().toISOString() });
    if (this.promptEntries.length > PROMPT_LIMIT) this.promptEntries.splice(0, this.promptEntries.length - PROMPT_LIMIT);
    this.emitChange();
  }

  /** 一次模型 HTTP 往返的完整请求与响应（流式则聚合内容 + 原始增量），调试面板「AI」页展示。 */
  exchange(entry: DebugExchangeInput) {
    const chunks: DebugExchangeChunk[] = entry.chunks
      .slice(0, EXCHANGE_CHUNK_LIMIT)
      .map((chunk, index) => ({ ...chunk, index }));
    this.exchangeEntries.push({
      id: this.nextId(),
      ts: new Date().toISOString(),
      stage: entry.stage,
      model: entry.model,
      stream: entry.stream,
      attempt: entry.attempt,
      request: {
        url: sanitizeLog(entry.url),
        headers: redactHeaders(entry.headers),
        body: capText(entry.body),
        truncated: entry.body.length > EXCHANGE_CHAR_CAP,
      },
      response: {
        status: entry.status,
        transport: entry.transport,
        ms: entry.ms,
        body: capText(entry.responseText),
        truncated: entry.responseText.length > EXCHANGE_CHAR_CAP,
        content: capText(entry.content),
        reasoning: capText(entry.reasoning),
        finishReason: entry.finishReason,
        usage: entry.usage,
        error: entry.error,
      },
      chunks,
      droppedChunks: Math.max(0, entry.chunks.length - chunks.length),
    });
    if (this.exchangeEntries.length > EXCHANGE_LIMIT) this.exchangeEntries.splice(0, this.exchangeEntries.length - EXCHANGE_LIMIT);
    this.emitChange();
  }

  registerSnapshot(provider: DebugSnapshotProvider): () => void {
    this.snapshots.add(provider);
    return () => this.snapshots.delete(provider);
  }

  snapshot(): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const provider of this.snapshots) {
      try {
        Object.assign(merged, provider());
      } catch (error) {
        merged.snapshotError = error instanceof Error ? error.message : String(error);
      }
    }
    return merged;
  }

  getLogs(): DebugLogEntry[] {
    return this.logs;
  }

  getNetwork(): DebugNetworkEntry[] {
    return this.networkEntries;
  }

  getPrompts(): DebugPromptEntry[] {
    return this.promptEntries;
  }

  getExchanges(): DebugExchangeEntry[] {
    return this.exchangeEntries;
  }

  clear(scope: 'logs' | 'network' | 'prompts' | 'exchanges' | 'all' = 'all') {
    if (scope === 'all' || scope === 'logs') this.logs = [];
    if (scope === 'all' || scope === 'network') this.networkEntries = [];
    if (scope === 'all' || scope === 'prompts') this.promptEntries = [];
    if (scope === 'all' || scope === 'exchanges') this.exchangeEntries = [];
    this.emitChange();
  }

  /** 把 console.warn / console.error 也收进日志，页面报错不再丢失。 */
  attachConsole() {
    if (this.consoleAttached) return;
    this.consoleAttached = true;
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);
    console.warn = (...args: unknown[]) => {
      this.log('warn', 'console', args.map(stringify).join(' ').slice(0, 400));
      originalWarn(...args);
    };
    console.error = (...args: unknown[]) => {
      this.log('error', 'console', args.map(stringify).join(' ').slice(0, 400));
      originalError(...args);
    };
  }

  exportBundle(): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      url: typeof location !== 'undefined' ? location.href : '',
      snapshot: this.snapshot(),
      logs: this.logs,
      network: this.networkEntries,
      prompts: this.promptEntries,
      exchanges: this.exchangeEntries,
    }, null, 2);
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      const storage = safeStorage();
      if (!storage) return;
      try {
        storage.setItem(PERSIST_KEY, JSON.stringify({
          logs: this.logs.slice(-200),
          network: this.networkEntries.slice(-80),
        }));
      } catch {
        // 存储满时放弃持久化
      }
    }, 800);
  }

  private restore() {
    const storage = safeStorage();
    if (!storage) return;
    try {
      const raw = storage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { logs?: DebugLogEntry[]; network?: DebugNetworkEntry[] };
      this.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
      this.networkEntries = Array.isArray(parsed.network) ? parsed.network : [];
    } catch {
      // 损坏的调试缓存直接丢弃
    }
  }
}

const SENSITIVE_HEADER = /authorization|key|token|secret|cookie|password/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_HEADER.test(name) ? `[REDACTED ${value.length} 字符]` : value;
  }
  return redacted;
}

function capText(text: string): string {
  return text.length > EXCHANGE_CHAR_CAP
    ? `${text.slice(0, EXCHANGE_CHAR_CAP)}\n…（截断 ${text.length - EXCHANGE_CHAR_CAP} 字符）`
    : text;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const debugBus = new DebugBus();
