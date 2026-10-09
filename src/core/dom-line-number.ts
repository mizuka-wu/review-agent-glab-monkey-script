/**
 * GitLab 各版本把行号写在 DOM 的不同位置：老版是行号格里的 a[data-line-number]、代码格里的 span#LC11，
 * 新版把属性拼成 data-linenumber，19.x 的 grid diff 还把 data-interop-line 挂在格子外面那层 side wrapper 上。
 * 划词取行号（selection）与 Finding 定位（finding-highlight）共用这一套读法，同一行两边必须读出同一个数。
 */

export type LineSide = 'old' | 'new' | 'unified';

/** 行号格：格内文本可能就是行号本身。代码格永远不算，格内文本是代码。 */
const GUTTER_SELECTOR = '.old_line, .new_line, .diff-line-num, .diff-line-numbers, .line_numbers, [data-side], [data-testid$="line-number"]';
const CODE_SELECTOR = '.line_content, .blob-code';
/** 侧别标记：行号格、代码格与 19.x 的 side wrapper 都可能带，用来判断某个行号属于哪一侧。 */
const SIDE_SELECTOR = '.old_line, .new_line, [data-side], [data-interop-type]';
const SIDE_ATTR_SELECTOR = '[data-old-line-number], [data-new-line-number], [data-interop-old-line], [data-interop-new-line], [data-interop-type]';
/** 行号常常不在节点自身而在子节点上：行号格里的 a、老版代码格里的 span#LC11 / span#L11。 */
const LINE_NODE_SELECTOR = '[data-linenumber], [data-line-number], [data-line], [data-old-line-number], [data-new-line-number], '
  + '[data-interop-line], [data-interop-old-line], [data-interop-new-line], [id^="LC"], [id^="L"]';
/** 行 id 的两种编码：单号 LC11 / L11，双号 <sha>_<old>_<new>（经典 inline 写 sha_，19.x grid 写文件 sha）。 */
const SINGLE_ID = /^(?:LC|L)(\d+)$/;
const PAIR_ID = /_(\d*)_(\d*)$/;

/** 只接受「整格就是一个数字」的文本，避免把代码里的数字当成行号。 */
export function plainLineNumber(value: string | null | undefined): number | undefined {
  const match = value?.trim().match(/^\d+$/);
  const line = match ? Number(match[0]) : undefined;
  return line !== undefined && line > 0 ? line : undefined;
}

/** data-interop-line 是「本行所属侧」的行号，只有侧别吻合（或没标侧别）时才能用。 */
function interopLine(data: DOMStringMap | undefined, side: LineSide): string | undefined {
  if (!data) return undefined;
  return data.interopType === undefined || data.interopType === side ? data.interopLine : undefined;
}

/** 侧别明确的属性写法：data-old|new-line-number、data-interop-old|new-line，以及侧别吻合的 data-interop-line。 */
function sideAttrLineNumber(node: Element | null | undefined, side: LineSide): number | undefined {
  const data = node instanceof HTMLElement ? node.dataset : undefined;
  const sources = side === 'old'
    ? [data?.oldLineNumber, data?.interopOldLine, interopLine(data, side)]
    : [data?.newLineNumber, data?.interopNewLine, interopLine(data, side)];
  for (const source of sources) {
    const line = plainLineNumber(source);
    if (line !== undefined) return line;
  }
  return undefined;
}

/** 没标侧别的属性写法：data-linenumber（新版）/ data-line-number（旧版）/ data-line（Vue diff）。 */
function genericAttrLineNumber(node: Element | null | undefined): number | undefined {
  const data = node instanceof HTMLElement ? node.dataset : undefined;
  for (const source of [data?.linenumber, data?.lineNumber, data?.line]) {
    const line = plainLineNumber(source);
    if (line !== undefined) return line;
  }
  return undefined;
}

/** 行 id 里的行号：LC11 / L11 是单号，<sha>_<old>_<new> 缺哪侧哪段就是空。 */
export function idLineNumber(node: Element | null | undefined, side: LineSide): number | undefined {
  const id = node?.id ?? '';
  const single = SINGLE_ID.exec(id);
  if (single) return Number(single[1]);
  const pair = PAIR_ID.exec(id);
  if (!pair) return undefined;
  return Number(pair[side === 'old' ? 1 : 2]) || undefined;
}

/** 行号属性的新旧拼写都认；不含行 id。 */
export function attrLineNumber(node: Element | null | undefined, side: LineSide): number | undefined {
  return sideAttrLineNumber(node, side) ?? genericAttrLineNumber(node);
}

/** 节点自身的行号：属性优先，其次行 id。 */
function nodeLineNumber(node: Element | null | undefined, side: LineSide): number | undefined {
  return attrLineNumber(node, side) ?? idLineNumber(node, side);
}

/** 这个节点属于哪一侧：old/new 类名、data-side、19.x 的 data-interop-type。 */
export function sideOfNode(node: Element | null | undefined): 'old' | 'new' | undefined {
  if (!node) return undefined;
  const data = node instanceof HTMLElement ? node.dataset : undefined;
  if (data?.side === 'old' || data?.interopType === 'old' || node.classList.contains('old_line') || node.classList.contains('old')) return 'old';
  if (data?.side === 'new' || data?.interopType === 'new' || node.classList.contains('new_line') || node.classList.contains('new')) return 'new';
  return undefined;
}

/**
 * 一个节点上能读出的行号。侧别明确的写法随时可用；无侧别的 data-linenumber 与行 id 属于节点自己那一侧，
 * 侧别冲突时不能用（side-by-side 的旧侧行号套到新侧就是错的行）。
 */
function readableLineNumber(node: Element, side: LineSide): number | undefined {
  const explicit = sideAttrLineNumber(node, side);
  if (explicit !== undefined) return explicit;
  const marker = sideOfNode(node) ?? sideOfNode(node.closest(SIDE_SELECTOR));
  if (side !== 'unified' && marker !== undefined && marker !== side) return undefined;
  return genericAttrLineNumber(node) ?? idLineNumber(node, side);
}

/** 父层只认侧别明确的写法：side-by-side 行容器上那种无侧别 data-line-number 是新侧行号。 */
function ancestorSideLineNumber(node: Element, side: LineSide): number | undefined {
  const explicit = sideAttrLineNumber(node, side);
  if (explicit !== undefined) return explicit;
  if (side === 'unified') return genericAttrLineNumber(node) ?? idLineNumber(node, side);
  const marker = sideOfNode(node);
  return marker !== undefined && marker !== side ? undefined : idLineNumber(node, side);
}

function isGutterCell(cell: Element): boolean {
  return !cell.matches(CODE_SELECTOR) && cell.matches(GUTTER_SELECTOR);
}

/** 一行的行号格：命中侧的优先，其次没标侧别的（blob / 简化 DOM）。19.x 一行里有两格（评论按钮 + 行号），逐个试到读出为止。 */
function gutterCells(row: Element | null | undefined, side: LineSide): HTMLElement[] {
  const cells = [...(row?.querySelectorAll<HTMLElement>(GUTTER_SELECTOR) ?? [])].filter(isGutterCell);
  return [...cells.filter((cell) => sideOfNode(cell) === side), ...cells.filter((cell) => sideOfNode(cell) === undefined)];
}

/**
 * 侧别明确的行号（data-interop-old|new-line / data-old|new-line-number）优先于无侧别的 data-linenumber：
 * 19.x inline 视图一行有两格行号（旧号在前、新号在后），上下文行两格数字还不一样，只有 interop 属性分得清两侧。
 */
function explicitLineNumber(root: Element, side: LineSide): number | undefined {
  const self = sideAttrLineNumber(root, side);
  if (self !== undefined) return self;
  for (const node of root.querySelectorAll<HTMLElement>(SIDE_ATTR_SELECTOR)) {
    const line = sideAttrLineNumber(node, side);
    if (line !== undefined) return line;
  }
  return undefined;
}

/** 子节点里的行号：老版 span#LC11 在代码格里，新版 a[data-linenumber] 在行号格里，19.x 的 data-interop-* 在 side wrapper 上。 */
function descendantLineNumber(root: Element | null | undefined, side: LineSide): number | undefined {
  for (const node of root?.querySelectorAll<HTMLElement>(LINE_NODE_SELECTOR) ?? []) {
    const line = readableLineNumber(node, side);
    if (line !== undefined) return line;
  }
  return undefined;
}

/** 父层里的行号：19.x grid 把 data-interop-line 挂在格子外面那层 side wrapper 上。 */
export function ancestorLineNumber(node: Element | null | undefined, side: LineSide, boundary?: Element | null): number | undefined {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    const line = ancestorSideLineNumber(current, side);
    if (line !== undefined) return line;
    if (current === boundary) return undefined;
  }
  return undefined;
}

/** 行号格的行号：自身属性 / id → 子节点 → 格内文本（只有行号格的文本才是行号）。 */
function gutterLineNumber(gutter: Element | null | undefined, side: LineSide): number | undefined {
  if (!gutter) return undefined;
  return nodeLineNumber(gutter, side)
    ?? descendantLineNumber(gutter, side)
    ?? plainLineNumber(gutter.textContent);
}

/** 代码格 / 行号格里的行号；代码格还要往父层找（19.x 把 data-interop-line 挂在格子外面）。 */
export function cellLineNumber(cell: Element | null | undefined, side: LineSide, boundary?: Element | null): number | undefined {
  if (!cell) return undefined;
  if (isGutterCell(cell)) return gutterLineNumber(cell, side);
  return explicitLineNumber(cell, side)
    ?? nodeLineNumber(cell, side)
    ?? descendantLineNumber(cell, side)
    ?? ancestorLineNumber(cell, side, boundary);
}

/** 行容器的行号：行号格优先，其次行自身属性 / id，最后行内子节点。 */
export function rowLineNumber(row: Element | null | undefined, side: LineSide): number | undefined {
  if (!row) return undefined;
  const explicit = explicitLineNumber(row, side);
  if (explicit !== undefined) return explicit;
  for (const gutter of gutterCells(row, side)) {
    const line = gutterLineNumber(gutter, side);
    if (line !== undefined) return line;
  }
  return nodeLineNumber(row, side) ?? descendantLineNumber(row, side);
}
