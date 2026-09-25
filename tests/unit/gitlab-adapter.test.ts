import { describe, expect, it, vi } from 'vitest';
import { buildDiscussionPayload, GitLabAdapter, GitLabApiError } from '../../src/core/gitlab-adapter';
import type { MergeRequestRef } from '../../src/core/types';

describe('GitLab discussion payload', () => {
  it('builds a new-side text position with all diff refs', () => {
    const payload = buildDiscussionPayload({
      body: 'review comment',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 3,
      side: 'new',
      diffRefs: { baseSha: 'base', headSha: 'head', startSha: 'start' },
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
      body: 'comment', path: 'a.ts', startLine: 4, endLine: 4, side: 'old',
      diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
    });
    expect(payload.get('position[old_line]')).toBe('4');
  });

  it('uses /dev/null paths for new and deleted files and supports line ranges', () => {
    const payload = buildDiscussionPayload({
      body: 'comment', path: 'src/new.ts', oldPath: '/dev/null', newPath: 'src/new.ts',
      startLine: 1, endLine: 3, side: 'new', newFile: true,
      diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
    });
    expect(payload.get('position[old_path]')).toBe('/dev/null');
    expect(payload.get('position[line_range][start][new_line]')).toBe('1');
    expect(payload.get('position[line_range][end][new_line]')).toBe('3');
  });
});

describe('GitLabAdapter', () => {
  const ref: MergeRequestRef = { origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7 };
  const mergeRequest = { diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' } };

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
    const draft = { body: 'same', path: 'a.ts', startLine: 1, endLine: 1, side: 'new' as const, diffRefs: { baseSha: 'base', headSha: 'head', startSha: 'start' } };
    expect(await adapter.createDiscussion(ref, draft)).toMatchObject({ id: 'existing', deduplicated: true });

    await expect(adapter.createDiscussion(ref, { ...draft, body: 'different', diffRefs: { baseSha: 'base', headSha: 'old', startSha: 'start' } }))
      .rejects.toBeInstanceOf(GitLabApiError);
  });
});
