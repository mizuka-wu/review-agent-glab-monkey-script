type GmHandle = { abort?: () => void };

type GmXhr = (details: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  onload: (response: { status: number; responseText: string }) => void;
  onerror: (error: unknown) => void;
  ontimeout?: () => void;
}) => GmHandle | undefined;

function gmXhr(): GmXhr | undefined {
  return (globalThis as typeof globalThis & { GM?: { xmlHttpRequest?: GmXhr } }).GM?.xmlHttpRequest;
}

export type HttpTransport = 'gm' | 'fetch';

export function httpTransport(): HttpTransport {
  return gmXhr() ? 'gm' : 'fetch';
}

/** GitLab API 等常规请求的总超时；模型调用在 openai-runtime 里按场景覆盖。 */
export const HTTP_TIMEOUT_MS = 60_000;

export function timeoutSeconds(timeoutMs: number) {
  return `${timeoutMs / 1000}s`;
}

/** 超时错误：与用户取消（AbortError）区分，retryable 决定是否进入重试。 */
export class RequestTimeoutError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * 把「用户取消」和「超时」合成一个 AbortSignal。AbortSignal.any 在部分 userscript
 * 运行环境不存在，这里手写组合：两种中止互不覆盖，timedOut 只在超时触发时为真，
 * 因此调用方能靠 attribute() 把 AbortError 正确归因。
 */
export class TimeoutSignal {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fired = false;
  private readonly forwardUserAbort = () => this.controller.abort();

  constructor(private readonly user?: AbortSignal) {
    if (user?.aborted) this.controller.abort();
    else user?.addEventListener('abort', this.forwardUserAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get timedOut(): boolean {
    return this.fired;
  }

  /** 启动（或重置）超时倒计时：到期未 dispose/arm 就中止请求并标记为超时。 */
  arm(timeoutMs: number) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, timeoutMs);
  }

  dispose() {
    this.clearTimer();
    this.user?.removeEventListener('abort', this.forwardUserAbort);
  }

  /** 超时 → RequestTimeoutError；用户取消 → 原样抛出 AbortError。 */
  attribute(error: unknown, message: string, retryable: boolean): unknown {
    return this.fired ? new RequestTimeoutError(message, retryable) : error;
  }

  private clearTimer() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export interface HttpRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  text: string;
  transport: HttpTransport;
}

/**
 * GM.xmlHttpRequest 不受页面 CSP connect-src / CORS 限制（gitlab.com 的
 * connect-src 是 'self'，页面上下文 fetch 外部模型端点会被拦），因此优先使用；
 * 开发环境或无 GM 时回退到 fetch。两条传输都受 timeoutMs 约束，网络黑洞不会永久挂起。
 */
export function httpRequest(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
  const timeoutMs = init.timeoutMs ?? HTTP_TIMEOUT_MS;
  const gm = gmXhr();
  if (gm) {
    return new Promise((resolve, reject) => {
      const handle = gm({
        method: init.method ?? 'GET',
        url,
        headers: init.headers,
        data: init.body,
        timeout: timeoutMs,
        onload: (response) => resolve({ status: response.status, text: response.responseText, transport: 'gm' }),
        onerror: () => reject(new Error(`请求失败：${url}`)),
        ontimeout: () => reject(new RequestTimeoutError(`请求超时（${timeoutSeconds(timeoutMs)} 未完成）：${url}`, true)),
      });
      init.signal?.addEventListener('abort', () => handle?.abort?.(), { once: true });
      if (init.signal?.aborted) handle?.abort?.();
    });
  }
  const guard = new TimeoutSignal(init.signal);
  guard.arm(timeoutMs);
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    signal: guard.signal,
  })
    .then(async (response) => ({ status: response.status, text: await response.text(), transport: 'fetch' as HttpTransport }))
    .catch((error: unknown) => {
      throw guard.attribute(error, `请求超时（${timeoutSeconds(timeoutMs)} 未完成）：${url}`, true);
    })
    .finally(() => guard.dispose());
}

export async function httpJson<T>(url: string, init: HttpRequestInit = {}): Promise<{ status: number; data: T }> {
  const response = await httpRequest(url, init);
  return { status: response.status, data: JSON.parse(response.text || 'null') as T };
}
