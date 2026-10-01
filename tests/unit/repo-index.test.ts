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

const otherFiles: Record<string, string> = {
  'src/auth.ts': 'export function verifyTokenV2(token: string) {\n  return Boolean(token);\n}\n',
};

function fakeAdapter(source: Record<string, string> = files): GitLabAdapter {
  return {
    listTree: vi.fn(async () => Object.keys(source).map((path) => ({ path, type: 'blob' }))),
    getFile: vi.fn(async (path: string) => {
      if (!(path in source)) throw new Error(`404 ${path}`);
      return source[path];
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

  it('lists files with sizes and removes directories recursively', async () => {
    const store = await createRepoStore('/test-dir');
    await store.writeFile('/idx/a/files/x.ts', 'aaaa');
    await store.writeFile('/idx/a/files/deep/y.ts', 'bb');
    await store.writeFile('/idx/b/files/z.ts', 'ccc');

    const listed = await store.listFiles('/idx/a');
    expect(listed.map((entry) => entry.path).sort()).toEqual(['/idx/a/files/deep/y.ts', '/idx/a/files/x.ts']);
    expect(listed.find((entry) => entry.path.endsWith('x.ts'))?.size).toBe(4);

    await store.removeDir('/idx/a');
    expect(await store.listFiles('/idx/a')).toEqual([]);
    expect(await store.readFile('/idx/b/files/z.ts')).toBe('ccc');
  });
});

describe('RepoIndex', () => {
  it('indexes eligible files, builds symbols and persists per-ref metadata', async () => {
    const index = await createRepoIndex();
    const status = await index.index(fakeAdapter(), { ref: 'sha-1', label: 'main', projectPath: 'acme/app' });

    expect(status.state).toBe('ready');
    expect(status.files).toBe(3);
    expect(status.symbols).toBeGreaterThanOrEqual(2);
    expect(status.label).toBe('main');
    expect(index.ready).toBe(true);
    expect(index.inSync).toBe(false);
    expect(await index.readFile('src/auth.ts')).toContain('verifyToken');
    expect(await index.store.readFile('/idx/sha-1/meta.json')).toContain('sha-1');

    const found = index.search('verify');
    expect(found.defs[0]?.name).toBe('verifyToken');
    const chain = index.callChain('verifyToken', 1);
    expect(chain?.callers.some((caller) => caller.symbol === 'handler')).toBe(true);

    index.markCurrentRef('sha-1');
    expect(index.inSync).toBe(true);
  });

  it('skips markdown, lockfiles and oversized files', async () => {
    const index = new RepoIndex(await createRepoStore('/test-skip'), { maxFileBytes: 1000 });
    const status = await index.index(fakeAdapter(), { ref: 'sha-2' });
    expect(status.files).toBe(2);
    expect(status.skipped.files).toBeGreaterThanOrEqual(1);
    expect(await index.readFile('src/huge.ts')).toBeNull();
  });

  it('keeps separate namespaces per ref and switches between them', async () => {
    const store = await createRepoStore('/test-multi');
    const index = new RepoIndex(store);

    await index.index(fakeAdapter(files), { ref: 'sha-a', label: 'main' });
    await index.index(fakeAdapter(otherFiles), { ref: 'sha-b', label: 'feature/x' });

    const registry = await index.list();
    expect(registry.map((entry) => entry.ref).sort()).toEqual(['sha-a', 'sha-b']);
    expect(index.status.ref).toBe('sha-b');
    expect(index.search('verifyTokenV2').defs).toHaveLength(1);

    expect(await index.activate('sha-a')).toBe(true);
    expect(index.status.ref).toBe('sha-a');
    expect(index.status.label).toBe('main');
    expect(index.search('verifyTokenV2').defs).toEqual([]);
    expect(index.search('verifyToken').defs).toHaveLength(1);
    expect(await index.readFile('src/auth.ts')).toContain('verifyToken(token');
  });

  it('restores from cache without touching the adapter', async () => {
    const store = await createRepoStore('/test-restore');
    const adapter = fakeAdapter();
    await new RepoIndex(store).index(adapter, { ref: 'sha-3' });
    const callsAfterIndex = (adapter.getFile as ReturnType<typeof vi.fn>).mock.calls.length;

    const second = new RepoIndex(store);
    expect(await second.restore('sha-3')).toBe(true);
    expect(second.ready).toBe(true);
    expect(second.search('verify').defs).toHaveLength(1);
    expect((adapter.getFile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterIndex);

    const third = new RepoIndex(store);
    expect(await third.restore('other-sha')).toBe(false);
  });

  it('deletes a single ref and resets when deleting the active one', async () => {
    const store = await createRepoStore('/test-remove');
    const index = new RepoIndex(store);
    await index.index(fakeAdapter(files), { ref: 'sha-a' });
    await index.index(fakeAdapter(otherFiles), { ref: 'sha-b' });

    await index.remove('sha-a');
    expect((await index.list()).map((entry) => entry.ref)).toEqual(['sha-b']);
    expect(index.status.ref).toBe('sha-b');
    expect(await index.readFile('src/auth.ts')).toContain('verifyTokenV2');

    await index.remove('sha-b');
    expect(await index.list()).toEqual([]);
    expect(index.status.state).toBe('idle');
    expect(index.ready).toBe(false);
    expect(await index.readFile('src/auth.ts')).toBeNull();
  });

  it('prunes oldest indexes beyond maxIndexes', async () => {
    const store = await createRepoStore('/test-prune');
    const index = new RepoIndex(store, { ...defaultRepoIndexOptions, maxIndexes: 2 });
    await index.index(fakeAdapter(files), { ref: 'sha-1', label: 'a', projectPath: 'p' });
    await index.index(fakeAdapter(files), { ref: 'sha-2', label: 'b', projectPath: 'p' });
    await index.index(fakeAdapter(files), { ref: 'sha-3', label: 'c', projectPath: 'p' });

    const registry = await index.list();
    expect(registry.map((entry) => entry.ref).sort()).toEqual(['sha-2', 'sha-3']);
    expect(await store.listFiles('/idx/sha-1')).toEqual([]);
    expect(index.status.registry).toHaveLength(2);
  });

  it('clears every namespace and the registry', async () => {
    const index = await createRepoIndex();
    await index.index(fakeAdapter(), { ref: 'sha-5' });
    await index.clear();
    expect(index.status.state).toBe('idle');
    expect(index.status.registry).toEqual([]);
    expect(await index.list()).toEqual([]);
    expect(await index.readFile('src/auth.ts')).toBeNull();
  });
});
