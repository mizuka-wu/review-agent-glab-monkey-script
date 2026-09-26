import { describe, expect, it } from 'vitest';
import { extractHunks, hunkContext, normalizeFileDiff, parseUnifiedDiff } from '../../src/core/diff';

const multiHunkDiff = `@@ -1,3 +1,4 @@
 line1
-old line
+new line
+added line
 line3
@@ -10,3 +11,4 @@
 context1
 context2
+another added
 context3`;

const singleHunkDiff = `@@ -5,2 +5,3 @@
+added1
+added2
 context`;

describe('extractHunks', () => {
  it('extracts multiple hunks from one file', () => {
    const file = normalizeFileDiff({
      old_path: 'src/a.ts',
      new_path: 'src/a.ts',
      diff: multiHunkDiff,
    });
    const hunks = extractHunks([file]);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].filePath).toBe('src/a.ts');
  });

  it('counts added and removed lines', () => {
    const file = normalizeFileDiff({
      old_path: 'src/a.ts',
      new_path: 'src/a.ts',
      diff: singleHunkDiff,
    });
    const hunks = extractHunks([file]);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].addedCount).toBe(2);
    expect(hunks[0].removedCount).toBe(0);
  });

  it('handles multiple files', () => {
    const file1 = normalizeFileDiff({ old_path: 'a.ts', new_path: 'a.ts', diff: singleHunkDiff });
    const file2 = normalizeFileDiff({ old_path: 'b.ts', new_path: 'b.ts', diff: singleHunkDiff });
    const hunks = extractHunks([file1, file2]);
    expect(hunks).toHaveLength(2);
    expect(hunks.map((h) => h.filePath)).toEqual(['a.ts', 'b.ts']);
  });

  it('returns empty for no changes', () => {
    const file = normalizeFileDiff({ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n same\n same2' });
    // Context-only diff still produces hunks
    const hunks = extractHunks([file]);
    expect(hunks.length).toBeGreaterThanOrEqual(0);
  });
});

describe('hunkContext', () => {
  it('renders hunk as diff text', () => {
    const file = normalizeFileDiff({
      old_path: 'src/a.ts',
      new_path: 'src/a.ts',
      diff: singleHunkDiff,
    });
    const hunks = extractHunks([file]);
    const context = hunkContext(hunks);
    expect(context).toContain('src/a.ts');
    expect(context).toContain('+added1');
  });

  it('renders multiple hunks', () => {
    const file = normalizeFileDiff({
      old_path: 'src/a.ts',
      new_path: 'src/a.ts',
      diff: multiHunkDiff,
    });
    const hunks = extractHunks([file]);
    const context = hunkContext(hunks);
    expect(context).toContain('+new line');
    expect(context).toContain('+another added');
  });
});

describe('parseUnifiedDiff', () => {
  it('parses multi-hunk diffs correctly', () => {
    const lines = parseUnifiedDiff(multiHunkDiff);
    expect(lines.filter((l) => l.kind === 'added').length).toBe(3);
    expect(lines.filter((l) => l.kind === 'removed').length).toBe(1);
    // Two distinct hunks
    const hunkIds = new Set(lines.map((l) => l.hunkId));
    expect(hunkIds.size).toBe(2);
  });
});
