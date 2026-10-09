import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ancestorLineNumber, attrLineNumber, cellLineNumber, idLineNumber, plainLineNumber, rowLineNumber, sideOfNode,
} from '../../src/core/dom-line-number';
import { highlightFindingOnPage } from '../../src/core/finding-highlight';
import { captureCodeSelection, selectionLabel } from '../../src/core/selection';

/** 老版 GitLab（用户实测 DOM）：行号既不在格子也不在行的属性上，而在代码格里 span 的 id 上。 */
const lcSpanDiff = `
<div class="diff-file" data-file-path="src/foo.ts">
  <div data-testid="left-content" class="diff-td line_content left-side new">
    <span id="LC11" class="line">export function foo() {}</span>
  </div>
</div>`;

/**
 * GitLab 19.x 的 grid diff（真实 DOM 抄样）：行是 div.line_holder，一侧的行号格有两格
 * （第一格只挂评论按钮，行号 a 在第二格），代码格是 div[data-testid="left-content"]，
 * 父层 side wrapper 上还挂着 data-interop-line / data-interop-type。
 */
const gridDiff = `
<div class="diff-file file-holder has-body is-virtual-scrolling" id="52007ba0" data-path="packages/y-mxgraph/src/models/diagram.ts" active="true">
  <div data-testid="file-title-container" class="js-file-title file-title">
    <div class="file-header-content"><a class="file-title-name" href="#">packages/y-mxgraph/src/models/diagram.ts</a></div>
  </div>
  <div class="diff-viewer"><div class="diff-grid diff-table code">
    <div class="diff-grid-row diff-tr line_holder">
      <div id="52007ba0_14_14" data-testid="left-side" data-interop-type="new" data-interop-line="14" data-interop-new-line="14" data-interop-old-line="14" class="diff-grid-left left-side">
        <div data-testid="left-line-number" class="diff-td diff-line-num null"><span class="add-diff-note tooltip-wrapper has-tooltip"><div data-testid="left-comment-button" role="button"></div></span> <a data-linenumber="14" href="#52007ba0_14_14" aria-label="14"></a></div>
        <div class="diff-td diff-line-num null"><a data-linenumber="14" href="#52007ba0_14_14" aria-label="14"></a></div>
        <div class="diff-td line-coverage left-side has-tooltip"></div>
        <div data-testid="left-content" class="diff-td line_content with-coverage left-side"><span class="line" data-lang="typescript">export interface Diagram extends ElementCompact {</span></div>
      </div>
    </div>
    <div class="diff-grid-row diff-tr line_holder">
      <div id="52007ba0_16_16" data-testid="left-side" data-interop-type="new" data-interop-line="16" data-interop-new-line="16" class="diff-grid-left left-side">
        <div data-testid="left-line-number" class="diff-td diff-line-num new new_line"><span class="add-diff-note tooltip-wrapper has-tooltip"><div data-testid="left-comment-button" role="button"></div></span></div>
        <div class="diff-td diff-line-num new new_line"><a data-linenumber="16" href="#52007ba0_16_16" aria-label="16"></a></div>
        <div class="diff-td line-coverage left-side has-tooltip new"></div>
        <div data-testid="left-content" class="diff-td line_content with-coverage left-side new"><span class="line" data-lang="typescript">  customProperties?: Map&lt;string, string&gt;;</span></div>
      </div>
    </div>
    <div class="diff-grid-row diff-tr line_holder">
      <div id="52007ba0_16_17" data-testid="left-side" data-interop-type="new" data-interop-line="17" data-interop-new-line="17" data-interop-old-line="16" class="diff-grid-left left-side">
        <div data-testid="left-line-number" class="diff-td diff-line-num null"><span class="add-diff-note tooltip-wrapper has-tooltip"><div data-testid="left-comment-button" role="button"></div></span> <a data-linenumber="16" href="#52007ba0_16_17" aria-label="16"></a></div>
        <div class="diff-td diff-line-num null"><a data-linenumber="17" href="#52007ba0_16_17" aria-label="17"></a></div>
        <div class="diff-td line-coverage left-side has-tooltip"></div>
        <div data-testid="left-content" class="diff-td line_content with-coverage left-side"><span class="line" data-lang="typescript">}</span></div>
      </div>
    </div>
    <div class="diff-grid-row diff-tr line_holder">
      <div id="52007ba0_33_48" data-testid="left-side" data-interop-type="old" data-interop-line="33" data-interop-old-line="33" class="diff-grid-left left-side">
        <div data-testid="left-line-number" class="diff-td diff-line-num old old_line"><span class="add-diff-note tooltip-wrapper has-tooltip"><div data-testid="left-comment-button" role="button"></div></span> <a data-linenumber="33" href="#52007ba0_33_48" aria-label="33"></a></div>
        <div class="diff-td diff-line-num old old_line"></div>
        <div class="diff-td line-coverage left-side has-tooltip old"></div>
        <div data-testid="left-content" class="diff-td line_content with-coverage left-side old"><span class="line" data-lang="typescript">      name: yDiagram.get("name") as string,</span></div>
      </div>
    </div>
  </div></div>
</div>`;

/** side-by-side：行容器上的 data-line-number 是新侧行号，不能套到旧侧。 */
const parallelDiff = `
<div class="diff-file" data-file-path="src/checkout.ts">
  <table class="diff-table"><tbody>
    <tr class="line_holder" data-line-number="21">
      <td class="diff-td old_line">20</td>
      <td class="line_content old">-  const fee = 0.1;</td>
      <td class="diff-td new_line">21</td>
      <td class="line_content new">+  const fee = 0.2;</td>
    </tr>
  </tbody></table>
</div>`;

const GRID_PATH = 'packages/y-mxgraph/src/models/diagram.ts';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Range.prototype.getBoundingClientRect = () => ({
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
});

beforeEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string) {
  document.body.innerHTML = html;
}

function gridRow(line: string) {
  return document.getElementById(`52007ba0_${line}`)!.closest<HTMLElement>('.line_holder')!;
}

function gridCell(line: string) {
  return document.getElementById(`52007ba0_${line}`)!.querySelector<HTMLElement>('[data-testid="left-content"]')!;
}

function selectContents(node: Element) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('代码格里的 span#LC 行号 id', () => {
  it('向下查子节点读到 LC11，不再报行号未知', () => {
    mount(lcSpanDiff);
    const cell = document.querySelector<HTMLElement>('[data-testid="left-content"]')!;

    expect(cellLineNumber(cell, 'new')).toBe(11);
    expect(sideOfNode(cell)).toBe('new');
  });

  it('L11 这种单号 id 同样能读', () => {
    mount('<div class="diff-file" data-file-path="src/foo.ts"><div class="line_content new"><span id="L11" class="line">foo();</span></div></div>');

    expect(cellLineNumber(document.querySelector('.line_content'), 'new')).toBe(11);
  });

  it('代码格里的数字文本仍然不是行号', () => {
    mount('<div class="diff-file" data-file-path="src/foo.ts"><div class="line_content new"><span class="line">42</span></div></div>');

    expect(cellLineNumber(document.querySelector('.line_content'), 'new')).toBeUndefined();
  });
});

describe('GitLab 19.x grid diff 的行号', () => {
  it('上下文行读到行号格第二格里的 a[data-linenumber]', () => {
    mount(gridDiff);

    expect(rowLineNumber(gridRow('14_14'), 'new')).toBe(14);
    expect(rowLineNumber(gridRow('14_14'), 'old')).toBe(14);
  });

  it('新增行第一格只有评论按钮时继续读第二格', () => {
    mount(gridDiff);

    expect(rowLineNumber(gridRow('16_16'), 'new')).toBe(16);
    expect(rowLineNumber(gridRow('16_16'), 'old')).toBeUndefined();
  });

  it('上下文行两格行号不同时按 data-interop 分侧，不拿旧号当新号', () => {
    mount(gridDiff);

    expect(rowLineNumber(gridRow('16_17'), 'new')).toBe(17);
    expect(rowLineNumber(gridRow('16_17'), 'old')).toBe(16);
    expect(cellLineNumber(gridCell('16_17'), 'new', gridRow('16_17'))).toBe(17);
  });

  it('删除行按 old 侧读，不拿行 id 里的新侧位置冒充新侧行号', () => {
    mount(gridDiff);

    expect(rowLineNumber(gridRow('33_48'), 'old')).toBe(33);
    expect(rowLineNumber(gridRow('33_48'), 'new')).toBeUndefined();
  });

  it('代码格与行容器读出同一个数', () => {
    mount(gridDiff);

    for (const [line, side] of [['14_14', 'new'], ['16_16', 'new'], ['16_17', 'new'], ['33_48', 'old']] as const) {
      expect(cellLineNumber(gridCell(line), side, gridRow(line))).toBe(rowLineNumber(gridRow(line), side));
    }
  });

  it('行号格全空时回落到父层的 data-interop-line', () => {
    mount(gridDiff);
    const row = gridRow('16_16');
    row.querySelectorAll('[data-linenumber]').forEach((node) => node.remove());

    expect(rowLineNumber(row, 'new')).toBe(16);
    expect(cellLineNumber(gridCell('16_16'), 'new', row)).toBe(16);
  });
});

describe('side-by-side 的侧别隔离', () => {
  it('两侧各读自己的行号格', () => {
    mount(parallelDiff);
    const row = document.querySelector<HTMLElement>('tr')!;

    expect(rowLineNumber(row, 'old')).toBe(20);
    expect(rowLineNumber(row, 'new')).toBe(21);
  });

  it('父层的无侧别 data-line-number 不套到旧侧', () => {
    mount(parallelDiff);
    const cell = document.querySelector<HTMLElement>('.line_content.old')!;
    const row = document.querySelector<HTMLElement>('tr')!;

    expect(ancestorLineNumber(cell, 'old', row)).toBeUndefined();
    expect(cellLineNumber(cell, 'old', row)).toBeUndefined();
    // 行容器上那个无侧别属性按 GitLab 的约定是新侧行号，只在行级读取时生效
    expect(rowLineNumber(row, 'new')).toBe(21);
  });
});

describe('行号读法的基础件', () => {
  it('只认整格是数字的文本', () => {
    expect(plainLineNumber('42')).toBe(42);
    expect(plainLineNumber(' 42 ')).toBe(42);
    expect(plainLineNumber('const a = 42;')).toBeUndefined();
    expect(plainLineNumber('0')).toBeUndefined();
    expect(plainLineNumber(null)).toBeUndefined();
  });

  it('行 id 的单号与双号两种编码', () => {
    const node = (id: string) => {
      const div = document.createElement('div');
      div.id = id;
      return div;
    };

    expect(idLineNumber(node('LC11'), 'new')).toBe(11);
    expect(idLineNumber(node('L7'), 'unified')).toBe(7);
    expect(idLineNumber(node('sha_10_'), 'old')).toBe(10);
    expect(idLineNumber(node('sha_10_'), 'new')).toBeUndefined();
    expect(idLineNumber(node('sha__11'), 'new')).toBe(11);
    expect(idLineNumber(node('52007ba039cb50ce_33_48'), 'old')).toBe(33);
    expect(idLineNumber(node('52007ba039cb50ce_33_48'), 'new')).toBe(48);
    expect(idLineNumber(node('diff-file'), 'new')).toBeUndefined();
  });

  it('属性拼写新旧都认，data-interop-line 只在侧别吻合时可用', () => {
    const node = (attrs: Record<string, string>) => {
      const div = document.createElement('div');
      for (const [name, value] of Object.entries(attrs)) div.setAttribute(name, value);
      return div;
    };

    expect(attrLineNumber(node({ 'data-linenumber': '9' }), 'new')).toBe(9);
    expect(attrLineNumber(node({ 'data-line-number': '9' }), 'old')).toBe(9);
    expect(attrLineNumber(node({ 'data-line': '9' }), 'new')).toBe(9);
    expect(attrLineNumber(node({ 'data-new-line-number': '21' }), 'new')).toBe(21);
    expect(attrLineNumber(node({ 'data-new-line-number': '21' }), 'old')).toBeUndefined();
    expect(attrLineNumber(node({ 'data-interop-type': 'new', 'data-interop-line': '16' }), 'new')).toBe(16);
    expect(attrLineNumber(node({ 'data-interop-type': 'old', 'data-interop-line': '33' }), 'new')).toBeUndefined();
    expect(attrLineNumber(node({ 'data-interop-old-line': '33' }), 'old')).toBe(33);
  });

  it('侧别标记认 old/new 类名、data-side 与 data-interop-type', () => {
    const node = (html: string) => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      return wrapper.firstElementChild!;
    };

    expect(sideOfNode(node('<div class="old_line"></div>'))).toBe('old');
    expect(sideOfNode(node('<div class="line_content new"></div>'))).toBe('new');
    expect(sideOfNode(node('<div data-side="old"></div>'))).toBe('old');
    expect(sideOfNode(node('<div data-interop-type="new"></div>'))).toBe('new');
    expect(sideOfNode(node('<div class="line_content"></div>'))).toBeUndefined();
  });
});

describe('划词与定位共用同一套行号读法', () => {
  it('同一行：划词读到的行号就是定位高亮的那一行', async () => {
    mount(gridDiff);
    selectContents(gridCell('16_16').querySelector('.line')!);

    const captured = captureCodeSelection(document)!;
    expect(captured).toMatchObject({ filePath: GRID_PATH, side: 'new', startLine: 16, endLine: 16 });
    expect(selectionLabel(captured)).toBe('diagram.ts:16');

    const outcome = await highlightFindingOnPage({
      path: GRID_PATH, line: 16, endLine: 16, side: 'new',
      severity: 'medium', title: '自定义属性没有校验', existingCode: 'customProperties?: Map<string, string>;',
    });

    expect(outcome.failure).toBeUndefined();
    expect(outcome.highlighted).toEqual([gridRow('16_16')]);
  });

  it('删除行两边都按 old 侧读数', async () => {
    mount(gridDiff);
    selectContents(gridCell('33_48').querySelector('.line')!);

    const captured = captureCodeSelection(document)!;
    expect(captured).toMatchObject({ side: 'old', startLine: 33 });
    expect(selectionLabel(captured)).toBe('diagram.ts:33（旧侧）');

    const outcome = await highlightFindingOnPage({
      path: GRID_PATH, line: 33, endLine: 33, side: 'old',
      severity: 'low', title: '删除的字段仍在别处引用', existingCode: 'name: yDiagram.get("name") as string,',
    });

    expect(outcome.highlighted).toEqual([gridRow('33_48')]);
  });
});
