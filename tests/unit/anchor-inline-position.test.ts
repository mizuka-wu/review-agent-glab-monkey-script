import { describe, expect, it } from 'vitest';
import { anchorFindings, resolvePublishPosition } from '../../src/core/anchor';
import { debugBus } from '../../src/core/debug-bus';
import { normalizeFileDiff, repoPathCandidates, repoPathEquals } from '../../src/core/diff';
import { normalizeFindings } from '../../src/core/findings';
import type { Finding } from '../../src/core/types';

const finding = (input: Partial<Finding> = {}): Finding => ({
  id: 'id', fingerprint: 'fp', path: 'src/payment.ts', line: 0, endLine: 0, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
  evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment', source: 'model', status: 'draft',
  ...input,
});

const payment = normalizeFileDiff({
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  diff: '@@ -8,3 +8,5 @@\n function pay() {\n+  const apiKey = "sk-live-1";\n+  return charge(apiKey);\n }',
});

const spaced = normalizeFileDiff({
  old_path: 'src/my file.ts', new_path: 'src/my file.ts',
  diff: '@@ -1,1 +1,2 @@\n header\n+added();',
});

const renamed = normalizeFileDiff({
  old_path: 'src/old.ts', new_path: 'src/new.ts', renamed_file: true,
  diff: '@@ -1,1 +1,2 @@\n base\n+moved();',
});

const removed = normalizeFileDiff({
  old_path: 'src/r.ts', new_path: 'src/r.ts',
  diff: '@@ -30,2 +29,1 @@\n-  const fee = 0.1;\n   kept',
});

const tabs = normalizeFileDiff({
  old_path: 'src/t.go', new_path: 'src/t.go',
  diff: '@@ -1,1 +1,4 @@\n package main\n+\tif  err != nil {\n+\t\treturn err\n+\t}',
});

describe('repo path matching', () => {
  it('offers both the raw and the diff-prefix-stripped spelling', () => {
    expect(repoPathCandidates('b/src/a.ts')).toEqual(['b/src/a.ts', 'src/a.ts']);
    expect(repoPathCandidates('./src//a.ts')).toEqual(['src/a.ts']);
    expect(repoPathCandidates('src/my%20file.ts')).toEqual(['src/my file.ts']);
    expect(repoPathCandidates('src\\a.ts')).toEqual(['src/a.ts']);
  });

  it('treats prefix, encoding and case variants as the same file', () => {
    expect(repoPathEquals('a/src/Pay.ts', 'src/pay.ts')).toBe(true);
    expect(repoPathEquals('src/my%20file.ts', 'src/my file.ts')).toBe(true);
    expect(repoPathEquals('src/a.ts', 'src/b.ts')).toBe(false);
  });
});

describe('inline position: path matching', () => {
  it('resolves a path carrying the diff prefix', () => {
    const position = resolvePublishPosition(finding({ path: 'b/src/payment.ts', line: 9, endLine: 9 }), [payment]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/payment.ts', line: 9, endLine: 9 });
  });

  it('resolves a percent-encoded path', () => {
    const position = resolvePublishPosition(
      finding({ path: 'src/my%20file.ts', line: 2, endLine: 2 }), [spaced]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/my file.ts', line: 2 });
  });

  it('maps a finding that only knows the pre-rename path', () => {
    const position = resolvePublishPosition(finding({ path: 'src/old.ts', line: 2, endLine: 2 }), [renamed]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/new.ts', oldPath: 'src/old.ts', line: 2 });
  });

  it('maps a finding that only knows the post-rename path', () => {
    const position = resolvePublishPosition(
      finding({ path: 'src/new.ts', oldPath: 'src/old.ts', line: 2, endLine: 2 }), [renamed]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/new.ts', line: 2 });
  });

  it('resolves a path the model reported relative to a subdirectory', () => {
    const position = resolvePublishPosition(finding({ path: 'payment.ts', line: 10, endLine: 10 }), [payment]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/payment.ts', line: 10 });
  });

  it('resolves a path whose case drifted', () => {
    const position = resolvePublishPosition(finding({ path: 'src/PAYMENT.ts', line: 11, endLine: 11 }), [payment]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/payment.ts', line: 11 });
  });
});

describe('inline position: model output normalization', () => {
  it('resolves the diff file behind a prefixed path so the side is not guessed', () => {
    const [normalized] = normalizeFindings([{
      path: 'b/src/payment.ts', line: 9, side: 'new', title: 'T', content: 'C',
      existingCode: 'const apiKey = "sk-live-1";',
    }], [payment]);
    expect(normalized).toMatchObject({
      newPath: 'src/payment.ts', oldPath: 'src/payment.ts', side: 'new', line: 9,
    });
  });

  it('anchors a prefixed path onto the diff instead of dropping the finding', () => {
    const [anchored] = anchorFindings(
      [finding({ path: 'a/src/payment.ts', existingCode: 'const apiKey = "sk-live-1";' })], [payment]);
    expect(anchored).toMatchObject({
      path: 'src/payment.ts', line: 9, endLine: 9, side: 'new',
      anchor: { source: 'diff', publishable: true },
    });
  });
});

describe('inline position: line number semantics', () => {
  it('publishes on an unchanged context line inside the hunk', () => {
    const position = resolvePublishPosition(finding({ line: 8, endLine: 8 }), [payment]);
    expect(position.publishable).toBe(true);
    expect(position.corrected).toBeUndefined();
    expect(position.finding).toMatchObject({ line: 8, endLine: 8, side: 'new' });
  });

  it('flips to the old side when the code only exists there', () => {
    const position = resolvePublishPosition(finding({
      path: 'src/r.ts', line: 30, endLine: 30, side: 'new', existingCode: 'const fee = 0.1;',
    }), [removed]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 30, endLine: 30, side: 'old' });
  });

  it('does not move a comment onto the other side when the content disagrees', () => {
    const position = resolvePublishPosition(finding({
      id: 'wrong-side', path: 'src/r.ts', line: 30, endLine: 30, side: 'new', existingCode: 'unrelatedCall();',
    }), [removed]);
    expect(position.publishable).toBe(false);
    expect(position.reasonCode).toBe('line-not-in-diff');
  });

  it('matches code whose indentation drifted from tabs to spaces', () => {
    const position = resolvePublishPosition(finding({
      path: 'src/t.go', line: 0, endLine: 0,
      existingCode: 'if err != nil {\n  return err\n}',
    }), [tabs]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/t.go', line: 2, endLine: 4, side: 'new' });
  });
});

describe('inline position: snippet spelling variants', () => {
  it('strips the diff markers the model copied along with the code', () => {
    const position = resolvePublishPosition(finding({
      line: 0, endLine: 0,
      existingCode: '+  const apiKey = "sk-live-1";\n+  return charge(apiKey);',
    }), [payment]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 9, endLine: 10 });
  });

  it('strips the line-number prefixes copied from full-file context', () => {
    const position = resolvePublishPosition(finding({
      line: 0, endLine: 0,
      existingCode: '9: const apiKey = "sk-live-1";\n10: return charge(apiKey);',
    }), [payment]);
    expect(position).toMatchObject({ publishable: true, corrected: true });
    expect(position.finding).toMatchObject({ line: 9, endLine: 10 });
  });
});

describe('inline position: full-file anchors', () => {
  it('converts a full-file line into the diff line when the content agrees', () => {
    const position = resolvePublishPosition(finding({
      line: 9, endLine: 9, existingCode: 'const apiKey = "sk-live-1";',
      anchor: { source: 'full-file', publishable: false },
    }), [payment]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ line: 9, endLine: 9, side: 'new' });
  });

  it('keeps a full-file finding downgraded when the diff line says something else', () => {
    const position = resolvePublishPosition(finding({
      id: 'full-file-conflict', line: 9, endLine: 9, existingCode: 'totallyDifferentCode();',
      anchor: { source: 'full-file', publishable: false },
    }), [payment]);
    expect(position.publishable).toBe(false);
    expect(position.reasonCode).toBe('full-file-only');
  });
});

describe('inline position: downgrade reporting', () => {
  it('names the reason code and writes it to the debug bus', () => {
    const position = resolvePublishPosition(
      finding({ id: 'downgrade-log', path: 'src/ghost.ts', line: 3, endLine: 3, existingCode: 'nope()' }), [payment]);
    expect(position.publishable).toBe(false);
    expect(position.reasonCode).toBe('path-not-in-diff');

    const entry = debugBus.getLogs().at(-1);
    expect(entry).toMatchObject({ level: 'warn', source: 'anchor' });
    expect(entry?.message).toContain('行内评论降级为全文');
    expect(entry?.detail).toContain('code=path-not-in-diff');
    expect(entry?.detail).toContain('path=src/ghost.ts');
  });

  it('logs one finding only once while the review keeps recomputing', () => {
    const blocked = finding({ id: 'downgrade-once', path: 'src/ghost.ts', line: 4, endLine: 4, existingCode: 'nope()' });
    resolvePublishPosition(blocked, [payment]);
    const afterFirst = debugBus.getLogs().length;
    resolvePublishPosition(blocked, [payment]);
    expect(debugBus.getLogs()).toHaveLength(afterFirst);
  });

  it('reports an unloaded diff separately from a missing file', () => {
    expect(resolvePublishPosition(finding({ id: 'no-diff', line: 2, endLine: 2 }), []).reasonCode).toBe('no-diff');
    expect(resolvePublishPosition(finding({ id: 'no-line', line: 500, endLine: 500 }), [payment]).reasonCode)
      .toBe('line-not-in-diff');
  });
});

describe('inline position: multi-line snippets', () => {
  const gap = normalizeFileDiff({
    old_path: 'src/g.ts', new_path: 'src/g.ts',
    diff: '@@ -1,1 +1,5 @@\n top\n+function pay() {\n+\n+  return 1;\n+}',
  });

  it('keeps interior blank lines so the match stays contiguous', () => {
    const position = resolvePublishPosition(finding({
      path: 'src/g.ts', line: 0, endLine: 0,
      existingCode: 'function pay() {\n\n  return 1;\n}',
    }), [gap]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/g.ts', line: 2, endLine: 5 });
  });

  it('still matches when the model dropped the blank line', () => {
    const position = resolvePublishPosition(finding({
      id: 'dense', path: 'src/g.ts', line: 0, endLine: 0,
      existingCode: '\nreturn 1;\n}\n',
    }), [gap]);
    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ path: 'src/g.ts', line: 4, endLine: 5 });
  });
});
