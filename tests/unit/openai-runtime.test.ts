import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIRuntime } from '../../src/core/openai-runtime';

const settings = {
  modelBaseUrl: 'https://model.test/v1',
  apiKey: 'key',
  model: 'model',
  gitlabToken: '',
  effort: 'balanced' as const,
  language: 'zh-CN' as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAIRuntime', () => {
  it('retries retryable model responses and returns content', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    await expect(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hello' }])).resolves.toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable model errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    vi.stubGlobal('fetch', fetcher);

    await expect(new OpenAIRuntime(settings).complete([{ role: 'user', content: 'hello' }])).rejects.toThrow('bad key');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
