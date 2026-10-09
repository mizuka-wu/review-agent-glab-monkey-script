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

/** 不命中任何内置规则的干净变更：Review 完成后是 0 findings 的空态。 */
const cleanDiff = {
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

const modelFindings = JSON.stringify([{
  title: '硬编码 API Key 应移至安全配置', severity: 'high', category: 'security', confidence: 'high',
  path: 'src/payment.ts', line: 2, endLine: 2, existingCode: 'const apiKey = "sk-live-123";',
  suggestion: '从环境变量或密钥管理服务读取', reason: '新增赋值涉及密码、Token 或 API Key',
  content: '新增赋值涉及密码、Token 或 API Key，应从安全配置读取。',
  evidence: [{ path: 'src/payment.ts', line: 2, snippet: 'const apiKey = "sk-live-123";' }],
  comment: '发现硬编码 API Key，应从安全配置或密钥管理服务读取。',
}]);

const RULES_ONLY = { reviewMode: 'rules', gitlabToken: '', language: 'zh-CN' };
const HYBRID = {
  provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
  reviewMode: 'hybrid', gitlabToken: '', language: 'zh-CN',
};

/** GitLab 与模型端点都走 fetch：modelGate 可以把 Review 卡在 running，用来验证进行中禁用复位。 */
function stubNetwork(options: { modelGate?: Promise<void>; diffs?: unknown[] } = {}) {
  const { modelGate, diffs = [diff] } = options;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/chat/completions')) {
      if (modelGate) await modelGate;
      return json({
        id: 'c1', object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: modelFindings }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    if (url.includes('/v1/models')) return json({ data: [{ id: 'test-model' }] });
    if (url.includes('/merge_requests/248/diffs')) return json(diffs);
    if (url.includes('/merge_requests/248')) return json(mergeRequest);
    if (url.endsWith('/discussions')) return json([]);
    return json({ message: '404 Not Found' }, 404);
  }));
}

function mount(settings: Record<string, unknown>) {
  localStorage.setItem('review-agent-settings-v1', JSON.stringify(settings));
  localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
  return render(<App page={page} />);
}

const topBar = () => within(screen.getByRole('toolbar', { name: 'Review 操作' }));
const bottomBar = () => within(screen.getByRole('toolbar', { name: '评审快捷操作' }));
const promptBox = () => screen.getByRole('textbox', { name: '项目补充要求' });
const cards = () => document.querySelectorAll('article[data-finding-source]');
/** 「结果」标签的计数徽标只在有 Finding 时渲染，复位后应当只剩标签文字。 */
const resultsTabLabel = () => screen.getByRole('tab', { name: /结果/ }).textContent;

async function waitForMrLoaded() {
  await waitFor(() => expect(topBar().getByRole('button', { name: '开始 Review' })).toBeEnabled());
}

async function runReview() {
  fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
  await waitFor(() => expect(cards().length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByText(/Review 完成|个问题/)).toBeTruthy());
}

beforeEach(() => {
  localStorage.clear();
  debugBus.clear('all');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('review reset', () => {
  it('底部「重新开始」清空本轮结果并把焦点交回 prompt 输入框', async () => {
    stubNetwork();
    mount(RULES_ONLY);
    await waitForMrLoaded();

    fireEvent.change(promptBox(), { target: { value: '金额计算必须用 decimal' } });
    await runReview();
    expect(cards().length).toBeGreaterThan(0);
    expect(resultsTabLabel()).not.toBe('结果');

    const reset = bottomBar().getByRole('button', { name: '重新开始' });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    await waitFor(() => expect(screen.getByText('开始一次混合评审')).toBeTruthy());
    expect(cards()).toHaveLength(0);
    expect(resultsTabLabel()).toBe('结果');
    expect(screen.queryByRole('toolbar', { name: '评审快捷操作' })).toBeNull();
    expect(screen.getByText('已回到初始状态，可以开始新一轮 Review')).toBeTruthy();

    const prompt = promptBox();
    expect(prompt).toHaveFocus();
    expect(prompt).toBeEnabled();
    expect(prompt).toHaveValue('金额计算必须用 decimal');
  }, 20000);

  it('复位后可以立刻开始下一轮 Review', async () => {
    stubNetwork();
    mount(RULES_ONLY);
    await waitForMrLoaded();
    await runReview();

    fireEvent.click(bottomBar().getByRole('button', { name: '重新开始' }));
    await waitFor(() => expect(screen.getByText('开始一次混合评审')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    expect(topBar().getByRole('button', { name: '重新开始' })).toBeEnabled();
  }, 20000);

  it('顶部「重新开始」与底部同一个复位入口，行为一致', async () => {
    stubNetwork();
    mount(RULES_ONLY);
    await waitForMrLoaded();

    expect(topBar().queryByRole('button', { name: '重新开始' })).toBeNull();
    await runReview();

    const reset = topBar().getByRole('button', { name: '重新开始' });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    await waitFor(() => expect(screen.getByText('开始一次混合评审')).toBeTruthy());
    expect(cards()).toHaveLength(0);
    expect(resultsTabLabel()).toBe('结果');
    expect(promptBox()).toHaveFocus();
    expect(topBar().queryByRole('button', { name: '重新开始' })).toBeNull();
  }, 20000);

  it('Review 进行中两个入口都禁用，结束后恢复可用', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubNetwork({ modelGate: gate });
    mount(HYBRID);
    await waitForMrLoaded();

    fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
    await waitFor(() => expect(topBar().getByRole('button', { name: 'Review 中' })).toBeTruthy());

    expect(topBar().getByRole('button', { name: '重新开始' })).toBeDisabled();
    await waitFor(() => expect(bottomBar().getByRole('button', { name: '重新开始' })).toBeDisabled());

    release();
    await waitFor(() => expect(topBar().getByRole('button', { name: '重新开始' })).toBeEnabled());
    expect(bottomBar().getByRole('button', { name: '重新开始' })).toBeEnabled();
  }, 20000);

  it('0 findings 的空态同样能复位回初始输入界面', async () => {
    stubNetwork({ diffs: [cleanDiff] });
    mount(RULES_ONLY);
    await waitForMrLoaded();

    fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
    await waitFor(() => expect(screen.getByText('没有发现需要处理的问题')).toBeTruthy());
    expect(cards()).toHaveLength(0);

    const reset = bottomBar().getByRole('button', { name: '重新开始' });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    await waitFor(() => expect(screen.getByText('开始一次混合评审')).toBeTruthy());
    expect(screen.queryByText('没有发现需要处理的问题')).toBeNull();
    expect(promptBox()).toHaveFocus();
  }, 20000);

  it('复位保留 chat 会话、设置与 debug 记录', async () => {
    stubNetwork();
    mount({ ...RULES_ONLY, debugEnabled: true });
    await waitForMrLoaded();

    fireEvent.change(promptBox(), { target: { value: '不要评论命名风格' } });
    await runReview();

    // Review 结束会往当前 chat 会话里写一条总结：复位不该把它带走
    fireEvent.click(screen.getByRole('tab', { name: /对话/ }));
    await waitFor(() => expect(document.body.textContent).toContain('结果已列在「结果」页'));

    fireEvent.click(screen.getByRole('tab', { name: /结果/ }));
    fireEvent.click(bottomBar().getByRole('button', { name: '重新开始' }));
    await waitFor(() => expect(screen.getByText('开始一次混合评审')).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /对话/ }));
    await waitFor(() => expect(document.body.textContent).toContain('结果已列在「结果」页'));

    fireEvent.click(screen.getByRole('tab', { name: /调试/ }));
    await waitFor(() => expect(document.body.textContent).toContain('已复位 Review：清除本轮结果，回到 prompt 输入界面'));
    expect(document.body.textContent).toContain('开始 Review（整个 MR · rules）');

    fireEvent.click(screen.getByRole('tab', { name: /结果/ }));
    await waitFor(() => expect(screen.getByText('开始一次混合评审')).toBeTruthy());
    expect(promptBox()).toHaveValue('不要评论命名风格');
    expect(document.body.textContent).toContain('仅规则');
    expect(JSON.parse(localStorage.getItem('review-agent-settings-v1') ?? '{}').reviewMode).toBe('rules');
  }, 20000);
});
