import { normalizeFileDiff } from './diff';
import { sha1Hex } from './sha1';
import { buildFullTextComment } from './findings';
import { parseGitLabUrl, projectApiIdentifier } from './gitlab-url';
import { debugBus } from './debug-bus';
import { httpRequest } from './http';
import { isPublishRequest, logPublishRequest } from './publish-request-log';
import type {
  AdapterCapabilities,
  DiffRefs,
  DiscussionDraft,
  DiscussionPosition,
  FileDiff,
  Finding,
  MergeRequestContext,
  MergeRequestRef,
  MrCommit,
  PageContext,
  PositionLineRef,
  PositionReanchor,
  PositionReanchorResult,
  PublishDowngrade,
  RecentMergeRequest,
  PublishedComment,
  PublishedDiscussion,
} from './types';

/**
 * 一次读到的 MR 变更快照：context.diffRefs 与 files 同源，发布 position 的三个 sha 只能从这里取。
 */
export interface MrDiffSnapshot {
  context: MergeRequestContext;
  files: FileDiff[];
}

export class GitLabApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = `gitlab_http_${status}`,
  ) {
    super(message);
    this.name = 'GitLabApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** MR commits API 的一条原始提交：字段随 GitLab 版本有出入，缺失一律落成空串。 */
interface RawMrCommit {
  id?: string;
  short_id?: string;
  title?: string;
  message?: string;
  author_name?: string;
  created_at?: string;
}

/** title 缺失时用 message 第一行顶上：GitLab 自己也是这么算 title 的。 */
export function normalizeMrCommit(raw: RawMrCommit): MrCommit {
  const id = String(raw.id ?? '');
  const message = String(raw.message ?? '');
  return {
    id,
    shortId: String(raw.short_id ?? id.slice(0, 8)),
    title: String(raw.title ?? message.split('\n')[0] ?? ''),
    message,
    authorName: String(raw.author_name ?? ''),
    createdAt: String(raw.created_at ?? ''),
  };
}

/** GitLab commits API 的一个文件动作：content 是完整文件内容，不是增量。 */
export interface CommitFile {
  path: string;
  content: string;
  action: 'create' | 'update';
}

export interface CommitDraft {
  branch: string;
  /** commit 标题。 */
  message: string;
  /** commit 正文，GitLab 会拼在标题之后。 */
  description?: string;
  files: CommitFile[];
}

export interface CreatedCommit {
  id: string;
  shortId: string;
  title: string;
  webUrl: string;
}

/**
 * commits API 只收 JSON（actions 是数组，form-encoding 写不出来）。
 * 正文自己拼在标题后面：GitLab 的 commit_description 会被部分版本直接忽略
 * （19.x 上提交出来的 message 只剩标题），而 commit_message 里的空行分段
 * 一定落成 git 的 subject + body。
 */
export function buildCommitPayload(draft: CommitDraft): string {
  const description = draft.description?.trim() ?? '';
  return JSON.stringify({
    branch: draft.branch,
    commit_message: description ? `${draft.message.trim()}\n\n${description}` : draft.message.trim(),
    actions: draft.files.map((file) => ({
      action: file.action,
      file_path: file.path,
      content: file.content,
    })),
  });
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 默认传输走 httpRequest：Tampermonkey 沙箱里裸 fetch 的 origin 是扩展本身，
 * 对自部署 GitLab 属于跨域会被 CORS 拦截；GM.xmlHttpRequest 带 Cookie 且不受
 * CSP/CORS 限制，无 GM 环境（如 E2E 注入主世界）回退到 fetch。
 */
const defaultFetcher: FetchLike = async (input, init) => {
  const result = await httpRequest(input, {
    method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD',
    headers: init?.headers as Record<string, string> | undefined,
    body: init?.body == null ? undefined : String(init.body),
    signal: init?.signal ?? undefined,
  });
  return new Response(result.text, { status: result.status });
};

function csrfToken() {
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
}

function errorCode(status: number) {
  const codes: Record<number, string> = {
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    422: 'line_out_of_diff',
    429: 'rate_limited',
  };
  return codes[status] ?? `gitlab_http_${status}`;
}

type RawDiff = Parameters<typeof normalizeFileDiff>[0];

/** MR diff 版本列表的一条：GitLab 每次 push 收集一个版本，三个 sha 与那份 diff 同属一个版本。 */
interface RawDiffVersion {
  id: number;
  head_commit_sha?: string;
  base_commit_sha?: string;
  start_commit_sha?: string;
  state?: string;
}

interface RawDiffVersionDetail extends RawDiffVersion {
  diffs?: RawDiff[];
}

interface RawMergeRequestSummary {
  iid: number;
  title?: string;
  state?: string;
  source_branch?: string;
  target_branch?: string;
  updated_at?: string;
  web_url?: string;
}

/** position 的 JSON 结构：键名逐字抄 19.4 容器 app/validators/json_schemas/position.json。 */
export interface PositionLineRangeEndpoint {
  line_code: string;
  type: 'old' | 'new';
  old_line?: number;
  new_line?: number;
}

export interface DiscussionPositionPayload {
  position_type: 'text';
  base_sha?: string;
  head_sha?: string;
  start_sha?: string;
  new_path?: string;
  old_path?: string;
  old_line?: number;
  new_line?: number;
  line_range?: { start: PositionLineRangeEndpoint; end: PositionLineRangeEndpoint };
}

/** 空值字段一律不发：GitLab 收到 base_sha: '' 会把整个 diff_refs 判为不完整。 */
function optionalField(value: string) {
  return value || undefined;
}

/**
 * old_path / new_path 都必须写真实路径：新增或删除文件填 /dev/null 会被当成 diff 路径过滤条件
 * 传给 Gitaly，GitLab 直接 500（eachDiff: exit status 128）。
 */
function setPositionPath(...candidates: (string | undefined)[]) {
  return candidates.find((candidate) => candidate && candidate !== '/dev/null') ?? '';
}

/**
 * GitLab 的 line_for_position 拿 (old_line, new_line) 同时比对 diff 行：added 行只有 new_line、
 * removed 行只有 old_line、context 行两者都有。只按 side 填一侧，context 行就匹配不到任何 diff 行，
 * Note 以 `line_code can't be blank` 400；自己凑一对同样匹配不到。配对只能取自真实 diff 行。
 * JSON 里行号原生就是整数（position.json 的 old_line / new_line 是 integer），不再靠 form 的字符串强转。
 */
function positionLines(line: PositionLineRef) {
  return { old_line: line.oldLine, new_line: line.newLine };
}

/** 没有 diff 行配对时的兜底：按 side 填一侧，至少 added / removed 行还能发出去。 */
function sideLineRef(side: 'old' | 'new', line: number): PositionLineRef {
  return side === 'new' ? { newLine: line } : { oldLine: line };
}

/**
 * GitLab 算 line_code 的路径口径是 `new_path.presence || old_path`
 * （lib/gitlab/diff/file.rb#file_path，MergeRequests::ResolveDiffPositionService 也照这个解析），
 * 和 payload 里 new_path 用的是同一个值：rename 后哈希的是新路径。
 */
function lineCodePath(position: DiscussionPosition) {
  return setPositionPath(position.newPath, position.oldPath, position.path)
    || setPositionPath(position.oldPath, position.newPath, position.path);
}

/**
 * `SHA1(file_path)_old_line_new_line`（lib/gitlab/git.rb#diff_line_code）。缺的那一侧按
 * ResolveDiffPositionService#build_line_range_entry 的口径补 0，不是留空串——新增文件与删除文件
 * 本来就是这个值（GitLab 解析器给它们的 old_pos / new_pos 就是 0）。
 * 已知差异：改动文件里的新增 / 删除行，GitLab 页面上那行自己的 line_code 用的是 old_pos / new_pos
 * （插入点行号，非 0），前端按 start.line_code 找范围起点会落空、整段不高亮；评论本身照常创建，
 * 挂在顶层 position 那一行上（与 0.4.22 一致，不是回归）。
 */
function lineCode(filePath: string, line: PositionLineRef) {
  return `${sha1Hex(filePath)}_${line.oldLine ?? 0}_${line.newLine ?? 0}`;
}

/**
 * 文档口径：本 commit 新增的行（只有 new_line）才是 'new'，删除行与上下文行一律 'old'。
 * GitLab 自己的 ResolveDiffPositionService 对上下文行给 nil，但文档把这 4 个键标成必填、
 * 类型是 string，老版本严格校验时 null 一样会被 schema 拒，所以恒发字符串。
 */
function lineAge(line: PositionLineRef): 'old' | 'new' {
  return line.newLine !== undefined && line.oldLine === undefined ? 'new' : 'old';
}

/**
 * line_range 的 start / end 各自 4 个键都是官方文档标的 Required：line_code、type、old_line、new_line。
 * 19.4 的 position.json 没写 required，缺键本地照样 201；老 GitLab 严格校验就是
 * 400 `position must be a valid json schema`。
 */
function lineRangeEndpoint(filePath: string, line: PositionLineRef): PositionLineRangeEndpoint {
  return { line_code: lineCode(filePath, line), type: lineAge(line), ...positionLines(line) };
}

/**
 * 由 DiscussionPosition 构造真实的 position 对象：JSON 直发原生结构，undefined 键由
 * JSON.stringify 自动省略，不需要手工拼任何字符串。
 */
export function buildDiscussionPosition(position: DiscussionPosition): DiscussionPositionPayload {
  // 顶层 old_line / new_line 描述的是评论结束行，必须和该行在 diff 里的配对完全一致。
  const end = position.end ?? sideLineRef(position.side, position.endLine);
  const payload: DiscussionPositionPayload = {
    position_type: 'text',
    base_sha: optionalField(position.diffRefs.baseSha),
    head_sha: optionalField(position.diffRefs.headSha),
    start_sha: optionalField(position.diffRefs.startSha),
    new_path: optionalField(setPositionPath(position.newPath, position.oldPath, position.path)),
    old_path: optionalField(setPositionPath(position.oldPath, position.newPath, position.path)),
    ...positionLines(end),
  };
  // 单行评论不进 line_range：文档的单行示例也只有顶层 old_line / new_line。
  if (position.startLine === position.endLine) return payload;

  const filePath = lineCodePath(position);
  return {
    ...payload,
    line_range: {
      start: lineRangeEndpoint(filePath, position.start ?? sideLineRef(position.side, position.startLine)),
      end: lineRangeEndpoint(filePath, end),
    },
  };
}

/**
 * discussions 端点发 JSON body：form 编码会把嵌套的 position[line_range][start][line_code] 拆成一堆
 * 平铺字段，老 GitLab 与油猴 GM.xmlHttpRequest 这条链路上解析出来的 position 不是合法结构，
 * 一律 400 `position 必须是有效的 json schema`。
 * 无 position 时只带 body，GitLab 会创建 MR 级全文评论。
 * position 会被 GitLab 原样存下并按 json schema 校验（additionalProperties: false），
 * 多一个键就是 `position must be a valid json schema`，所以只发 schema 里存在的键。
 */
export function buildDiscussionPayload(input: DiscussionDraft): string {
  return JSON.stringify(input.position
    ? { body: input.body, position: buildDiscussionPosition(input.position) }
    : { body: input.body });
}

/** GitLab 判 position 非法的状态码：行号不在 diff 内、路径不在 MR 里、diff_refs 过期。 */
const POSITION_REJECTED = new Set([400, 409, 422]);

function isPositionRejection(error: unknown): error is GitLabApiError {
  return error instanceof GitLabApiError && POSITION_REJECTED.has(error.status);
}

/**
 * GitLab 只回一句 `line_code can't be blank` / `position must be a valid json schema`，用户看不出所以然，
 * 按状态码翻成人话，再把原文截短附在后面便于排查。
 */
export function positionRejectionReason(error: GitLabApiError): string {
  const head = error.status === 409
    ? 'MR 已更新，这条 Finding 的 diff 位置已过期'
    : error.status === 422
      ? '行号不在当前 Diff 范围内'
      : 'GitLab 拒绝了这个行内位置';
  // 原始报错是 `GitLab API 400：{"message":"400 Bad request - Note {...}"}`：剥掉包装，只留 GitLab 自己那句话
  const raw = error.message.replace(/^GitLab API \d+：/, '').trim();
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (parsed.message !== undefined) {
      detail = typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed.message);
    }
  } catch {
    // 不是 JSON（网络层兜底文案等）就原样用
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 120);
  return detail ? `${head}（${detail}）` : head;
}

/**
 * 行内被拒后的降级信息：409 重锚过就把重锚结果写进原因（用户要看得出是 MR 更新了、脚本也试过救），
 * 并带回重锚后重发用的那份 position，降级日志才能同时给出两次参数。
 */
function rejectionDowngrade(error: GitLabApiError, attempt?: PositionReanchorResult): PublishDowngrade {
  const rejected = positionRejectionReason(error);
  if (!attempt) return { reason: rejected, status: error.status, serverMessage: error.message };
  const reanchorReason = attempt.position
    ? `重发仍被 GitLab 拒绝（${rejected}）`
    : attempt.reason ?? rejected;
  return {
    reason: `MR 已更新，已尝试重锚：${reanchorReason}`,
    status: error.status,
    serverMessage: error.message,
    reanchored: true,
    reanchorReason,
    ...(attempt.position ? { reanchorPosition: attempt.position } : {}),
  };
}

export class GitLabAdapter {
  constructor(
    private readonly page: PageContext,
    private readonly gitlabToken = '',
    private readonly fetcher: FetchLike = defaultFetcher,
  ) {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };
    if (this.gitlabToken) headers['PRIVATE-TOKEN'] = this.gitlabToken;
    if (options.method === 'POST') {
      headers['X-CSRF-Token'] = csrfToken();
      // 只剩 approveMergeRequest 这种没有 body 的端点吃这个默认值；带 body 的一律显式声明 JSON。
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
    }

    const url = `${this.page.origin}${path}`;
    // 发布链路的每一次写请求都留一份完整现场（URL / headers / body 原文 / 响应 / curl 重放）：
    // 用户老实例上的 400 只能靠这条真实发出的请求定位，脚本侧的 position 参数替代不了它。
    const scene = isPublishRequest(method, path) ? { method, url, headers, body: options.body } : undefined;

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        body: options.body,
        credentials: 'same-origin',
        signal: options.signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      const ms = Date.now() - startedAt;
      debugBus.network({ kind: 'gitlab', method, url: path, ms, error: 'network_error' });
      debugBus.log('error', 'gitlab', `${method} ${path} 连接失败`, String(error));
      if (scene) logPublishRequest({ ...scene, ok: false, ms, error: String(error) });
      throw new GitLabApiError(0, `无法连接 GitLab API：${String(error)}`, 'network_error');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      const ms = Date.now() - startedAt;
      debugBus.network({ kind: 'gitlab', method, url: path, status: response.status, ms, error: detail.slice(0, 200) });
      debugBus.log('error', 'gitlab', `${method} ${path} → HTTP ${response.status}`, detail.slice(0, 300));
      if (scene) logPublishRequest({ ...scene, ok: false, ms, status: response.status, responseText: detail });
      throw new GitLabApiError(
        response.status,
        `GitLab API ${response.status}：${detail.slice(0, 300)}`,
        errorCode(response.status),
      );
    }

    const payload = (await response.json()) as T;
    const ms = Date.now() - startedAt;
    debugBus.network({
      kind: 'gitlab', method, url: path, status: response.status,
      ms, bytes: JSON.stringify(payload).length,
    });
    if (scene) logPublishRequest({ ...scene, ok: true, ms, status: response.status });
    return payload;
  }

  private async requestText(path: string, options: RequestOptions = {}): Promise<string> {
    const headers: Record<string, string> = {
      Accept: 'text/plain',
      ...options.headers,
    };
    if (this.gitlabToken) headers['PRIVATE-TOKEN'] = this.gitlabToken;

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetcher(`${this.page.origin}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        credentials: 'same-origin',
        signal: options.signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      debugBus.network({ kind: 'gitlab', method: options.method ?? 'GET', url: path, ms: Date.now() - startedAt, error: 'network_error' });
      throw new GitLabApiError(0, `无法连接 GitLab API：${String(error)}`, 'network_error');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      debugBus.network({ kind: 'gitlab', method: options.method ?? 'GET', url: path, status: response.status, ms: Date.now() - startedAt, error: detail.slice(0, 200) });
      debugBus.log('error', 'gitlab', `${options.method ?? 'GET'} ${path} → HTTP ${response.status}`, detail.slice(0, 300));
      throw new GitLabApiError(
        response.status,
        `GitLab API ${response.status}：${detail.slice(0, 300)}`,
        errorCode(response.status),
      );
    }
    const text = await response.text();
    debugBus.network({ kind: 'gitlab', method: options.method ?? 'GET', url: path, status: response.status, ms: Date.now() - startedAt, bytes: text.length });
    return text;
  }

  private projectRef() {
    return projectApiIdentifier(this.page);
  }

  async probe(): Promise<AdapterCapabilities> {
    try {
      await this.request('/api/v4/user');
      return { authenticated: true, canReadMergeRequests: true, canCreateDiscussions: true };
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 401) {
        return { authenticated: false, canReadMergeRequests: false, canCreateDiscussions: false };
      }
      return { authenticated: false, canReadMergeRequests: true, canCreateDiscussions: false };
    }
  }

  async getMergeRequest(ref: MergeRequestRef): Promise<MergeRequestContext> {
    const data = await this.request<Record<string, unknown>>(
      `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}`,
    );
    const refs = data.diff_refs as Partial<Record<'base_sha' | 'head_sha' | 'start_sha', string>> | null;
    const diffRefs: DiffRefs = {
      baseSha: refs?.base_sha ?? String(data.diff_head_sha ?? ''),
      headSha: refs?.head_sha ?? String(data.sha ?? ''),
      startSha: refs?.start_sha ?? refs?.base_sha ?? String(data.diff_head_sha ?? ''),
    };

    return {
      ...ref,
      title: String(data.title ?? ''),
      description: data.description == null ? '' : String(data.description),
      state: String(data.state ?? 'opened'),
      sourceBranch: String(data.source_branch ?? ''),
      targetBranch: String(data.target_branch ?? ''),
      sha: String(data.sha ?? diffRefs.headSha),
      diffRefs,
    };
  }

  /**
   * MR 的提交列表：需求细节常常只写在 commit message 里，评审要当背景读。
   * 一页 100 条已经等于上下文条数上限，只有整页拿满时才继续翻页，
   * 多读的页只用于在省略标记里给出准确条数（上限 3 页 / 300 条）。
   */
  async listMrCommits(
    ref: MergeRequestRef,
    options: { signal?: AbortSignal } = {},
  ): Promise<MrCommit[]> {
    const raw: RawMrCommit[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const data = await this.request<RawMrCommit[]>(
        `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/commits?per_page=100&page=${page}`,
        { signal: options.signal },
      );
      raw.push(...data);
      if (data.length < 100) break;
    }
    return raw.map(normalizeMrCommit);
  }

  /**
   * 行内评论 position 的 base_sha / start_sha / head_sha 与行号必须同源：分两次请求取
   * （MR 详情拿 sha、diffs 拿行号），中间 MR 被 push 就是「旧行号 + 新 sha」，
   * GitLab 不报 409 而是直接 400 `line_code can't be blank`，从报错里看不出是 sha 混了。
   * versions/:id 一个响应里同时给三个 sha 和那份 diff，取到的天然同源；
   * GitLab 还没收集出 diff 版本（老版本没这个接口 / state=empty / diffs 为空）才回落到 MR 详情 + diffs 两次读。
   */
  async fetchMrDiffSnapshot(
    ref: MergeRequestRef,
    options: { onPage?: (loaded: number, hasMore: boolean) => void; signal?: AbortSignal } = {},
  ): Promise<MrDiffSnapshot> {
    const context = await this.getMergeRequest(ref);
    const version = await this.diffVersionSnapshot(ref, context.diffRefs.headSha, options.signal);
    if (version) {
      return { context: { ...context, diffRefs: version.diffRefs }, files: version.files };
    }
    return { context, files: await this.listDiffs(ref, options) };
  }

  /** 优先取 head_sha 对得上的那个版本，取不到就取最新的一个；版本详情里没 diff 就当没有。 */
  private async diffVersionSnapshot(
    ref: MergeRequestRef,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<{ diffRefs: DiffRefs; files: FileDiff[] } | undefined> {
    const base = `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/versions`;
    try {
      const versions = await this.request<RawDiffVersion[]>(`${base}?per_page=100`, { signal });
      // 老 GitLab 没有这个接口（404），网关也可能把它包成 200 + 错误体：都当「没有版本可读」回落
      const picked = Array.isArray(versions)
        ? versions.find((version) => version.head_commit_sha === headSha) ?? versions[0]
        : undefined;
      if (!picked?.id) return undefined;

      const detail = await this.request<RawDiffVersionDetail>(`${base}/${picked.id}`, { signal });
      const raw = detail?.diffs;
      if (!Array.isArray(raw) || raw.length === 0) return undefined;

      const diffRefs: DiffRefs = {
        baseSha: detail.base_commit_sha ?? '',
        headSha: detail.head_commit_sha ?? '',
        startSha: detail.start_commit_sha ?? detail.base_commit_sha ?? '',
      };
      debugBus.log('debug', 'gitlab', `diff_refs 与 diff 取自同一个版本响应 !${ref.mergeRequestIid} v${picked.id}`, [
        `head=${diffRefs.headSha.slice(0, 8)}`,
        `base=${diffRefs.baseSha.slice(0, 8)}`,
        `start=${diffRefs.startSha.slice(0, 8)}`,
        `files=${raw.length}`,
      ].join(' · '));
      return { diffRefs, files: raw.map(normalizeFileDiff) };
    } catch {
      return undefined;
    }
  }

  async listDiffs(
    ref: MergeRequestRef,
    options: { onPage?: (loaded: number, hasMore: boolean) => void; signal?: AbortSignal } = {},
  ): Promise<FileDiff[]> {
    // Fetch first page to determine total
    const firstPage = await this.request<RawDiff[]>(
      `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/diffs?per_page=20&page=1`,
      { signal: options.signal },
    );

    if (firstPage.length < 20) {
      options.onPage?.(firstPage.length, false);
      return firstPage.map(normalizeFileDiff);
    }

    // Parallel fetch remaining pages with concurrency limit of 3
    const allRaw: RawDiff[][] = [firstPage];
    let page = 2;
    let hasMore = true;
    const CONCURRENCY = 3;

    while (hasMore && page <= 50) {
      const batchPages: number[] = [];
      for (let i = 0; i < CONCURRENCY && page <= 50; i += 1) {
        batchPages.push(page);
        page += 1;
      }

      const batchResults = await Promise.all(
        batchPages.map((p) =>
          this.request<RawDiff[]>(
            `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/diffs?per_page=20&page=${p}`,
            { signal: options.signal },
          ).catch(() => null),
        ),
      );

      for (const result of batchResults) {
        if (result === null) {
          // Page failed but don't stop — try next batch
          continue;
        }
        if (result.length === 0) {
          hasMore = false;
          break;
        }
        allRaw.push(result);
        if (result.length < 20) {
          hasMore = false;
          break;
        }
      }

      options.onPage?.(allRaw.reduce((sum, chunk) => sum + chunk.length, 0), hasMore);
    }

    return allRaw.flat().map(normalizeFileDiff);
  }

  async createDiscussion(
    ref: MergeRequestRef,
    draft: DiscussionDraft,
  ): Promise<PublishedDiscussion> {
    if (draft.position) {
      const current = await this.getMergeRequest(ref);
      if (current.diffRefs.headSha !== draft.position.diffRefs.headSha) {
        throw new GitLabApiError(409, 'MR 已更新，当前 Finding 的 diff_refs 已过期', 'stale_diff_refs');
      }
    }

    const discussions = await this.listDiscussions(ref);
    const existing = discussions.find((discussion) =>
      discussion.notes?.some((note) => note.body === draft.body),
    );
    if (existing) {
      return {
        id: existing.id,
        noteId: String(existing.notes?.[0]?.id ?? ''),
        deduplicated: true,
      };
    }

    const response = await this.request<{ id: string; notes?: { id: number }[] }>(
      `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/discussions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildDiscussionPayload(draft),
      },
    );
    return {
      id: response.id,
      noteId: String(response.notes?.[0]?.id ?? ''),
    };
  }

  /**
   * 发布一条评论：有 diff 行号就创建行内 Discussion；没有行号、或行内被 GitLab 拒
   * （400/409/422 等 position 错误）就降级为 MR 级全文评论重发一次，发布不会因为行号失败。
   * 409 不再直接降级：它只说明手里的 diff_refs 过期（评审到发布之间 MR 被 push 了新 commit），
   * 给了 reanchor 钩子就先重新拉 diff_refs、在新 diff 上重跑 anchor 再发一次；两轮封顶，重发仍被拒才降级。
   * 降级不静默：原因写进 debugBus 计数与返回值，UI 直接告诉用户为什么没挂到行上。
   */
  async publishComment(
    ref: MergeRequestRef,
    finding: Finding,
    body: string,
    position?: DiscussionPosition,
    reanchor?: PositionReanchor,
  ): Promise<PublishedComment> {
    let downgrade: PublishDowngrade | undefined;
    let current = position;
    let reanchored = false;
    let attempt: PositionReanchorResult | undefined;
    if (position) {
      for (let round = 0; round < 2 && current; round += 1) {
        try {
          const published = await this.createDiscussion(ref, { body, position: current });
          if (reanchored) {
            debugBus.count('publish-inline-reanchored');
            debugBus.log('info', 'publish', `MR 已更新，行内位置 409 后重锚成功，行内评论保住 ${finding.path}:${finding.line}`, [
              `head=${current.diffRefs.headSha.slice(0, 8)}`,
              `line=${current.startLine}${current.endLine > current.startLine ? `-${current.endLine}` : ''}`,
              `side=${current.side}`,
            ].join(' · '));
          }
          return { ...published, mode: 'inline', ...(reanchored ? { reanchored: true } : {}) };
        } catch (error) {
          if (!isPositionRejection(error)) throw error;
          // 只有 409 才是 diff_refs 过期，才值得重锚；400 / 422 是位置本身不合法，重锚也救不回来
          if (error.status === 409 && reanchor && !reanchored) {
            reanchored = true;
            attempt = await reanchor(current, error);
            if (attempt.position) {
              current = attempt.position;
              continue;
            }
            current = undefined;
          }
          downgrade = rejectionDowngrade(error, reanchored ? attempt : undefined);
          debugBus.count(`publish-inline-rejected:${error.status}`);
          if (reanchored) debugBus.count('publish-inline-reanchor-failed');
          debugBus.log(
            'warn', 'publish',
            reanchored
              ? `行内位置 409，重锚后仍失败（HTTP ${error.status}），改为全文评论 ${finding.path}:${finding.line}`
              : `行内位置被 GitLab 拒绝（HTTP ${error.status}），改为全文评论 ${finding.path}:${finding.line}`,
            [error.message, reanchored ? `重锚：${downgrade.reanchorReason ?? '无新位置'}` : ''].filter(Boolean).join('\n'),
          );
          break;
        }
      }
    }
    const discussion = await this.createDiscussion(ref, { body: buildFullTextComment(finding, body) });
    return { ...discussion, mode: 'full', ...(downgrade ? { downgrade } : {}) };
  }

  /** 一键 Approve 当前 MR。 */
  async approveMergeRequest(ref: MergeRequestRef) {
    await this.request<{ id: number }>(
      `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/approve`,
      { method: 'POST' },
    );
  }

  /** 发布 MR 级总评论（不带行位置）。 */
  async createNote(ref: MergeRequestRef, body: string) {
    return this.request<{ id: number }>(
      `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/notes`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) },
    );
  }

  async listDiscussions(ref: MergeRequestRef) {
    const discussions: { id: string; notes?: { id: number; body: string; author?: { username?: string } }[] }[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const data = await this.request<{ id: string; notes?: { id: number; body: string; author?: { username?: string } }[] }[]>(
        `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/discussions?per_page=20&page=${page}`,
      );
      discussions.push(...data);
      if (data.length < 20) break;
    }
    return discussions;
  }

  /**
   * Fetch existing discussion bodies for duplicate detection.
   * Returns a set of normalized comment bodies.
   */
  async getExistingCommentBodies(ref: MergeRequestRef): Promise<Set<string>> {
    try {
      const discussions = await this.listDiscussions(ref);
      const bodies = new Set<string>();
      for (const discussion of discussions) {
        for (const note of discussion.notes ?? []) {
          bodies.add(note.body.trim());
        }
      }
      return bodies;
    } catch {
      return new Set(); // Graceful fallback if discussions can't be read
    }
  }

  async getFile(path: string, ref: string, signal?: AbortSignal) {
    return this.requestText(
      `/api/v4/projects/${this.projectRef()}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      { signal },
    );
  }

  /**
   * 向指定分支提交一次改动。修复链路只写 MR 的源分支，目标分支永不参与；
   * 分支被保护或 Token 权限不足时 GitLab 返回 403，冲突返回 409，都由调用方明示。
   */
  async createCommit(draft: CommitDraft): Promise<CreatedCommit> {
    const commit = await this.request<{ id: string; short_id: string; title: string; web_url: string }>(
      `/api/v4/projects/${this.projectRef()}/repository/commits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildCommitPayload(draft),
      },
    );
    debugBus.log(
      'info', 'gitlab', `已提交 ${commit.short_id} 到 ${draft.branch}`,
      draft.files.map((file) => `${file.action} ${file.path}`).join(', '),
    );
    return { id: commit.id, shortId: commit.short_id, title: commit.title, webUrl: commit.web_url };
  }

  /**
   * Get diffs for a single commit.
   */
  /**
   * 递归列出仓库树。GitLab 没有符号级 REST API，
   * 符号索引需要先拿到文件清单再逐个读取 raw 内容。
   */
  async listTree(
    ref: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ path: string; type: string }[]> {
    const entries: { path: string; type: string }[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.request<{ path: string; type: string }[]>(
        `/api/v4/projects/${this.projectRef()}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=20&page=${page}`,
        { signal: options.signal },
      );
      entries.push(...data);
      if (data.length < 20) break;
    }
    return entries;
  }

  async listCommitDiffs(sha: string): Promise<FileDiff[]> {
    const files: FileDiff[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const data = await this.request<RawDiff[]>(
        `/api/v4/projects/${this.projectRef()}/repository/commits/${encodeURIComponent(sha)}/diff?per_page=20&page=${page}`,
      );
      files.push(...data.map(normalizeFileDiff));
      if (data.length < 20) break;
    }
    return files;
  }

  /**
   * Get diffs between two refs (branch comparison).
   */
  async listCompareDiffs(fromRef: string, toRef: string): Promise<FileDiff[]> {
    const data = await this.request<{
      diffs: RawDiff[];
      commits: { id: string; short_id: string; title: string }[];
    }>(
      `/api/v4/projects/${this.projectRef()}/repository/compare?from=${encodeURIComponent(fromRef)}&to=${encodeURIComponent(toRef)}`,
    );
    return (data.diffs ?? []).map(normalizeFileDiff);
  }

  /**
   * Get commit metadata.
   */
  async getCommit(sha: string): Promise<{ id: string; short_id: string; title: string; message: string; created_at: string }> {
    return this.request(
      `/api/v4/projects/${this.projectRef()}/repository/commits/${encodeURIComponent(sha)}`,
    );
  }

  async searchCode(query: string, ref: string, signal?: AbortSignal) {
    const data = await this.request<{ filename: string; path: string; ref: string; startline: number; data: string }[]>(
      `/api/v4/projects/${this.projectRef()}/search?scope=blobs&search=${encodeURIComponent(query)}&ref=${encodeURIComponent(ref)}`,
      { signal },
    );
    return data.map((item) => ({
      path: item.path,
      line: item.startline,
      ref: item.ref,
      snippet: item.data,
    }));
  }

  /**
   * 跨项目的最近活动 MR（scope=all）：给「参考 MR」选择器当候选。
   * per_page 上限 20：再大 GitLab 会直接拒绝。
   */
  async listRecentMergeRequests(
    options: { state?: 'opened' | 'all'; limit?: number; signal?: AbortSignal } = {},
  ): Promise<RecentMergeRequest[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 20));
    const data = await this.request<RawMergeRequestSummary[]>(
      `/api/v4/merge_requests?scope=all&state=${options.state ?? 'opened'}&order_by=updated_at&sort=desc&per_page=${limit}`,
      { signal: options.signal },
    );
    const recent: RecentMergeRequest[] = [];
    for (const item of data) {
      if (!item.web_url) continue;
      const parsed = parseGitLabUrl(new URL(item.web_url));
      if (!parsed.projectPath || !parsed.mergeRequestIid) continue;
      recent.push({
        ref: { origin: parsed.origin, projectPath: parsed.projectPath, iid: parsed.mergeRequestIid },
        title: item.title ?? '',
        state: item.state ?? 'opened',
        sourceBranch: item.source_branch ?? '',
        targetBranch: item.target_branch ?? '',
        updatedAt: item.updated_at ?? '',
        webUrl: item.web_url,
      });
    }
    return recent;
  }

  async getGitLog(path: string, ref: string, signal?: AbortSignal) {
    const data = await this.request<{ id: string; short_id: string; title: string; created_at: string; author_name: string }[]>(
      `/api/v4/projects/${this.projectRef()}/repository/commits?ref_name=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=10`,
      { signal },
    );
    return data.map((commit) => ({
      sha: commit.short_id,
      message: commit.title,
      author: commit.author_name,
      date: commit.created_at,
    }));
  }
}

export function mergeRequestRefFromPage(page: PageContext): MergeRequestRef | undefined {
  if (!page.mergeRequestIid || !page.projectPath) return undefined;
  return {
    origin: page.origin,
    projectPath: page.projectPath,
    projectNumericId: page.projectNumericId,
    mergeRequestIid: page.mergeRequestIid,
  };
}

/** 参考 MR 可能在别的项目甚至别的 GitLab 实例上：按链接自己的 origin + 项目路径建适配器。 */
export function projectAdapter(origin: string, projectPath: string, gitlabToken = ''): GitLabAdapter {
  return new GitLabAdapter({ origin, route: 'unknown', projectPath }, gitlabToken);
}
