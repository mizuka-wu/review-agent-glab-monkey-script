import { normalizeFileDiff } from './diff';
import { buildFullTextComment } from './findings';
import { parseGitLabUrl, projectApiIdentifier } from './gitlab-url';
import { debugBus } from './debug-bus';
import { httpRequest } from './http';
import type {
  AdapterCapabilities,
  DiffRefs,
  DiscussionDraft,
  DiscussionPosition,
  FileDiff,
  Finding,
  MergeRequestContext,
  MergeRequestRef,
  PageContext,
  PositionLineRef,
  RecentMergeRequest,
  PublishedComment,
  PublishedDiscussion,
} from './types';

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
  body?: string | URLSearchParams;
  signal?: AbortSignal;
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

interface RawMergeRequestSummary {
  iid: number;
  title?: string;
  state?: string;
  source_branch?: string;
  target_branch?: string;
  updated_at?: string;
  web_url?: string;
}

/** 空值字段一律不发：GitLab 收到 position[base_sha]= 会把整个 diff_refs 判为不完整。 */
function setPositionField(payload: URLSearchParams, key: string, value: string) {
  if (value) payload.set(key, value);
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
 */
function setPositionLine(payload: URLSearchParams, prefix: string, line: PositionLineRef) {
  if (line.oldLine !== undefined) payload.set(`${prefix}[old_line]`, String(line.oldLine));
  if (line.newLine !== undefined) payload.set(`${prefix}[new_line]`, String(line.newLine));
}

/** 没有 diff 行配对时的兜底：按 side 填一侧，至少 added / removed 行还能发出去。 */
function sideLineRef(side: 'old' | 'new', line: number): PositionLineRef {
  return side === 'new' ? { newLine: line } : { oldLine: line };
}

/**
 * 无 position 时只带 body，GitLab 会创建 MR 级全文评论。
 * position[line_range] 会被 GitLab 原样存下并按 json schema 校验（additionalProperties: false），
 * 多一个键就是 `position must be a valid json schema`，所以只发 schema 里存在的键。
 */
export function buildDiscussionPayload(input: DiscussionDraft) {
  const payload = new URLSearchParams();
  payload.set('body', input.body);
  const position = input.position;
  if (!position) return payload;

  payload.set('position[position_type]', 'text');
  setPositionField(payload, 'position[base_sha]', position.diffRefs.baseSha);
  setPositionField(payload, 'position[head_sha]', position.diffRefs.headSha);
  setPositionField(payload, 'position[start_sha]', position.diffRefs.startSha);
  setPositionField(payload, 'position[new_path]', setPositionPath(position.newPath, position.oldPath, position.path));
  setPositionField(payload, 'position[old_path]', setPositionPath(position.oldPath, position.newPath, position.path));

  // 顶层 old_line / new_line 描述的是评论结束行，必须和该行在 diff 里的配对完全一致。
  const end = position.end ?? sideLineRef(position.side, position.endLine);
  setPositionLine(payload, 'position', end);
  if (position.startLine === position.endLine) return payload;

  setPositionLine(payload, 'position[line_range][start]', position.start ?? sideLineRef(position.side, position.startLine));
  setPositionLine(payload, 'position[line_range][end]', end);
  return payload;
}

/** GitLab 判 position 非法的状态码：行号不在 diff 内、路径不在 MR 里、diff_refs 过期。 */
const POSITION_REJECTED = new Set([400, 409, 422]);

function isPositionRejection(error: unknown): error is GitLabApiError {
  return error instanceof GitLabApiError && POSITION_REJECTED.has(error.status);
}

export class GitLabAdapter {
  constructor(
    private readonly page: PageContext,
    private readonly gitlabToken = '',
    private readonly fetcher: FetchLike = defaultFetcher,
  ) {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };
    if (this.gitlabToken) headers['PRIVATE-TOKEN'] = this.gitlabToken;
    if (options.method === 'POST') {
      headers['X-CSRF-Token'] = csrfToken();
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
    }

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
      debugBus.log('error', 'gitlab', `${options.method ?? 'GET'} ${path} 连接失败`, String(error));
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

    const payload = (await response.json()) as T;
    debugBus.network({
      kind: 'gitlab', method: options.method ?? 'GET', url: path, status: response.status,
      ms: Date.now() - startedAt, bytes: JSON.stringify(payload).length,
    });
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
      state: String(data.state ?? 'opened'),
      sourceBranch: String(data.source_branch ?? ''),
      targetBranch: String(data.target_branch ?? ''),
      sha: String(data.sha ?? diffRefs.headSha),
      diffRefs,
    };
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
   */
  async publishComment(
    ref: MergeRequestRef,
    finding: Finding,
    body: string,
    position?: DiscussionPosition,
  ): Promise<PublishedComment> {
    if (position) {
      try {
        return { ...(await this.createDiscussion(ref, { body, position })), mode: 'inline' };
      } catch (error) {
        if (!isPositionRejection(error)) throw error;
        debugBus.log('warn', 'publish', `行内位置被 GitLab 拒绝（HTTP ${error.status}），改为全文评论 ${finding.path}:${finding.line}`, error.message);
      }
    }
    const discussion = await this.createDiscussion(ref, { body: buildFullTextComment(finding, body) });
    return { ...discussion, mode: 'full' };
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
    const payload = new URLSearchParams();
    payload.set('body', body);
    return this.request<{ id: number }>(
      `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/notes`,
      { method: 'POST', body: payload },
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
