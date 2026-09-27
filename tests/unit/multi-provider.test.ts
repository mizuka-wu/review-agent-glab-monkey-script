import { describe, expect, it, vi } from 'vitest';


import { createModelRuntime } from '../../src/core/model-runtime';
import { OpenAIRuntime } from '../../src/core/openai-runtime';
import type { RuntimeSettings } from '../../src/core/types';

function makeSettings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    provider: 'openai',
    modelBaseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    gitlabToken: '',
    effort: 'balanced',
    language: 'zh-CN',
    mcp: { enabled: false, serverUrl: '' },
    auth: { mode: 'bearer', customHeaders: {}, apiKeyHeader: 'Authorization', apiKeyQueryParam: 'key' },
    ...overrides,
  };
}

describe('createModelRuntime', () => {
  it('returns OpenAIRuntime for openai provider', () => {
    const runtime = createModelRuntime(makeSettings({ provider: 'openai' }));
    expect(runtime).toBeInstanceOf(OpenAIRuntime);
  });

  it('returns OpenAIRuntime for anthropic provider (unified)', () => {
    const runtime = createModelRuntime(makeSettings({ provider: 'anthropic' }));
    expect(runtime).toBeInstanceOf(OpenAIRuntime);
  });

  it('returns OpenAIRuntime for gemini provider (unified)', () => {
    const runtime = createModelRuntime(makeSettings({ provider: 'gemini' }));
    expect(runtime).toBeInstanceOf(OpenAIRuntime);
  });

  it('defaults to OpenAIRuntime for unknown provider', () => {
    const runtime = createModelRuntime(makeSettings({ provider: 'unknown' as RuntimeSettings['provider'] }));
    expect(runtime).toBeInstanceOf(OpenAIRuntime);
  });
});

describe('AnthropicRuntime (unified to OpenAI)', () => {
  it('is configured when all required fields are set', () => {
    const runtime = new OpenAIRuntime(makeSettings({ provider: 'anthropic' }));
    expect(runtime.configured).toBe(true);
  });

  it('is not configured without API key', () => {
    const runtime = new OpenAIRuntime(makeSettings({ provider: 'anthropic', apiKey: '' }));
    expect(runtime.configured).toBe(false);
  });

  it('is not configured without base URL', () => {
    const runtime = new OpenAIRuntime(makeSettings({ provider: 'anthropic', modelBaseUrl: '' }));
    expect(runtime.configured).toBe(false);
  });

  it('sends correct headers and endpoint on complete', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );

    const runtime = new OpenAIRuntime(makeSettings({
      provider: 'anthropic',
      modelBaseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    }));

    const result = await runtime.complete([{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'test' }]);
    expect(result).toBe('ok');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/chat/completions');
    const headers = options?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-ant-test');

    const body = JSON.parse(options?.body as string);
    expect(body.model).toBe('claude-sonnet-4-20250514');

    fetchSpy.mockRestore();
  });

  it('retries on 429 and succeeds', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls < 3) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 });
    });

    const runtime = new OpenAIRuntime(makeSettings({ provider: 'anthropic' }));
    const result = await runtime.complete([{ role: 'user', content: 'test' }]);
    expect(result).toBe('done');
    expect(calls).toBe(3);

    vi.restoreAllMocks();
  });
});

describe('GeminiRuntime (unified to OpenAI)', () => {
  it('is configured when all required fields are set', () => {
    const runtime = new OpenAIRuntime(makeSettings({ provider: 'gemini' }));
    expect(runtime.configured).toBe(true);
  });

  it('is not configured without API key', () => {
    const runtime = new OpenAIRuntime(makeSettings({ provider: 'gemini', apiKey: '' }));
    expect(runtime.configured).toBe(false);
  });

  it('sends correct endpoint and body format', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );

    const runtime = new OpenAIRuntime(makeSettings({
      provider: 'gemini',
      modelBaseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'AIza-test',
      model: 'gemini-2.0-flash',
    }));

    const result = await runtime.complete(
      [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'test' }],
    );
    expect(result).toBe('ok');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('/chat/completions');

    const body = JSON.parse(options?.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'test' },
    ]);

    fetchSpy.mockRestore();
  });
});
