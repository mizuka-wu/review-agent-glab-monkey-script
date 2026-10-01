import { describe, expect, it, vi } from 'vitest';
import { normalizeFileDiff } from '../../src/core/diff';
import { ReviewEngine } from '../../src/core/review-engine';
import type { Finding } from '../../src/core/types';

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
        content: 'Explain the risk in detail with clear reasoning.',
        evidence: [{ path: 'src/a.ts', lines: 'L1', quote: 'const x = 1;' }],
      }] })),
    };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file], background: 'payment retry is required' });

    expect(runtime.review).toHaveBeenCalledWith([file], undefined, 'zh-CN', undefined, 'payment retry is required', { onToken: undefined });
    expect(result.findings[0]).toMatchObject({ path: 'src/a.ts', line: 1, endLine: 1, side: 'new' });
  });

  it('deduplicates findings and filters low confidence in fast mode', async () => {
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [
        { path: 'src/a.ts', line: 1, category: 'bug', severity: 'low', confidence: 'low', title: 'Same', content: 'Same issue description', existingCode: 'const x = 1;', evidence: [{ path: 'src/a.ts', lines: 'L1', quote: 'const x = 1;' }] },
        { path: 'src/a.ts', line: 2, category: 'bug', severity: 'high', confidence: 'high', title: 'Same', content: 'Same issue description', existingCode: 'console.log(x);', evidence: [{ path: 'src/a.ts', lines: 'L2', quote: 'console.log(x);' }] },
      ] })),
    };
    const engine = new ReviewEngine(runtime, { ...settings, effort: 'fast' });
    const result = await engine.run({ files: [file] });

    expect(runtime.review).toHaveBeenCalledOnce();
    const fromModel = result.findings.filter((finding) => finding.source === 'model');
    expect(fromModel).toHaveLength(1);
    expect(fromModel[0].confidence).toBe('high');
    // 规则命中是确定性结果，不受审查强度影响
    expect(result.findings.some((finding) => finding.source === 'rule')).toBe(true);
  });

  it('drops model findings whose existing code cannot be anchored', async () => {
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [{
        path: 'src/a.ts', existingCode: 'missing()', category: 'bug', title: 'Bad', content: 'Bad',
      }] })),
    };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file] });
    expect(result.findings.filter((finding) => finding.source === 'model')).toEqual([]);
    expect(result.stages.model.ran).toBe(true);
  });

  it('runs deterministic rules without a configured model', async () => {
    const runtime = { configured: false, review: vi.fn() };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file] });

    expect(runtime.review).not.toHaveBeenCalled();
    expect(result.source).toBe('rule');
    expect(result.sources).toEqual(['rule']);
    expect(result.stages.model).toEqual({ ran: false, findings: 0 });
    expect(result.stages.rules.ran).toBe(true);
    expect(result.stages.rules.rules).toBeGreaterThan(0);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((finding) => finding.source === 'rule' && finding.ruleId)).toBe(true);
    expect(result.warnings.join(' ')).toContain('仅执行');
  });

  it('reports both sources in hybrid mode and tags rule provenance', async () => {
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [{
        path: 'src/a.ts', existingCode: 'return x;', category: 'bug', severity: 'high', confidence: 'high',
        title: 'Unbounded return value', content: 'Detailed explanation of the returned value risk.',
        evidence: [{ path: 'src/a.ts', lines: 'L3', quote: 'return x;' }],
      }] })),
    };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file] });

    expect(result.sources).toEqual(['rule', 'model']);
    expect(result.source).toBe('model');
    expect(result.stages.rules.findings).toBeGreaterThan(0);
    expect(result.stages.model.findings).toBe(1);
    const ruleFinding = result.findings.find((finding) => finding.ruleId === 'builtin-console-log');
    expect(ruleFinding).toMatchObject({ source: 'rule', rulePackId: 'built-in', rulePackName: '内置规则' });
    expect(ruleFinding?.comment).toContain('规则检查 `builtin-console-log`');
  });

  it('keeps rule findings when the model call fails', async () => {
    const runtime = { configured: true, review: vi.fn().mockRejectedValue(new Error('401 invalid api key')) };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file] });

    expect(result.source).toBe('rule');
    expect(result.stages.model.error).toContain('401');
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toContain('AI 评审未产出结果');
  });

  it('can skip the rule stage', async () => {
    const runtime = { configured: true, review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [] })) };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file], rules: false });

    expect(result.stages.rules).toEqual({ ran: false, findings: 0, rules: 0 });
    expect(result.findings).toEqual([]);
  });

  it('loads full-file context and relocates unique evidence across files', async () => {
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [{
        path: 'src/wrong.ts',
        evidence: [{ path: 'src/helper.ts', quote: 'function helper() {' }],
        existingCode: 'function helper() {\n  return 1;\n}',
        category: 'bug',
        severity: 'high',
        confidence: 'high',
        title: 'Cross-file risk',
        content: 'Explain the cross-file risk with detailed analysis.',
      }] })),
    };
    const loader = vi.fn(async (path: string) => path === 'src/helper.ts'
      ? 'function helper() {\n  return 1;\n}'
      : 'const x = 1;\nconsole.log(x);\nreturn x;');
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({
      files: [file],
      loadFile: loader,
      fullFileRef: 'head-sha',
    });

    expect(result.context.fullFiles.map((item) => item.path)).toEqual(expect.arrayContaining(['src/a.ts', 'src/helper.ts']));
    expect(result.findings[0]).toMatchObject({
      path: 'src/helper.ts',
      anchor: { source: 'full-file', publishable: false, relocatedFromPath: 'src/wrong.ts' },
    });
    expect(result.warnings.join(' ')).toContain('跨文件重定位');
  });
});

export type { Finding };

describe('ReviewEngine bundles and reflection', () => {
  function modelFinding(path: string, title: string) {
    return {
      path,
      existingCode: 'const x = 1;',
      category: 'bug',
      severity: 'high',
      confidence: 'high',
      title,
      content: 'Explain the risk with evidence.',
      evidence: [{ path, lines: 'L1', quote: 'const x = 1;' }],
    };
  }

  it('reviews multiple bundles concurrently and merges their findings', async () => {
    const files = [
      ...Array.from({ length: 4 }, (_, i) => normalizeFileDiff({
        old_path: `src/a/f${i}.ts`, new_path: `src/a/f${i}.ts`,
        diff: '@@ -1 +1,2 @@\n-old\n+const x = 1;\n+console.log(x);',
      })),
      ...Array.from({ length: 4 }, (_, i) => normalizeFileDiff({
        old_path: `src/b/f${i}.ts`, new_path: `src/b/f${i}.ts`,
        diff: '@@ -1 +1,2 @@\n-old\n+const x = 1;\n+console.log(x);',
      })),
    ];
    const bundleCalls: number[] = [];
    const runtime = {
      configured: true,
      review: vi.fn().mockImplementation(async (bundle: typeof files) => {
        bundleCalls.push(bundle.length);
        return JSON.stringify({ findings: [modelFinding(bundle[0].newPath, `issue in ${bundle[0].newPath}`)] });
      }),
      reflect: vi.fn().mockResolvedValue('[]'),
    };
    const engine = new ReviewEngine(runtime, settings);
    const seen: Finding[][] = [];
    const result = await engine.run({ files, onBundleFindings: (findings) => seen.push(findings) });

    expect(bundleCalls).toEqual([4, 4]);
    expect(seen).toHaveLength(2);
    expect(result.findings.filter((finding) => finding.source === 'model')).toHaveLength(2);
    expect(result.stages.model.findings).toBe(2);
  });

  it('drops AI findings the reflection module rejects and keeps rule findings', async () => {
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [modelFinding('src/a.ts', 'Unsafe value')] })),
      reflect: vi.fn().mockImplementation(async (payload: string) => {
        const items = JSON.parse(payload) as { id: string }[];
        return JSON.stringify(items.map((item) => ({ id: item.id, keep: false, reason: '纯风格偏好' })));
      }),
    };
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: [file] });

    expect(result.findings.filter((finding) => finding.source === 'model')).toHaveLength(0);
    expect(result.findings.some((finding) => finding.source === 'rule')).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('反思模块移除'))).toBe(true);
  });

  it('skips reflection on fast effort', async () => {
    const reflect = vi.fn().mockResolvedValue('[]');
    const runtime = {
      configured: true,
      review: vi.fn().mockResolvedValue(JSON.stringify({ findings: [modelFinding('src/a.ts', 'Unsafe value')] })),
      reflect,
    };
    const engine = new ReviewEngine(runtime, { ...settings, effort: 'fast' });
    const result = await engine.run({ files: [file] });
    expect(reflect).not.toHaveBeenCalled();
    expect(result.findings.filter((finding) => finding.source === 'model')).toHaveLength(1);
  });
});

describe('ReviewEngine.scan', () => {
  it('runs rules over full files and marks findings unpublishable', () => {
    const runtime = { configured: false, review: vi.fn(), reflect: vi.fn() };
    const engine = new ReviewEngine(runtime, settings);
    const scanned = engine.scan([normalizeFileDiff({
      old_path: 'src/s.ts', new_path: 'src/s.ts',
      diff: '@@ -0,0 +1,2 @@\n+const apiKey = "sk-live-123";\n+use(apiKey);',
    })]);
    expect(scanned.length).toBeGreaterThan(0);
    for (const finding of scanned) {
      expect(finding.anchor).toEqual({ source: 'full-file', publishable: false });
    }
  });
});
