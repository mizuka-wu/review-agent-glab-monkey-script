import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { selectionFile } from '../../src/core/context';
import {
  captureCodeSelection,
  isCodeSelection,
  selectionAlive,
  selectionLabel,
  selectionLines,
  selectionQuote,
  selectionRef,
  watchSelection,
} from '../../src/core/selection';
import type { CodeSelection } from '../../src/core/types';

/** 经典 GitLab（HAML 渲染）inline diff：行号在 old_line / new_line 两个格子里。 */
const classicInline = `
<div class="diff-file file-holder" data-file-path="src/payment.ts">
  <div class="file-header-content"><strong class="file-title-name">src/payment.ts</strong></div>
  <div class="diff-content table-holder">
    <table class="diff-table"><tbody>
      <tr class="line_holder match" id="sha_9_9">
        <td class="old_line"><a class="diff-line-num" data-line-number="9" href="#sha_9_9">9</a></td>
        <td class="new_line"><a class="diff-line-num" data-line-number="9" href="#sha_9_9">9</a></td>
        <td class="line_content match noteable">  const total = 1;</td>
      </tr>
      <tr class="line_holder old" id="sha_10_">
        <td class="old_line"><a class="diff-line-num" data-line-number="10" href="#sha_10_">10</a></td>
        <td class="new_line"></td>
        <td class="line_content old noteable">-  const fee = 0.1;</td>
      </tr>
      <tr class="line_holder new" id="sha__11">
        <td class="old_line"></td>
        <td class="new_line"><a class="diff-line-num" data-line-number="11" href="#sha__11">11</a></td>
        <td class="line_content new noteable">+  const fee = 0.2;</td>
      </tr>
      <tr class="line_holder new" id="sha__12">
        <td class="old_line"></td>
        <td class="new_line"><a class="diff-line-num" data-line-number="12" href="#sha__12">12</a></td>
        <td class="line_content new noteable">+  return total + fee;</td>
      </tr>
    </tbody></table>
  </div>
</div>`;

/** 经典 side-by-side：一个 tr 里同时有 old/new 两侧，tr 上的 data-line-number 是新侧行号。 */
const classicParallel = `
<div class="diff-file file-holder" data-file-path="src/checkout.ts">
  <div class="file-title-content"><a class="file-title-name" href="#">src/checkout.ts</a></div>
  <div class="diff-content">
    <table class="diff-table"><tbody>
      <tr class="line_holder" data-line-number="21">
        <td class="diff-td old_line">20</td>
        <td class="line_content old">-  const fee = 0.1;</td>
        <td class="diff-td new_line">21</td>
        <td class="line_content new">+  const fee = 0.2;</td>
      </tr>
    </tbody></table>
  </div>
</div>`;

/** 新版 Vue diff：tr[data-line] + td.diff-line-numbers[data-side] + a#L{n}，文件是 rename。 */
const vueDiff = `
<div class="diff-file file-holder" data-file-path="src/api/user.ts">
  <div class="file-header"><div class="file-title-content">
    <span class="file-title-name">
      <a href="/p/-/blob/sha/src/api/old-user.ts">src/api/old-user.ts</a> → <a href="/p/-/blob/sha/src/api/user.ts">src/api/user.ts</a>
    </span>
  </div></div>
  <table class="diff-table"><tbody>
    <tr class="line_holder diff-line" data-line="20">
      <td class="diff-line-numbers old" data-side="old"><a id="L19" data-line-number="19" href="#L19">19</a></td>
      <td class="diff-line-numbers new" data-side="new"><a id="L20" data-line-number="20" href="#L20">20</a></td>
      <td class="line_content new">  return user;</td>
    </tr>
    <tr class="line_holder diff-line" data-line="21">
      <td class="diff-line-numbers old" data-side="old"><a id="L20" data-line-number="20" href="#L20">20</a></td>
      <td class="diff-line-numbers new" data-side="new"><a id="L21" data-line-number="21" href="#L21">21</a></td>
      <td class="line_content old">-  return legacyUser;</td>
    </tr>
  </tbody></table>
</div>`;

/** rename 标题但没有 data-file-path：只能从「旧路径 → 新路径」里取新路径。 */
const renamedTitleOnly = `
<div class="file-holder">
  <div class="file-header-content"><strong class="file-title-name">src/api/old-user.ts → src/api/user.ts</strong></div>
  <table class="diff-table"><tbody>
    <tr class="line_holder new">
      <td class="old_line"></td>
      <td class="new_line">5</td>
      <td class="line_content new">+  export const user = 1;</td>
    </tr>
  </tbody></table>
</div>`;

/** DOM 里完全没有行号信息（老版本 / 非标准结构）。 */
const withoutLineInfo = `
<div class="diff-file" data-file-path="src/legacy.ts">
  <div class="file-title-name">src/legacy.ts</div>
  <div class="line_holder"><code>const token = "abc";</code></div>
</div>`;

/** 起点行有行号、终点行没有：跨行选择靠覆盖行数推算。 */
const partialLineInfo = `
<div class="diff-file" data-file-path="src/partial.ts">
  <div class="line_holder new" data-line-number="4"><code>const a = 1;</code></div>
  <div class="line_holder new"><code>const b = 2;</code></div>
</div>`;

/** blob 文件视图：没有 diff 侧别，行号在 .line_numbers 的 a#L{n} 上。 */
const blobView = `
<div class="file-holder blob-viewer" data-path="src/blob.ts">
  <div class="blob-content-holder"><div class="blob-content">
    <table class="text-file"><tbody>
      <tr id="LC7" class="line_holder">
        <td class="line_numbers"><a class="diff-line-num" id="L7" data-line-number="7" href="#L7">7</a></td>
        <td class="line_content">export const total = 42;</td>
      </tr>
    </tbody></table>
  </div></div>
</div>`;

/**
 * 新版 GitLab（实测 DOM）：行号属性写作 data-linenumber，整页没有 data-line-number；
 * 行号格里还挂着「+」评论按钮，格内文本不是纯数字，文本兜底读不出来，只能靠属性。
 */
const linenumberInline = `
<div class="diff-file file-holder" data-file-path="src/payment.ts">
  <div class="file-header-content"><span class="file-title-name">src/payment.ts</span></div>
  <div class="diff-content table-holder">
    <table class="diff-table inline"><tbody>
      <tr class="line_holder diff-line" id="sha_9_9">
        <td class="diff-td old_line diff-line-numbers" data-side="old"><a class="diff-line-num" data-linenumber="9" href="#sha_9_9">9</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="diff-td new_line diff-line-numbers" data-side="new"><a class="diff-line-num" data-linenumber="9" href="#sha_9_9">9</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="line_content match">  const total = 1;</td>
      </tr>
      <tr class="line_holder diff-line old" id="sha_10_">
        <td class="diff-td old_line diff-line-numbers" data-side="old"><a class="diff-line-num" data-linenumber="10" href="#sha_10_">10</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="diff-td new_line diff-line-numbers" data-side="new"></td>
        <td class="line_content old">-  const fee = 0.1;</td>
      </tr>
      <tr class="line_holder diff-line new" id="sha__11">
        <td class="diff-td old_line diff-line-numbers" data-side="old"></td>
        <td class="diff-td new_line diff-line-numbers" data-side="new"><a class="diff-line-num" data-linenumber="11" href="#sha__11">11</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="line_content new">+  const fee = 0.2;</td>
      </tr>
      <tr class="line_holder diff-line new" id="sha__12">
        <td class="diff-td old_line diff-line-numbers" data-side="old"></td>
        <td class="diff-td new_line diff-line-numbers" data-side="new"><a class="diff-line-num" data-linenumber="12" href="#sha__12">12</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="line_content new">+  return total + fee;</td>
      </tr>
    </tbody></table>
  </div>
</div>`;

/** 新旧属性名混排：old 侧写 data-linenumber、new 侧写 data-line-number，两种都要读到。 */
const mixedLineNumberAttrs = `
<div class="diff-file file-holder" data-file-path="src/checkout.ts">
  <div class="file-header-content"><span class="file-title-name">src/checkout.ts</span></div>
  <div class="diff-content">
    <table class="diff-table"><tbody>
      <tr class="line_holder diff-line" data-linenumber="21">
        <td class="diff-td old_line"><a class="diff-line-num" data-linenumber="20">20</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="line_content old">-  const fee = 0.1;</td>
        <td class="diff-td new_line"><a class="diff-line-num" data-line-number="21">21</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="line_content new">+  const fee = 0.2;</td>
      </tr>
    </tbody></table>
  </div>
</div>`;

/** 行号只写在行容器的 data-linenumber 上：既不是 tr 也没有 .line_holder。 */
const linenumberRowOnly = `
<div class="diff-file" data-file-path="src/rowonly.ts">
  <div class="diff-content">
    <div data-linenumber="8"><code>const a = 1;</code></div>
    <div data-linenumber="9"><code>const b = 2;</code></div>
  </div>
</div>`;

/** blob 文件视图（新版）：行号格里只有 data-linenumber，没有 id 也没有 data-line-number。 */
const blobViewLinenumber = `
<div class="file-holder blob-viewer" data-path="src/blob.ts">
  <div class="blob-content-holder"><div class="blob-content">
    <table class="text-file"><tbody>
      <tr class="line_holder">
        <td class="line_numbers"><a class="diff-line-num" data-linenumber="7" href="#L7">7</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="line_content">export const total = 42;</td>
      </tr>
    </tbody></table>
  </div></div>
</div>`;

/** MR 讨论区 / 描述：普通文本 + markdown 表格，没有任何代码位置语义。 */
const discussionNote = `
<div class="discussion-notes">
  <div class="note-text md">
    <p>这里的 <code>apiKey</code> 看起来是硬编码的，需要确认。</p>
    <table><tbody><tr><td>列 A</td><td>列 B</td></tr></tbody></table>
  </div>
</div>`;

// jsdom 不实现 Range.getBoundingClientRect，工具条定位只需要一个矩形占位。
beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => ({
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
});

function mount(html: string) {
  document.body.innerHTML = html;
}

function applyRange(range: Range) {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 划选一个元素里的全部内容（等价于用户在该行拖拽划词）。 */
function selectContents(selector: string) {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(selector)!);
  applyRange(range);
}

function firstText(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text;
}

function lastText(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let last = walker.nextNode() as Text;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
  return last;
}

/** 从 from 里划到 to，覆盖多行。 */
function selectBetween(from: Element, to: Element) {
  const range = document.createRange();
  range.setStart(firstText(from), 0);
  const end = lastText(to);
  range.setEnd(end, end.length);
  applyRange(range);
}

function codeAt(selector: string, index: number) {
  return document.querySelectorAll(selector)[index]!;
}

function selectionOf(patch: Partial<CodeSelection> = {}): CodeSelection {
  return { filePath: 'src/payment.ts', side: 'new', text: 'const a = 1;', top: 0, left: 0, ...patch };
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('captureCodeSelection · 经典 GitLab diff', () => {
  it('新增行按 new 侧行号引用', () => {
    mount(classicInline);
    selectContents('tr:nth-child(3) > .line_content');

    const captured = captureCodeSelection(document)!;
    expect(captured.filePath).toBe('src/payment.ts');
    expect(captured.side).toBe('new');
    expect(captured.startLine).toBe(11);
    expect(captured.endLine).toBe(11);
    expect(captured.text).toContain('const fee = 0.2');
  });

  it('上下文行取新侧行号', () => {
    mount(classicInline);
    selectContents('tr:nth-child(1) > .line_content');

    expect(captureCodeSelection(document)).toMatchObject({ side: 'new', startLine: 9, endLine: 9 });
  });

  it('删除行按 old 侧行号引用，不套用 new 侧行号', () => {
    mount(classicInline);
    selectContents('tr:nth-child(2) > .line_content');

    const captured = captureCodeSelection(document)!;
    expect(captured.side).toBe('old');
    expect(captured.startLine).toBe(10);
    expect(captured.endLine).toBe(10);
  });

  it('side-by-side 两侧各读自己的行号格（tr 上的 data-line-number 是新侧）', () => {
    mount(classicParallel);

    selectContents('.line_content.old');
    expect(captureCodeSelection(document)).toMatchObject({ filePath: 'src/checkout.ts', side: 'old', startLine: 20 });

    selectContents('.line_content.new');
    expect(captureCodeSelection(document)).toMatchObject({ filePath: 'src/checkout.ts', side: 'new', startLine: 21 });
  });

  it('跨 old/new 两侧划词时按起点侧别给行号，不混用两侧', () => {
    mount(classicParallel);
    selectBetween(document.querySelector('.line_content.old')!, document.querySelector('.line_content.new')!);

    const captured = captureCodeSelection(document)!;
    expect(captured.side).toBe('old');
    expect(captured.startLine).toBe(20);
    expect(captured.endLine).toBe(20);
  });

  it('跨行选择给出起止行号与完整文本', () => {
    mount(classicInline);
    selectBetween(codeAt('.line_content', 2), codeAt('.line_content', 3));

    const captured = captureCodeSelection(document)!;
    expect(captured.startLine).toBe(11);
    expect(captured.endLine).toBe(12);
    expect(captured.text).toContain('const fee = 0.2');
    expect(captured.text).toContain('return total + fee');
  });
});

describe('captureCodeSelection · 新版 GitLab diff', () => {
  it('tr[data-line] + .diff-line-numbers 结构按侧别取行号', () => {
    mount(vueDiff);

    selectContents('tr:nth-child(1) > .line_content');
    expect(captureCodeSelection(document)).toMatchObject({ filePath: 'src/api/user.ts', side: 'new', startLine: 20 });

    selectContents('tr:nth-child(2) > .line_content');
    const old = captureCodeSelection(document)!;
    expect(old.side).toBe('old');
    expect(old.startLine).toBe(20);
    expect(old.startLine).not.toBe(21);
  });

  it('rename 文件优先用 data-file-path', () => {
    mount(vueDiff);
    selectContents('tr:nth-child(1) > .line_content');

    expect(captureCodeSelection(document)!.filePath).toBe('src/api/user.ts');
  });

  it('rename 标题没有 data-file-path 时取箭头后的新路径', () => {
    mount(renamedTitleOnly);
    selectContents('.line_content');

    const captured = captureCodeSelection(document)!;
    expect(captured.filePath).toBe('src/api/user.ts');
    expect(captured.startLine).toBe(5);
  });
});

describe('captureCodeSelection · 行号缺失与降级', () => {
  it('DOM 里没有行号时明示未知，不编造 :1', () => {
    mount(withoutLineInfo);
    selectContents('code');

    const captured = captureCodeSelection(document)!;
    expect(captured.filePath).toBe('src/legacy.ts');
    expect(captured.startLine).toBeUndefined();
    expect(captured.endLine).toBeUndefined();
    expect(selectionLabel(captured)).toBe('legacy.ts:行号未知');
    expect(selectionRef(captured)).toBe('src/legacy.ts（行号未知）');
    expect(selectionRef(captured)).not.toContain(':1');
  });

  it('跨行选择终点行号缺失时按覆盖行数推算', () => {
    mount(partialLineInfo);
    selectBetween(codeAt('.line_holder code', 0), codeAt('.line_holder code', 1));

    const captured = captureCodeSelection(document)!;
    expect(captured.startLine).toBe(4);
    expect(captured.endLine).toBe(5);
  });

  it('代码格里的纯数字不会被当成行号', () => {
    mount(`
<div class="diff-file" data-file-path="src/numbers.ts">
  <table class="diff-table"><tbody>
    <tr class="line_holder"><td class="line_content new" data-side="new">42</td></tr>
  </tbody></table>
</div>`);
    selectContents('.line_content');

    const captured = captureCodeSelection(document)!;
    expect(captured.side).toBe('new');
    expect(captured.text).toBe('42');
    expect(captured.startLine).toBeUndefined();
  });

  it('代码格上的 LC 行号 id 仍然可用', () => {
    mount(`
<div class="diff-file" data-file-path="src/numbers.ts">
  <table class="diff-table"><tbody>
    <tr class="line_holder"><td class="line_content new" id="LC99">42</td></tr>
  </tbody></table>
</div>`);
    selectContents('.line_content');

    expect(captureCodeSelection(document)).toMatchObject({ startLine: 99, endLine: 99 });
  });

  it('blob 文件视图标记为 unified 并取行号格里的行号', () => {
    mount(blobView);
    selectContents('.line_content');

    expect(captureCodeSelection(document)).toMatchObject({ filePath: 'src/blob.ts', side: 'unified', startLine: 7, endLine: 7 });
  });

  it('讨论区文本不再回落到默认路径', () => {
    mount('<div class="note-text"><p>讨论区里的普通文本</p></div>');
    selectContents('p');

    const captured = captureCodeSelection(document, 'src/fallback.ts')!;
    expect(captured.filePath).toBeUndefined();
    expect(captured.text).toBe('讨论区里的普通文本');
  });

  it('空选区返回 null', () => {
    mount(classicInline);
    document.getSelection()!.removeAllRanges();

    expect(captureCodeSelection(document)).toBeNull();
  });
});

describe('选区引用格式', () => {
  it('区间与单行', () => {
    expect(selectionLines(selectionOf({ startLine: 10, endLine: 14 }))).toBe('10-14');
    expect(selectionLabel(selectionOf({ startLine: 10, endLine: 14 }))).toBe('payment.ts:10-14');
    expect(selectionRef(selectionOf({ startLine: 10, endLine: 14 }))).toBe('src/payment.ts（新增侧 L10-14）');
    expect(selectionLabel(selectionOf({ startLine: 10, endLine: 10 }))).toBe('payment.ts:10');
    expect(selectionRef(selectionOf({ startLine: 10, endLine: 10 }))).toBe('src/payment.ts（新增侧 L10）');
  });

  it('old 侧标注删除侧', () => {
    expect(selectionLabel(selectionOf({ side: 'old', startLine: 3, endLine: 3 }))).toBe('payment.ts:3（旧侧）');
    expect(selectionRef(selectionOf({ side: 'old', startLine: 3, endLine: 3 }))).toBe('src/payment.ts（删除侧 L3）');
  });

  it('unified 侧不宣称新增/删除', () => {
    expect(selectionRef(selectionOf({ side: 'unified', startLine: 7, endLine: 7 }))).toBe('src/payment.ts（L7）');
  });

  it('行号未知时降级为无行号引用', () => {
    expect(selectionLines(selectionOf({ startLine: undefined, endLine: undefined }))).toBeUndefined();
    expect(selectionLabel(selectionOf({ startLine: undefined, endLine: undefined }))).toBe('payment.ts:行号未知');
    expect(selectionRef(selectionOf({ startLine: undefined, endLine: undefined }))).toBe('src/payment.ts（行号未知）');
  });
});

describe('selectionFile', () => {
  it('new 侧选区按新增行构造', () => {
    const file = selectionFile(selectionOf({ startLine: 11, endLine: 12, text: 'a\nb' }));

    expect(file.diff).toBe('+a\n+b');
    expect(file.lines).toEqual([
      { hunkId: 'selection', newLine: 11, kind: 'added', text: 'a' },
      { hunkId: 'selection', newLine: 12, kind: 'added', text: 'b' },
    ]);
  });

  it('old 侧选区按删除行构造', () => {
    const file = selectionFile(selectionOf({ side: 'old', startLine: 3, endLine: 4, text: 'a\nb' }));

    expect(file.diff).toBe('-a\n-b');
    expect(file.lines).toEqual([
      { hunkId: 'selection', oldLine: 3, kind: 'removed', text: 'a' },
      { hunkId: 'selection', oldLine: 4, kind: 'removed', text: 'b' },
    ]);
  });

  it('行号未知时不带行号，不编造起点', () => {
    const file = selectionFile(selectionOf({ startLine: undefined, endLine: undefined, text: 'a\nb' }));

    expect(file.lines).toEqual([
      { hunkId: 'selection', kind: 'added', text: 'a' },
      { hunkId: 'selection', kind: 'added', text: 'b' },
    ]);
  });
});

describe('captureCodeSelection · data-linenumber（新版属性名）', () => {
  it('inline diff 的行号格只有 data-linenumber 时按 new 侧读到', () => {
    mount(linenumberInline);
    selectContents('tr:nth-child(3) > .line_content');

    expect(captureCodeSelection(document)).toMatchObject({
      filePath: 'src/payment.ts', side: 'new', startLine: 11, endLine: 11,
    });
  });

  it('删除行按 old 侧读 data-linenumber，不套用 new 侧行号', () => {
    mount(linenumberInline);
    selectContents('tr:nth-child(2) > .line_content');

    const captured = captureCodeSelection(document)!;
    expect(captured.side).toBe('old');
    expect(captured.startLine).toBe(10);
    expect(captured.endLine).toBe(10);
  });

  it('上下文行取新侧的 data-linenumber', () => {
    mount(linenumberInline);
    selectContents('tr:nth-child(1) > .line_content');

    expect(captureCodeSelection(document)).toMatchObject({ side: 'new', startLine: 9, endLine: 9 });
  });

  it('跨行选择读到 data-linenumber 的起止行', () => {
    mount(linenumberInline);
    selectBetween(codeAt('.line_content', 2), codeAt('.line_content', 3));

    const captured = captureCodeSelection(document)!;
    expect(captured.startLine).toBe(11);
    expect(captured.endLine).toBe(12);
    expect(captured.text).toContain('return total + fee');
  });

  it('data-linenumber 与 data-line-number 混排时两侧各读各的（取并集）', () => {
    mount(mixedLineNumberAttrs);

    selectContents('.line_content.old');
    expect(captureCodeSelection(document)).toMatchObject({ filePath: 'src/checkout.ts', side: 'old', startLine: 20 });

    selectContents('.line_content.new');
    expect(captureCodeSelection(document)).toMatchObject({ filePath: 'src/checkout.ts', side: 'new', startLine: 21 });
  });

  it('行号只写在行容器 data-linenumber 上时按行容器读', () => {
    mount(linenumberRowOnly);

    selectContents('.diff-content > div:first-child code');
    expect(captureCodeSelection(document)).toMatchObject({
      filePath: 'src/rowonly.ts', side: 'new', startLine: 8, endLine: 8,
    });

    selectBetween(codeAt('code', 0), codeAt('code', 1));
    expect(captureCodeSelection(document)).toMatchObject({ startLine: 8, endLine: 9 });
  });

  it('blob 视图的 data-linenumber 行号格标记为 unified', () => {
    mount(blobViewLinenumber);
    selectContents('.line_content');

    expect(captureCodeSelection(document)).toMatchObject({
      filePath: 'src/blob.ts', side: 'unified', startLine: 7, endLine: 7,
    });
  });
});

describe('captureCodeSelection · 非 diff 区域降级', () => {
  it('讨论区选区只带原文，不编造路径 / 侧别 / 行号', () => {
    mount(discussionNote);
    selectContents('p');

    const captured = captureCodeSelection(document, 'src/fallback.ts')!;
    expect(captured.text).toContain('硬编码');
    expect(captured.filePath).toBeUndefined();
    expect(captured.side).toBeUndefined();
    expect(captured.startLine).toBeUndefined();
    expect(captured.endLine).toBeUndefined();
    expect(isCodeSelection(captured)).toBe(false);
    expect(Object.keys(captured).sort()).toEqual(['left', 'text', 'top']);
  });

  it('评论里的 markdown 表格不会被当成 diff 行', () => {
    mount(discussionNote);
    selectContents('td');

    const captured = captureCodeSelection(document)!;
    expect(captured.text).toBe('列 A');
    expect(isCodeSelection(captured)).toBe(false);
    expect(captured.side).toBeUndefined();
  });

  it('页面标题等普通文本同样降级', () => {
    mount('<h1 class="title">Harden checkout payment error handling</h1>');
    selectContents('h1');

    expect(isCodeSelection(captureCodeSelection(document)!)).toBe(false);
  });

  it('diff 内选区仍然带完整元数据与三个动作语义', () => {
    mount(classicInline);
    selectContents('tr:nth-child(3) > .line_content');

    const captured = captureCodeSelection(document)!;
    expect(isCodeSelection(captured)).toBe(true);
    expect(captured).toMatchObject({ filePath: 'src/payment.ts', side: 'new', startLine: 11, endLine: 11 });
  });
});

describe('selectionAlive · 选区 DOM 消失后关闭工具条', () => {
  it('选区节点还在页面上且未折叠时判活', () => {
    mount(classicInline);
    selectContents('tr:nth-child(3) > .line_content');

    expect(selectionAlive(document.getSelection()!.anchorNode, document)).toBe(true);
  });

  it('选区所在节点被移除（切 tab / SPA 路由）后判死', () => {
    mount(classicInline);
    selectContents('tr:nth-child(3) > .line_content');
    const node = document.getSelection()!.anchorNode;

    document.body.innerHTML = '<div class="diff-file" data-file-path="src/other.ts">切走后的新内容</div>';

    expect(node!.isConnected).toBe(false);
    expect(selectionAlive(node, document)).toBe(false);
  });

  it('选区被清空后判死', () => {
    mount(classicInline);
    selectContents('tr:nth-child(3) > .line_content');
    const node = document.getSelection()!.anchorNode;

    document.getSelection()!.removeAllRanges();

    expect(selectionAlive(node, document)).toBe(false);
  });

  it('没有锚点节点时判死', () => {
    mount(classicInline);

    expect(selectionAlive(null, document)).toBe(false);
    expect(selectionAlive(undefined, document)).toBe(false);
  });
});

describe('非代码选区的标签与引用', () => {
  const plain = selectionOf({
    filePath: undefined, side: undefined, startLine: undefined, endLine: undefined, text: '页面文本',
  });

  it('标签与引用都不带 path:line 与新旧侧', () => {
    expect(isCodeSelection(plain)).toBe(false);
    expect(selectionLabel(plain)).toBe('页面文本选区');
    expect(selectionRef(plain)).toBe('页面选区');
    expect(selectionQuote(plain)).toBe('[选中内容]');
    expect(selectionLabel(plain)).not.toContain('payment.ts');
    expect(selectionQuote(plain)).not.toMatch(/L\d|新增侧|删除侧/);
  });

  it('代码选区的引用行保留 path 与行号', () => {
    expect(isCodeSelection(selectionOf({ startLine: 10, endLine: 12 }))).toBe(true);
    expect(selectionQuote(selectionOf({ startLine: 10, endLine: 12 })))
      .toBe('[代码选区: src/payment.ts（新增侧 L10-12）]');
  });
});

describe('watchSelection · 工具条随选区消失而关闭', () => {
  it('选区节点被移除（切 tab / SPA 路由）时回调', async () => {
    mount(classicInline);
    selectContents('tr:nth-child(3) > .line_content');
    const node = document.getSelection()!.anchorNode;
    const onGone = vi.fn();
    const unwatch = watchSelection(node, document, onGone);

    document.body.innerHTML = '<div class="diff-file" data-file-path="src/other.ts">切走后的新内容</div>';
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());

    unwatch();
    onGone.mockClear();
    document.body.innerHTML = '';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onGone).not.toHaveBeenCalled();
  });

  it('选区被清空时经 selectionchange 回调', () => {
    mount(classicInline);
    selectContents('tr:nth-child(3) > .line_content');
    const node = document.getSelection()!.anchorNode;
    const onGone = vi.fn();
    const unwatch = watchSelection(node, document, onGone);

    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));

    expect(onGone).toHaveBeenCalled();
    unwatch();
  });

  it('选区仍然有效时不误关（无关 DOM 变更与 selectionchange 都不触发）', async () => {
    mount(classicInline);
    selectContents('tr:nth-child(3) > .line_content');
    const onGone = vi.fn();
    const unwatch = watchSelection(document.getSelection()!.anchorNode, document, onGone);

    document.body.insertAdjacentHTML('beforeend', '<div class="diff-file" data-file-path="src/next.ts">别的文件</div>');
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onGone).not.toHaveBeenCalled();
    unwatch();
  });
});
