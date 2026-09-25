import { describe, expect, it } from 'vitest';
import { anchorFindings } from '../../src/core/anchor';
import { buildReviewContext, includedFiles } from '../../src/core/context';
import { normalizeFileDiff } from '../../src/core/diff';
import type { Finding } from '../../src/core/types';

const file = normalizeFileDiff({
  old_path: 'src/a.ts', new_path: 'src/a.ts',
  diff: '@@ -1,2 +1,3 @@\n context\n+const x = 1;\n+return x;',
});

const finding = (input: Partial<Finding>): Finding => ({
  id: 'id', fingerprint: 'fp', path: 'src/a.ts', line: 0, endLine: 0, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
  evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment', source: 'model', status: 'draft',
  ...input,
});

describe('context builder and anchor', () => {
  it('filters generated, secret and lockfiles and keeps budget omissions visible', () => {
    const context = buildReviewContext({
      files: [file, normalizeFileDiff({ old_path: 'dist/a.js', new_path: 'dist/a.js', diff: '+x' }), normalizeFileDiff({ old_path: '.env', new_path: '.env', diff: '+SECRET=1' }), normalizeFileDiff({ old_path: 'package-lock.json', new_path: 'package-lock.json', diff: '+{}' })],
      budgetCharacters: 10,
    });
    expect(includedFiles(context).map((item) => item.newPath)).toEqual([]);
    expect(context.omittedFiles.map((item) => item.reason)).toEqual(expect.arrayContaining(['budget', 'generated', 'secret', 'lockfile']));
  });

  it('anchors multi-line existing code and rejects ambiguous/missing code', () => {
    const anchored = anchorFindings([finding({ existingCode: 'const x = 1;\nreturn x;' })], [file]);
    expect(anchored[0]).toMatchObject({ line: 2, endLine: 3, side: 'new' });
    expect(anchorFindings([finding({ existingCode: 'missing()' })], [file])).toEqual([]);
    expect(anchorFindings([finding({ line: 99 })], [file])).toEqual([]);
  });
});
