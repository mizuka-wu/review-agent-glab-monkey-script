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
