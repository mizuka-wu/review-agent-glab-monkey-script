import { describe, expect, it, vi } from 'vitest';
import { anchorFindings } from '../../src/core/anchor';
import { normalizeFileDiff } from '../../src/core/diff';
import {
  commentableRanges,
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

describe('可锚定行标注（GitLab 只接受挂在 diff 行上的 position）', () => {
  it('把 diff 行号连成区间', () => {
    expect(commentableRanges([3, 4, 5, 9], 1, 12)).toBe('L3-5, L9');
    expect(commentableRanges([5], 1, 12)).toBe('L5');
    expect(commentableRanges([5, 5, 6], 1, 12)).toBe('L5-6');
  });

  it('段外的行号不进区间，段内没有可锚定行时返回空串', () => {
    expect(commentableRanges([20, 30], 1, 12)).toBe('');
  });

  it('完整文件上下文段头明示哪些行能挂行内评论', () => {
    const file = normalizeFileDiff({
      old_path: 'src/a.ts', new_path: 'src/a.ts',
      diff: '@@ -5,2 +5,2 @@\n-const a = 1;\n+const a = 2;',
    });
    const context = fullFileContext(
      { ...file, newFileContent: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') },
      4000, 2,
    );

    expect(context).toContain('src/a.ts L3-7');
    expect(context).toContain('可锚定行：L5');
    expect(context).toContain('不要对它们产出 finding');
    // padding 出来的上下文行照样带行号，模型仍能读懂周边代码
    expect(context).toContain('3: line 3');
  });

  it('整段都没有可锚定行时直说（删除文件没有新侧行号）', () => {
    const file = normalizeFileDiff({
      old_path: 'src/gone.ts', new_path: '/dev/null', deleted_file: true,
      diff: '@@ -1,2 +0,0 @@\n-one\n-two',
    });
    const context = fullFileContext({ ...file, newFileContent: 'one\ntwo' }, 4000, 2);

    expect(context).toContain('本段没有可锚定行');
  });
});
