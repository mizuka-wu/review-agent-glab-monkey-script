import { describe, expect, it } from 'vitest';
import { buildDiscussionPayload } from '../../src/core/gitlab-adapter';

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
});
