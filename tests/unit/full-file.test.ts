import { describe, expect, it, vi } from 'vitest';
import { anchorFindings } from '../../src/core/anchor';
import { normalizeFileDiff } from '../../src/core/diff';
import {
  createFullFileSnapshot,
  fullFileContext,
  loadFullFiles,
} from '../../src/core/full-file';
import type { Finding } from '../../src/core/types';

const finding = (input: Partial<Finding>): Finding => ({
  id: 'id', fingerprint: 'fp', path: 'src/wrong.ts', line: 0, endLine: 0, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
  evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment', source: 'model', status: 'draft',
  ...input,
});

describe('full file context and relocation', () => {
  it('builds bounded line windows around diff anchors', () => {
    const file = normalizeFileDiff({
      old_path: 'src/a.ts', new_path: 'src/a.ts',
      diff: '@@ -10 +10 @@\n const changed = true;',
    });
    const context = fullFileContext({ ...file, newFileContent: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') }, 500, 1);
    expect(context).toContain('src/a.ts L9-11');
    expect(context).toContain('10: line 10');
  });

  it('loads raw content with limits and records omissions', async () => {
    const loader = vi.fn(async (path: string) => path === 'large.ts' ? 'x'.repeat(20) : 'line 1\nline 2');
    const result = await loadFullFiles(['src/a.ts', 'large.ts', 'src/a.ts'], 'head', loader, {
      maxFileCharacters: 15,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: 'src/a.ts', ref: 'head', lines: ['line 1', 'line 2'] });
    expect(result.omitted).toEqual([{ path: 'large.ts', reason: 'too_large', message: '文件超过 15 字符' }]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('relocates a unique full-file match but keeps it non-publishable', () => {
    const snapshot = createFullFileSnapshot('src/helper.ts', 'head', 'function helper() {\n  return 1;\n}');
    const result = anchorFindings([
      finding({ existingCode: 'function helper() {\n  return 1;\n}', path: 'src/missing.ts' }),
    ], [], [snapshot]);
    expect(result[0]).toMatchObject({
      path: 'src/helper.ts',
      line: 1,
      endLine: 3,
      anchor: { source: 'full-file', publishable: false, relocatedFromPath: 'src/missing.ts' },
    });
  });

  it('rejects ambiguous full-file matches and relocates unique diff matches', () => {
    const repeated = createFullFileSnapshot('src/repeated.ts', 'head', 'same();\nsame();');
    expect(anchorFindings([finding({ existingCode: 'same();' })], [], [repeated])).toEqual([]);

    const changed = normalizeFileDiff({
      old_path: 'src/real.ts', new_path: 'src/real.ts',
      diff: '@@ -1 +1 @@\n+unique();',
    });
    const result = anchorFindings([finding({ existingCode: 'unique();' })], [changed]);
    expect(result[0]).toMatchObject({
      path: 'src/real.ts',
      anchor: { source: 'diff', publishable: true, relocatedFromPath: 'src/wrong.ts' },
    });
  });
});
