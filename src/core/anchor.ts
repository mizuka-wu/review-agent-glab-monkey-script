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
  /** 命中的真实 diff 行：发布位置的行号配对只能从这里取，不能由行号反推。 */
  rows?: DiffLine[];
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
/** 带行号的 diff 渲染成「+L23 code」/「-L17 code」/「 L5 code」，模型同样会连行号一起抄。 */
const NUMBERED_DIFF_PREFIX = /^[-+ ]?\s*L\d{1,6}(?::|\||\u2502|>)?(?:\s+|$)/;
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
 * 一个代码片段的全部可搜索写法，按可信度排序：原文 → 去 diff 行号前缀 → 去完整文件行号 → 去 diff 前缀 → 去掉空行。
 * 首尾空行是模型多带的换行，直接剪掉；中间空行是「行号连续」的依据，只能作为最后一种兜底写法整体去掉。
 */
function snippetVariants(value: string): string[][] {
  const base = trimEdges(normalizeCode(value));
  if (base.length === 0) return [];
  const variants = [base];
  const unnumbered = stripPrefix(base, NUMBERED_DIFF_PREFIX);
  if (unnumbered.some((line, index) => line !== base[index])) variants.push(unnumbered);
  const denumbered = stripPrefix(unnumbered, LINE_NUMBER_PREFIX);
  if (denumbered.some((line, index) => line !== unnumbered[index])) variants.push(denumbered);
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
      rows: slice,
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

// --- 发布位置：一律按当前 diff 的真实行重新锚定 ---

/** 行内位置降级为全文评论的机器可读原因，写进 debugBus 便于统计还剩哪些场景。 */
export type PublishBlockCode =
  | 'no-diff' | 'path-not-in-diff' | 'diff-collapsed' | 'reanchor-no-match' | 'reanchor-ambiguous';

export interface PublishPosition {
  publishable: boolean;
  /** publishable 为 false 时的用户可见原因。 */
  reason?: string;
  reasonCode?: PublishBlockCode;
  /** 位置由当前 diff 重新锚定得到，与 Finding 原本的行号 / 侧别 / 路径不同。 */
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

function otherSide(side: 'old' | 'new'): 'old' | 'new' {
  return side === 'new' ? 'old' : 'new';
}

/** 一处命中 = 当前 diff 里真实相邻的若干行，side 是这些行真的存在的那一侧。 */
interface RowHit {
  file: FileDiff;
  rows: DiffLine[];
  side: 'old' | 'new';
}

/**
 * 侧别是模型的提示，不是行号：先按提示侧在真实 diff 行里找，那一侧有命中就只认那一侧
 * （同一段上下文行在两侧各命中一次，其实是同一处，不必当成两个候选）；
 * 提示侧一处都没有才看另一侧——模型常把删除行写成新增侧。
 */
function rowHits(file: FileDiff, target: string[], hint: 'old' | 'new'): RowHit[] {
  const onSide = (side: 'old' | 'new'): RowHit[] =>
    diffMatches(file, target, side).map((match) => ({ file, rows: match.rows!, side }));
  const hinted = onSide(hint);
  return hinted.length > 0 ? hinted : onSide(otherSide(hint));
}

/**
 * 重新锚定：按写法变体的可信度从高到低（原文 → 去 diff 行号 → 去完整文件行号 → 去 diff 前缀 → 去空行）
 * 在当前 diff 的真实行里找 existingCode / evidence.quote。命中唯一一处才算锚上；
 * 某一档命中多处时继续往下找唯一命中，全都分不清才把「多候选」原样交出去（由调用方降级，不猜）。
 */
function reanchorIn(finding: Finding, file: FileDiff): RowHit[] {
  let ambiguous: RowHit[] = [];
  for (const snippet of searchSnippets(finding)) {
    const hits = rowHits(file, snippet, finding.side);
    if (hits.length === 1) return hits;
    if (hits.length > 1 && ambiguous.length === 0) ambiguous = hits;
  }
  return ambiguous;
}

/**
 * 模型报的行数只当提示：命中起点与提示行号一致、且能在同侧同 hunk 内连续延展时，
 * 才把评论范围补回模型报的长度；否则只覆盖真正匹配上的那几行，绝不拿提示行号去凑 end。
 */
function extendHit(file: FileDiff, hit: RowHit, finding: Finding): RowHit {
  const span = finding.endLine - finding.line;
  if (span <= 0 || hit.rows.length > span) return hit;
  if (sideValue(hit.rows[0], hit.side) !== finding.line) return hit;
  const entries = sideEntries(file, hit.side);
  const from = entries.indexOf(hit.rows[0]);
  const rows = entries.slice(from, from + span + 1);
  if (rows.length !== span + 1 || !contiguous(rows, hit.side)) return hit;
  if (!rows.every((line) => line.hunkId === rows[0].hunkId)) return hit;
  return { ...hit, rows };
}

function hitMatch(hit: RowHit): AnchorMatch {
  const { file, rows, side } = hit;
  return {
    path: file.newPath === '/dev/null' ? file.oldPath : file.newPath,
    start: sideValue(rows[0], side),
    end: sideValue(rows[rows.length - 1], side),
    side,
    source: 'diff',
    file,
    rows,
  };
}

/**
 * GitLab 只认 diff 行上真实存在的 (old_line, new_line) 配对：added 行只有 new_line、
 * removed 行只有 old_line、context 行两者都有。自己凑一对或只填一侧都会让 line_code 落空、
 * 整条评论以 `line_code can't be blank` 400 被拒，所以配对直接抄命中的那两行真实 diff 行。
 */
function lineRefs(rows: DiffLine[]) {
  const ref = (row: DiffLine): PositionLineRef => ({
    ...(row.oldLine !== undefined ? { oldLine: row.oldLine } : {}),
    ...(row.newLine !== undefined ? { newLine: row.newLine } : {}),
  });
  return { start: ref(rows[0]), end: ref(rows[rows.length - 1]) };
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

/** 降级只在首次出现时记一条，评审流式更新会反复重算同一批 Finding，不能每次都刷日志；计数则每次都累加。 */
function blocked(finding: Finding, code: PublishBlockCode, reason: string): PublishPosition {
  const key = `${finding.id}:${code}:${finding.line}`;
  debugBus.count(`publish-downgrade:${code}`);
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

/** 一个 diff 行都没有的原因：按 GitLab 自己给的标记说，别一律推给「文件过大」。 */
function noDiffLinesReason(file: FileDiff): string {
  if (file.tooLarge) return 'GitLab 判定这个文件的 diff 过大（too_large），没有返回内容';
  if (file.collapsed) return '这个文件的 diff 被 GitLab 折叠了，没有返回内容';
  if (file.renamedFile) return '这个文件只是重命名，没有内容变更';
  return 'GitLab 没有返回这个文件的 diff 内容';
}

function located(finding: Finding) {
  return `${finding.path}:${finding.line}${finding.endLine > finding.line ? `-${finding.endLine}` : ''}`;
}

/** 「无匹配」要说清是哪一种无匹配：没片段可比 / 只锚到完整文件 / 片段在当前 diff 里真的找不到。 */
function noMatchReason(finding: Finding): string {
  if (finding.anchor?.source === 'full-file') {
    return `重新锚定失败：无匹配 —— ${located(finding)} 只锚定到完整文件，当前 Diff 里没有可对应的行`;
  }
  if (searchSnippets(finding).length === 0) {
    return `重新锚定失败：无匹配 —— ${located(finding)} 没有可比对的代码片段（existingCode 与 evidence.quote 都是空的），不拿模型行号硬发`;
  }
  return `重新锚定失败：无匹配 —— 当前 Diff 的真实行里找不到 ${located(finding)} 这段代码`;
}

function ambiguousReason(finding: Finding, hits: RowHit[]): string {
  const where = hits.map((hit) => `第 ${sideValue(hit.rows[0], hit.side)} 行`).join('、');
  return `重新锚定失败：多候选 —— ${located(finding)} 的代码片段在当前 Diff 里命中 ${hits.length} 处（${where}），不猜是哪一处`;
}

function resolved(finding: Finding, match: AnchorMatch): PublishPosition {
  const anchored = applyMatch(finding, match);
  const changed = anchored.path !== finding.path || anchored.line !== finding.line
    || anchored.endLine !== finding.endLine || anchored.side !== finding.side;
  const anchor = { ...anchored.anchor!, ...(changed || finding.anchor?.corrected ? { corrected: true } : {}) };
  return {
    publishable: true,
    ...(changed ? { corrected: true } : {}),
    finding: { ...anchored, anchor },
    lines: lineRefs(match.rows!),
  };
}

/**
 * 发布位置：一律由当前 MR diff 的真实行重新锚定得到。
 *
 * 模型报的 line / endLine / side 只是提示，不直接进 GitLab position——行号对不上真实 diff 行、
 * 或侧别与行的真实形态不符，GitLab 一律以 `line_code can't be blank` 400 拒掉整条评论。
 * 所以这里只认内容：拿 existingCode / evidence.quote 在当前 diff 里重新匹配，命中唯一一处才发布，
 * 匹配不到或命中多处都降级为 MR 全文评论（走既有 [inline-fallback] 日志），绝不按行号或就近猜一个位置。
 */
export function resolvePublishPosition(finding: Finding, files: FileDiff[]): PublishPosition {
  if (files.length === 0) return blocked(finding, 'no-diff', '当前 Diff 尚未加载，无法校验评论位置');

  const index = fileIndex(files);
  const file = matchFile(finding, index);

  // 路径对不上（renamed / 前缀 / 大小写都兜不住）时按内容跨文件找一次，找到的仍必须是唯一一处
  if (!file) {
    const hits = files.flatMap((candidate) => reanchorIn(finding, candidate));
    if (hits.length > 1) return blocked(finding, 'reanchor-ambiguous', ambiguousReason(finding, hits));
    if (hits.length === 1) return resolved(finding, hitMatch(extendHit(hits[0].file, hits[0], finding)));
    return blocked(finding, 'path-not-in-diff', `${finding.path} 不在当前 Diff 中，无法定位行内评论`);
  }

  // 没有 diff 行就没有 line_code：GitLab 折叠 / 判为过大 / 纯重命名都落在这里，原因要说准
  if (file.lines.length === 0) {
    return blocked(finding, 'diff-collapsed', `${file.newPath}：${noDiffLinesReason(file)}，无法定位行内评论`);
  }

  const hits = reanchorIn(finding, file);
  if (hits.length === 0) return blocked(finding, 'reanchor-no-match', noMatchReason(finding));
  if (hits.length > 1) return blocked(finding, 'reanchor-ambiguous', ambiguousReason(finding, hits));
  return resolved(finding, hitMatch(extendHit(file, hits[0], finding)));
}
