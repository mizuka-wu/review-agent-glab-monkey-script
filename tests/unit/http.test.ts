import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRequest, httpTransport } from '../../src/core/http';

/** 永不 settle 的 fetch：只在 signal abort 时按浏览器语义 reject AbortError。 */
function hangingFetch(_url: string, init: { signal?: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

type GmInit = {
  method: string;
  url: string;
  timeout?: number;
  ontimeout?: () => void;
  onload: (response: { status: number; responseText: string }) => void;
  onerror: (error: unknown) => void;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as { GM?: unknown }).GM;
});

describe('httpRequest · 传输选择', () => {
  it('有 GM 时走 GM 传输并回传状态与响应体', async () => {
    const details: GmInit[] = [];
    (globalThis as { GM?: unknown }).GM = {
      xmlHttpRequest: (init: GmInit) => {
        details.push(init);
        init.onload({ status: 200, responseText: '{"ok":true}' });
        return { abort: () => undefined };
      },
    };

    const response = await httpRequest('https://model.test/v1/models');

    expect(response).toEqual({ status: 200, text: '{"ok":true}', transport: 'gm' });
    expect(httpTransport()).toBe('gm');
    expect(details[0].method).toBe('GET');
  });

  it('没有 GM 时回退到 fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));

    const response = await httpRequest('https://gitlab.test/api/v4/version', { method: 'GET' });

    expect(response).toEqual({ status: 200, text: '{"ok":true}', transport: 'fetch' });
    expect(httpTransport()).toBe('fetch');
  });
});

describe('httpRequest · 客户端不再自设超时', () => {
  it('GM 传输不注册 timeout / ontimeout，超时由服务端决定', async () => {
    const details: GmInit[] = [];
    (globalThis as { GM?: unknown }).GM = {
      xmlHttpRequest: (init: GmInit) => {
        details.push(init);
        init.onload({ status: 200, responseText: '{}' });
        return { abort: () => undefined };
      },
    };

    await httpRequest('https://model.test/v1/chat/completions', { method: 'POST', body: '{}' });

    expect(details[0]).not.toHaveProperty('timeout');
    expect(details[0]).not.toHaveProperty('ontimeout');
  });

  it('fetch 传输不自己中止：服务端多久不回都等，用户取消仍是 AbortError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(hangingFetch));
    const user = new AbortController();

    const request = httpRequest('https://model.test/v1/chat/completions', { method: 'POST', body: '{}', signal: user.signal });
    void request.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(600_000);
    user.abort();

    const error = await request.catch((cause: unknown) => cause) as Error;
    expect(error.name).toBe('AbortError');
  });

  it('用户取消转发给 GM 句柄', async () => {
    (globalThis as { GM?: unknown }).GM = {
      xmlHttpRequest: (init: GmInit) => ({ abort: () => init.onerror(new Error('aborted by user')) }),
    };
    const user = new AbortController();

    const request = httpRequest('https://gitlab.test/api/v4/projects', { signal: user.signal });
    user.abort();

    await expect(request).rejects.toThrow(/请求失败：https:\/\/gitlab\.test\/api\/v4\/projects/);
  });
});
