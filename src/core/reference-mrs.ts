import { repoPathCandidates } from './diff';
import { parseGitLabUrl } from './gitlab-url';
import { mapWithConcurrency } from './review-bundles';
import type {
  FileDiff,
  MergeRequestContext,
  MergeRequestRef,
  MrLinkRef,
  ReferenceMr,
} from './types';

/** 参考块总预算：参考资料是配菜，不能挤掉当前 MR 的 diff。 */
export const REFERENCE_BUDGET_CHARACTERS = 24_000;
const MIN_PER_REFERENCE = 2_000;
const FETCH_CONCURRENCY = 2;

export interface MrLinkParseFailure {
  input: string;
  reason: string;
}

export interface MrLinkParseResult {
  refs: MrLinkRef[];
  invalid: MrLinkParseFailure[];
}

/** GitLab 的 references.full 写法：group/project!12。 */
const MR_SHORTHAND = /^([^!/]+(?:\/[^!/]+)*)!(\d+)$/;
/** 粘贴时常见的包裹与尾随标点：MR 链接不会以这些字符结尾。 */
const LEADING_NOISE = /^[<(\[{"'“「]+/;
const TRAILING_NOISE = /[>)\]}.,;:!?'"”」。，；：！？]+$/;

function cleanLinkToken(token: string) {
  return token.trim().replace(LEADING_NOISE, '').replace(TRAILING_NOISE, '');
}

export function mrLinkKey(ref: MrLinkRef) {
  return `${ref.origin}|${ref.projectPath}|${ref.iid}`;
}

export function mrLinkLabel(ref: MrLinkRef) {
  return `${ref.projectPath}!${ref.iid}`;
}

export function mrWebUrl(ref: MrLinkRef) {
  return `${ref.origin}/${ref.projectPath}/-/merge_requests/${ref.iid}`;
}

export function isSameMr(left: MrLinkRef, right: MrLinkRef) {
  return mrLinkKey(left) === mrLinkKey(right);
}

export function parseMrLink(input: string, fallbackOrigin?: string): { ref?: MrLinkRef; reason?: string } {
  const token = cleanLinkToken(input);
  if (!token) return { reason: '空链接' };

  const shorthand = MR_SHORTHAND.exec(token);
  if (shorthand) {
    if (!fallbackOrigin) return { reason: `${token} 不是完整链接，无法确定 GitLab 地址` };
    return { ref: { origin: fallbackOrigin, projectPath: shorthand[1], iid: Number(shorthand[2]) } };
  }

  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return { reason: `${token} 不是可解析的链接` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { reason: `${token} 不是 http(s) 链接` };
  }
  const parsed = parseGitLabUrl(url);
  if (!parsed.projectPath) return { reason: `${token} 里读不到 GitLab 项目路径` };
  if (!parsed.mergeRequestIid) return { reason: `${token} 不是 Merge Request 链接` };
  return {
    ref: { origin: parsed.origin, projectPath: parsed.projectPath, iid: parsed.mergeRequestIid },
  };
}

/** 一段文本里按换行/空格/逗号分隔的多个 MR 链接，去重后按出现顺序返回。 */
export function parseMrLinks(text: string, fallbackOrigin?: string): MrLinkParseResult {
  const refs: MrLinkRef[] = [];
  const invalid: MrLinkParseFailure[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/[\s,;，；]+/).filter(Boolean)) {
    const token = cleanLinkToken(raw);
    if (!token) continue;
    const { ref, reason } = parseMrLink(token, fallbackOrigin);
    if (!ref) {
      invalid.push({ input: token, reason: reason ?? '无法识别的链接' });
      continue;
    }
    const key = mrLinkKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }

  return { refs, invalid };
}

export interface ReferenceMrApi {
  getMergeRequest(ref: MergeRequestRef): Promise<MergeRequestContext>;
  listDiffs(ref: MergeRequestRef, options?: { signal?: AbortSignal }): Promise<FileDiff[]>;
}

export type ReferenceMrApiFactory = (ref: MrLinkRef) => ReferenceMrApi;

export function referenceMergeRequestRef(ref: MrLinkRef): MergeRequestRef {
  return { origin: ref.origin, projectPath: ref.projectPath, mergeRequestIid: ref.iid };
}

/** 失败原因说人话：哪个链接、什么状态码、下一步能怎么办。 */
export function describeReferenceFailure(ref: MrLinkRef, error: unknown): string {
  const status = (error as { status?: number })?.status;
  const detail = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) return `GitLab 拒绝了请求（HTTP ${status}）：Token 无效或没有 ${ref.projectPath} 的读权限`;
  if (status === 404) return `找不到 ${mrLinkLabel(ref)}（HTTP 404）：MR 不存在、被删除，或 Token 看不到该项目`;
  if (status === 0) return `连不上 ${ref.origin}：网络不可达，或该实例不允许跨域请求`;
  return detail;
}

export async function loadReferenceMr(ref: MrLinkRef, api: ReferenceMrApi, signal?: AbortSignal): Promise<ReferenceMr> {
  const target = referenceMergeRequestRef(ref);
  const addedAt = new Date().toISOString();
  try {
    const [context, files] = await Promise.all([
      api.getMergeRequest(target),
      api.listDiffs(target, { signal }),
    ]);
    return {
      ref, status: 'ready', files, addedAt,
      title: context.title,
      headSha: context.diffRefs.headSha,
      ...(files.length === 0 ? { error: '这个 MR 没有读到任何变更文件（可能是空 MR，或 diff 还没生成）' } : {}),
    };
  } catch (error) {
    if (signal?.aborted || (error as Error)?.name === 'AbortError') throw error;
    return { ref, status: 'failed', files: [], addedAt, error: describeReferenceFailure(ref, error) };
  }
}

export async function loadReferenceMrs(
  refs: MrLinkRef[],
  factory: ReferenceMrApiFactory,
  signal?: AbortSignal,
): Promise<ReferenceMr[]> {
  return mapWithConcurrency(refs, FETCH_CONCURRENCY, (ref) => loadReferenceMr(ref, factory(ref), signal));
}

function pathKeys(path: string): string[] {
  return repoPathCandidates(path).map((candidate) => candidate.toLowerCase());
}

/**
 * 只属于参考 MR 的路径（当前 MR 也改了同名文件时不算，那种 Finding 本来就落在当前 diff 上）。
 * 用来拦掉模型对参考变更产出的 Finding：参考变更不是评审对象。
 */
export function referenceOnlyPathKeys(references: ReferenceMr[], currentFiles: FileDiff[]): Set<string> {
  const keys = new Set<string>();
  for (const reference of references) {
    if (reference.status !== 'ready') continue;
    for (const file of reference.files) {
      for (const path of [file.newPath, file.oldPath]) {
        if (path && path !== '/dev/null') for (const key of pathKeys(path)) keys.add(key);
      }
    }
  }
  for (const file of currentFiles) {
    for (const path of [file.newPath, file.oldPath]) {
      if (path) for (const key of pathKeys(path)) keys.delete(key);
    }
  }
  return keys;
}

export function isReferenceOnlyPath(path: string, keys: Set<string>): boolean {
  if (keys.size === 0) return false;
  return pathKeys(path).some((key) => keys.has(key));
}

export function referenceFilesOf(references: ReferenceMr[]): FileDiff[] {
  return references.filter((reference) => reference.status === 'ready').flatMap((reference) => reference.files);
}

export interface ReferenceBlock {
  text: string;
  characters: number;
  fileCount: number;
}

/**
 * 参考块：明确标注「只读上下文、不是评审对象」，每个文件都带上来源 MR，
 * 避免模型把参考路径当成当前 MR 的路径。
 */
export function referenceContextBlock(
  references: ReferenceMr[],
  budgetCharacters: number = REFERENCE_BUDGET_CHARACTERS,
): ReferenceBlock {
  const ready = references.filter((reference) => reference.status === 'ready' && reference.files.length > 0);
  if (ready.length === 0) return { text: '', characters: 0, fileCount: 0 };

  const perReference = Math.max(MIN_PER_REFERENCE, Math.floor(budgetCharacters / ready.length));
  const sections: string[] = [];
  let fileCount = 0;

  ready.forEach((reference, index) => {
    const label = mrLinkLabel(reference.ref);
    const lines: string[] = [
      `### 参考 MR ${index + 1}：${label}${reference.title ? ` — ${reference.title}` : ''}`,
      `来源：${mrWebUrl(reference.ref)}${reference.headSha ? ` · head ${reference.headSha.slice(0, 8)}` : ''} · ${reference.files.length} 个变更文件`,
    ];
    let used = lines.join('\n').length;
    let included = 0;

    for (const file of reference.files) {
      const chunk = `#### [参考 ${label}] ${file.newPath}\n${file.diff}`;
      if (used + chunk.length > perReference) break;
      lines.push(chunk);
      used += chunk.length;
      included += 1;
    }
    if (included < reference.files.length) {
      lines.push(`（其余 ${reference.files.length - included} 个参考文件按预算省略）`);
    }
    fileCount += included;
    sections.push(lines.join('\n\n'));
  });

  const text = [
    '## 参考变更：其他 MR（只读上下文，不是评审对象）',
    '下面是与当前 MR 配套的其他 MR 的变更，只用于理解跨项目/跨仓库的整体改动意图。',
    '不要对参考变更本身产出 finding；所有 finding 的 path 必须来自当前 MR 的变更文件。',
    '如果当前 MR 与参考变更不一致（接口、字段、协议、版本号对不上），就在当前 MR 的文件上报告这个不一致。',
    '',
    sections.join('\n\n'),
  ].join('\n');

  return { text, characters: text.length, fileCount };
}
