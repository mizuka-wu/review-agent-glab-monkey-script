import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debugBus } from '../../src/core/debug-bus';
import { buildDiscussionPayload, GitLabApiError, GitLabAdapter } from '../../src/core/gitlab-adapter';
import {
  buildCurlReplay,
  CURL_TOKEN_PLACEHOLDER,
  formatPublishRequest,
  formatRequestHeaders,
  isPublishRequest,
  logPublishRequest,
  payloadKind,
  PUBLISH_REQUEST_PREFIX,
  redactHeaderValue,
  shellQuote,
  type PublishRequestScene,
} from '../../src/core/publish-request-log';
import type { DiscussionDraft, MergeRequestRef, PageContext } from '../../src/core/types';

/**
 * 用户老实例上 0.4.24（JSON 直发）发布行内评论仍然 400，脚本侧参数已经推断过两轮都没命中，
 * 只剩「真实发出的那一条请求」这一个证据来源。这里钉死：发布链路每一次写请求都留下
 * 完整现场（method + 全 URL + headers + body 原文 + 响应 + 可直接粘贴的 curl），
 * 失败必打、成功也打，且 PAT 在任何一行里都不出现。
 */

const page: PageContext = { origin: 'https://gitlab.old', projectPath: 'group/project', route: 'diff', mergeRequestIid: 7 };
const ref: MergeRequestRef = { origin: 'https://gitlab.old', projectPath: 'group/project', mergeRequestIid: 7 };
const REFS = { baseSha: 'base-sha', headSha: 'head-sha', startSha: 'start-sha' };
/** 假 PAT：断言它一个字都不许出现在日志里。 */
const TOKEN = 'glpat-' + 'x'.repeat(20);

const draft: DiscussionDraft = {
  body: "硬编码密钥  需要挪进配置\n第二行",
  position: {
    path: 'src/payment.ts', startLine: 12, endLine: 14, side: 'new',
    start: { newLine: 12 }, end: { oldLine: 13, newLine: 14 }, diffRefs: REFS,
  },
};
const BODY = buildDiscussionPayload(draft);
const URL = 'https://gitlab.old/api/v4/projects/group%2Fproject/merge_requests/7/discussions';
const REJECTION = '{"message":"400 Bad request - Note {:position=>[\\"必须是有效的 json schema\\"]}"}';

const scene = (input: Partial<PublishRequestScene> = {}): PublishRequestScene => ({
  method: 'POST',
  url: URL,
  headers: {
    Accept: 'application/json', 'Content-Type': 'application/json',
    'PRIVATE-TOKEN': TOKEN, 'X-CSRF-Token': '',
  },
  body: BODY,
  ok: false,
  ms: 42,
  ...input,
});

/** 按 URL 应答：GET 走 MR 详情 / discussions 列表，POST 用 postStatus / postBody。 */
function stubFetcher(postStatus: number, postBody: string) {
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (method === 'POST') {
      posts.push({ url, headers, body: String(init?.body ?? '') });
      return new Response(postBody, { status: postStatus });
    }
    if (url.includes('/merge_requests/7') && !url.includes('/discussions')) {
      return new Response(JSON.stringify({ diff_refs: { base_sha: REFS.baseSha, head_sha: REFS.headSha, start_sha: REFS.startSha } }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  });
  return { fetcher, posts };
}

/** console 上的请求现场：logToConsole 直接打，spy 收得到整段文本。 */
function spyConsole() {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const blocks = () => [...error.mock.calls, ...info.mock.calls]
    .map((call) => String(call[0]))
    .filter((text) => text.includes(PUBLISH_REQUEST_PREFIX));
  return { error, info, blocks };
}

function loggedScenes() {
  return debugBus.getLogs().filter((entry) => entry.message.startsWith(PUBLISH_REQUEST_PREFIX));
}

function sceneText(entry: { message: string; detail?: string }) {
  return `${entry.message}\n${entry.detail ?? ''}`;
}

beforeEach(() => {
  debugBus.clear('all');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('[inline-request] 现场格式化', () => {
  it('失败现场：method + 全 URL + status + body 原文 + 响应原文，每行都带前缀', () => {
    const lines = formatPublishRequest(scene({ status: 400, responseText: REJECTION }));

    expect(lines.every((line) => line.startsWith(PUBLISH_REQUEST_PREFIX))).toBe(true);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain(`POST ${URL}`);
    expect(lines[0]).toContain('HTTP 400（失败）');
    expect(lines[0]).toContain('payload=inline');
    // headers：Content-Type / Accept 必打，令牌脱敏
    expect(lines[1]).toContain('Content-Type=application/json');
    expect(lines[1]).toContain('Accept=application/json');
    expect(lines[1]).toContain(`PRIVATE-TOKEN=${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}（${TOKEN.length} 字符）`);
    expect(lines[1]).toContain('X-CSRF-Token=（空）');
    // body 原文：一个字符都不许改，position / line_range / sha 全靠它
    expect(lines[2]).toBe(`${PUBLISH_REQUEST_PREFIX} body(${BODY.length} 字符): ${BODY}`);
    expect(lines[2]).toContain('"position_type":"text"');
    expect(lines[2]).toContain('"line_range"');
    expect(lines[2]).toContain('"head_sha":"head-sha"');
    expect(lines[2]).toContain('硬编码密钥  需要挪进');
    expect(lines[3]).toContain('HTTP 400');
    expect(lines[3]).toContain('必须是有效的 json schema');
  });

  it('成功现场：只打 status，不打响应 body', () => {
    const lines = formatPublishRequest(scene({ ok: true, status: 201, responseText: undefined }));

    expect(lines[0]).toContain('HTTP 201（成功）');
    expect(lines[3]).toBe(`${PUBLISH_REQUEST_PREFIX} response: HTTP 201`);
    expect(lines[2]).toContain(BODY);
  });

  it('传输层失败（连不上）：没有 status 也要留下现场', () => {
    const lines = formatPublishRequest(scene({ ok: false, status: undefined, error: 'TypeError: NetworkError' }));

    expect(lines[0]).toContain('传输失败（失败）');
    expect(lines[3]).toContain('未收到响应');
    expect(lines[3]).toContain('NetworkError');
  });

  it('响应 body 过长时截断并标注，超长 HTML 不冲爆 localStorage', () => {
    const html = `<html>${'x'.repeat(9000)}</html>`;
    const lines = formatPublishRequest(scene({ status: 502, responseText: html }));

    expect(lines[3]).toContain('HTTP 502');
    expect(lines[3]).toContain(`…（截断 ${html.length - 4000} 字符）`);
    expect(lines[3].length).toBeLessThan(4200);
  });

  it('payload 形态：有 position 是 inline，只有 body 是 full，form 串是 raw', () => {
    expect(payloadKind(BODY)).toBe('inline');
    expect(payloadKind('{"body":"全文评论"}')).toBe('full');
    expect(payloadKind(undefined)).toBe('empty');
    expect(payloadKind('body=a%20b&position%5Bx%5D=1')).toBe('raw');
  });

  it('只打发布链路的写请求：GET / approve / diffs 一个都不打', () => {
    const discussions = '/api/v4/projects/g%2Fp/merge_requests/7/discussions';
    expect(isPublishRequest('POST', discussions)).toBe(true);
    expect(isPublishRequest('POST', '/api/v4/projects/g%2Fp/merge_requests/7/notes')).toBe(true);
    expect(isPublishRequest('POST', `${discussions}/abc123/notes`)).toBe(true);
    expect(isPublishRequest('POST', `${discussions}?per_page=20`)).toBe(true);
    expect(isPublishRequest('GET', discussions)).toBe(false);
    expect(isPublishRequest('POST', '/api/v4/projects/g%2Fp/merge_requests/7/approve')).toBe(false);
    expect(isPublishRequest('POST', '/api/v4/projects/g%2Fp/merge_requests/7/diffs')).toBe(false);
  });
});

describe('[inline-request] 脱敏', () => {
  it('PRIVATE-TOKEN 只露首尾 4 位与长度，原值不出现；短令牌整个抹掉', () => {
    expect(redactHeaderValue('PRIVATE-TOKEN', TOKEN)).toBe(`${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}（${TOKEN.length} 字符）`);
    expect(redactHeaderValue('private-token', 'abc123')).toBe('[REDACTED]');
    expect(redactHeaderValue('X-CSRF-Token', 'csrf-value-123456')).toBe('[REDACTED 17 字符]');
    expect(redactHeaderValue('Authorization', `Bearer ${TOKEN}`)).toBe(`[REDACTED ${'Bearer '.length + TOKEN.length} 字符]`);
    expect(redactHeaderValue('Content-Type', 'application/json')).toBe('application/json');
  });

  it('整段现场（含 curl）里找不到 PAT，也找不到 CSRF 值', () => {
    const text = formatPublishRequest(scene({
      status: 400,
      responseText: REJECTION,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'PRIVATE-TOKEN': TOKEN, 'X-CSRF-Token': 'csrf-secret-value-999' },
    })).join('\n');

    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('SuperSecret');
    expect(text).not.toContain('csrf-secret-value-999');
    expect(text).toContain(`${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}（${TOKEN.length} 字符）`);
    expect(text).toContain(CURL_TOKEN_PLACEHOLDER);
  });

  it('body 里混进令牌样式的内容也被 sanitizeLog 兜住', () => {
    const lines = formatPublishRequest(scene({
      body: JSON.stringify({ body: 'apiKey = ' + 'glpat-' + 'x'.repeat(24), position: { position_type: 'text' } }),
      status: 400,
    }));

    expect(lines[2]).not.toContain('glpat-' + 'x'.repeat(24));
    expect(lines[2]).toContain('[REDACTED]');
  });

  it('headers 行原样保留非敏感值，敏感值只留长度', () => {
    const line = formatRequestHeaders({ 'Content-Type': 'application/json', 'PRIVATE-TOKEN': TOKEN });
    expect(line).toBe(`Content-Type=application/json · PRIVATE-TOKEN=${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}（${TOKEN.length} 字符）`);
    expect(formatRequestHeaders({})).toBe('（无）');
  });
});

describe('[inline-request] curl 重放命令', () => {
  it('单行、带 URL / Content-Type / Accept / <PAT> 占位 / --data 原文', () => {
    const curl = buildCurlReplay(scene({ status: 400 }));

    expect(curl).not.toContain('\n');
    expect(curl.startsWith(`curl -sS -X POST '${URL}'`)).toBe(true);
    expect(curl).toContain(`-H 'Content-Type: application/json'`);
    expect(curl).toContain(`-H 'Accept: application/json'`);
    expect(curl).toContain(`-H 'PRIVATE-TOKEN: ${CURL_TOKEN_PLACEHOLDER}'`);
    expect(curl.endsWith(`--data '${BODY}'`)).toBe(true);
    expect(curl).not.toContain(TOKEN);
  });

  it("body 里的单引号按 '\\'' 转义，整条命令可以直接粘贴执行", () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shellQuote("it's a 'test'")).toBe(`'it'\\''s a '\\''test'\\'''`);

    const body = JSON.stringify({ body: "Note {:line_code=>[\"can't be blank\"]}", position: { position_type: 'text' } });
    const curl = buildCurlReplay(scene({ body }));
    expect(curl).toContain(`--data '${body.replace(/'/g, `'\\''`)}'`);
    expect(curl).toContain(`can'\\''t be blank`);
  });

  it('没带 PRIVATE-TOKEN 的请求（Cookie 认证）在命令后面附一句提示', () => {
    const curl = buildCurlReplay(scene({ headers: { 'Content-Type': 'application/json' } }));
    expect(curl).toContain('# 实际请求没带 PRIVATE-TOKEN');
  });

  it('无 body 的 POST 不带 --data', () => {
    expect(buildCurlReplay(scene({ body: undefined }))).not.toContain('--data');
  });
});

describe('[inline-request] 落盘：console + 面板 + 导出包', () => {
  it('失败打 error 级，成功打 debug 级，两处内容一致', () => {
    const console_ = spyConsole();

    logPublishRequest(scene({ status: 400, responseText: REJECTION }));
    logPublishRequest(scene({ ok: true, status: 201 }));

    const entries = loggedScenes();
    expect(entries.map((entry) => entry.level)).toEqual(['error', 'debug']);
    expect(entries.every((entry) => entry.source === 'publish')).toBe(true);
    expect(sceneText(entries[0])).toContain(BODY);
    expect(sceneText(entries[0])).toContain('HTTP 400');

    const blocks = console_.blocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain(BODY);
    expect(blocks[0]).toContain('curl');
    expect(blocks[0]).not.toContain(TOKEN);
    expect(blocks[0].split('\n').every((line) => line.startsWith(PUBLISH_REQUEST_PREFIX))).toBe(true);
    expect(console_.error).toHaveBeenCalledTimes(1);
    expect(console_.info).toHaveBeenCalledTimes(1);

    expect(debugBus.exportBundle()).toContain('inline-request');
  });
});

describe('[inline-request] 真实传输链（GitLabAdapter#request）', () => {
  it('行内发布 400：现场里的 body 与实际发出的字节完全一致，status 与响应原文都在', async () => {
    const { fetcher, posts } = stubFetcher(400, REJECTION);
    const adapter = new GitLabAdapter(page, TOKEN, fetcher);

    await expect(adapter.createDiscussion(ref, draft)).rejects.toBeInstanceOf(GitLabApiError);

    expect(posts).toHaveLength(1);
    const entries = loggedScenes();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('error');
    const text = sceneText(entries[0]);
    expect(text).toContain(`POST ${URL}`);
    expect(text).toContain(`${PUBLISH_REQUEST_PREFIX} body(${posts[0].body.length} 字符): ${posts[0].body}`);
    expect(text).toContain('HTTP 400');
    expect(text).toContain('必须是有效的 json schema');
    expect(text).toContain(`--data '${posts[0].body.replace(/'/g, `'\\''`)}'`);
    expect(text).not.toContain(TOKEN);
    // 只打 POST：前置的 MR 详情 / discussions 列表不留现场
    expect(debugBus.getLogs().filter((entry) => entry.message.startsWith(PUBLISH_REQUEST_PREFIX))).toHaveLength(1);
  });

  it('行内发布 201：也打一条 debug 级现场，响应 body 不外泄', async () => {
    const { fetcher } = stubFetcher(201, '{"id":"d1","notes":[{"id":11}]}');
    const adapter = new GitLabAdapter(page, TOKEN, fetcher);

    await expect(adapter.createDiscussion(ref, draft)).resolves.toEqual({ id: 'd1', noteId: '11' });

    const entries = loggedScenes();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('debug');
    const text = sceneText(entries[0]);
    expect(text).toContain('HTTP 201（成功）');
    expect(text).toContain(BODY);
    expect(text).not.toContain('"noteId"');
  });

  it('MR 总评论（notes 端点）同样留现场，payload=full', async () => {
    const { fetcher } = stubFetcher(201, '{"id":99}');
    const adapter = new GitLabAdapter(page, TOKEN, fetcher);

    await adapter.createNote(ref, 'MR 总评论');

    const text = sceneText(loggedScenes()[0]);
    expect(text).toContain('/merge_requests/7/notes');
    expect(text).toContain('payload=full');
    expect(text).toContain('{"body":"MR 总评论"}');
  });

  it('行内被拒后降级全文：两条 POST 各留一份现场，先 inline 后 full', async () => {
    let posted = 0;
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        posted += 1;
        const isInline = (JSON.parse(String(init?.body ?? '{}')) as { position?: unknown }).position !== undefined;
        return isInline
          ? new Response(REJECTION, { status: 400 })
          : new Response('{"id":"d2","notes":[{"id":22}]}', { status: 201 });
      }
      if (url.includes('/merge_requests/7') && !url.includes('/discussions')) {
        return new Response(JSON.stringify({ diff_refs: { base_sha: REFS.baseSha, head_sha: REFS.headSha, start_sha: REFS.startSha } }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    const adapter = new GitLabAdapter(page, TOKEN, fetcher);
    const finding = {
      id: 'f1', fingerprint: 'fp', path: 'src/payment.ts', line: 12, endLine: 14, side: 'new',
      category: 'bug', severity: 'medium', confidence: 'high', title: 'T', content: 'C',
      evidence: [], existingCode: '', suggestionCode: '', comment: '硬编码密钥', source: 'model', status: 'draft',
    } as never;

    const published = await adapter.publishComment(ref, finding, '硬编码密钥', draft.position);

    expect(posted).toBe(2);
    expect(published.mode).toBe('full');
    const texts = loggedScenes().map(sceneText);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('payload=inline');
    expect(texts[0]).toContain('HTTP 400');
    expect(texts[1]).toContain('payload=full');
    expect(texts[1]).toContain('HTTP 201（成功）');
  });

  it('连不上 GitLab：传输失败也留现场（用户老实例挂代理时就是这个形态）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('NetworkError when attempting to fetch resource'); });
    const adapter = new GitLabAdapter(page, TOKEN, fetcher);

    await expect(adapter.createNote(ref, 'x')).rejects.toThrow();

    const text = sceneText(loggedScenes()[0]);
    expect(text).toContain('传输失败');
    expect(text).toContain('未收到响应');
    expect(text).toContain('NetworkError');
    expect(text).toContain('{"body":"x"}');
  });

  it('GET 类请求（diffs / discussions 列表 / MR 详情）一条现场都不打', async () => {
    const { fetcher } = stubFetcher(201, '{"id":"d1"}');
    const adapter = new GitLabAdapter(page, TOKEN, fetcher);

    await adapter.getMergeRequest(ref);
    await adapter.listDiscussions(ref);

    expect(loggedScenes()).toHaveLength(0);
  });
});
