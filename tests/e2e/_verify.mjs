import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const bundle = readFileSync('dist/review-agent-glab-monkey-script.user.js', 'utf8');

await page.route('https://gitlab.test/**', r => {
  const url = new URL(r.request().url());
  if (r.request().resourceType() === 'document')
    r.fulfill({ contentType: 'text/html', body: '<html><head><meta name="csrf-token" content="t"></head><body data-page="projects:merge_requests:show"><div class="diff-file" data-file-path="src/a.ts"><div class="file-title-name">src/a.ts</div><div class="line_holder" data-line-number="1"><code class="ra-line-code">const x = 1;</code></div></div></body></html>' });
  else if (url.pathname.includes('chat/completions'))
    r.fulfill({ json: { choices: [{ message: { content: 'AI response here' } }] } });
  else r.fulfill({ json: {} });
});

await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs');
await page.addScriptTag({ content: bundle });
await page.waitForTimeout(2000);
await page.getByRole('button', { name: '打开 Review Agent' }).click();
await page.waitForTimeout(500);

// Dump all buttons and their text
const buttons = await page.locator('[aria-label="Review Agent"] button').all();
for (const btn of buttons) {
  const text = await btn.textContent();
  const label = await btn.getAttribute('aria-label');
  console.log('BTN:', JSON.stringify(text?.trim()), 'aria:', label);
}

// Check if review section has the "提问" button
const askBtn = page.locator('[aria-label="Review Agent"] button').filter({ hasText: '提问' });
console.log('\nAsk buttons:', await askBtn.count());

// Take screenshot
await page.screenshot({ path: '/tmp/verify.png' });
console.log('Screenshot saved');
await browser.close();
