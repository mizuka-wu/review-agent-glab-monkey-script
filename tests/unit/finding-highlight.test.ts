import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHighlights, highlightFindingOnPage, injectHighlightStyles, savePendingLocate, takePendingLocate,
  type LocateTarget,
} from '../../src/core/finding-highlight';

const target = (input: Partial<LocateTarget> = {}): LocateTarget => ({
  path: 'src/payment.ts', line: 11, endLine: 11, side: 'new',
  severity: 'high', title: '硬编码密钥', existingCode: 'const fee = 0.2;',
  ...input,
});

/** 新版 GitLab 实测 DOM：行号只写 data-linenumber，整页没有 data-line-number。 */
const realDiff = `
<div class="diff-file file-holder" data-file-path="src/payment.ts">
  <div class="file-header-content"><span class="file-title-name">src/payment.ts</span></div>
  <div class="diff-content table-holder">
    <table class="diff-table inline"><tbody>
      <tr class="line_holder diff-line" id="sha_9_9">
        <td class="diff-td old_line diff-line-numbers" data-side="old"><a class="diff-line-num" data-linenumber="9">9</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="diff-td new_line diff-line-numbers" data-side="new"><a class="diff-line-num" data-linenumber="9">9</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="line_content match">  const total = 1;</td>
      </tr>
      <tr class="line_holder diff-line old" id="sha_10_">
        <td class="diff-td old_line diff-line-numbers" data-side="old"><a class="diff-line-num" data-linenumber="10">10</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="diff-td new_line diff-line-numbers" data-side="new"></td>
        <td class="line_content old">-  const fee = 0.1;</td>
      </tr>
      <tr class="line_holder diff-line new" id="sha__11">
        <td class="diff-td old_line diff-line-numbers" data-side="old"></td>
        <td class="diff-td new_line diff-line-numbers" data-side="new"><a class="diff-line-num" data-linenumber="11">11</a><button class="diff-comment-avatar" type="button">+</button></td>
        <td class="line_content new">+  const fee = 0.2;</td>
      </tr>
    </tbody></table>
  </div>
</div>`;

/**
 * GitLab 19.x 默认渲染的 Rapid Diffs（真实 DOM 抄样）：文件容器是自定义元素 <diff-file>，路径写在 data-file-data 的 JSON 里，
 * 行是 tr.rd-hunk-lines，行号在两个 td.rd-line-number[data-position] 里的 a.rd-line-link 上。
 */
const rapidDiff = `
<diff-file class="rd-diff-file-component" data-testid="rd-diff-file" id="5d6d6495c"
  data-file-data='{"viewer":"text_inline","old_path":"matrix/modified.ts","new_path":"matrix/modified.ts"}'>
  <article class="rd-diff-file" data-virtual="text_inline">
    <header class="rd-diff-file-header" data-testid="rd-diff-file-header">
      <a class="rd-diff-file-link" href="/test/test/-/blob/head-sha/matrix/modified.ts">matrix/modified.ts</a>
    </header>
    <table><tbody>
      <tr class="rd-hunk-header rd-hunk-header-inline" data-hunk-header="">
        <td class="rd-hunk-header-buttons" colspan="2"><button type="button" class="rd-expand-lines-button" data-click="expandLines" aria-label="Show lines before"></button></td>
        <td class="rd-hunk-header-content">@@ -17,7 +17,8 @@</td>
      </tr>
      <tr class="rd-hunk-lines rd-hunk-lines-inline" data-testid="hunk-lines-inline" id="line_5d6d6495c_17">
        <td class="rd-line-number" data-position="old"><a class="rd-line-link" data-line-number="17" aria-label="17" href="#"></a></td>
        <td class="rd-line-number" data-position="new"><a class="rd-line-link" data-line-number="18" aria-label="18" href="#"></a></td>
        <td class="rd-line-content" data-gfm-source="true"><pre class="rd-line-text">export const base17 = 17;</pre></td>
      </tr>
      <tr class="rd-hunk-lines rd-hunk-lines-inline" data-testid="hunk-lines-inline" id="line_5d6d6495c_20">
        <td class="rd-line-number" data-change="removed" data-position="old"><a class="rd-line-link" data-line-number="19" aria-label="19" href="#"></a></td>
        <td class="rd-line-number rd-line-number-empty" data-change="removed" data-position="new"></td>
        <td class="rd-line-content" data-change="removed"><pre class="rd-line-text">export const base19 = 19;</pre></td>
      </tr>
      <tr class="rd-hunk-lines rd-hunk-lines-inline" data-testid="hunk-lines-inline" id="line_5d6d6495c_A19">
        <td class="rd-line-number rd-line-number-empty" data-change="added" data-position="old"></td>
        <td class="rd-line-number" data-change="added" data-position="new"><a class="rd-line-link" data-line-number="20" aria-label="20" href="#"></a></td>
        <td class="rd-line-content" data-change="added"><pre class="rd-line-text">export const base19 = 1900;</pre></td>
      </tr>
    </tbody></table>
  </article>
</diff-file>`;

const overviewPage = `
<ul class="nav nav-tabs">
  <li class="nav-item"><a class="nav-link" href="/acme/app/-/merge_requests/7">Overview</a></li>
  <li class="nav-item"><a class="nav-link" href="/acme/app/-/merge_requests/7/commits">Commits</a></li>
  <li class="nav-item"><a class="nav-link" href="/acme/app/-/merge_requests/7/diffs">Changes</a></li>
</ul>
<div class="description">MR 描述</div>`;

const collapsedFile = `
<div class="diff-file file-holder" data-file-path="src/big.ts">
  <div class="file-header-content"><span class="file-title-name">src/big.ts</span></div>
  <div class="diff-collapsed"><button class="js-show-diff" type="button">Load diff</button></div>
</div>`;

const foldedFile = `
<div class="diff-file file-holder" data-file-path="src/fold.ts">
  <div class="file-header-content"><span class="file-title-name">src/fold.ts</span></div>
  <div class="diff-content"><table class="diff-table"><tbody>
    <tr class="line_holder diff-line new" id="sha__4">
      <td class="diff-td old_line" data-side="old"></td>
      <td class="diff-td new_line" data-side="new"><a class="diff-line-num" data-linenumber="4">4</a></td>
      <td class="line_content new">+before();</td>
    </tr>
    <tr class="line_holder expand">
      <td class="diff-line-numbers unfold"></td>
      <td class="line_content unfold"><a class="js-expand-lines" href="#">Expand</a></td>
    </tr>
    <tr class="line_holder diff-line new" id="sha__40">
      <td class="diff-td old_line" data-side="old"></td>
      <td class="diff-td new_line" data-side="new"><a class="diff-line-num" data-linenumber="40">40</a></td>
      <td class="line_content new">+after();</td>
    </tr>
  </tbody></table></div>
</div>`;

const revealedRow = `
    <tr class="line_holder diff-line new" id="sha__20">
      <td class="diff-td old_line" data-side="old"></td>
      <td class="diff-td new_line" data-side="new"><a class="diff-line-num" data-linenumber="20">20</a></td>
      <td class="line_content new">+target();</td>
    </tr>`;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function onClick(selector: string, handler: (node: HTMLElement) => void) {
  const node = document.querySelector<HTMLElement>(selector);
  node?.addEventListener('click', (event) => {
    event.preventDefault();
    handler(node);
  });
}

describe('highlightFindingOnPage', () => {
  it('reads the new GitLab data-linenumber spelling and highlights the row', async () => {
    injectHighlightStyles();
    document.body.innerHTML = realDiff;

    const outcome = await highlightFindingOnPage(target());

    expect(outcome.failure).toBeUndefined();
    expect(outcome.highlighted.map((row) => row.id)).toEqual(['sha__11']);
    expect(outcome.highlighted[0].classList.contains('ra-finding-highlight')).toBe(true);
    expect(document.querySelectorAll('.ra-finding-marker')).toHaveLength(1);
  });

  it('resolves an old-side line through the sha_old_new row id', async () => {
    document.body.innerHTML = realDiff;

    const outcome = await highlightFindingOnPage(
      target({ line: 10, endLine: 10, side: 'old', existingCode: 'const fee = 0.1;' }));

    expect(outcome.highlighted.map((row) => row.id)).toEqual(['sha_10_']);
  });

  it('highlights a whole range, including the removed line sitting inside it', async () => {
    document.body.innerHTML = realDiff;

    const outcome = await highlightFindingOnPage(target({ line: 9, endLine: 11, existingCode: 'const total = 1;' }));

    expect(outcome.highlighted.map((row) => row.id)).toEqual(['sha_9_9', 'sha_10_', 'sha__11']);
    expect(outcome.highlighted[0].querySelector('td .ra-finding-marker')).not.toBeNull();
  });

  it('switches to the Changes tab first when the page sits on Overview', async () => {
    document.body.innerHTML = overviewPage;
    onClick('a[href$="/diffs"]', () => { document.body.innerHTML = realDiff; });

    const outcome = await highlightFindingOnPage(target());

    expect(outcome.highlighted.map((row) => row.id)).toEqual(['sha__11']);
    expect(takePendingLocate()).toBeUndefined();
  });

  it('expands a collapsed file before looking for the line', async () => {
    document.body.innerHTML = collapsedFile;
    onClick('.js-show-diff', (node) => {
      node.closest<HTMLElement>('.diff-collapsed')!.outerHTML = `
        <div class="diff-content"><table class="diff-table"><tbody>
          <tr class="line_holder diff-line new" id="sha__7">
            <td class="diff-td new_line" data-side="new"><a class="diff-line-num" data-linenumber="7">7</a></td>
            <td class="line_content new">+loaded();</td>
          </tr>
        </tbody></table></div>`;
    });

    const outcome = await highlightFindingOnPage(
      target({ path: 'src/big.ts', line: 7, endLine: 7, existingCode: 'loaded();' }));

    expect(outcome.highlighted.map((row) => row.id)).toEqual(['sha__7']);
  });

  it('expands a folded section that hides the target line', async () => {
    document.body.innerHTML = foldedFile;
    onClick('.js-expand-lines', (node) => {
      const row = node.closest<HTMLElement>('tr')!;
      row.insertAdjacentHTML('beforebegin', revealedRow);
      row.remove();
    });

    const outcome = await highlightFindingOnPage(
      target({ path: 'src/fold.ts', line: 20, endLine: 20, existingCode: 'target();' }));

    expect(outcome.highlighted.map((row) => row.id)).toEqual(['sha__20']);
  });

  it('falls back to matching the code text when the gutter is unreadable', async () => {
    document.body.innerHTML = realDiff;
    document.querySelectorAll('[data-linenumber]').forEach((node) => node.removeAttribute('data-linenumber'));
    document.querySelectorAll('[id^="sha_"]').forEach((node) => { node.id = ''; });

    const outcome = await highlightFindingOnPage(target({ line: 11, endLine: 11 }));

    expect(outcome.highlighted).toHaveLength(1);
    expect(outcome.highlighted[0].textContent).toContain('const fee = 0.2;');
  });

  it('degrades to the file header when the line is nowhere on the page', async () => {
    document.body.innerHTML = realDiff;

    const outcome = await highlightFindingOnPage(target({ line: 777, endLine: 777, existingCode: 'absent();' }));

    expect(outcome).toMatchObject({ highlighted: [], fileLevel: true, failure: 'line-not-found' });
  });

  it('says so instead of failing silently when the file is not in the page', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = realDiff;

    const promise = highlightFindingOnPage(target({ path: 'src/ghost.ts' }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await promise).toMatchObject({ highlighted: [], fileLevel: false, failure: 'file-not-found' });
  });

  it('reports a page without a Changes tab', async () => {
    document.body.innerHTML = '<div class="description">没有 diff 也没有 tab</div>';

    expect(await highlightFindingOnPage(target())).toMatchObject({ failure: 'no-diff-tab' });
  });

  it('keeps the pending target when the tab click really navigates away', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = overviewPage;
    onClick('a[href$="/diffs"]', () => undefined);

    const promise = highlightFindingOnPage(target());
    await vi.advanceTimersByTimeAsync(8_000);

    expect(await promise).toMatchObject({ highlighted: [], failure: 'navigated' });
    expect(takePendingLocate()).toMatchObject({ path: 'src/payment.ts', line: 11 });
  });

  it('clears previous highlights before applying new ones', async () => {
    document.body.innerHTML = realDiff;
    await highlightFindingOnPage(target({ line: 9, endLine: 9, existingCode: 'const total = 1;' }));
    expect(document.querySelectorAll('[data-ra-highlight]')).toHaveLength(1);

    await highlightFindingOnPage(target());

    expect(document.querySelectorAll('[data-ra-highlight]')).toHaveLength(1);
    expect(document.querySelector('[data-ra-highlight]')?.id).toBe('sha__11');
    clearHighlights();
    expect(document.querySelectorAll('[data-ra-highlight], .ra-finding-marker')).toHaveLength(0);
  });
});

describe('pending locate handover', () => {
  it('round-trips the locate target through sessionStorage', () => {
    savePendingLocate(target());
    expect(takePendingLocate()).toMatchObject({ path: 'src/payment.ts', line: 11, side: 'new' });
    expect(takePendingLocate()).toBeUndefined();
  });

  it('drops a stale target so a reload long after does not jump around', () => {
    savePendingLocate(target());
    const stored = JSON.parse(sessionStorage.getItem('review-agent-pending-locate-v1')!) as { savedAt: number };
    sessionStorage.setItem('review-agent-pending-locate-v1', JSON.stringify({
      ...stored, savedAt: Date.now() - 120_000,
    }));
    expect(takePendingLocate()).toBeUndefined();
  });
});

describe('highlightFindingOnPage · 19.x Rapid Diffs（默认渲染）', () => {
  const rapidTarget = (input: Partial<LocateTarget> = {}): LocateTarget => target({
    path: 'matrix/modified.ts', line: 20, endLine: 20, side: 'new',
    existingCode: 'export const base19 = 1900;', ...input,
  });

  it('文件容器是 <diff-file data-file-data>，路径从 JSON 里读出来', async () => {
    injectHighlightStyles();
    document.body.innerHTML = rapidDiff;

    const outcome = await highlightFindingOnPage(rapidTarget());

    expect(outcome.failure).toBeUndefined();
    expect(outcome.highlighted.map((row) => row.id)).toEqual(['line_5d6d6495c_A19']);
  });

  it('新增行按新侧行号定位，删除行按旧侧行号定位', async () => {
    document.body.innerHTML = rapidDiff;
    const removed = await highlightFindingOnPage(
      rapidTarget({ line: 19, endLine: 19, side: 'old', existingCode: 'export const base19 = 19;' }));

    expect(removed.highlighted.map((row) => row.id)).toEqual(['line_5d6d6495c_20']);
  });

  it('上下文行两侧号码不同也不会串到旧侧那一行', async () => {
    document.body.innerHTML = rapidDiff;
    const outcome = await highlightFindingOnPage(
      rapidTarget({ line: 18, endLine: 18, side: 'new', existingCode: 'export const base17 = 17;' }));

    expect(outcome.highlighted.map((row) => row.id)).toEqual(['line_5d6d6495c_17']);
  });

  it('整段范围连删除行一起高亮', async () => {
    document.body.innerHTML = rapidDiff;
    const outcome = await highlightFindingOnPage(
      rapidTarget({ line: 18, endLine: 20, existingCode: 'export const base17 = 17;' }));

    expect(outcome.highlighted.map((row) => row.id)).toEqual([
      'line_5d6d6495c_17', 'line_5d6d6495c_20', 'line_5d6d6495c_A19',
    ]);
  });
});
