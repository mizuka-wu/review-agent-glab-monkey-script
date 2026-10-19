import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCommitPayload, buildDiscussionPayload, buildDiscussionPosition, GitLabAdapter, GitLabApiError, positionRejectionReason } from '../../src/core/gitlab-adapter';
import { resolvePublishPosition } from '../../src/core/anchor';
import { debugBus } from '../../src/core/debug-bus';
import { toDiscussionPosition } from '../../src/core/reanchor';
import type { DiscussionDraft, DiscussionPosition, Finding, MergeRequestRef, PageContext } from '../../src/core/types';

/** 真实发出去的那一份 JSON body：所有断言都基于它，不再看 form 平铺键。 */
type SentDiscussion = { body: string; position?: Record<string, unknown> };

function sent(draft: DiscussionDraft): SentDiscussion {
  const payload = buildDiscussionPayload(draft);
  // 不再是 form：整条 body 必须是合法 JSON，且不许出现 form 编码的平铺 position 键
  expect(payload).not.toContain('position%5B');
  expect(payload).not.toContain('position[');
  return JSON.parse(payload) as SentDiscussion;
}

const positionOf = (draft: DiscussionDraft) => sent(draft).position;

describe('GitLab discussion payload（JSON body）', () => {
  it('builds a new-side text position with all diff refs', () => {
    const payload = sent({
      body: 'review comment',
      position: {
        path: 'src/a.ts',
        startLine: 2,
        endLine: 3,
        side: 'new',
        diffRefs: { baseSha: 'base', headSha: 'head', startSha: 'start' },
      },
    });
    expect(payload.body).toBe('review comment');
    expect(payload.position).toMatchObject({
      position_type: 'text',
      base_sha: 'base',
      head_sha: 'head',
      start_sha: 'start',
      new_path: 'src/a.ts',
      old_path: 'src/a.ts',
      new_line: 3,
    });
    // JSON 里行号是整数（position.json 的 old_line / new_line 就是 integer），不是 form 的字符串
    expect(typeof payload.position!.new_line).toBe('number');
    expect('old_line' in payload.position!).toBe(false);
  });

  it('uses old_line for deleted code', () => {
    const position = positionOf({
      body: 'comment',
      position: { path: 'a.ts', startLine: 4, endLine: 4, side: 'old', diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' } },
    });
    expect(position!.old_line).toBe(4);
  });

  it('keeps the real path on both sides for a new file and supports line ranges', () => {
    const position = positionOf({
      body: 'comment',
      position: {
        path: 'src/new.ts', oldPath: '/dev/null', newPath: 'src/new.ts',
        startLine: 1, endLine: 3, side: 'new',
        start: { newLine: 1 }, end: { newLine: 3 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    // GitLab 把 old_path/new_path 当 diff 路径过滤条件传给 Gitaly，/dev/null 会 500。
    expect(position!.old_path).toBe('src/new.ts');
    expect(position!.new_path).toBe('src/new.ts');
    const range = position!.line_range as { start: Record<string, unknown>; end: Record<string, unknown> };
    expect(range.start.new_line).toBe(1);
    expect(range.end.new_line).toBe(3);
  });

  it('sends both old_line and new_line for a context line', () => {
    const payload = sent({
      body: 'comment',
      position: {
        path: 'a.ts', startLine: 15, endLine: 15, side: 'new',
        start: { oldLine: 15, newLine: 15 }, end: { oldLine: 15, newLine: 15 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    expect(payload.position).toMatchObject({ old_line: 15, new_line: 15 });
    expect('line_range' in payload.position!).toBe(false);
  });

  it('sends only the side that really exists on a removed line', () => {
    const position = positionOf({
      body: 'comment',
      position: {
        path: 'a.ts', startLine: 33, endLine: 33, side: 'old',
        start: { oldLine: 33 }, end: { oldLine: 33 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    expect(position!.old_line).toBe(33);
    expect('new_line' in position!).toBe(false);
  });

  it('describes the end line at top level and pairs every line_range endpoint separately', () => {
    const position = positionOf({
      body: 'comment',
      position: {
        // start 是 context 行（两侧都有行号），end 是 added 行（只有 new 侧）
        path: 'a.ts', startLine: 15, endLine: 16, side: 'new',
        start: { oldLine: 15, newLine: 15 }, end: { newLine: 16 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    const range = position!.line_range as { start: Record<string, unknown>; end: Record<string, unknown> };
    expect(position!.new_line).toBe(16);
    expect('old_line' in position!).toBe(false);
    expect(range.start).toMatchObject({ old_line: 15, new_line: 15 });
    expect(range.end.new_line).toBe(16);
    expect('old_line' in range.end).toBe(false);
  });

  it('only emits line_range keys the GitLab json schema allows', () => {
    const position = positionOf({
      body: 'comment',
      position: {
        path: 'a.ts', startLine: 29, endLine: 36, side: 'new',
        start: { newLine: 29 }, end: { newLine: 36 },
        diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
      },
    });
    // line_range 被 GitLab 原样存下并按 additionalProperties: false 校验，多一个键就整条 400。
    // 键名抄 19.4 容器 app/validators/json_schemas/position.json 里 line_range.start / .end 的 properties。
    const allowed = ['line_code', 'type', 'old_line', 'new_line'];
    const range = position!.line_range as { start: Record<string, unknown>; end: Record<string, unknown> };
    for (const endpoint of ['start', 'end'] as const) {
      const keys = Object.keys(range[endpoint]);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => !allowed.includes(key))).toEqual([]);
    }
  });

  it('drops blank position fields instead of sending empty values', () => {
    const position = positionOf({
      body: 'comment',
      position: {
        path: 'a.ts', startLine: 2, endLine: 2, side: 'new',
        diffRefs: { baseSha: '', headSha: 'h', startSha: '' },
      },
    });
    // undefined 键由 JSON.stringify 自动省略：body 里连键名都不出现
    expect('base_sha' in position!).toBe(false);
    expect('start_sha' in position!).toBe(false);
    expect(buildDiscussionPayload({
      body: 'comment',
      position: { path: 'a.ts', startLine: 2, endLine: 2, side: 'new', diffRefs: { baseSha: '', headSha: 'h', startSha: '' } },
    })).not.toContain('base_sha');
    expect(position!.head_sha).toBe('h');
  });

  it('omits every position field for a full-text comment', () => {
    expect(sent({ body: 'MR 级评论' })).toEqual({ body: 'MR 级评论' });
    expect(buildDiscussionPayload({ body: 'MR 级评论' })).toBe('{"body":"MR 级评论"}');
  });

  it('position 对象由 DiscussionPosition 直接构造，序列化前后是同一份结构', () => {
    const position: DiscussionPosition = {
      path: 'a.ts', startLine: 2, endLine: 4, side: 'new',
      start: { newLine: 2 }, end: { newLine: 4 },
      diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
    };
    expect(JSON.parse(buildDiscussionPayload({ body: 'x', position })) as SentDiscussion)
      .toEqual({ body: 'x', position: JSON.parse(JSON.stringify(buildDiscussionPosition(position))) as unknown });
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

  const parsedOf = (post: string) => JSON.parse(post) as SentDiscussion;
  const bodyOf = (post: string) => parsedOf(post).body;
  const positionOf = (post: string) => parsedOf(post).position;

  it('creates an inline discussion when the position is accepted', async () => {
    const { adapter, posts } = publisher([200]);
    expect(await adapter.publishComment(ref, finding, 'Comment', position)).toMatchObject({ id: 'd1', mode: 'inline' });
    expect(posts).toHaveLength(1);
    expect(positionOf(posts[0])!.new_line).toBe(12);
    expect(bodyOf(posts[0])).toBe('Comment');
  });

  it('publishes a full-text comment when there is no usable line', async () => {
    const { adapter, posts } = publisher([200]);
    expect(await adapter.publishComment(ref, finding, 'Comment')).toMatchObject({ id: 'd1', mode: 'full' });
    expect(posts).toHaveLength(1);
    expect(positionOf(posts[0])).toBeUndefined();
    expect(bodyOf(posts[0])).toContain('src/a.ts:12');
    expect(bodyOf(posts[0])).toContain('Comment');
  });

  it('retries as a full-text comment when GitLab rejects the position', async () => {
    for (const status of [400, 422]) {
      const { adapter, posts } = publisher([status, 200]);
      expect(await adapter.publishComment(ref, finding, 'Comment', position)).toMatchObject({ id: 'd2', mode: 'full' });
      expect(posts).toHaveLength(2);
      expect(positionOf(posts[0])!.new_line).toBe(12);
      expect(positionOf(posts[1])).toBeUndefined();
      expect(bodyOf(posts[1])).toContain('全文评论');
    }
  });

  it('falls back to a full-text comment when the diff refs went stale', async () => {
    const { adapter, posts } = publisher([200]);
    const stale = { ...position, diffRefs: { baseSha: 'base', headSha: 'old', startSha: 'start' } };
    expect(await adapter.publishComment(ref, finding, 'Comment', stale)).toMatchObject({ mode: 'full' });
    expect(posts).toHaveLength(1);
    expect(positionOf(posts[0])).toBeUndefined();
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
  const field = (post: string, key: string) => (JSON.parse(post) as SentDiscussion).position?.[key];

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
        const sentHead = (JSON.parse(body) as SentDiscussion).position?.head_sha;
        const rejected = sentHead !== undefined && (conflicts > 0 || sentHead !== head);
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
    expect(field(posts[0], 'new_line')).toBe(12);
    expect(field(posts[1], 'new_line')).toBe(13);
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
    expect(field(posts[0], 'new_line')).toBe(12);
    expect(field(posts[1], 'new_line')).toBe(13);
    expect((JSON.parse(posts[2]) as SentDiscussion).position).toBeUndefined();
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
    expect((JSON.parse(posts[1]) as SentDiscussion).position).toBeUndefined();
  });

  it('400 / 422 不是 diff_refs 过期，不触发重锚', async () => {
    for (const status of [400, 422]) {
      const posts: string[] = [];
      const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (init?.method === 'POST') {
          posts.push(String(init.body));
          return (JSON.parse(String(init.body)) as SentDiscussion).position?.head_sha
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
    expect(field(posts[1], 'new_line')).toBe(14);
    expect((JSON.parse(posts[2]) as SentDiscussion).position).toBeUndefined();
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
    const sentPayload = JSON.parse(buildDiscussionPayload({
      body: 'b', position: toDiscussionPosition(publish, snapshot.context.diffRefs)!,
    })) as SentDiscussion;
    expect(sentPayload.position).toMatchObject({
      base_sha: 'v-base', head_sha: 'v-head', start_sha: 'v-start', new_line: 10,
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

/**
 * 多行评论的 line_range 在官方文档里 4 个键全是 Required（line_code / type / old_line / new_line），
 * 19.4 容器的 position.json 没写 required，缺键本地照样 201；老 GitLab 严格校验就是
 * 400 `position 必须是有效的 json schema`。老版本起不来，这里按文档口径做键级严格自检。
 */
describe('discussion payload: line_range 官方必填键（line_code + type）', () => {
  const REFS = { baseSha: 'b', headSha: 'h', startSha: 's' };
  // 下面三个 hex 是在 GitLab 容器里用 Digest::SHA1.hexdigest 跑出来的，不是测试自己算的
  const HASH: Record<string, string> = {
    'a.ts': '02699cd6ca65aa6819d7e387678d8ea5359b5e59',
    'src/new.ts': 'df2b62deb31702acddc8aa626ad5715d14f6ec2b',
    'src/gone.ts': '3610915ac3ee397af8456cf1dd1f95aa7a212463',
  };
  const SCHEMA_FIELDS = ['line_code', 'type', 'old_line', 'new_line'];

  type SentRange = { start: Record<string, unknown>; end: Record<string, unknown> };

  const paramsOf = (position: Partial<DiscussionPosition> & { startLine: number; endLine: number }) =>
    (JSON.parse(buildDiscussionPayload({
      body: 'c',
      position: { path: 'a.ts', side: 'new', diffRefs: REFS, ...position } as DiscussionPosition,
    })) as SentDiscussion).position!;

  const rangeOf = (params: Record<string, unknown>) => params.line_range as SentRange;

  /** 模拟老 GitLab 的严格校验：必填键到齐、值是字符串枚举、没有 additionalProperties 之外的键、行号自洽。 */
  function expectStrictLineRange(params: Record<string, unknown>) {
    const range = params.line_range as SentRange | undefined;
    expect(range, '多行评论没发 line_range').toBeTruthy();

    for (const endpoint of ['start', 'end'] as const) {
      const sent = range![endpoint];
      // position.json 里 line_range.start / .end 都是 additionalProperties: false，多一个键整条 400
      expect(Object.keys(sent).filter((field) => !SCHEMA_FIELDS.includes(field)), `${endpoint} 多了 schema 不允许的键`).toEqual([]);

      // 文档标的两个 Required 键：line_code 是 SHA1(path)_old_new，type 只能是 'new' / 'old'
      expect(sent.line_code, `${endpoint} 缺 line_code`).toMatch(/^[0-9a-f]{40}_\d+_\d+$/);
      expect(['new', 'old'], `${endpoint} 的 type 不是字符串枚举`).toContain(sent.type);

      // line_code 里的行号必须和同一 endpoint 的 old_line / new_line 对得上，缺的一侧按 GitLab 口径补 0
      const [, oldPart, newPart] = String(sent.line_code).split('_');
      expect(Number(oldPart), `${endpoint} line_code 的 old 行号和 old_line 不一致`)
        .toBe(sent.old_line === undefined ? 0 : Number(sent.old_line));
      expect(Number(newPart), `${endpoint} line_code 的 new 行号和 new_line 不一致`)
        .toBe(sent.new_line === undefined ? 0 : Number(sent.new_line));
      // 只有本 commit 新增的行（没有 old_line）才是 'new'
      expect(sent.type, `${endpoint} 的 type 和行号配对不自洽`)
        .toBe(sent.old_line === undefined ? 'new' : 'old');
    }
  }

  it('start / end 各自把 line_code + type 补齐，四个键一个不缺', () => {
    const params = paramsOf({
      startLine: 18, endLine: 20, side: 'new',
      start: { oldLine: 18, newLine: 18 }, end: { newLine: 20 },
    });
    const range = rangeOf(params);
    expect(range.start).toEqual({
      line_code: `${HASH['a.ts']}_18_18`, type: 'old', old_line: 18, new_line: 18,
    });
    expect(range.end).toEqual({ line_code: `${HASH['a.ts']}_0_20`, type: 'new', new_line: 20 });
    expect('old_line' in range.end).toBe(false);
    expectStrictLineRange(params);
  });

  it('type 三态：新增行 new、删除行 old、上下文行 old', () => {
    const params = paramsOf({
      startLine: 19, endLine: 21, side: 'old',
      start: { oldLine: 19 }, end: { oldLine: 20, newLine: 21 },
    });
    const range = rangeOf(params);
    // start 是 removed 行：只有 old_line → 'old'；end 是 context 行：两侧都有 → 也是 'old'
    expect(range.start.type).toBe('old');
    expect(range.end.type).toBe('old');
    expect(range.start.line_code).toBe(`${HASH['a.ts']}_19_0`);
    expect(range.end.line_code).toBe(`${HASH['a.ts']}_20_21`);
    expectStrictLineRange(params);
  });

  it('line_code 缺的一侧补 0，不是留空串', () => {
    const params = paramsOf({ startLine: 2, endLine: 5, side: 'new', start: { newLine: 2 }, end: { newLine: 5 } });
    const range = rangeOf(params);
    expect(range.start.line_code).toBe(`${HASH['a.ts']}_0_2`);
    expect(range.end.line_code).toBe(`${HASH['a.ts']}_0_5`);
    expect(String(range.start.line_code)).not.toContain('__');
    expect(String(range.start.line_code)).not.toMatch(/_$/);
    expectStrictLineRange(params);
  });

  it('哈希的是 new_path.presence || old_path：rename 用新路径，删除文件回落旧路径', () => {
    const renamed = paramsOf({
      path: 'src/new.ts', oldPath: 'src/old.ts', newPath: 'src/new.ts',
      startLine: 3, endLine: 4, side: 'new', start: { oldLine: 3, newLine: 3 }, end: { newLine: 4 },
    });
    expect(renamed.new_path).toBe('src/new.ts');
    expect(rangeOf(renamed).start.line_code).toBe(`${HASH['src/new.ts']}_3_3`);
    expectStrictLineRange(renamed);

    // 新增文件：old_path 是 /dev/null，两侧都只能哈希新路径
    const created = paramsOf({
      path: 'src/new.ts', oldPath: '/dev/null', newPath: 'src/new.ts',
      startLine: 1, endLine: 3, side: 'new', start: { newLine: 1 }, end: { newLine: 3 },
    });
    expect(rangeOf(created).start.line_code).toBe(`${HASH['src/new.ts']}_0_1`);
    expect(rangeOf(created).end.line_code).toBe(`${HASH['src/new.ts']}_0_3`);
    expectStrictLineRange(created);

    // 删除文件：new_path 是 /dev/null，哈希回落 old_path
    const deleted = paramsOf({
      path: 'src/gone.ts', oldPath: 'src/gone.ts', newPath: '/dev/null',
      startLine: 7, endLine: 9, side: 'old', start: { oldLine: 7 }, end: { oldLine: 9 },
    });
    expect(deleted.new_path).toBe('src/gone.ts');
    expect(rangeOf(deleted).start.line_code).toBe(`${HASH['src/gone.ts']}_7_0`);
    expect(rangeOf(deleted).start.type).toBe('old');
    expectStrictLineRange(deleted);
  });

  it('没有 diff 行配对时按 side 兜底，两个必填键照样发得出去', () => {
    const byNew = paramsOf({ startLine: 2, endLine: 5, side: 'new' });
    expect(rangeOf(byNew).start).toMatchObject({ line_code: `${HASH['a.ts']}_0_2`, type: 'new' });
    expect(rangeOf(byNew).end).toMatchObject({ line_code: `${HASH['a.ts']}_0_5`, type: 'new' });
    expectStrictLineRange(byNew);

    const byOld = paramsOf({ startLine: 4, endLine: 6, side: 'old' });
    expect(rangeOf(byOld).start).toMatchObject({ line_code: `${HASH['a.ts']}_4_0`, type: 'old' });
    expect(rangeOf(byOld).end).toMatchObject({ line_code: `${HASH['a.ts']}_6_0`, type: 'old' });
    expectStrictLineRange(byOld);
  });

  it('单行评论一个 line_range 键都不发：文档的单行示例只有顶层 old_line / new_line', () => {
    for (const position of [
      { path: 'a.ts', startLine: 9, endLine: 9, side: 'new' as const, start: { newLine: 9 }, end: { newLine: 9 }, diffRefs: REFS },
      { path: 'a.ts', startLine: 9, endLine: 9, side: 'old' as const, start: { oldLine: 9 }, end: { oldLine: 9 }, diffRefs: REFS },
      { path: 'a.ts', startLine: 9, endLine: 9, side: 'new' as const, diffRefs: REFS },
    ]) {
      const params = (JSON.parse(buildDiscussionPayload({ body: 'c', position })) as SentDiscussion).position!;
      expect('line_range' in params).toBe(false);
      expect(buildDiscussionPayload({ body: 'c', position })).not.toContain('line_range');
      expect(params.new_line ?? params.old_line).toBe(9);
    }
  });

  it('MR 级全文评论不发任何 position 键', () => {
    expect(Object.keys(JSON.parse(buildDiscussionPayload({ body: 'c' })) as SentDiscussion)).toEqual(['body']);
  });
});

/**
 * 真实链路（老 GitLab + 油猴 GM.xmlHttpRequest）上 form 编码的嵌套 position 会被解析成畸形结构，
 * GitLab 只回一句 400 `position 必须是有效的 json schema`。发布端点因此一律改发 JSON：
 * 这里把「真的打到 fetcher 的那一次请求」的 Content-Type 与 body 结构钉死。
 */
describe('发布端点走 JSON body（不再 form 编码嵌套 position）', () => {
  const page: PageContext = { origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 };
  const ref: MergeRequestRef = { origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7 };
  const REFS = { baseSha: 'base', headSha: 'head', startSha: 'start' };

  type Seen = { url: string; contentType: string; body: string };

  function recorder(options: { discussions?: unknown[] } = {}) {
    const seen: Seen[] = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (init?.method === 'POST') {
        seen.push({ url: input, contentType: headers['Content-Type'] ?? '', body: String(init?.body ?? '') });
        return new Response(
          JSON.stringify(input.endsWith('/notes') || input.endsWith('/approve')
            ? { id: 99 }
            : { id: 'd1', notes: [{ id: 11 }] }),
          { status: 201 },
        );
      }
      if (input.endsWith('/merge_requests/7')) {
        return new Response(JSON.stringify({ diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' } }), { status: 200 });
      }
      return new Response(JSON.stringify(options.discussions ?? []), { status: 200 });
    });
    return { adapter: new GitLabAdapter(page, 'glpat-test', fetcher), seen };
  }

  it('单行行内评论：Content-Type 是 application/json，body 解析后是原生 position 结构', async () => {
    const { adapter, seen } = recorder();

    const published = await adapter.createDiscussion(ref, {
      body: 'inline single',
      position: {
        path: 'src/a.ts', startLine: 12, endLine: 12, side: 'new',
        start: { oldLine: 11, newLine: 12 }, end: { oldLine: 11, newLine: 12 }, diffRefs: REFS,
      },
    });

    expect(published).toEqual({ id: 'd1', noteId: '11' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://gitlab.test/api/v4/projects/group%2Fproject/merge_requests/7/discussions');
    expect(seen[0].contentType).toBe('application/json');
    // 一个 form 平铺键都不许有：position[line_range][...] 这种嵌套字段正是老 GitLab 解析出畸形结构的原因
    expect(seen[0].body).not.toContain('position%5B');
    expect(seen[0].body).not.toContain('position[');
    expect(JSON.parse(seen[0].body)).toEqual({
      body: 'inline single',
      position: {
        position_type: 'text', base_sha: 'base', head_sha: 'head', start_sha: 'start',
        new_path: 'src/a.ts', old_path: 'src/a.ts', old_line: 11, new_line: 12,
      },
    });
  });

  it('多行行内评论：line_range 是嵌套对象，行号是整数，缺的一侧整个键都不出现', async () => {
    const { adapter, seen } = recorder();

    await adapter.createDiscussion(ref, {
      body: 'inline multi',
      position: {
        path: 'src/a.ts', startLine: 12, endLine: 14, side: 'new',
        start: { newLine: 12 }, end: { oldLine: 13, newLine: 14 }, diffRefs: REFS,
      },
    });

    expect(seen[0].contentType).toBe('application/json');
    const body = JSON.parse(seen[0].body) as SentDiscussion;
    const range = body.position!.line_range as { start: Record<string, unknown>; end: Record<string, unknown> };
    expect(body.body).toBe('inline multi');
    expect(body.position).toMatchObject({ position_type: 'text', old_line: 13, new_line: 14 });
    expect(range.start).toMatchObject({ type: 'new', new_line: 12 });
    expect(range.start.line_code).toMatch(/^[0-9a-f]{40}_0_12$/);
    expect(range.end).toMatchObject({ type: 'old', old_line: 13, new_line: 14 });
    expect(range.end.line_code).toMatch(/^[0-9a-f]{40}_13_14$/);
    expect('old_line' in range.start).toBe(false);
    expect(Object.keys(range)).toEqual(['start', 'end']);
  });

  it('MR 级全文评论：body 里只有 body 一个键，position 整个不出现', async () => {
    const { adapter, seen } = recorder();

    await adapter.createDiscussion(ref, { body: '全文评论' });

    expect(seen[0].contentType).toBe('application/json');
    expect(JSON.parse(seen[0].body)).toEqual({ body: '全文评论' });
  });

  it('总评论（notes 端点）同族一致：也是 JSON，接口照样 201', async () => {
    const { adapter, seen } = recorder();

    await expect(adapter.createNote(ref, 'MR 总评论')).resolves.toEqual({ id: 99 });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://gitlab.test/api/v4/projects/group%2Fproject/merge_requests/7/notes');
    expect(seen[0].contentType).toBe('application/json');
    expect(JSON.parse(seen[0].body)).toEqual({ body: 'MR 总评论' });
  });

  it('去重路径不变：命中已有讨论时一次 POST 都不发，也就谈不上编码', async () => {
    const { adapter, seen } = recorder({
      discussions: [{ id: 'existing', notes: [{ id: 2, body: 'inline single' }] }],
    });

    const published = await adapter.createDiscussion(ref, {
      body: 'inline single',
      position: { path: 'src/a.ts', startLine: 12, endLine: 12, side: 'new', diffRefs: REFS },
    });

    expect(published).toEqual({ id: 'existing', noteId: '2', deduplicated: true });
    expect(seen).toEqual([]);
  });

  it('approve 是唯一还吃 form 默认 Content-Type 的端点：它没有 body，JSON 化没有把它改坏', async () => {
    const { adapter, seen } = recorder();

    await adapter.approveMergeRequest(ref);

    expect(seen[0].url).toBe('https://gitlab.test/api/v4/projects/group%2Fproject/merge_requests/7/approve');
    expect(seen[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(seen[0].body).toBe('');
  });
});
