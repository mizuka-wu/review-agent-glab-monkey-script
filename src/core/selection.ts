import type { CodeSelection } from './types';

type Side = CodeSelection['side'];

interface LineAnchor {
  side: Side;
  line?: number;
}

/** GitLab 各版本的 diff 行容器：经典 HAML 的 tr.line_holder、Vue diff 的 tr[data-line]、blob 视图的 tr#LC10。 */
const ROW_SELECTOR = 'tr, .line_holder, .diff-line, [data-line-number], [data-line], [id^="LC"]';
/** 选区可能落在代码格里，也可能落在行号格里。 */
const CELL_SELECTOR = '.line_content, .diff-line-numbers, .line_numbers, .old_line, .new_line, .blob-code, td';
/** 行号格：格内文本就是行号本身，可以安全解析（代码格不行）。 */
const GUTTER_SELECTOR = '.old_line, .new_line, .diff-line-numbers, .line_numbers, td[id^="L"], [data-side]';
const BLOB_SELECTOR = '.blob-viewer, .blob-content, table.text-file';
const FILE_SELECTOR = '.diff-file, .file-holder, .blob-viewer';
/** 代码格：格内文本是代码，任何情况下都不能拿来当行号。 */
const CODE_SELECTOR = '.line_content, .blob-code';

function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** 只接受「整格就是一个数字」的文本，避免把代码里的数字当成行号。 */
function lineNumber(value: string | null | undefined): number | undefined {
  const match = value?.trim().match(/^\d+$/);
  const line = match ? Number(match[0]) : undefined;
  return line !== undefined && line > 0 ? line : undefined;
}

function idLineNumber(node: Element | null | undefined): number | undefined {
  const match = node?.id.match(/^(?:LC|L)(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/** 行号格 / 行容器上的 old、new 标记，决定行号按哪一侧解释。 */
function sideOf(node: Element | null | undefined): Side | undefined {
  if (!node) return undefined;
  const explicit = node instanceof HTMLElement ? node.dataset.side : undefined;
  if (explicit === 'old' || node.classList.contains('old_line') || node.classList.contains('old')) return 'old';
  if (explicit === 'new' || node.classList.contains('new_line') || node.classList.contains('new')) return 'new';
  return undefined;
}

function isGutter(cell: HTMLElement): boolean {
  return !cell.matches(CODE_SELECTOR) && cell.matches(GUTTER_SELECTOR);
}

function guttersOf(row: HTMLElement | null): { old?: HTMLElement; new?: HTMLElement; plain?: HTMLElement } {
  const gutters: { old?: HTMLElement; new?: HTMLElement; plain?: HTMLElement } = {};
  for (const cell of row?.querySelectorAll<HTMLElement>(GUTTER_SELECTOR) ?? []) {
    if (!isGutter(cell)) continue;
    const side = sideOf(cell);
    if (side === 'old' && !gutters.old) gutters.old = cell;
    else if (side === 'new' && !gutters.new) gutters.new = cell;
    else if (!side && !gutters.plain) gutters.plain = cell;
  }
  return gutters;
}

/** 属性 / id 读行号：不解析文本，代码内容里的数字不是行号。 */
function attrLineNumber(node: Element | null | undefined, side: Side): number | undefined {
  const data = node instanceof HTMLElement ? node.dataset : undefined;
  const sources = [
    side === 'old' ? data?.oldLineNumber : data?.newLineNumber,
    data?.lineNumber,
    data?.line,
  ];
  for (const source of sources) {
    const line = lineNumber(source);
    if (line !== undefined) return line;
  }
  return idLineNumber(node);
}

function gutterLineNumber(node: HTMLElement | undefined, side: Side): number | undefined {
  if (!node) return undefined;
  const anchor = node.querySelector<HTMLElement>('[data-line-number], [data-line], [id^="L"]');
  return attrLineNumber(node, side) ?? attrLineNumber(anchor, side) ?? lineNumber(node.textContent);
}

function cellLineNumber(cell: HTMLElement | null, side: Side): number | undefined {
  if (!cell) return undefined;
  return isGutter(cell) ? gutterLineNumber(cell, side) : attrLineNumber(cell, side);
}

/** 优先命中侧的行号格，其次行容器属性，最后无侧别行号格（blob / 简化 DOM）。 */
function lineOf(row: HTMLElement | null, cell: HTMLElement | null, side: Side): number | undefined {
  const gutters = guttersOf(row);
  const sources = side === 'old'
    ? [gutterLineNumber(gutters.old, 'old'), attrLineNumber(row, 'old'), cellLineNumber(cell, 'old'), gutterLineNumber(gutters.plain, 'old')]
    : [gutterLineNumber(gutters.new ?? gutters.plain, 'new'), attrLineNumber(row, 'new'), cellLineNumber(cell, 'new')];
  return sources.find((line) => line !== undefined);
}

function anchorOf(element: Element | null): LineAnchor {
  const cell = element?.closest<HTMLElement>(CELL_SELECTOR) ?? null;
  const row = (cell ?? element)?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
  const side = sideOf(cell) ?? sideOf(row) ?? (row?.closest(BLOB_SELECTOR) ? 'unified' : 'new');
  return { side, line: lineOf(row, cell, side) };
}

/** rename 文件标题形如「old/path.ts → new/path.ts」，取箭头后面的新路径。 */
function titlePath(container: Element | null | undefined): string | undefined {
  const node = container?.querySelector<HTMLElement>(
    '.file-title-new, .file-title-name, .file-title-content a, .file-header-content, .file-title',
  );
  const title = trimmed(node?.textContent);
  return title?.split(/→|->|⇒/).map((part) => part.trim()).filter(Boolean).at(-1);
}

function datasetPath(node: HTMLElement | null | undefined): string | undefined {
  return trimmed(node?.dataset.filePath) ?? trimmed(node?.dataset.newPath) ?? trimmed(node?.dataset.path);
}

/** data-file-path 优先（rename 时它一定是新路径），标题文本只在属性缺失时兜底。 */
function pathFrom(element: Element | null, fallback: string): string {
  const attributed = element?.closest<HTMLElement>('[data-file-path], [data-new-path]');
  const container = element?.closest<HTMLElement>(FILE_SELECTOR);
  const nested = container?.querySelector<HTMLElement>('[data-file-path], [data-new-path], [data-path]');
  return datasetPath(attributed)
    ?? datasetPath(container)
    ?? datasetPath(nested)
    ?? titlePath(container)
    ?? fallback;
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** 选区覆盖的行数：只数行元素，不按文本换行猜（表格单元格的换行不是行边界）。 */
function spannedRows(range: Range): number {
  const rows = range.cloneContents().querySelectorAll('tr, .line_holder, .diff-line').length;
  return rows > 0 ? rows : 1;
}

/** 终点与起点不同侧时行号不可比；终点读不到行号就按覆盖行数推算，起点也读不到只能明示未知。 */
function endLineOf(range: Range, start: LineAnchor, end: LineAnchor): number | undefined {
  const comparable = end.side === start.side;
  if (start.line === undefined) return comparable ? end.line : undefined;
  if (end.line !== undefined && comparable) return Math.max(start.line, end.line);
  return start.line + spannedRows(range) - 1;
}

/** 选区行号文本："10-14" / "10"；页面 DOM 取不到行号时返回 undefined。 */
export function selectionLines(selection: CodeSelection): string | undefined {
  if (selection.startLine === undefined) return undefined;
  return selection.endLine !== undefined && selection.endLine > selection.startLine
    ? `${selection.startLine}-${selection.endLine}`
    : `${selection.startLine}`;
}

/** 工具栏 / 会话里的短标签：行号未知就直说，不编造 :1。 */
export function selectionLabel(selection: CodeSelection): string {
  const name = selection.filePath.replace(/^.*\//, '');
  return `${name}:${selectionLines(selection) ?? '行号未知'}${selection.side === 'old' ? '（旧侧）' : ''}`;
}

/** 拼进提问消息的引用：行号未知时降级为无行号引用。 */
export function selectionRef(selection: CodeSelection): string {
  const lines = selectionLines(selection);
  if (!lines) return `${selection.filePath}（行号未知）`;
  const side = selection.side === 'old' ? '删除侧 ' : selection.side === 'new' ? '新增侧 ' : '';
  return `${selection.filePath}（${side}L${lines}）`;
}

export function captureCodeSelection(
  doc: Document,
  defaultPath = '',
): CodeSelection | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return null;

  const startElement = elementOf(range.startContainer);
  const startAnchor = anchorOf(startElement);
  const endAnchor = anchorOf(elementOf(range.endContainer));
  const rect = range.getBoundingClientRect();

  return {
    filePath: pathFrom(startElement, defaultPath),
    side: startAnchor.side,
    startLine: startAnchor.line,
    endLine: endLineOf(range, startAnchor, endAnchor),
    text: text.slice(0, 3000),
    top: rect.top > 90 ? rect.top - 52 : rect.bottom + 10,
    left: Math.min(Math.max(rect.left + rect.width / 2, 190), window.innerWidth - 190),
  };
}
