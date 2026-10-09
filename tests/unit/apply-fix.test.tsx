import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import type { PageContext } from '../../src/core/types';

const page: PageContext = {
  origin: 'https://gitlab.test', route: 'diff', projectPath: 'acme/app',
  projectNumericId: 42, mergeRequestIid: 248,
};

const mergeRequest = {
  title: 'Harden checkout payment error handling', state: 'opened',
  source_branch: 'feature/payment', target_branch: 'main', sha: 'head-sha',
  diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha', start_sha: 'start-sha' },
};

const paymentDiff = {
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  new_file: false, deleted_file: false, renamed_file: false,
  diff: [
    '@@ -1,2 +1,4 @@ export function pay() {',
    ' export function pay() {',
    '+  const apiKey = "sk-live-123";',
    '+  return charge(apiKey);',
    ' }',
  ].join('\n'),
};

const currentFile = 'export function pay() {\n  const apiKey = "sk-live-123";\n  return charge(apiKey);\n}\n';
const fixedFile = 'export function pay() {\n  const apiKey = readSecret("payment-key");\n  return charge(apiKey);\n}\n';

const fixPatch = [
  '@@ -1,4 +1,4 @@',
  ' export function pay() {',
  '-  const apiKey = "sk-live-123";',
  '+  const apiKey = readSecret("payment-key");',
  '   return charge(apiKey);',
  ' }',
].join('\n');

/** A：有锚点、有建议改法 → 可修复。B：低置信度的泛泛建议 → 不给入口。 */
const modelFindings = JSON.stringify({
  findings: [
    {
      title: '硬编码 API Key 应移至安全配置', severity: 'high', category: 'security', confidence: 'high',
      path: 'src/payment.ts', line: 2, endLine: 2, side: 'new',
      existingCode: 'const apiKey = "sk-live-123";',
      suggestionCode: 'const apiKey = readSecret("payment-key");',
      content: '新增赋值把密钥直接写进了源文件。',
      evidence: [{ path: 'src/payment.ts', lines: 'L2', quote: 'const apiKey = "sk-live-123";' }],
      comment: '发现硬编码 API Key，应从安全配置读取。',
    },
    {
      title: '错误处理策略需要整体重构', severity: 'medium', category: 'maintainability', confidence: 'low',
      path: 'src/payment.ts', line: 3, endLine: 3, side: 'new',
      existingCode: 'return charge(apiKey);',
      content: '整个模块的错误处理策略不统一，建议引入统一的错误分层与降级路径。',
      evidence: [{ path: 'src/payment.ts', lines: 'L3', quote: 'return charge(apiKey);' }],
      comment: '错误处理策略需要统一。',
    },
  ],
});

interface Call { url: string; method: string; body: string }

function stubNetwork(options: { fixResponse?: string; commitStatus?: number } = {}): Call[] {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body });

    if (url.startsWith('https://model.test')) {
      const content = body.includes('你是代码评审管线的修复模块')
        ? options.fixResponse ?? JSON.stringify({ patch: fixPatch })
        : modelFindings;
      return json({
        id: 'c1', object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    if (url.includes('/repository/files/')) return new Response(currentFile, { status: 200 });
    if (url.includes('/repository/commits') && method === 'POST') {
      const status = options.commitStatus ?? 201;
      return status < 300
        ? json({ id: 'c0ffee1234567890', short_id: 'c0ffee12', title: '硬编码 API Key 应移至安全配置', web_url: 'https://gitlab.test/commit/c0ffee12' }, status)
        : json({ message: `${status} Forbidden` }, status);
    }
    if (url.includes('/api/v4/user')) return json({ username: 'root' });
    if (url.includes('/discussions')) return json([]);
    if (url.includes('/merge_requests/248/diffs')) return json([paymentDiff]);
    if (url.includes('/merge_requests/248')) return json(mergeRequest);
    return json({ message: '404 Not Found' }, 404);
  }));
  return calls;
}

const SETTINGS = {
  provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
  reviewMode: 'hybrid', effort: 'thorough', language: 'zh-CN', gitlabToken: 'glpat-test',
  applyFixEnabled: true,
};

function mount(settings: Record<string, unknown> = SETTINGS) {
  localStorage.setItem('review-agent-settings-v1', JSON.stringify(settings));
  localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
  return render(<App page={page} />);
}

async function runReview() {
  await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
  await waitFor(() => expect(screen.getByText(/个问题/)).toBeInTheDocument(), { timeout: 8000 });
}

function card(title: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('article[data-finding-source]')]
    .find((article) => article.textContent?.includes(title));
  if (!found) throw new Error(`找不到 Finding 卡片：${title}`);
  return found;
}

/** 结果列表默认只展开第一条，其余卡片要先点开才看得到操作按钮。 */
function expand(article: HTMLElement) {
  const toggle = article.querySelector('button[aria-expanded="false"]');
  if (toggle) fireEvent.click(toggle);
}

const fixButton = (article: HTMLElement) => within(article).queryByRole('button', { name: '应用修复' });
const statusOf = (title: string) => card(title).getAttribute('data-finding-status');
const commitsOf = (calls: Call[]) => calls.filter((call) => call.url.includes('/repository/commits') && call.method === 'POST');
const diffsOf = (calls: Call[]) => calls.filter((call) => call.url.includes('/merge_requests/248/diffs'));

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('apply fix gating', () => {
  it('renders no apply-fix entry while the setting is off', async () => {
    stubNetwork();
    mount({ ...SETTINGS, applyFixEnabled: false });
    await runReview();
    expand(card('硬编码 API Key 应移至安全配置'));

    expect(screen.queryByRole('button', { name: '应用修复' })).not.toBeInTheDocument();
    // 发布链路不受影响：入口还在
    expect(screen.getAllByRole('button', { name: /行内评论|全文评论/ }).length).toBeGreaterThan(0);
  });

  it('turns the entry on from the settings panel and persists the switch', async () => {
    stubNetwork();
    mount({ ...SETTINGS, applyFixEnabled: false });
    await runReview();
    expect(screen.queryByRole('button', { name: '应用修复' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '设置' }));
    const toggle = screen.getByRole('switch', { name: '允许应用修复' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('review-agent-settings-v1') ?? '{}') as { applyFixEnabled?: boolean };
      expect(stored.applyFixEnabled).toBe(true);
    });

    fireEvent.click(screen.getByRole('tab', { name: /^结果/ }));
    expand(card('硬编码 API Key 应移至安全配置'));
    expect(fixButton(card('硬编码 API Key 应移至安全配置'))).toBeInTheDocument();
  });

  it('offers the entry only on findings with a concrete change', async () => {
    stubNetwork();
    mount();
    await runReview();

    const fixable = card('硬编码 API Key 应移至安全配置');
    expand(fixable);
    expect(fixButton(fixable)).toBeEnabled();

    const vague = card('错误处理策略需要整体重构');
    expand(vague);
    expect(fixButton(vague)).not.toBeInTheDocument();
  });
});

describe('apply fix flow', () => {
  it('previews the file, the diff and the reused commit message before committing', async () => {
    const calls = stubNetwork();
    mount();
    await runReview();

    const article = card('硬编码 API Key 应移至安全配置');
    expand(article);
    fireEvent.click(fixButton(article)!);

    const dialog = await screen.findByRole('dialog', { name: '应用修复' });
    await waitFor(() => expect(within(dialog).getByText('Diff 预览')).toBeInTheDocument());

    // 读了源分支上的当前文件内容，并用同一份模型配置生成修复
    expect(calls.some((call) => call.url.includes('/repository/files/src%2Fpayment.ts/raw')
      && call.url.includes('ref=feature%2Fpayment'))).toBe(true);
    const fixPrompt = calls.filter((call) => call.url.includes('/chat/completions'))
      .map((call) => JSON.parse(call.body) as { messages: { role: string; content: string }[] })
      .find((payload) => payload.messages[0].content.includes('你是代码评审管线的修复模块'))!
      .messages[1].content;
    expect(fixPrompt).toContain('硬编码 API Key 应移至安全配置');
    expect(fixPrompt).toContain('2:   const apiKey = "sk-live-123";');
    expect(fixPrompt).toContain('const apiKey = readSecret("payment-key");');

    expect(dialog.textContent).toContain('提交到源分支 feature/payment');
    expect(dialog.textContent).toContain('src/payment.ts');
    expect(dialog.textContent).toContain('-  const apiKey = "sk-live-123";');
    expect(dialog.textContent).toContain('+  const apiKey = readSecret("payment-key");');
    // commit 信息直接复用 Finding：标题当 message，证据/建议正文当 description
    const commit = within(dialog).getByText('Commit 信息（直接复用 Finding）').parentElement!;
    expect(commit.textContent).toContain('硬编码 API Key 应移至安全配置');
    expect(commit.textContent).toContain('新增赋值把密钥直接写进了源文件。');
    expect(commit.textContent).toContain('src/payment.ts L2');
    expect(commit.textContent).toContain('规则 `builtin-hardcoded-secret`');
    expect(commitsOf(calls)).toHaveLength(0);
  });

  it('commits to the source branch, marks the finding fixed and refreshes the MR changes', async () => {
    const calls = stubNetwork();
    mount();
    await runReview();
    const before = diffsOf(calls).length;

    const article = card('硬编码 API Key 应移至安全配置');
    expand(article);
    fireEvent.click(fixButton(article)!);
    const dialog = await screen.findByRole('dialog', { name: '应用修复' });
    await waitFor(() => expect(within(dialog).getByText('Diff 预览')).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole('button', { name: '确认提交' }));

    await waitFor(() => expect(commitsOf(calls)).toHaveLength(1));
    const payload = JSON.parse(commitsOf(calls)[0].body) as {
      branch: string; commit_message: string; commit_description?: string;
      actions: { action: string; file_path: string; content: string }[];
    };
    expect(payload.branch).toBe('feature/payment');
    // 标题就是 Finding 标题，正文是 Finding 的证据与建议原文
    expect(payload.commit_message.split('\n')[0]).toBe('硬编码 API Key 应移至安全配置');
    expect(payload.commit_message).toContain('新增赋值把密钥直接写进了源文件。');
    expect(payload.commit_message).toContain('const apiKey = "sk-live-123";');
    expect(payload.commit_description).toBeUndefined();
    expect(payload.actions).toEqual([
      { action: 'update', file_path: 'src/payment.ts', content: fixedFile },
    ]);

    await waitFor(() => expect(screen.getByText('已提交修复 c0ffee12 到 feature/payment')).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: '应用修复' })).not.toBeInTheDocument();
    expect(statusOf('硬编码 API Key 应移至安全配置')).toBe('fixed');
    expect(within(card('硬编码 API Key 应移至安全配置')).getAllByText('已修复').length).toBeGreaterThan(1);
    // 提交后重新拉了一次 MR 变更
    await waitFor(() => expect(diffsOf(calls).length).toBeGreaterThan(before));
  });

  it('says why an unusable model answer was dropped and commits nothing', async () => {
    const calls = stubNetwork({ fixResponse: '我觉得这里应该改成从配置读取密钥。' });
    mount();
    await runReview();

    const article = card('硬编码 API Key 应移至安全配置');
    expand(article);
    fireEvent.click(fixButton(article)!);

    const dialog = await screen.findByRole('dialog', { name: '应用修复' });
    await waitFor(() => expect(dialog.textContent).toContain('模型没有返回可解析的 JSON 修复结果'));
    expect(within(dialog).getByRole('button', { name: '确认提交' })).toBeDisabled();
    expect(commitsOf(calls)).toHaveLength(0);
    expect(statusOf('硬编码 API Key 应移至安全配置')).not.toBe('fixed');
  });

  it('reports a rejected push and leaves the finding unfixed', async () => {
    const calls = stubNetwork({ commitStatus: 403 });
    mount();
    await runReview();

    const article = card('硬编码 API Key 应移至安全配置');
    expand(article);
    fireEvent.click(fixButton(article)!);
    const dialog = await screen.findByRole('dialog', { name: '应用修复' });
    await waitFor(() => expect(within(dialog).getByText('Diff 预览')).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole('button', { name: '确认提交' }));

    await waitFor(() => expect(dialog.textContent).toContain('没有向该分支推送的权限'));
    expect(dialog.textContent).toContain('403');
    expect(statusOf('硬编码 API Key 应移至安全配置')).not.toBe('fixed');
    expect(screen.queryByRole('dialog', { name: '应用修复' })).toBeInTheDocument();
  });
});
