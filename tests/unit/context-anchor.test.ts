import { describe, expect, it } from 'vitest';
import { anchorFindings, resolvePublishPosition } from '../../src/core/anchor';
import { buildReviewContext, fileOmissionReason, includedFiles, pathOmissionReason } from '../../src/core/context';
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

  it('narrows a range whose end line is not part of the matched code', () => {
    const position = resolvePublishPosition(
      finding({ line: 2, endLine: 9, existingCode: 'const x = 1;' }), [file]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 2, endLine: 2 });
    expect(position.lines).toEqual({ start: { newLine: 2 }, end: { newLine: 2 } });
  });

  it('blocks when the content cannot be located in the current diff', () => {
    const position = resolvePublishPosition(
      finding({ line: 99, endLine: 99, existingCode: 'totallyAbsentCall()' }), [file]);
    expect(position.publishable).toBe(false);
    expect(position.reasonCode).toBe('reanchor-no-match');
    expect(position.reason).toContain('重新锚定失败：无匹配');
  });

  it('maps a renamed path onto the new path expected by GitLab', () => {
    const position = resolvePublishPosition(
      finding({ line: 2, endLine: 3, existingCode: 'const x = 1;' }), [renamedFile]);
    expect(position.corrected).toBe(true);
    expect(position.finding).toMatchObject({
      path: 'src/b.ts', oldPath: 'src/a.ts', newPath: 'src/b.ts', line: 2, endLine: 3,
    });
  });

  it('ignores whitespace drift but never a rewritten snippet', () => {
    const drifted = resolvePublishPosition(
      finding({ path: 'src/p.ts', line: 40, endLine: 40, existingCode: '   const   apiKey = "sk-live-123";  ' }),
      [secretFile]);
    expect(drifted).toMatchObject({ publishable: true, corrected: true });
    expect(drifted.finding).toMatchObject({ line: 2, endLine: 2 });

    // 大小写 / 少个分号就是另一段代码了：不再按相似度挑一行，宁可降级也不挂错位置
    const rewritten = resolvePublishPosition(
      finding({ path: 'src/p.ts', line: 40, endLine: 40, existingCode: 'const apikey="sk-live-123"' }), [secretFile]);
    expect(rewritten.publishable).toBe(false);
    expect(rewritten.reasonCode).toBe('reanchor-no-match');
  });

  it('does not pick a line from identifier tokens in the title and description', () => {
    const position = resolvePublishPosition(finding({
      path: 'src/auth.ts', line: 77, endLine: 77, existingCode: '',
      title: 'verifyToken 没有校验过期', content: '调用 verifyToken(token) 之后没有检查返回值',
    }), [authFile]);
    expect(position.publishable).toBe(false);
    expect(position.reasonCode).toBe('reanchor-no-match');
    expect(position.reason).toContain('没有可比对的代码片段');
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

  it('never falls back to nearby context when the finding carries no searchable content', () => {
    for (const line of [5, 500]) {
      const position = resolvePublishPosition(
        finding({ line, endLine: line, title: '问题', content: '说明', existingCode: '' }), [file]);
      expect(position.publishable).toBe(false);
      expect(position.reasonCode).toBe('reanchor-no-match');
      expect(position.reason).toContain('没有可比对的代码片段');
    }
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

describe('GitLab 折叠掉的文件（空 diff）', () => {
  it('空 diff 判为 collapsed，不进模型上下文但仍在省略清单里可见', () => {
    const context = buildReviewContext({
      files: [file, normalizeFileDiff({ old_path: 'apps/report/index.html', new_path: 'apps/report/index.html', diff: '' })],
    });

    expect(includedFiles(context).map((item) => item.newPath)).toEqual(['src/a.ts']);
    expect(context.omittedFiles).toContainEqual({ path: 'apps/report/index.html', reason: 'collapsed' });
  });

  it('fileOmissionReason 的判定顺序不变：binary 优先，空 diff 才轮到 collapsed', () => {
    expect(fileOmissionReason({ ...file, diff: '' })).toBe('collapsed');
    expect(fileOmissionReason({ ...file, diff: '', binary: true })).toBe('binary');
    expect(fileOmissionReason(file)).toBeUndefined();
  });

  it('GitLab 自己标了 collapsed / too_large 就直接采信，不靠空 diff 猜', () => {
    expect(fileOmissionReason({ ...file, collapsed: true })).toBe('collapsed');
    expect(fileOmissionReason({ ...file, tooLarge: true })).toBe('collapsed');
    expect(fileOmissionReason({ ...file, binary: true, tooLarge: true })).toBe('binary');
  });

  it('GitLab 标为 generated 的文件不再进上下文（原来这个标记被丢掉了）', () => {
    expect(fileOmissionReason({ ...file, generated: true })).toBe('generated');
    const context = buildReviewContext({
      files: [file, normalizeFileDiff({ old_path: 'dist/app.js', new_path: 'dist/app.js', diff: '+x', generated_file: true })],
    });

    expect(includedFiles(context).map((item) => item.newPath)).toEqual(['src/a.ts']);
    expect(context.omittedFiles).toContainEqual({ path: 'dist/app.js', reason: 'generated' });
  });

  it('完整文件读取只按路径判定，不受 collapsed 影响', () => {
    expect(pathOmissionReason('src/a.ts')).toBeUndefined();
    expect(pathOmissionReason('pnpm-lock.yaml')).toBe('lockfile');
    expect(pathOmissionReason('.env')).toBe('secret');
    expect(pathOmissionReason('dist/a.js')).toBe('generated');
    expect(pathOmissionReason('src/a.ts', true)).toBe('generated');
    expect(pathOmissionReason('/dev/null')).toBe('unsupported');
  });
});
