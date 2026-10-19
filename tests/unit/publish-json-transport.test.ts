import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDiscussionPayload, GitLabAdapter } from '../../src/core/gitlab-adapter';
import type { DiscussionDraft, MergeRequestRef, PageContext } from '../../src/core/types';

/**
 * 用户报的 400 `position 必须是有效的 json schema` 出在真实链路：油猴里请求走 GM.xmlHttpRequest，
 * body 是 form 编码的平铺 position[...] 字段，老 GitLab 解析不出合法的嵌套结构。
 * 这里不注入 fetcher，直接量生产那条传输链：GM 与页面 fetch 两种环境拿到的都必须是
 * 「Content-Type: application/json + 一整条 JSON 字符串」，不能出现 form 编码残留。
 */

const page: PageContext = { origin: 'https://gitlab.test', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 };
const ref: MergeRequestRef = { origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7 };
const REFS = { baseSha: 'base', headSha: 'head', startSha: 'start' };

const singleLine: DiscussionDraft = {
  body: 'inline single',
  position: {
    path: 'src/a.ts', startLine: 12, endLine: 12, side: 'new',
    start: { oldLine: 11, newLine: 12 }, end: { oldLine: 11, newLine: 12 }, diffRefs: REFS,
  },
};
const multiLine: DiscussionDraft = {
  body: 'inline multi',
  position: {
    path: 'src/a.ts', startLine: 12, endLine: 14, side: 'new',
    start: { newLine: 12 }, end: { oldLine: 13, newLine: 14 }, diffRefs: REFS,
  },
};

type GmInit = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  onload: (response: { status: number; responseText: string }) => void;
  onerror: (error: unknown) => void;
};

/** 按 URL 应答：GET 走 MR 详情 / discussions 列表，POST 一律 201。GM 的响应字段叫 responseText。 */
function respond(url: string, method: string) {
  if (method === 'POST') {
    return { status: 201, responseText: url.endsWith('/notes') ? '{"id":99}' : '{"id":"d1","notes":[{"id":11}]}' };
  }
  if (url.includes('/merge_requests/7') && !url.includes('/discussions')) {
    return {
      status: 200,
      responseText: JSON.stringify({ diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' } }),
    };
  }
  return { status: 200, responseText: '[]' };
}

function stubGm() {
  const details: GmInit[] = [];
  (globalThis as { GM?: unknown }).GM = {
    xmlHttpRequest: (init: GmInit) => {
      details.push(init);
      init.onload(respond(init.url, init.method));
      return { abort: () => undefined };
    },
  };
  return details;
}

function stubFetch() {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    const response = respond(url, method);
    return new Response(response.responseText, { status: response.status });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { GM?: unknown }).GM;
});

describe('发布链路 · GM.xmlHttpRequest 环境', () => {
  it('行内单行：data 是一整条 JSON 字符串，Content-Type 与 body 类型一致', async () => {
    const details = stubGm();
    const adapter = new GitLabAdapter(page, 'glpat-test');

    const published = await adapter.createDiscussion(ref, singleLine);

    expect(published).toEqual({ id: 'd1', noteId: '11' });
    const post = details.find((entry) => entry.method === 'POST')!;
    expect(post.url).toBe('https://gitlab.test/api/v4/projects/group%2Fproject/merge_requests/7/discussions');
    expect(typeof post.data).toBe('string');
    expect(post.headers!['Content-Type']).toBe('application/json');
    expect(post.data).toBe(buildDiscussionPayload(singleLine));
    // form 平铺键一个都不许剩：老 GitLab 就是被 position[line_range][...] 这种字段解析成畸形结构的
    expect(post.data).not.toContain('position%5B');
    expect(post.data).not.toContain('position[');
    expect(JSON.parse(post.data!)).toEqual(JSON.parse(buildDiscussionPayload(singleLine)) as unknown);
  });

  it('行内多行：嵌套 line_range 原样进 JSON，行号是整数不是字符串', async () => {
    const details = stubGm();
    const adapter = new GitLabAdapter(page, 'glpat-test');

    await adapter.createDiscussion(ref, multiLine);

    const post = details.find((entry) => entry.method === 'POST')!;
    const body = JSON.parse(post.data!) as { body: string; position: Record<string, unknown> };
    const range = body.position.line_range as { start: Record<string, unknown>; end: Record<string, unknown> };
    expect(body.body).toBe('inline multi');
    expect(body.position).toMatchObject({ position_type: 'text', head_sha: 'head', new_line: 14, old_line: 13 });
    expect(range.start).toMatchObject({ type: 'new', new_line: 12 });
    expect(range.end).toMatchObject({ type: 'old', old_line: 13, new_line: 14 });
    expect(typeof range.end.new_line).toBe('number');
    expect('old_line' in range.start).toBe(false);
  });

  it('MR 总评论（notes 端点）同样是 JSON，接口照样 201', async () => {
    const details = stubGm();
    const adapter = new GitLabAdapter(page, 'glpat-test');

    await expect(adapter.createNote(ref, 'MR 总评论')).resolves.toEqual({ id: 99 });

    const post = details.find((entry) => entry.method === 'POST')!;
    expect(post.url).toBe('https://gitlab.test/api/v4/projects/group%2Fproject/merge_requests/7/notes');
    expect(post.headers!['Content-Type']).toBe('application/json');
    expect(post.data).toBe('{"body":"MR 总评论"}');
  });
});

describe('发布链路 · 页面 fetch 环境（无 GM）', () => {
  it('body 是字符串、Content-Type 是 application/json，credentials 仍走 same-origin', async () => {
    const calls = stubFetch();
    const adapter = new GitLabAdapter(page, '');

    await adapter.createDiscussion(ref, singleLine);

    const post = calls.find((call) => call.method === 'POST')!;
    expect(typeof post.body).toBe('string');
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(post.body).toBe(buildDiscussionPayload(singleLine));
  });

  it('全文评论的 body 只有 body 一个键，position 整个不出现', async () => {
    const calls = stubFetch();
    const adapter = new GitLabAdapter(page, '');

    await adapter.createDiscussion(ref, { body: 'MR 级全文评论' });

    const post = calls.find((call) => call.method === 'POST')!;
    expect(JSON.parse(String(post.body))).toEqual({ body: 'MR 级全文评论' });
  });
});
