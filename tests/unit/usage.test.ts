import { describe, expect, it } from 'vitest';
import {
  clearUsage,
  formatCost,
  formatTokenCount,
  getUsageSummary,
  parseAnthropicUsage,
  parseGeminiUsage,
  parseOpenAIUsage,
  recordUsage,
} from '../../src/core/usage';

function makeStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    async getValue(key: string, fallback: unknown) {
      return store.has(key) ? store.get(key) : fallback;
    },
    async setValue(key: string, value: unknown) {
      store.set(key, value);
    },
  };
}

describe('usage tracking', () => {
  it('records usage and computes cost', async () => {
    const storage = makeStorage();
    const record = await recordUsage('openai', 'gpt-4o-mini', 1000, 500, storage);
    expect(record.inputTokens).toBe(1000);
    expect(record.outputTokens).toBe(500);
    expect(record.estimatedCost).toBeGreaterThan(0);
  });

  it('accumulates usage summary', async () => {
    const storage = makeStorage();
    await recordUsage('openai', 'gpt-4o-mini', 1000, 500, storage);
    await recordUsage('openai', 'gpt-4o-mini', 2000, 1000, storage);
    await recordUsage('anthropic', 'claude-sonnet-4-20250514', 3000, 1500, storage);

    const summary = await getUsageSummary(storage);
    expect(summary.callCount).toBe(3);
    expect(summary.totalInputTokens).toBe(6000);
    expect(summary.totalOutputTokens).toBe(3000);
    expect(summary.totalEstimatedCost).toBeGreaterThan(0);
    expect(Object.keys(summary.byModel)).toHaveLength(2);
  });

  it('clears usage', async () => {
    const storage = makeStorage();
    await recordUsage('openai', 'gpt-4o-mini', 100, 50, storage);
    await clearUsage(storage);
    const summary = await getUsageSummary(storage);
    expect(summary.callCount).toBe(0);
  });

  it('parses OpenAI usage', () => {
    const usage = parseOpenAIUsage({ usage: { prompt_tokens: 100, completion_tokens: 50 } });
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
  });

  it('parses Anthropic usage', () => {
    const usage = parseAnthropicUsage({ usage: { input_tokens: 200, output_tokens: 100 } });
    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(100);
  });

  it('parses Gemini usage', () => {
    const usage = parseGeminiUsage({ usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 150 } });
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(150);
  });

  it('handles missing usage gracefully', () => {
    expect(parseOpenAIUsage({}).inputTokens).toBe(0);
    expect(parseAnthropicUsage({}).inputTokens).toBe(0);
    expect(parseGeminiUsage({}).inputTokens).toBe(0);
  });
});

describe('formatting', () => {
  it('formats token counts', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
  });

  it('formats costs', () => {
    expect(formatCost(0.001)).toBe('$0.0010');
    expect(formatCost(0.05)).toBe('$0.050');
    expect(formatCost(1.5)).toBe('$1.50');
  });
});
