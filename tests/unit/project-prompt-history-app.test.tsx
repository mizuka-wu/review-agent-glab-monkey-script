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
  old_path: 'src/payment.test.ts', new_path: 'src/payment.test.ts',
  new_file: false, deleted_file: false, renamed_file: false,
  diff: [
    '@@ -1,4 +1,5 @@ describe("orderTotal", () => {',
    ' describe("orderTotal", () => {',
    '+  const items = [{ price: 2 }, { price: 3 }];',
    '   it("sums the item prices", () => {',
    '     expect(orderTotal(items)).toBe(5);',
  ].join('\n'),
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubNetwork() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/models')) return json({ data: ['test-model'] });
    if (url.includes('/merge_requests/248/diffs')) return json([diff]);
    if (url.includes('/merge_requests/248')) return json(mergeRequest);
    if (url.endsWith('/discussions')) return json([]);
    return json({ message: '404 Not Found' }, 404);
  }));
}

/** 起始页的项目补充要求：旧单值 projectPrompts 会在 loadSettings 里被迁移成 1 条历史。 */
function mount(projectPrompts: unknown, projectPromptHistory?: unknown) {
  localStorage.setItem('review-agent-settings-v1', JSON.stringify({
    reviewMode: 'rules', gitlabToken: '', language: 'zh-CN',
    projectPrompts, ...(projectPromptHistory ? { projectPromptHistory } : {}),
  }));
  localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
  return render(<App page={page} />);
}

const box = () => screen.getByRole('textbox', { name: '项目补充要求' }) as HTMLTextAreaElement;
const listOf = () => screen.getByRole('listbox', { name: '项目补充要求历史列表' });
const stored = () => JSON.parse(localStorage.getItem('review-agent-settings-v1') ?? '{}');

async function waitForIdle() {
  await waitFor(() => expect(screen.getByText('开始一次混合评审')).toBeTruthy());
  await waitFor(() => expect(screen.getByRole('button', { name: '开始 Review' })).toBeEnabled());
}

beforeEach(() => {
  localStorage.clear();
  debugBus.clear('all');
  stubNetwork();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('起始页项目补充要求历史', () => {
  it('旧版单值提示迁移成 1 条历史，输入框里还是原来那段话', async () => {
    mount({ 'acme/app': '金额计算必须用 decimal' });
    await waitForIdle();

    expect(box()).toHaveValue('金额计算必须用 decimal');
    expect(screen.getByRole('button', { name: '项目补充要求历史' })).toHaveTextContent('1');
    fireEvent.click(screen.getByRole('button', { name: '项目补充要求历史' }));
    expect(within(listOf()).getAllByRole('option')).toHaveLength(1);
    expect(within(listOf()).getAllByRole('option')[0]).toHaveTextContent('金额计算必须用 decimal');
  }, 20000);

  it('标题写清按项目记住最近 10 次', async () => {
    mount({});
    await waitForIdle();
    expect(screen.getByText(/项目补充要求（按 acme\/app 记住最近 10 次，↑↓ 翻历史/)).toBeInTheDocument();
  }, 20000);

  it('改完失焦即保存：新值置顶，老版本落进 localStorage 的历史里', async () => {
    mount({ 'acme/app': '第一版要求' });
    await waitForIdle();

    fireEvent.change(box(), { target: { value: '第二版要求' } });
    // 打字阶段历史不动（只有迁移带过来的那 1 条），否则每敲一个字都会多出一条
    await waitFor(() => expect(stored().projectPromptHistory?.['acme/app']).toEqual(['第一版要求']));
    expect(stored().projectPrompts['acme/app']).toBe('第二版要求');

    fireEvent.blur(box());
    await waitFor(() => expect(stored().projectPromptHistory?.['acme/app']).toEqual(['第二版要求', '第一版要求']));
    expect(stored().projectPrompts['acme/app']).toBe('第二版要求');
  }, 20000);

  it('↑ 直接翻回上一版，↓ 回到正在写的内容', async () => {
    mount({}, { 'acme/app': ['第二版要求', '第一版要求'] });
    await waitForIdle();

    fireEvent.change(box(), { target: { value: '写到一半' } });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('第二版要求');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('第一版要求');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box()).toHaveValue('写到一半');
  }, 20000);

  it('翻出旧版本再失焦会把它提到最前，历史不重复增长', async () => {
    mount({}, { 'acme/app': ['第二版要求', '第一版要求'] });
    await waitForIdle();

    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('第一版要求');
    fireEvent.blur(box());

    await waitFor(() => expect(stored().projectPromptHistory?.['acme/app']).toEqual(['第一版要求', '第二版要求']));
    expect(stored().projectPrompts['acme/app']).toBe('第一版要求');
  }, 20000);

  it('列表里删掉一条噪声历史后持久化，当前生效值不受影响', async () => {
    mount({ 'acme/app': '第二版要求' }, { 'acme/app': ['第二版要求', '写错的一条', '第一版要求'] });
    await waitForIdle();

    fireEvent.click(screen.getByRole('button', { name: '项目补充要求历史' }));
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '删除这条补充要求' })[1]);

    await waitFor(() => expect(stored().projectPromptHistory?.['acme/app']).toEqual(['第二版要求', '第一版要求']));
    expect(box()).toHaveValue('第二版要求');
  }, 20000);

  it('清空后失焦：当前值不再注入，历史保留可以 ↑ 捞回来', async () => {
    mount({ 'acme/app': '第一版要求' });
    await waitForIdle();

    fireEvent.change(box(), { target: { value: '' } });
    fireEvent.blur(box());

    await waitFor(() => expect(stored().projectPrompts?.['acme/app']).toBeUndefined());
    expect(stored().projectPromptHistory['acme/app']).toEqual(['第一版要求']);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('第一版要求');
  }, 20000);

  it('只存过历史、当前值为空的项目也能在起始页翻出来', async () => {
    mount({}, { 'acme/app': ['以前的要求'] });
    await waitForIdle();

    expect(box()).toHaveValue('');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('以前的要求');
  }, 20000);
});
