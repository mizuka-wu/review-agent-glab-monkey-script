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

const mergeRequest = {
  title: 'Harden checkout payment error handling',
  state: 'opened', source_branch: 'feature/payment', target_branch: 'main', sha: 'head-sha',
  diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha-0123456789', start_sha: 'start-sha' },
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

/** 设置里的 GitLab 令牌：降级日志会带上服务端原话与全部 position 参数，唯独不能带这个。 */
const TOKEN = 'glpat-SuperSecretTokenValue123';
const RULES_ONLY = { reviewMode: 'rules', gitlabToken: TOKEN, language: 'zh-CN' };

const REJECTION = "Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}";

/** rejectPosition=true 时带 position 的行内请求一律 400；不带 position 的全文重发一律 201。 */
function stubPublish(rejectPosition: boolean) {
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
      return rejectPosition && body.includes('position%5B')
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

/** console 上的降级现场：attachConsole 会包一层，spy 仍然收得到完整文本。 */
function spyConsole() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    warn,
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

describe('行内降级为全文时把原因与完整参数打到 console', () => {
  it('单条发布被拒：一段 [inline-fallback] 现场，含原因、position 全量参数、diff_refs 与服务端响应', async () => {
    const posts = stubPublish(true);
    const console_ = spyConsole();
    mount();
    await runReview();

    fireEvent.click(within(cards()[0]).getByRole('button', { name: /行内评论|全文评论/ }));
    const dialog = await screen.findByRole('dialog', { name: /发布(行内|全文)评论/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /^确认(行内|全文)评论/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/已降级全文评论/));
    await waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(2));

    const blocks = console_.blocks();
    expect(blocks).toHaveLength(1);
    const log = blocks[0];
    expect(log.split('\n').every((line) => line.startsWith(INLINE_FALLBACK_PREFIX))).toBe(true);
    expect(log).toContain('行内评论降级为全文评论');
    expect(log).toContain('cause=inline-rejected');
    expect(log).toContain('reasonCode=inline-rejected');
    expect(log).toContain('reason: GitLab 拒绝了这个行内位置');
    expect(log).toContain('line_code');
    // 当时真实发出的 position 参数一个不少
    expect(log).toContain('position[position_type]=text');
    expect(log).toContain('position[base_sha]=base-sha');
    expect(log).toContain('position[head_sha]=head-sha-0123456789');
    expect(log).toContain('position[start_sha]=start-sha');
    expect(log).toContain('position[new_path]=src/payment.ts');
    expect(log).toContain('position[old_path]=src/payment.ts');
    // 锚定输入与结果、diff 概况、服务端响应
    expect(log).toContain('anchor-input: path=src/payment.ts');
    expect(log).toContain('anchor-result: source=diff');
    expect(log).toContain('side=new');
    expect(log).toContain('lineKind=added');
    expect(log).toContain('diff: file=src/payment.ts');
    expect(log).toContain('server: HTTP 400');
    expect(log).toContain('400 Bad request');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('SuperSecret');

    // 调试面板 / 导出包里也是同一条完整现场
    const entries = debugBus.getLogs().filter((entry) => entry.message.startsWith(INLINE_FALLBACK_PREFIX));
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toContain('position[head_sha]=head-sha-0123456789');
    expect(debugBus.exportBundle()).toContain('inline-fallback');
  });

  it('批量发布：每条降级各打一段，条数与降级条数一致', async () => {
    stubPublish(true);
    const console_ = spyConsole();
    mount();
    await runReview();

    fireEvent.click(bottomBar().getByRole('button', { name: /一键(行内评论|全文评论|发布)/ }));
    fireEvent.click(bottomBar().getByRole('button', { name: '确认发布？' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/条行内失败已降级全文/));

    const blocks = console_.blocks();
    expect(blocks.length).toBe(3);
    expect(blocks.every((log) => log.includes('reasonCode=inline-rejected'))).toBe(true);
    expect(blocks.every((log) => log.includes('position[head_sha]=head-sha-0123456789'))).toBe(true);
    expect(debugBus.getCounters()['publish-inline-rejected:400']).toBe(3);
  });

  it('行内发布成功不打这条日志', async () => {
    const posts = stubPublish(false);
    const console_ = spyConsole();
    mount();
    await runReview();

    fireEvent.click(within(cards()[0]).getByRole('button', { name: /行内评论|全文评论/ }));
    const dialog = await screen.findByRole('dialog', { name: /发布(行内|全文)评论/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /^确认(行内|全文)评论/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/行级 Discussion 已发布/));

    expect(posts[0]).toContain('position%5B');
    expect(console_.blocks()).toHaveLength(0);
    expect(debugBus.getLogs().some((entry) => entry.message.startsWith(INLINE_FALLBACK_PREFIX))).toBe(false);
  });

  it('MR 总评论这种主动全文发布不算降级，不出声', async () => {
    const posts = stubPublish(false);
    const console_ = spyConsole();
    mount();
    await runReview();

    fireEvent.click(bottomBar().getByRole('button', { name: /总评论/ }));
    fireEvent.click(bottomBar().getByRole('button', { name: '确认发布？' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/总评论已发布/));

    expect(posts.some((body) => body.includes('position%5B'))).toBe(false);
    expect(console_.blocks()).toHaveLength(0);
  });
});
