import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bundlePath = resolve(process.cwd(), 'dist/review-agent-glab-monkey-script.user.js');
const bundle = readFileSync(bundlePath, 'utf8');

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

async function routeGitLab(page: Page, requests: string[] = []) {
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

async function mountGitLab(page: Page) {
  await routeGitLab(page);
  await page.addInitScript({ content: bundle });
  await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript({
    content: `localStorage.removeItem('review-agent-settings-v1');`,
  });
});

test('loads real GitLab diff, runs rule review, and publishes a confirmed discussion', async ({ page }) => {
  const requests: string[] = [];
  await routeGitLab(page, requests);
  await page.addInitScript({ content: bundle });
  await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs');

  await expect(page.getByText('Harden checkout payment error handling')).toBeVisible();
  await page.getByRole('tab', { name: 'Review' }).click();
  await expect(page.getByText('已从 GitLab API 读取 1 个文件的真实 Diff。')).toBeVisible();
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
  expect(request.postData()).toContain('position%5Bnew_line%5D=2');
  await expect(page.getByText('行级 Discussion 已发布')).toBeVisible();
  await expect(finding.getByRole('button', { name: '已发布', exact: true })).toBeVisible();
  expect(requests.some((path) => path.endsWith('/diffs'))).toBe(true);
});

test('captures a real diff selection and calls an OpenAI-compatible model', async ({ page }) => {
  await page.addInitScript({
    content: `localStorage.setItem('review-agent-settings-v1', JSON.stringify({ modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key', gitlabToken: '', effort: 'balanced', language: 'zh-CN' }));`,
  });
  await routeGitLab(page);
  await page.route('https://model.test/v1/chat/completions', (route) => route.fulfill({
    json: { choices: [{ message: { content: '模型回答：这段代码需要保护 API Key。' } }] },
  }));
  await page.addInitScript({ content: bundle });
  await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs');
  await expect(page.getByText('Harden checkout payment error handling')).toBeVisible();

  await page.locator('[data-line-number="1"] .ra-line-code').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element.firstChild ?? element);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  await expect(page.getByRole('toolbar', { name: '代码选区操作' })).toBeVisible();
  await page.getByRole('button', { name: '问一下' }).click();
  await expect(page.getByText('src/payment.ts:L1-1')).toBeVisible();
  await page.getByLabel('提问内容').fill('这段代码有什么风险？');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('模型回答：这段代码需要保护 API Key。')).toBeVisible();
});

test('userscript metadata is bundled and the entry is scoped to GitLab pages', async ({ page }) => {
  const metadata = bundle.slice(bundle.indexOf('// ==UserScript=='), bundle.indexOf('// ==/UserScript=='));
  expect(metadata).toContain('@name         Review Agent for GitLab');
  expect(metadata).toContain('@match        https://*/*');
  expect(metadata).toContain('@match        http://*/*');
  expect(metadata).toContain('@grant        GM.getValue');
  expect(metadata).toContain('@grant        GM.xmlHttpRequest');
  expect(metadata).toContain('@run-at       document-idle');

  await page.route('https://example.test/**', (route) => route.fulfill({ body: '<!doctype html><html><body>ordinary page</body></html>' }));
  await page.addInitScript({ content: bundle });
  await page.goto('https://example.test/docs');
  await expect(page.locator('#review-agent-glab-root')).toHaveCount(0);

  await routeGitLab(page);
  await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs');
  await expect(page.getByRole('complementary', { name: 'Review Agent' })).toBeVisible();
});
