import { test, expect, type Page } from '@playwright/test';
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
const isRealGitlab = Boolean(realGitlabUrl && realMrUrl);

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

// --- Mock 路由 ---

async function routeGitLab(page: Page, requests: string[] = [], options?: { stream?: boolean; delayMs?: number }) {
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
          ]),
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
    if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
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
    if (url.pathname.startsWith('/api/v4/projects/') && url.pathname.endsWith('/merge_requests/248/diffs')) {
      await route.fulfill({ json: [diff] });
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
    await finding.getByRole('button', { name: '发布到 GitLab' }).click();
    await expect(page.getByRole('dialog', { name: '发布到 GitLab' })).toBeVisible();
    await page.getByLabel('评论内容').fill('Edited review comment');

    const discussionRequest = page.waitForRequest((request) => request.url().endsWith('/discussions'));
    await page.getByRole('button', { name: '确认发布' }).click();
    const request = await discussionRequest;
    expect(request.postData()).toContain('body=Edited+review+comment');
    expect(request.postData()).toContain('position%5Bhead_sha%5D=head-sha');
    await expect(page.getByText('行级 Discussion 已发布')).toBeVisible();
    expect(requests.some((path) => path.endsWith('/diffs'))).toBe(true);
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
    await expect(page.getByText('src/payment.ts:1-1')).toBeVisible();

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
    await page.waitForTimeout(1000);
    const signInForm = page.locator('input[name="user[login]"]');
    if (await signInForm.count() > 0) {
      await signInForm.fill(gitlabUser);
      await page.locator('input[name="user[password]"]').fill(gitlabPass);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForURL((url) => !url.pathname.includes('sign_in'), { timeout: 15000 });
    }
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
});
