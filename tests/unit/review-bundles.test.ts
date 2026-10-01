import { describe, expect, it } from 'vitest';
import { normalizeFileDiff } from '../../src/core/diff';
import { groupFilesIntoBundles, mapWithConcurrency } from '../../src/core/review-bundles';
import type { FileDiff } from '../../src/core/types';

function file(path: string, lines = 2): FileDiff {
  return normalizeFileDiff({
    old_path: path,
    new_path: path,
    diff: `@@ -1 +1,${lines} @@\n-old\n${Array.from({ length: lines }, (_, i) => `+const v${i} = ${i};`).join('\n')}`,
  });
}

describe('groupFilesIntoBundles', () => {
  it('keeps small changesets in a single bundle', () => {
    const files = [file('src/a.ts'), file('src/b.ts')];
    expect(groupFilesIntoBundles(files)).toEqual([files]);
  });

  it('splits by directory and file budget', () => {
    const files = [
      ...Array.from({ length: 5 }, (_, i) => file(`src/a/f${i}.ts`)),
      ...Array.from({ length: 5 }, (_, i) => file(`src/b/f${i}.ts`)),
    ];
    const bundles = groupFilesIntoBundles(files, { maxFiles: 4 });
    expect(bundles.length).toBeGreaterThanOrEqual(3);
    for (const bundle of bundles) expect(bundle.length).toBeLessThanOrEqual(4);
    expect(bundles.flat().map((f) => f.newPath).sort()).toEqual(files.map((f) => f.newPath).sort());
  });

  it('gives an oversized file its own bundle', () => {
    const huge = file('src/huge.ts', 4000);
    const bundles = groupFilesIntoBundles([file('src/a.ts'), huge], { maxChars: 500 });
    expect(bundles.some((bundle) => bundle.length === 1 && bundle[0].newPath === 'src/huge.ts')).toBe(true);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
