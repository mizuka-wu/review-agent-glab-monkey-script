import { findDiffLine } from './diff';
import type {
  Finding,
  FindingCategory,
  FindingConfidence,
  FindingEvidence,
  FindingSeverity,
  FileDiff,
} from './types';

const categories = new Set<FindingCategory>([
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
]);
const severities = new Set<FindingSeverity>(['critical', 'high', 'medium', 'low']);
const confidences = new Set<FindingConfidence>(['high', 'medium', 'low']);

function oneOf<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value.toLowerCase() as T)
    ? (value.toLowerCase() as T)
    : fallback;
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function fingerprintFinding(input: {
  path: string;
  existingCode: string;
  category: FindingCategory;
  title: string;
  line?: number;
}) {
  const source = [
    'gitlab-review-agent-v1',
    input.path.trim(),
    input.existingCode.replace(/\s+/g, '').toLowerCase(),
    input.category,
    normalizeText(input.title).toLowerCase(),
    String(input.line ?? 0),
  ].join('\u0000');

  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < source.length; index += 1) {
    first ^= source.charCodeAt(index);
    first = Math.imul(first, 0x01000193) >>> 0;
    second ^= source.charCodeAt(index) + index;
    second = Math.imul(second, 0x85ebca6b) >>> 0;
  }
  return `ra-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function cleanEvidence(value: unknown, fallbackPath: string): FindingEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): FindingEvidence => {
      const evidence = item as Partial<FindingEvidence>;
      return {
        path: normalizeText(evidence.path) || fallbackPath,
        lines: normalizeText(evidence.lines),
        quote: normalizeText(evidence.quote),
      };
    })
    .filter((item) => item.quote.length > 0)
    .slice(0, 5);
}

export function normalizeFindings(raw: unknown, files: FileDiff[]): Finding[] {
  const input = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { findings?: unknown }).findings)
      ? (raw as { findings: unknown[] }).findings
      : [];
  const normalized: Finding[] = [];
  const seen = new Set<string>();

  for (const value of input) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const path = normalizeText(item.path ?? item.filePath);
    const lineValue = Number(item.line ?? item.startLine);
    const line = Number.isInteger(lineValue) && lineValue >= 1 ? lineValue : 0;
    const title = normalizeText(item.title);
    const content = normalizeText(item.content ?? item.description);
    const existingCode = typeof item.existingCode === 'string' ? item.existingCode : '';
    const file = files.find((candidate) => candidate.newPath === path || candidate.oldPath === path);

    if (!path || (!line && !existingCode) || !title || !content) continue;

    const category = oneOf(item.category, categories, 'bug');
    const severity = oneOf(item.severity, severities, 'medium');
    const confidence = oneOf(item.confidence, confidences, 'medium');
    const endLineValue = Number(item.endLine ?? line);
    const endLine = Number.isInteger(endLineValue) && endLineValue >= line ? endLineValue : line;
    const suggestedSide = item.side === 'old' ? 'old' : 'new';
    const anchoredLine = line ? findDiffLine(files, path, suggestedSide, line) : undefined;
    const side = anchoredLine ? suggestedSide : findDiffLine(files, path, 'new', line) ? 'new' : 'old';
    const fingerprint = fingerprintFinding({ path, existingCode, category, title, line });

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    normalized.push({
      id: fingerprint,
      fingerprint,
      path,
      oldPath: file?.oldPath,
      newPath: file?.newPath,
      newFile: file?.newFile,
      deletedFile: file?.deletedFile,
      line,
      endLine,
      side,
      category,
      severity,
      confidence,
      title,
      content,
      evidence: cleanEvidence(item.evidence, path),
      existingCode,
      suggestionCode: typeof item.suggestionCode === 'string' ? item.suggestionCode : '',
      comment: normalizeText(item.comment) || `${title}\n\n${content}`,
      source: item.source === 'rule' ? 'rule' : 'model',
      status: 'draft',
    });
  }

  return normalized;
}

export function parseModelFindings(content: string, files: FileDiff[]) {
  const withoutFence = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const firstArray = withoutFence.indexOf('[');
  const lastArray = withoutFence.lastIndexOf(']');
  const firstObject = withoutFence.indexOf('{');
  const lastObject = withoutFence.lastIndexOf('}');
  const json =
    firstArray >= 0 && lastArray > firstArray
      ? withoutFence.slice(firstArray, lastArray + 1)
      : withoutFence.slice(firstObject, lastObject + 1);

  try {
    return normalizeFindings(JSON.parse(json), files);
  } catch (error) {
    throw new Error(`模型未返回有效 JSON Finding：${String(error)}`);
  }
}
