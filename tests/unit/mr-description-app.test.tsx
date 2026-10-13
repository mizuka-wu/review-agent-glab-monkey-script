import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import type { PageContext } from '../../src/core/types';

const page: PageContext = {
  origin: 'https://gitlab.test', route: 'diff', projectPath: 'acme/app',
  projectNumericId: 42, mergeRequestIid: 248,
};

const DESCRIPTION = '## 需求\n支付失败必须给出可操作的错误提示。\n\n- 密钥不能进日志\n- 重试最多 3 次';

const currentDiff = {
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  new_file: false, deleted_file: false, renamed_file: false,
  diff: ['@@ -1,2 +1,4 @@ export function pay() {', ' export function pay() {', '+  const apiKey = "sk-live-123";', '+  return charge(apiKey);', ' }'].join('\n'),
};

const modelFindings = JSON.stringify({
  findings: [{
    title: '硬编码 API Key 应移至安全配置', severity: 'high', category: 'security', confidence: 'high',
    path: 'src/payment.ts', line: 2, endLine: 2, side: 'new', existingCode: 'const apiKey = "sk-live-123";',
    content: '新增赋值涉及密码、Token 或 API Key，应从安全配置读取。',
    evidence: [{ path: 'src/payment.ts', lines: 'L2', quote: 'const apiKey = "sk-live-123";' }],
    comment: '发现硬编码 API Key，应从安全配置读取。',
  }],
});

// 说明段出厂默认不进上下文：这里显式打开，验的是「打开后」的全链路行为
const HYBRID = {
  provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
  reviewMode: 'hybrid', gitlabToken: 'glpat-test', language: 'zh-CN', effort: 'balanced',
  includeMrDescription: true,
};

interface Call { url: string; method: string; body: string }

function stubNetwork(description: string | null = DESCRIPTION): Call[] {
  const calls: Call[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '' });

    if (url.startsWith('https://model.test')) {
      return json({
        id: 'c1', object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: modelFindings }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    if (url.includes('/discussions')) return json([]);
    if (url.includes('/merge_requests/248/diffs')) return json([currentDiff]);
    if (url.includes('/merge_requests/248')) {
      return json({
        title: 'Harden checkout payment error handling', description, state: 'opened',
        source_branch: 'feature/payment', target_branch: 'main', sha: 'head-sha',
        diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha', start_sha: 'start-sha' },
      });
    }
    return json({ message: '404 Not Found' });
  }));
  return calls;
}

/** 只取评审那一次调用：反思模块也打同一个端点，但 system prompt 不同。 */
function reviewPrompts(calls: Call[]): string[] {
  return calls
    .filter((call) => call.url.includes('/chat/completions'))
    .map((call) => decodeURIComponent(call.body))
    .filter((body) => body.includes('你是代码评审引擎'));
}

async function runReview() {
  fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
  await waitFor(() => expect(screen.getByText(/个问题/)).toBeInTheDocument(), { timeout: 8000 });
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  localStorage.setItem('review-agent-settings-v1', JSON.stringify(HYBRID));
  localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
  return render(<App page={page} />);
}

describe('MR description in the app review flow', () => {
  it('sends the MR description to the model as requirement background', async () => {
    const calls = stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());

    await runReview();

    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## MR 说明（提交者写的需求背景，用来判断实现是否符合意图）');
    expect(prompts[0]).toContain('支付失败必须给出可操作的错误提示');
    expect(prompts[0]).toContain('重试最多 3 次');
    expect(prompts[0]).toContain('src/payment.ts');
    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
  });

  it('leaves the description block out for a title-only MR', async () => {
    const calls = stubNetwork(null);
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());

    await runReview();

    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('MR 说明');
    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
  });
});
