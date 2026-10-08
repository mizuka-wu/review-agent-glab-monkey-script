import { afterEach, describe, expect, it, vi } from 'vitest';
import { debugBus } from '../../src/core/debug-bus';
import { OpenAIRuntime } from '../../src/core/openai-runtime';
import { defaultSettings } from '../../src/core/settings';
import type { RuntimeSettings } from '../../src/core/types';

const settings: RuntimeSettings = {
  ...defaultSettings,
  modelBaseUrl: 'https://model.test/v1',
  apiKey: 'abcdef123456789',
  model: 'qwen-test',
};

function sse(events: string[]) {
  return new Response(`${events.map((event) => `data: ${event}`).join('\n\n')}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  debugBus.clear();
});

describe('debugBus.exchange', () => {
  it('keeps the full request/response and redacts credentials', () => {
    debugBus.clear();
    const listener = vi.fn();
    const unsubscribe = debugBus.subscribe(listener);
    debugBus.exchange({
      stage: 'review', model: 'qwen-test', stream: false, attempt: 1,
      url: 'https://model.test/v1/chat/completions?key=abcdef123456789',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abcdef123456789' },
      body: JSON.stringify({ model: 'qwen-test', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 }),
      status: 200, transport: 'gm', ms: 42,
      responseText: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}',
      content: 'ok', reasoning: '', finishReason: 'stop', usage: { input: 3, output: 1 }, chunks: [],
    });
    unsubscribe();

    expect(listener).toHaveBeenCalled();
    const [entry] = debugBus.getExchanges();
    expect(entry.request.url).not.toContain('abcdef123456789');
    expect(entry.request.headers.Authorization).not.toContain('abcdef123456789');
    expect(entry.request.headers['Content-Type']).toBe('application/json');
    expect(entry.request.body).toContain('"temperature":0.2');
    expect(entry.request.truncated).toBe(false);
    expect(entry.response.status).toBe(200);
    expect(entry.response.finishReason).toBe('stop');
    expect(entry.response.usage).toEqual({ input: 3, output: 1 });
    expect(entry.response.body).toContain('finish_reason');
  });

  it('indexes stream chunks, caps oversized text and clears exchanges independently', () => {
    debugBus.clear();
    debugBus.log('info', 'test', 'keep me');
    const revisionBefore = debugBus.getRevision();
    debugBus.exchange({
      stage: 'chat', model: 'qwen-test', stream: true, attempt: 1,
      url: 'https://model.test/v1/chat/completions', headers: {},
      body: 'x'.repeat(70000), transport: 'fetch', ms: 12, responseText: '',
      content: 'ab', reasoning: 'r', finishReason: 'stop',
      chunks: [
        { kind: 'reasoning', text: 'r' },
        { kind: 'content', text: 'a' },
        { kind: 'content', text: 'b', finishReason: 'stop' },
        ...Array.from({ length: 1300 }, () => ({ kind: 'content' as const, text: 'c' })),
      ],
    });

    expect(debugBus.getRevision()).toBeGreaterThan(revisionBefore);
    const [entry] = debugBus.getExchanges();
    expect(entry.chunks[0]).toMatchObject({ index: 0, kind: 'reasoning', text: 'r' });
    expect(entry.chunks[2]).toMatchObject({ index: 2, kind: 'content', text: 'b', finishReason: 'stop' });
    expect(entry.chunks).toHaveLength(1200);
    expect(entry.droppedChunks).toBe(103);
    expect(entry.request.truncated).toBe(true);
    expect(entry.request.body.length).toBeLessThan(70000);
    expect(entry.response.truncated).toBe(false);

    const bundle = JSON.parse(debugBus.exportBundle()) as { exchanges: unknown[]; logs: unknown[] };
    expect(bundle.exchanges).toHaveLength(1);
    expect(bundle.logs).toHaveLength(1);

    debugBus.clear('exchanges');
    expect(debugBus.getExchanges()).toHaveLength(0);
    expect(debugBus.getLogs()).toHaveLength(1);
  });
});

describe('OpenAIRuntime exchange capture', () => {
  it('records the request body and parsed response of a JSON call', async () => {
    debugBus.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }), { status: 200 })));

    await new OpenAIRuntime(settings).complete(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
      { json: true, stage: 'review' },
    );

    const [entry] = debugBus.getExchanges();
    expect(entry.stage).toBe('review');
    expect(entry.stream).toBe(false);
    expect(entry.request.url).toBe('https://model.test/v1/chat/completions');
    expect(entry.request.headers.Authorization).not.toContain('abcdef123456789');
    const body = JSON.parse(entry.request.body) as Record<string, unknown>;
    expect(body.model).toBe('qwen-test');
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(false);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(entry.response.status).toBe(200);
    expect(entry.response.content).toBe('{"findings":[]}');
    expect(entry.response.finishReason).toBe('stop');
    expect(entry.response.usage).toEqual({ input: 5, output: 2 });
    expect(entry.response.error).toBeUndefined();
  });

  it('aggregates stream deltas and keeps the raw increments', async () => {
    debugBus.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      '{"choices":[{"delta":{"reasoning_content":"想一下"}}]}',
      '{"choices":[{"delta":{"content":"你"}}]}',
      '{"choices":[{"delta":{"content":"好"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4}}',
    ])));

    const tokens: string[] = [];
    const thinking: string[] = [];
    await new OpenAIRuntime(settings).complete(
      [{ role: 'user', content: 'hi' }],
      { stage: 'chat', onToken: (token) => tokens.push(token), onThinking: (token) => thinking.push(token) },
    );

    expect(tokens.join('')).toBe('你好');
    expect(thinking.join('')).toBe('想一下');
    const [entry] = debugBus.getExchanges();
    expect(entry.stream).toBe(true);
    expect(JSON.parse(entry.request.body) as Record<string, unknown>).toMatchObject({ stream: true });
    expect(entry.chunks.map((chunk) => chunk.kind)).toEqual(['reasoning', 'content', 'content']);
    expect(entry.chunks.map((chunk) => chunk.text).join('')).toBe('想一下你好');
    expect(entry.response.content).toBe('你好');
    expect(entry.response.reasoning).toBe('想一下');
    expect(entry.response.finishReason).toBe('stop');
    expect(entry.response.usage).toEqual({ input: 11, output: 4 });
  });

  it('records one exchange per attempt and keeps the failure reason', async () => {
    debugBus.clear();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })));

    await expect(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hello' }])).resolves.toBe('ok');

    const entries = debugBus.getExchanges();
    expect(entries.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(entries[0].response.status).toBe(429);
    expect(entries[0].response.error).toBe('busy');
    expect(entries[1].response.content).toBe('ok');
    expect(entries[1].response.error).toBeUndefined();
  });

  it('records the tool-call request including the tool list', async () => {
    debugBus.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{"path":"src/a.ts"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }), { status: 200 })));

    const result = await new OpenAIRuntime(settings).callWithTools(
      [{ role: 'user', content: 'read it' }],
      [{
        name: 'file_read',
        description: '读取文件',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] },
      }],
      'system prompt',
    );

    expect(result.type).toBe('tool_calls');
    const [entry] = debugBus.getExchanges();
    expect(entry.stage).toBe('tools');
    const body = JSON.parse(entry.request.body) as { messages: Array<{ role: string }>; tools: unknown[] };
    expect(body.messages[0]).toMatchObject({ role: 'system', content: 'system prompt' });
    expect(body.tools).toHaveLength(1);
    expect(entry.response.finishReason).toBe('tool_calls');
    expect(entry.response.content).toContain('file_read');
    expect(entry.response.usage).toEqual({ input: 7, output: 3 });
  });
});
