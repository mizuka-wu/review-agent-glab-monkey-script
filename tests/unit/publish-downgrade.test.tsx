import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { debugBus } from '../../src/core/debug-bus';
import type { PageContext } from '../../src/core/types';

const page: PageContext = {
  origin: 'https://gitlab.test', route: 'diff', projectPath: 'acme/app',
  projectNumericId: 42, mergeRequestIid: 248,
};

const mergeRequest = {
  title: 'Harden checkout payment error handling',
  state: 'opened', source_branch: 'feature/payment', target_branch: 'main', sha: 'head-sha',
  diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha', start_sha: 'start-sha' },
};

const diff = {
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  new_file: false, deleted_file: false, renamed_file: false,
  diff: [
    '@@ -1,2 +1,4 @@ export function pay() {',
    ' export function pay() {',
    '+  const apiKey = "sk-live-123";',
    '+  console.log(apiKey);',
    ' }',
  ].join('\n'),
};

const RULES_ONLY = { reviewMode: 'rules', gitlabToken: '', language: 'zh-CN' };

/** GitLab 拒绝 position 的原话：用户看到状态码没意义，UI 要翻成人话并把原文附上。 */
const REJECTION = "Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}";

/** 带 position 的行内请求一律 400，不带 position 的全文重发一律 201。 */
/** 0.4.24 起 discussions 端点发 JSON body：有没有带 position 直接看 body 里的 position 键。 */
const hasPosition = (body: string) => (JSON.parse(body) as { position?: unknown }).position !== undefined;
const positionField = (body: string, key: string) =>
  (JSON.parse(body) as { position?: Record<string, unknown> }).position?.[key];

function stubRejectedPosition() {
  const posts: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/v1/models')) return json({ data: [{ id: 'test-model' }] });
    if (url.includes('/merge_requests/248/diffs')) return json([diff]);
    if (url.includes('/discussions') && method === 'POST') {
      const body = String(init?.body ?? '');
      posts.push(body);
      return hasPosition(body)
        ? json({ message: `400 Bad request - ${REJECTION}` }, 400)
        : json({ id: `d${posts.length}`, notes: [{ id: posts.length }] }, 201);
    }
    if (url.includes('/discussions')) return json([]);
    if (url.includes('/merge_requests/248')) return json(mergeRequest);
    return json({ message: '404 Not Found' }, 404);
  }));
  return posts;
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
  await waitFor(() => expect(cards().length).toBeGreaterThan(0));
}

beforeEach(() => {
  localStorage.clear();
  debugBus.clear('all');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('行内发布被 GitLab 拒了以后不再静默降级', () => {
  it('单条发布：toast 与卡片都写清楚行内失败的原因', async () => {
    const posts = stubRejectedPosition();
    mount();
    await runReview();

    fireEvent.click(within(cards()[0]).getByRole('button', { name: /行内评论|全文评论/ }));
    const dialog = await screen.findByRole('dialog', { name: /发布(行内|全文)评论/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /^确认(行内|全文)评论/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/行内失败：.*已降级全文评论/));
    expect(screen.getByRole('status')).toHaveTextContent('GitLab 拒绝了这个行内位置');
    expect(screen.getByRole('status')).toHaveTextContent("line_code");

    // 行内确实试过、又被拒、再发全文：两次 POST 都不能少
    await waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(2));
    expect(hasPosition(posts[0])).toBe(true);
    expect(hasPosition(posts[1])).toBe(false);

    // 卡片上留痕，toast 消失以后用户仍能看出这条是降级发出去的
    await waitFor(() => expect(cards()[0].textContent).toContain('行内失败：'));
    expect(cards()[0].textContent).toContain('已降级全文评论');
    expect(debugBus.getCounters()['publish-inline-rejected:400']).toBeGreaterThan(0);
  });

  it('批量发布：汇总里点名降级条数与原因', async () => {
    stubRejectedPosition();
    mount();
    await runReview();

    fireEvent.click(bottomBar().getByRole('button', { name: /一键(行内评论|全文评论|发布)/ }));
    fireEvent.click(bottomBar().getByRole('button', { name: '确认发布？' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/条行内失败已降级全文/));
    expect(screen.getByRole('status')).toHaveTextContent(/^已发布 3 条全文评论；3 条行内失败已降级全文：GitLab 拒绝了这个行内位置/);
    expect(screen.getByRole('status')).toHaveTextContent("line_code");
  });

  it('降级原因按状态码计数，调试面板的快照里能看出主要失败形态', async () => {
    stubRejectedPosition();
    mount();
    await runReview();

    fireEvent.click(bottomBar().getByRole('button', { name: /一键(行内评论|全文评论|发布)/ }));
    fireEvent.click(bottomBar().getByRole('button', { name: '确认发布？' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/条行内失败已降级全文/));

    expect(debugBus.getCounters()['publish-inline-rejected:400']).toBe(3);
    expect(debugBus.getLogs().some((entry) => entry.source === 'publish' && /行内位置被 GitLab 拒绝/.test(entry.message))).toBe(true);
    expect(debugBus.snapshot().counters).toMatchObject({ 'publish-inline-rejected:400': expect.any(Number) });
  });
});
