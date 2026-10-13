import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import {
  MR_COMMIT_MESSAGE_BUDGET_CHARACTERS,
  MR_COMMITS_BUDGET_CHARACTERS,
  MR_COMMITS_MAX_ENTRIES,
  MR_DESCRIPTION_BUDGET_CHARACTERS,
  buildReviewContext,
  formatMrCommits,
  mrCommitsContext,
} from '../../src/core/context';
import { buildDelegationContext } from '../../src/core/delegation';
import { normalizeFileDiff } from '../../src/core/diff';
import { GitLabAdapter, GitLabApiError, normalizeMrCommit } from '../../src/core/gitlab-adapter';
import { OpenAIRuntime } from '../../src/core/openai-runtime';
import { loadReferenceMr, referenceContextBlock } from '../../src/core/reference-mrs';
import { ReviewEngine } from '../../src/core/review-engine';
import { BUILT_IN_PACK } from '../../src/core/rule-packs';
import { summarizeReviewContext } from '../../src/core/session';
import type {
  FileDiff, MergeRequestContext, MrCommit, MrLinkRef, PageContext, ReferenceMr, RuntimeSettings,
} from '../../src/core/types';

const settings = {
  provider: 'openai', modelBaseUrl: 'https://model.test/v1', apiKey: 'key', model: 'model',
  gitlabToken: '', effort: 'balanced', reviewMode: 'hybrid', language: 'zh-CN',
  mcp: { enabled: false, servers: [] }, auth: { mode: 'bearer', customHeaders: {}, apiKeyHeader: 'Authorization', apiKeyQueryParam: 'key' },
  repoIndex: { enabled: false, maxFiles: 100, maxBytes: 1000, maxIndexes: 3 },
  projectPrompts: {}, repoContext: false, debugEnabled: false, thinking: 'default',
  includeMrDescription: true, includeMrCommits: true,
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

function commit(overrides: Partial<MrCommit> = {}): MrCommit {
  return {
    id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    shortId: 'a1b2c3d4',
    title: 'feat(pay): 支持支付失败重试',
    message: 'feat(pay): 支持支付失败重试\n\n需求：支付网关超时后最多重试 3 次，指数退避。\n重试次数走配置，不写死。',
    authorName: 'mizuka',
    createdAt: '2026-10-13T10:00:00.000Z',
    ...overrides,
  };
}

const COMMITS: MrCommit[] = [
  commit(),
  commit({
    id: 'b2c3d4e5f6a7b2c3d4e5f6a7b2c3d4e5f6a7b2c3', shortId: 'b2c3d4e5',
    title: 'fix(pay): 密钥不再进日志',
    message: 'fix(pay): 密钥不再进日志\n\n评审要求：任何级别日志都不能打印 apiKey。',
  }),
];

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

describe('mrCommitsContext', () => {
  it('renders one entry per commit: short sha + title, message body underneath', () => {
    const block = mrCommitsContext(COMMITS);
    expect(block).toContain('## MR Commits（提交者写在 commit message 里的需求与实现说明）');
    expect(block).toContain('1. `a1b2c3d4` feat(pay): 支持支付失败重试');
    expect(block).toContain('   需求：支付网关超时后最多重试 3 次，指数退避。');
    expect(block).toContain('2. `b2c3d4e5` fix(pay): 密钥不再进日志');
    expect(block).toContain('不要对提交信息本身产出 finding');
  });

  it('does not repeat the title line inside the message body', () => {
    const block = mrCommitsContext(COMMITS);
    expect(block.split('feat(pay): 支持支付失败重试')).toHaveLength(2);
  });

  it('keeps every message line, including multi-paragraph bodies', () => {
    const block = mrCommitsContext([commit({ message: 'title\n\n第一段\n\n第二段' })]);
    expect(block).toContain('   第一段');
    expect(block).toContain('   第二段');
  });

  it('skips the whole block when there is nothing to show', () => {
    for (const empty of [undefined, null, [], [commit({ title: '', message: '   ' })]]) {
      expect(mrCommitsContext(empty as MrCommit[] | null | undefined)).toBe('');
    }
  });

  it('falls back to the message first line when a commit has no title', () => {
    const block = mrCommitsContext([commit({ title: '', message: '需求：只走内网网关\n细节：超时 3s' })]);
    expect(block).toContain('1. `a1b2c3d4` 需求：只走内网网关');
    expect(block).toContain('   细节：超时 3s');
  });

  it('trims surrounding whitespace so entries never start or end blank', () => {
    const block = mrCommitsContext([commit({ title: '  feat: x  ', message: '  feat: x  \n\n  正文  ' })]);
    expect(block).toContain('1. `a1b2c3d4` feat: x');
    expect(block).toContain('   正文');
    expect(block).not.toContain('\n\n\n');
  });

  it('caps the entry count at 100 and says how many were dropped', () => {
    const many = Array.from({ length: MR_COMMITS_MAX_ENTRIES + 30 }, (_, index) =>
      commit({ id: `id${index}`, shortId: `sha${index}`, title: `commit ${index}`, message: `commit ${index}` }));
    const block = mrCommitsContext(many);
    expect(block).toContain(`100. \`sha99\` commit 99`);
    expect(block).not.toContain('`sha100`');
    expect(block).toContain(`（其余 30 条提交按 ${MR_COMMITS_MAX_ENTRIES} 条上限省略）`);
  });

  it('truncates an over-long single message and leaves the other commits intact', () => {
    const long = `需求全文：${'x'.repeat(MR_COMMIT_MESSAGE_BUDGET_CHARACTERS + 800)}`;
    const block = mrCommitsContext([
      commit({ title: 'feat: long', message: `feat: long\n\n${long}` }),
      commit({ shortId: 'lastone1', title: 'feat: last', message: 'feat: last\n\n最后一条要在。' }),
    ]);
    expect(block).toContain(`已按 ${MR_COMMIT_MESSAGE_BUDGET_CHARACTERS} 字符预算截断`);
    expect(block).not.toContain('x'.repeat(MR_COMMIT_MESSAGE_BUDGET_CHARACTERS));
    expect(block).toContain('`lastone1` feat: last');
    expect(block).toContain('最后一条要在。');
  });

  it('shares the description budget and truncates the whole list with the same marker', () => {
    expect(MR_COMMITS_BUDGET_CHARACTERS).toBe(MR_DESCRIPTION_BUDGET_CHARACTERS);
    const many = Array.from({ length: 60 }, (_, index) =>
      commit({ shortId: `sha${index}`, title: `commit ${index}`, message: `commit ${index}\n\n${'y'.repeat(300)}` }));
    const block = mrCommitsContext(many);
    expect(block).toContain(`已按 ${MR_COMMITS_BUDGET_CHARACTERS} 字符预算截断`);
    expect(block.length).toBeLessThan(many.length * 320);
  });

  it('keeps a short commit list verbatim, without any truncation marker', () => {
    const block = mrCommitsContext(COMMITS);
    expect(block).not.toContain('截断');
    expect(block).not.toContain('省略');
    expect(block).toContain('重试次数走配置，不写死。');
  });

  it('honours a smaller budget passed by the caller', () => {
    const block = mrCommitsContext(COMMITS, 120);
    expect(block).toContain('已按 120 字符预算截断');
  });

  it('still numbers entries when a commit carries no sha at all', () => {
    expect(formatMrCommits([commit({ id: '', shortId: '', title: 'feat: no sha', message: 'feat: no sha' })]))
      .toBe('1. feat: no sha');
  });

  it('derives a short sha from the full id when GitLab omits short_id', () => {
    expect(normalizeMrCommit({ id: 'a1b2c3d4e5f6', message: 'feat: x' }).shortId).toBe('a1b2c3d4');
  });
});

describe('normalizeMrCommit', () => {
  it('maps the GitLab payload and never leaves a field undefined', () => {
    expect(normalizeMrCommit({
      id: 'a1b2c3d4e5f6a1b2', short_id: 'a1b2c3d4', title: 'feat: x',
      message: 'feat: x\n\n正文', author_name: 'mizuka', created_at: '2026-10-13T10:00:00.000Z',
    })).toEqual({
      id: 'a1b2c3d4e5f6a1b2', shortId: 'a1b2c3d4', title: 'feat: x',
      message: 'feat: x\n\n正文', authorName: 'mizuka', createdAt: '2026-10-13T10:00:00.000Z',
    });
  });

  it('falls back to empty strings and the message first line for a sparse payload', () => {
    expect(normalizeMrCommit({ message: 'feat: only message' })).toEqual({
      id: '', shortId: '', title: 'feat: only message', message: 'feat: only message',
      authorName: '', createdAt: '',
    });
    expect(normalizeMrCommit({})).toEqual({
      id: '', shortId: '', title: '', message: '', authorName: '', createdAt: '',
    });
  });
});

describe('GitLabAdapter.listMrCommits', () => {
  const ref = { origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7 };
  const page: PageContext = { origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 };
  const rawCommits = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => ({
      id: `id${offset + index}`, short_id: `sha${offset + index}`, title: `commit ${offset + index}`,
      message: `commit ${offset + index}\n\n正文`, author_name: 'mizuka', created_at: '2026-10-13T10:00:00.000Z',
    }));

  it('reads the MR commits endpoint of the current project', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(rawCommits(2)), { status: 200 }));
    const adapter = new GitLabAdapter(page, '', fetcher);

    const commits = await adapter.listMrCommits(ref);
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/v4/projects/group%2Fproject/merge_requests/7/commits?per_page=100&page=1');
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ shortId: 'sha0', title: 'commit 0', message: 'commit 0\n\n正文' });
  });

  it('stops paginating as soon as a page comes back short', async () => {
    const single = vi.fn(async () => new Response(JSON.stringify(rawCommits(7)), { status: 200 }));
    await new GitLabAdapter(page, '', single).listMrCommits(ref);
    expect(single).toHaveBeenCalledTimes(1);

    const paged = vi.fn(async (input: string) => {
      const current = Number(new URL(input).searchParams.get('page'));
      const body = current === 1 ? rawCommits(100) : rawCommits(40, 100);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const commits = await new GitLabAdapter(page, '', paged).listMrCommits(ref);
    expect(paged).toHaveBeenCalledTimes(2);
    expect(commits).toHaveLength(140);
    expect(commits[139].shortId).toBe('sha139');
  });

  it('never reads more than three pages even for an endless MR', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(rawCommits(100)), { status: 200 }));
    const commits = await new GitLabAdapter(page, '', fetcher).listMrCommits(ref);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(commits).toHaveLength(300);
  });

  it('surfaces a failing commits endpoint as a GitLabApiError for the caller to degrade', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: '404 Not Found' }), { status: 404 }));
    const error = await new GitLabAdapter(page, '', fetcher).listMrCommits(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect((error as GitLabApiError).status).toBe(404);
  });

  it('passes the abort signal through so a stopped review cancels the request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await new GitLabAdapter(page, '', fetcher).listMrCommits(ref, { signal: controller.signal });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('buildReviewContext with commits', () => {
  it('counts the commits block into the context size without touching the diff budget', () => {
    const block = mrCommitsContext(COMMITS);
    const withCommits = buildReviewContext({ files: currentFiles, commitsCharacters: block.length });
    const without = buildReviewContext({ files: currentFiles });

    expect(withCommits.commitsCharacters).toBe(block.length);
    expect(withCommits.estimatedCharacters).toBe(without.estimatedCharacters + block.length);
    expect(withCommits.files.filter((file) => file.included)).toHaveLength(without.files.length);
  });

  it('adds up with the description block instead of replacing it', () => {
    const context = buildReviewContext({
      files: currentFiles, descriptionCharacters: 120, commitsCharacters: 300,
    });
    expect(context.estimatedCharacters)
      .toBe(buildReviewContext({ files: currentFiles }).estimatedCharacters + 420);
  });

  it('reports zero characters when the MR has no readable commits', () => {
    expect(buildReviewContext({ files: currentFiles }).commitsCharacters).toBe(0);
    expect(buildReviewContext({ files: currentFiles, commitsCharacters: 0 }).estimatedCharacters)
      .toBe(buildReviewContext({ files: currentFiles }).estimatedCharacters);
  });
});

describe('ReviewEngine splices the MR commits into the model input', () => {
  it('passes the commits block to the single review call and records its size', async () => {
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, mrCommits: COMMITS });

    expect(runtime.review).toHaveBeenCalledTimes(1);
    const options = runtime.review.mock.calls[0][5] as { mrCommits?: string };
    expect(options.mrCommits).toContain('## MR Commits');
    expect(options.mrCommits).toContain('最多重试 3 次');
    expect(result.context.commitsCharacters).toBe(options.mrCommits!.length);
    expect(summarizeReviewContext(result.context).commitsCharacters).toBe(options.mrCommits!.length);
  });

  it('carries description and commits side by side', async () => {
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({
      files: currentFiles, mrDescription: '## 需求\n支付要重试', mrCommits: COMMITS,
    });

    const options = runtime.review.mock.calls[0][5] as { mrDescription?: string; mrCommits?: string };
    expect(options.mrDescription).toContain('## MR 说明');
    expect(options.mrCommits).toContain('## MR Commits');
    expect(result.context.descriptionCharacters).toBe(options.mrDescription!.length);
    expect(result.context.commitsCharacters).toBe(options.mrCommits!.length);
  });

  it('leaves the option unset for an MR without commits', async () => {
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, mrCommits: [] });

    expect((runtime.review.mock.calls[0][5] as { mrCommits?: string }).mrCommits).toBeUndefined();
    expect(result.context.commitsCharacters).toBe(0);
    expect(summarizeReviewContext(result.context).commitsCharacters).toBeUndefined();
  });

  it('repeats the commits block on every bundle of a split review', async () => {
    const manyFiles = Array.from({ length: 8 }, (_, index) =>
      diffFile(`src/file-${index}.ts`, `@@ -1 +1,2 @@\n-old\n+const value${index} = ${index};`));
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings);
    await engine.run({ files: manyFiles, mrCommits: COMMITS });

    expect(runtime.review.mock.calls.length).toBeGreaterThan(1);
    for (const call of runtime.review.mock.calls) {
      expect((call[5] as { mrCommits?: string }).mrCommits).toContain('## MR Commits');
    }
  });

  it('still counts the block when no model is configured', async () => {
    const runtime = { configured: false, review: vi.fn(), reflect: vi.fn() };
    const engine = new ReviewEngine(runtime, settings, [BUILT_IN_PACK]);
    const result = await engine.run({ files: currentFiles, mrCommits: COMMITS });

    expect(runtime.review).not.toHaveBeenCalled();
    expect(result.context.commitsCharacters).toBe(mrCommitsContext(COMMITS).length);
  });
});

describe('OpenAIRuntime review prompt', () => {
  function stubModel() {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it('puts the commits after the description and before the repo background', async () => {
    const fetcher = stubModel();

    await new OpenAIRuntime(runtimeSettings).review(
      currentFiles, undefined, 'zh-CN', undefined, '仓库符号上下文：src/current.ts 定义 pay()',
      { mrDescription: '## MR 说明（提交者写的需求背景，用来判断实现是否符合意图）\n支付要重试', mrCommits: mrCommitsContext(COMMITS), projectPrompt: '只看安全问题' },
    );

    const prompt = promptOf(fetcher);
    const diffAt = prompt.indexOf('src/current.ts');
    const descriptionAt = prompt.indexOf('## MR 说明');
    const commitsAt = prompt.indexOf('## MR Commits');
    const backgroundAt = prompt.indexOf('业务背景：');
    const projectAt = prompt.indexOf('## 项目补充要求');
    expect(descriptionAt).toBeGreaterThan(diffAt);
    expect(commitsAt).toBeGreaterThan(descriptionAt);
    expect(backgroundAt).toBeGreaterThan(commitsAt);
    expect(projectAt).toBeGreaterThan(backgroundAt);
    expect(prompt).toContain('最多重试 3 次');
  });

  it('renders no empty commits section when the MR has no commits', async () => {
    const fetcher = stubModel();

    await new OpenAIRuntime(runtimeSettings).review(currentFiles, undefined, 'zh-CN', undefined, undefined, {});

    const prompt = promptOf(fetcher);
    expect(prompt).not.toContain('## MR Commits');
    expect(prompt).not.toMatch(/\n\n\n/);
  });
});

describe('reference MR commits', () => {
  const companion: MrLinkRef = { origin: 'https://other.test', projectPath: 'platform/sdk', iid: 12 };

  function reference(overrides: Partial<ReferenceMr> = {}): ReferenceMr {
    return {
      ref: companion, status: 'ready', title: 'feat: companion token endpoint', headSha: 'abcdef1234567890',
      addedAt: '2026-10-13T10:00:00.000Z',
      files: [diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')],
      ...overrides,
    };
  }

  function mrContext(description: string): MergeRequestContext {
    return {
      origin: companion.origin, projectPath: companion.projectPath, mergeRequestIid: companion.iid,
      title: 'feat: companion', description, state: 'opened',
      sourceBranch: 'feat/x', targetBranch: 'main', sha: 'head',
      diffRefs: { baseSha: 'base', headSha: 'abcdef1234567890', startSha: 'start' },
    };
  }

  it('splices the reference commits into the read-only reference block', () => {
    const { text } = referenceContextBlock([reference({ commits: COMMITS })]);
    expect(text).toContain('#### [参考 platform/sdk!12] MR Commits（只读背景，不是评审对象）');
    expect(text).toContain('1. `a1b2c3d4` feat(pay): 支持支付失败重试');
    expect(text).toContain('不要对参考变更本身产出 finding');
    expect(text).toContain('src/companion.ts');
  });

  it('omits the section for a reference MR without commits', () => {
    expect(referenceContextBlock([reference()]).text).not.toContain('MR Commits');
    expect(referenceContextBlock([reference({ commits: [] })]).text).not.toContain('MR Commits');
  });

  it('truncates the reference commits to a quarter of that reference budget so diffs stay dominant', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      commit({ shortId: `sha${index}`, title: `commit ${index}`, message: `commit ${index}\n\n${'y'.repeat(200)}` }));
    const { text } = referenceContextBlock([reference({ commits: many })], 4_000);
    expect(text).toContain('已按 1000 字符预算截断');
    expect(text).toContain('src/companion.ts');
  });

  it('charges the commits to the reference budget instead of inflating it', () => {
    const files = Array.from({ length: 30 }, (_, index) =>
      diffFile(`src/file-${index}.ts`, '@@ -1 +1,10 @@\n+const v = 1;'.repeat(10)));
    const plain = referenceContextBlock([reference({ files })], 4_000);
    const withCommits = referenceContextBlock([reference({ files, commits: COMMITS })], 4_000);
    expect(withCommits.fileCount).toBeLessThan(plain.fileCount);
  });

  it('keeps description and commits, one pair of sections per reference MR', () => {
    const other: MrLinkRef = { origin: 'https://other.test', projectPath: 'platform/web', iid: 30 };
    const { text } = referenceContextBlock([
      reference({ description: '第一个参考说明', commits: [commit({ title: '第一个参考提交', message: '第一个参考提交' })] }),
      reference({ ref: other, description: '第二个参考说明', commits: [commit({ title: '第二个参考提交', message: '第二个参考提交' })] }),
    ]);
    expect(text).toContain('[参考 platform/sdk!12] MR 说明');
    expect(text).toContain('[参考 platform/sdk!12] MR Commits');
    expect(text).toContain('[参考 platform/web!30] MR Commits');
    expect(text).toContain('第一个参考提交');
    expect(text).toContain('第二个参考提交');
  });

  it('carries the commits loaded from the GitLab API', async () => {
    const loaded = await loadReferenceMr(companion, {
      getMergeRequest: vi.fn().mockResolvedValue(mrContext('配套改动说明')),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
      listMrCommits: vi.fn().mockResolvedValue(COMMITS),
    });
    expect(loaded.status).toBe('ready');
    expect(loaded.commits).toEqual(COMMITS);
    expect(loaded.description).toBe('配套改动说明');
  });

  it('leaves the commits unset when the reference MR has none', async () => {
    const loaded = await loadReferenceMr(companion, {
      getMergeRequest: vi.fn().mockResolvedValue(mrContext('')),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
      listMrCommits: vi.fn().mockResolvedValue([]),
    });
    expect(loaded.commits).toBeUndefined();
  });

  it('keeps the reference ready when only the commits endpoint fails', async () => {
    const loaded = await loadReferenceMr(companion, {
      getMergeRequest: vi.fn().mockResolvedValue(mrContext('配套改动说明')),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
      listMrCommits: vi.fn().mockRejectedValue(new GitLabApiError(403, 'GitLab API 403：forbidden')),
    });
    expect(loaded.status).toBe('ready');
    expect(loaded.files).toHaveLength(1);
    expect(loaded.commits).toBeUndefined();
    expect(loaded.error).toBeUndefined();
  });

  it('still works with an API object that has no commits method at all', async () => {
    const loaded = await loadReferenceMr(companion, {
      getMergeRequest: vi.fn().mockResolvedValue(mrContext('')),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
    });
    expect(loaded.status).toBe('ready');
    expect(loaded.commits).toBeUndefined();
  });

  it('still drops a model finding aimed at a reference path when the reference carries commits', async () => {
    const runtime = runtimeReturning([{
      path: 'src/companion.ts', line: 1, endLine: 1, side: 'new', category: 'security', severity: 'high',
      confidence: 'high', title: '参考仓库里的问题', content: '不该出现在结果里。',
      existingCode: 'export const a = 1;', evidence: [], comment: 'x',
    }]);
    const engine = new ReviewEngine(runtime, settings);
    const result = await engine.run({ files: currentFiles, references: [reference({ commits: COMMITS })] });

    expect(result.findings.some((finding) => finding.path === 'src/companion.ts')).toBe(false);
    expect(result.warnings.join('\n')).toContain('丢弃了 1 条落在参考 MR 上的 AI Finding');
  });
});

describe('delegation export', () => {
  it('includes the MR commits section', () => {
    const text = buildDelegationContext({
      files: currentFiles, packs: [BUILT_IN_PACK], commits: COMMITS,
      meta: { project: 'g/p', mergeRequestIid: 7, headSha: 'abc123' },
    });
    expect(text).toContain('## MR Commits');
    expect(text).toContain('feat(pay): 支持支付失败重试');
    expect(text).toContain('最多重试 3 次');
  });

  it('says the commits are absent instead of dropping the section', () => {
    const text = buildDelegationContext({ files: currentFiles, packs: [BUILT_IN_PACK] });
    expect(text).toContain('## MR Commits\n(无)');
  });
});

describe('MR commits in the app review flow', () => {
  const page: PageContext = {
    origin: 'https://gitlab.test', route: 'diff', projectPath: 'acme/app',
    projectNumericId: 42, mergeRequestIid: 248,
  };
  const HYBRID = {
    provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
    reviewMode: 'hybrid', gitlabToken: 'glpat-test', language: 'zh-CN', effort: 'balanced',
  };
  const currentDiff = {
    old_path: 'src/payment.ts', new_path: 'src/payment.ts',
    new_file: false, deleted_file: false, renamed_file: false,
    diff: '@@ -1,2 +1,4 @@ export function pay() {\n export function pay() {\n+  const apiKey = "sk-live-123";\n+  return charge(apiKey);\n }',
  };
  const modelFindings = JSON.stringify({
    findings: [{
      title: '硬编码 API Key 应移至安全配置', severity: 'high', category: 'security', confidence: 'high',
      path: 'src/payment.ts', line: 2, endLine: 2, side: 'new', existingCode: 'const apiKey = "sk-live-123";',
      content: '新增赋值涉及密码、Token 或 API Key，应从安全配置读取。',
      evidence: [{ path: 'src/payment.ts', lines: 'L2', quote: 'const apiKey = "sk-live-123";' }],
      comment: '发现硬编码 API Key，应从安全配置读取。',
    }],
  });
  const rawCommits = [
    { id: 'a1b2c3d4e5f6a1b2', short_id: 'a1b2c3d4', title: 'feat(pay): 支付失败重试 3 次', message: 'feat(pay): 支付失败重试 3 次\n\n需求：网关超时后指数退避重试，密钥不进日志。', author_name: 'mizuka', created_at: '2026-10-13T10:00:00.000Z' },
  ];

  interface Call { url: string; body: string }

  function stubNetwork(options: { commitsStatus?: number; commits?: unknown[] } = {}): Call[] {
    const commitsStatus = options.commitsStatus ?? 200;
    const calls: Call[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });

      if (url.startsWith('https://model.test')) {
        return json({
          id: 'c1', object: 'chat.completion', model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: modelFindings }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      if (url.includes('/merge_requests/248/commits')) {
        return commitsStatus === 200
          ? json(options.commits ?? rawCommits)
          : json({ message: '403 Forbidden' }, commitsStatus);
      }
      if (url.includes('/discussions')) return json([]);
      if (url.includes('/merge_requests/248/diffs')) return json([currentDiff]);
      if (url.includes('/merge_requests/248')) {
        return json({
          title: 'Harden checkout payment error handling', description: '', state: 'opened',
          source_branch: 'feature/payment', target_branch: 'main', sha: 'head-sha',
          diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha', start_sha: 'start-sha' },
        });
      }
      return json({ message: '404 Not Found' }, 404);
    }));
    return calls;
  }

  /** 只取评审那一次调用：反思模块也打同一个端点，但 system prompt 不同。 */
  function reviewPrompts(calls: Call[]): string[] {
    return calls
      .filter((call) => call.url.includes('/chat/completions'))
      .map((call) => decodeURIComponent(call.body))
      .filter((body) => body.includes('你是代码评审引擎'));
  }

  function mount() {
    localStorage.setItem('review-agent-settings-v1', JSON.stringify(HYBRID));
    localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
    return render(createElement(App, { page }));
  }

  async function runReview() {
    fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
    await waitFor(() => expect(screen.getByText(/个问题/)).toBeInTheDocument(), { timeout: 8000 });
  }

  afterEach(() => { cleanup(); localStorage.clear(); });

  it('fetches the commits next to the MR context and sends them to the model', async () => {
    const calls = stubNetwork({});
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    expect(calls.some((call) => call.url.includes('/merge_requests/248/commits?per_page=100&page=1'))).toBe(true);

    await runReview();

    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## MR Commits（提交者写在 commit message 里的需求与实现说明）');
    expect(prompts[0]).toContain('`a1b2c3d4` feat(pay): 支付失败重试 3 次');
    expect(prompts[0]).toContain('网关超时后指数退避重试，密钥不进日志');
    expect(prompts[0]).toContain('src/payment.ts');
    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
  });

  it('reviews normally when the commits endpoint fails, without an empty section', async () => {
    const calls = stubNetwork({ commitsStatus: 403 });
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());

    await runReview();

    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('MR Commits');
    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
    expect(screen.queryByText(/读取 MR 数据失败/)).not.toBeInTheDocument();
  });

  it('renders no commits section for an MR whose commit list is empty', async () => {
    const calls = stubNetwork({ commits: [] });
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());

    await runReview();

    expect(reviewPrompts(calls)[0]).not.toContain('MR Commits');
  });
});
