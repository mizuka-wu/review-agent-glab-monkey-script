import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import type { PageContext } from '../../src/core/types';

const page: PageContext = {
  origin: 'https://gitlab.test', route: 'diff', projectPath: 'acme/app',
  projectNumericId: 42, mergeRequestIid: 248,
};

const CURRENT_MR_URL = 'https://gitlab.test/acme/app/-/merge_requests/248/diffs';
const REFERENCE_MR_URL = 'https://other.test/platform/sdk/-/merge_requests/12';

const mergeRequest = {
  title: 'Harden checkout payment error handling', state: 'opened',
  source_branch: 'feature/payment', target_branch: 'main', sha: 'head-sha',
  diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha', start_sha: 'start-sha' },
};

const currentDiff = {
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  new_file: false, deleted_file: false, renamed_file: false,
  diff: ['@@ -1,2 +1,4 @@ export function pay() {', ' export function pay() {', '+  const apiKey = "sk-live-123";', '+  return charge(apiKey);', ' }'].join('\n'),
};

const referenceDiff = {
  old_path: 'src/companion.ts', new_path: 'src/companion.ts',
  new_file: true, deleted_file: false, renamed_file: false,
  diff: '@@ -0,0 +1,2 @@\n+export const COMPANION_TOKEN = "tk_companion";\n+export function companionPing() { return "pong"; }',
};

const referenceMergeRequest = {
  title: 'feat: companion token endpoint', state: 'opened',
  source_branch: 'feat/token', target_branch: 'main', sha: 'c0ffee1234567890',
  diff_refs: { base_sha: 'c-base', head_sha: 'c0ffee1234567890', start_sha: 'c-base' },
};

/** 模型同时给当前 MR 和参考 MR 各出一条：参考那条必须被丢掉。 */
const modelFindings = JSON.stringify({
  findings: [
    {
      title: '硬编码 API Key 应移至安全配置', severity: 'high', category: 'security', confidence: 'high',
      path: 'src/payment.ts', line: 2, endLine: 2, side: 'new', existingCode: 'const apiKey = "sk-live-123";',
      content: '新增赋值涉及密码、Token 或 API Key，应从安全配置读取。',
      evidence: [{ path: 'src/payment.ts', lines: 'L2', quote: 'const apiKey = "sk-live-123";' }],
      comment: '发现硬编码 API Key，应从安全配置读取。', suggestionCode: 'const apiKey = readSecret("key");',
    },
    {
      title: '参考仓库里的 Token 也写死了', severity: 'high', category: 'security', confidence: 'high',
      path: 'src/companion.ts', line: 1, endLine: 1, side: 'new', existingCode: 'export const COMPANION_TOKEN = "tk_companion";',
      content: '参考 MR 的 companion.ts 把 Token 直接写进了源文件。',
      evidence: [{ path: 'src/companion.ts', lines: 'L1', quote: 'export const COMPANION_TOKEN = "tk_companion";' }],
      comment: '参考 MR 里有硬编码 Token。',
    },
  ],
});

const HYBRID = {
  provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
  reviewMode: 'hybrid', gitlabToken: 'glpat-test', language: 'zh-CN', effort: 'balanced',
};

interface Call { url: string; method: string; body: string }

function stubNetwork(options: { referenceStatus?: number; recent?: unknown[] } = {}): Call[] {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' });

    if (url.startsWith('https://model.test')) {
      return json({
        id: 'c1', object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: modelFindings }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    if (url.startsWith('https://other.test')) {
      if (url.includes('/merge_requests/12/diffs')) {
        return options.referenceStatus === 404 ? json({ message: '404 Not Found' }, 404) : json([referenceDiff]);
      }
      if (url.includes('/merge_requests/12')) {
        return options.referenceStatus === 404 ? json({ message: '404 Not Found' }, 404) : json(referenceMergeRequest);
      }
      return json({ message: '404 Not Found' }, 404);
    }
    // 顺序要紧：/discussions 也含 '/merge_requests/248'，必须先判
    if (url.includes('/discussions')) {
      return method === 'GET' ? json([]) : json({ id: 'discussion-1', notes: [{ id: 11 }] });
    }
    if (url.includes('/api/v4/merge_requests?scope=all')) return json(options.recent ?? []);
    if (url.includes('/merge_requests/248/diffs')) return json([currentDiff]);
    if (url.includes('/merge_requests/248')) return json(mergeRequest);
    return json({ message: '404 Not Found' }, 404);
  }));
  return calls;
}

function mount(settings: Record<string, unknown> = HYBRID) {
  localStorage.setItem('review-agent-settings-v1', JSON.stringify(settings));
  localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
  return render(<App page={page} />);
}

const panel = () => screen.getByRole('region', { name: '参考 MR' });
const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /^参考 MR/ }));
const linkBox = () => screen.getByRole('textbox', { name: '参考 MR 链接' });

function pasteLinks(text: string) {
  openPanel();
  fireEvent.change(linkBox(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '解析并拉取' }));
}

async function runReview() {
  fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
  await waitFor(() => expect(screen.getByText(/个问题/)).toBeInTheDocument(), { timeout: 8000 });
}

function modelRequestBodies(calls: Call[]): string[] {
  return calls.filter((call) => call.url.includes('/chat/completions')).map((call) => decodeURIComponent(call.body));
}

/** 只取评审那一次调用：反思模块也打同一个端点，但 system prompt 不同。 */
function reviewPrompts(calls: Call[]): string[] {
  return modelRequestBodies(calls).filter((body) => body.includes('你是代码评审引擎'));
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('reference MRs in the app', () => {
  it('fetches a pasted reference MR and shows it as attached context', async () => {
    const calls = stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());

    pasteLinks(`${REFERENCE_MR_URL}\nhttps://gitlab.test/acme/app/-/merge_requests/248/diffs`);

    await waitFor(() => expect(within(panel()).getByText('已就绪')).toBeInTheDocument());
    expect(within(panel()).getByText('platform/sdk!12')).toBeInTheDocument();
    expect(within(panel()).getByText('1 个变更文件 · head c0ffee12')).toBeInTheDocument();
    expect(within(panel()).getByText('feat: companion token endpoint')).toBeInTheDocument();
    expect(calls.some((call) => call.url.startsWith('https://other.test/api/v4/projects/platform%2Fsdk/merge_requests/12/diffs'))).toBe(true);

    // 当前 MR 不能当自己的参考，要说明原因
    expect(within(panel()).getByText('1 个链接没有加进来')).toBeInTheDocument();
    expect(panel()).toHaveTextContent('这就是当前正在评审的 MR，不需要当参考');
    expect(linkBox().value).toBe('');
  });

  it('splices the reference diff into the one review call and never into the findings', async () => {
    const calls = stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    pasteLinks(REFERENCE_MR_URL);
    await waitFor(() => expect(within(panel()).getByText('已就绪')).toBeInTheDocument());

    await runReview();

    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('参考变更：其他 MR（只读上下文，不是评审对象）');
    expect(prompts[0]).toContain('platform/sdk!12');
    expect(prompts[0]).toContain('COMPANION_TOKEN');
    expect(prompts[0]).toContain('src/payment.ts');

    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
    expect(screen.queryByText('参考仓库里的 Token 也写死了')).not.toBeInTheDocument();
    const articles = document.querySelectorAll('article[data-finding-source]');
    expect(articles.length).toBeGreaterThan(0);
    for (const article of articles) expect(article.textContent).not.toContain('src/companion.ts:');

    fireEvent.click(screen.getByRole('button', { name: '运行说明' }));
    expect(screen.getByText(/已注入 1 个参考 MR/)).toBeInTheDocument();
    expect(screen.getByText(/丢弃了 1 条落在参考 MR 上的 AI Finding/)).toBeInTheDocument();
  });

  it('publishes only to the current MR while a reference MR is attached', async () => {
    const calls = stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    pasteLinks(REFERENCE_MR_URL);
    await waitFor(() => expect(within(panel()).getByText('已就绪')).toBeInTheDocument());
    await runReview();

    const finding = [...document.querySelectorAll<HTMLElement>('article[data-finding-source]')]
      .find((article) => article.textContent?.includes('硬编码 API Key'))!;
    fireEvent.click(within(finding).getByRole('button', { name: /行内评论|全文评论/ }));
    const dialog = await screen.findByRole('dialog');
    // 发布目标写在弹窗上：永远只有当前 MR
    expect(dialog.textContent).toContain('acme/app · MR !248');
    fireEvent.click(within(dialog).getByRole('button', { name: /确认行内评论|确认全文评论/ }));
    await waitFor(() => expect(calls.some((call) => call.url.includes('/discussions') && call.method === 'POST')).toBe(true));

    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(post.url.startsWith('https://other.test')).toBe(false);
      if (post.url.includes('/discussions')) {
        expect(post.url).toContain('https://gitlab.test/api/v4/projects/42/merge_requests/248/discussions');
        expect(post.body).toContain('position%5Bhead_sha%5D=head-sha');
      }
    }
    expect(calls.filter((call) => call.url.includes('/discussions') && call.method === 'POST')).toHaveLength(1);
  });

  it('spells out a reference MR that could not be fetched, before and after the review', async () => {
    const calls = stubNetwork({ referenceStatus: 404 });
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    pasteLinks(REFERENCE_MR_URL);

    await waitFor(() => expect(within(panel()).getByText('拉取失败')).toBeInTheDocument());
    expect(panel()).toHaveTextContent('找不到 platform/sdk!12（HTTP 404）');
    expect(panel()).toHaveTextContent('Token 看不到该项目');

    await runReview();
    fireEvent.click(screen.getByRole('button', { name: '运行说明' }));
    expect(screen.getByText(/参考 MR platform\/sdk!12 拉取失败/)).toBeInTheDocument();
    expect(modelRequestBodies(calls).join('\n')).not.toContain('COMPANION_TOKEN');
    expect(reviewPrompts(calls)).toHaveLength(1);
  });

  it('reports a link that is not an MR at all', async () => {
    stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    pasteLinks('https://gitlab.test/acme/app/-/issues/9 随便一段话');
    expect(within(panel()).getByText('2 个链接没有加进来')).toBeInTheDocument();
    expect(panel()).toHaveTextContent('不是 Merge Request 链接');
    expect(panel()).toHaveTextContent('不是可解析的链接');
  });

  it('removes an attached reference so the next review runs without it', async () => {
    const calls = stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    pasteLinks(REFERENCE_MR_URL);
    await waitFor(() => expect(within(panel()).getByText('已就绪')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '移除参考 MR platform/sdk!12' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^参考 MR/ })).toHaveTextContent('未附加'));

    const before = reviewPrompts(calls).length;
    await runReview();
    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(before + 1);
    expect(prompts.at(-1)).not.toContain('COMPANION_TOKEN');
    expect(prompts.at(-1)).not.toContain('参考变更');
  });

  it('offers local review history first, then GitLab recent activity, and attaches a picked MR', async () => {
    localStorage.setItem('review-agent-review-sessions-v1', JSON.stringify({
      'ra-session-1': {
        version: 1, id: 'ra-session-1', key: 'k', origin: 'https://gitlab.test', projectPath: 'acme/legacy',
        mergeRequestIid: 77, headSha: 'sha', title: '上次评审的 MR', scope: 'all', source: 'rule',
        status: 'completed', effort: 'balanced', language: 'zh-CN',
        createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-08T20:11:00.000Z',
        findings: [], warnings: [], context: { includedFiles: 1, omittedFiles: [], fullFiles: 0, omittedFullFiles: [], estimatedCharacters: 10, budgetCharacters: 60000 },
      },
    }));
    const calls = stubNetwork({
      recent: [
        { iid: 12, title: 'feat: companion token endpoint', state: 'opened', source_branch: 'feat/token', target_branch: 'main', updated_at: '2026-10-09T09:40:00.000Z', web_url: REFERENCE_MR_URL },
        { iid: 248, title: '当前 MR 自己', state: 'opened', updated_at: '2026-10-09T09:00:00.000Z', web_url: CURRENT_MR_URL },
      ],
    });
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());

    openPanel();
    fireEvent.click(screen.getByRole('button', { name: '从最近活动选择' }));
    await waitFor(() => expect(within(panel()).getByText('acme/legacy!77')).toBeInTheDocument());

    expect(calls.some((call) => call.url.includes('/api/v4/merge_requests?scope=all'))).toBe(true);
    expect(within(panel()).queryByText('acme/app!248')).not.toBeInTheDocument();

    const historyGroup = within(panel()).getByText('本工具评审过的 MR').parentElement!;
    expect(within(historyGroup).getByText('上次评审的 MR')).toBeInTheDocument();

    fireEvent.click(within(panel()).getByRole('checkbox', { name: '选择 platform/sdk!12' }));
    await waitFor(() => expect(within(panel()).getByText('已就绪')).toBeInTheDocument());
    expect(calls.some((call) => call.url.startsWith('https://other.test/api/v4/projects/platform%2Fsdk/merge_requests/12'))).toBe(true);

    fireEvent.click(within(panel()).getByRole('checkbox', { name: '选择 platform/sdk!12' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^参考 MR/ })).toHaveTextContent('未附加'));
  });

  it('keeps a failing recent-activity list visible instead of showing an empty picker', async () => {
    const calls = stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: '' });
      if (url.includes('/api/v4/merge_requests?scope=all')) return new Response('{"message":"401 Unauthorized"}', { status: 401 });
      if (url.includes('/discussions')) return new Response('[]', { status: 200 });
      if (url.includes('/merge_requests/248/diffs')) return new Response(JSON.stringify([currentDiff]), { status: 200 });
      if (url.includes('/merge_requests/248')) return new Response(JSON.stringify(mergeRequest), { status: 200 });
      return new Response('{"message":"404 Not Found"}', { status: 404 });
    }));

    openPanel();
    fireEvent.click(screen.getByRole('button', { name: '从最近活动选择' }));
    await waitFor(() => expect(panel()).toHaveTextContent('最近活动列表读取失败'));
    expect(panel()).toHaveTextContent('401');
    expect(panel()).toHaveTextContent('可以直接把 MR 链接粘到上面的输入框');
  });

  it('leaves a single-MR review exactly as before when no reference is attached', async () => {
    const calls = stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^参考 MR/ })).toHaveTextContent('未附加');

    await runReview();
    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('参考变更');
    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
    expect(calls.some((call) => call.url.startsWith('https://other.test'))).toBe(false);
  });
});
