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

/** 保留段落与 Markdown 结构，只清理行尾空白和多余空行。 */
function normalizeMultiline(value: unknown) {
  if (typeof value !== 'string') return '';
  return value
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
      const evidence = item as Partial<FindingEvidence> & Record<string, unknown>;
      const rawLines = evidence.lines ?? evidence.line ?? evidence.linesRange;
      const rawQuote = evidence.quote ?? evidence.snippet ?? evidence.text ?? evidence.code;
      return {
        path: normalizeText(evidence.path) || fallbackPath,
        lines: typeof rawLines === 'number' ? `L${rawLines}` : normalizeText(rawLines),
        quote: normalizeText(rawQuote),
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
    const content = normalizeMultiline(item.content ?? item.description);
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
      comment: normalizeMultiline(item.comment) || `${title}\n\n${content}`,
      source: item.source === 'rule' ? 'rule' : 'model',
      status: 'draft',
      ruleId: typeof item.ruleId === 'string' ? item.ruleId : undefined,
      rulePackId: typeof item.rulePackId === 'string' ? item.rulePackId : undefined,
      rulePackName: typeof item.rulePackName === 'string' ? item.rulePackName : undefined,
      occurrences: typeof item.occurrences === 'number' ? item.occurrences : undefined,
    });
  }

  return normalized;
}

export function parseModelFindings(content: string, files: FileDiff[]) {
  const candidates = jsonCandidates(content);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) || (parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings))) {
        return normalizeFindings(parsed, files);
      }
    } catch {
      // 继续尝试下一个候选片段（思考过程里也可能出现方括号）
    }
  }
  throw new Error('模型未返回有效 JSON Finding：无法从响应中解析出 JSON 数组');
}

/** 从可能混有思考过程的文本里按可信度提取 JSON 候选片段。 */
function jsonCandidates(content: string): string[] {
  const text = content.trim();
  const candidates: string[] = [text];

  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(fence[1].trim());
  }

  const firstArray = text.indexOf('[');
  const lastArray = text.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(text.slice(firstArray, lastArray + 1));
  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(text.slice(firstObject, lastObject + 1));

  // 思考过程常以 "findings" 数组结尾：取最后一个看起来像数组起点的位置
  const lateArray = text.lastIndexOf('"findings"');
  if (lateArray >= 0) {
    const open = text.lastIndexOf('[', lateArray);
    const brace = text.lastIndexOf('{', open >= 0 ? open : 0);
    const start = brace >= 0 ? brace : open;
    if (start >= 0 && lastObject > start) candidates.push(text.slice(start, lastObject + 1));
  }
  return candidates;
}
