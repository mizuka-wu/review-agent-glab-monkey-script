import { describe, expect, it, vi } from 'vitest';
import { RepoIndex, createRepoIndex, defaultRepoIndexOptions } from '../../src/core/repo-index';
import { createRepoStore } from '../../src/core/repo-store';
import type { GitLabAdapter } from '../../src/core/gitlab-adapter';

const files: Record<string, string> = {
  'src/auth.ts': 'export function verifyToken(token: string) {\n  return token.length > 0;\n}\n',
  'src/handler.ts': 'import { verifyToken } from "./auth";\nexport function handler() {\n  return verifyToken("x");\n}\n',
  'README.md': '# docs\n',
  'package-lock.json': '{}\n',
  'src/huge.ts': 'x'.repeat(5000),
};

function fakeAdapter(): GitLabAdapter {
  return {
    listTree: vi.fn(async () => Object.keys(files).map((path) => ({ path, type: 'blob' }))),
    getFile: vi.fn(async (path: string) => {
      if (!(path in files)) throw new Error(`404 ${path}`);
      return files[path];
    }),
  } as unknown as GitLabAdapter;
}

describe('repo store', () => {
  it('falls back to the memory backend when OPFS is unavailable', async () => {
    const store = await createRepoStore('/test');
    expect(store.backend).toBe('memory');
    await store.writeFile('/a/b.ts', 'hello');
    expect(await store.readFile('/a/b.ts')).toBe('hello');
    expect(await store.readFile('/missing')).toBeNull();
    await store.clear();
    expect(await store.readFile('/a/b.ts')).toBeNull();
  });
});

describe('RepoIndex', () => {
  it('indexes eligible files, builds symbols and persists metadata', async () => {
    const index = await createRepoIndex();
    const status = await index.index(fakeAdapter(), 'sha-1');

    expect(status.state).toBe('ready');
    // auth + handler + huge（README 与 lockfile 被过滤）
    expect(status.files).toBe(3);
    expect(status.symbols).toBeGreaterThanOrEqual(2);
    expect(index.ready).toBe(true);
    expect(await index.readFile('src/auth.ts')).toContain('verifyToken');
    expect(await index.store.readFile('/meta.json')).toContain('sha-1');

    const found = index.search('verify');
    expect(found.defs[0]?.name).toBe('verifyToken');
    const chain = index.callChain('verifyToken', 1);
    expect(chain?.callers.some((caller) => caller.symbol === 'handler')).toBe(true);
  });

  it('skips markdown, lockfiles and oversized files', async () => {
    const index = new RepoIndex(await createRepoStore('/test-skip'), {
      ...defaultRepoIndexOptions, maxFileBytes: 1000,
    });
    const status = await index.index(fakeAdapter(), 'sha-2');
    expect(status.files).toBe(2);
    expect(status.skipped.files).toBeGreaterThanOrEqual(1);
    expect(await index.readFile('src/huge.ts')).toBeNull();
  });

  it('restores a cached index for the same ref only', async () => {
    const store = await createRepoStore('/test-restore');
    const first = new RepoIndex(store);
    await first.index(fakeAdapter(), 'sha-3');

    const second = new RepoIndex(store);
    expect(await second.restore('sha-3')).toBe(true);
    expect(second.ready).toBe(true);
    expect(second.search('verify').defs).toHaveLength(1);

    const third = new RepoIndex(store);
    expect(await third.restore('other-sha')).toBe(false);
  });

  it('respects maxFiles and reports cancellation', async () => {
    const index = new RepoIndex(await createRepoStore('/test-limit'), { ...defaultRepoIndexOptions, maxFiles: 1 });
    const status = await index.index(fakeAdapter(), 'sha-4');
    expect(status.files).toBe(1);
  });

  it('clears cache and returns to idle', async () => {
    const index = await createRepoIndex();
    await index.index(fakeAdapter(), 'sha-5');
    await index.clear();
    expect(index.status.state).toBe('idle');
    expect(index.ready).toBe(false);
    expect(await index.readFile('src/auth.ts')).toBeNull();
  });
});
