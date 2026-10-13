import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { Banner, Toast } from '../../src/components/ui/modern';
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

/** 中性浮层底色：进行中和普通播报共用，只有报错才换红。 */
const TOAST_BG = '#1e2536';
const DANGER = '#dc2626';
const DANGER_BG = '#fee2e2';
const LOADING_BG = '#f8f9fb';

function gate() {
  let open: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { open = resolve; });
  return { held, release: () => open() };
}

/** 发布写接口可以卡住：用来观察「进行中」这一段到底是什么样式。 */
function stubNetwork(options: { publishGate?: Promise<void>; noteStatus?: number } = {}) {
  const { publishGate, noteStatus = 200 } = options;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/v1/models')) return json({ data: [{ id: 'test-model' }] });
    if (url.includes('/merge_requests/248/diffs')) return json([diff]);
    if (url.includes('/approve')) return json({ id: 1 });
    if (url.includes('/notes') && method === 'POST') {
      if (publishGate) await publishGate;
      return noteStatus === 200 ? json({ id: 99 }) : json({ message: '403 Forbidden' }, noteStatus);
    }
    if (url.includes('/discussions') && method === 'POST') {
      if (publishGate) await publishGate;
      return json({ id: 'd1', notes: [{ id: 11 }] });
    }
    if (url.includes('/discussions')) return json([]);
    if (url.includes('/merge_requests/248')) return json(mergeRequest);
    return json({ message: '404 Not Found' }, 404);
  }));
}

function mount() {
  localStorage.setItem('review-agent-settings-v1', JSON.stringify(RULES_ONLY));
  localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
  return render(<App page={page} />);
}

const topBar = () => within(screen.getByRole('toolbar', { name: 'Review 操作' }));
const bottomBar = () => within(screen.getByRole('toolbar', { name: '评审快捷操作' }));
const cards = () => document.querySelectorAll('article[data-finding-source]');
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

describe('loading / error prompt styling', () => {
  it('toast 进行中是中性底色加 spinner，报错才是红色', () => {
    render(<Toast text="正在发布 2 条评论…" tone="loading" />);
    const loading = screen.getByRole('status');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading.querySelector('[data-spinner]')).not.toBeNull();
    expect(loading).toHaveStyle({ backgroundColor: TOAST_BG });
    expect(loading).not.toHaveStyle({ backgroundColor: DANGER });
    cleanup();

    render(<Toast text="总评论发布失败：GitLab API 403" tone="error" />);
    const failed = screen.getByRole('alert');
    expect(failed).toHaveStyle({ backgroundColor: DANGER });
    expect(failed.querySelector('[data-spinner]')).toBeNull();
    cleanup();

    render(<Toast text="总评论已发布" />);
    const done = screen.getByRole('status');
    expect(done).toHaveStyle({ backgroundColor: TOAST_BG });
    expect(done).not.toHaveAttribute('aria-busy');
    expect(done.querySelector('[data-spinner]')).toBeNull();
  });

  it('Banner 的 loading 调子是中性提示，不借报错红', () => {
    const loading = render(<Banner tone="loading" title="正在发布…">正在提交到 GitLab，请稍候…</Banner>);
    expect(screen.getByRole('status')).toBe(loading.container.firstElementChild);
    expect(loading.container.firstElementChild).toHaveStyle({ backgroundColor: LOADING_BG });
    expect(loading.container.firstElementChild).not.toHaveStyle({ backgroundColor: DANGER_BG });
    expect(loading.container.querySelector('[data-spinner]')).not.toBeNull();
    cleanup();

    const blocked = render(<Banner tone="danger" title="当前无法发布">评审进行中，请等本次 Review 结束后再发布</Banner>);
    expect(blocked.container.firstElementChild).toHaveStyle({ backgroundColor: DANGER_BG });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('publish in progress', () => {
  it('一键发布：进行中是 loading 提示，结束后被结果提示替换', async () => {
    const publish = gate();
    stubNetwork({ publishGate: publish.held });
    mount();
    await runReview();

    fireEvent.click(bottomBar().getByRole('button', { name: /一键(行内评论|全文评论|发布)/ }));
    fireEvent.click(bottomBar().getByRole('button', { name: '确认发布？' }));

    const loading = await screen.findByRole('status');
    expect(loading).toHaveTextContent(/正在发布 \d+ 条评论…/);
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading.querySelector('[data-spinner]')).not.toBeNull();
    expect(loading).toHaveStyle({ backgroundColor: TOAST_BG });
    expect(loading).not.toHaveStyle({ backgroundColor: DANGER });
    expect(screen.queryByText('当前无法发布')).toBeNull();

    // 进行中不自作主张消失：超过普通播报的 3.6s 也还在，等发布结果来替换
    await sleep(3800);
    expect(screen.getByRole('status')).toHaveTextContent(/正在发布 \d+ 条评论…/);

    publish.release();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^已发布 \d+ 条/));
    expect(screen.queryByText(/正在发布/)).toBeNull();
    expect(screen.getByRole('status')).toHaveStyle({ backgroundColor: TOAST_BG });
  }, 25000);

  it('单条发布：弹窗里进行中是 loading，不再是红色「当前无法发布」', async () => {
    const publish = gate();
    stubNetwork({ publishGate: publish.held });
    mount();
    await runReview();

    fireEvent.click(within(cards()[0]).getByRole('button', { name: /行内评论|全文评论/ }));
    const dialog = await screen.findByRole('dialog', { name: /发布(行内|全文)评论/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /^确认(行内|全文)评论/ }));

    const loading = await within(dialog).findByRole('status');
    expect(loading).toHaveTextContent('正在发布…');
    expect(loading).toHaveTextContent('正在提交到 GitLab，请稍候…');
    expect(loading.querySelector('[data-spinner]')).not.toBeNull();
    expect(loading).toHaveStyle({ backgroundColor: LOADING_BG });
    expect(loading).not.toHaveStyle({ backgroundColor: DANGER_BG });
    expect(within(dialog).queryByText('当前无法发布')).toBeNull();
    expect(within(dialog).getByRole('button', { name: '发布中…' })).toBeDisabled();

    publish.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent(/^行级 Discussion 已发布$|^行内不可用，已改为全文评论$/);
  }, 25000);

  it('总评论发布失败：进行中是 loading，结果仍然是红色报错', async () => {
    const publish = gate();
    stubNetwork({ publishGate: publish.held, noteStatus: 403 });
    mount();
    await runReview();

    fireEvent.click(bottomBar().getByRole('button', { name: '总评论' }));
    fireEvent.click(bottomBar().getByRole('button', { name: '确认发布？' }));

    const loading = await screen.findByRole('status');
    expect(loading).toHaveTextContent('正在发布总评论…');
    expect(loading).toHaveStyle({ backgroundColor: TOAST_BG });

    publish.release();
    const failed = await screen.findByRole('alert');
    expect(failed).toHaveTextContent(/总评论发布失败：GitLab API 403/);
    expect(failed).toHaveStyle({ backgroundColor: DANGER });
    expect(failed.querySelector('[data-spinner]')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  }, 25000);
});
