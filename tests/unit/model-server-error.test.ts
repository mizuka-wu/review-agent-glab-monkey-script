import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_MAX_RETRIES, OpenAIRuntime } from '../../src/core/openai-runtime';
import { defaultSettings } from '../../src/core/settings';

const settings = {
  ...defaultSettings,
  modelBaseUrl: 'https://model.test/v1',
  apiKey: 'key',
  model: 'model',
};

const ATTEMPTS = MODEL_MAX_RETRIES + 1;

/** 永不 settle：只在 signal abort 时按浏览器语义 reject AbortError。 */
function hangingFetch(_url: string, init: { signal?: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

function jsonResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function errorResponse(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

type StreamTail = 'done' | 'error-event' | 'drop';

/** SSE 流：先吐 chunk，再按服务端失败的三种形态收尾。 */
function sseResponse(chunks: unknown[], tail: StreamTail = 'done', errorEvent?: unknown) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (tail === 'error-event') {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
      } else if (tail === 'drop') {
        controller.error(new TypeError('network error'));
        return;
      } else {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function tokenOf(text: string) {
  return { choices: [{ delta: { content: text } }] };
}

/** DOMException 不是 Error 的子类，这里统一读 name / message。 */
async function capture(promise: Promise<unknown>) {
  const cause = await promise.catch((value: unknown) => value);
  return {
    name: (cause as { name?: string }).name ?? '',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('模型服务端超时 / 错误响应', () => {
  it('HTTP 504 网关超时：重试到上限后给出中文超时文案，不倒原始 HTML', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('<html>504 Gateway Time-out</html>', {
      status: 504, headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetcher);

    const error = await capture(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }]));

    expect(fetcher).toHaveBeenCalledTimes(ATTEMPTS);
    expect(error.message).toContain('模型服务超时（HTTP 504）');
    expect(error.message).toContain(`已重试 ${MODEL_MAX_RETRIES} 次仍失败`);
    expect(error.message).not.toContain('<html>');
  });

  it('HTTP 408 之后服务端恢复：第二次直接成功', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(errorResponse(408, { error: { message: 'Request Timeout' } }))
      .mockResolvedValueOnce(jsonResponse('ok'));
    vi.stubGlobal('fetch', fetcher);

    await expect(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('HTTP 500 走既有重试通道，重试耗尽后报服务端文案', async () => {
    const fetcher = vi.fn().mockImplementation(async () => errorResponse(500, { error: { message: '内部错误' } }));
    vi.stubGlobal('fetch', fetcher);

    const error = await capture(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }]));

    expect(fetcher).toHaveBeenCalledTimes(ATTEMPTS);
    expect(error.message).toContain('内部错误');
    expect(error.message).toContain(`已重试 ${MODEL_MAX_RETRIES} 次仍失败`);
  });

  it('HTTP 200 但 body 是 error JSON（code=timeout）：识别为超时并重试', async () => {
    const fetcher = vi.fn().mockImplementation(
      async () => errorResponse(200, { error: { message: 'upstream request timeout', code: 'timeout' } }),
    );
    vi.stubGlobal('fetch', fetcher);

    const error = await capture(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }]));

    expect(fetcher).toHaveBeenCalledTimes(ATTEMPTS);
    expect(error.message).toContain('模型服务超时');
    expect(error.message).toContain('upstream request timeout');
    expect(error.message).not.toContain('HTTP 200');
    expect(error.message).not.toContain('{"error"');
  });

  it('HTTP 200 + 不可重试的 error JSON：原样给出服务端文案，不重试', async () => {
    const fetcher = vi.fn().mockImplementation(async () => errorResponse(200, { error: { message: '模型不存在', code: 'model_not_found' } }));
    vi.stubGlobal('fetch', fetcher);

    await expect(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('模型不存在');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('HTTP 401 不重试，仍是原样文案', async () => {
    const fetcher = vi.fn().mockImplementation(async () => errorResponse(401, { error: { message: 'bad key' } }));
    vi.stubGlobal('fetch', fetcher);

    await expect(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('bad key');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('SSE 中途 error 事件：已经吐过的 token 不丢，整体判为失败且不重试', async () => {
    const fetcher = vi.fn().mockImplementation(
      async () => sseResponse([tokenOf('半截回答')], 'error-event', { error: { message: 'request timed out', code: 'timeout' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const tokens: string[] = [];

    const error = await capture(new OpenAIRuntime(settings).complete(
      [{ role: 'user', content: 'hi' }],
      { onToken: (token) => tokens.push(token) },
    ));

    expect(tokens).toEqual(['半截回答']);
    expect(error.message).toContain('模型服务超时');
    expect(error.name).not.toBe('AbortError');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('SSE 中途 error 事件且没有任何内容：重试后成功', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(sseResponse([], 'error-event', { error: { message: 'gateway timeout', code: 'timeout' } }))
      .mockResolvedValueOnce(sseResponse([tokenOf('ok')]));
    vi.stubGlobal('fetch', fetcher);
    const tokens: string[] = [];

    const answer = await new OpenAIRuntime(settings).complete(
      [{ role: 'user', content: 'hi' }],
      { onToken: (token) => tokens.push(token) },
    );

    expect(answer).toBe('ok');
    expect(tokens).toEqual(['ok']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('SSE 连接中断且没有任何内容：归类为连接失败并重试', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(sseResponse([], 'drop'))
      .mockResolvedValueOnce(sseResponse([tokenOf('ok')]));
    vi.stubGlobal('fetch', fetcher);

    await expect(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }], { onToken: () => undefined }))
      .resolves.toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('SSE 一直断线：重试耗尽后报中文连接失败', async () => {
    const fetcher = vi.fn().mockImplementation(async () => sseResponse([], 'drop'));
    vi.stubGlobal('fetch', fetcher);

    const error = await capture(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }], { onToken: () => undefined }));

    expect(fetcher).toHaveBeenCalledTimes(ATTEMPTS);
    expect(error.message).toContain('模型服务连接失败');
    expect(error.message).toContain(`已重试 ${MODEL_MAX_RETRIES} 次仍失败`);
  });

  it('工具调用（Agent 路径）同样重试服务端超时并给出中文文案', async () => {
    const fetcher = vi.fn().mockImplementation(async () => errorResponse(504, { error: { message: 'timed out', code: 'timeout' } }));
    vi.stubGlobal('fetch', fetcher);

    const error = await capture(new OpenAIRuntime(settings).callWithTools([{ role: 'user', content: 'hi' }], [], 'system')
      .then((result) => JSON.stringify(result)));

    expect(fetcher).toHaveBeenCalledTimes(ATTEMPTS);
    expect(error.message).toContain('模型服务超时（HTTP 504）');
    expect(error.message).toContain(`已重试 ${MODEL_MAX_RETRIES} 次仍失败`);
  });

  it('测试连接遇到网关超时给出中文文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => errorResponse(504, '')));

    await expect(new OpenAIRuntime(settings).testConnection()).rejects.toThrow('模型服务超时（HTTP 504）');
  });
});

describe('用户取消', () => {
  it('取消不触发重试，仍是 AbortError', async () => {
    const fetcher = vi.fn().mockImplementation(hangingFetch);
    vi.stubGlobal('fetch', fetcher);
    const user = new AbortController();

    const promise = new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }], { signal: user.signal });
    void promise.catch(() => undefined);
    user.abort();

    const error = await capture(promise);
    expect(error.name).toBe('AbortError');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('退避等待期间取消：不再发起下一次请求，promise 立即落定', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () => errorResponse(504, ''));
    vi.stubGlobal('fetch', fetcher);
    const user = new AbortController();

    const promise = new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }], { signal: user.signal });
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    user.abort();

    const error = await capture(promise);
    expect(error.name).toBe('AbortError');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('流式过程中取消仍走取消语义，不当作服务端错误', async () => {
    const fetcher = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const user = new AbortController();

    const promise = new OpenAIRuntime(settings).complete(
      [{ role: 'user', content: 'hi' }],
      { onToken: () => undefined, signal: user.signal },
    );
    void promise.catch(() => undefined);
    user.abort();

    const error = await capture(promise);
    expect(error.name).toBe('AbortError');
    expect(error.message).not.toContain('超时');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
