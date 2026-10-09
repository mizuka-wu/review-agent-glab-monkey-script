import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bundlePath = resolve(process.cwd(), 'dist/review-agent-glab-monkey-script.user.js');
const bundle = readFileSync(bundlePath, 'utf8');

// --- 真实 GitLab 模式配置 ---
// 设置 GITLAB_URL + GITLAB_PAT + GITLAB_MR_URL 即可测试真实 GitLab MR
// 示例:
//   GITLAB_URL=http://127.0.0.1:8929 \
//   GITLAB_PAT=glpat-xxx \
//   GITLAB_MR_URL=http://127.0.0.1:8929/acme/app/-/merge_requests/1/diffs \
//   pnpm test:e2e

const realGitlabUrl = process.env.GITLAB_URL || '';
const modelBaseUrl = process.env.MODEL_BASE_URL || 'http://localhost:8000/v1';
const modelName = process.env.MODEL_NAME || 'qwen35-a3b';
const modelApiKey = process.env.MODEL_API_KEY || '';
const realMrUrl = process.env.GITLAB_MR_URL || '';
const gitlabUser = process.env.GITLAB_USER || 'root';
const gitlabPass = process.env.GITLAB_PASS || '5iveRage';
const gitlabPat = process.env.GITLAB_PAT || '';
const isRealGitlab = Boolean(realGitlabUrl && realMrUrl);
/** 真实 MR 的项目路径与 iid：发布测试要用 REST API 清理自己发出去的评论。 */
const realMrRef = /^(?:https?:\/\/[^/]+)?\/(?<project>.+)\/-\/merge_requests\/(?<iid>\d+)/.exec(realMrUrl)?.groups;
const realMrApi = `${realGitlabUrl}/api/v4/projects/${encodeURIComponent(realMrRef?.project ?? '')}/merge_requests/${realMrRef?.iid ?? ''}`;

// --- Mock 模式数据 ---

const mockHtml = `<!doctype html>
<html><head><meta name="csrf-token" content="csrf-test"></head>
<body data-page="projects:merge_requests:show">
  <div class="diff-file" data-file-path="src/payment.ts">
    <div class="file-title-name">src/payment.ts</div>
    <div class="line_holder" data-line-number="1"><code class="ra-line-code">const apiKey = "sk-live-123";</code></div>
    <div class="line_holder" data-line-number="2"><code class="ra-line-code">console.log(apiKey);</code></div>
    <div class="line_holder" data-line-number="3"><code class="ra-line-code">return handle(error as any);</code></div>
  </div>
</body></html>`;

const mergeRequest = {
  title: 'Harden checkout payment error handling',
  state: 'opened',
  source_branch: 'feature/payment',
  target_branch: 'main',
  sha: 'head-sha',
  diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha', start_sha: 'start-sha' },
};

const repoFiles: Record<string, string> = {
  'src/auth.ts': 'export function verifyToken(token: string) {\n  return token.length > 0;\n}\n',
  'src/handler.ts': 'import { verifyToken } from "./auth";\nexport function handler() {\n  return verifyToken("x");\n}\n',
};

const diff = {
  old_path: 'src/payment.ts',
  new_path: 'src/payment.ts',
  diff: [
    '@@ -1,2 +1,4 @@ export function pay() {',
    ' export function pay() {',
    '+  const apiKey = "sk-live-123";',
    '+  console.log(apiKey);',
    '+  return handle(error as any);',
    ' }',
  ].join('\n'),
  new_file: false,
  deleted_file: false,
  renamed_file: false,
};

// --- Mock：另一个 GitLab 实例上的配套 MR（跨项目 / 跨 origin 的参考变更）---

const companionHost = 'https://companion.test';
const companionMrUrl = `${companionHost}/platform/sdk/-/merge_requests/12`;
const companionLabel = 'platform/sdk!12';

const companionMergeRequest = {
  title: 'feat: companion token endpoint',
  state: 'opened',
  source_branch: 'feat/token',
  target_branch: 'main',
  sha: 'companion-head',
  diff_refs: { base_sha: 'c-base', head_sha: 'c0ffee1234567890', start_sha: 'c-base' },
};

const companionDiff = {
  old_path: 'src/companion.ts',
  new_path: 'src/companion.ts',
  new_file: true,
  deleted_file: false,
  renamed_file: false,
  diff: '@@ -0,0 +1,2 @@\n+export const COMPANION_TOKEN = "tk_companion";\n+export function companionPing() { return "pong"; }',
};

/** 模型对参考变更也报一条：参考 MR 不是评审对象，这条必须被丢掉。 */
const companionFinding = {
  title: '参考仓库里的 Token 也写死了', severity: 'high', category: 'security', confidence: 'high',
  path: 'src/companion.ts', line: 1, endLine: 1, existingCode: 'export const COMPANION_TOKEN = "tk_companion";',
  content: '参考 MR 的 companion.ts 把 Token 直接写进了源文件。',
  evidence: [{ path: 'src/companion.ts', line: 1, snippet: 'export const COMPANION_TOKEN = "tk_companion";' }],
  comment: '参考 MR 里有硬编码 Token。',
};

/**
 * 参考 MR 在另一个 origin 上：油猴里 GM.xmlHttpRequest 不受 CORS 限制，
 * E2E 是把脚本注入主世界走 fetch，所以 mock 响应要自己带上 CORS 头。
 */
async function routeCompanion(page: Page, requests: string[] = [], options?: { status?: number }) {
  await page.route(`${companionHost}/**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.host}${url.pathname}`);
    const status = options?.status ?? 200;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    const body = status === 200
      ? url.pathname.endsWith('/diffs') ? [companionDiff] : companionMergeRequest
      : { message: `${status} Not Found` };
    await route.fulfill({ status, headers, body: JSON.stringify(body) });
  });
}

// --- Mock 路由 ---

async function routeGitLab(page: Page, requests: string[] = [], options?: { stream?: boolean; delayMs?: number; modelStatus?: number; rejectPosition?: boolean; diffs?: unknown[]; extraFindings?: unknown[]; recentMrs?: unknown[] }) {
  // Mock model API
  await page.route('https://model.test/**', async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    const body = {
      id: 'mock-completion',
      object: 'chat.completion',
      model: 'test-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify([
            {
              title: '硬编码 API Key 应移至安全配置',
              severity: 'high',
              category: 'security',
              confidence: 'high',
              path: 'src/payment.ts',
              line: 2,
              endLine: 2,
              existingCode: 'const apiKey = "sk-live-123";',
              suggestion: '从环境变量或密钥管理服务读取',
              reason: '新增赋值涉及密码、Token 或 API Key',
              content: '新增赋值涉及密码、Token 或 API Key。应从安全配置或密钥管理服务读取，并确认该值没有进入日志和构建产物。',
              evidence: [{ path: 'src/payment.ts', line: 2, snippet: 'const apiKey = "sk-live-123";' }],
              comment: '发现硬编码 API Key，应从安全配置或密钥管理服务读取。',
            },
            {
              title: '调试日志可能泄漏运行时变量',
              severity: 'low',
              category: 'maintainability',
              confidence: 'medium',
              path: 'src/payment.ts',
              line: 3,
              endLine: 3,
              existingCode: 'console.log(apiKey);',
              suggestion: '移除调试日志',
              reason: '日志输出敏感变量',
              content: 'console.log 输出了 apiKey 变量，可能在生产环境泄漏敏感信息。',
              evidence: [{ path: 'src/payment.ts', line: 3, snippet: 'console.log(apiKey);' }],
              comment: 'console.log 可能泄漏 API Key。',
            },
            ...(options?.extraFindings ?? []),
          ]),
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
    if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options?.modelStatus) {
      await route.fulfill({ status: options.modelStatus, contentType: 'application/json', body: JSON.stringify({ error: { message: 'model not found' } }) });
      return;
    }
    const content = body.choices[0].message.content as string;
    if (options?.stream && (route.request().postData() ?? '').includes('"stream":true')) {
      const step = Math.max(1, Math.floor(content.length / 3));
      const parts = [content.slice(0, step), content.slice(step, step * 2), content.slice(step * 2)];
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先检查新增行是否涉及敏感信息…' } }] })}\n\n`
        + parts.map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
      await route.fulfill({ contentType: 'text/event-stream', body: sse });
      return;
    }
    await route.fulfill({ json: body });
  });
  await page.route('https://gitlab.test/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (route.request().resourceType() === 'document') {
      await route.fulfill({ contentType: 'text/html', body: mockHtml });
      return;
    }
    if (url.pathname === '/api/v4/merge_requests') {
      await route.fulfill({ json: options?.recentMrs ?? [] });
      return;
    }
    if (url.pathname.startsWith('/api/v4/projects/') && url.pathname.endsWith('/merge_requests/248/diffs')) {
      await route.fulfill({ json: options?.diffs ?? [diff] });
      return;
    }
    if (url.pathname.startsWith('/api/v4/projects/') && url.pathname.endsWith('/merge_requests/248')) {
      await route.fulfill({ json: mergeRequest });
      return;
    }
    if (url.pathname.endsWith('/repository/tree')) {
      await route.fulfill({ json: Object.keys(repoFiles).map((path) => ({ path, type: 'blob' })) });
      return;
    }
    if (url.pathname.includes('/repository/files/') && url.pathname.endsWith('/raw')) {
      const path = decodeURIComponent(url.pathname.split('/repository/files/')[1].split('/raw')[0]);
      if (path in repoFiles) {
        await route.fulfill({ contentType: 'text/plain', body: repoFiles[path] });
        return;
      }
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    if (url.pathname.endsWith('/discussions') && route.request().method() === 'GET') {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname.endsWith('/discussions') && route.request().method() === 'POST') {
      if (options?.rejectPosition && (route.request().postData() ?? '').includes('position%5B')) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'position is invalid' }) });
        return;
      }
      await route.fulfill({ json: { id: 'discussion-1', notes: [{ id: 'note-1' }] } });
      return;
    }
    if (url.pathname.endsWith('/approve') && route.request().method() === 'POST') {
      await route.fulfill({ json: { id: 1 } });
      return;
    }
    if (url.pathname.endsWith('/notes') && route.request().method() === 'POST') {
      await route.fulfill({ json: { id: 99 } });
      return;
    }
    await route.fulfill({ status: 404, body: 'not found' });
  });
}

// --- 通用辅助 ---

async function mountUserscript(page: Page, url: string, settings?: Record<string, unknown>) {
  if (settings) {
    await page.addInitScript({
      content: `localStorage.setItem('review-agent-settings-v1', ${JSON.stringify(JSON.stringify(settings))});`,
    });
  } else {
    await page.addInitScript({
      content: `localStorage.removeItem('review-agent-settings-v1');`,
    });
  }
  await page.goto(url);
  // Inject after page load so DOM is ready
  await page.addScriptTag({ content: bundle });
}

// --- 测试 ---

test.describe('mock mode', () => {
  test.skip(isRealGitlab, '跳过 mock 测试（已设置 GITLAB_URL）');

  test('loads diff, runs rule review, and publishes a confirmed discussion', async ({ page }) => {
    const requests: string[] = [];
    await routeGitLab(page, requests);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await expect(page.getByText('Harden checkout payment error handling')).toBeVisible();
    await page.getByRole('button', { name: '开始 Review' }).click();

    await expect(page.getByText('硬编码 API Key 应移至安全配置')).toBeVisible();
    await expect(page.getByText('调试日志可能泄漏运行时变量')).toBeVisible();

    const finding = page.locator('article').filter({ hasText: '硬编码 API Key 应移至安全配置' });
    await expect(finding.getByText('行内 L2')).toBeVisible();
    await finding.getByRole('button', { name: '行内评论' }).click();
    await expect(page.getByRole('dialog', { name: '发布行内评论' })).toBeVisible();
    await page.getByLabel('评论内容').fill('Edited review comment');

    const discussionRequest = page.waitForRequest((request) =>
      request.url().endsWith('/discussions') && request.method() === 'POST');
    await page.getByRole('button', { name: '确认行内评论' }).click();
    const request = await discussionRequest;
    expect(request.postData()).toContain('body=Edited+review+comment');
    expect(request.postData()).toContain('position%5Bhead_sha%5D=head-sha');
    await expect(page.getByText('行级 Discussion 已发布')).toBeVisible();
    expect(requests.some((path) => path.endsWith('/diffs'))).toBe(true);
  });

  test('degrades to a full-text comment when GitLab rejects the inline position', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/discussions') && request.method() === 'POST') posts.push(request.postData() ?? '');
    });
    await routeGitLab(page, [], { rejectPosition: true });
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText('硬编码 API Key 应移至安全配置')).toBeVisible({ timeout: 15000 });

    const finding = page.locator('article').filter({ hasText: '硬编码 API Key 应移至安全配置' });
    await finding.getByRole('button', { name: '行内评论' }).click();
    await page.getByRole('button', { name: '确认行内评论' }).click();

    await expect(page.getByText('行内不可用，已改为全文评论')).toBeVisible({ timeout: 15000 });
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain('position%5Bnew_line%5D=2');
    expect(posts[1]).not.toContain('position');
    expect(decodeURIComponent(posts[1])).toContain('src/payment.ts:2');
    await expect(finding.getByRole('button', { name: '已发布', exact: true })).toBeVisible();
  });

  test('runs rule-only review without an API key and shows the setup hint', async ({ page }) => {
    const requests: string[] = [];
    await routeGitLab(page, requests);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN', reviewMode: 'hybrid',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();

    // 未配置提示
    await expect(page.getByText('未配置模型 API Key')).toBeVisible();
    await expect(page.getByRole('button', { name: '先跑规则检查' })).toBeVisible();

    await page.getByRole('button', { name: '开始 Review' }).click();

    // 规则命中：硬编码密钥 + console.log + as any
    await expect(page.locator('article[data-finding-source="rule"]').first()).toBeVisible();
    await expect(page.getByText('代码中疑似硬编码敏感信息').first()).toBeVisible();
    await expect(page.getByText('AI 未运行')).toBeVisible();

    // 模型接口不应该被调用
    expect(requests.some((path) => path.includes('chat/completions'))).toBe(false);

    // 规则来源标签可见
    await expect(page.getByRole('button', { name: /规则 \d+/ })).toBeVisible();
  });

  test('captures selection and opens chat with attachment', async ({ page }) => {
    await routeGitLab(page);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await expect(page.getByText('Harden checkout payment error handling')).toBeVisible();

    // Simulate code selection
    await page.locator('[data-line-number="1"] .ra-line-code').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element.firstChild ?? element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // Verify selection toolbar appears
    await expect(page.getByRole('toolbar', { name: '代码选区操作' })).toBeVisible();

    // Click "问一下" to open chat with attachment
    await page.getByRole('button', { name: '问一下' }).click();
    // 会话附件用「文件名:行号」引用；页面 DOM 读不到行号时会显示「行号未知」而不是编造行号。
    const attachmentChip = page.locator('div:has(> button[aria-label="移除代码附件"]) > span');
    await expect(attachmentChip).toHaveText('payment.ts:1');

    // Verify composer is available
    await expect(page.getByLabel('消息输入框')).toBeVisible();
  });

  test('builds a local repo index and answers symbol search + call chain', async ({ page }) => {
    await routeGitLab(page);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
      repoIndex: { enabled: true, maxFiles: 50, maxBytes: 1048576 }, repoContext: true,
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('tab', { name: /索引/ }).click();
    await page.getByRole('button', { name: '建立索引' }).click();

    await expect(page.getByText('已就绪')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('OPFS', { exact: false }).first()).toBeVisible();

    await page.getByLabel('符号搜索').fill('verify');
    await expect(page.getByRole('button', { name: /verifyToken/ })).toBeVisible();
    await page.getByRole('button', { name: /verifyToken/ }).first().click();
    await expect(page.getByText(/调用链（向上 2 层/)).toBeVisible();
    await expect(page.getByText(/handler/).first()).toBeVisible();

    // 注册表：按 branch 记录，标记当前 head，可单独删除
    await expect(page.getByText('已缓存索引')).toBeVisible();
    await expect(page.getByText('feature/payment')).toBeVisible();
    await expect(page.getByText('当前 head')).toBeVisible();

    // 全文件扫描（仅规则）：结果进入结果页，发布时降级为全文评论
    await page.getByRole('button', { name: '扫描已索引文件' }).click();
    await expect(page.getByText(/扫描完成：2 个文件/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('扫描模式（全文件规则扫描）')).toBeVisible({ timeout: 10000 });
    await page.getByRole('tab', { name: /索引/ }).click();
    await page.getByRole('button', { name: '删除索引 feature/payment' }).click();
    await expect(page.getByText('还没有缓存')).toBeVisible();
  });

  test('quick actions publish inline comments, summary note and approve', async ({ page }) => {
    const requests: string[] = [];
    await routeGitLab(page, requests);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs');
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText(/个问题/)).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /一键行内评论/ }).click();
    await page.getByRole('button', { name: '确认发布？' }).first().click();
    await expect(page.getByText(/已发布 \d+ 条行内评论/)).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: '总评论', exact: true }).click();
    await page.getByRole('button', { name: '确认发布？' }).first().click();
    await expect(page.getByText('总评论已发布')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: '一键 Approve' }).click();
    await page.getByRole('button', { name: '确认 Approve？' }).click();
    await expect(page.getByText('已 Approve 该 MR')).toBeVisible({ timeout: 15000 });

    expect(requests.some((path) => path.endsWith('/discussions'))).toBe(true);
    expect(requests.some((path) => path.endsWith('/notes'))).toBe(true);
    expect(requests.some((path) => path.endsWith('/approve'))).toBe(true);
  });

  test('keeps one-click approve after a review that found nothing', async ({ page }) => {
    const requests: string[] = [];
    // 换成不命中任何内置规则的干净变更：Review 完成后是 0 findings 的空态
    await routeGitLab(page, requests, { diffs: [{
      old_path: 'src/payment.test.ts', new_path: 'src/payment.test.ts',
      new_file: false, deleted_file: false, renamed_file: false,
      diff: [
        '@@ -1,4 +1,5 @@ describe("orderTotal", () => {',
        ' describe("orderTotal", () => {',
        '+  const items = [{ price: 2 }, { price: 3 }];',
        '   it("sums the item prices", () => {',
        '     expect(orderTotal(items)).toBe(5);',
      ].join('\n'),
    }] });
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs');
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('button', { name: '开始 Review' }).click();

    // 0 findings 的空态以前会把整条底部工具栏一起带走，Approve 就此消失
    await expect(page.getByText('没有发现需要处理的问题')).toBeVisible({ timeout: 15000 });
    const bar = page.getByRole('toolbar', { name: '评审快捷操作' });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: '总评论' })).toBeDisabled();

    await bar.getByRole('button', { name: '一键 Approve' }).click();
    await bar.getByRole('button', { name: '确认 Approve？' }).click();
    await expect(page.getByText('已 Approve 该 MR')).toBeVisible({ timeout: 15000 });
    expect(requests.some((path) => path.endsWith('/approve'))).toBe(true);
  });

  test('returns to the prompt input state after a finished review', async ({ page }) => {
    await routeGitLab(page);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    const prompt = page.getByRole('textbox', { name: '项目补充要求' });
    await expect(prompt).toBeVisible();
    await prompt.fill('金额计算必须用 decimal');

    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText('硬编码 API Key 应移至安全配置').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('article[data-finding-source]')).not.toHaveCount(0);

    // 底部结果面板的复位入口：清掉本轮结果，回到可输入的初始态
    await page.getByRole('toolbar', { name: '评审快捷操作' })
      .getByRole('button', { name: '重新开始' }).click();
    await expect(page.getByText('开始一次混合评审')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('article[data-finding-source]')).toHaveCount(0);
    await expect(prompt).toBeEditable();
    await expect(prompt).toBeFocused();
    // prompt 属于设置，不在复位范围内
    await expect(prompt).toHaveValue('金额计算必须用 decimal');

    // 顶部动作栏的复位入口与底部同一个函数：再跑一轮，从顶部回去
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText('硬编码 API Key 应移至安全配置').first()).toBeVisible({ timeout: 15000 });
    await page.getByRole('toolbar', { name: 'Review 操作' })
      .getByRole('button', { name: '重新开始' }).click();
    await expect(page.getByText('开始一次混合评审')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('article[data-finding-source]')).toHaveCount(0);
    await expect(prompt).toBeFocused();
  });

  test('streams model review output live into the panel', async ({ page }) => {
    const requests: string[] = [];
    await routeGitLab(page, requests, { stream: true });
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN', debugEnabled: true,
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText('硬编码 API Key 应移至安全配置').first()).toBeVisible({ timeout: 15000 });
    // SSE 流式路径应被调试面板记录（url 带 (stream) 后缀）
    const panel = page.locator('aside[aria-label="Review Agent"]');
    await page.getByRole('tab', { name: /调试/ }).click();
    await page.getByRole('button', { name: /网络 \d+/ }).click();
    await expect(panel.getByText(/chat\/completions \(stream\)/).first()).toBeVisible({ timeout: 10000 });
  });

  test('can stop a running review while the model stream is in flight', async ({ page }) => {
    const requests: string[] = [];
    await routeGitLab(page, requests, { delayMs: 4000 });
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText('Review 进行中')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '取消' }).first().click();
    await expect(page.getByText('已取消')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('模型分析已停止；已完成的规则结果仍保留并可发布。')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: '开始 Review' })).toBeVisible({ timeout: 10000 });
  });

  test('shows a visible banner when the model endpoint fails', async ({ page }) => {
    const requests: string[] = [];
    await routeGitLab(page, requests, { modelStatus: 404 });
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'missing-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText('AI 评审未运行', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/模型服务返回 HTTP 404/).first()).toBeVisible({ timeout: 10000 });
    // 规则结果不受模型失败影响
    await expect(page.getByText(/个问题/)).toBeVisible({ timeout: 10000 });
  });

  test('auto-switches to an available model when the current one is missing and persists it', async ({ page }) => {
    await routeGitLab(page);
    await page.route('http://localhost:9999/v1/models', (route) => route.fulfill({
      json: { data: [{ id: 'qwen35-a3b' }, { id: 'qwen38-27b' }] },
    }));
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'http://localhost:9999/v1', model: 'gpt-4o-mini', apiKey: '',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('tab', { name: /设置/ }).click();
    await expect(page.getByText(/已自动切换到 qwen35-a3b/)).toBeVisible({ timeout: 10000 });
    const stored = await page.evaluate(() => (JSON.parse(localStorage.getItem('review-agent-settings-v1') ?? '{}') as { model?: string }).model);
    expect(stored).toBe('qwen35-a3b');
  });

  test('hides the selection toolbar for selections inside the panel', async ({ page }) => {
    await routeGitLab(page);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs');
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    // 页内 diff 选区 → 工具条出现（拖拽选区比 dblclick 在各环境更稳定）
    const code = page.locator('code.ra-line-code').first();
    const lineBox = (await code.boundingBox())!;
    const selectLine = async () => {
      await page.mouse.move(lineBox.x + 1, lineBox.y + lineBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(lineBox.x + lineBox.width - 1, lineBox.y + lineBox.height / 2, { steps: 6 });
      await page.mouse.up();
    };
    await selectLine();
    try {
      await expect(page.getByRole('toolbar', { name: '代码选区操作' })).toBeVisible({ timeout: 4000 });
    } catch {
      await selectLine();
      await expect(page.getByRole('toolbar', { name: '代码选区操作' })).toBeVisible({ timeout: 8000 });
    }
    // 面板内选区（对话输入框）→ 工具条隐藏
    await page.getByRole('tab', { name: /对话/ }).click();
    const box = page.getByLabel('消息输入框');
    await box.click();
    await box.fill('hello world selection');
    await box.dblclick();
    await expect(page.getByRole('toolbar', { name: '代码选区操作' })).toHaveCount(0, { timeout: 10000 });
  });

  test('injects a per-project supplementary system prompt into hybrid review', async ({ page }) => {
    const requests: string[] = [];
    await routeGitLab(page, requests, { stream: true });
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN', debugEnabled: true, projectPrompts: {},
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    const promptBox = page.getByPlaceholder(/可选：本项目评审的额外约束/);
    await promptBox.fill('禁止报告命名风格问题');
    const stored = await page.evaluate(() => (JSON.parse(localStorage.getItem('review-agent-settings-v1') ?? '{}') as { projectPrompts?: Record<string, string> }).projectPrompts);
    expect(stored?.['acme/app']).toBe('禁止报告命名风格问题');
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText('硬编码 API Key 应移至安全配置').first()).toBeVisible({ timeout: 15000 });
    const panel = page.locator('aside[aria-label="Review Agent"]');
    await page.getByRole('tab', { name: /调试/ }).click();
    await page.getByRole('button', { name: /提示词 \d+/ }).click();
    await panel.getByText(/条消息 · 响应/).first().click();
    await expect(panel.getByText('禁止报告命名风格问题').first()).toBeVisible({ timeout: 10000 });
  });

  test('session viewer replays findings, marks fixed and hides handled', async ({ page }) => {
    await routeGitLab(page);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs');
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText(/个问题/)).toBeVisible({ timeout: 15000 });

    await page.locator('article').first().getByRole('button', { name: '忽略' }).click();
    await page.getByRole('button', { name: '回放' }).click();
    const dialog = page.getByRole('dialog', { name: '会话回放' });
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(dialog.getByText('已忽略').first()).toBeVisible({ timeout: 10000 });

    await dialog.getByRole('switch').click();
    await expect(dialog.getByText('已忽略')).toHaveCount(0);
    await dialog.getByRole('switch').click();

    await dialog.getByRole('button', { name: '标记已修复' }).first().click();
    await expect(dialog.getByText('已修复').first()).toBeVisible({ timeout: 10000 });

    await dialog.getByRole('button', { name: '恢复为当前会话' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('article').first().getByText('已修复')).toBeVisible({ timeout: 10000 });
  });

  // --- 参考 MR：其他 MR 只作为只读上下文拼进当前这次评审 ---

  const referencePanel = (page: Page) => page.getByRole('region', { name: '参考 MR' });

  async function openReferencePanel(page: Page) {
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('button', { name: /^参考 MR/ }).click();
    await expect(referencePanel(page).getByLabel('参考 MR 链接')).toBeVisible();
  }

  const RULES_ONLY_SETTINGS = {
    provider: 'openai', modelBaseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '',
    gitlabToken: '', effort: 'balanced', language: 'zh-CN', reviewMode: 'hybrid',
  };

  test('splices a pasted reference MR into the review input and keeps publishing on the current MR', async ({ page }) => {
    const requests: string[] = [];
    const modelBodies: string[] = [];
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url());
      if (request.url().includes('/chat/completions')) modelBodies.push(request.postData() ?? '');
    });
    await routeCompanion(page, requests);
    await routeGitLab(page, requests, { extraFindings: [companionFinding] });
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await openReferencePanel(page);
    const panel = referencePanel(page);

    await panel.getByLabel('参考 MR 链接').fill(
      `${companionMrUrl}\nhttps://gitlab.test/acme/app/-/merge_requests/248/diffs`,
    );
    await panel.getByRole('button', { name: '解析并拉取' }).click();
    await expect(panel.getByText('已就绪', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText(companionLabel)).toBeVisible();
    await expect(panel.getByText('1 个变更文件 · head c0ffee12')).toBeVisible();
    // 当前 MR 自己不能当参考，原因要点名
    await expect(panel.getByText('这就是当前正在评审的 MR，不需要当参考')).toBeVisible();
    expect(requests.some((entry) => entry === 'GET companion.test/api/v4/projects/platform%2Fsdk/merge_requests/12/diffs')).toBe(true);

    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText('硬编码 API Key 应移至安全配置').first()).toBeVisible({ timeout: 15000 });

    // 参考块进了那一次评审调用（模型 prompt 里能看到参考 diff）
    const reviewPrompt = modelBodies.find((body) => body.includes('你是代码评审引擎')) ?? '';
    expect(reviewPrompt).toContain('参考变更：其他 MR（只读上下文，不是评审对象）');
    expect(reviewPrompt).toContain(companionLabel);
    expect(reviewPrompt).toContain('COMPANION_TOKEN');

    // 参考 MR 不产出 Finding，运行说明里如实写明
    await expect(page.getByText('参考仓库里的 Token 也写死了')).toHaveCount(0);
    await page.getByRole('button', { name: '运行说明' }).click();
    await expect(page.getByText(/已注入 1 个参考 MR/)).toBeVisible();
    await expect(page.getByText(/丢弃了 1 条落在参考 MR 上的 AI Finding/)).toBeVisible();

    // 发布链路完全没变：一键发布全部 Finding，落点仍然只有当前 MR
    const quickBar = page.getByRole('toolbar', { name: '评审快捷操作' });
    const firstPost = page.waitForResponse(
      (response) => response.url().endsWith('/discussions') && response.request().method() === 'POST',
      { timeout: 30000 },
    );
    await quickBar.getByRole('button', { name: /^一键(行内评论|全文评论|发布)/ }).click();
    await quickBar.getByRole('button', { name: '确认发布？' }).click();
    const response = await firstPost;
    expect(response.request().postData()).toContain('position%5Bhead_sha%5D=head-sha');
    await expect(page.getByRole('button', { name: '已发布', exact: true }).first()).toBeVisible({ timeout: 30000 });

    // 项目标识可能是数字 id 或编码路径，但 host 与 MR 必须永远是当前这一个
    const currentMrDiscussions = /^https:\/\/gitlab\.test\/api\/v4\/projects\/(?:42|acme%2Fapp)\/merge_requests\/248\/discussions$/;
    const discussionPosts = posts.filter((url) => url.endsWith('/discussions'));
    expect(discussionPosts.length).toBeGreaterThan(1);
    for (const url of discussionPosts) expect(url).toMatch(currentMrDiscussions);
    // 参考 MR 那边一个写请求都没有
    expect(posts.filter((url) => url.startsWith(companionHost))).toEqual([]);
    expect(requests.filter((entry) => entry.startsWith('POST companion.test'))).toEqual([]);
  });

  test('reports which reference MR could not be fetched and why', async ({ page }) => {
    const requests: string[] = [];
    await routeCompanion(page, requests, { status: 404 });
    await routeGitLab(page, requests);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', RULES_ONLY_SETTINGS);
    await openReferencePanel(page);
    const panel = referencePanel(page);

    await panel.getByLabel('参考 MR 链接').fill(companionMrUrl);
    await panel.getByRole('button', { name: '解析并拉取' }).click();
    await expect(panel.getByText('拉取失败', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText(`找不到 ${companionLabel}（HTTP 404）：MR 不存在、被删除，或 Token 看不到该项目`)).toBeVisible();
    await expect(page.getByRole('button', { name: /^参考 MR/ })).toContainText('1 个失败');

    // 不是 MR 的链接也要逐条说明，不能静默丢掉
    await panel.getByLabel('参考 MR 链接').fill('https://gitlab.test/acme/app/-/issues/9 not-a-url');
    await panel.getByRole('button', { name: '解析并拉取' }).click();
    await expect(panel.getByText('2 个链接没有加进来')).toBeVisible();
    await expect(panel.getByText('不是 Merge Request 链接')).toBeVisible();
    await expect(panel.getByText('不是可解析的链接')).toBeVisible();

    // 失败会带进本轮评审的运行说明
    await page.getByRole('button', { name: '开始 Review' }).click();
    await expect(page.getByText(/个问题|没有发现需要处理的问题/).first()).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '运行说明' }).click();
    await expect(page.getByText(new RegExp(`参考 MR ${companionLabel.replace('/', '\\/')} 拉取失败`))).toBeVisible();
  });

  test('attaches a reference MR picked from local review history and GitLab recent activity', async ({ page }) => {
    const requests: string[] = [];
    await routeCompanion(page, requests);
    await routeGitLab(page, requests, {
      recentMrs: [
        {
          iid: 12, title: 'feat: companion token endpoint', state: 'opened', source_branch: 'feat/token',
          target_branch: 'main', updated_at: '2026-10-09T09:40:00.000Z', web_url: companionMrUrl,
        },
        {
          iid: 248, title: 'Harden checkout payment error handling', state: 'opened',
          updated_at: '2026-10-09T09:00:00.000Z', web_url: 'https://gitlab.test/acme/app/-/merge_requests/248',
        },
      ],
    });
    const sessions = {
      'ra-session-1': {
        version: 1, id: 'ra-session-1', key: 'k', origin: 'https://gitlab.test', projectPath: 'acme/legacy',
        mergeRequestIid: 77, headSha: 'sha', title: '上次评审过的 MR', scope: 'all', source: 'rule',
        status: 'completed', effort: 'balanced', language: 'zh-CN',
        createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-08T20:11:00.000Z',
        findings: [], warnings: [],
        context: { includedFiles: 1, omittedFiles: [], fullFiles: 0, omittedFullFiles: [], estimatedCharacters: 10, budgetCharacters: 60000 },
      },
    };
    await page.addInitScript({
      content: `localStorage.setItem('review-agent-review-sessions-v1', ${JSON.stringify(JSON.stringify(sessions))});`,
    });
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', RULES_ONLY_SETTINGS);
    await openReferencePanel(page);
    const panel = referencePanel(page);

    await panel.getByRole('button', { name: '从最近活动选择' }).click();
    await expect(panel.getByText('acme/legacy!77')).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText(companionLabel)).toBeVisible();
    // 当前 MR 不在候选里
    await expect(panel.getByText('acme/app!248')).toHaveCount(0);
    // 本地评审记录置顶
    const order = await panel.evaluate((node) => {
      const text = node.textContent ?? '';
      return [text.indexOf('本工具评审过的 MR'), text.indexOf('GitLab 最近活动')];
    });
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[0]).toBeLessThan(order[1]);
    expect(requests.some((entry) => entry.includes('scope=all'))).toBe(false);

    await panel.getByRole('checkbox', { name: `选择 ${companionLabel}` }).check();
    await expect(panel.getByText('已就绪', { exact: true })).toBeVisible({ timeout: 15000 });
    expect(requests.some((entry) => entry === 'GET companion.test/api/v4/projects/platform%2Fsdk/merge_requests/12/diffs')).toBe(true);

    await panel.getByRole('checkbox', { name: `选择 ${companionLabel}` }).uncheck();
    await expect(page.getByRole('button', { name: /^参考 MR/ })).toContainText('未附加');
  });

  test('recalls submitted prompts with the arrow keys and the history list', async ({ page }) => {
    const requests: string[] = [];
    await routeGitLab(page, requests);
    await mountUserscript(page, 'https://gitlab.test/acme/app/-/merge_requests/248/diffs', {
      provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await page.getByRole('tab', { name: /对话/ }).click();
    const box = page.getByLabel('消息输入框');
    await expect(box).toBeVisible();

    // 草稿被清空 = 这一轮真的发出去了（responding 时 Enter 会被忽略，不能靠文本判断）
    const sendPrompt = async (text: string) => {
      await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible({ timeout: 15000 });
      await box.fill(text);
      await box.press('Enter');
      await expect(box).toHaveValue('', { timeout: 15000 });
      await expect(page.getByText(text).first()).toBeVisible({ timeout: 15000 });
      // 等模型回完，responding 才会放下来
      await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible({ timeout: 15000 });
    };

    await sendPrompt('第一次提问：这段变更的失败路径');
    await sendPrompt('第二次提问：并发与幂等性怎么保证');

    // prompt 历史单独存一个键，不和 chat 会话存储混在一起
    const stored = await page.evaluate(() => ({
      prompts: JSON.parse(localStorage.getItem('review-agent-prompt-history-v1') ?? '[]') as string[],
      sessions: JSON.parse(localStorage.getItem('review-agent-chat-v1') ?? '[]') as unknown[],
    }));
    expect(stored.prompts).toEqual(['第二次提问：并发与幂等性怎么保证', '第一次提问：这段变更的失败路径']);
    expect(stored.sessions.length).toBeGreaterThan(0);

    await expect(box).toHaveValue('');
    await box.click();
    await box.press('ArrowUp');
    await expect(box).toHaveValue('第二次提问：并发与幂等性怎么保证');
    await box.press('ArrowUp');
    await expect(box).toHaveValue('第一次提问：这段变更的失败路径');
    await expect(page.getByText('历史 prompt 2/2')).toBeVisible();
    await box.press('ArrowDown');
    await expect(box).toHaveValue('第二次提问：并发与幂等性怎么保证');

    // 历史列表：点击填回输入框
    await page.getByRole('button', { name: '历史 prompt' }).click();
    const list = page.getByRole('listbox', { name: '历史 prompt 列表' });
    await expect(list.getByRole('option')).toHaveCount(2);
    await list.getByRole('option').nth(1).click();
    await expect(box).toHaveValue('第一次提问：这段变更的失败路径');

    // 也可以直接从历史里作为新一轮提交
    const sentBefore = requests.filter((path) => path.includes('chat/completions')).length;
    await page.getByRole('button', { name: '历史 prompt' }).click();
    await list.getByRole('button', { name: '直接发送这条 prompt' }).first().click();
    await expect.poll(() => requests.filter((path) => path.includes('chat/completions')).length, { timeout: 15000 })
      .toBeGreaterThan(sentBefore);
    await expect(box).toHaveValue('');
    // 直接发送也照样进历史：同一条不会重复占位
    await expect.poll(async () => page.evaluate(
      () => JSON.parse(localStorage.getItem('review-agent-prompt-history-v1') ?? '[]') as string[],
    )).toEqual(['第二次提问：并发与幂等性怎么保证', '第一次提问：这段变更的失败路径']);
  });

  test('userscript metadata is bundled and scoped to GitLab pages', async ({ page }) => {
    const metadata = bundle.slice(bundle.indexOf('// ==UserScript=='), bundle.indexOf('// ==/UserScript=='));
    expect(metadata).toContain('@name         Review Agent for GitLab');
    expect(metadata).toContain('@grant        GM.getValue');
    expect(metadata).toContain('@downloadURL');
    expect(metadata).toContain('@updateURL');

    await page.route('https://example.test/**', (route) => route.fulfill({ body: '<!doctype html><html><body>ordinary page</body></html>' }));
    await page.goto('https://example.test/docs');
    await page.addScriptTag({ content: bundle });
    await expect(page.locator('#review-agent-glab-root')).toHaveCount(0);

    await routeGitLab(page);
    await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs');
    await page.addScriptTag({ content: bundle });
    await page.getByRole('button', { name: '打开 Review Agent' }).click();
    await expect(page.getByRole('complementary', { name: 'Review Agent' })).toBeVisible();
  });
});

test.describe('real GitLab mode', () => {
  test.skip(!isRealGitlab, '跳过真实 GitLab 测试（未设置 GITLAB_URL + GITLAB_MR_URL）');

  async function loginToGitLab(page: Page, baseUrl: string) {
    // Check if already logged in
    await page.goto(`${baseUrl}/users/sign_in`);
    const signInForm = page.locator('input[name="user[login]"]');
    if (await signInForm.count() === 0) return;
    await signInForm.fill(gitlabUser);
    await page.locator('input[name="user[password]"]').fill(gitlabPass);
    await page.locator('button[type="submit"]').first().click();
    // 跳转有时在 waitForURL 挂上监听之前就完成了，改成在页面里轮询地址
    await page.waitForFunction(() => !window.location.pathname.includes('sign_in'), undefined, { timeout: 20000 });
    await page.waitForLoadState('domcontentloaded');
  }

  test('injects userscript and reads real MR data', async ({ page }) => {
    await loginToGitLab(page, realGitlabUrl);
    await mountUserscript(page, realMrUrl);
    await page.getByRole('button', { name: '打开 Review Agent' }).click({ timeout: 15000 });
    await expect(page.getByRole('complementary', { name: 'Review Agent' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/开始一次混合评审|当前页面没有可用的 MR Diff|正在读取 MR 数据/)).toBeVisible({ timeout: 15000 });
  });

  test('runs rule review on real MR diff', async ({ page }) => {
    await loginToGitLab(page, realGitlabUrl);
    await mountUserscript(page, realMrUrl);
    await page.getByRole('button', { name: '打开 Review Agent' }).click({ timeout: 15000 });
    await page.getByRole('button', { name: '开始 Review' }).click({ timeout: 15000 });
    await expect(page.getByText(/个问题|没有发现需要处理的问题|没有可用的 MR Diff/)).toBeVisible({ timeout: 30000 });
  });

  test('returns to the prompt input state after a finished real review', async ({ page }) => {
    test.setTimeout(240_000);
    await loginToGitLab(page, realGitlabUrl);
    await mountUserscript(page, realMrUrl);
    await page.getByRole('button', { name: '打开 Review Agent' }).click({ timeout: 20000 });
    const prompt = page.getByRole('textbox', { name: '项目补充要求' });
    await expect(prompt).toBeVisible({ timeout: 20000 });

    const runReview = async () => {
      await page.getByRole('button', { name: '开始 Review' }).click({ timeout: 20000 });
      await expect(page.getByRole('button', { name: 'Review 中', exact: true })).toBeHidden({ timeout: 120000 });
      await expect(page.getByText(/个问题|没有发现需要处理的问题|没有可用的 MR Diff/).first()).toBeVisible({ timeout: 20000 });
    };
    const assertBackToInput = async () => {
      await expect(page.getByText('开始一次混合评审')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('article[data-finding-source]')).toHaveCount(0);
      await expect(prompt).toBeEditable();
      await expect(prompt).toBeFocused();
    };

    await runReview();
    const bar = page.getByRole('toolbar', { name: '评审快捷操作' });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: '重新开始' }).click();
    await assertBackToInput();

    await runReview();
    await page.getByRole('toolbar', { name: 'Review 操作' })
      .getByRole('button', { name: '重新开始' }).click();
    await assertBackToInput();
  });

  // --- 底部工具栏：Approve 常驻 + 整排控件横向可滚（不把横向滚动推给页面）---

  /** 面板收到最小宽度：控件一定溢出，才能验证底部栏是自己横滑而不是撑破布局。 */
  async function useNarrowPanel(page: Page) {
    const prefs = { width: 380, top: 72, right: 16, open: false, hintDismissed: true };
    await page.addInitScript({
      content: `localStorage.setItem('review-agent-ui-v1', ${JSON.stringify(JSON.stringify(prefs))});`,
    });
  }

  /** Approve 用完就撤：真实 MR 不能留下测试的批准记录。API 的非 GET 走 cookie 会话时要带 CSRF。 */
  async function setApproved(page: Page, approved: boolean) {
    const csrf = await page.evaluate(
      () => document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '',
    ).catch(() => '');
    const headers: Record<string, string> = {};
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (gitlabPat) headers['PRIVATE-TOKEN'] = gitlabPat;
    const response = await page.request
      .post(`${realMrApi}/${approved ? 'approve' : 'unapprove'}`, { headers })
      .catch(() => undefined);
    return response?.status();
  }

  const pageHOverflow = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  test('keeps the bottom bar scrollable and approves the real MR from it', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(!realMrRef, 'GITLAB_MR_URL 不是可解析的 MR 地址');
    await loginToGitLab(page, realGitlabUrl);
    await useNarrowPanel(page);
    await mountUserscript(page, realMrUrl);
    const baselineOverflow = await pageHOverflow(page);

    // 上一轮留下的批准会让 POST /approve 直接失败，先复位（未批准时返回 404，忽略）
    await setApproved(page, false);

    await page.getByRole('button', { name: '打开 Review Agent' }).click({ timeout: 20000 });
    const panel = page.locator('aside[aria-label="Review Agent"]');
    await expect(panel).toHaveCSS('width', '380px');

    await page.getByRole('button', { name: '开始 Review' }).click({ timeout: 20000 });
    await expect(page.getByRole('button', { name: 'Review 中', exact: true })).toBeHidden({ timeout: 120000 });
    await expect(page.getByText(/个问题|没有发现需要处理的问题|没有可用的 MR Diff/).first()).toBeVisible({ timeout: 20000 });

    // Review 结束后底部工具栏必须还在，且一键 Approve 可点（有 MR 引用就够）
    const bar = page.getByRole('toolbar', { name: '评审快捷操作' });
    await expect(bar).toBeVisible();
    const approve = bar.getByRole('button', { name: '一键 Approve' });
    await expect(approve).toBeEnabled();

    const metrics = await bar.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      overflowX: getComputedStyle(node).overflowX,
    }));
    expect(metrics.overflowX).toBe('auto');
    expect(metrics.scrollWidth, '窄面板下底部工具栏应当溢出').toBeGreaterThan(metrics.clientWidth);

    const last = bar.getByRole('button', { name: 'Delegation' });
    const barBox = (await bar.boundingBox())!;
    const before = (await last.boundingBox())!;
    expect(before.x + before.width, '溢出的控件一开始就该落在可视区外')
      .toBeGreaterThan(barBox.x + barBox.width);

    await bar.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    expect(await bar.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const after = (await last.boundingBox())!;
    expect(after.x + after.width, '横滑到底后最后一个控件要完全可见')
      .toBeLessThanOrEqual(barBox.x + barBox.width + 1);

    // 横滑只发生在底部栏内部：面板和页面都不该多出横向滚动
    const overflow = await page.evaluate(() => {
      const aside = document.getElementById('review-agent-glab-root')?.shadowRoot
        ?.querySelector('aside[aria-label="Review Agent"]');
      return aside ? aside.scrollWidth - aside.clientWidth : Number.NaN;
    });
    expect(overflow, '面板被底部栏撑出横向滚动').toBeLessThanOrEqual(0);
    expect(await pageHOverflow(page), '页面被底部栏撑出横向滚动').toBeLessThanOrEqual(baselineOverflow);

    await bar.evaluate((node) => { node.scrollLeft = 0; });
    const posted = page.waitForResponse(
      (response) => response.url().endsWith('/approve') && response.request().method() === 'POST',
      { timeout: 60000 },
    );
    await approve.click();
    await bar.getByRole('button', { name: '确认 Approve？' }).click();
    const response = await posted;
    const status = response.status();
    const raw = await response.text();
    // 清理放在断言之前：断言失败也不把批准留在真实 MR 上
    const cleanup = await setApproved(page, false);

    expect(status, raw).toBe(201);
    expect(JSON.parse(raw)).toMatchObject({ user_has_approved: true, approved: true });
    await expect(page.getByText('已 Approve 该 MR')).toBeVisible({ timeout: 20000 });
    expect(cleanup, 'e2e 没有把 Approve 撤销干净').toBe(201);
  });

  test('runs hybrid review against a real local model (omlx)', async ({ page }) => {
    const reachable = await fetch(`${modelBaseUrl}/models`).then((r) => r.ok).catch(() => false);
    test.skip(!reachable, `本地模型服务 ${modelBaseUrl} 不可达`);
    test.setTimeout(240_000);
    await loginToGitLab(page, realGitlabUrl);
    await mountUserscript(page, realMrUrl, {
      provider: 'openai', modelBaseUrl, model: modelName, apiKey: modelApiKey,
      gitlabToken: '', effort: 'balanced', language: 'zh-CN', thinking: 'off',
      repoIndex: { enabled: true, maxFiles: 150, maxBytes: 8 * 1024 * 1024, maxIndexes: 4 },
      repoContext: true, debugEnabled: true,
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click({ timeout: 15000 });
    await page.getByRole('button', { name: '开始 Review' }).click({ timeout: 15000 });

    // 等待 Review 真正结束：运行中按钮在 preparing+running 期间都可见，消失即代表完成。
    // 不能直接等 "N 个问题"，因为进行中的空计数也会显示 "0 个问题"，会造成提前匹配。
    await expect(page.getByRole('button', { name: 'Review 中', exact: true })).toBeHidden({ timeout: 200_000 });
    await expect(page.getByText('AI 未运行')).toHaveCount(0);
    await expect(page.getByText('AI 评审失败')).toHaveCount(0);
    // 完成态：有问题列表或明确的"没有发现"空态。模型产出数量不确定，0 也是合法结果，
    // 因此这里不断言 AI 必须命中，真实调用由下方调试面板的网络/提示词记录证明。
    await expect(page.getByText(/个问题|没有发现需要处理的问题/).first()).toBeVisible({ timeout: 10000 });

    // 调试面板里应能看到模型请求与提示词记录（设置中已打开调试）
    const panel = page.locator('aside[aria-label="Review Agent"]');
    await page.getByRole('tab', { name: /调试/ }).click();
    await page.getByRole('button', { name: /网络 \d+/ }).click();
    await expect(panel.getByText(/chat\/completions/).first()).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /提示词 \d+/ }).click();
    await expect(panel.getByText(modelName).first()).toBeVisible({ timeout: 10000 });
  });

  test('builds repo index on real GitLab, searches symbols and manages registry', async ({ page }) => {
    test.setTimeout(120_000);
    await loginToGitLab(page, realGitlabUrl);
    await mountUserscript(page, realMrUrl, {
      provider: 'openai', modelBaseUrl: 'https://model.invalid/v1', model: 'unused', apiKey: '',
      gitlabToken: '', effort: 'balanced', language: 'zh-CN',
      repoIndex: { enabled: true, maxFiles: 120, maxBytes: 6 * 1024 * 1024, maxIndexes: 3 },
      repoContext: true, debugEnabled: true,
    });
    await page.getByRole('button', { name: '打开 Review Agent' }).click({ timeout: 15000 });
    await page.getByRole('tab', { name: /索引/ }).click();
    await page.getByRole('button', { name: '建立索引' }).click();

    await expect(page.getByText('已就绪')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('已缓存索引')).toBeVisible();
    await expect(page.getByText('当前 head')).toBeVisible();

    // 直接从 OPFS 读符号表，取一个真实存在的符号去搜索
    const symbolName = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const idx = await (await root.getDirectoryHandle('review-agent')).getDirectoryHandle('idx');
      for await (const [, handle] of idx.entries()) {
        if (handle.kind !== 'directory') continue;
        const metaFile = await handle.getFileHandle('meta.json');
        const meta = JSON.parse(await (await metaFile.getFile()).text());
        const withDefs = (meta.files ?? []).find((file: { defs?: unknown[] }) => (file.defs ?? []).length > 0);
        if (withDefs) return withDefs.defs[0].name as string;
      }
      return null;
    });
    expect(symbolName).toBeTruthy();

    const search = page.getByLabel('符号搜索');
    await search.fill(symbolName as string);
    await expect(page.getByRole('button', { name: new RegExp(symbolName as string) }).first()).toBeVisible({ timeout: 5000 });

    // 调试面板应记录真实 GitLab 请求
    await page.getByRole('tab', { name: /调试/ }).click();
    await page.getByRole('button', { name: /网络 \d+/ }).click();
    await expect(page.getByText(/repository\/tree/).first()).toBeVisible({ timeout: 10000 });

    // 删除该索引后注册表清空
    await page.getByRole('tab', { name: /索引/ }).click();
    await page.getByRole('button', { name: /删除索引/ }).first().click();
    await expect(page.getByText('还没有缓存')).toBeVisible({ timeout: 10000 });
  });
  // --- 页面交互：划词行号 / 选区菜单生命周期 / Finding 定位，全部在真实 GitLab 页面上跑 ---

  /**
   * GitLab 19.x 默认用 Rapid Diffs（Beta）的自定义元素渲染 diff，行号 DOM 完全不同；
   * 脚本的划词与定位针对经典 diff 渲染，用 GitLab 自己的 cookie 固定住渲染方式。
   */
  async function useClassicDiffs(page: Page) {
    await page.context().addCookies([{ name: 'rapid_diffs_enabled', value: 'false', url: realGitlabUrl }]);
  }

  const RULE_TITLE = 'E2E 定位目标行';

  interface LineTarget { path: string; line: number; text: string }

  const selectionToolbar = (page: Page) => page.getByRole('toolbar', { name: '代码选区操作' });

  /** GitLab 自己渲染的行号（行号格里的 a[data-linenumber]）：用来校验脚本读到的数不是编出来的。 */
  const gitlabLineOf = (node: HTMLElement) => {
    const row = node.closest('.line_holder');
    const anchor = row?.querySelector('a[data-linenumber], a[data-line-number]');
    const interop = row?.querySelector('[data-interop-new-line], [data-interop-old-line]');
    return Number(anchor?.getAttribute('data-linenumber') ?? anchor?.getAttribute('data-line-number')
      ?? interop?.getAttribute('data-interop-new-line') ?? interop?.getAttribute('data-interop-old-line') ?? 0);
  };

  /**
   * 拖拽划词：比 dblclick 更接近用户真实操作，也不会只选中一个 token。
   * 拖拽距离要收着点：代码格一直延伸到面板底下，mouseup 落在面板上会被当成「面板内选区」而收起工具条。
   */
  async function selectText(page: Page, target: Locator) {
    // diff 是异步渲染的，拖拽撞上行内节点被换掉就会选空：重试到真有选区为止
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await target.scrollIntoViewIfNeeded();
      const box = (await target.boundingBox())!;
      // 面板 fixed 盖在页面右侧：拖拽终点落在面板上会被当成「面板内选区」而收起工具条，终点收在面板左边
      const panelLeft = await page.evaluate(() => {
        const panel = document.getElementById('review-agent-glab-root')?.shadowRoot
          ?.querySelector('aside[aria-label="Review Agent"]');
        const rect = panel?.getBoundingClientRect();
        return rect && rect.width > 0 ? rect.left : window.innerWidth;
      });
      const endX = Math.max(box.x + 20, Math.min(box.x + box.width - 3, box.x + 240, panelLeft - 24));
      await page.mouse.move(box.x + 3, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(endX, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      const selected = await page.waitForFunction(
        () => (document.getSelection()?.toString().trim().length ?? 0) > 0, undefined, { timeout: 5000 },
      ).then(() => true).catch(() => false);
      if (selected) return;
    }
    throw new Error('拖拽划词没有产生选区');
  }

  /** 划词到工具条出现为止：选区节点被页面换掉时工具条会跟着关，重试一次通常就落在稳定 DOM 上。 */
  async function selectUntilToolbar(page: Page, target: Locator) {
    const toolbar = selectionToolbar(page);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await selectText(page, target);
      const shown = await toolbar.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
      if (shown) return toolbar;
    }
    return toolbar;
  }

  /** 定位用的是平滑滚动：连续两次读到同一个位置才算停下，否则拖拽会选到别处。 */
  async function settledBox(target: Locator) {
    let box = await target.boundingBox();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await target.page().waitForTimeout(250);
      const next = await target.boundingBox();
      if (box && next && box.x === next.x && box.y === next.y) return next;
      box = next;
    }
    return box;
  }

  /** diff 是异步渲染 + 虚拟滚动的：等到真有带代码文本的行再开始操作。 */
  async function waitDiffLines(page: Page) {
    await page.waitForFunction(
      () => [...document.querySelectorAll('.diff-file[data-path] .line_content')]
        .some((cell) => (cell.textContent ?? '').trim().length > 0),
      undefined,
      { timeout: 60000 },
    );
  }

  /** 从真实 diff 里挑一行唯一的新增代码，作为规则命中与定位的目标。 */
  function pickAddedLine(page: Page) {
    return page.evaluate((): { path: string; line: number; text: string } | undefined => {
      for (const file of document.querySelectorAll<HTMLElement>('.diff-file[data-path]')) {
        const cells = [...file.querySelectorAll<HTMLElement>('.line_content.new')];
        const texts = cells.map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim());
        for (const [index, text] of texts.entries()) {
          if (text.length < 12 || text.startsWith('//') || text.startsWith('*')) continue;
          if (texts.filter((other) => other === text).length > 1) continue;
          const row = cells[index].closest('.line_holder');
          const anchor = row?.querySelector('a[data-linenumber], a[data-line-number]');
          const line = Number(anchor?.getAttribute('data-linenumber') ?? anchor?.getAttribute('data-line-number') ?? 0);
          if (line > 0) return { path: file.dataset.path ?? '', line, text };
        }
      }
      return undefined;
    });
  }

  /** 规则评审要跑出确定命中的一条 Finding：只匹配目标行、只作用于目标文件。 */
  function locateRulePack(target: LineTarget) {
    const pattern = target.text.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    return [{
      id: 'e2e-locate-pack', name: 'E2E 定位规则包', version: '1.0.0', enabled: true, builtIn: false,
      rules: [{
        id: 'e2e-locate-line', enabled: true, severity: 'medium', category: 'maintainability',
        title: RULE_TITLE, content: '用于在真实页面上验证 Finding 定位与划词行号读数一致。',
        matchPatterns: [{ type: 'regex', pattern }],
        scope: { include: [target.path] },
      }],
    }];
  }

  /** 规则包要在脚本启动前落到 localStorage；用 addInitScript 注入，整页跳转后脚本会自动重挂载。 */
  async function seedRulePacks(page: Page, packs: unknown) {
    await page.addInitScript({
      content: `localStorage.setItem('review-agent-rule-packs-v1', ${JSON.stringify(JSON.stringify(packs))});`,
    });
    await page.addInitScript({ content: bundle });
  }

  /** 规则阶段恒运行，不需要模型；等目标 Finding 的卡片出现。 */
  async function runRuleReview(page: Page, line: number) {
    await page.getByRole('button', { name: '打开 Review Agent' }).click({ timeout: 20000 });
    await page.getByRole('button', { name: '开始 Review' }).click({ timeout: 20000 });
    const card = page.locator('aside[aria-label="Review Agent"] article')
      .filter({ hasText: RULE_TITLE })
      .filter({ hasText: new RegExp(`行内 L${line}\\b`) })
      .first();
    await expect(card).toBeVisible({ timeout: 90000 });
    return card;
  }

  test('reads the real line number when selecting diff code', async ({ page }) => {
    await loginToGitLab(page, realGitlabUrl);
    await useClassicDiffs(page);
    await mountUserscript(page, realMrUrl);
    await waitDiffLines(page);

    const file = page.locator('.diff-file[data-path]')
      .filter({ has: page.locator('.line_content.new', { hasText: /\S/ }) })
      .first();
    const added = file.locator('.line_content.new').filter({ hasText: /\S/ }).first();
    const addedLine = await added.evaluate(gitlabLineOf);
    expect(addedLine).toBeGreaterThan(0);

    const toolbar = await selectUntilToolbar(page, added);
    await expect(toolbar).toContainText(`:${addedLine}`);
    await expect(toolbar).not.toContainText('行号未知');

    // 删除行按旧侧行号引用，标签明确标出旧侧
    const removed = file.locator('.line_content.old').filter({ hasText: /\S/ }).first();
    if (await removed.count() > 0) {
      const removedLine = await removed.evaluate(gitlabLineOf);
      expect(removedLine).toBeGreaterThan(0);
      await selectUntilToolbar(page, removed);
      await expect(toolbar).toContainText(`:${removedLine}（旧侧）`);
    }
  });

  test('keeps a non-diff selection text-only', async ({ page }) => {
    await loginToGitLab(page, realGitlabUrl);
    await useClassicDiffs(page);
    await mountUserscript(page, realMrUrl);
    await waitDiffLines(page);

    const toolbar = await selectUntilToolbar(page, page.locator('h1.title').first());
    await expect(toolbar).toContainText('页面文本选区');
    await expect(toolbar.getByRole('button', { name: '问一下' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: '复制选中内容' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Review 这段' })).toHaveCount(0);

    // 提问引用里没有 path:line，只有原文
    await toolbar.getByRole('button', { name: '问一下' }).click();
    const panel = page.locator('aside[aria-label="Review Agent"]');
    await expect(panel).toBeVisible({ timeout: 10000 });
    await expect(panel.getByText('页面文本选区').first()).toBeVisible({ timeout: 10000 });
    await expect(panel).not.toContainText('.ts:');
    await expect(panel).not.toContainText('行号未知');
  });

  test('drops the selection menu when the selected rows leave the page', async ({ page }) => {
    await loginToGitLab(page, realGitlabUrl);
    await useClassicDiffs(page);
    await mountUserscript(page, realMrUrl);
    await waitDiffLines(page);

    const file = page.locator('.diff-file[data-path]')
      .filter({ has: page.locator('.line_content.new', { hasText: /\S/ }) })
      .first();
    const toolbar = await selectUntilToolbar(page, file.locator('.line_content.new').filter({ hasText: /\S/ }).first());

    // 折叠文件：GitLab 客户端整块移除 diff 行（不刷新页面），工具条必须跟着消失
    await file.locator('button[aria-label="Hide file contents"]').first().click();
    await expect(file.locator('.line_holder')).toHaveCount(0, { timeout: 15000 });
    await expect(toolbar).toHaveCount(0, { timeout: 10000 });

    // 切 tab（整页跳转）后同样不残留
    await page.locator('a[href$="/commits"]').first().click();
    await page.waitForFunction(() => window.location.pathname.endsWith('/commits'), undefined, { timeout: 30000 });
    await expect(selectionToolbar(page)).toHaveCount(0);
  });

  test('gives every toolbar button a tooltip that says more than its label', async ({ page }) => {
    await loginToGitLab(page, realGitlabUrl);
    await useClassicDiffs(page);
    await mountUserscript(page, realMrUrl);
    await waitDiffLines(page);

    const file = page.locator('.diff-file[data-path]')
      .filter({ has: page.locator('.line_content.new', { hasText: /\S/ }) })
      .first();
    const toolbar = await selectUntilToolbar(page, file.locator('.line_content.new').filter({ hasText: /\S/ }).first());

    const buttons = toolbar.locator('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      const label = ((await button.textContent()) ?? '').trim();
      const title = await button.getAttribute('title');
      expect(title, `${label} 缺少 tooltip`).not.toBeNull();
      expect(title, `${label} 的 tooltip 与按钮文本重复`).not.toBe(label);
      expect(title!.length).toBeGreaterThan(label.length);
    }
  });

  test('locates a finding on the real diff and reads the same line as the selection', async ({ page }) => {
    test.setTimeout(240_000);
    await loginToGitLab(page, realGitlabUrl);
    await useClassicDiffs(page);
    await mountUserscript(page, realMrUrl);
    await waitDiffLines(page);
    const target = await pickAddedLine(page);
    test.skip(target === undefined, '真实 MR 里没有可定位的新增行');
    const { path, line, text } = target!;

    // 种一条只命中该行的规则：真实 diff 上跑出确定的 Finding，页面和模型都不 mock
    await seedRulePacks(page, locateRulePack(target!));
    await page.goto(realMrUrl);
    await waitDiffLines(page);
    const card = await runRuleReview(page, line);

    // 先把文件折叠起来，定位要自己把它展开
    const file = page.locator(`.diff-file[data-path="${path}"]`);
    await file.locator('button[aria-label="Hide file contents"]').first().click();
    await expect(file.locator('.line_holder')).toHaveCount(0, { timeout: 15000 });

    await card.getByRole('button', { name: '定位', exact: true }).click();
    // LocateOutcome 如实播报：文件被重新展开、目标行真的找到了
    await expect(page.locator('#review-agent-glab-root').getByRole('status'))
      .toContainText(`已高亮 ${path.replace(/^.*\//, '')}:${line}`, { timeout: 30000 });

    const highlighted = page.locator('.ra-finding-highlight').first();
    await expect(highlighted).toBeVisible({ timeout: 10000 });
    expect(await highlighted.evaluate(gitlabLineOf)).toBe(line);
    await expect(highlighted).toContainText(text.trim());

    // 滚动到行：等平滑滚动停下，高亮行落在视口内
    const box = await settledBox(highlighted);
    expect(box, '高亮行没有布局位置').not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeLessThan(900);

    // 同一行 DOM：划词读到的行号与定位用的行号一致（两边共用 core/dom-line-number）
    const toolbar = await selectUntilToolbar(page, highlighted.locator('.line_content'));
    await expect(toolbar).toContainText(`:${line}`);
    await expect(toolbar).not.toContainText('行号未知');
  });

  test('keeps locating after the Changes tab reloads the page', async ({ page }) => {
    test.setTimeout(240_000);
    await loginToGitLab(page, realGitlabUrl);
    await useClassicDiffs(page);
    await mountUserscript(page, realMrUrl);
    await waitDiffLines(page);
    const target = await pickAddedLine(page);
    test.skip(target === undefined, '真实 MR 里没有可定位的新增行');
    const { line, text } = target!;
    await seedRulePacks(page, locateRulePack(target!));

    // 从 Overview 起：定位要先切 Changes tab（GitLab 是整页跳转），落地后接着走完
    await page.goto(realMrUrl.replace(/\/diffs.*$/, ''));
    await expect(page.locator('.diff-file')).toHaveCount(0);
    const card = await runRuleReview(page, line);
    await card.getByRole('button', { name: '定位', exact: true }).click();

    await page.waitForFunction(() => window.location.pathname.endsWith('/diffs'), undefined, { timeout: 30000 });
    const highlighted = page.locator('.ra-finding-highlight').first();
    await expect(highlighted).toBeVisible({ timeout: 60000 });
    expect(await highlighted.evaluate(gitlabLineOf)).toBe(line);
    await expect(highlighted).toContainText(text.trim());
  });

  // --- 真实发布链：userscript → createDiscussion → POST /discussions，在真实 MR 上落一条行内评论 ---

  /** 与 core/diff.ts#parseUnifiedDiff 同一套行号规则，从 unified diff 里取新增行。 */
  const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

  function addedRows(diff: string) {
    const rows: { line: number; text: string }[] = [];
    let newLine = 0;
    let inHunk = false;
    for (const raw of diff.split(/\r?\n/)) {
      const header = HUNK_HEADER.exec(raw);
      if (header) { newLine = Number(header[3]); inHunk = true; continue; }
      if (!inHunk || raw === '\\ No newline at end of file') continue;
      if (raw.startsWith('+')) { rows.push({ line: newLine, text: raw.slice(1) }); newLine += 1; }
      else if (raw.startsWith(' ') || raw === '') newLine += 1;
    }
    return rows;
  }

  /** 挑一行唯一、够长、不是注释的新增代码：规则要精确命中它，卡片要能被 `行内 L{n}` 锁定。 */
  function pickFromDiff(path: string, diff: string): LineTarget | undefined {
    const rows = addedRows(diff);
    const texts = rows.map((row) => row.text.replace(/\s+/g, ' ').trim());
    for (const [index, text] of texts.entries()) {
      if (text.length < 12 || text.startsWith('//') || text.startsWith('*')) continue;
      if (texts.filter((other) => other === text).length > 1) continue;
      return { path, line: rows[index].line, text };
    }
    return undefined;
  }

  /**
   * 优先挑新增文件里的行：修复前 buildDiscussionPayload 对新增文件发 position[old_path]=/dev/null，
   * GitLab 把它当 diff 路径过滤条件丢给 Gitaly，整个请求直接 500。
   * 目标行从 REST diff 取而不是从 DOM 取：GitLab 的 diff 文件是懒渲染的，没滚到就不在 DOM 里。
   */
  async function pickPublishTarget(page: Page) {
    const response = await page.request.get(`${realMrApi}/diffs?per_page=100`).catch(() => undefined);
    if (!response?.ok()) return undefined;
    const diffs = await response.json() as { new_path: string; diff: string; new_file?: boolean }[];
    const ordered = [...diffs.filter((entry) => entry.new_file), ...diffs.filter((entry) => !entry.new_file)];
    for (const entry of ordered) {
      const target = pickFromDiff(entry.new_path, entry.diff ?? '');
      if (target) return target;
    }
    return undefined;
  }

  /**
   * 用完就删：真实 MR 不能被测试评论弄脏。API 的非 GET 请求走 cookie 会话时会被 CSRF 挡掉，
   * 所以带上页面里的 csrf-token，有 GITLAB_PAT 时再加 PRIVATE-TOKEN。
   */
  async function deleteInlineNote(page: Page, discussionId: string, noteId: number) {
    const csrf = await page.evaluate(
      () => document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '',
    ).catch(() => '');
    const headers: Record<string, string> = {};
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (gitlabPat) headers['PRIVATE-TOKEN'] = gitlabPat;
    const response = await page.request
      .delete(`${realMrApi}/discussions/${discussionId}/notes/${noteId}`, { headers })
      .catch(() => undefined);
    return response?.status();
  }

  test('publishes a real inline discussion through the full publish chain', async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(!realMrRef, 'GITLAB_MR_URL 不是可解析的 MR 地址');
    await loginToGitLab(page, realGitlabUrl);
    await mountUserscript(page, realMrUrl);

    const target = await pickPublishTarget(page);
    test.skip(target === undefined, '真实 MR 里没有可发布的新增行');
    const { path, line } = target!;

    await seedRulePacks(page, locateRulePack(target!));
    await page.goto(realMrUrl);
    const card = await runRuleReview(page, line);

    await card.getByRole('button', { name: '行内评论' }).click();
    await expect(page.getByRole('dialog', { name: '发布行内评论' })).toBeVisible();
    await page.getByLabel('评论内容').fill(`E2E 行内评论 ${path}:${line} ${Date.now()}`);

    const posted = page.waitForResponse(
      (response) => response.url().endsWith('/discussions') && response.request().method() === 'POST',
      { timeout: 90_000 },
    );
    await page.getByRole('button', { name: '确认行内评论' }).click();
    const response = await posted;
    const status = response.status();
    const raw = await response.text();
    const discussion = status < 300
      ? JSON.parse(raw) as { id: string; notes?: { id: number; position?: Record<string, unknown> }[] }
      : undefined;
    const noteId = discussion?.notes?.[0]?.id;
    // 清理放在断言之前：断言失败也不把评论留在真实 MR 上
    const cleanupStatus = noteId ? await deleteInlineNote(page, discussion!.id, noteId) : undefined;

    // 修复前这里会是 500（新增文件发 /dev/null）或 400（line_code can't be blank / position must be a valid json schema）
    expect(status, raw).toBe(201);
    expect(noteId, 'GitLab 没有返回行内 note').toBeTruthy();

    const sent = decodeURIComponent(response.request().postData() ?? '');
    expect(sent).not.toContain('/dev/null');
    expect(sent).toContain(`position[new_path]=${path}`);
    expect(sent).toContain(`position[old_path]=${path}`);

    const position = discussion!.notes![0].position ?? {};
    expect(position).toMatchObject({ position_type: 'text', new_path: path, old_path: path });
    // GitLab 用 (old_line, new_line) 精确匹配 diff 行，匹配不上根本创建不出 discussion
    expect([position.new_line, position.old_line]).toContain(line);

    await expect(page.getByText('行级 Discussion 已发布')).toBeVisible({ timeout: 30000 });
    await expect(card.getByRole('button', { name: '已发布', exact: true })).toBeVisible();
    // 放到最后：清理失败要报，但不能盖掉真正的发布失败
    expect(cleanupStatus, 'e2e 行内评论没有清理干净').toBe(204);
  });
});
