import { describe, expect, it, vi } from 'vitest';
import { GitLabAdapter, GitLabApiError, projectAdapter } from '../../src/core/gitlab-adapter';
import { normalizeFileDiff } from '../../src/core/diff';
import {
  describeReferenceFailure, isReferenceOnlyPath, isSameMr, loadReferenceMr, loadReferenceMrs, mrLinkKey,
  mrLinkLabel, mrWebUrl, parseMrLink, parseMrLinks, referenceContextBlock, referenceFilesOf,
  referenceOnlyPathKeys,
} from '../../src/core/reference-mrs';
import type { FileDiff, MergeRequestContext, MrLinkRef, ReferenceMr } from '../../src/core/types';

const ref = (projectPath: string, iid: number, origin = 'https://gitlab.test'): MrLinkRef => ({ origin, projectPath, iid });

const companion: MrLinkRef = { origin: 'https://other.test', projectPath: 'platform/sdk', iid: 12 };

function diffFile(path: string, diff: string): FileDiff {
  return normalizeFileDiff({ old_path: path, new_path: path, diff });
}

function readyReference(overrides: Partial<ReferenceMr> = {}): ReferenceMr {
  return {
    ref: companion, status: 'ready', files: [], addedAt: '2026-10-09T10:00:00.000Z',
    title: 'feat: companion api change', headSha: 'abcdef1234567890', ...overrides,
  };
}

describe('MR link parsing', () => {
  it('reads host, project path and iid out of every GitLab MR URL shape', () => {
    const shapes = [
      'https://gitlab.test/group/project/-/merge_requests/12',
      'https://gitlab.test/group/project/-/merge_requests/12/diffs',
      'https://gitlab.test/group/project/-/merge_requests/12/commits',
      'https://gitlab.test/group/project/-/merge_requests/12/',
      'https://gitlab.test/group/project/-/merge_requests/12?diff_id=99',
      'https://gitlab.test/group/project/-/merge_requests/12#note_5',
      'https://gitlab.test/group/project/merge_requests/12',
      'https://gitlab.test/group/sub/team/project/-/merge_requests/7',
      'http://127.0.0.1:8929/test/y-mxgraph/-/merge_requests/1/diffs',
      'https://gitlab.test/group/my-project/-/merge_requests/3',
      'https://gitlab.test/group%2Fproject/-/merge_requests/5',
    ];
    const parsed = shapes.map((shape) => parseMrLink(shape).ref);
    expect(parsed.every((item) => item !== undefined)).toBe(true);
    expect(parsed[0]).toEqual({ origin: 'https://gitlab.test', projectPath: 'group/project', iid: 12 });
    expect(parsed[6]).toEqual({ origin: 'https://gitlab.test', projectPath: 'group/project', iid: 12 });
    expect(parsed[7]).toEqual({ origin: 'https://gitlab.test', projectPath: 'group/sub/team/project', iid: 7 });
    expect(parsed[8]).toEqual({ origin: 'http://127.0.0.1:8929', projectPath: 'test/y-mxgraph', iid: 1 });
    expect(parsed[9]).toEqual({ origin: 'https://gitlab.test', projectPath: 'group/my-project', iid: 3 });
    expect(parsed[10]).toEqual({ origin: 'https://gitlab.test', projectPath: 'group/project', iid: 5 });
  });

  it('keeps a cross-instance reference separate from the current page origin', () => {
    expect(parseMrLink('https://other.test/platform/sdk/-/merge_requests/12').ref).toEqual(companion);
    expect(mrLinkKey(companion)).toBe('https://other.test|platform/sdk|12');
    expect(mrLinkLabel(companion)).toBe('platform/sdk!12');
    expect(mrWebUrl(companion)).toBe('https://other.test/platform/sdk/-/merge_requests/12');
    expect(isSameMr(companion, { ...companion })).toBe(true);
    expect(isSameMr(companion, ref('platform/sdk', 12, 'https://other.test'))).toBe(true);
    expect(isSameMr(companion, ref('platform/sdk', 13, 'https://other.test'))).toBe(false);
  });

  it('accepts GitLab references.full shorthand against the current origin', () => {
    expect(parseMrLink('group/project!12', 'https://gitlab.test').ref).toEqual(ref('group/project', 12));
    expect(parseMrLink('group/project!12').reason).toContain('不是完整链接');
  });

  it('tolerates the wrappers and trailing punctuation people paste', () => {
    expect(parseMrLink('<https://gitlab.test/g/p/-/merge_requests/4>').ref).toEqual(ref('g/p', 4));
    expect(parseMrLink('(https://gitlab.test/g/p/-/merge_requests/4)').ref).toEqual(ref('g/p', 4));
    expect(parseMrLink('https://gitlab.test/g/p/-/merge_requests/4。').ref).toEqual(ref('g/p', 4));
  });

  it('says why a link is unusable instead of dropping it silently', () => {
    expect(parseMrLink('https://gitlab.test/group/project/-/blob/main/README.md').reason).toContain('不是 Merge Request 链接');
    expect(parseMrLink('https://gitlab.test/group/project/-/issues/9').reason).toContain('不是 Merge Request 链接');
    expect(parseMrLink('https://gitlab.test/group/project').reason).toContain('读不到 GitLab 项目路径');
    expect(parseMrLink('https://gitlab.test/group/project/-/merge_requests/abc').reason).toContain('不是 Merge Request 链接');
    expect(parseMrLink('随便写的一段话').reason).toContain('不是可解析的链接');
    expect(parseMrLink('ftp://gitlab.test/g/p/-/merge_requests/1').reason).toContain('不是 http(s) 链接');
  });

  it('splits a pasted block on newlines, spaces and commas, keeping order and dropping repeats', () => {
    const text = [
      'https://gitlab.test/group/a/-/merge_requests/1',
      'https://other.test/platform/sdk/-/merge_requests/12 https://gitlab.test/group/b/-/merge_requests/2',
      'https://gitlab.test/group/a/-/merge_requests/1/diffs, https://gitlab.test/group/c/-/merge_requests/3',
      'not-a-link',
    ].join('\n');
    const result = parseMrLinks(text, 'https://gitlab.test');
    expect(result.refs.map(mrLinkLabel)).toEqual(['group/a!1', 'platform/sdk!12', 'group/b!2', 'group/c!3']);
    expect(result.invalid).toEqual([{ input: 'not-a-link', reason: expect.stringContaining('不是可解析的链接') }]);
  });

  it('reports every unusable token separately', () => {
    const result = parseMrLinks('https://gitlab.test/g/p\nhttps://gitlab.test/g/p/-/issues/2', 'https://gitlab.test');
    expect(result.refs).toHaveLength(0);
    expect(result.invalid.map((item) => item.input)).toEqual(['https://gitlab.test/g/p', 'https://gitlab.test/g/p/-/issues/2']);
  });
});

describe('reference path guard', () => {
  const currentFiles = [diffFile('src/current.ts', '@@ -1 +1 @@\n-a\n+b')];
  const references = [readyReference({
    files: [
      diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;'),
      diffFile('src/current.ts', '@@ -1 +1 @@\n-x\n+y'),
      diffFile('/dev/null', '@@ -1 +0,0 @@\n-gone'),
    ],
  })];

  it('only bans paths that belong to the reference MR alone', () => {
    const keys = referenceOnlyPathKeys(references, currentFiles);
    expect(isReferenceOnlyPath('src/companion.ts', keys)).toBe(true);
    expect(isReferenceOnlyPath('src/current.ts', keys)).toBe(false);
    expect(isReferenceOnlyPath('src/other.ts', keys)).toBe(false);
  });

  it('matches a/ b/ prefixed and differently cased paths', () => {
    const keys = referenceOnlyPathKeys([readyReference({ files: [diffFile('Src/Companion.ts', '@@ -1 +1 @@\n-a\n+b')] })], currentFiles);
    expect(isReferenceOnlyPath('b/Src/Companion.ts', keys)).toBe(true);
    expect(isReferenceOnlyPath('src/companion.ts', keys)).toBe(true);
  });

  it('bans nothing when no reference loaded, so a single-MR review is untouched', () => {
    const keys = referenceOnlyPathKeys([{ ...readyReference(), status: 'failed' }], currentFiles);
    expect(keys.size).toBe(0);
    expect(isReferenceOnlyPath('src/companion.ts', keys)).toBe(false);
  });

  it('collects reference files for the rule stage without touching their findings', () => {
    expect(referenceFilesOf(references)).toHaveLength(3);
    expect(referenceFilesOf([...references, { ...readyReference(), status: 'failed', files: [diffFile('x.ts', '')] }])).toHaveLength(3);
  });
});

describe('reference context block', () => {
  const reference = readyReference({
    files: [diffFile('src/companion.ts', '@@ -0,0 +1,2 @@\n+export const COMPANION_TOKEN = "tk";\n+export function ping() {}')],
  });

  it('labels the block as read-only context and names the source MR on every file', () => {
    const { text, characters, fileCount } = referenceContextBlock([reference]);
    expect(text).toContain('## 参考变更：其他 MR（只读上下文，不是评审对象）');
    expect(text).toContain('不要对参考变更本身产出 finding');
    expect(text).toContain('所有 finding 的 path 必须来自当前 MR 的变更文件');
    expect(text).toContain('### 参考 MR 1：platform/sdk!12 — feat: companion api change');
    expect(text).toContain('https://other.test/platform/sdk/-/merge_requests/12');
    expect(text).toContain('head abcdef12');
    expect(text).toContain('#### [参考 platform/sdk!12] src/companion.ts');
    expect(text).toContain('COMPANION_TOKEN');
    expect(characters).toBe(text.length);
    expect(fileCount).toBe(1);
  });

  it('stays empty when nothing is usable', () => {
    expect(referenceContextBlock([])).toEqual({ text: '', characters: 0, fileCount: 0 });
    expect(referenceContextBlock([{ ...reference, status: 'failed' }]).text).toBe('');
    expect(referenceContextBlock([{ ...reference, files: [] }]).text).toBe('');
  });

  it('numbers multiple references and keeps them all in one block', () => {
    const second = readyReference({
      ref: ref('group/other', 3), title: 'chore: bump contract',
      files: [diffFile('contract.yaml', '@@ -1 +1 @@\n-a\n+b')],
    });
    const { text, fileCount } = referenceContextBlock([reference, second]);
    expect(text).toContain('### 参考 MR 1：platform/sdk!12');
    expect(text).toContain('### 参考 MR 2：group/other!3 — chore: bump contract');
    expect(text).toContain('#### [参考 group/other!3] contract.yaml');
    expect(fileCount).toBe(2);
  });

  it('respects the character budget and says how much it dropped', () => {
    const files = Array.from({ length: 40 }, (_, index) => diffFile(
      `src/file-${index}.ts`,
      `@@ -1 +1,20 @@\n${Array.from({ length: 20 }, (_, line) => `+const value${index}_${line} = "${'x'.repeat(40)}";`).join('\n')}`,
    ));
    const { text, fileCount } = referenceContextBlock([readyReference({ files })], 4_000);
    expect(fileCount).toBeLessThan(files.length);
    expect(fileCount).toBeGreaterThan(0);
    expect(text).toContain(`其余 ${files.length - fileCount} 个参考文件按预算省略`);
  });
});

describe('loading reference MRs', () => {
  const mergeRequest = (title: string): MergeRequestContext => ({
    origin: companion.origin, projectPath: companion.projectPath, mergeRequestIid: companion.iid,
    title, state: 'opened', sourceBranch: 'feat/x', targetBranch: 'main', sha: 'head',
    diffRefs: { baseSha: 'base', headSha: 'abcdef1234567890', startSha: 'start' },
  });

  it('pulls title, head sha and diffs through the API', async () => {
    const api = {
      getMergeRequest: vi.fn().mockResolvedValue(mergeRequest('feat: companion api change')),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
    };
    const loaded = await loadReferenceMr(companion, api);
    expect(api.getMergeRequest).toHaveBeenCalledWith({ origin: 'https://other.test', projectPath: 'platform/sdk', mergeRequestIid: 12 });
    expect(loaded).toMatchObject({ ref: companion, status: 'ready', title: 'feat: companion api change', headSha: 'abcdef1234567890' });
    expect(loaded.files.map((file) => file.newPath)).toEqual(['src/companion.ts']);
    expect(loaded.error).toBeUndefined();
  });

  it('reports a readable reason per failure mode', async () => {
    const cases: [unknown, string][] = [
      [new GitLabApiError(404, 'GitLab API 404：404 Not Found'), '找不到 platform/sdk!12（HTTP 404）'],
      [new GitLabApiError(401, 'GitLab API 401：unauthorized'), 'GitLab 拒绝了请求（HTTP 401）'],
      [new GitLabApiError(403, 'GitLab API 403：forbidden'), 'GitLab 拒绝了请求（HTTP 403）'],
      [new GitLabApiError(0, '无法连接 GitLab API：network error', 'network_error'), '连不上 https://other.test'],
      [new Error('boom'), 'boom'],
    ];
    for (const [error, expected] of cases) {
      const loaded = await loadReferenceMr(companion, {
        getMergeRequest: vi.fn().mockRejectedValue(error),
        listDiffs: vi.fn().mockResolvedValue([]),
      });
      expect(loaded.status).toBe('failed');
      expect(loaded.files).toEqual([]);
      expect(loaded.error).toContain(expected);
    }
  });

  it('flags an MR that returned no changed files instead of pretending it worked', async () => {
    const loaded = await loadReferenceMr(companion, {
      getMergeRequest: vi.fn().mockResolvedValue(mergeRequest('empty')),
      listDiffs: vi.fn().mockResolvedValue([]),
    });
    expect(loaded.status).toBe('ready');
    expect(loaded.error).toContain('没有读到任何变更文件');
  });

  it('rethrows a user cancellation so the caller can stop', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new Error('aborted');
    error.name = 'AbortError';
    await expect(loadReferenceMr(companion, {
      getMergeRequest: vi.fn().mockRejectedValue(error),
      listDiffs: vi.fn().mockResolvedValue([]),
    }, controller.signal)).rejects.toThrow('aborted');
  });

  it('loads several references and keeps one failure from killing the rest', async () => {
    const second = ref('group/other', 3);
    const loaded = await loadReferenceMrs([companion, second], (target) => ({
      getMergeRequest: vi.fn().mockImplementation(async () => {
        if (target.projectPath === 'group/other') throw new GitLabApiError(404, 'not found');
        return mergeRequest('ok');
      }),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/a.ts', '@@ -1 +1 @@\n-a\n+b')]),
    }));
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ status: 'ready' });
    expect(loaded[1]).toMatchObject({ status: 'failed' });
    expect(loaded[1].error).toContain('找不到 group/other!3');
  });

  it('describes failures with the MR label and status', () => {
    expect(describeReferenceFailure(companion, new GitLabApiError(429, 'rate limited'))).toContain('rate limited');
  });
});

describe('recent MR candidates', () => {
  const raw = (project: string, iid: number, title: string) => ({
    iid, title, state: 'opened', source_branch: 'feat/x', target_branch: 'main',
    updated_at: '2026-10-09T09:00:00.000Z',
    web_url: `https://gitlab.test/${project}/-/merge_requests/${iid}`,
  });

  it('reads the instance-wide updated_desc list into MR refs', async () => {
    const fetcher = vi.fn(async (input: string) => new Response(
      JSON.stringify([raw('group/a', 1, '第一个'), raw('platform/sdk', 12, '第二个')]),
      { status: 200 },
    ));
    const adapter = new GitLabAdapter({ origin: 'https://gitlab.test', projectPath: 'group/a', route: 'diff' }, 'token', fetcher);
    const recent = await adapter.listRecentMergeRequests();
    expect(fetcher).toHaveBeenCalledWith(
      'https://gitlab.test/api/v4/merge_requests?scope=all&state=opened&order_by=updated_at&sort=desc&per_page=20',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(recent).toEqual([
      {
        ref: ref('group/a', 1), title: '第一个', state: 'opened', sourceBranch: 'feat/x',
        targetBranch: 'main', updatedAt: '2026-10-09T09:00:00.000Z',
        webUrl: 'https://gitlab.test/group/a/-/merge_requests/1',
      },
      expect.objectContaining({ ref: ref('platform/sdk', 12), title: '第二个' }),
    ]);
  });

  it('clamps the page size to what GitLab accepts and can ask for merged/closed too', async () => {
    const fetcher = vi.fn(async () => new Response('[]', { status: 200 }));
    const adapter = new GitLabAdapter({ origin: 'https://gitlab.test', projectPath: 'g/p', route: 'diff' }, '', fetcher);
    await adapter.listRecentMergeRequests({ limit: 100, state: 'all' });
    expect(String(fetcher.mock.calls[0][0])).toContain('state=all');
    expect(String(fetcher.mock.calls[0][0])).toContain('per_page=20');
  });

  it('skips entries whose web_url is not an MR link', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([
      { ...raw('group/a', 1, '可用') }, { iid: 2, web_url: 'https://gitlab.test/dashboard/activity' }, { iid: 3 },
    ]), { status: 200 }));
    const adapter = new GitLabAdapter({ origin: 'https://gitlab.test', projectPath: 'g/p', route: 'diff' }, '', fetcher);
    expect(await adapter.listRecentMergeRequests()).toHaveLength(1);
  });

  it('builds an adapter for another project on another instance', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ title: 'x', diff_refs: { head_sha: 'h' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const adapter = projectAdapter('https://other.test', 'platform/sdk', 'token');
    await adapter.getMergeRequest({ origin: 'https://other.test', projectPath: 'platform/sdk', mergeRequestIid: 12 });
    expect(fetch).toHaveBeenCalledWith(
      'https://other.test/api/v4/projects/platform%2Fsdk/merge_requests/12',
      expect.objectContaining({ headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'token' }) }),
    );
    vi.unstubAllGlobals();
  });
});
