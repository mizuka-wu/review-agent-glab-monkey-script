import { debugBus } from './debug-bus';
import { repoPathCandidates, repoPathEquals } from './diff';
import type {
  DiffLine,
  FileDiff,
  Finding,
  FullFileSnapshot,
  PositionLineRef,
} from './types';

interface AnchorMatch {
  path: string;
  start: number;
  end: number;
  side: 'old' | 'new';
  source: 'diff' | 'full-file';
  file?: FileDiff;
}

function normalizeCode(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim());
}

/** 代码行比对忽略缩进和内部多余空白：模型抄片段时常把 tab 换成空格、对齐补空格。 */
function loose(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/** 完整文件上下文渲染成「42: code」，模型经常把行号一起抄进 existingCode。 */
const LINE_NUMBER_PREFIX = /^\d{1,6}\s*[:|\u2502>]\s*/;
/** 模型直接复制 diff 文本时会带上 +/- 前缀；--- +++ 文件头不算。 */
const DIFF_MARKER_PREFIX = /^(?![-+]{3})[-+]\s?/;

function stripPrefix(lines: string[], pattern: RegExp) {
  return lines.map((line) => line.replace(pattern, ''));
}

function trimEdges(lines: string[]) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].length === 0) start += 1;
  while (end > start && lines[end - 1].length === 0) end -= 1;
  return lines.slice(start, end);
}

/**
 * 一个代码片段的全部可搜索写法，按可信度排序：原文 → 去行号 → 去 diff 前缀 → 去掉空行。
 * 首尾空行是模型多带的换行，直接剪掉；中间空行是「行号连续」的依据，只能作为最后一种兜底写法整体去掉。
 */
function snippetVariants(value: string): string[][] {
  const base = trimEdges(normalizeCode(value));
  if (base.length === 0) return [];
  const variants = [base];
  const denumbered = stripPrefix(base, LINE_NUMBER_PREFIX);
  if (denumbered.some((line, index) => line !== base[index])) variants.push(denumbered);
  const unmarked = stripPrefix(denumbered, DIFF_MARKER_PREFIX);
  if (unmarked.some((line, index) => line !== denumbered[index])) variants.push(unmarked);
  const dense = unmarked.filter((line) => line.length > 0);
  if (dense.length > 0 && dense.length !== unmarked.length) variants.push(dense);
  return variants;
}

/** Finding 自带的可搜索代码片段（含写法变体）；suggestionCode 是「应改成什么」，不参与匹配。 */
function searchSnippets(finding: Finding) {
  return [finding.existingCode, ...finding.evidence.map((evidence) => evidence.quote)]
    .flatMap(snippetVariants);
}

function diffMatches(file: FileDiff, target: string[], side: 'old' | 'new'): AnchorMatch[] {
  const candidates = file.lines.filter((line) => side === 'new' ? line.newLine !== undefined : line.oldLine !== undefined);
  const wanted = target.map(loose);
  const matches: AnchorMatch[] = [];
  for (let index = 0; index <= candidates.length - target.length; index += 1) {
    const slice = candidates.slice(index, index + target.length);
    const sameHunk = slice.every((line) => line.hunkId === slice[0].hunkId);
    const consecutive = slice.every((line, offset) => {
      if (offset === 0) return true;
      const previous = slice[offset - 1];
      return side === 'new'
        ? line.newLine === previous.newLine! + 1
        : line.oldLine === previous.oldLine! + 1;
    });
    if (!sameHunk || !consecutive || !slice.every((line, offset) => loose(line.text) === wanted[offset])) continue;
    matches.push({
      path: file.newPath === '/dev/null' ? file.oldPath : file.newPath,
      start: side === 'new' ? slice[0].newLine! : slice[0].oldLine!,
      end: side === 'new' ? slice.at(-1)!.newLine! : slice.at(-1)!.oldLine!,
      side,
      source: 'diff',
      file,
    });
  }
  return matches;
}

function fullFileMatches(snapshot: FullFileSnapshot, target: string[]): AnchorMatch[] {
  const matches: AnchorMatch[] = [];
  for (let index = 0; index <= snapshot.lines.length - target.length; index += 1) {
    if (!target.every((line, offset) => loose(snapshot.lines[index + offset]) === loose(line))) continue;
    matches.push({
      path: snapshot.path,
      start: index + 1,
      end: index + target.length,
      side: 'new',
      source: 'full-file',
    });
  }
  return matches;
}

/** rename 后 Finding 可能只带 oldPath，匹配结果可能只带 newPath：两侧都要互查。 */
function preferredMatches(finding: Finding, matches: AnchorMatch[]) {
  const wanted = [
    finding.path,
    finding.newPath,
    finding.oldPath,
    ...finding.evidence.map((evidence) => evidence.path),
  ].filter((path): path is string => Boolean(path));
  const preferred = matches.filter((match) => [match.path, match.file?.newPath, match.file?.oldPath]
    .filter((path): path is string => Boolean(path))
    .some((path) => wanted.some((want) => repoPathEquals(path, want))));
  return preferred.length > 0 ? preferred : matches;
}

function chooseMatch(finding: Finding, input: AnchorMatch[]) {
  const matches = preferredMatches(finding, input);
  if (matches.length === 1) return matches[0];
  if (!Number.isInteger(finding.line) || finding.line < 1) return undefined;
  const containingLine = matches.filter((match) => match.start <= finding.line && finding.line <= match.end);
  return containingLine.length === 1 ? containingLine[0] : undefined;
}

function applyMatch(finding: Finding, match: AnchorMatch): Finding {
  const relocatedFromPath = repoPathEquals(finding.path, match.path) ? undefined : finding.path;
  return {
    ...finding,
    path: match.path,
    oldPath: match.file?.oldPath ?? match.path,
    newPath: match.file?.newPath ?? match.path,
    newFile: match.file?.newFile,
    deletedFile: match.file?.deletedFile,
    line: match.start,
    endLine: match.end,
    side: match.side,
    anchor: {
      source: match.source,
      publishable: match.source === 'diff',
      ...(relocatedFromPath ? { relocatedFromPath } : {}),
    },
  };
}

export function resolveFindingAnchor(
  finding: Finding,
  files: FileDiff[],
  fullFiles: FullFileSnapshot[] = [],
): Finding | undefined {
  const variants = snippetVariants(finding.existingCode);
  if (variants.length > 0) {
    for (const target of variants) {
      const diff = files.flatMap((file) => [
        ...diffMatches(file, target, finding.side),
        ...diffMatches(file, target, finding.side === 'new' ? 'old' : 'new'),
      ]);
      const diffMatch = chooseMatch(finding, diff);
      if (diffMatch) return applyMatch(finding, diffMatch);
      if (diff.length > 0) return undefined;
    }

    const full = fullFiles.flatMap(
      (snapshot) => variants.flatMap((target) => fullFileMatches(snapshot, target)),
    );
    const fullMatch = chooseMatch(finding, full);
    return fullMatch ? applyMatch(finding, fullMatch) : undefined;
  }

  const lineMatches = files.flatMap((file) => file.lines
    .filter((line) => finding.side === 'new' ? line.newLine === finding.line : line.oldLine === finding.line)
    .map((): AnchorMatch => ({
      path: file.newPath === '/dev/null' ? file.oldPath : file.newPath,
      start: finding.line,
      end: finding.endLine || finding.line,
      side: finding.side,
      source: 'diff',
      file,
    })));
  const match = chooseMatch(finding, lineMatches);
  return match ? applyMatch(finding, match) : undefined;
}

export function anchorFindings(
  findings: Finding[],
  files: FileDiff[],
  fullFiles: FullFileSnapshot[] = [],
) {
  return findings
    .map((finding) => resolveFindingAnchor(finding, files, fullFiles))
    .filter((finding): finding is Finding => Boolean(finding));
}

// --- 发布位置校验 / 自动修正 ---

/** 模糊匹配可接受的最低相似度：GitLab 只接受落在 diff 行上的位置，猜错不如不发。 */
const FUZZY_THRESHOLD = 0.7;
/** 无任何可搜索内容时，允许按邻近上下文修正的最大行距。 */
const PROXIMITY_WINDOW = 50;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]{3,}/g;
const COMMON_IDENTIFIERS = new Set([
  'true', 'false', 'null', 'undefined', 'return', 'function', 'const', 'class', 'import', 'export',
  'default', 'extends', 'implements', 'interface', 'this', 'typeof', 'instanceof', 'await', 'async',
  'throw', 'catch', 'finally', 'public', 'private', 'protected', 'static', 'readonly', 'void',
  'never', 'unknown', 'string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'none', 'lambda',
  'else', 'elif', 'while', 'with', 'from', 'pass', 'break', 'continue', 'self', 'type', 'enum',
  'value', 'values', 'data', 'item', 'items', 'index', 'result', 'results', 'error', 'errors',
  'file', 'files', 'path', 'name', 'test', 'tests', 'should', 'when', 'then', 'expect', 'describe',
]);

/** 行内位置降级为全文评论的机器可读原因，写进 debugBus 便于统计还剩哪些场景。 */
export type PublishBlockCode = 'no-diff' | 'path-not-in-diff' | 'line-not-in-diff' | 'full-file-only';

export interface PublishPosition {
  publishable: boolean;
  /** publishable 为 false 时的用户可见原因。 */
  reason?: string;
  reasonCode?: PublishBlockCode;
  /** 位置由内容匹配重新定位得到，与 Finding 原行号不同。 */
  corrected?: boolean;
  /** GitLab 行内评论要的起止行 old/new 行号配对，取自真实 diff 行。 */
  lines?: { start: PositionLineRef; end: PositionLineRef };
  finding: Finding;
}

function sideValue(line: DiffLine, side: 'old' | 'new') {
  return side === 'new' ? line.newLine! : line.oldLine!;
}

function sideEntries(file: FileDiff, side: 'old' | 'new') {
  return file.lines.filter((line) => (side === 'new' ? line.newLine : line.oldLine) !== undefined);
}

function contiguous(slice: DiffLine[], side: 'old' | 'new') {
  return slice.every((line, offset) =>
    offset === 0 || sideValue(line, side) === sideValue(slice[offset - 1], side) + 1);
}

function toMatch(file: FileDiff, slice: DiffLine[], side: 'old' | 'new'): AnchorMatch {
  return {
    path: file.newPath === '/dev/null' ? file.oldPath : file.newPath,
    start: sideValue(slice[0], side),
    end: sideValue(slice[slice.length - 1], side),
    side,
    source: 'diff',
    file,
  };
}

function coversDiff(file: FileDiff, side: 'old' | 'new', start: number, end: number) {
  if (!Number.isInteger(start) || start < 1) return false;
  const entries = sideEntries(file, side);
  const from = entries.findIndex((line) => sideValue(line, side) === start);
  if (from < 0) return false;
  if (!Number.isInteger(end) || end <= start) return true;
  const to = entries.findIndex((line) => sideValue(line, side) === end);
  return to > from && contiguous(entries.slice(from, to + 1), side);
}

function sliceLines(file: FileDiff, side: 'old' | 'new', start: number, end: number) {
  const entries = sideEntries(file, side);
  const from = entries.findIndex((line) => sideValue(line, side) === start);
  const to = entries.findIndex((line) => sideValue(line, side) === end);
  return entries.slice(from, to >= from ? to + 1 : from + 1);
}

function lineMatch(file: FileDiff, side: 'old' | 'new', start: number, end: number): AnchorMatch {
  return toMatch(file, sliceLines(file, side, start, end), side);
}

function otherSide(side: 'old' | 'new'): 'old' | 'new' {
  return side === 'new' ? 'old' : 'new';
}

function bothSides(side: 'old' | 'new'): ('old' | 'new')[] {
  return [side, otherSide(side)];
}

function compact(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function bigrams(value: string) {
  const grams = new Set<string>();
  for (let index = 0; index + 1 < value.length; index += 1) grams.add(value.slice(index, index + 2));
  return grams;
}

function similarity(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const target = bigrams(left);
  const source = bigrams(right);
  let shared = 0;
  for (const gram of target) if (source.has(gram)) shared += 1;
  return (2 * shared) / (target.size + source.size);
}

function identifiers(text: string) {
  const tokens = new Set<string>();
  for (const token of text.match(IDENTIFIER) ?? []) {
    const key = token.toLowerCase();
    if (!COMMON_IDENTIFIERS.has(key)) tokens.add(key);
  }
  return tokens;
}

function nearestTo(matches: AnchorMatch[], hint: number) {
  return [...matches].sort((left, right) => Math.abs(left.start - hint) - Math.abs(right.start - hint))[0];
}

function snippetMatch(finding: Finding, file: FileDiff) {
  const sides = bothSides(finding.side);
  for (const snippet of searchSnippets(finding)) {
    for (const side of sides) {
      const exact = diffMatches(file, snippet, side);
      if (exact.length > 0) return nearestTo(exact, finding.line);
    }
  }
  return undefined;
}

function fuzzyMatch(file: FileDiff, target: string[], side: 'old' | 'new') {
  const entries = sideEntries(file, side);
  let best: { score: number; match: AnchorMatch } | undefined;
  for (let index = 0; index + target.length <= entries.length; index += 1) {
    const slice = entries.slice(index, index + target.length);
    if (!contiguous(slice, side)) continue;
    const score = slice.reduce(
      (sum, line, offset) => sum + similarity(compact(line.text), target[offset]), 0,
    ) / target.length;
    if (score < FUZZY_THRESHOLD) continue;
    if (!best || score > best.score) best = { score, match: toMatch(file, slice, side) };
  }
  return best?.match;
}

function tokenMatch(file: FileDiff, tokens: Set<string>, side: 'old' | 'new', hint: number) {
  const required = Math.min(2, tokens.size);
  const scored = sideEntries(file, side)
    .map((line) => ({ line, score: [...identifiers(line.text)].filter((token) => tokens.has(token)).length }))
    .filter((entry) => entry.score >= required)
    .sort((left, right) => right.score - left.score
      || Math.abs(sideValue(left.line, side) - hint) - Math.abs(sideValue(right.line, side) - hint));
  return scored[0] ? toMatch(file, [scored[0].line], side) : undefined;
}

function nearestMatch(file: FileDiff, side: 'old' | 'new', hint: number) {
  let best: DiffLine | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const entry of sideEntries(file, side)) {
    const gap = Math.abs(sideValue(entry, side) - hint);
    if (gap < distance) { distance = gap; best = entry; }
  }
  return best && distance <= PROXIMITY_WINDOW ? toMatch(file, [best], side) : undefined;
}

/** 同一文件内按「代码片段精确 → 代码片段模糊 → 标识符 → 邻近上下文」逐级降级重定位。 */
function relocate(finding: Finding, file: FileDiff) {
  const sides = bothSides(finding.side);
  const snippets = searchSnippets(finding);
  const exact = snippetMatch(finding, file);
  if (exact) return exact;

  for (const snippet of snippets) {
    const target = snippet.map(compact);
    const longest = target.reduce((left, right) => (right.length > left.length ? right : left), target[0]);
    for (const side of sides) {
      const match = fuzzyMatch(file, target, side)
        ?? (target.length > 1 ? fuzzyMatch(file, [longest], side) : undefined);
      if (match) return match;
    }
  }

  const tokens = identifiers([finding.title, finding.content, ...snippets.flat()].join('\n'));
  for (const side of sides) {
    if (tokens.size > 0) {
      const match = tokenMatch(file, tokens, side, finding.line);
      if (match) return match;
    }
    if (snippets.length === 0 && tokens.size === 0) {
      const match = nearestMatch(file, side, finding.line);
      if (match) return match;
    }
  }

  return undefined;
}

/** diff 文件的路径索引：newPath / oldPath 双向登记，精确 → 大小写不敏感 → 目录后缀逐级兜底。 */
interface FileIndex {
  byPath: Map<string, FileDiff>;
  files: FileDiff[];
}

function fileIndex(files: FileDiff[]): FileIndex {
  const byPath = new Map<string, FileDiff>();
  for (const file of files) {
    for (const raw of [file.newPath, file.oldPath]) {
      if (raw === '/dev/null') continue;
      for (const key of repoPathCandidates(raw)) {
        byPath.set(key, file);
        byPath.set(key.toLowerCase(), file);
      }
    }
  }
  return { byPath, files };
}

function lookupPath(index: FileIndex, path: string | undefined): FileDiff | undefined {
  if (!path) return undefined;
  const candidates = repoPathCandidates(path);
  for (const key of candidates) {
    const hit = index.byPath.get(key) ?? index.byPath.get(key.toLowerCase());
    if (hit) return hit;
  }
  // 模型有时给出相对子目录的路径，按目录后缀匹配（比整串相等宽松，但比 basename 唯一性可靠）
  const suffixes = candidates.map((key) => `/${key.toLowerCase()}`);
  return index.files.find((file) => [file.newPath, file.oldPath].some((raw) => {
    const normalized = repoPathCandidates(raw)[0]?.toLowerCase();
    return normalized !== undefined && suffixes.some((suffix) => normalized.endsWith(suffix));
  }));
}

/** rename 场景 old↔new 都要查：Finding 可能只带旧路径，diff 文件可能只登记新路径。 */
function matchFile(finding: Finding, index: FileIndex) {
  for (const path of [finding.newPath, finding.path, finding.oldPath]) {
    const file = lookupPath(index, path);
    if (file) return file;
  }
  return undefined;
}

const reportedDowngrades = new Set<string>();
const REPORTED_LIMIT = 400;

/** 降级只在首次出现时记一条，评审流式更新会反复重算同一批 Finding，不能每次都刷日志。 */
function blocked(finding: Finding, code: PublishBlockCode, reason: string): PublishPosition {
  const key = `${finding.id}:${code}:${finding.line}`;
  if (!reportedDowngrades.has(key)) {
    if (reportedDowngrades.size >= REPORTED_LIMIT) reportedDowngrades.clear();
    reportedDowngrades.add(key);
    debugBus.log('warn', 'anchor', `行内评论降级为全文：${reason}`, [
      `code=${code}`,
      `path=${finding.path}`,
      `line=${finding.line}${finding.endLine > finding.line ? `-${finding.endLine}` : ''}`,
      `side=${finding.side}`,
      `anchor=${finding.anchor?.source ?? 'diff'}`,
      `snippet=${finding.existingCode ? 'yes' : 'no'}`,
    ].join(' · '));
  }
  return { publishable: false, reason, reasonCode: code, finding };
}

/** diff 行上真实存在的行号配对：added 行没有 oldLine，removed 行没有 newLine，context 行两者都有。 */
function lineRefAt(file: FileDiff, side: 'old' | 'new', line: number): PositionLineRef | undefined {
  const row = sideEntries(file, side).find((candidate) => sideValue(candidate, side) === line);
  return row && { oldLine: row.oldLine, newLine: row.newLine };
}

/**
 * GitLab 只认 diff 行上真实存在的 (old_line, new_line) 配对：自己凑一对或只填一侧都会让 line_code
 * 落空、整条评论被 400 拒掉，所以发布位置直接带上起止行的真实配对，由 buildDiscussionPayload 原样发出。
 */
function matchLines(match: AnchorMatch) {
  if (!match.file) return undefined;
  const start = lineRefAt(match.file, match.side, match.start);
  const end = lineRefAt(match.file, match.side, match.end);
  return start && end ? { start, end } : undefined;
}

function resolved(finding: Finding, match: AnchorMatch): PublishPosition {
  const anchored = applyMatch(finding, match);
  const changed = anchored.path !== finding.path || anchored.line !== finding.line
    || anchored.endLine !== finding.endLine || anchored.side !== finding.side;
  const anchor = { ...anchored.anchor!, ...(changed || finding.anchor?.corrected ? { corrected: true } : {}) };
  const lines = matchLines(match);
  return {
    publishable: true,
    ...(changed ? { corrected: true } : {}),
    finding: { ...anchored, anchor },
    ...(lines ? { lines } : {}),
  };
}

/** 行号直接命中 diff：整段落得到最好，endLine 越界就收敛成单行。 */
function directLineMatch(finding: Finding, file: FileDiff): AnchorMatch | undefined {
  const end = finding.endLine > finding.line ? finding.endLine : finding.line;
  if (coversDiff(file, finding.side, finding.line, end)) {
    return lineMatch(file, finding.side, finding.line, end);
  }
  if (end > finding.line && coversDiff(file, finding.side, finding.line, finding.line)) {
    return lineMatch(file, finding.side, finding.line, finding.line);
  }
  return undefined;
}

/**
 * 侧别不可信时的行号采信条件：full-file 锚的行号是 head 版本绝对行号（语义上等于 diff 的 new 侧），
 * normalizeFindings 在行号落不到 diff 时也会随手把 side 填成 'old'。
 * 这两种情况光行号相同不足以证明是同一处，必须那一行的内容也对得上，否则宁可降级也不发错行。
 */
function verifiedLineMatch(
  finding: Finding,
  file: FileDiff,
  sides: ('old' | 'new')[],
): AnchorMatch | undefined {
  const snippet = searchSnippets(finding)[0];
  if (!snippet) return undefined;
  const end = finding.endLine > finding.line ? finding.endLine : finding.line;
  for (const side of sides) {
    if (!coversDiff(file, side, finding.line, end)) continue;
    const rows = sliceLines(file, side, finding.line, end);
    if (rows.length === 0 || rows.length > snippet.length) continue;
    if (rows.every((row, offset) => loose(row.text) === loose(snippet[offset]))) {
      return toMatch(file, rows, side);
    }
  }
  return undefined;
}

/**
 * 发布前把 Finding 的行号对到该文件真实的 diff 行号集合上：命中就直接发布；
 * 对不上（diff 折叠、上下文偏移、renamed path、侧别填错）就按 Finding 自身内容重新定位；
 * 内容也匹配不上才判为不可发布，避免把 422 留给 GitLab。
 */
export function resolvePublishPosition(finding: Finding, files: FileDiff[]): PublishPosition {
  if (files.length === 0) return blocked(finding, 'no-diff', '当前 Diff 尚未加载，无法校验评论位置');

  const index = fileIndex(files);
  const file = matchFile(finding, index);
  if (!file) {
    const relocated = files.map((candidate) => snippetMatch(finding, candidate)).find((match) => match !== undefined);
    return relocated
      ? resolved(finding, relocated)
      : blocked(finding, 'path-not-in-diff', `${finding.path} 不在当前 Diff 中，无法定位行内评论`);
  }

  const fullFileOnly = finding.anchor?.source === 'full-file';
  const lineHit = fullFileOnly
    ? verifiedLineMatch(finding, file, bothSides('new'))
    : directLineMatch(finding, file) ?? verifiedLineMatch(finding, file, [otherSide(finding.side)]);
  if (lineHit) return resolved(finding, lineHit);

  const match = relocate(finding, file);
  if (match) return resolved(finding, match);

  return blocked(finding, fullFileOnly ? 'full-file-only' : 'line-not-in-diff', fullFileOnly
    ? '该 Finding 只锚定到完整文件，当前 Diff 里没有可对应的行'
    : `Diff 中找不到第 ${finding.line} 行，且无法按 Finding 内容自动修正位置`);
}
