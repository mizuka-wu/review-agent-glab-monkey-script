import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const bundle = readFileSync('dist/review-agent-glab-monkey-script.user.js', 'utf8');
await page.route('https://gitlab.test/**', r => {
  if (r.request().resourceType() === 'document')
    r.fulfill({ contentType: 'text/html', body: '<html><head><meta name="csrf-token" content="t"></head><body data-page="projects:merge_requests:show"></body></html>' });
  else r.fulfill({ json: {} });
});
await page.goto('https://gitlab.test/acme/app/-/merge_requests/248/diffs');
await page.addScriptTag({ content: bundle });
await page.waitForTimeout(2000);
await page.getByRole('button', { name: '打开 Review Agent' }).click();
await page.waitForTimeout(300);

const info = await page.evaluate(() => {
  const panel = document.querySelector('[aria-label="Review Agent"]');
  if (!panel) return 'no panel';
  const out = [];
  function dump(el, d) {
    if (d > 5) return;
    const cs = getComputedStyle(el);
    out.push('  '.repeat(d) + el.tagName.toLowerCase() +
      ' h=' + cs.height + ' ovY=' + cs.overflowY +
      ' flex=' + cs.flex + ' minH=' + cs.minHeight +
      ' disp=' + cs.display + ' scrollH=' + el.scrollHeight + ' clientH=' + el.clientHeight);
    for (const c of el.children) dump(c, d + 1);
  }
  dump(panel, 0);
  return out.join('\n');
});
console.log(info);
await browser.close();
