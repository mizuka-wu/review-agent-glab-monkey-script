import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestTimeoutError } from '../../src/core/http';
import {
  MODEL_REQUEST_TIMEOUT_MS,
  MODEL_STREAM_FIRST_CHUNK_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  OpenAIRuntime,
} from '../../src/core/openai-runtime';
import { defaultSettings } from '../../src/core/settings';
import type { CodeSelection } from '../../src/core/types';

const settings = {
  ...defaultSettings,
  modelBaseUrl: 'https://model.test/v1',
  apiKey: 'key',
  model: 'model',
};

/** 永不 settle：只在 signal abort 时按浏览器语义 reject AbortError。 */
function hangingFetch(_url: string, init: { signal?: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

function jsonResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function sseResponse(chunks: unknown[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 首包之后不再产出数据的流；signal abort 时按浏览器语义 error。 */
function stalledFetch(firstChunk?: unknown) {
  return (_url: string, init: { signal?: AbortSignal }) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (firstChunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
        init.signal?.addEventListener(
          'abort',
          () => controller.error(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  };
}

function selectionOf(patch: Partial<CodeSelection> = {}): CodeSelection {
  return { filePath: 'src/payment.ts', side: 'new', text: 'const apiKey = "sk-live";', top: 0, left: 0, ...patch };
}

function promptOf(fetcher: ReturnType<typeof vi.fn>, call = 0): string {
  const body = JSON.parse(String((fetcher.mock.calls[call][1] as RequestInit).body)) as {
    messages: { content: string }[];
  };
  return body.messages.map((message) => message.content).join('\n');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('模型请求超时', () => {
  it('非流式请求超时按可重试错误重试一次后成功', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockImplementationOnce(hangingFetch)
      .mockResolvedValueOnce(jsonResponse('ok'));
    vi.stubGlobal('fetch', fetcher);

    const promise = new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }]);
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(MODEL_REQUEST_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('超时最多尝试两次，之后抛出明示超时的错误', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(hangingFetch);
    vi.stubGlobal('fetch', fetcher);

    const promise = new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }]);
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(MODEL_REQUEST_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(MODEL_REQUEST_TIMEOUT_MS);

    const error = await promise.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toContain('超时');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('用户取消不当作超时错误', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(hangingFetch));
    const user = new AbortController();

    const promise = new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }], { signal: user.signal });
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    user.abort();

    const error = await promise.catch((cause: unknown) => cause);
    expect((error as Error).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(MODEL_REQUEST_TIMEOUT_MS);
  });

  it('流式首包超时后重试，第二次正常输出', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockImplementationOnce(hangingFetch)
      .mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: 'streamed' } }] }]));
    vi.stubGlobal('fetch', fetcher);
    const tokens: string[] = [];

    const promise = new OpenAIRuntime(settings).complete(
      [{ role: 'user', content: 'hi' }],
      { onToken: (token) => tokens.push(token) },
    );
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_CHUNK_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toBe('streamed');
    expect(tokens).toEqual(['streamed']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('流式中途空闲超时：已有内容就保留部分内容', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(stalledFetch({ choices: [{ delta: { content: '部分结果' } }] }));
    vi.stubGlobal('fetch', fetcher);
    const tokens: string[] = [];

    const promise = new OpenAIRuntime(settings).complete(
      [{ role: 'user', content: 'hi' }],
      { onToken: (token) => tokens.push(token) },
    );
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);

    await expect(promise).resolves.toBe('部分结果');
    expect(tokens).toEqual(['部分结果']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('流式一直没有任何数据时抛超时错误，而不是取消', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(stalledFetch());
    vi.stubGlobal('fetch', fetcher);

    const promise = new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }], { onToken: () => undefined });
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_CHUNK_TIMEOUT_MS);

    const error = await promise.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toContain('超时');
    expect((error as Error).name).not.toBe('AbortError');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('流式过程中用户取消仍走取消语义', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(stalledFetch({ choices: [{ delta: { content: 'x' } }] }));
    vi.stubGlobal('fetch', fetcher);
    const user = new AbortController();

    const promise = new OpenAIRuntime(settings).complete(
      [{ role: 'user', content: 'hi' }],
      { onToken: () => undefined, signal: user.signal },
    );
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    user.abort();

    const error = await promise.catch((cause: unknown) => cause);
    expect((error as Error).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
  });

  it('429 重试不受超时改动影响', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429 }))
      .mockResolvedValueOnce(jsonResponse('ok'));
    vi.stubGlobal('fetch', fetcher);

    await expect(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('选区引用进提示词', () => {
  it('行号已知时带上真实侧别与区间', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse('ok'));
    vi.stubGlobal('fetch', fetcher);
    const selection = selectionOf({ side: 'old', startLine: 10, endLine: 12 });

    await new OpenAIRuntime(settings).chat(
      [{ id: 'u1', role: 'user', content: '这段有什么问题', attachment: selection }],
      selection,
    );

    const prompt = promptOf(fetcher);
    expect(prompt).toContain('Selected file: src/payment.ts');
    expect(prompt).toContain('Location: old:10-12');
  });

  it('行号未知时明示 unknown，不编造行号', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse('ok'));
    vi.stubGlobal('fetch', fetcher);
    const selection = selectionOf({ startLine: undefined, endLine: undefined });

    await new OpenAIRuntime(settings).chat(
      [{ id: 'u1', role: 'user', content: '这段有什么问题', attachment: selection }],
      selection,
    );

    const prompt = promptOf(fetcher);
    expect(prompt).toContain('Selected file: src/payment.ts');
    expect(prompt).toMatch(/Location: unknown/);
    expect(prompt).not.toMatch(/Location: new:\d/);
    expect(prompt).not.toContain('undefined');
  });
});
