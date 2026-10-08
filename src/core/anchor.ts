import type {
  DiffLine,
  FileDiff,
  Finding,
  FullFileSnapshot,
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

function diffMatches(file: FileDiff, target: string[], side: 'old' | 'new'): AnchorMatch[] {
  const candidates = file.lines.filter((line) => side === 'new' ? line.newLine !== undefined : line.oldLine !== undefined);
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
    if (!sameHunk || !consecutive || !slice.every((line, offset) => line.text.trim() === target[offset])) continue;
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
    if (!target.every((line, offset) => snapshot.lines[index + offset].trim() === line)) continue;
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

function preferredMatches(finding: Finding, matches: AnchorMatch[]) {
  const preferredPaths = new Set([
    finding.path,
    finding.newPath,
    finding.oldPath,
    ...finding.evidence.map((evidence) => evidence.path),
  ].filter((path): path is string => Boolean(path)));
  const preferred = matches.filter((match) => preferredPaths.has(match.path));
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
  const relocatedFromPath = finding.path === match.path ? undefined : finding.path;
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
  const target = normalizeCode(finding.existingCode);
  if (target.length > 0) {
    const diff = files.flatMap((file) => [
      ...diffMatches(file, target, finding.side),
      ...diffMatches(file, target, finding.side === 'new' ? 'old' : 'new'),
    ]);
    const diffMatch = chooseMatch(finding, diff);
    if (diffMatch) return applyMatch(finding, diffMatch);
    if (diff.length > 0) return undefined;

    const full = fullFiles.flatMap((snapshot) => fullFileMatches(snapshot, target));
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

export interface PublishPosition {
  publishable: boolean;
  /** publishable 为 false 时的用户可见原因。 */
  reason?: string;
  /** 位置由内容匹配重新定位得到，与 Finding 原行号不同。 */
  corrected?: boolean;
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

function lineMatch(file: FileDiff, side: 'old' | 'new', start: number, end: number): AnchorMatch {
  const entries = sideEntries(file, side);
  const from = entries.findIndex((line) => sideValue(line, side) === start);
  const to = entries.findIndex((line) => sideValue(line, side) === end);
  return toMatch(file, entries.slice(from, to >= from ? to + 1 : from + 1), side);
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

/** Finding 自带的可搜索代码片段，按可信度排序；suggestionCode 是「应改成什么」，不参与匹配。 */
function searchSnippets(finding: Finding) {
  return [finding.existingCode, ...finding.evidence.map((evidence) => evidence.quote)]
    .map((value) => normalizeCode(value).filter((line) => line.length > 0))
    .filter((lines) => lines.length > 0);
}

function nearestTo(matches: AnchorMatch[], hint: number) {
  return [...matches].sort((left, right) => Math.abs(left.start - hint) - Math.abs(right.start - hint))[0];
}

function snippetMatch(finding: Finding, file: FileDiff) {
  const sides: ('old' | 'new')[] = [finding.side, finding.side === 'new' ? 'old' : 'new'];
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
  const sides: ('old' | 'new')[] = [finding.side, finding.side === 'new' ? 'old' : 'new'];
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

function matchFile(finding: Finding, files: FileDiff[]) {
  const wanted = [finding.newPath, finding.path, finding.oldPath].filter((path): path is string => Boolean(path));
  return files.find((file) => wanted.includes(file.newPath) || wanted.includes(file.oldPath));
}

function blocked(finding: Finding, reason: string): PublishPosition {
  return { publishable: false, reason, finding };
}

function resolved(finding: Finding, match: AnchorMatch): PublishPosition {
  const anchored = applyMatch(finding, match);
  const changed = anchored.path !== finding.path || anchored.line !== finding.line
    || anchored.endLine !== finding.endLine || anchored.side !== finding.side;
  const anchor = { ...anchored.anchor!, ...(changed || finding.anchor?.corrected ? { corrected: true } : {}) };
  return { publishable: true, ...(changed ? { corrected: true } : {}), finding: { ...anchored, anchor } };
}

/**
 * 发布前把 Finding 的行号对到该文件真实的 diff 行号集合上：命中就直接发布；
 * 对不上（diff 折叠、上下文偏移、renamed path）就按 Finding 自身内容重新定位；
 * 内容也匹配不上才判为不可发布，避免把 422 留给 GitLab。
 */
export function resolvePublishPosition(finding: Finding, files: FileDiff[]): PublishPosition {
  if (files.length === 0) return blocked(finding, '当前 Diff 尚未加载，无法校验评论位置');

  const file = matchFile(finding, files);
  if (!file) {
    const relocated = files.map((candidate) => snippetMatch(finding, candidate)).find((match) => match !== undefined);
    return relocated
      ? resolved(finding, relocated)
      : blocked(finding, `${finding.path} 不在当前 Diff 中，无法定位行级评论`);
  }

  const fullFileOnly = finding.anchor?.source === 'full-file';
  if (!fullFileOnly) {
    const end = finding.endLine > finding.line ? finding.endLine : finding.line;
    if (coversDiff(file, finding.side, finding.line, end)) {
      return resolved(finding, lineMatch(file, finding.side, finding.line, end));
    }
    if (end > finding.line && coversDiff(file, finding.side, finding.line, finding.line)) {
      return resolved(finding, lineMatch(file, finding.side, finding.line, finding.line));
    }
  }

  const match = relocate(finding, file);
  if (match) return resolved(finding, match);

  return blocked(finding, fullFileOnly
    ? '该 Finding 只锚定到完整文件，当前 Diff 里没有可对应的行'
    : `Diff 中找不到第 ${finding.line} 行，且无法按 Finding 内容自动修正位置`);
}
