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

async function routeGitLab(page: Page, requests: string[] = []) {
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
              title: '代码中疑似硬编码敏感信息',
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
              title: '新增调试日志可能泄漏运行时信息',
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
    if (url.pathname.endsWith('/discussions') && route.request().method() === 'GET') {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname.endsWith('/discussions') && route.request().method() === 'POST') {
      await route.fulfill({ json: { id: 'discussion-1', notes: [{ id: 'note-1' }] } });
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

    await expect(page.getByText('代码中疑似硬编码敏感信息')).toBeVisible();
    await expect(page.getByText('新增调试日志可能泄漏运行时信息')).toBeVisible();

    const finding = page.locator('article').filter({ hasText: '代码中疑似硬编码敏感信息' });
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
});
