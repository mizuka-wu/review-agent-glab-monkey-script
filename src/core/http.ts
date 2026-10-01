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
 * 开发环境或无 GM 时回退到 fetch。
 */
export function httpRequest(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
  const gm = gmXhr();
  if (gm) {
    return new Promise((resolve, reject) => {
      const handle = gm({
        method: init.method ?? 'GET',
        url,
        headers: init.headers,
        data: init.body,
        timeout: init.timeoutMs ?? 60_000,
        onload: (response) => resolve({ status: response.status, text: response.responseText, transport: 'gm' }),
        onerror: () => reject(new Error(`请求失败：${url}`)),
        ontimeout: () => reject(new Error(`请求超时：${url}`)),
      });
      init.signal?.addEventListener('abort', () => handle?.abort?.(), { once: true });
      if (init.signal?.aborted) handle?.abort?.();
    });
  }
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  }).then(async (response) => ({ status: response.status, text: await response.text(), transport: 'fetch' as HttpTransport }));
}

export async function httpJson<T>(url: string, init: HttpRequestInit = {}): Promise<{ status: number; data: T }> {
  const response = await httpRequest(url, init);
  return { status: response.status, data: JSON.parse(response.text || 'null') as T };
}
