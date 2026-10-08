import { describe, expect, it } from 'vitest';
import { anchorFindings, resolvePublishPosition } from '../../src/core/anchor';
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

const renamedFile = normalizeFileDiff({
  old_path: 'src/a.ts', new_path: 'src/b.ts', renamed_file: true,
  diff: '@@ -1,2 +1,3 @@\n context\n+const x = 1;\n+return x;',
});

const secretFile = normalizeFileDiff({
  old_path: 'src/p.ts', new_path: 'src/p.ts',
  diff: '@@ -1,1 +1,2 @@\n export function pay() {\n+  const apiKey = "sk-live-123";',
});

const authFile = normalizeFileDiff({
  old_path: 'src/auth.ts', new_path: 'src/auth.ts',
  diff: '@@ -1,2 +1,3 @@\n import { x } from "y";\n+export function verifyToken(token) {\n+  return token.length > 0;',
});

const removedFile = normalizeFileDiff({
  old_path: 'src/a.ts', new_path: 'src/a.ts',
  diff: '@@ -5,2 +4,1 @@\n-const legacy = 1;\n kept',
});

const otherFile = normalizeFileDiff({
  old_path: 'src/b.ts', new_path: 'src/b.ts',
  diff: '@@ -10,2 +10,3 @@\n ctx\n+const x = 1;\n+return x;',
});

describe('resolvePublishPosition', () => {
  it('keeps a finding whose range really sits on diff lines', () => {
    const position = resolvePublishPosition(
      finding({ line: 2, endLine: 3, existingCode: 'const x = 1;\nreturn x;' }), [file]);
    expect(position.publishable).toBe(true);
    expect(position.corrected).toBeUndefined();
    expect(position.finding).toMatchObject({ line: 2, endLine: 3, side: 'new' });
    expect(position.finding.anchor).toMatchObject({ source: 'diff', publishable: true });
  });

  it('re-locates an out-of-range line by matching the finding code', () => {
    const position = resolvePublishPosition(
      finding({ line: 99, endLine: 99, existingCode: 'const x = 1;\nreturn x;' }), [file]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 2, endLine: 3, side: 'new' });
    expect(position.finding.anchor).toMatchObject({ corrected: true });
  });

  it('clamps an end line that is not part of the diff', () => {
    const position = resolvePublishPosition(finding({ line: 2, endLine: 9 }), [file]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 2, endLine: 2 });
  });

  it('blocks when neither the line nor the content can be located', () => {
    const position = resolvePublishPosition(
      finding({ line: 99, endLine: 99, existingCode: 'totallyAbsentCall()' }), [file]);
    expect(position.publishable).toBe(false);
    expect(position.reason).toContain('无法按 Finding 内容自动修正位置');
  });

  it('maps a renamed path onto the new path expected by GitLab', () => {
    const position = resolvePublishPosition(
      finding({ line: 2, endLine: 3, existingCode: 'const x = 1;' }), [renamedFile]);
    expect(position.corrected).toBe(true);
    expect(position.finding).toMatchObject({
      path: 'src/b.ts', oldPath: 'src/a.ts', newPath: 'src/b.ts', line: 2, endLine: 3,
    });
  });

  it('fuzzy-matches a snippet whose whitespace and case drifted', () => {
    const position = resolvePublishPosition(
      finding({ path: 'src/p.ts', line: 40, endLine: 40, existingCode: 'const apikey="sk-live-123"' }), [secretFile]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 2, endLine: 2 });
  });

  it('falls back to identifier tokens from the title and description', () => {
    const position = resolvePublishPosition(finding({
      path: 'src/auth.ts', line: 77, endLine: 77, existingCode: '',
      title: 'verifyToken 没有校验过期', content: '调用 verifyToken(token) 之后没有检查返回值',
    }), [authFile]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 2, endLine: 2, side: 'new' });
  });

  it('flips to the old side when the code only exists on a removed line', () => {
    const position = resolvePublishPosition(
      finding({ line: 5, endLine: 5, side: 'new', existingCode: 'const legacy = 1;' }), [removedFile]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 5, endLine: 5, side: 'old' });
  });

  it('relocates a finding whose own file is missing from the diff', () => {
    const position = resolvePublishPosition(finding({
      path: 'src/ghost.ts', line: 2, endLine: 2, existingCode: 'const x = 1;\nreturn x;',
    }), [otherFile]);
    expect(position.corrected).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/b.ts', line: 11, endLine: 12 });
  });

  it('blocks a file that is absent from the diff and matches nothing', () => {
    const position = resolvePublishPosition(
      finding({ path: 'src/ghost.ts', line: 1, endLine: 1, existingCode: 'nope()' }), [file]);
    expect(position.publishable).toBe(false);
    expect(position.reason).toContain('不在当前 Diff 中');
  });

  it('uses nearby context only when the finding carries no searchable content', () => {
    const near = resolvePublishPosition(
      finding({ line: 5, endLine: 5, title: '问题', content: '说明', existingCode: '' }), [file]);
    expect(near).toMatchObject({ publishable: true, corrected: true });
    expect(near.finding).toMatchObject({ line: 3, endLine: 3 });

    const far = resolvePublishPosition(
      finding({ line: 500, endLine: 500, title: '问题', content: '说明', existingCode: '' }), [file]);
    expect(far.publishable).toBe(false);
    expect(far.reason).toContain('Diff 中找不到第 500 行');
  });

  it('does not trust the line number of a full-file anchored finding', () => {
    const position = resolvePublishPosition(finding({
      line: 2, endLine: 2, existingCode: '', anchor: { source: 'full-file', publishable: false },
    }), [file]);
    expect(position.publishable).toBe(false);
    expect(position.reason).toContain('只锚定到完整文件');
  });

  it('blocks until diffs are loaded', () => {
    const position = resolvePublishPosition(finding({ line: 2, endLine: 2 }), []);
    expect(position.publishable).toBe(false);
    expect(position.reason).toContain('Diff 尚未加载');
  });
});
