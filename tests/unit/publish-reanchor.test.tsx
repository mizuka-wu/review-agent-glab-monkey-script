import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { debugBus } from '../../src/core/debug-bus';
import { INLINE_FALLBACK_PREFIX } from '../../src/core/inline-fallback';
import type { PageContext } from '../../src/core/types';

const page: PageContext = {
  origin: 'https://gitlab.test', route: 'diff', projectPath: 'acme/app',
  projectNumericId: 42, mergeRequestIid: 248,
};

const OLD_HEAD = 'head-sha-1';
const NEW_HEAD = 'head-sha-2';

/** 评审时的 diff：apiKey 在新侧第 2 行。 */
const reviewedDiff = {
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  new_file: false, deleted_file: false, renamed_file: false,
  diff: [
    '@@ -1,2 +1,5 @@ export function pay() {',
    ' export function pay() {',
    '+  const apiKey = "sk-live-123";',
    '+  console.log(apiKey);',
    '+  return handle(error as any);',
    ' }',
  ].join('\n'),
};

/** 评审之后有人往 MR 里 push 了一个 commit：上面多插一行，同一处代码落到新侧第 3 行。 */
const pushedDiff = {
  ...reviewedDiff,
  diff: [
    '@@ -1,2 +1,6 @@ export function pay() {',
    ' export function pay() {',
    '+  const traceId = nextTraceId();',
    '+  const apiKey = "sk-live-123";',
    '+  console.log(apiKey);',
    '+  return handle(error as any);',
    ' }',
  ].join('\n'),
};

/** push 把这段代码整个改掉了：重锚只能判为不可发布，走全文降级。 */
const rewrittenDiff = {
  ...reviewedDiff,
  diff: '@@ -40,2 +40,3 @@\n function refund() {\n+  return gateway.refund();\n }',
};

const RULES_ONLY = { reviewMode: 'rules', gitlabToken: '', language: 'zh-CN' };

/**
 * 服务端只认当前 head：position 带旧 head_sha 就 409。
 * push() 用来在评审跑完之后模拟「有人往 MR 推了新 commit」，之后 MR / diffs 接口一律返回新 head 与新 diff。
 */
function stubMr(afterPush: unknown = pushedDiff) {
  const posts: string[] = [];
  const diffGets: string[] = [];
  const state = { head: OLD_HEAD, diff: reviewedDiff as unknown };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/v1/models')) return json({ data: [{ id: 'test-model' }] });
    if (url.includes('/merge_requests/248/diffs')) {
      if (method === 'GET') diffGets.push(url);
      return json([state.diff]);
    }
    if (url.includes('/discussions') && method === 'POST') {
      const body = String(init?.body ?? '');
      posts.push(body);
      const sentHead = new URLSearchParams(body).get('position[head_sha]');
      if (sentHead && sentHead !== state.head) return json({ message: 'position is invalid' }, 409);
      return json({ id: `d${posts.length}`, notes: [{ id: posts.length }] }, 201);
    }
    if (url.includes('/discussions')) return json([]);
    if (url.includes('/merge_requests/248')) {
      return json({
        title: 'Harden checkout payment error handling', state: 'opened',
        source_branch: 'feature/payment', target_branch: 'main', sha: state.head,
        diff_refs: { base_sha: 'base-sha', head_sha: state.head, start_sha: 'start-sha' },
      });
    }
    return json({ message: '404 Not Found' }, 404);
  }));
  return {
    posts,
    diffGets,
    push: () => { state.head = NEW_HEAD; state.diff = afterPush; },
    field: (post: string, key: string) => new URLSearchParams(post).get(`position[${key}]`),
  };
}

function mount() {
  localStorage.setItem('review-agent-settings-v1', JSON.stringify(RULES_ONLY));
  localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
  return render(<App page={page} />);
}

const topBar = () => within(screen.getByRole('toolbar', { name: 'Review 操作' }));
const bottomBar = () => within(screen.getByRole('toolbar', { name: '评审快捷操作' }));
const cards = () => document.querySelectorAll('article[data-finding-source]');

async function runReview() {
  await waitFor(() => expect(topBar().getByRole('button', { name: '开始 Review' })).toBeEnabled());
  fireEvent.click(topBar().getByRole('button', { name: '开始 Review' }));
  await waitFor(() => expect(cards().length).toBe(4));
}

async function publishFirst() {
  fireEvent.click(within(cards()[0]).getByRole('button', { name: /行内评论|全文评论/ }));
  const dialog = await screen.findByRole('dialog', { name: /发布(行内|全文)评论/ });
  fireEvent.click(within(dialog).getByRole('button', { name: /^确认(行内|全文)评论/ }));
}

function spyConsole() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    blocks: () => warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes(INLINE_FALLBACK_PREFIX)),
  };
}

beforeEach(() => {
  localStorage.clear();
  debugBus.clear('all');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('行内位置 409 不再直接降级全文：重拉 diff_refs 重锚后重发', () => {
  it('单条发布：MR 被 push 过也保住行内评论，用户看不到降级提示', async () => {
    const mr = stubMr();
    const console_ = spyConsole();
    mount();
    await runReview();
    mr.push();

    await publishFirst();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/行级 Discussion 已发布/));
    expect(screen.getByRole('status').textContent).not.toContain('降级');
    expect(document.body.textContent).not.toContain('行内失败');
    // 重锚后重发的那一次：新 head_sha + 按内容重算出的新行号（2 → 3）
    expect(mr.posts).toHaveLength(1);
    expect(mr.field(mr.posts[0], 'head_sha')).toBe(NEW_HEAD);
    expect(mr.field(mr.posts[0], 'new_line')).toBe('3');
    expect(mr.posts[0]).toContain('position%5B');
    // 静默成功：不打降级日志，只留计数
    expect(console_.blocks()).toHaveLength(0);
    expect(debugBus.getCounters()['publish-inline-reanchored']).toBe(1);
    expect(debugBus.getCounters()['publish-409-refresh']).toBe(1);
    expect(debugBus.getCounters()['publish-inline-reanchor-failed']).toBeUndefined();
  });

  it('批量发布：第一条 409 刷新出的 diff_refs 被后续评论直接复用，不各自撞一次 409', async () => {
    const mr = stubMr();
    mount();
    await runReview();
    const diffsBeforePublish = mr.diffGets.length;
    mr.push();

    fireEvent.click(bottomBar().getByRole('button', { name: /一键(行内评论|全文评论|发布)/ }));
    fireEvent.click(bottomBar().getByRole('button', { name: '确认发布？' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/已发布 4 条行内评论/));
    expect(screen.getByRole('status').textContent).not.toContain('降级');
    expect(mr.posts).toHaveLength(4);
    expect(mr.posts.every((post) => mr.field(post, 'head_sha') === NEW_HEAD)).toBe(true);
    // 四条 Finding 原来在 2/4/2/3 行，push 之后整体下移一行
    expect(mr.posts.map((post) => mr.field(post, 'new_line')).sort()).toEqual(['3', '3', '4', '5']);
    // 整批只重新拉了一次 diff：第一条 409 之后剩下的评论直接用新 refs 重锚
    expect(mr.diffGets.length - diffsBeforePublish).toBe(1);
    expect(debugBus.getCounters()['publish-409-refresh']).toBe(1);
    // 只有第一条撞了 409 需要重锚，剩下三条直接用共享的新 refs 一次发出去
    expect(debugBus.getCounters()['publish-inline-reanchored']).toBe(1);
    expect(debugBus.getCounters()['publish-inline-reanchor-failed']).toBeUndefined();
  });

  it('push 把代码整个改掉：重锚救不回来才降级全文，文案说明「MR 已更新，已尝试重锚」', async () => {
    const mr = stubMr(rewrittenDiff);
    const console_ = spyConsole();
    mount();
    await runReview();
    mr.push();

    await publishFirst();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/已降级全文评论/));
    expect(screen.getByRole('status').textContent).toContain('MR 已更新，已尝试重锚');
    expect(screen.getByRole('status').textContent).toContain('重新锚定失败：无匹配');
    // 行内没发出去（预检就 409 了），只有全文那一次
    expect(mr.posts).toHaveLength(1);
    expect(mr.posts[0]).not.toContain('position');
    expect(debugBus.getCounters()['publish-inline-reanchored']).toBeUndefined();
    expect(debugBus.getCounters()['publish-inline-reanchor-failed']).toBe(1);

    // 降级日志记下「重锚后仍失败」与两次参数
    const blocks = console_.blocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('reanchored=true');
    expect(blocks[0]).toContain('reanchor: 409 重锚后仍失败');
    expect(blocks[0]).toContain(`first-position=position[position_type]=text · position[base_sha]=base-sha · position[head_sha]=${OLD_HEAD}`);
    expect(blocks[0]).toContain('retry-position=未重锚出位置，第二次没发出');
  });

  it('批量发布时 push 把代码整个改掉：整批降级全文，每条原因都写清「MR 已更新，已尝试重锚」', async () => {
    const mr = stubMr(rewrittenDiff);
    mount();
    await runReview();
    mr.push();

    fireEvent.click(bottomBar().getByRole('button', { name: /一键(行内评论|全文评论|发布)/ }));
    fireEvent.click(bottomBar().getByRole('button', { name: '确认发布？' }));

    await waitFor(() => expect(screen.getByRole('status'))
      .toHaveTextContent(/4 条行内失败已降级全文：MR 已更新，已尝试重锚/));
    // 四条都是全文：第一条撞 409 后重锚失败，剩下三条用刷新后的 diff 直接判定挂不上行
    expect(mr.posts).toHaveLength(4);
    expect(mr.posts.every((post) => !post.includes('position'))).toBe(true);
    expect(debugBus.getCounters()['publish-409-refresh']).toBe(1);
    expect(debugBus.getCounters()['publish-inline-reanchor-failed']).toBe(1);
    expect(debugBus.getCounters()['publish-inline-reanchored']).toBeUndefined();
    // 卡片上留了原因，toast 消失以后用户仍看得出这批为什么是全文
    await waitFor(() => expect(cards()[0].textContent).toContain('行内失败：MR 已更新，已尝试重锚'));
  });

  it('MR 没被 push 时一切照旧：行内一次发出去，不重新拉 diff', async () => {
    const mr = stubMr();
    mount();
    await runReview();
    const diffsBeforePublish = mr.diffGets.length;

    await publishFirst();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/行级 Discussion 已发布/));
    expect(mr.posts).toHaveLength(1);
    expect(mr.field(mr.posts[0], 'head_sha')).toBe(OLD_HEAD);
    expect(mr.field(mr.posts[0], 'new_line')).toBe('2');
    expect(mr.diffGets.length).toBe(diffsBeforePublish);
    expect(debugBus.getCounters()['publish-409-refresh']).toBeUndefined();
    expect(debugBus.getCounters()['publish-inline-reanchored']).toBeUndefined();
  });
});
