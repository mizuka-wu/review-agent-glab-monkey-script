import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Launch with CDP debugging
const browser = await chromium.launch({ headless: false, slowMo: 50 });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const bundle = readFileSync('dist/review-agent-glab-monkey-script.user.js', 'utf8');
await page.route('https://gitlab.test/**', r => {
  const url = new URL(r.request().url());
  if (r.request().resourceType() === 'document')
    r.fulfill({ contentType: 'text/html', body: '<html><head><meta name="csrf-token" content="t"></head><body data-page="projects:merge_requests:show"><div class="diff-file" data-file-path="src/a.ts"><div class="file-title-name">src/a.ts</div><div class="line_holder" data-line-number="1"><code class="ra-line-code">const x = 1;</code></div></div></body></html>' });
  else if (url.pathname.includes('chat/completions'))
    r.fulfill({ json: { choices: [{ message: { content: 'AI response' } }] } });
  else r.fulfill({ json: {} });
});

await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs');
await page.addScriptTag({ content: bundle });
await page.waitForTimeout(2000);
await page.getByRole('button', { name: '打开 Review Agent' }).click();
await page.waitForTimeout(500);

// === SCROLL TEST ===
console.log('=== SCROLL TEST ===');
const scrollResult = await page.evaluate(() => {
  const panel = document.querySelector('[aria-label="Review Agent"]');
  // The body div is the 3rd child (header, tabs, body)
  const body = panel.children[2];
  const cs = getComputedStyle(body);
  const inner = body.children[0];

  // Try to force scroll by setting a large height on inner content
  inner.style.minHeight = '2000px';

  return {
    bodyOverflowY: cs.overflowY,
    bodyFlex: cs.flex,
    bodyHeight: cs.height,
    bodyScrollH: body.scrollHeight,
    bodyClientH: body.clientHeight,
    innerOverflowY: getComputedStyle(inner).overflowY,
    innerMinHeight: getComputedStyle(inner).minHeight,
  };
});
console.log('After forcing 2000px content:', JSON.stringify(scrollResult, null, 2));

// Now try to scroll
const scrollTop = await page.evaluate(() => {
  const body = document.querySelector('[aria-label="Review Agent"]').children[2];
  body.scrollTop = 500;
  return body.scrollTop;
});
console.log('scrollTop after setting 500:', scrollTop);

// Take screenshot
await page.screenshot({ path: '/tmp/scroll-test.png' });
console.log('Screenshot saved');
await browser.close();
