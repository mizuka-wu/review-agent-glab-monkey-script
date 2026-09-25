import { describe, expect, it } from 'vitest';
import { parseGitLabUrl, projectApiIdentifier } from '../../src/core/gitlab-url';

describe('parseGitLabUrl', () => {
  it('parses nested subgroups and encoded project names', () => {
    const page = parseGitLabUrl('https://gitlab.com/acme%2Forg/platform/api/-/merge_requests/248/diffs');
    expect(page).toMatchObject({
      origin: 'https://gitlab.com',
      route: 'diff',
      projectPath: 'acme/org/platform/api',
      mergeRequestIid: 248,
    });
  });

  it('parses legacy merge request URLs', () => {
    const page = parseGitLabUrl('https://gitlab.example.com/group/project/merge_requests/17');
    expect(page).toMatchObject({ route: 'merge-request', projectPath: 'group/project', mergeRequestIid: 17 });
  });

  it('parses file, raw, tree and commit routes', () => {
    expect(parseGitLabUrl('https://gitlab.com/a/b/-/blob/main/src/app.ts')).toMatchObject({
      route: 'file',
      filePath: 'src/app.ts',
    });
    expect(parseGitLabUrl('https://gitlab.com/a/b/-/raw/main/README.md')).toMatchObject({
      route: 'file',
      filePath: 'README.md',
    });
    expect(parseGitLabUrl('https://gitlab.com/a/b/-/tree/main/packages')).toMatchObject({
      route: 'file',
      filePath: 'packages',
    });
    expect(parseGitLabUrl('https://gitlab.com/a/b/-/commit/abc123')).toMatchObject({
      route: 'commit',
      commitSha: 'abc123',
    });
  });

  it('rejects invalid IIDs and non-project URLs', () => {
    expect(parseGitLabUrl('https://gitlab.com/a/b/-/merge_requests/nope').route).toBe('unknown');
    expect(parseGitLabUrl('https://example.com/a/b').projectPath).toBe('');
  });

  it('uses numeric project IDs for API requests', () => {
    expect(projectApiIdentifier({ projectPath: 'a/b', projectNumericId: 42 })).toBe('42');
    expect(projectApiIdentifier({ projectPath: 'a/b' })).toBe('a%2Fb');
  });
});
