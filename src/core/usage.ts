import type { ModelProvider, UsageRecord } from './types';

// --- Usage tracking ---

const USAGE_KEY = 'review-agent-usage-v1';

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
  callCount: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; estimatedCost: number; count: number }>;
  records: UsageRecord[];
}

// Approximate cost per 1K tokens (USD) — for estimation only
const COST_PER_K_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-haiku-3': { input: 0.00025, output: 0.00125 },
  'gemini-2.0-flash': { input: 0.0001, output: 0.0004 },
  'gemini-2.0-pro': { input: 0.00125, output: 0.005 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_PER_K_TOKENS[model] ?? { input: 0.001, output: 0.002 }; // generic fallback
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}

type StorageBackend = {
  getValue(key: string, fallback: unknown): Promise<unknown>;
  setValue(key: string, value: unknown): Promise<void>;
};

function defaultStorage(): StorageBackend {
  const gm = (globalThis as typeof globalThis & { GM?: StorageBackend }).GM;
  if (gm) return gm;
  return {
    async getValue(key, fallback) {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    },
    async setValue(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
  };
}

export async function recordUsage(
  provider: ModelProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
  storage = defaultStorage(),
): Promise<UsageRecord> {
  const record: UsageRecord = {
    timestamp: new Date().toISOString(),
    provider,
    model,
    inputTokens,
    outputTokens,
    estimatedCost: estimateCost(model, inputTokens, outputTokens),
  };

  const raw = await storage.getValue(USAGE_KEY, []);
  const records = Array.isArray(raw) ? (raw as UsageRecord[]) : [];
  records.push(record);

  // Keep last 500 records
  const trimmed = records.slice(-500);
  await storage.setValue(USAGE_KEY, trimmed);

  return record;
}

export async function getUsageSummary(storage = defaultStorage()): Promise<UsageSummary> {
  const raw = await storage.getValue(USAGE_KEY, []);
  const records = Array.isArray(raw) ? (raw as UsageRecord[]) : [];

  const summary: UsageSummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    callCount: records.length,
    byModel: {},
    records,
  };

  for (const record of records) {
    summary.totalInputTokens += record.inputTokens;
    summary.totalOutputTokens += record.outputTokens;
    summary.totalEstimatedCost += record.estimatedCost;

    const key = `${record.provider}/${record.model}`;
    if (!summary.byModel[key]) {
      summary.byModel[key] = { inputTokens: 0, outputTokens: 0, estimatedCost: 0, count: 0 };
    }
    summary.byModel[key].inputTokens += record.inputTokens;
    summary.byModel[key].outputTokens += record.outputTokens;
    summary.byModel[key].estimatedCost += record.estimatedCost;
    summary.byModel[key].count += 1;
  }

  return summary;
}

export async function clearUsage(storage = defaultStorage()): Promise<void> {
  await storage.setValue(USAGE_KEY, []);
}

// --- Parse usage from API responses ---

export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
}

export function parseOpenAIUsage(payload: Record<string, unknown>): ParsedUsage {
  const usage = payload.usage as Record<string, number> | undefined;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

export function parseAnthropicUsage(payload: Record<string, unknown>): ParsedUsage {
  const usage = payload.usage as Record<string, number> | undefined;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

export function parseGeminiUsage(payload: Record<string, unknown>): ParsedUsage {
  const usage = payload.usageMetadata as Record<string, number> | undefined;
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
  };
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
