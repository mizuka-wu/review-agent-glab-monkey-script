import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_TIMEOUT_MS, httpRequest, RequestTimeoutError, TimeoutSignal } from '../../src/core/http';

/** 永不 settle 的 fetch：只在 signal abort 时按浏览器语义 reject AbortError。 */
function hangingFetch(_url: string, init: { signal?: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

function jsonResponse(body: string) {
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as { GM?: unknown }).GM;
});

describe('TimeoutSignal', () => {
  it('用户取消转发到合成 signal，但不标记为超时', () => {
    const user = new AbortController();
    const guard = new TimeoutSignal(user.signal);
    guard.arm(1_000);

    user.abort();

    expect(guard.signal.aborted).toBe(true);
    expect(guard.timedOut).toBe(false);
    const abortError = new DOMException('Aborted', 'AbortError');
    expect(guard.attribute(abortError, '请求超时', true)).toBe(abortError);
    guard.dispose();
  });

  it('超时只中止合成 signal，不回写用户 signal', () => {
    vi.useFakeTimers();
    const user = new AbortController();
    const guard = new TimeoutSignal(user.signal);
    guard.arm(500);

    vi.advanceTimersByTime(500);

    expect(guard.timedOut).toBe(true);
    expect(guard.signal.aborted).toBe(true);
    expect(user.signal.aborted).toBe(false);
    const error = guard.attribute(new DOMException('Aborted', 'AbortError'), '请求超时（0.5s 未完成）', true);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toContain('超时');
    guard.dispose();
  });

  it('重新 arm 会替换上一次的截止时间，dispose 之后不再触发', () => {
    vi.useFakeTimers();
    const guard = new TimeoutSignal();
    guard.arm(1_000);
    vi.advanceTimersByTime(900);
    guard.arm(1_000);
    vi.advanceTimersByTime(900);
    expect(guard.timedOut).toBe(false);

    guard.dispose();
    vi.advanceTimersByTime(5_000);
    expect(guard.timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('构造时用户已取消则立即中止', () => {
    const user = new AbortController();
    user.abort();

    expect(new TimeoutSignal(user.signal).signal.aborted).toBe(true);
  });
});

describe('httpRequest 超时', () => {
  it('fetch 挂死时按默认总超时失败，并中止请求', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(hangingFetch);
    vi.stubGlobal('fetch', fetcher);

    const request = httpRequest('https://gitlab.test/api/v4/projects');
    void request.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS);

    const error = await request.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as RequestTimeoutError).retryable).toBe(true);
    expect((error as Error).message).toContain('请求超时');
    expect((fetcher.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
  });

  it('尊重调用方传入的 timeoutMs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(hangingFetch));

    const request = httpRequest('https://gitlab.test/api/v4/projects', { timeoutMs: 5_000 });
    let settled = false;
    void request.catch(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).rejects.toThrow(/请求超时（5s 未完成）/);
  });

  it('用户取消仍然是 AbortError，不会被报成超时', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(hangingFetch));
    const user = new AbortController();

    const request = httpRequest('https://gitlab.test/api/v4/projects', { signal: user.signal });
    void request.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    user.abort();

    const error = await request.catch((cause: unknown) => cause);
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS);
  });

  it('请求正常结束后释放定时器，不留悬挂超时', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('{"ok":true}')));

    const response = await httpRequest('https://gitlab.test/api/v4/version');

    expect(response.status).toBe(200);
    expect(response.transport).toBe('fetch');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('GM 传输把 ontimeout 归类为超时错误并透传 timeout', async () => {
    const details: { timeout?: number }[] = [];
    (globalThis as typeof globalThis & { GM?: unknown }).GM = {
      xmlHttpRequest: (init: { timeout?: number; ontimeout?: () => void }) => {
        details.push(init);
        init.ontimeout?.();
        return { abort: () => undefined };
      },
    };

    const error = await httpRequest('https://gitlab.test/api/v4/projects', { timeoutMs: 12_000 })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toContain('请求超时（12s 未完成）');
    expect(details[0].timeout).toBe(12_000);
  });

  it('GM 传输默认使用 HTTP_TIMEOUT_MS', async () => {
    const details: { timeout?: number }[] = [];
    (globalThis as typeof globalThis & { GM?: unknown }).GM = {
      xmlHttpRequest: (init: { timeout?: number; onload: (response: { status: number; responseText: string }) => void }) => {
        details.push(init);
        init.onload({ status: 200, responseText: '{}' });
        return { abort: () => undefined };
      },
    };

    await httpRequest('https://gitlab.test/api/v4/projects');

    expect(details[0].timeout).toBe(HTTP_TIMEOUT_MS);
  });
});
