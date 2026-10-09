import { describe, expect, it, vi } from 'vitest';
import { resolvePublishPosition } from '../../src/core/anchor';
import { normalizeFileDiff } from '../../src/core/diff';
import { ReviewEngine } from '../../src/core/review-engine';
import { summarizeReviewContext } from '../../src/core/session';
import type { FileDiff, MrLinkRef, ReferenceMr, RuntimeSettings } from '../../src/core/types';

const settings = {
  provider: 'openai', modelBaseUrl: 'https://model.test/v1', apiKey: 'key', model: 'model',
  gitlabToken: '', effort: 'balanced', reviewMode: 'hybrid', language: 'zh-CN',
  mcp: { enabled: false, servers: [] }, auth: { mode: 'bearer', customHeaders: {}, apiKeyHeader: 'Authorization', apiKeyQueryParam: 'key' },
  repoIndex: { enabled: false, maxFiles: 100, maxBytes: 1000, maxIndexes: 3 },
  projectPrompts: {}, repoContext: false, debugEnabled: false, thinking: 'default',
} as unknown as RuntimeSettings;

const companionRef: MrLinkRef = { origin: 'https://other.test', projectPath: 'platform/sdk', iid: 12 };

function diffFile(path: string, diff: string): FileDiff {
  return normalizeFileDiff({ old_path: path, new_path: path, diff });
}

/** 当前 MR：改了 src/current.ts，没动测试。 */
const currentFiles = [diffFile('src/current.ts', '@@ -1,2 +1,4 @@\n export function pay() {\n+  const apiKey = "sk-live-123";\n+  return charge(apiKey);\n }')];

/** 参考 MR：另一个项目里的配套改动，里面有一处一眼可见的硬编码密钥。 */
function companionReference(overrides: Partial<ReferenceMr> = {}): ReferenceMr {
  return {
    ref: companionRef,
    status: 'ready',
    title: 'feat: companion token endpoint',
    headSha: 'abcdef1234567890',
    addedAt: '2026-10-09T10:00:00.000Z',
    files: [diffFile('src/companion.ts', '@@ -0,0 +1,2 @@\n+export const COMPANION_TOKEN = "sk-live-999";\n+export function ping() { return "pong"; }')],
    ...overrides,
  };
}

function modelFinding(overrides: Record<string, unknown> = {}) {
  return {
    path: 'src/current.ts',
    line: 2,
    endLine: 2,
    side: 'new',
    category: 'security',
    severity: 'high',
    confidence: 'high',
    title: '硬编码密钥',
    content: '新增代码把 API Key 直接写进了源文件，应当改从配置读取。',
    existingCode: 'const apiKey = "sk-live-123";',
    evidence: [{ path: 'src/current.ts', lines: 'L2', quote: 'const apiKey = "sk-live-123";' }],
    comment: '请把密钥移到配置。',
    ...overrides,
  };
}

function runtimeReturning(findings: unknown[]) {
  return {
    configured: true,
    review: vi.fn().mockResolvedValue(JSON.stringify({ findings })),
    reflect: vi.fn().mockResolvedValue('[]'),
  };
}

describe('review with reference MRs', () => {
  it('splices the reference block into the single model call for the current MR', async () => {
    const runtime = runtimeReturning([modelFinding()]);
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, references: [companionReference()] });

    expect(runtime.review).toHaveBeenCalledTimes(1);
    const [files, selection, language, signal, background, options] = runtime.review.mock.calls[0];
    expect(files).toEqual(currentFiles);
    expect(selection).toBeUndefined();
    expect(language).toBe('zh-CN');
    expect(signal).toBeUndefined();
    expect(background).toBeUndefined();
    expect(options.references).toContain('## 参考变更：其他 MR（只读上下文，不是评审对象）');
    expect(options.references).toContain('platform/sdk!12');
    expect(options.references).toContain('COMPANION_TOKEN');

    expect(result.context.references).toHaveLength(1);
    expect(result.context.referenceCharacters).toBe(options.references.length);
    expect(result.context.estimatedCharacters).toBeGreaterThanOrEqual(options.references.length);
    expect(result.warnings.join('\n')).toContain('已注入 1 个参考 MR');
  });

  it('leaves the prompt untouched when no reference MR is attached', async () => {
    const runtime = runtimeReturning([modelFinding()]);
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles });

    expect(runtime.review.mock.calls[0][5]).toEqual({ onToken: undefined, onThinking: undefined, projectPrompt: undefined, references: undefined });
    expect(result.context.references).toEqual([]);
    expect(result.context.referenceCharacters).toBe(0);
    expect(result.warnings.join('\n')).not.toContain('参考 MR');
  });

  it('never produces a rule finding on a reference MR file', async () => {
    const engine = new ReviewEngine({ configured: false, review: vi.fn(), reflect: vi.fn() }, settings);
    const result = await engine.run({ files: currentFiles, references: [companionReference()] });

    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some((finding) => finding.path.includes('companion'))).toBe(false);
    expect(result.findings.every((finding) => finding.path === 'src/current.ts')).toBe(true);
    expect(result.findings.some((finding) => finding.ruleId === 'builtin-hardcoded-secret')).toBe(true);
  });

  it('lets a reference test file satisfy the missing-test rule for the current MR', async () => {
    const engine = new ReviewEngine({ configured: false, review: vi.fn(), reflect: vi.fn() }, settings);
    const withoutReference = await engine.run({ files: currentFiles });
    const withReference = await engine.run({
      files: currentFiles,
      references: [companionReference({ files: [diffFile('tests/companion.test.ts', '@@ -0,0 +1 @@\n+it("works", () => {});')] })],
    });

    expect(withoutReference.findings.some((finding) => finding.ruleId === 'builtin-missing-test')).toBe(true);
    expect(withReference.findings.some((finding) => finding.ruleId === 'builtin-missing-test')).toBe(false);
  });

  it('drops an AI finding aimed at the reference MR and says so', async () => {
    const runtime = runtimeReturning([
      modelFinding(),
      modelFinding({
        path: 'src/companion.ts',
        line: 1,
        title: '参考仓库里也有硬编码密钥',
        content: '参考 MR 的 src/companion.ts 同样把 Token 写死在源文件里。',
        existingCode: 'export const COMPANION_TOKEN = "sk-live-999";',
        evidence: [{ path: 'src/companion.ts', lines: 'L1', quote: 'export const COMPANION_TOKEN = "sk-live-999";' }],
      }),
    ]);
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, references: [companionReference()] });

    expect(result.findings.map((finding) => finding.path)).not.toContain('src/companion.ts');
    expect(result.findings.some((finding) => finding.title === '硬编码密钥')).toBe(true);
    expect(result.warnings.join('\n')).toContain('丢弃了 1 条落在参考 MR 上的 AI Finding');
  });

  it('keeps a finding on the current MR that cites the reference change as evidence', async () => {
    const runtime = runtimeReturning([modelFinding({
      title: '与配套 MR 的字段名不一致',
      content: '当前 MR 读取 apiKey，而配套的 platform/sdk!12 已经把它改名为 token。',
      evidence: [
        { path: 'src/current.ts', lines: 'L2', quote: 'const apiKey = "sk-live-123";' },
        { path: 'src/companion.ts', lines: 'L1', quote: 'export const COMPANION_TOKEN = "sk-live-999";' },
      ],
    })]);
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, references: [companionReference()] });

    const fromModel = result.findings.filter((finding) => finding.source === 'model');
    expect(fromModel).toHaveLength(1);
    expect(fromModel[0]).toMatchObject({ path: 'src/current.ts', title: '与配套 MR 的字段名不一致' });
    expect(fromModel[0].evidence.map((item) => item.path)).toContain('src/companion.ts');
    expect(result.warnings.join('\n')).not.toContain('落在参考 MR 上');
  });

  it('keeps a finding on a path both MRs touch, since the current diff owns it', async () => {
    const runtime = runtimeReturning([modelFinding()]);
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({
      files: currentFiles,
      references: [companionReference({ files: [diffFile('src/current.ts', '@@ -1 +1 @@\n-a\n+b')] })],
    });

    expect(result.findings.some((finding) => finding.title === '硬编码密钥')).toBe(true);
    expect(result.warnings.join('\n')).not.toContain('落在参考 MR 上');
  });

  it('never reads a reference-only path from the current project when loading full files', async () => {
    const loadFile = vi.fn(async (path: string) => `content of ${path}\n`);
    const runtime = runtimeReturning([modelFinding({
      path: 'src/companion.ts',
      existingCode: '',
      line: 1,
      title: '参考文件上的问题',
      content: '这条 Finding 落在参考 MR 的文件上，应该被丢弃。',
      evidence: [{ path: 'src/companion.ts', lines: 'L1', quote: 'COMPANION_TOKEN' }],
    })]);
    const engine = new ReviewEngine(runtime, settings);
    await engine.run({
      files: currentFiles,
      references: [companionReference()],
      loadFile,
      fullFileRef: 'head-sha',
    });

    expect(loadFile.mock.calls.map((call) => call[0])).not.toContain('src/companion.ts');
  });

  it('reports which reference MR could not be fetched and why', async () => {
    const engine = new ReviewEngine({ configured: false, review: vi.fn(), reflect: vi.fn() }, settings);
    const result = await engine.run({
      files: currentFiles,
      references: [
        companionReference({ status: 'failed', files: [], title: undefined, headSha: undefined, error: '找不到 platform/sdk!12（HTTP 404）：MR 不存在、被删除，或 Token 看不到该项目' }),
        { ...companionReference(), ref: { origin: 'https://other.test', projectPath: 'group/pending', iid: 3 }, status: 'loading', files: [] },
        { ...companionReference(), ref: { origin: 'https://other.test', projectPath: 'group/empty', iid: 4 }, files: [] },
      ],
    });
    const warnings = result.warnings.join('\n');

    expect(warnings).toContain('参考 MR platform/sdk!12 拉取失败：找不到 platform/sdk!12（HTTP 404）');
    expect(warnings).toContain('参考 MR group/pending!3 还没拉取完成');
    expect(warnings).toContain('参考 MR group/empty!4 没有可用的变更文件');
    expect(warnings).not.toContain('已注入');
  });

  it('records the references used in the review context of the current MR', async () => {
    const engine = new ReviewEngine({ configured: false, review: vi.fn(), reflect: vi.fn() }, settings);
    const result = await engine.run({ files: currentFiles, references: [companionReference()] });
    expect(result.context.references?.[0]).toMatchObject({ status: 'ready', title: 'feat: companion token endpoint' });
    expect(result.context.files.map((file) => file.newPath)).toEqual(['src/current.ts']);
  });
});

describe('publish routing with reference MRs', () => {
  it('resolves every publish position against the current MR diff only', async () => {
    const runtime = runtimeReturning([
      modelFinding(),
      modelFinding({ path: 'src/companion.ts', existingCode: 'export const COMPANION_TOKEN = "sk-live-999";', line: 1, title: '参考仓库的问题', content: '这条不应该活到发布阶段。' }),
    ]);
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, references: [companionReference()] });
    const publishable = result.findings.map((finding) => resolvePublishPosition(finding, currentFiles));

    expect(result.findings.length).toBeGreaterThan(0);
    for (const position of publishable) {
      if (!position.publishable) continue;
      expect(currentFiles.map((file) => file.newPath)).toContain(position.finding.path);
      expect(position.finding.path).not.toContain('companion');
    }
    expect(publishable.filter((position) => position.publishable).length).toBeGreaterThan(0);
  });

  it('would refuse an inline position for a reference path even if one slipped through', () => {
    const leaked = resolvePublishPosition({
      id: 'x', fingerprint: 'x', path: 'src/companion.ts', line: 1, endLine: 1, side: 'new' as const,
      category: 'bug' as const, severity: 'high' as const, confidence: 'high' as const,
      title: 'x', content: 'x', evidence: [], existingCode: 'export const COMPANION_TOKEN', suggestionCode: '',
      comment: 'x', source: 'model' as const, status: 'draft' as const,
    }, currentFiles);
    expect(leaked.publishable).toBe(false);
    expect(leaked.reasonCode).toBe('path-not-in-diff');
  });
});

describe('review session summary', () => {
  it('remembers which reference MRs were consulted, on the current MR record', async () => {
    const engine = new ReviewEngine({ configured: false, review: vi.fn(), reflect: vi.fn() }, settings);
    const result = await engine.run({
      files: currentFiles,
      references: [companionReference(), { ...companionReference(), ref: { origin: 'https://other.test', projectPath: 'group/gone', iid: 9 }, status: 'failed', files: [], error: 'HTTP 404' }],
    });
    const summary = summarizeReviewContext(result.context);

    expect(summary.references).toEqual([
      { label: 'platform/sdk!12', title: 'feat: companion token endpoint', status: 'ready', files: 1 },
      { label: 'group/gone!9', title: 'feat: companion token endpoint', status: 'failed', files: 0 },
    ]);
    expect(summary.referenceCharacters).toBeGreaterThan(0);
    expect(summary.includedFiles).toBe(1);
  });

  it('leaves the summary shape alone for a plain single-MR review', async () => {
    const engine = new ReviewEngine({ configured: false, review: vi.fn(), reflect: vi.fn() }, settings);
    const result = await engine.run({ files: currentFiles });
    const summary = summarizeReviewContext(result.context);
    expect(summary.references).toBeUndefined();
    expect(summary.referenceCharacters).toBeUndefined();
  });
});
