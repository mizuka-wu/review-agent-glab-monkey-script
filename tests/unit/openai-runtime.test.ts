import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIRuntime } from '../../src/core/openai-runtime';
import type { CodeSelection } from '../../src/core/types';

const settings = {
  provider: 'openai' as const,
  modelBaseUrl: 'https://model.test/v1',
  apiKey: 'key',
  model: 'model',
  gitlabToken: '',
  effort: 'balanced' as const,
  language: 'zh-CN' as const,
  mcp: { enabled: false, serverUrl: '' },
  auth: { mode: 'bearer' as const, customHeaders: {}, apiKeyHeader: 'Authorization', apiKeyQueryParam: 'key' },
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

function selectionOf(patch: Partial<CodeSelection> = {}): CodeSelection {
  return { filePath: 'src/payment.ts', side: 'new', text: 'const apiKey = "sk-live";', top: 0, left: 0, ...patch };
}

function promptOf(fetcher: ReturnType<typeof vi.fn>, call = 0): string {
  const body = JSON.parse(String((fetcher.mock.calls[call][1] as RequestInit).body)) as {
    messages: { content: string }[];
  };
  return body.messages.map((message) => message.content).join('\n');
}

function jsonResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

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
