/**
 * 行内评论降级为全文评论时的结构化排查日志。
 *
 * 「这条为什么没挂到行上」的答案散落在 toast、卡片 Badge 与调试面板计数里，用户复现完就没了：
 * 远程排查拿不到当时真实发出的 position 参数、diff_refs 与服务端原话，而老 GitLab 上大量降级，
 * 400 / 409 / 422 的 body 才是最关键的证据（`position must be a valid json schema` 那次就是靠 body 定位的）。
 * 这里把一次降级的完整现场拼成每行都带 [inline-fallback] 前缀的文本，同时进 console 与调试面板 / 导出包，
 * 用户直接复制 console 就能发来。所有字段都过 sanitizeLog；正文与代码片段只记长度不记内容，PAT 永不落日志。
 */

import type { PublishPosition } from './anchor';
import { sanitizeLog } from './capabilities';
import { debugBus } from './debug-bus';
import { findDiffLine, repoPathEquals } from './diff';
import { diffViewKind, domLineSource } from './dom-line-number';
import { buildDiscussionPayload } from './gitlab-adapter';
import { selectionLabel } from './selection';
import type {
  CodeSelection,
  DiffRefs,
  DiscussionPosition,
  FileDiff,
  Finding,
  PositionLineRef,
  PublishDowngrade,
} from './types';

/** 每一行都带这个前缀：console 里 grep / 过滤只看降级现场，用户也能整段复制。 */
export const INLINE_FALLBACK_PREFIX = '[inline-fallback]';

/** position-blocked = 发布前就判定行内不可用（没发请求）；inline-rejected = 发出去了被 GitLab 拒。 */
export type InlineFallbackCause = 'position-blocked' | 'inline-rejected';

/** 一次发布现场的原始事实，由调用方（App 的发布出口）提供，本模块只负责判定与格式化。 */
export interface InlineFallbackFacts {
  /** 发布用的 Finding（可能是锚定前的原始值）。 */
  finding: Finding;
  /** resolvePublishPosition 的结果：publishable=false 时带 reasonCode / reason，finding 是锚定后的值。 */
  position?: PublishPosition;
  /** 真的发出去的行内 position；发布前就被拦下时为 undefined。 */
  attempted?: DiscussionPosition;
  /** publishComment 带回的服务端拒绝信息；只有行内被拒时才有值。 */
  downgrade?: PublishDowngrade;
  files?: FileDiff[];
  diffRefs?: DiffRefs;
  selection?: CodeSelection;
  gitlabVersion?: string;
  /** 评论正文，只统计长度不进日志。 */
  body?: string;
}

export interface InlineFallbackCauseInfo {
  cause: InlineFallbackCause;
  reasonCode: string;
  reason: string;
  status?: number;
  serverMessage?: string;
}

/**
 * 是不是「真降级」：本来要发行内、结果发成全文才算。
 * 用户主动发全文（MR 总评论、扫描模式这种压根没有位置校验信息的场景）返回 undefined，不打这条日志。
 */
export function inlineFallbackCause(facts: InlineFallbackFacts): InlineFallbackCauseInfo | undefined {
  if (facts.downgrade) {
    return {
      cause: 'inline-rejected',
      reasonCode: 'inline-rejected',
      reason: facts.downgrade.reason,
      ...(facts.downgrade.status !== undefined ? { status: facts.downgrade.status } : {}),
      ...(facts.downgrade.serverMessage ? { serverMessage: facts.downgrade.serverMessage } : {}),
    };
  }
  const blocked = facts.position && !facts.position.publishable ? facts.position : undefined;
  if (!blocked) return undefined;
  return {
    cause: 'position-blocked',
    reasonCode: blocked.reasonCode ?? 'unknown',
    reason: blocked.reason ?? '无法确定行内评论位置',
  };
}

const VALUE_CAP = 300;

function clean(value: string, cap = VALUE_CAP) {
  const text = sanitizeLog(value.replace(/\s+/g, ' ').trim());
  return text.length > cap ? `${text.slice(0, cap)}…(+${text.length - cap})` : text;
}

function lineRange(finding: Finding) {
  return finding.endLine > finding.line ? `${finding.line}-${finding.endLine}` : `${finding.line}`;
}

/** 代码片段只记规模：片段里常常就是「硬编码的密钥」那一行，不进日志。 */
function snippetStats(finding: Finding) {
  const lines = finding.existingCode.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return `${lines.length} 行/${finding.existingCode.length} 字符`;
}

function lineRef(label: string, ref?: PositionLineRef) {
  if (!ref) return '';
  const parts = [
    ref.oldLine !== undefined ? `old_line=${ref.oldLine}` : '',
    ref.newLine !== undefined ? `new_line=${ref.newLine}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `${label}{${parts.join(',')}}` : '';
}

/** 实际发出的 position 参数原样还原（去掉正文），排查 `line_code can't be blank` 这类拒绝只能看这个。 */
export function positionParams(position?: DiscussionPosition) {
  if (!position) return undefined;
  const params = buildDiscussionPayload({ body: '', position });
  params.delete('body');
  return [...params.entries()]
    .map(([key, value]) => `${decodeURIComponent(key)}=${value}`)
    .join(' · ');
}

function diffRefsLine(refs?: DiffRefs) {
  if (!refs) return 'diff-refs: 未取到（MR 上下文尚未加载）';
  return `diff-refs: base_sha=${refs.baseSha} · start_sha=${refs.startSha} · head_sha=${refs.headSha}`;
}

/**
 * GitLab 实际返回的这个文件的 diff 概况：可用行号区间就是「第 42 行为什么不在 diff 里」的直接答案，
 * 折叠 / 过大 / 纯重命名也在这里一眼看出（这三种压根没有 diff 行）。
 */
function diffSummaryLine(facts: InlineFallbackFacts, anchored: Finding) {
  const file = facts.files?.find((candidate) =>
    repoPathEquals(candidate.newPath, anchored.path) || repoPathEquals(candidate.oldPath, anchored.path));
  if (!file) return `diff: 当前 Diff 里没有 ${anchored.path}（共 ${facts.files?.length ?? 0} 个文件）`;
  const span = (side: 'old' | 'new') => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const line of file.lines) {
      const value = side === 'new' ? line.newLine : line.oldLine;
      if (value === undefined) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return min === Number.POSITIVE_INFINITY ? 'none' : min === max ? `${min}` : `${min}-${max}`;
  };
  return [
    `diff: file=${file.newPath}`,
    `lines=${file.lines.length}`,
    `newLines=${span('new')}`,
    `oldLines=${span('old')}`,
    `hunks=${new Set(file.lines.map((line) => line.hunkId)).size}`,
    `newFile=${file.newFile}`,
    `deletedFile=${file.deletedFile}`,
    `renamedFile=${file.renamedFile}`,
    `collapsed=${file.collapsed === true}`,
    `tooLarge=${file.tooLarge === true}`,
  ].join(' · ');
}

/** 页面 DOM 侧的证据：这一行在页面上找不找得到、行号是从哪个属性 / span id 读出来的。 */
function domLine(anchored: Finding) {
  const probe = domLineSource(anchored.line, anchored.side);
  const parts = [`view=${diffViewKind()}`, `rowFound=${probe.found}`];
  if (probe.rowId) parts.push(`rowId=${probe.rowId}`);
  if (probe.from && probe.from.length > 0) parts.push(`lineFrom=${probe.from.join('|')}`);
  if (probe.lineCode) parts.push(`lineCode=${probe.lineCode}`);
  return parts.join(' · ');
}

/**
 * 409 重锚的现场：重锚跑过就必须把两次 position 都打出来——只看第一次分不清是 diff_refs 过期还是行号真没了，
 * 只看第二次又不知道原来发的是什么。重锚成功不会走到这里（保住行内就不算降级，只留计数与 info 日志）。
 */
function reanchorLine(downgrade?: PublishDowngrade, attempted?: DiscussionPosition) {
  if (!downgrade?.reanchored) return undefined;
  return [
    `${INLINE_FALLBACK_PREFIX} reanchor: 409 重锚后仍失败`,
    `reason=${clean(downgrade.reanchorReason ?? downgrade.reason)}`,
    `first-position=${positionParams(attempted) ?? '无（发布前已判定行内不可用）'}`,
    `retry-position=${positionParams(downgrade.reanchorPosition) ?? '未重锚出位置，第二次没发出'}`,
  ].join(' · ');
}

function serverLine(cause: InlineFallbackCauseInfo) {
  if (cause.cause !== 'inline-rejected') return undefined;
  const message = cause.serverMessage ?? cause.reason;
  return `server: HTTP ${cause.status ?? '???'} · message=${clean(message)}`;
}

/** 整段降级现场：每行一个维度、都带前缀，用户可以整段复制，也能只 grep 关心的那一行。 */
export function formatInlineFallback(facts: InlineFallbackFacts, cause: InlineFallbackCauseInfo): string[] {
  const input = facts.finding;
  const anchored = facts.position?.finding ?? input;
  const anchor = anchored.anchor;
  const kind = facts.files ? findDiffLine(facts.files, anchored.path, anchored.side, anchored.line)?.kind : undefined;
  const lines = [
    [
      `${INLINE_FALLBACK_PREFIX} 行内评论降级为全文评论`,
      `cause=${cause.cause}`,
      `reasonCode=${cause.reasonCode}`,
      cause.status !== undefined ? `status=${cause.status}` : '',
      facts.downgrade?.reanchored ? 'reanchored=true' : '',
      `path=${anchored.path}`,
      `line=${lineRange(anchored)}`,
      `side=${anchored.side}`,
    ].filter(Boolean).join(' · '),
    `${INLINE_FALLBACK_PREFIX} reason: ${clean(cause.reason)}`,
    `${INLINE_FALLBACK_PREFIX} finding: id=${input.id} · source=${input.source}${input.corroborated ? `+${input.corroborated}` : ''}`
      + ` · severity=${input.severity} · confidence=${input.confidence} · status=${input.status}`
      + ` · fileLevel=${input.fileLevel === true}`
      + (input.ruleId ? ` · ruleId=${input.ruleId}` : '')
      + (input.rulePackName ? ` · rulePack=${clean(input.rulePackName, 60)}` : '')
      + ` · title=${clean(input.title, 120)}`,
    `${INLINE_FALLBACK_PREFIX} anchor-input: path=${input.path} · line=${lineRange(input)} · side=${input.side}`
      + ` · oldPath=${input.oldPath ?? '-'} · newPath=${input.newPath ?? '-'}`
      + ` · newFile=${input.newFile === true} · deletedFile=${input.deletedFile === true}`
      + ` · snippet=${snippetStats(input)} · evidence=${input.evidence.length}`,
    [
      `${INLINE_FALLBACK_PREFIX} anchor-result: source=${anchor?.source ?? 'none'}`,
      `publishable=${anchor?.publishable ?? false}`,
      `corrected=${facts.position?.corrected === true || anchor?.corrected === true}`,
      anchor?.relocatedFromPath ? `relocatedFromPath=${anchor.relocatedFromPath}` : '',
      `path=${anchored.path} · line=${lineRange(anchored)} · side=${anchored.side}`,
      `lineKind=${kind ?? 'unknown'}`,
      lineRef('lines.start=', facts.position?.lines?.start),
      lineRef('lines.end=', facts.position?.lines?.end),
    ].filter(Boolean).join(' · '),
    `${INLINE_FALLBACK_PREFIX} position: ${positionParams(facts.attempted) ?? '未发出（发布前已判定行内不可用）'}`,
    reanchorLine(facts.downgrade, facts.attempted),
    `${INLINE_FALLBACK_PREFIX} ${diffRefsLine(facts.diffRefs)}`,
    `${INLINE_FALLBACK_PREFIX} ${diffSummaryLine(facts, anchored)}`,
    `${INLINE_FALLBACK_PREFIX} dom: ${domLine(anchored)}`,
  ].filter((line): line is string => line !== undefined);

  if (facts.selection) {
    lines.push(`${INLINE_FALLBACK_PREFIX} selection: ${clean(selectionLabel(facts.selection))} · side=${facts.selection.side ?? '-'}`
      + ` · ${facts.selection.text.length} 字符`);
  }
  const server = serverLine(cause);
  if (server) lines.push(`${INLINE_FALLBACK_PREFIX} ${server}`);
  lines.push([
    `${INLINE_FALLBACK_PREFIX} env: gitlab=${facts.gitlabVersion ?? 'unknown'}`,
    `page=${typeof location === 'undefined' ? '-' : clean(location.href, 200)}`,
    `body=${facts.body?.length ?? 0} 字符`,
  ].join(' · '));
  return lines.map((line) => clean(line, 2000));
}

/**
 * 发布出口的降级日志：只有真降级才出声，console 与调试面板 / 导出包各留一份同样的现场。
 * 返回判定出的降级原因，调用方不需要再算一遍。
 */
export function logInlineFallback(facts: InlineFallbackFacts): InlineFallbackCauseInfo | undefined {
  const cause = inlineFallbackCause(facts);
  if (!cause) return undefined;
  const lines = formatInlineFallback(facts, cause);
  debugBus.logToConsole('warn', 'publish', lines[0], lines.slice(1).join('\n'));
  return cause;
}
