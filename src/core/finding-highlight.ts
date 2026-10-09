import { repoPathEquals } from './diff';
import { rowLineNumber } from './dom-line-number';
import type { Finding } from './types';

/** 定位所需的最小信息：Finding 可直接赋值，整页跳转后也能从 sessionStorage 复原继续定位。 */
export interface LocateTarget {
  path: string;
  newPath?: string;
  oldPath?: string;
  line: number;
  endLine: number;
  side: 'old' | 'new';
  severity: Finding['severity'];
  title: string;
  existingCode?: string;
}

export type LocateFailure = 'navigated' | 'no-diff-tab' | 'file-not-found' | 'line-not-found';

export interface LocateOutcome {
  highlighted: HTMLElement[];
  /** 目标行没能定位到，但文件在页面上：已滚动到文件头。 */
  fileLevel: boolean;
  failure?: LocateFailure;
}

/** GitLab 各版本 diff 行容器：经典 HAML 的 tr.line_holder、Vue diff 的 .diff-line、19.x grid 的 div.line_holder、blob 视图的 tr#LC10。 */
const ROW_SELECTOR = 'tr, .line_holder, .diff-line, [data-linenumber], [data-line-number], [data-line], [data-interop-line]';
const FILE_SELECTOR = '.diff-file, .file-holder, [data-testid="diff-file"], [data-file-path]';
const CODE_SELECTOR = '.line_content, code, .blob-code';
const HEADER_SELECTOR = '.file-header, .file-header-content, [data-testid="diff-file-header"]';
/**
 * 文件级折叠（大文件默认收起、用户手动收起文件）与「隐藏的 N 行」段内折叠，控件选择器分开：前者一次点完，后者要逐个试。
 * 19.x 的文件收起开关没有 js- 钩子，只剩 aria-label 可以认。
 */
const FILE_EXPAND_SELECTOR = '.diff-collapsed a, .diff-collapsed button, [data-testid="diff-file-collapsed"] a, '
  + '[data-testid="diff-file-collapsed"] button, .js-show-diff, a.js-load-diff, button.js-load-diff, '
  + '.diff-content.collapsed button, .collapsed-diff button, '
  + 'button[aria-label="Show file contents"], button[aria-label="显示文件内容"]';
const LINE_EXPAND_SELECTOR = 'a.js-expand-lines, button.js-expand-lines, a.js-expand-line-range, '
  + 'button.js-expand-line-range, .line_content.unfold a, .line_content.unfold button, td.unfold a, td.unfold button, '
  + 'tr.expand a, tr.expand button, [data-testid="diff-expand-button"], [data-diff-toggle-entity="expansion"] a, '
  + '.diff-expand-text';
/** diff 文件列表本身还没渲染到目标文件时的「加载更多」。 */
const LOAD_MORE_SELECTOR = 'button.js-load-more, .js-load-more button, [data-testid="load-more-diffs"], '
  + '.load-more button, button.js-force-expand-all-diffs';
const TAB_LABEL = /^(changes|diffs?|变更|更改|差异|文件改动)$/i;

const PENDING_KEY = 'review-agent-pending-locate-v1';
const PENDING_TTL = 60_000;
const EXPAND_ROUNDS = 6;
/** 展开折叠的总预算：逐段展开可能很慢，但用户点「定位」不该等上十几秒。 */
const REVEAL_BUDGET = 6000;

function settle(ms = 220) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await settle(160);
  }
}

function otherSide(side: 'old' | 'new'): 'old' | 'new' {
  return side === 'new' ? 'old' : 'new';
}

/** 行容器可能带任意一种标记，统一收敛到最外层的行元素并去重。 */
function rowsOf(container: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const node of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const row = node.closest<HTMLElement>('tr, .line_holder, .diff-line') ?? node;
    if (row === container || seen.has(row)) continue;
    seen.add(row);
    rows.push(row);
  }
  return rows;
}

function datasetPath(node: Element | null | undefined): string | undefined {
  if (!(node instanceof HTMLElement)) return undefined;
  const value = node.dataset.filePath ?? node.dataset.newPath ?? node.dataset.path ?? node.dataset.oldPath;
  return value?.trim() || undefined;
}

/** 文件头路径来源按可信度排：data-file-path → blob 链接 href → 标题 title → 标题文本。 */
function containerPath(container: HTMLElement): string {
  const direct = datasetPath(container)
    ?? datasetPath(container.querySelector('[data-file-path], [data-new-path], [data-path], [data-old-path]'));
  if (direct) return direct;

  const scope = container.querySelector<HTMLElement>(HEADER_SELECTOR) ?? container;
  const href = scope.querySelector<HTMLAnchorElement>('a[href*="/blob/"], a[href*="/raw/"]')?.getAttribute('href') ?? '';
  const fromHref = /\/(?:blob|raw)\/[^/]+\/(.+)$/.exec(href);
  if (fromHref) {
    const path = fromHref[1].split(/[?#]/)[0];
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }

  const title = scope.querySelector<HTMLElement>('.file-title-name, .file-title, [data-testid="diff-file-title"]');
  return title?.getAttribute('title')?.trim() || title?.textContent?.trim() || '';
}

/** 文件容器可能套着好几层标记（.diff-file 外层 + 内层 [data-file-path]），只保留最外面那层。 */
function fileContainers(doc: Document): HTMLElement[] {
  const nodes = [...doc.querySelectorAll<HTMLElement>(FILE_SELECTOR)];
  return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
}

/** 页面文件头可能只渲染 basename，或渲染相对子目录的路径，所以按目录后缀双向互查。 */
function matchesWanted(pagePath: string, wanted: string[]) {
  if (wanted.some((want) => repoPathEquals(pagePath, want))) return true;
  const rendered = pagePath.replace(/^\/+/, '');
  return wanted.some((want) => `/${want.replace(/^\/+/, '')}`.endsWith(`/${rendered}`)
    || rendered.endsWith(`/${want.replace(/^\/+/, '')}`));
}

function wantedPaths(target: LocateTarget) {
  return [target.path, target.newPath, target.oldPath].filter((path): path is string => Boolean(path));
}

function findFileContainer(doc: Document, target: LocateTarget): HTMLElement | undefined {
  const wanted = wantedPaths(target);
  return fileContainers(doc).find((container) => {
    const path = containerPath(container);
    return path.length > 0 && matchesWanted(path, wanted);
  });
}

function findRow(container: HTMLElement, target: LocateTarget): HTMLElement | undefined {
  if (!(target.line > 0)) return undefined;
  for (const side of [target.side, otherSide(target.side)]) {
    const row = rowsOf(container).find((candidate) => rowLineNumber(candidate, side) === target.line);
    if (row) return row;
  }
  return undefined;
}

/** 行号在 DOM 里找不到时按代码原文兜底：虚拟滚动只渲染可视区，行号缺但文本还在。 */
function rowByContent(container: HTMLElement, target: LocateTarget): HTMLElement | undefined {
  const wanted = (target.existingCode ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0);
  if (!wanted) return undefined;
  let best: HTMLElement | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const row of rowsOf(container)) {
    const text = (row.querySelector<HTMLElement>(CODE_SELECTOR)?.textContent ?? '')
      .replace(/^[+-]\s?/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text !== wanted) continue;
    const line = rowLineNumber(row, target.side) ?? rowLineNumber(row, otherSide(target.side)) ?? 0;
    const gap = Math.abs(line - target.line);
    if (gap < bestGap) { bestGap = gap; best = row; }
  }
  return best;
}

/** 折叠段可能有好几个：挑「上方最后一个已知行号仍小于目标行」的那个，也就是最靠近目标的展开点。 */
function nearestExpander(container: HTMLElement, expanders: HTMLElement[], target: LocateTarget) {
  const rows = rowsOf(container);
  let best: HTMLElement | undefined;
  let bestLine = Number.NEGATIVE_INFINITY;
  for (const expander of expanders) {
    const index = rows.indexOf(expander.closest<HTMLElement>('tr, .line_holder, .diff-line') ?? expander);
    if (index < 0) continue;
    let previous: number | undefined;
    for (let cursor = index - 1; cursor >= 0 && previous === undefined; cursor -= 1) {
      previous = rowLineNumber(rows[cursor], target.side) ?? rowLineNumber(rows[cursor], otherSide(target.side));
    }
    if (previous !== undefined && previous >= target.line) continue;
    const rank = previous ?? Number.NEGATIVE_INFINITY;
    if (rank > bestLine) { bestLine = rank; best = expander; }
  }
  return best;
}

/** 目标行不在 DOM 里：先展开文件级折叠，再逐个展开「隐藏的 N 行」，每步都重新找行。 */
async function revealRow(container: HTMLElement, target: LocateTarget): Promise<HTMLElement | undefined> {
  const probe = () => findRow(container, target);
  const immediate = probe();
  if (immediate) return immediate;

  const deadline = Date.now() + REVEAL_BUDGET;
  const fileToggles = [...container.querySelectorAll<HTMLElement>(FILE_EXPAND_SELECTOR)];
  if (fileToggles.length > 0) {
    for (const toggle of fileToggles) toggle.click();
    const afterFile = await waitFor(probe, deadline - Date.now());
    if (afterFile) return afterFile;
  }

  const tried = new Set<HTMLElement>();
  for (let round = 0; round < EXPAND_ROUNDS && Date.now() < deadline; round += 1) {
    const expanders = [...container.querySelectorAll<HTMLElement>(LINE_EXPAND_SELECTOR)]
      .filter((node) => !tried.has(node));
    if (expanders.length === 0) break;
    const next = nearestExpander(container, expanders, target) ?? expanders[0];
    tried.add(next);
    next.click();
    const revealed = await waitFor(probe, deadline - Date.now());
    if (revealed) return revealed;
  }
  return undefined;
}

function decorate(row: HTMLElement, target: LocateTarget) {
  row.setAttribute('data-ra-highlight', 'true');
  row.classList.add('ra-finding-highlight');
  if (row.querySelector('.ra-finding-marker')) return;
  const indicator = document.createElement('div');
  indicator.className = `ra-finding-marker severity-${target.severity}`;
  indicator.title = `${target.severity}: ${target.title}`;
  indicator.textContent = target.severity === 'critical' || target.severity === 'high' ? '!' : '•';
  // tr 里直接塞 div 会破坏表格布局，徽标挂到第一个单元格上
  const host = row.matches('tr') ? row.querySelector<HTMLElement>('td, th') ?? row : row;
  host.style.position = 'relative';
  host.prepend(indicator);
}

function rowsInRange(container: HTMLElement, target: LocateTarget, anchor: HTMLElement): HTMLElement[] {
  if (!(target.line > 0)) return [anchor];
  const end = Math.max(target.line, target.endLine);
  const ranged = rowsOf(container).filter((row) => {
    const line = rowLineNumber(row, target.side) ?? rowLineNumber(row, otherSide(target.side));
    return line !== undefined && line >= target.line && line <= end;
  });
  return ranged.length > 0 ? ranged : [anchor];
}

function hasDiffFiles(doc: Document) {
  return doc.querySelector(FILE_SELECTOR) !== null;
}

function changesTab(doc: Document): HTMLAnchorElement | undefined {
  const scoped = [...doc.querySelectorAll<HTMLAnchorElement>(
    'nav a, .nav-tabs a, [data-testid="tabs"] a, ul.nav a, .merge-request-tabs a, .issuable-tabs a',
  )];
  const links = scoped.length > 0 ? scoped : [...doc.querySelectorAll<HTMLAnchorElement>('a[href$="/diffs"]')];
  return links.find((link) => TAB_LABEL.test(link.textContent?.trim() ?? '')
    || /\/diffs(?:[?#]|$)/.test(link.getAttribute('href') ?? ''));
}

/** GitLab 的 MR tab 是整页链接：切到 Changes 会重新加载，定位意图先落盘，新页面加载后接管。 */
export function savePendingLocate(target: LocateTarget) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...target, savedAt: Date.now() }));
  } catch { /* 隐私模式下 sessionStorage 会抛 */ }
}

export function clearPendingLocate() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch { /* 同上 */ }
}

/** 整页跳转前存下的定位目标；过期或残缺就丢掉，新页面不会拿着旧意图乱跳。 */
export function takePendingLocate(): LocateTarget | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as LocateTarget & { savedAt?: number };
    if (!parsed.path || !(parsed.line > 0)) return undefined;
    if (Date.now() - (parsed.savedAt ?? 0) > PENDING_TTL) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 把目标行滚到可视区并高亮。定位是有前置条件的：
 * 不在 Changes 视图先切过去、文件被折叠先展开、目标行落在「隐藏的 N 行」里先展开折叠段，
 * 三步都走完还找不到行才降级为滚动到文件头，找不到文件则如实报告。
 */
export async function highlightFindingOnPage(target: LocateTarget): Promise<LocateOutcome> {
  clearHighlights();
  const doc = document;
  const missed = { highlighted: [], fileLevel: false } as LocateOutcome;

  if (!hasDiffFiles(doc)) {
    const tab = changesTab(doc);
    if (!tab) return { ...missed, failure: 'no-diff-tab' };
    savePendingLocate(target);
    tab.click();
    if (await waitFor(() => hasDiffFiles(doc) ? true : undefined, 5000) === undefined) {
      return { ...missed, failure: 'navigated' };
    }
    clearPendingLocate();
  }

  let container = await waitFor(() => findFileContainer(doc, target), 3000);
  if (!container) {
    // diff 文件列表可能还在分批加载
    for (const button of doc.querySelectorAll<HTMLElement>(LOAD_MORE_SELECTOR)) button.click();
    container = await waitFor(() => findFileContainer(doc, target), 3000);
  }
  if (!container) return { ...missed, failure: 'file-not-found' };

  const row = await revealRow(container, target) ?? rowByContent(container, target);
  if (!row) {
    (container.querySelector<HTMLElement>(HEADER_SELECTOR) ?? container)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
    return { highlighted: [], fileLevel: true, failure: 'line-not-found' };
  }

  const highlighted = rowsInRange(container, target, row);
  for (const item of highlighted) decorate(item, target);
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return { highlighted, fileLevel: false };
}

/**
 * Clear all finding highlights from the page.
 */
export function clearHighlights(): void {
  document.querySelectorAll('[data-ra-highlight]').forEach((el) => {
    el.removeAttribute('data-ra-highlight');
    el.classList.remove('ra-finding-highlight');
  });
  document.querySelectorAll('.ra-finding-marker').forEach((el) => el.remove());
}

/**
 * Add persistent visual style for finding highlights.
 * Injected once into the page.
 */
export function injectHighlightStyles(): void {
  if (document.getElementById('ra-finding-highlight-styles')) return;

  const style = document.createElement('style');
  style.id = 'ra-finding-highlight-styles';
  style.textContent = `
    .ra-finding-highlight {
      box-shadow: inset 4px 0 0 #2f6fed !important;
      background: rgba(47, 111, 237, 0.08) !important;
    }
    .ra-finding-marker {
      position: absolute;
      left: -24px;
      top: 50%;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font-size: 11px;
      font-weight: 700;
      color: #fff;
      z-index: 10;
      pointer-events: none;
    }
    .ra-finding-marker.severity-critical,
    .ra-finding-marker.severity-high { background: #d3453b; }
    .ra-finding-marker.severity-medium { background: #d39a27; }
    .ra-finding-marker.severity-low { background: #3c78c7; }
  `;
  document.head.appendChild(style);
}
