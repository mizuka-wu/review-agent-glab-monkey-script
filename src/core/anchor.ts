import type { DiffLine, FileDiff, Finding } from './types';

function normalizeCode(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function consecutiveMatches(lines: DiffLine[], target: string[], side: 'old' | 'new') {
  const candidates = lines.filter((line) => side === 'new' ? line.newLine !== undefined : line.oldLine !== undefined);
  for (let index = 0; index <= candidates.length - target.length; index += 1) {
    const slice = candidates.slice(index, index + target.length);
    if (slice.every((line, offset) => line.text.trim() === target[offset])) {
      return {
        start: side === 'new' ? slice[0].newLine! : slice[0].oldLine!,
        end: side === 'new' ? slice[slice.length - 1].newLine! : slice[slice.length - 1].oldLine!,
      };
    }
  }
  return undefined;
}

export function resolveFindingAnchor(finding: Finding, files: FileDiff[]): Finding | undefined {
  const file = files.find((candidate) => candidate.newPath === finding.path || candidate.oldPath === finding.path);
  if (!file) return finding.existingCode ? undefined : finding;
  const target = normalizeCode(finding.existingCode);

  if (target.length > 0) {
    const side = finding.side === 'old' ? 'old' : 'new';
    const direct = consecutiveMatches(file.lines, target, side);
    const fallback = direct ?? consecutiveMatches(file.lines, target, side === 'new' ? 'old' : 'new');
    if (!fallback) return undefined;
    return { ...finding, side: direct ? side : side === 'new' ? 'old' : 'new', line: fallback.start, endLine: fallback.end };
  }

  const hasLine = file.lines.some((line) =>
    finding.side === 'new' ? line.newLine === finding.line : line.oldLine === finding.line,
  );
  return hasLine ? finding : undefined;
}

export function anchorFindings(findings: Finding[], files: FileDiff[]) {
  return findings
    .map((finding) => resolveFindingAnchor(finding, files))
    .filter((finding): finding is Finding => Boolean(finding));
}
