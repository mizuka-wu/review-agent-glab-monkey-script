import type {
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
    .map((line) => line.trim())
    .filter(Boolean);
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
    .map((line): AnchorMatch => ({
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
