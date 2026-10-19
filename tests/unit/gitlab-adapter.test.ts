import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCommitPayload, buildDiscussionPayload, GitLabAdapter, GitLabApiError, positionRejectionReason } from '../../src/core/gitlab-adapter';
import { resolvePublishPosition } from '../../src/core/anchor';
import { debugBus } from '../../src/core/debug-bus';
import { toDiscussionPosition } from '../../src/core/reanchor';
import type { DiscussionPosition, Finding, MergeRequestRef, PageContext } from '../../src/core/types';

describe('GitLab discussion payload', () => {
  it('builds a new-side text position with all diff refs', () => {
    const payload = buildDiscussionPayload({
      body: 'review comment',
      position: {
        path: 'src/a.ts',
        startLine: 2,
        endLine: 3,
        side: 'new',
        diffRefs: { baseSha: 'base', headSha: 'head', startSha: 'start' },
      },
    });
    expect(Object.fromEntries(payload)).toMatchObject({
      body: 'review comment',
      'position[position_type]': 'text',
      'position[base_sha]': 'base',
      'position[head_sha]': 'head',
      'position[start_sha]': 'start',
      'position[new_path]': 'src/a.ts',
      'position[old_path]': 'src/a.ts',
      'position[new_line]': '3',
    });
    expect(payload.has('position[old_line]')).toBe(false);
  });

  it('uses old_line for deleted code', () => {
    const payload = buildDiscussionPayload({
      body: 'comment',
      position: { path: 'a.ts', startLine: 4, endLine: 4, side: 'old', diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' } },
    });
    expect(payload.get('position[old_line]')).toBe('4');
  });

  it('keeps the real path on both sides for a new file and supports line ranges', () => {
    const payload = buildDiscussionPayload({
      body: 'comment',
      position: {
        path: 'src/new.ts', oldPath: '/dev/null', newPath: 'src/new.ts',
        startLine: 1, endLine: 3, side: 'new',
        start: { newLine: 1 }, end: { newLine: 3 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    // GitLab 把 old_path/new_path 当 diff 路径过滤条件传给 Gitaly，/dev/null 会 500。
    expect(payload.get('position[old_path]')).toBe('src/new.ts');
    expect(payload.get('position[new_path]')).toBe('src/new.ts');
    expect(payload.get('position[line_range][start][new_line]')).toBe('1');
    expect(payload.get('position[line_range][end][new_line]')).toBe('3');
  });

  it('sends both old_line and new_line for a context line', () => {
    const payload = buildDiscussionPayload({
      body: 'comment',
      position: {
        path: 'a.ts', startLine: 15, endLine: 15, side: 'new',
        start: { oldLine: 15, newLine: 15 }, end: { oldLine: 15, newLine: 15 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    expect(payload.get('position[old_line]')).toBe('15');
    expect(payload.get('position[new_line]')).toBe('15');
    expect([...payload.keys()].some((key) => key.startsWith('position[line_range]'))).toBe(false);
  });

  it('sends only the side that really exists on a removed line', () => {
    const payload = buildDiscussionPayload({
      body: 'comment',
      position: {
        path: 'a.ts', startLine: 33, endLine: 33, side: 'old',
        start: { oldLine: 33 }, end: { oldLine: 33 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    expect(payload.get('position[old_line]')).toBe('33');
    expect(payload.has('position[new_line]')).toBe(false);
  });

  it('describes the end line at top level and pairs every line_range endpoint separately', () => {
    const payload = buildDiscussionPayload({
      body: 'comment',
      position: {
        // start 是 context 行（两侧都有行号），end 是 added 行（只有 new 侧）
        path: 'a.ts', startLine: 15, endLine: 16, side: 'new',
        start: { oldLine: 15, newLine: 15 }, end: { newLine: 16 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    expect(payload.get('position[new_line]')).toBe('16');
    expect(payload.has('position[old_line]')).toBe(false);
    expect(payload.get('position[line_range][start][old_line]')).toBe('15');
    expect(payload.get('position[line_range][start][new_line]')).toBe('15');
    expect(payload.get('position[line_range][end][new_line]')).toBe('16');
    expect(payload.has('position[line_range][end][old_line]')).toBe(false);
  });

  it('only emits line_range keys the GitLab json schema allows', () => {
    const payload = buildDiscussionPayload({
      body: 'comment',
      position: {
        path: 'a.ts', startLine: 29, endLine: 36, side: 'new',
        start: { newLine: 29 }, end: { newLine: 36 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    // line_range 被 GitLab 原样存下并按 additionalProperties: false 校验，多一个键就整条 400。
    const allowed = new Set(['start', 'end'].flatMap((endpoint) =>
      ['old_line', 'new_line'].map((field) => `position[line_range][${endpoint}][${field}]`)));
    const emitted = [...payload.keys()].filter((key) => key.startsWith('position[line_range]'));
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it('drops blank position fields instead of sending empty values', () => {
    const payload = buildDiscussionPayload({
      body: 'comment',
      position: {
        path: 'a.ts', startLine: 2, endLine: 2, side: 'new',
        diffRefs: { baseSha: '', headSha: 'h', startSha: '' },
      },
    });
    expect(payload.has('position[base_sha]')).toBe(false);
    expect(payload.has('position[start_sha]')).toBe(false);
    expect(payload.get('position[head_sha]')).toBe('h');
  });

  it('omits every position field for a full-text comment', () => {
    const payload = buildDiscussionPayload({ body: 'MR 级评论' });
    expect(Object.fromEntries(payload)).toEqual({ body: 'MR 级评论' });
    expect([...payload.keys()].some((key) => key.startsWith('position'))).toBe(false);
  });
});

describe('GitLabAdapter', () => {
  const ref: MergeRequestRef = { origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7 };
  const mergeRequest = { diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' } };
  const position: DiscussionPosition = {
    path: 'a.ts', startLine: 1, endLine: 1, side: 'new',
    diffRefs: { baseSha: 'base', headSha: 'head', startSha: 'start' },
  };

  it('paginates diffs and discussions', async () => {
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input);
      const page = Number(url.searchParams.get('page') ?? 1);
      const items = url.pathname.endsWith('/diffs')
        ? Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({ old_path: `a${page}-${index}`, new_path: `a${page}-${index}`, diff: '@@ -1 +1 @@\n-x\n+y' }))
        : page === 1 ? [{ id: 'd1', notes: [{ id: 1, body: 'x' }] }] : [];
      return new Response(JSON.stringify(items), { status: 200 });
    });
    const adapter = new GitLabAdapter({ origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 }, '', fetcher);
    expect(await adapter.listDiffs(ref)).toHaveLength(101);
    expect(await adapter.listDiscussions(ref)).toHaveLength(1);
  });

  it('reads repository files as raw text with encoded path and ref', async () => {
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.pathname).toContain('/repository/files/src%2Fa%20b.ts/raw');
      expect(url.searchParams.get('ref')).toBe('head sha');
      return new Response('const value = 1;\n', { status: 200 });
    });
    const adapter = new GitLabAdapter({ origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 }, '', fetcher);
    await expect(adapter.getFile('src/a b.ts', 'head sha')).resolves.toBe('const value = 1;\n');
  });

  it('reads the MR description so review can use it as requirement background', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      title: 'feat: pay',
      description: '## 需求\n支付失败要给出可操作提示',
      state: 'opened', source_branch: 'feat/pay', target_branch: 'main', sha: 'head',
      diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' },
    }), { status: 200 }));
    const adapter = new GitLabAdapter({ origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 }, '', fetcher);

    const context = await adapter.getMergeRequest(ref);
    expect(fetcher.mock.calls[0][0]).toContain('/api/v4/projects/group%2Fproject/merge_requests/7');
    expect(context.description).toBe('## 需求\n支付失败要给出可操作提示');
    expect(context.title).toBe('feat: pay');
  });

  it('maps a null or missing description to an empty string', async () => {
    for (const payload of [
      { title: 'no description', description: null, diff_refs: null },
      { title: 'no description field', diff_refs: null },
    ]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
      const adapter = new GitLabAdapter({ origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 }, '', fetcher);
      expect((await adapter.getMergeRequest(ref)).description).toBe('');
    }
  });

  it('rejects stale diff refs and deduplicates identical comments', async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/merge_requests/7') && !url.pathname.endsWith('/discussions')) {
        return new Response(JSON.stringify(mergeRequest), { status: 200 });
      }
      if (url.pathname.endsWith('/discussions') && init?.method === 'POST') throw new Error('should not post');
      return new Response(JSON.stringify([{ id: 'existing', notes: [{ id: 2, body: 'same' }] }]), { status: 200 });
    });
    const adapter = new GitLabAdapter({ origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 }, '', fetcher);
    const draft = { body: 'same', position };
    expect(await adapter.createDiscussion(ref, draft)).toMatchObject({ id: 'existing', deduplicated: true });

    await expect(adapter.createDiscussion(ref, {
      body: 'different',
      position: { ...position, diffRefs: { baseSha: 'base', headSha: 'old', startSha: 'start' } },
    })).rejects.toBeInstanceOf(GitLabApiError);
  });
});

describe('publishComment inline → full-text fallback', () => {
  const page: PageContext = { origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 };
  const ref: MergeRequestRef = { origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7 };
  const position: DiscussionPosition = {
    path: 'src/a.ts', startLine: 12, endLine: 12, side: 'new',
    diffRefs: { baseSha: 'base', headSha: 'head', startSha: 'start' },
  };
  const finding: Finding = {
    id: 'f1', fingerprint: 'fp', path: 'src/a.ts', line: 12, endLine: 12, side: 'new',
    category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
    evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment', source: 'model', status: 'draft',
  };

  function publisher(postStatuses: number[]) {
    const posts: string[] = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (init?.method === 'POST') {
        posts.push(String(init.body));
        const status = postStatuses[Math.min(posts.length - 1, postStatuses.length - 1)];
        return status === 200
          ? new Response(JSON.stringify({ id: `d${posts.length}`, notes: [{ id: posts.length }] }), { status })
          : new Response('{"message":"position is invalid"}', { status });
      }
      if (url.pathname.endsWith('/merge_requests/7')) {
        return new Response(JSON.stringify({ diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' } }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    return { adapter: new GitLabAdapter(page, '', fetcher), posts };
  }

  const bodyOf = (post: string) => new URLSearchParams(post).get('body') ?? '';

  it('creates an inline discussion when the position is accepted', async () => {
    const { adapter, posts } = publisher([200]);
    expect(await adapter.publishComment(ref, finding, 'Comment', position)).toMatchObject({ id: 'd1', mode: 'inline' });
    expect(posts).toHaveLength(1);
    expect(new URLSearchParams(posts[0]).get('position[new_line]')).toBe('12');
    expect(bodyOf(posts[0])).toBe('Comment');
  });

  it('publishes a full-text comment when there is no usable line', async () => {
    const { adapter, posts } = publisher([200]);
    expect(await adapter.publishComment(ref, finding, 'Comment')).toMatchObject({ id: 'd1', mode: 'full' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toContain('position');
    expect(bodyOf(posts[0])).toContain('src/a.ts:12');
    expect(bodyOf(posts[0])).toContain('Comment');
  });

  it('retries as a full-text comment when GitLab rejects the position', async () => {
    for (const status of [400, 422]) {
      const { adapter, posts } = publisher([status, 200]);
      expect(await adapter.publishComment(ref, finding, 'Comment', position)).toMatchObject({ id: 'd2', mode: 'full' });
      expect(posts).toHaveLength(2);
      expect(new URLSearchParams(posts[0]).get('position[new_line]')).toBe('12');
      expect(posts[1]).not.toContain('position');
      expect(bodyOf(posts[1])).toContain('全文评论');
    }
  });

  it('falls back to a full-text comment when the diff refs went stale', async () => {
    const { adapter, posts } = publisher([200]);
    const stale = { ...position, diffRefs: { baseSha: 'base', headSha: 'old', startSha: 'start' } };
    expect(await adapter.publishComment(ref, finding, 'Comment', stale)).toMatchObject({ mode: 'full' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toContain('position');
  });

  it('does not retry when GitLab rejects the request itself', async () => {
    const { adapter, posts } = publisher([403]);
    await expect(adapter.publishComment(ref, finding, 'Comment', position)).rejects.toMatchObject({ status: 403 });
    expect(posts).toHaveLength(1);
  });

  it('降级不静默：把 GitLab 的拒绝原因带回给调用方并计数', async () => {
    debugBus.clear();
    const { adapter } = publisher([400, 200]);

    const published = await adapter.publishComment(ref, finding, 'Comment', position);

    expect(published.mode).toBe('full');
    expect(published.downgrade?.status).toBe(400);
    expect(published.downgrade?.reason).toContain('GitLab 拒绝了这个行内位置');
    expect(published.downgrade?.reason).toContain('position is invalid');
    expect(debugBus.getCounters()).toMatchObject({ 'publish-inline-rejected:400': 1 });
    debugBus.clear();
  });

  it('行内成功时不带降级原因，一开始就没有位置的全文发布也不算降级', async () => {
    const inline = await publisher([200]).adapter.publishComment(ref, finding, 'Comment', position);
    expect(inline.downgrade).toBeUndefined();

    const full = await publisher([200]).adapter.publishComment(ref, finding, 'Comment');
    expect(full.mode).toBe('full');
    expect(full.downgrade).toBeUndefined();
  });

  it('把 GitLab 的状态码翻成人话，原文截短附在后面', () => {
    expect(positionRejectionReason(new GitLabApiError(409, 'MR 已更新，当前 Finding 的 diff_refs 已过期', 'stale_diff_refs')))
      .toContain('MR 已更新');
    expect(positionRejectionReason(new GitLabApiError(422, 'line out of diff')))
      .toBe('行号不在当前 Diff 范围内（line out of diff）');
    expect(positionRejectionReason(new GitLabApiError(400, "Note {:line_code=>[\"can't be blank\"]}")))
      .toContain('GitLab 拒绝了这个行内位置');
    expect(positionRejectionReason(new GitLabApiError(400, 'x'.repeat(400))).length).toBeLessThan(160);
  });

  it('剥掉 GitLab API 前缀与 JSON 外壳，只留服务端那句原话', () => {
    const reason = positionRejectionReason(new GitLabApiError(
      400,
      'GitLab API 400：{"message":"400 Bad request - Note {:line_code=>[\\"can\'t be blank\\"]}"}',
    ));

    expect(reason).toBe('GitLab 拒绝了这个行内位置（400 Bad request - Note {:line_code=>["can\'t be blank"]}）');
  });
});

describe('行内位置 409 → 重拉 diff_refs 重锚后重发', () => {
  const page: PageContext = { origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 };
  const ref: MergeRequestRef = { origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7 };
  const finding: Finding = {
    id: 'f1', fingerprint: 'fp', path: 'src/a.ts', line: 12, endLine: 12, side: 'new',
    category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
    evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment', source: 'model', status: 'draft',
  };
  const position = (headSha: string, startLine = 12): DiscussionPosition => ({
    path: 'src/a.ts', startLine, endLine: startLine, side: 'new',
    diffRefs: { baseSha: 'base', headSha, startSha: 'start' },
  });
  const field = (post: string, key: string) => new URLSearchParams(post).get(`position[${key}]`);

  /**
   * 服务端 head 已经是 head-2：带旧 head_sha 的 position 在发布前预检就被判 409（不会真的发出去），
   * conflicts 则模拟「refs 当时对得上、GitLab 仍然 409」，两种 409 源头都要能触发重锚。
   */
  function conflictPublisher(options: { head?: string; conflicts?: number } = {}) {
    const posts: string[] = [];
    const head = options.head ?? 'head-2';
    let conflicts = options.conflicts ?? 0;
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (init?.method === 'POST') {
        const body = String(init.body);
        posts.push(body);
        const sentHead = new URLSearchParams(body).get('position[head_sha]');
        const rejected = sentHead !== null && (conflicts > 0 || sentHead !== head);
        if (rejected && conflicts > 0) conflicts -= 1;
        return rejected
          ? new Response('{"message":"position is invalid"}', { status: 409 })
          : new Response(JSON.stringify({ id: `d${posts.length}`, notes: [{ id: posts.length }] }), { status: 200 });
      }
      if (url.pathname.endsWith('/merge_requests/7')) {
        return new Response(JSON.stringify({ diff_refs: { base_sha: 'base', head_sha: head, start_sha: 'start' } }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    return { adapter: new GitLabAdapter(page, '', fetcher), posts };
  }

  beforeEach(() => debugBus.clear('all'));
  afterEach(() => debugBus.clear('all'));

  it('服务端 409 后按新 diff_refs 重锚重发，行内评论保住、不降级', async () => {
    const { adapter, posts } = conflictPublisher({ conflicts: 1 });
    const reanchor = vi.fn(async () => ({ position: position('head-2', 13) }));

    const published = await adapter.publishComment(ref, finding, 'Comment', position('head-2'), reanchor);

    expect(published).toMatchObject({ mode: 'inline', reanchored: true });
    expect(published.downgrade).toBeUndefined();
    expect(reanchor).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(2);
    expect(field(posts[0], 'new_line')).toBe('12');
    expect(field(posts[1], 'new_line')).toBe('13');
    expect(debugBus.getCounters()['publish-inline-reanchored']).toBe(1);
    expect(debugBus.getCounters()['publish-inline-reanchor-failed']).toBeUndefined();
  });

  it('发布前预检出的 stale diff_refs 也走重锚：过期那一次根本没发出去', async () => {
    const { adapter, posts } = conflictPublisher();
    const reanchor = vi.fn(async () => ({ position: position('head-2') }));

    const published = await adapter.publishComment(ref, finding, 'Comment', position('head-1'), reanchor);

    expect(published).toMatchObject({ mode: 'inline', reanchored: true });
    expect(posts).toHaveLength(1);
    expect(field(posts[0], 'head_sha')).toBe('head-2');
  });

  it('重锚钩子拿到的是那份过期 position 与 409 本身', async () => {
    const { adapter } = conflictPublisher();
    const reanchor = vi.fn(async () => ({ position: position('head-2') }));

    await adapter.publishComment(ref, finding, 'Comment', position('head-1'), reanchor);

    const [sent, error] = reanchor.mock.calls[0];
    expect(sent.diffRefs.headSha).toBe('head-1');
    expect(error.status).toBe(409);
  });

  it('重锚后重发仍 409：才降级全文，原因写清「MR 已更新，已尝试重锚」并带回两次 position', async () => {
    const { adapter, posts } = conflictPublisher({ conflicts: 9 });
    const reanchor = vi.fn(async () => ({ position: position('head-2', 13) }));

    const published = await adapter.publishComment(ref, finding, 'Comment', position('head-2'), reanchor);

    expect(published.mode).toBe('full');
    expect(published.reanchored).toBeUndefined();
    expect(published.downgrade).toMatchObject({ status: 409, reanchored: true });
    expect(published.downgrade?.reason).toContain('MR 已更新，已尝试重锚：重发仍被 GitLab 拒绝');
    expect(published.downgrade?.reanchorReason).toContain('重发仍被 GitLab 拒绝');
    expect(published.downgrade?.reanchorPosition?.startLine).toBe(13);
    expect(posts).toHaveLength(3);
    expect(field(posts[0], 'new_line')).toBe('12');
    expect(field(posts[1], 'new_line')).toBe('13');
    expect(posts[2]).not.toContain('position');
    expect(debugBus.getCounters()).toMatchObject({
      'publish-inline-rejected:409': 1,
      'publish-inline-reanchor-failed': 1,
    });
    expect(debugBus.getCounters()['publish-inline-reanchored']).toBeUndefined();
  });

  it('重锚出不来位置（行已被 push 改掉）：降级全文，原因带上 anchor 给的理由', async () => {
    const { adapter, posts } = conflictPublisher({ conflicts: 1 });
    const reanchor = vi.fn(async () => ({ reason: '新的 Diff 中找不到这一行' }));

    const published = await adapter.publishComment(ref, finding, 'Comment', position('head-2'), reanchor);

    expect(published.mode).toBe('full');
    expect(published.downgrade?.reason).toBe('MR 已更新，已尝试重锚：新的 Diff 中找不到这一行');
    expect(published.downgrade?.reanchored).toBe(true);
    expect(published.downgrade?.reanchorPosition).toBeUndefined();
    expect(posts).toHaveLength(2);
    expect(posts[1]).not.toContain('position');
  });

  it('400 / 422 不是 diff_refs 过期，不触发重锚', async () => {
    for (const status of [400, 422]) {
      const posts: string[] = [];
      const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (init?.method === 'POST') {
          posts.push(String(init.body));
          return new URLSearchParams(String(init.body)).get('position[head_sha]')
            ? new Response('{"message":"nope"}', { status })
            : new Response(JSON.stringify({ id: 'd1', notes: [{ id: 1 }] }), { status: 200 });
        }
        if (url.pathname.endsWith('/merge_requests/7')) {
          return new Response(JSON.stringify({ diff_refs: { base_sha: 'base', head_sha: 'head-1', start_sha: 'start' } }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      });
      const adapter = new GitLabAdapter(page, '', fetcher);
      const reanchor = vi.fn(async () => ({ position: position('head-1') }));

      const published = await adapter.publishComment(ref, finding, 'Comment', position('head-1'), reanchor);

      expect(published.mode).toBe('full');
      expect(reanchor).not.toHaveBeenCalled();
      expect(published.downgrade?.reanchored).toBeUndefined();
      expect(published.downgrade?.reason).not.toContain('重锚');
      expect(posts).toHaveLength(2);
    }
  });

  it('重锚上限一次：服务端一直 409 也只重锚一次、只重发一次', async () => {
    const { adapter, posts } = conflictPublisher({ conflicts: 99 });
    let calls = 0;
    const reanchor = vi.fn(async () => ({ position: position('head-2', 13 + (calls += 1)) }));

    const published = await adapter.publishComment(ref, finding, 'Comment', position('head-2'), reanchor);

    expect(reanchor).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    expect(published.mode).toBe('full');
    // 行内两次（原位置 + 重锚后各一次）+ 全文一次，到此为止不再循环
    expect(posts).toHaveLength(3);
    expect(field(posts[1], 'new_line')).toBe('14');
    expect(posts[2]).not.toContain('position');
  });

  it('没给重锚钩子时行为不变：409 直接降级全文', async () => {
    const { adapter, posts } = conflictPublisher({ conflicts: 1 });

    const published = await adapter.publishComment(ref, finding, 'Comment', position('head-2'));

    expect(published.mode).toBe('full');
    expect(published.downgrade?.reason).not.toContain('重锚');
    expect(published.downgrade?.reanchored).toBeUndefined();
    expect(posts).toHaveLength(2);
    expect(debugBus.getCounters()['publish-inline-reanchored']).toBeUndefined();
  });

  it('行内一次就成功时不碰重锚钩子', async () => {
    const { adapter } = conflictPublisher({ head: 'head-1' });
    const reanchor = vi.fn(async () => ({ position: position('head-2') }));

    const published = await adapter.publishComment(ref, finding, 'Comment', position('head-1'), reanchor);

    expect(published).toMatchObject({ mode: 'inline' });
    expect(published.reanchored).toBeUndefined();
    expect(reanchor).not.toHaveBeenCalled();
  });
});

describe('createCommit', () => {
  const page: PageContext = { origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 };

  it('maps files onto GitLab commit actions and keeps the finding text as the message', () => {
    const payload = JSON.parse(buildCommitPayload({
      branch: 'feature/payment',
      message: '硬编码 API Key 应移至安全配置',
      description: '证据：src/payment.ts L2',
      files: [
        { path: 'src/payment.ts', content: 'const a = readSecret();\n', action: 'update' },
        { path: 'src/secret.ts', content: 'export const key = "";\n', action: 'create' },
      ],
    })) as Record<string, unknown>;

    expect(payload).toMatchObject({ branch: 'feature/payment' });
    // 标题就是 Finding 标题，正文接在空行后面（GitLab 会忽略 commit_description）
    expect(payload.commit_message).toBe('硬编码 API Key 应移至安全配置\n\n证据：src/payment.ts L2');
    expect('commit_description' in payload).toBe(false);
    expect(payload.actions).toEqual([
      { action: 'update', file_path: 'src/payment.ts', content: 'const a = readSecret();\n' },
      { action: 'create', file_path: 'src/secret.ts', content: 'export const key = "";\n' },
    ]);
  });

  it('leaves out an empty commit description', () => {
    const payload = JSON.parse(buildCommitPayload({
      branch: 'main', message: 'title', description: '  ', files: [{ path: 'a.ts', content: 'a', action: 'update' }],
    })) as Record<string, unknown>;
    expect(payload.commit_message).toBe('title');
    expect('commit_description' in payload).toBe(false);
  });

  it('posts JSON to the repository commits endpoint of the source branch', async () => {
    const seen: { url: string; method: string; contentType: string; token: string; body: string }[] = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({
        url: input, method: init?.method ?? 'GET', body: String(init?.body ?? ''),
        contentType: headers['Content-Type'] ?? '', token: headers['PRIVATE-TOKEN'] ?? '',
      });
      return new Response(
        JSON.stringify({ id: 'c0ffee1234567890', short_id: 'c0ffee12', title: '修复标题', web_url: 'https://gitlab.test/commit/c0ffee12' }),
        { status: 201 },
      );
    });
    const adapter = new GitLabAdapter(page, 'glpat-test', fetcher);

    const commit = await adapter.createCommit({
      branch: 'feature/payment', message: '修复标题', description: '正文',
      files: [{ path: 'src/payment.ts', content: 'fixed\n', action: 'update' }],
    });

    expect(commit).toEqual({
      id: 'c0ffee1234567890', shortId: 'c0ffee12', title: '修复标题',
      webUrl: 'https://gitlab.test/commit/c0ffee12',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://gitlab.test/api/v4/projects/group%2Fproject/repository/commits');
    expect(seen[0].method).toBe('POST');
    expect(seen[0].contentType).toBe('application/json');
    expect(seen[0].token).toBe('glpat-test');
    expect(JSON.parse(seen[0].body)).toMatchObject({
      branch: 'feature/payment',
      commit_message: '修复标题\n\n正文',
      actions: [{ action: 'update', file_path: 'src/payment.ts', content: 'fixed\n' }],
    });
  });

  it('surfaces a protected-branch rejection as a GitLabApiError', async () => {
    const fetcher = vi.fn(async () => new Response('{"message":"403 Forbidden"}', { status: 403 }));
    const adapter = new GitLabAdapter(page, 'glpat-test', fetcher);
    await expect(adapter.createCommit({
      branch: 'main', message: 'm', files: [{ path: 'a.ts', content: 'a', action: 'update' }],
    })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('fetchMrDiffSnapshot：diff_refs 与 diff 同源（stale diff_refs 的根）', () => {
  const ref: MergeRequestRef = { origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7 };
  const page: PageContext = { origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 };

  const mrDetail = {
    title: 'feat: pay', description: '', state: 'opened', source_branch: 'feat/pay', target_branch: 'main',
    sha: 'mr-head', diff_refs: { base_sha: 'mr-base', head_sha: 'mr-head', start_sha: 'mr-start' },
  };
  const versionRaw = (diff: string) => ({
    old_path: 'src/payment.ts', new_path: 'src/payment.ts',
    new_file: false, deleted_file: false, renamed_file: false, diff,
  });
  /** 版本响应里的那份 diff：apiKey 在新侧第 10 行。 */
  const versionDiff = '@@ -8,2 +8,5 @@\n function pay() {\n+  const traceId = nextTraceId();\n+  const apiKey = "sk-live-1";\n+  return charge(apiKey);\n }';
  /** MR diffs 接口会返回的那份（旧 head）：apiKey 还在新侧第 9 行。 */
  const staleDiff = '@@ -8,2 +8,4 @@\n function pay() {\n+  const apiKey = "sk-live-1";\n+  return charge(apiKey);\n }';

  interface Routes { versions?: unknown; version?: unknown; versionsStatus?: number }

  function stub(routes: Routes) {
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname.endsWith('/versions/9')) return new Response(JSON.stringify(routes.version), { status: 200 });
      if (url.pathname.endsWith('/versions')) {
        return new Response(JSON.stringify(routes.versions ?? { message: '404 Not Found' }), { status: routes.versionsStatus ?? 200 });
      }
      if (url.pathname.endsWith('/merge_requests/7/diffs')) return new Response(JSON.stringify([versionRaw(staleDiff)]), { status: 200 });
      if (url.pathname.endsWith('/merge_requests/7')) return new Response(JSON.stringify(mrDetail), { status: 200 });
      return new Response(JSON.stringify({ message: '404 Not Found' }), { status: 404 });
    });
    return { adapter: new GitLabAdapter(page, '', fetcher), seen };
  }

  const collected = {
    id: 9, base_commit_sha: 'v-base', head_commit_sha: 'v-head', start_commit_sha: 'v-start',
    diffs: [versionRaw(versionDiff)],
  };

  it('三个 sha 与 diff 取自同一个版本响应：MR 详情读到的 head 已经过期也用它那份', async () => {
    const { adapter, seen } = stub({
      versions: [{ id: 9, head_commit_sha: 'v-head' }, { id: 8, head_commit_sha: 'older-head' }],
      version: collected,
    });

    const snapshot = await adapter.fetchMrDiffSnapshot(ref);

    expect(snapshot.context.diffRefs).toEqual({ baseSha: 'v-base', headSha: 'v-head', startSha: 'v-start' });
    // MR 标题这些元信息仍来自 MR 详情，只有 diff_refs 换成与 diff 同源的那一份
    expect(snapshot.context.title).toBe('feat: pay');
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].lines.some((line) => line.newLine === 10 && line.text.includes('apiKey'))).toBe(true);
    expect(seen.some((path) => path.endsWith('/merge_requests/7/diffs'))).toBe(false);
  });

  it('按 head_sha 挑版本：MR 详情与版本列表对得上时就是它', async () => {
    const { adapter } = stub({
      versions: [{ id: 8, head_commit_sha: 'older-head' }, { id: 9, head_commit_sha: 'mr-head' }],
      version: collected,
    });
    expect((await adapter.fetchMrDiffSnapshot(ref)).context.diffRefs.headSha).toBe('v-head');
  });

  it('老 GitLab 没有 versions 接口（404）时回落到 MR 详情 + diffs 两次读', async () => {
    const { adapter, seen } = stub({ versionsStatus: 404 });

    const snapshot = await adapter.fetchMrDiffSnapshot(ref);

    expect(snapshot.context.diffRefs).toEqual({ baseSha: 'mr-base', headSha: 'mr-head', startSha: 'mr-start' });
    expect(snapshot.files[0].lines.some((line) => line.newLine === 9 && line.text.includes('apiKey'))).toBe(true);
    expect(seen.some((path) => path.endsWith('/merge_requests/7/diffs'))).toBe(true);
  });

  it('versions 被网关包成 200 + 错误体、列表为空、或版本里没有 diff 时都回落，不拿半份数据当快照', async () => {
    for (const routes of [
      { versions: { message: '404 Not Found' } },
      { versions: [] },
      { versions: [{ id: 9, head_commit_sha: 'v-head' }], version: { ...collected, diffs: [] } },
      { versions: [{ id: 9, head_commit_sha: 'v-head' }], version: { id: 9 } },
    ]) {
      const { adapter } = stub(routes);
      const snapshot = await adapter.fetchMrDiffSnapshot(ref);
      expect(snapshot.context.diffRefs.headSha).toBe('mr-head');
      expect(snapshot.files[0].lines.some((line) => line.newLine === 9)).toBe(true);
    }
  });

  it('发布用的 position 三个 sha 与行号同源：sha 来自版本响应，行号来自同一响应里的那份 diff', async () => {
    const { adapter } = stub({ versions: [{ id: 9, head_commit_sha: 'v-head' }], version: collected });
    const snapshot = await adapter.fetchMrDiffSnapshot(ref);

    const publish = resolvePublishPosition({
      id: 'f', fingerprint: 'fp', path: 'src/payment.ts', line: 9, endLine: 9, side: 'new',
      category: 'security', severity: 'high', confidence: 'high', title: '硬编码密钥', content: 'c',
      evidence: [], existingCode: 'const apiKey = "sk-live-1";', suggestionCode: '', comment: 'c',
      source: 'model', status: 'draft',
    } as Finding, snapshot.files);

    // 模型报的第 9 行在这份 diff 里是 traceId：按内容锚到第 10 行，sha 用同一个响应里的
    expect(publish.finding.line).toBe(10);
    const params = Object.fromEntries(buildDiscussionPayload({
      body: 'b', position: toDiscussionPosition(publish, snapshot.context.diffRefs)!,
    }));
    expect(params).toMatchObject({
      'position[base_sha]': 'v-base', 'position[head_sha]': 'v-head', 'position[start_sha]': 'v-start',
      'position[new_line]': '10',
    });
  });

  it('position 的 head_sha 与服务端当前不一致时预检就 409，一次 POST 都不发', async () => {
    const posted: string[] = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (init?.method === 'POST') posted.push(url.pathname);
      if (url.pathname.endsWith('/merge_requests/7')) return new Response(JSON.stringify(mrDetail), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const adapter = new GitLabAdapter(page, '', fetcher);

    const error = await adapter.createDiscussion(ref, {
      body: 'b',
      position: {
        path: 'src/payment.ts', startLine: 9, endLine: 9, side: 'new',
        start: { newLine: 9 }, end: { newLine: 9 },
        diffRefs: { baseSha: 'mr-base', headSha: 'stale-head', startSha: 'mr-start' },
      },
    }).catch((caught: unknown) => caught as GitLabApiError);

    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error).toMatchObject({ status: 409, code: 'stale_diff_refs' });
    expect(posted).toEqual([]);
  });
});
