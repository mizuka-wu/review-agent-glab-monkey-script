const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.route('https://gitlab.test/**', route => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() === 'document') {
      route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="csrf-token" content="csrf-test"></head><body data-page="projects:merge_requests:show"></body></html>' });
      return;
    }
    if (url.pathname.endsWith('/diffs')) route.fulfill({ json: [{ old_path: 'src/payment.ts', new_path: 'src/payment.ts', diff: '@@ -1 +1 @@\n+const a = 1;\n', new_file: false, deleted_file: false }] });
    else route.fulfill({ json: { title: 'Test MR', state: 'opened', sha: 'abc', diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' }, source_branch: 'f', target_branch: 'm' } });
  });
  await page.addInitScript({ content: `localStorage.setItem('review-agent-settings-v1', ${JSON.stringify(JSON.stringify({ gitlabToken: '', effort: 'balanced', language: 'zh-CN' }))});` });
  await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: fs.readFileSync(path.resolve('dist/review-agent-glab-monkey-script.user.js'), 'utf8') });
  await page.waitForSelector('button[aria-label="打开 Review Agent"]', { timeout: 10000 });
  await page.click('button[aria-label="打开 Review Agent"]');
  await page.waitForSelector('aside[aria-label="Review Agent"]', { state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);
  // Make sure we're on chat view (not config)
  const host = await page.evaluateHandle(() => document.getElementById('review-agent-glab-root'));
  const isConfig = await page.evaluate(() => {
    const h = document.getElementById('review-agent-glab-root');
    const s = h?.shadowRoot ?? document;
    return s.querySelector('aside')?.textContent?.includes('模型配置') ?? false;
  });
  if (isConfig) {
    await page.evaluate(() => {
      const h = document.getElementById('review-agent-glab-root');
      const s = h?.shadowRoot ?? document;
      const btn = s.querySelector('button[aria-label="配置"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(500);
  }
  
  const aside = await page.locator('aside[aria-label="Review Agent"]').first();
  await aside.screenshot({ path: '/tmp/chat-view.png' });
  
  const info = await page.evaluate(() => {
    const host = document.getElementById('review-agent-glab-root');
    const shadow = host?.shadowRoot ?? document;
    const aside = shadow.querySelector('aside[aria-label="Review Agent"]');
    const ta = aside?.querySelector('textarea');
    const ar = aside?.getBoundingClientRect();
    const tr = ta?.getBoundingClientRect();
    // Check if textarea is visible in the aside
    const taVisible = tr && tr.top >= ar.top && tr.bottom <= ar.bottom + 5;
    return {
      asideH: ar ? Math.round(ar.height) : 0,
      asideTop: ar ? Math.round(ar.top) : 0,
      asideBottom: ar ? Math.round(ar.bottom) : 0,
      taTop: tr ? Math.round(tr.top) : 'N/A',
      taBottom: tr ? Math.round(tr.bottom) : 'N/A',
      taH: tr ? Math.round(tr.height) : 'N/A',
      taVisibleInAside: taVisible,
      taStyle: ta ? { display: getComputedStyle(ta).display, visibility: getComputedStyle(ta).visibility, opacity: getComputedStyle(ta).opacity } : 'N/A',
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
