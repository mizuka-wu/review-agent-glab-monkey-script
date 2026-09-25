import { describe, expect, it, vi } from 'vitest';
import { normalizeFileDiff } from '../../src/core/diff';
import { ReviewEngine } from '../../src/core/review-engine';
import type { Finding } from '../../src/core/types';

const settings = {
  modelBaseUrl: 'https://model.test/v1',
  apiKey: 'key',
  model: 'model',
  gitlabToken: '',
  effort: 'balanced' as const,
  language: 'zh-CN' as const,
};

const file = normalizeFileDiff({
  old_path: 'src/a.ts',
  new_path: 'src/a.ts',
  diff: '@@ -1 +1,3 @@\n-old\n+const x = 1;\n+console.log(x);\n+return x;',
});

describe('ReviewEngine', () => {
  it('builds a bounded context and reports omitted files', async () => {
    const runtime = { configured: false, review: vi.fn() };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file, normalizeFileDiff({ old_path: 'pnpm-lock.yaml', new_path: 'pnpm-lock.yaml', diff: '@@ -1 +1 @@\n-a\n+b' })] });

    expect(result.source).toBe('rule');
    expect(result.context.omittedFiles).toEqual([{ path: 'pnpm-lock.yaml', reason: 'lockfile' }]);
    expect(result.warnings[0]).toContain('pnpm-lock.yaml');
    expect(result.findings.some((finding) => finding.category === 'test')).toBe(true);
  });

  it('passes background context to the model and anchors findings by existing code', async () => {
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [{
        path: 'src/a.ts',
        existingCode: 'const x = 1;',
        category: 'bug',
        severity: 'high',
        confidence: 'high',
        title: 'Unsafe value',
        content: 'Explain the risk.',
      }] })),
    };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file], background: 'payment retry is required' });

    expect(runtime.review).toHaveBeenCalledWith([file], undefined, 'zh-CN', undefined, 'payment retry is required');
    expect(result.findings[0]).toMatchObject({ path: 'src/a.ts', line: 1, endLine: 1, side: 'new' });
  });

  it('deduplicates findings and filters low confidence in fast mode', async () => {
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [
        { path: 'src/a.ts', line: 1, category: 'bug', severity: 'low', confidence: 'low', title: 'Same', content: 'Same' },
        { path: 'src/a.ts', line: 2, category: 'bug', severity: 'high', confidence: 'high', title: 'Same', content: 'Same' },
      ] })),
    };
    const engine = new ReviewEngine(runtime, { ...settings, effort: 'fast' });
    const result = await engine.run({ files: [file] });

    expect(runtime.review).toHaveBeenCalledOnce();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].confidence).toBe('high');
  });

  it('drops model findings whose existing code cannot be anchored', async () => {
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [{
        path: 'src/a.ts', existingCode: 'missing()', category: 'bug', title: 'Bad', content: 'Bad',
      }] })),
    };
    const engine = new ReviewEngine(runtime, settings);
    expect((await engine.run({ files: [file] })).findings).toEqual([]);
  });
});

export type { Finding };
