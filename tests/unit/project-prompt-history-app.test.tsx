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
const historyButton = () => screen.getByRole('button', { name: '项目补充要求历史' });
const stored = () => JSON.parse(localStorage.getItem('review-agent-settings-v1') ?? '{}');

/** 打开历史列表并点第 index 条：↑↓ 已经不是入口，挑历史只能走按钮。 */
function pickEntry(index: number) {
  fireEvent.click(historyButton());
  fireEvent.click(within(listOf()).getAllByRole('option')[index]);
}

/** 派发原生按键事件：defaultPrevented 直接说明这一次按键有没有被脚本拦下来。 */
function press(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  box().dispatchEvent(event);
  return event;
}

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
    expect(historyButton()).toHaveTextContent('1');
    fireEvent.click(historyButton());
    expect(within(listOf()).getAllByRole('option')).toHaveLength(1);
    expect(within(listOf()).getAllByRole('option')[0]).toHaveTextContent('金额计算必须用 decimal');
  }, 20000);

  it('标题写清按项目记住最近 10 次、从历史按钮挑', async () => {
    mount({});
    await waitForIdle();
    expect(screen.getByText(/项目补充要求（按 acme\/app 记住最近 10 次，点输入框右上角的历史按钮挑回旧版本/)).toBeInTheDocument();
    expect(screen.queryByText(/↑↓ 翻历史/)).not.toBeInTheDocument();
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

  it('↑↓ / Esc 只归光标：多行内容不被历史覆盖，按键也没有被拦下来', async () => {
    mount({}, { 'acme/app': ['第二版要求', '第一版要求'] });
    await waitForIdle();

    fireEvent.change(box(), { target: { value: '第一行要求\n第二行要求' } });
    box().setSelectionRange(6, 6);

    expect(press('ArrowUp').defaultPrevented).toBe(false);
    expect(box()).toHaveValue('第一行要求\n第二行要求');
    expect(box().selectionStart).toBe(6);
    expect(press('ArrowDown').defaultPrevented).toBe(false);
    expect(press('Escape').defaultPrevented).toBe(false);
    expect(box()).toHaveValue('第一行要求\n第二行要求');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  }, 20000);

  it('从历史列表挑回旧版本再失焦，把它提到最前，历史不重复增长', async () => {
    mount({}, { 'acme/app': ['第二版要求', '第一版要求'] });
    await waitForIdle();

    pickEntry(1);
    expect(box()).toHaveValue('第一版要求');
    fireEvent.blur(box());

    await waitFor(() => expect(stored().projectPromptHistory?.['acme/app']).toEqual(['第一版要求', '第二版要求']));
    expect(stored().projectPrompts['acme/app']).toBe('第一版要求');
  }, 20000);

  it('列表里删掉一条噪声历史后持久化，当前生效值不受影响', async () => {
    mount({ 'acme/app': '第二版要求' }, { 'acme/app': ['第二版要求', '写错的一条', '第一版要求'] });
    await waitForIdle();

    fireEvent.click(historyButton());
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '删除这条补充要求' })[1]);

    await waitFor(() => expect(stored().projectPromptHistory?.['acme/app']).toEqual(['第二版要求', '第一版要求']));
    expect(box()).toHaveValue('第二版要求');
  }, 20000);

  it('清空后失焦：当前值不再注入，历史保留可以从列表捞回来', async () => {
    mount({ 'acme/app': '第一版要求' });
    await waitForIdle();

    fireEvent.change(box(), { target: { value: '' } });
    fireEvent.blur(box());

    await waitFor(() => expect(stored().projectPrompts?.['acme/app']).toBeUndefined());
    expect(stored().projectPromptHistory['acme/app']).toEqual(['第一版要求']);
    expect(historyButton()).toHaveTextContent('1');
    pickEntry(0);
    expect(box()).toHaveValue('第一版要求');
  }, 20000);

  it('只存过历史、当前值为空的项目也能在起始页挑回来', async () => {
    mount({}, { 'acme/app': ['以前的要求'] });
    await waitForIdle();

    expect(box()).toHaveValue('');
    press('ArrowUp');
    expect(box()).toHaveValue('');
    pickEntry(0);
    expect(box()).toHaveValue('以前的要求');
    await waitFor(() => expect(stored().projectPrompts['acme/app']).toBe('以前的要求'));
  }, 20000);

  it('历史按钮标出条数，展开后当前生效值被标成已选中', async () => {
    mount({ 'acme/app': '第二版要求' }, { 'acme/app': ['第二版要求', '第一版要求'] });
    await waitForIdle();

    expect(box()).toHaveValue('第二版要求');
    expect(historyButton()).toHaveTextContent('2');
    fireEvent.click(historyButton());
    const options = within(listOf()).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(historyButton());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  }, 20000);
});
