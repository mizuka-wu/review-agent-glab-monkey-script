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

describe('diff 末尾换行', () => {
  it('不把末尾换行切出来的空串当成 diff 行（否则凭空多一行，发 position 必被 400 拒）', () => {
    const file = normalizeFileDiff({ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -0,0 +1,2 @@\n+one\n+two\n' });

    expect(file.lines).toHaveLength(2);
    expect(file.lines.map((line) => line.newLine)).toEqual([1, 2]);
  });

  it('中间的空上下文行仍按 context 处理', () => {
    const lines = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n c\n');

    expect(lines.map((line) => [line.kind, line.text, line.newLine])).toEqual([
      ['context', 'a', 1],
      ['context', '', 2],
      ['context', 'c', 3],
    ]);
  });

  it('最后一个 hunk 的行号不会被幻影行推着走', () => {
    const file = normalizeFileDiff({
      old_path: 'src/a.ts', new_path: 'src/a.ts',
      diff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n',
    });

    expect(file.lines.at(-1)).toMatchObject({ kind: 'context', text: 'three', oldLine: 3, newLine: 3 });
  });
});

describe('normalizeFileDiff 带出 GitLab 自己的标记', () => {
  it('generated_file / collapsed / too_large 都落到 FileDiff 上', () => {
    const file = normalizeFileDiff({
      old_path: 'apps/report/index.html', new_path: 'apps/report/index.html', diff: '',
      generated_file: null, collapsed: false, too_large: true,
    });

    expect(file.tooLarge).toBe(true);
    expect(file.collapsed).toBe(false);
    expect(file.generated).toBe(false);
    expect(file.lines).toEqual([]);
  });

  it('缺字段与 null 一律落成 false，不留 undefined 语义', () => {
    const file = normalizeFileDiff({ old_path: 'a.ts', new_path: 'a.ts', diff: '+x' });

    expect(file).toMatchObject({ generated: false, collapsed: false, tooLarge: false });
  });
});
