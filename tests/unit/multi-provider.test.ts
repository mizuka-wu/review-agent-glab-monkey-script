import { describe, expect, it, vi } from 'vitest';
import { AnthropicRuntime } from '../../src/core/anthropic-runtime';
import { GeminiRuntime } from '../../src/core/gemini-runtime';
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
    ...overrides,
  };
}

describe('createModelRuntime', () => {
  it('returns OpenAIRuntime for openai provider', () => {
    const runtime = createModelRuntime(makeSettings({ provider: 'openai' }));
    expect(runtime).toBeInstanceOf(OpenAIRuntime);
  });

  it('returns AnthropicRuntime for anthropic provider', () => {
    const runtime = createModelRuntime(makeSettings({ provider: 'anthropic' }));
    expect(runtime).toBeInstanceOf(AnthropicRuntime);
  });

  it('returns GeminiRuntime for gemini provider', () => {
    const runtime = createModelRuntime(makeSettings({ provider: 'gemini' }));
    expect(runtime).toBeInstanceOf(GeminiRuntime);
  });

  it('defaults to OpenAIRuntime for unknown provider', () => {
    const runtime = createModelRuntime(makeSettings({ provider: 'unknown' as RuntimeSettings['provider'] }));
    expect(runtime).toBeInstanceOf(OpenAIRuntime);
  });
});

describe('AnthropicRuntime', () => {
  it('is configured when all required fields are set', () => {
    const runtime = new AnthropicRuntime(makeSettings({ provider: 'anthropic' }));
    expect(runtime.configured).toBe(true);
  });

  it('is not configured without API key', () => {
    const runtime = new AnthropicRuntime(makeSettings({ provider: 'anthropic', apiKey: '' }));
    expect(runtime.configured).toBe(false);
  });

  it('is not configured without base URL', () => {
    const runtime = new AnthropicRuntime(makeSettings({ provider: 'anthropic', modelBaseUrl: '' }));
    expect(runtime.configured).toBe(false);
  });

  it('sends correct headers and endpoint on complete', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
    );

    const runtime = new AnthropicRuntime(makeSettings({
      provider: 'anthropic',
      modelBaseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    }));

    const result = await runtime.complete([{ role: 'user', content: 'test' }], 'system prompt');
    expect(result).toBe('ok');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = options?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Authorization']).toBeUndefined();

    const body = JSON.parse(options?.body as string);
    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.system).toBe('system prompt');
    expect(body.messages).toEqual([{ role: 'user', content: 'test' }]);

    fetchSpy.mockRestore();
  });

  it('retries on 429 and succeeds', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls < 3) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }] }), { status: 200 });
    });

    const runtime = new AnthropicRuntime(makeSettings({ provider: 'anthropic' }));
    const result = await runtime.complete([{ role: 'user', content: 'test' }], 'sys');
    expect(result).toBe('done');
    expect(calls).toBe(3);

    vi.restoreAllMocks();
  });
});

describe('GeminiRuntime', () => {
  it('is configured when all required fields are set', () => {
    const runtime = new GeminiRuntime(makeSettings({ provider: 'gemini' }));
    expect(runtime.configured).toBe(true);
  });

  it('is not configured without API key', () => {
    const runtime = new GeminiRuntime(makeSettings({ provider: 'gemini', apiKey: '' }));
    expect(runtime.configured).toBe(false);
  });

  it('sends correct endpoint and body format', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 }),
    );

    const runtime = new GeminiRuntime(makeSettings({
      provider: 'gemini',
      modelBaseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'AIza-test',
      model: 'gemini-2.0-flash',
    }));

    const result = await runtime.complete(
      [{ role: 'user', parts: [{ text: 'test' }] }],
      'system prompt',
    );
    expect(result).toBe('ok');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('models/gemini-2.0-flash:generateContent');
    expect(url).toContain('key=AIza-test');

    const body = JSON.parse(options?.body as string);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'test' }] }]);
    expect(body.systemInstruction.parts[0].text).toBe('system prompt');

    fetchSpy.mockRestore();
  });
});
