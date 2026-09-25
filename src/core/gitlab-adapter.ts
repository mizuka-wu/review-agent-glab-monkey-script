import { normalizeFileDiff } from './diff';
import { projectApiIdentifier } from './gitlab-url';
import type {
  AdapterCapabilities,
  DiffRefs,
  DiscussionDraft,
  FileDiff,
  MergeRequestContext,
  MergeRequestRef,
  PageContext,
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

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

export function buildDiscussionPayload(input: DiscussionDraft) {
  const payload = new URLSearchParams();
  payload.set('body', input.body);
  payload.set('position[position_type]', 'text');
  payload.set('position[base_sha]', input.diffRefs.baseSha);
  payload.set('position[head_sha]', input.diffRefs.headSha);
  payload.set('position[start_sha]', input.diffRefs.startSha);
  payload.set('position[new_path]', input.path);
  payload.set('position[old_path]', input.path);

  if (input.side === 'new') {
    payload.set('position[new_line]', String(input.endLine));
  } else {
    payload.set('position[old_line]', String(input.endLine));
  }

  return payload;
}

export class GitLabAdapter {
  constructor(
    private readonly page: PageContext,
    private readonly gitlabToken = '',
    private readonly fetcher: FetchLike = fetch.bind(globalThis),
  ) {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };
    if (this.gitlabToken) headers['PRIVATE-TOKEN'] = this.gitlabToken;
    if (options.method === 'POST') {
      headers['X-CSRF-Token'] = csrfToken();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

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
      throw new GitLabApiError(0, `无法连接 GitLab API：${String(error)}`, 'network_error');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new GitLabApiError(
        response.status,
        `GitLab API ${response.status}：${detail.slice(0, 300)}`,
        errorCode(response.status),
      );
    }

    return (await response.json()) as T;
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

  async listDiffs(ref: MergeRequestRef): Promise<FileDiff[]> {
    const data = await this.request<unknown[]>(
      `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/diffs?per_page=100`,
    );
    return data.map(normalizeFileDiff);
  }

  async createDiscussion(
    ref: MergeRequestRef,
    draft: DiscussionDraft,
  ): Promise<PublishedDiscussion> {
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

  async listDiscussions(ref: MergeRequestRef) {
    return this.request<{ id: string; notes?: { id: number; body: string }[] }[]>(
      `/api/v4/projects/${this.projectRef()}/merge_requests/${ref.mergeRequestIid}/discussions?per_page=100`,
    );
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
