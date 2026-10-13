import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MR_DESCRIPTION_BUDGET_CHARACTERS,
  buildReviewContext,
  mrDescriptionContext,
  truncateToBudget,
} from '../../src/core/context';
import { buildDelegationContext } from '../../src/core/delegation';
import { normalizeFileDiff } from '../../src/core/diff';
import { OpenAIRuntime } from '../../src/core/openai-runtime';
import { loadReferenceMr, referenceContextBlock } from '../../src/core/reference-mrs';
import { ReviewEngine } from '../../src/core/review-engine';
import { BUILT_IN_PACK } from '../../src/core/rule-packs';
import { summarizeReviewContext } from '../../src/core/session';
import type { FileDiff, MergeRequestContext, MrLinkRef, ReferenceMr, RuntimeSettings } from '../../src/core/types';

const settings = {
  provider: 'openai', modelBaseUrl: 'https://model.test/v1', apiKey: 'key', model: 'model',
  gitlabToken: '', effort: 'balanced', reviewMode: 'hybrid', language: 'zh-CN',
  mcp: { enabled: false, servers: [] }, auth: { mode: 'bearer', customHeaders: {}, apiKeyHeader: 'Authorization', apiKeyQueryParam: 'key' },
  repoIndex: { enabled: false, maxFiles: 100, maxBytes: 1000, maxIndexes: 3 },
  projectPrompts: {}, repoContext: false, debugEnabled: false, thinking: 'default',
} as unknown as RuntimeSettings;

const runtimeSettings = {
  provider: 'openai' as const, modelBaseUrl: 'https://model.test/v1', apiKey: 'key', model: 'model',
  gitlabToken: '', effort: 'balanced' as const, language: 'zh-CN' as const,
  mcp: { enabled: false, serverUrl: '' },
  auth: { mode: 'bearer' as const, customHeaders: {}, apiKeyHeader: 'Authorization', apiKeyQueryParam: 'key' },
};

function diffFile(path: string, diff: string): FileDiff {
  return normalizeFileDiff({ old_path: path, new_path: path, diff });
}

const currentFiles = [diffFile('src/current.ts', '@@ -1,2 +1,3 @@\n export function pay() {\n+  return charge();\n }')];

const DESCRIPTION = '## 需求\n支付失败时必须给出可操作的错误提示。\n\n- 不允许把密钥写进日志\n- 重试最多 3 次';

function runtimeReturning(findings: unknown[] = []) {
  return {
    configured: true,
    review: vi.fn().mockResolvedValue(JSON.stringify({ findings })),
    reflect: vi.fn().mockResolvedValue('[]'),
  };
}

function promptOf(fetcher: ReturnType<typeof vi.fn>, call = 0): string {
  const body = JSON.parse(String((fetcher.mock.calls[call][1] as RequestInit).body)) as {
    messages: { content: string }[];
  };
  return body.messages.map((message) => message.content).join('\n');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mrDescriptionContext', () => {
  it('renders the description as a labelled context block', () => {
    const block = mrDescriptionContext(DESCRIPTION);
    expect(block).toContain('## MR 说明（提交者写的需求背景，用来判断实现是否符合意图）');
    expect(block).toContain(DESCRIPTION);
    expect(block).toContain('不要对说明文字本身产出 finding');
  });

  it('skips the whole block for an empty description instead of rendering a hollow section', () => {
    for (const empty of [undefined, null, '', '   ', '\n\t  \n']) {
      expect(mrDescriptionContext(empty)).toBe('');
    }
  });

  it('trims surrounding whitespace so the block never starts or ends blank', () => {
    const block = mrDescriptionContext(`\n\n  ${DESCRIPTION}  \n\n`);
    expect(block.endsWith(DESCRIPTION)).toBe(true);
    expect(block).not.toContain('\n\n\n');
  });

  it('truncates an over-long description and says how much was dropped', () => {
    const long = `需求说明：${'x'.repeat(MR_DESCRIPTION_BUDGET_CHARACTERS + 900)}`;
    const block = mrDescriptionContext(long);
    expect(block).toContain(`已按 ${MR_DESCRIPTION_BUDGET_CHARACTERS} 字符预算截断，原文 ${long.length} 字符`);
    expect(block.length).toBeLessThan(long.length + 200);
    expect(block).not.toContain('x'.repeat(MR_DESCRIPTION_BUDGET_CHARACTERS));
  });

  it('keeps a description within budget verbatim, without a truncation marker', () => {
    const block = mrDescriptionContext(DESCRIPTION);
    expect(block).not.toContain('截断');
    expect(block).toContain('- 重试最多 3 次');
  });

  it('honours a smaller budget passed by the caller', () => {
    const block = mrDescriptionContext('a'.repeat(50), 20);
    expect(block).toContain('已按 20 字符预算截断，原文 50 字符');
  });
});

describe('truncateToBudget', () => {
  it('returns short text untouched and never slices on a non-positive budget', () => {
    expect(truncateToBudget('short', 100)).toBe('short');
    expect(truncateToBudget('short', 0)).toBe('short');
    expect(truncateToBudget('short', -5)).toBe('short');
  });
});

describe('buildReviewContext with a description', () => {
  it('counts the description block into the context size without touching the diff budget', () => {
    const block = mrDescriptionContext(DESCRIPTION);
    const withDescription = buildReviewContext({ files: currentFiles, descriptionCharacters: block.length });
    const without = buildReviewContext({ files: currentFiles });

    expect(withDescription.descriptionCharacters).toBe(block.length);
    expect(withDescription.estimatedCharacters).toBe(without.estimatedCharacters + block.length);
    expect(withDescription.files.filter((file) => file.included)).toHaveLength(without.files.length);
  });

  it('reports zero characters when the MR has no description', () => {
    expect(buildReviewContext({ files: currentFiles }).descriptionCharacters).toBe(0);
    expect(buildReviewContext({ files: currentFiles, descriptionCharacters: 0 }).estimatedCharacters)
      .toBe(buildReviewContext({ files: currentFiles }).estimatedCharacters);
  });
});

describe('ReviewEngine splices the MR description into the model input', () => {
  it('passes the description block to the single review call and records its size', async () => {
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, mrDescription: DESCRIPTION });

    expect(runtime.review).toHaveBeenCalledTimes(1);
    const options = runtime.review.mock.calls[0][5] as { mrDescription?: string };
    expect(options.mrDescription).toContain('## MR 说明');
    expect(options.mrDescription).toContain('重试最多 3 次');
    expect(result.context.descriptionCharacters).toBe(options.mrDescription!.length);
    expect(summarizeReviewContext(result.context).descriptionCharacters).toBe(options.mrDescription!.length);
  });

  it('leaves the option unset for a title-only MR', async () => {
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, mrDescription: '   ' });

    expect((runtime.review.mock.calls[0][5] as { mrDescription?: string }).mrDescription).toBeUndefined();
    expect(result.context.descriptionCharacters).toBe(0);
    expect(summarizeReviewContext(result.context).descriptionCharacters).toBeUndefined();
  });

  it('repeats the description block on every bundle of a split review', async () => {
    const manyFiles = Array.from({ length: 8 }, (_, index) =>
      diffFile(`src/file-${index}.ts`, `@@ -1 +1,2 @@\n-old\n+const value${index} = ${index};`));
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings);
    await engine.run({ files: manyFiles, mrDescription: DESCRIPTION });

    expect(runtime.review.mock.calls.length).toBeGreaterThan(1);
    for (const call of runtime.review.mock.calls) {
      expect((call[5] as { mrDescription?: string }).mrDescription).toContain('## MR 说明');
    }
  });

  it('still runs rules only when no model is configured', async () => {
    const runtime = { configured: false, review: vi.fn(), reflect: vi.fn() };
    const engine = new ReviewEngine(runtime, settings, [BUILT_IN_PACK]);
    const result = await engine.run({ files: currentFiles, mrDescription: DESCRIPTION });

    expect(runtime.review).not.toHaveBeenCalled();
    expect(result.context.descriptionCharacters).toBe(mrDescriptionContext(DESCRIPTION).length);
  });
});

describe('OpenAIRuntime review prompt', () => {
  it('puts the description after the diff and before the repo background', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetcher);

    await new OpenAIRuntime(runtimeSettings).review(
      currentFiles, undefined, 'zh-CN', undefined, '仓库符号上下文：src/current.ts 定义 pay()',
      { mrDescription: mrDescriptionContext(DESCRIPTION), projectPrompt: '只看安全问题' },
    );

    const prompt = promptOf(fetcher);
    const diffAt = prompt.indexOf('src/current.ts');
    const descriptionAt = prompt.indexOf('## MR 说明');
    const backgroundAt = prompt.indexOf('业务背景：');
    const projectAt = prompt.indexOf('## 项目补充要求');
    expect(descriptionAt).toBeGreaterThan(diffAt);
    expect(backgroundAt).toBeGreaterThan(descriptionAt);
    expect(projectAt).toBeGreaterThan(backgroundAt);
    expect(prompt).toContain('重试最多 3 次');
  });

  it('renders no empty description section when the MR has no description', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetcher);

    await new OpenAIRuntime(runtimeSettings).review(currentFiles, undefined, 'zh-CN', undefined, undefined, {});

    const prompt = promptOf(fetcher);
    expect(prompt).not.toContain('## MR 说明');
    expect(prompt).not.toMatch(/\n\n\n/);
  });
});

describe('reference MR descriptions', () => {
  const companion: MrLinkRef = { origin: 'https://other.test', projectPath: 'platform/sdk', iid: 12 };

  function reference(overrides: Partial<ReferenceMr> = {}): ReferenceMr {
    return {
      ref: companion, status: 'ready', title: 'feat: companion token endpoint', headSha: 'abcdef1234567890',
      addedAt: '2026-10-13T10:00:00.000Z',
      files: [diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')],
      ...overrides,
    };
  }

  it('splices the reference description into the read-only reference block', () => {
    const { text } = referenceContextBlock([reference({ description: 'SDK 侧配套：新增 token 下发接口。' })]);
    expect(text).toContain('#### [参考 platform/sdk!12] MR 说明（只读背景，不是评审对象）');
    expect(text).toContain('SDK 侧配套：新增 token 下发接口。');
    expect(text).toContain('不要对参考变更本身产出 finding');
    expect(text).toContain('src/companion.ts');
  });

  it('omits the section for a reference MR without a description', () => {
    expect(referenceContextBlock([reference()]).text).not.toContain('MR 说明');
    expect(referenceContextBlock([reference({ description: '   ' })]).text).not.toContain('MR 说明');
  });

  it('truncates the reference description to half of that reference budget so diffs stay dominant', () => {
    const long = 'y'.repeat(6_000);
    const { text } = referenceContextBlock([reference({ description: long })], 4_000);
    expect(text).toContain('已按 2000 字符预算截断，原文 6000 字符');
    expect(text).toContain('src/companion.ts');
  });

  it('charges the description to the reference budget instead of inflating it', () => {
    const files = Array.from({ length: 30 }, (_, index) =>
      diffFile(`src/file-${index}.ts`, `@@ -1 +1,10 @@\n${'+const v = 1;'.repeat(1)}`.repeat(10)));
    const plain = referenceContextBlock([reference({ files })], 4_000);
    const withDescription = referenceContextBlock(
      [reference({ files, description: 'z'.repeat(4_000) })],
      4_000,
    );
    expect(withDescription.fileCount).toBeLessThan(plain.fileCount);
  });

  it('keeps every reference description, one section per reference MR', () => {
    const other: MrLinkRef = { origin: 'https://other.test', projectPath: 'platform/web', iid: 30 };
    const { text } = referenceContextBlock([
      reference({ description: '第一个参考说明' }),
      reference({ ref: other, description: '第二个参考说明' }),
    ]);
    expect(text).toContain('[参考 platform/sdk!12] MR 说明');
    expect(text).toContain('[参考 platform/web!30] MR 说明');
    expect(text).toContain('第一个参考说明');
    expect(text).toContain('第二个参考说明');
  });

  it('carries the description loaded from the GitLab API', async () => {
    const context: MergeRequestContext = {
      origin: companion.origin, projectPath: companion.projectPath, mergeRequestIid: companion.iid,
      title: 'feat: companion', description: '  配套改动说明  ', state: 'opened',
      sourceBranch: 'feat/x', targetBranch: 'main', sha: 'head',
      diffRefs: { baseSha: 'base', headSha: 'abcdef1234567890', startSha: 'start' },
    };
    const loaded = await loadReferenceMr(companion, {
      getMergeRequest: vi.fn().mockResolvedValue(context),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
    });
    expect(loaded.description).toBe('配套改动说明');
  });

  it('leaves the description unset when the reference MR is title-only', async () => {
    const loaded = await loadReferenceMr(companion, {
      getMergeRequest: vi.fn().mockResolvedValue({
        origin: companion.origin, projectPath: companion.projectPath, mergeRequestIid: companion.iid,
        title: 'feat: companion', description: '', state: 'opened',
        sourceBranch: 'feat/x', targetBranch: 'main', sha: 'head',
        diffRefs: { baseSha: 'base', headSha: 'abcdef1234567890', startSha: 'start' },
      } satisfies MergeRequestContext),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
    });
    expect(loaded.description).toBeUndefined();
  });

  it('still drops a model finding aimed at a reference path when the reference carries a description', async () => {
    const runtime = runtimeReturning([{
      path: 'src/companion.ts', line: 1, endLine: 1, side: 'new', category: 'security', severity: 'high',
      confidence: 'high', title: '参考仓库里的问题', content: '不该出现在结果里。',
      existingCode: 'export const a = 1;', evidence: [], comment: 'x',
    }]);
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({
      files: currentFiles,
      references: [reference({ description: 'SDK 侧配套说明' })],
    });

    expect(result.findings.some((finding) => finding.path === 'src/companion.ts')).toBe(false);
    expect(result.warnings.join('\n')).toContain('丢弃了 1 条落在参考 MR 上的 AI Finding');
  });
});

describe('delegation export', () => {
  it('includes the MR description section', () => {
    const text = buildDelegationContext({
      files: currentFiles, packs: [BUILT_IN_PACK], description: DESCRIPTION,
      meta: { project: 'g/p', mergeRequestIid: 7, headSha: 'abc123' },
    });
    expect(text).toContain('## MR 说明');
    expect(text).toContain('重试最多 3 次');
  });

  it('says the description is absent instead of dropping the section', () => {
    const text = buildDelegationContext({ files: currentFiles, packs: [BUILT_IN_PACK] });
    expect(text).toContain('## MR 说明\n(无)');
  });
});
