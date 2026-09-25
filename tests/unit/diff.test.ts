import { describe, expect, it } from 'vitest';
import { diffContext, findDiffLine, normalizeFileDiff, parseUnifiedDiff } from '../../src/core/diff';

const sample = [
  '@@ -10,4 +10,5 @@ function checkout() {',
  ' const order = createOrder();',
  '-reserve(order);',
  '+const reservation = reserve(order);',
  '+reservation.confirm();',
  ' return order;',
  ' }',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('tracks old and new line numbers across hunks', () => {
    expect(parseUnifiedDiff(sample)).toEqual([
      { hunkId: '10:10', oldLine: 10, newLine: 10, kind: 'context', text: 'const order = createOrder();' },
      { hunkId: '10:10', oldLine: 11, kind: 'removed', text: 'reserve(order);' },
      { hunkId: '10:10', newLine: 11, kind: 'added', text: 'const reservation = reserve(order);' },
      { hunkId: '10:10', newLine: 12, kind: 'added', text: 'reservation.confirm();' },
      { hunkId: '10:10', oldLine: 12, newLine: 13, kind: 'context', text: 'return order;' },
      { hunkId: '10:10', oldLine: 13, newLine: 14, kind: 'context', text: '}' },
    ]);
  });

  it('handles CRLF and no-newline markers', () => {
    const lines = parseUnifiedDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n\\ No newline at end of file');
    expect(lines.map((line) => line.text)).toEqual(['a', 'b']);
  });

  it('finds lines on both sides and trims oversized context', () => {
    const file = normalizeFileDiff({ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: sample });
    expect(findDiffLine([file], 'src/a.ts', 'old', 11)?.text).toBe('reserve(order);');
    expect(findDiffLine([file], 'src/a.ts', 'new', 12)?.text).toBe('reservation.confirm();');
    expect(diffContext([file], 5)).toContain('context budget exceeded');
  });
});
