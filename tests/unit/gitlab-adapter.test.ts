import { describe, expect, it, vi } from 'vitest';
import { buildDiscussionPayload, GitLabAdapter, GitLabApiError } from '../../src/core/gitlab-adapter';
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
});
