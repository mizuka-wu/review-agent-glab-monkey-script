import { findingLocation } from './findings';
import { splitFileLines } from './full-file';
import { GitLabApiError } from './gitlab-adapter';
import type { Finding, RuntimeSettings } from './types';

/** 超过这个长度的文件不送进修复提示词：模型输出会被截断，产出半截补丁。 */
export const MAX_FIX_FILE_CHARACTERS = 120_000;

/** diff 预览的 LCS 规模上限：中间区域再大就整块替换，避免 O(n·m) 卡住主线程。 */
const LCS_CELL_LIMIT = 250_000;

export type FixAction = 'create' | 'update';

export interface FixFileChange {
  path: string;
  action: FixAction;
  /** 源分支上当前的文件内容，用来渲染 diff 预览。 */
  before: string;
  content: string;
}

export interface FixPlan {
  findingId: string;
  /** 只写 MR 源分支，目标分支永不参与。 */
  branch: string;
  changes: FixFileChange[];
  /** commit 标题直接复用 Finding 标题。 */
  message: string;
  /** commit 正文复用 Finding 的证据与建议原文。 */
  description: string;
  patch: string;
}

export interface FixResult {
  /** patch = 模型给了 unified diff；content = 模型给了整份文件内容。 */
  mode: 'patch' | 'content';
  content: string;
}

/**
 * 修复候选：必须有确定的代码锚点（行号 + existingCode）和可执行的修改依据。
 * 文件级规则（如「缺少回归测试」）、指向已删除文件的、模型低置信度或只有泛泛描述
 * 的架构类建议都不给入口 —— 这些地方没有「就改这几行」的语义。
 */
export function isFixCandidate(finding: Finding): boolean {
  if (finding.deletedFile || finding.fileLevel) return false;
  if (!finding.path.trim() || finding.line < 1) return false;
  if (!finding.existingCode.trim()) return false;
  if (finding.source === 'rule') return true;
  if (finding.confidence === 'low') return false;
  return Boolean(finding.suggestionCode.trim())
    || finding.evidence.some((item) => item.quote.trim().length > 0);
}

/** commit message 直接复用 Finding 标题，不另编。 */
export function fixCommitMessage(finding: Finding): string {
  return finding.title.trim();
}

/** commit description 复用 Finding 的说明、证据与建议正文。 */
export function fixCommitDescription(finding: Finding): string {
  const evidence = finding.evidence
    .filter((item) => item.quote.trim())
    .map((item) => `- \`${item.path}${item.lines ? ` ${item.lines}` : ''}\`\n\n\`\`\`\n${item.quote.trim()}\n\`\`\``);
  return [
    finding.content.trim(),
    evidence.length > 0 ? `证据：\n\n${evidence.join('\n\n')}` : '',
    finding.existingCode.trim() ? `现有代码：\n\n\`\`\`\n${finding.existingCode.trim()}\n\`\`\`` : '',
    finding.suggestionCode.trim() ? `建议修改：\n\n\`\`\`\n${finding.suggestionCode.trim()}\n\`\`\`` : '',
    `位置：\`${findingLocation(finding)}\``,
    finding.ruleId
      ? `来源：规则 \`${finding.ruleId}\`${finding.rulePackName ? ` · ${finding.rulePackName}` : ''}`
      : '来源：AI 评审',
  ].filter(Boolean).join('\n\n');
}

export function fixSystemPrompt(language: RuntimeSettings['language']): string {
  if (language === 'en-US') {
    return `You are the patch module of a code review pipeline. Fix only the reported problem; do not refactor, reformat or touch unrelated code.
Output strict JSON with exactly one of:
{"patch":"<unified diff, only @@ hunks, every line starting with ' ', '+' or '-'>"}
{"content":"<the full fixed file>"}
Context lines in the patch must match the given file byte for byte, otherwise the patch cannot be applied. Output nothing but the JSON.`;
  }
  return `你是代码评审管线的修复模块。只修给出的这一处问题：不要顺手重构、不要调整无关格式、不要改动其它代码。
输出严格 JSON，二选一：
{"patch":"<unified diff，只含 @@ 开头的 hunk，每行以 ' '、'+' 或 '-' 开头>"}
{"content":"<修改后的完整文件内容>"}
patch 的上下文行必须与给定文件内容逐字符一致，否则无法应用。不要输出 JSON 以外的任何文字。`;
}

export function buildFixPayload(finding: Finding, content: string): string {
  if (content.length > MAX_FIX_FILE_CHARACTERS) {
    throw new Error(
      `${finding.path} 有 ${content.length} 字符，超过自动修复上限 ${MAX_FIX_FILE_CHARACTERS} 字符，请手动修改`,
    );
  }
  const numbered = splitFileLines(content).map((text, index) => `${index + 1}: ${text}`).join('\n');
  return [
    '## 待修复的问题',
    `标题：${finding.title}`,
    `位置：${findingLocation(finding)}（${finding.side === 'new' ? '新版本' : '旧版本'}）`,
    `说明：${finding.content}`,
    finding.evidence.length > 0
      ? `证据：\n${finding.evidence.map((item) => `- ${item.path}${item.lines ? ` ${item.lines}` : ''}：${item.quote}`).join('\n')}`
      : '',
    finding.existingCode.trim() ? `问题代码：\n\`\`\`\n${finding.existingCode.trim()}\n\`\`\`` : '',
    finding.suggestionCode.trim() ? `评审建议的改法：\n\`\`\`\n${finding.suggestionCode.trim()}\n\`\`\`` : '',
    `## ${finding.path} 的当前完整内容（行号只是定位用，不要写进结果）`,
    '```',
    numbered,
    '```',
  ].filter(Boolean).join('\n\n');
}

export interface PatchHunk {
  oldStart: number;
  /** hunk 里属于原文件的行（上下文 + 删除行）。 */
  before: string[];
  /** hunk 里属于修复后文件的行（上下文 + 新增行）。 */
  after: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedPatch(patch: string): PatchHunk[] {
  const text = patch.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;

  for (const raw of text.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = { oldStart: Number(header[1]), before: [], after: [] };
      hunks.push(current);
      continue;
    }
    // hunk 之外的 diff --git / --- a/x / +++ b/x 头直接跳过
    if (!current) continue;
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('-')) { current.before.push(raw.slice(1)); continue; }
    if (raw.startsWith('+')) { current.after.push(raw.slice(1)); continue; }
    if (raw.startsWith(' ') || raw === '') {
      current.before.push(raw.slice(1));
      current.after.push(raw.slice(1));
      continue;
    }
    // 模型在补丁后面多写了解释文字：到这里当前 hunk 结束
    current = undefined;
  }

  const usable = hunks.filter((hunk) => hunk.before.length > 0 || hunk.after.length > 0);
  if (usable.length === 0) throw new Error('模型没有返回可用的 unified diff（缺少 @@ hunk 头或 hunk 内容为空）');
  return usable;
}

const HUNK_NOT_FOUND = -1;
const HUNK_AMBIGUOUS = -2;

/**
 * 先按补丁声明的行号对齐，对不上再全文找唯一匹配：模型给的行号常偏几行，
 * 但上下文一致就说明是同一处。匹配到多处时不敢猜，直接判失败。
 */
function locateHunk(lines: string[], hunk: PatchHunk, floor: number): number {
  const target = hunk.before;
  // 零长度 hunk（@@ -3,0 +4 @@）是纯插入：位置在声明行的后面，不是前面
  if (target.length === 0) return Math.min(Math.max(floor, hunk.oldStart), lines.length);
  const hint = Math.max(floor, hunk.oldStart - 1);
  const matchesAt = (index: number) => index >= floor
    && index + target.length <= lines.length
    && target.every((line, offset) => lines[index + offset] === line);
  if (matchesAt(hint)) return hint;
  const found: number[] = [];
  for (let index = floor; index + target.length <= lines.length; index += 1) {
    if (!matchesAt(index)) continue;
    found.push(index);
    if (found.length > 1) return HUNK_AMBIGUOUS;
  }
  return found.length === 1 ? found[0] : HUNK_NOT_FOUND;
}

/** 把模型给的 unified patch 应用到当前文件内容上；应用不了就抛错，绝不落半截结果。 */
export function applyUnifiedPatch(before: string, patch: string): string {
  const hunks = parseUnifiedPatch(patch);
  const lines = splitFileLines(before);
  const placements: { index: number; hunk: PatchHunk }[] = [];

  hunks.forEach((hunk, order) => {
    const previous = placements.at(-1);
    const floor = previous ? previous.index + previous.hunk.before.length : 0;
    const index = locateHunk(lines, hunk, floor);
    if (index === HUNK_AMBIGUOUS) {
      throw new Error(`补丁第 ${order + 1} 个 hunk 在文件里匹配到多处相同代码，无法确定改哪一处`);
    }
    if (index === HUNK_NOT_FOUND) {
      throw new Error(`补丁第 ${order + 1} 个 hunk 无法应用：第 ${hunk.oldStart} 行附近找不到与补丁一致的原始代码（文件可能已改动）`);
    }
    placements.push({ index, hunk });
  });

  const out: string[] = [];
  let cursor = 0;
  for (const { index, hunk } of placements) {
    out.push(...lines.slice(cursor, index), ...hunk.after);
    cursor = index + hunk.before.length;
  }
  out.push(...lines.slice(cursor));
  return out.join('\n');
}

/** 模型经常把整份文件内容再包一层代码围栏，先脱掉再校验。 */
function stripContentFence(content: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*?)```$/.exec(content.trim());
  return fenced ? fenced[1].replace(/\n$/, '') : content;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const sliced = cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1);
  for (const candidate of [cleaned, sliced]) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // 换下一个候选
    }
  }
  throw new Error('模型没有返回可解析的 JSON 修复结果');
}

/** 修复结果体检：空内容、原样返回、体积暴涨、疑似截断都直接拒绝，不提交半截文件。 */
export function validateFixedContent(before: string, after: string): string {
  if (!after.trim()) throw new Error('模型返回的修复内容为空');
  if (after === before) throw new Error('模型返回的内容与当前文件完全一致，没有做出修改');
  if (after.length > before.length * 8 + 4096) {
    throw new Error(`修复结果体积异常（${after.length} 字符，原文件 ${before.length} 字符），已丢弃`);
  }
  const beforeLines = splitFileLines(before).map((line) => line.trim()).filter(Boolean);
  const kept = new Set(splitFileLines(after).map((line) => line.trim()).filter(Boolean));
  const lost = beforeLines.filter((line) => !kept.has(line)).length;
  if (beforeLines.length >= 20 && lost / beforeLines.length > 0.6) {
    throw new Error(`修复结果丢掉了 ${lost}/${beforeLines.length} 行原有代码，疑似输出被截断，已丢弃`);
  }
  return after;
}

export function parseFixResponse(response: string, before: string): FixResult {
  const payload = extractJsonObject(response);
  if (typeof payload.patch === 'string' && payload.patch.trim()) {
    return { mode: 'patch', content: validateFixedContent(before, applyUnifiedPatch(before, payload.patch)) };
  }
  if (typeof payload.content === 'string') {
    return { mode: 'content', content: validateFixedContent(before, stripContentFence(payload.content)) };
  }
  throw new Error('模型返回的 JSON 里既没有 patch 也没有 content 字段');
}

interface DiffOp {
  kind: 'context' | 'added' | 'removed';
  text: string;
}

function lcsOps(before: string[], after: string[]): DiffOp[] {
  const cols = after.length + 1;
  const dp = new Uint32Array((before.length + 1) * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] = before[i] === after[j]
        ? dp[(i + 1) * cols + j + 1] + 1
        : Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'context', text: before[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      ops.push({ kind: 'removed', text: before[i] });
      i += 1;
    } else {
      ops.push({ kind: 'added', text: after[j] });
      j += 1;
    }
  }
  while (i < before.length) { ops.push({ kind: 'removed', text: before[i] }); i += 1; }
  while (j < after.length) { ops.push({ kind: 'added', text: after[j] }); j += 1; }
  return ops;
}

/** 前后缀相同的行先对齐，只对中间改动区做 LCS：典型修复只动几行，不必整份文件比对。 */
function diffOps(before: string[], after: string[]): DiffOp[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const middleBefore = before.slice(start, endBefore);
  const middleAfter = after.slice(start, endAfter);
  const middle = middleBefore.length * middleAfter.length <= LCS_CELL_LIMIT
    ? lcsOps(middleBefore, middleAfter)
    : [
      ...middleBefore.map((text): DiffOp => ({ kind: 'removed', text })),
      ...middleAfter.map((text): DiffOp => ({ kind: 'added', text })),
    ];
  return [
    ...before.slice(0, start).map((text): DiffOp => ({ kind: 'context', text })),
    ...middle,
    ...before.slice(endBefore).map((text): DiffOp => ({ kind: 'context', text })),
  ];
}

function diffLines(content: string): string[] {
  if (!content) return [];
  const lines = splitFileLines(content);
  // 结尾换行会多出一个空行，去掉免得预览里多一条空上下文
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** 生成给确认弹窗看的 unified diff 预览；没有实际改动时返回空串。 */
export function buildUnifiedDiff(path: string, before: string, after: string, contextLines = 3): string {
  const ops = diffOps(diffLines(before), diffLines(after));
  if (ops.every((op) => op.kind === 'context')) return '';

  const groups: { start: number; end: number }[] = [];
  ops.forEach((op, index) => {
    if (op.kind === 'context') return;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length - 1, index + contextLines);
    const last = groups.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else groups.push({ start, end });
  });

  const oldNumbers: number[] = [];
  const newNumbers: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    oldNumbers.push(oldLine);
    newNumbers.push(newLine);
    if (op.kind !== 'added') oldLine += 1;
    if (op.kind !== 'removed') newLine += 1;
  }

  const body = groups.flatMap((group) => {
    const slice = ops.slice(group.start, group.end + 1);
    const oldCount = slice.filter((op) => op.kind !== 'added').length;
    const newCount = slice.filter((op) => op.kind !== 'removed').length;
    return [
      `@@ -${oldNumbers[group.start]},${oldCount} +${newNumbers[group.start]},${newCount} @@`,
      ...slice.map((op) => `${op.kind === 'added' ? '+' : op.kind === 'removed' ? '-' : ' '}${op.text}`),
    ];
  });

  return [`--- a/${path}`, `+++ b/${path}`, ...body].join('\n');
}

export function createFixPlan(input: {
  finding: Finding;
  branch: string;
  before: string;
  content: string;
}): FixPlan {
  const { finding, branch, before, content } = input;
  return {
    findingId: finding.id,
    branch,
    changes: [{ path: finding.path, action: 'update', before, content }],
    message: fixCommitMessage(finding),
    description: fixCommitDescription(finding),
    patch: buildUnifiedDiff(finding.path, before, content),
  };
}

const COMMIT_FAILURE_HINTS: Record<number, string> = {
  400: 'GitLab 拒绝了这次提交（文件路径或分支状态与提交内容不符）',
  403: '没有向该分支推送的权限（分支可能被保护，或 Token 权限不足）',
  409: '分支状态冲突，修复没有提交',
};

/** 提交失败要把 GitLab 的状态码翻译成人话：403 / 409 / 校验失败都不能只丢一串英文。 */
export function describeFixFailure(error: unknown): string {
  if (error instanceof GitLabApiError) {
    const hint = COMMIT_FAILURE_HINTS[error.status];
    return hint ? `${hint}：${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
