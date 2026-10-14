import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolvePublishPosition } from '../../src/core/anchor';
import { normalizeFileDiff } from '../../src/core/diff';
import { buildDiscussionPayload } from '../../src/core/gitlab-adapter';
import type { DiscussionPosition, FileDiff, Finding } from '../../src/core/types';

/**
 * 行内评论成功率矩阵（真实 GitLab）。
 *
 * 用户反馈「还是很容易没办法行内评论」，这个 spec 不猜原因：直接在真实 MR 上按维度量一遍。
 *   ① 行号来源：rapid 的 a.rd-line-link[data-line-number] / classic 的 data-interop-* 与 a[data-linenumber]
 *   ② diff 类型：新增行 / 删除行 / 上下文行（两侧行号不同的那种）
 *   ③ 文件状态：新文件 / 重命名 / 删除（/dev/null 侧）/ 普通修改 / 超长行 / GitLab 折叠的空 diff
 *   ④ 视图：classic（rapid_diffs_enabled=false）/ rapid（19.x 默认，无 cookie 也是它）
 *   ⑤ 选区形态：精确单行 / 跨行拖选 / 拖选终点落在面板外
 *   ⑥ 折叠行 / 超长行
 * 真值一律取 GitLab 自己写在 DOM / API 上的行号与 HTTP 状态码，不用脚本自己的读数当真值。
 */

const realGitlabUrl = process.env.GITLAB_URL || '';
const realMrUrl = process.env.GITLAB_MR_URL || '';
const gitlabPat = process.env.GITLAB_PAT || '';
const gitlabUser = process.env.GITLAB_USER || 'root';
const gitlabPass = process.env.GITLAB_PASS || '5iveRage';
const isRealGitlab = Boolean(realGitlabUrl && realMrUrl);
const matrixProject = process.env.GITLAB_MATRIX_PROJECT || 'test/test';
const matrixBranch = 'ra-inline-matrix';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

/** 直接在页面里跑 src/ 下的真实实现：DOM 读法不能靠抄一份到测试里，抄了就测不出改动。 */
function bundleForBrowser(files: string[]): string {
  return files
    .map((file) => ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
      .replace(/^import[\s\S]*?;\s*$/gm, '')
      .replace(/^export /gm, ''))
    .join('\n');
}

const domBundle = bundleForBrowser(['src/core/dom-line-number.ts', 'src/core/selection.ts']);

async function gitlabApi(path: string, init?: { method?: string; body?: unknown }) {
  const response = await fetch(`${realGitlabUrl}/api/v4${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'PRIVATE-TOKEN': gitlabPat,
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  try {
    return { status: response.status, data: JSON.parse(text) as any };
  } catch {
    return { status: response.status, data: text };
  }
}

// --- 矩阵沙箱 MR：一个 MR 里凑齐所有文件形态 ---

const seeded = (name: string, count: number) =>
  Array.from({ length: count }, (_, index) => `export const ${name}${index + 1} = ${index + 1}; // line ${index + 1}`).join('\n') + '\n';

interface MatrixMr { projectPath: string; iid: number; url: string; files: FileDiff[]; diffRefs: { baseSha: string; headSha: string; startSha: string } }

let matrixPromise: Promise<MatrixMr | undefined> | undefined;

/**
 * 建（或复用）一个覆盖全部文件形态的 MR：普通修改（含增/删/上下文行、行号错位）、重命名、删除、
 * 新文件、超长行、单行压缩产物，以及一个 400 行只在开头改一处的大文件（用来制造「行在 diff 之外」）。
 */
function ensureMatrixMr(): Promise<MatrixMr | undefined> {
  matrixPromise ??= (async () => {
    if (!gitlabPat) return undefined;
    const project = encodeURIComponent(matrixProject);
    const base = seeded('base', 60);
    const big = seeded('big', 400);

    const head = await gitlabApi(`/projects/${project}/repository/branches?branch=${encodeURIComponent('main')}`);
    if (head.status !== 200) return undefined;

    const reuse = async (): Promise<MatrixMr | undefined> => {
      const opened = await gitlabApi(`/projects/${project}/merge_requests?state=opened&source_branch=${matrixBranch}`);
      const existing = Array.isArray(opened.data) && opened.data.length > 0 ? opened.data[0] : undefined;
      if (!existing?.iid) return undefined;
      const diffs = await gitlabApi(`/projects/${project}/merge_requests/${existing.iid}/diffs?per_page=100`);
      const raw = Array.isArray(diffs.data) ? diffs.data : [];
      if (raw.length < 7) return undefined;
      const detail = await gitlabApi(`/projects/${project}/merge_requests/${existing.iid}`);
      return {
        projectPath: matrixProject, iid: existing.iid,
        url: `${realGitlabUrl}/${matrixProject}/-/merge_requests/${existing.iid}/diffs`,
        files: raw.map(normalizeFileDiff),
        diffRefs: {
          baseSha: detail.data.diff_refs.base_sha,
          headSha: detail.data.diff_refs.head_sha,
          startSha: detail.data.diff_refs.start_sha,
        },
      };
    };
    const reused = await reuse();
    if (reused) return reused;

    const seed = await gitlabApi(`/projects/${project}/repository/commits`, {
      method: 'POST',
      body: {
        branch: 'main', commit_message: 'chore(matrix): seed inline-publish matrix fixtures',
        actions: [
          { action: 'create', file_path: 'matrix/modified.ts', content: base },
          { action: 'create', file_path: 'matrix/renamed.ts', content: 'export function legacyName(): string {\n  return "legacy";\n}\n\nexport const LEGACY_FLAG = true;\n' },
          { action: 'create', file_path: 'matrix/deleted.ts', content: 'export function willBeRemoved() {\n  return "gone";\n}\n' },
          { action: 'create', file_path: 'matrix/longline.ts', content: `export const header = "${'x'.repeat(900)}";\nexport const short = 1;\nexport const payload = { a: 1, b: 2 };\n` },
          { action: 'create', file_path: 'matrix/big.ts', content: big },
        ],
      },
    });
    // 已经建过就是 400（文件已存在），复用即可
    if (seed.status >= 300 && seed.status !== 400) return undefined;

    await gitlabApi(`/projects/${project}/repository/branches?branch=${matrixBranch}`, { method: 'DELETE' });
    const branched = await gitlabApi(`/projects/${project}/repository/branches?branch=${matrixBranch}&ref=main`, { method: 'POST' });
    if (branched.status >= 300) return undefined;

    const modified = base.split('\n');
    modified[19] = 'export const base20 = 2000; // line 20 CHANGED';
    modified.splice(30, 0, 'export const inserted31 = 31; // inserted');
    const nextModified = modified.filter((_line, index) => index !== 49).join('\n');

    const committed = await gitlabApi(`/projects/${project}/repository/commits`, {
      method: 'POST',
      body: {
        branch: matrixBranch, commit_message: 'feat(matrix): exercise every inline-publish shape',
        actions: [
          { action: 'update', file_path: 'matrix/modified.ts', content: nextModified },
          { action: 'move', file_path: 'matrix/renamed-v2.ts', previous_path: 'matrix/renamed.ts', content: 'export function modernName(): string {\n  return "modern";\n}\n\nexport const LEGACY_FLAG = true;\n' },
          { action: 'delete', file_path: 'matrix/deleted.ts' },
          { action: 'update', file_path: 'matrix/longline.ts', content: `export const header = "${'y'.repeat(900)}";\nexport const short = 2;\nexport const payload = { a: 1, b: 2, c: 3 };\n` },
          { action: 'update', file_path: 'matrix/big.ts', content: big.replace('export const big3 = 3; // line 3', 'export const big3 = 33333; // line 3') },
          { action: 'create', file_path: 'matrix/added.ts', content: 'export const ADDED_TOKEN = "tk_added";\n\nexport function addedPing(): string {\n  return "pong";\n}\n' },
          { action: 'create', file_path: 'matrix/minified.js', content: `var m=function(){${'var q=1;'.repeat(200)}return q}();\n` },
        ],
      },
    });
    if (committed.status >= 300) return undefined;

    const opened = await gitlabApi(`/projects/${project}/merge_requests?state=opened&source_branch=${matrixBranch}`);
    let mr = Array.isArray(opened.data) && opened.data.length > 0 ? opened.data[0] : undefined;
    if (!mr) {
      const created = await gitlabApi(`/projects/${project}/merge_requests`, {
        method: 'POST',
        body: { source_branch: matrixBranch, target_branch: 'main', title: 'test: inline-publish matrix sandbox' },
      });
      mr = created.data;
    }
    if (!mr?.iid) return undefined;

    // GitLab 的 diff 是异步生成的：轮询到 7 个文件都读出来为止
    let raw: any[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const diffs = await gitlabApi(`/projects/${project}/merge_requests/${mr.iid}/diffs?per_page=100`);
      raw = Array.isArray(diffs.data) ? diffs.data : [];
      if (raw.length >= 7) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (raw.length < 7) return undefined;
    const detail = await gitlabApi(`/projects/${project}/merge_requests/${mr.iid}`);
    return {
      projectPath: matrixProject,
      iid: mr.iid,
      url: `${realGitlabUrl}/${matrixProject}/-/merge_requests/${mr.iid}/diffs`,
      files: raw.map(normalizeFileDiff),
      diffRefs: {
        baseSha: detail.data.diff_refs.base_sha,
        headSha: detail.data.diff_refs.head_sha,
        startSha: detail.data.diff_refs.start_sha,
      },
    };
  })();
  return matrixPromise;
}

async function loginToGitLab(page: Page) {
  await page.goto(`${realGitlabUrl}/users/sign_in`);
  const signInForm = page.locator('input[name="user[login]"]');
  if (await signInForm.count() === 0) return;
  await signInForm.fill(gitlabUser);
  await page.locator('input[name="user[password]"]').fill(gitlabPass);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => !window.location.pathname.includes('sign_in'), undefined, { timeout: 30000 });
}

/** GitLab 19.x 默认就是 Rapid Diffs；经典渲染要用它自己的 cookie 固定住。 */
async function useView(page: Page, view: 'classic' | 'rapid') {
  await page.context().addCookies([{
    name: 'rapid_diffs_enabled', value: view === 'classic' ? 'false' : 'true', url: realGitlabUrl,
  }]);
}

async function mountDomReaders(page: Page) {
  await page.evaluate((source: string) => {
    // eslint-disable-next-line no-eval
    (0, eval)(`${source}\n;window.__ra = { rowLineNumber, cellLineNumber, sideOfNode, captureCodeSelection, isCodeSelection, selectionLabel };`);
  }, domBundle);
}

interface MeasuredRow {
  path: string | null;
  change: string | null;
  truthOld: number | null;
  truthNew: number | null;
  readOld: number | null;
  readNew: number | null;
  /** 代码格自己的读数：Rapid Diffs 里行号格是代码格的兄弟节点，这一层最容易串侧别。 */
  cellOld: number | null;
  cellNew: number | null;
  long: boolean;
  text: string;
}

/** 逐行读一次：真值取 GitLab 自己写的属性，读数走 src/core/dom-line-number.ts。 */
const measureRows = `
;(function () {
  const n = (v) => (v === undefined || v === null || Number.isNaN(v) ? null : v);
  const num = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  const attr = (el, name) => (el ? el.getAttribute(name) : null);
  const truthOf = (row) => {
    const out = { old: null, new: null, path: null };
    const host = row.closest('diff-file');
    if (host) { try { out.path = JSON.parse(host.getAttribute('data-file-data') || '{}').new_path ?? null; } catch { /* 忽略坏 JSON */ } }
    const holder = row.closest('[data-path]');
    if (holder) out.path = out.path || holder.getAttribute('data-path');
    // rapid：两个 td.rd-line-number[data-position] 各带一个 a[data-line-number]
    for (const cell of row.querySelectorAll('td.rd-line-number')) {
      const link = cell.querySelector('a[data-line-number]');
      if (!link) continue;
      out[cell.getAttribute('data-position') === 'old' ? 'old' : 'new'] = num(link.getAttribute('data-line-number'));
    }
    // classic 19.x grid：side wrapper 上的 data-interop-old-line / data-interop-new-line 才分得清两侧
    out.old = out.old ?? num(attr(row.querySelector('[data-interop-old-line]'), 'data-interop-old-line'));
    out.new = out.new ?? num(attr(row.querySelector('[data-interop-new-line]'), 'data-interop-new-line'));
    // 老版：行号格里的 a[data-linenumber] / a[data-line-number]
    const gutter = (side) => {
      const scoped = row.querySelector('.' + side + '_line a[data-linenumber], .' + side + '_line a[data-line-number]');
      return num(attr(scoped, 'data-linenumber') ?? attr(scoped, 'data-line-number'));
    };
    out.old = out.old ?? gutter('old');
    out.new = out.new ?? gutter('new');
    return out;
  };
  const rows = [...document.querySelectorAll('tr.rd-hunk-lines, div.line_holder')];
  const measured = [];
  for (const row of rows) {
    const truth = truthOf(row);
    if (truth.old === null && truth.new === null) continue;
    const content = row.querySelector('.rd-line-content, .line_content');
    const change = row.querySelector('[data-change]')?.getAttribute('data-change')
      ?? (truth.old && truth.new ? 'context' : truth.new ? 'added' : 'removed');
    measured.push({
      path: truth.path, change, truthOld: truth.old, truthNew: truth.new,
      readOld: n(window.__ra.rowLineNumber(row, 'old')),
      readNew: n(window.__ra.rowLineNumber(row, 'new')),
      cellOld: n(window.__ra.cellLineNumber(content, 'old', row)),
      cellNew: n(window.__ra.cellLineNumber(content, 'new', row)),
      long: (content?.textContent || '').length > 400,
      text: (content?.textContent || '').trim().slice(0, 40),
    });
  }
  return measured;
})()
`;

/** 19.x 的 diff 按视口虚拟化：滚一遍把每个文件的行都收进来，按 (path, 行号, 文本) 去重。 */
async function collectRows(page: Page): Promise<MeasuredRow[]> {
  const all: MeasuredRow[] = [];
  const collect = async () => {
    const rows = await page.evaluate(measureRows) as MeasuredRow[];
    for (const row of rows) {
      const seen = all.some((item) => item.path === row.path && item.truthOld === row.truthOld
        && item.truthNew === row.truthNew && item.text === row.text);
      if (!seen) all.push(row);
    }
  };
  await collect();
  for (let step = 0; step < 22; step += 1) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(300);
    await collect();
  }
  return all;
}

test.describe('行内评论矩阵（真实 GitLab）', () => {
  test.skip(!isRealGitlab, '跳过真实 GitLab 矩阵测试（未设置 GITLAB_URL + GITLAB_MR_URL）');
  test.describe.configure({ timeout: 300_000 });

  test('维度①②③④⑥：两种视图下每个 diff 行的行号都读得对', async ({ page }) => {
    const matrix = await ensureMatrixMr();
    test.skip(matrix === undefined, `${matrixProject} 上没能准备好矩阵沙箱 MR（需要 GITLAB_PAT）`);
    await loginToGitLab(page);

    const measured: Record<string, MeasuredRow[]> = {};
    for (const view of ['rapid', 'classic'] as const) {
      await useView(page, view);
      await page.goto(matrix!.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(9000);
      await mountDomReaders(page);
      measured[view] = await collectRows(page);
    }

    for (const view of ['rapid', 'classic'] as const) {
      const rows = measured[view];
      // 视图没渲染出行就是量了个寂寞：先把「确实量到了」钉死
      expect(rows.length, `${view} 视图没读到 diff 行`).toBeGreaterThan(20);
      expect(new Set(rows.map((row) => row.path)).size, `${view} 视图只渲染了一个文件`).toBeGreaterThan(2);

      const wrong = rows.filter((row) => row.readOld !== row.truthOld || row.readNew !== row.truthNew);
      expect(wrong.map((row) => `${view} ${row.path} ${row.change} truth=${row.truthOld}/${row.truthNew} read=${row.readOld}/${row.readNew} "${row.text}"`),
        `${view} 视图有行号读错的行`).toEqual([]);

      // 代码格也要读得出来（划词落在代码上时先读行容器、再读格子），且增/删行不存在的另一侧必须是空
      const wrongCell = rows.filter((row) => row.cellOld !== row.truthOld || row.cellNew !== row.truthNew);
      expect(wrongCell.map((row) => `${view} ${row.path} ${row.change} truth=${row.truthOld}/${row.truthNew} cell=${row.cellOld}/${row.cellNew} "${row.text}"`),
        `${view} 视图有代码格行号读错的行`).toEqual([]);

      // 三种 diff 行形态都要真的量到，否则「全对」没有意义
      for (const change of ['added', 'removed', 'context']) {
        expect(rows.filter((row) => row.change === change).length, `${view} 视图没量到 ${change} 行`).toBeGreaterThan(0);
      }
      // 上下文行两侧号码不同（前面有插入）才算真验到了分侧读法
      expect(rows.some((row) => row.change === 'context' && row.truthOld !== row.truthNew), `${view} 视图没有两侧号码不同的上下文行`).toBe(true);
      expect(rows.some((row) => row.long), `${view} 视图没量到超长行`).toBe(true);
    }

    // 文件形态覆盖：新文件 / 重命名 / 删除 / 普通修改都要在 rapid 视图里量到
    const rapidPaths = new Set(measured.rapid.map((row) => row.path));
    for (const path of ['matrix/added.ts', 'matrix/renamed-v2.ts', 'matrix/deleted.ts', 'matrix/modified.ts']) {
      expect(rapidPaths.has(path), `rapid 视图没渲染 ${path}`).toBe(true);
    }
  });

  test('维度⑤：三种拖选形态都拿得到路径、侧别与行号', async ({ page }) => {
    const matrix = await ensureMatrixMr();
    test.skip(matrix === undefined, `${matrixProject} 上没能准备好矩阵沙箱 MR（需要 GITLAB_PAT）`);
    await loginToGitLab(page);

    for (const view of ['rapid', 'classic'] as const) {
      await useView(page, view);
      await page.goto(matrix!.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(9000);
      await mountDomReaders(page);

      const rowSelector = view === 'rapid' ? 'tr.rd-hunk-lines' : 'div.line_holder';
      const cellSelector = view === 'rapid' ? 'td.rd-line-content' : '[data-testid$="-content"], .line_content';
      const cellAt = (index: number) => page.locator(rowSelector).nth(index).locator(cellSelector).first();

      /**
       * 挑「此刻真的都在视口里、且 DOM 上相邻」的两行：19.x 两种渲染都按视口虚拟化，
       * 没滚到的行要么不在 DOM 里、要么坐标在几千像素外，硬编码行号拖不出真人能拖出的选区。
       */
      const pickVisibleRows = () => page.evaluate(() => {
        const rows = [...document.querySelectorAll('tr.rd-hunk-lines, div.line_holder')];
        const cellOf = (row: Element) => row.querySelector('.rd-line-content, .line_content');
        const hostOf = (row: Element) => row.closest('diff-file') ?? row.closest('.diff-file');
        const pathOf = (row: Element) => {
          const host = hostOf(row);
          const direct = host?.getAttribute('data-path');
          if (direct) return direct;
          try { return JSON.parse(host?.getAttribute('data-file-data') ?? '{}').new_path ?? null; } catch { return null; }
        };
        const numberOf = (row: Element, side: 'old' | 'new') => {
          const rapid = row.querySelector(`td.rd-line-number[data-position="${side}"] a[data-line-number]`);
          if (rapid) return Number(rapid.getAttribute('data-line-number'));
          const interop = row.querySelector(`[data-interop-${side}-line]`);
          if (interop) return Number(interop.getAttribute(`data-interop-${side}-line`));
          const gutter = row.querySelector(`.${side}_line a[data-linenumber], .${side}_line a[data-line-number]`);
          return gutter ? Number(gutter.getAttribute('data-linenumber') ?? gutter.getAttribute('data-line-number')) : Number.NaN;
        };
        const onScreen = (row: Element) => {
          const box = row.getBoundingClientRect();
          return box.height > 8 && box.y > 130 && box.y + box.height < window.innerHeight - 40;
        };
        const usable = (row: Element) => onScreen(row) && (cellOf(row)?.textContent ?? '').trim().length >= 12;
        const isRemoved = (row: Element) => row.querySelector('[data-change="removed"]') !== null
          || row.querySelector('.line_content.old') !== null;

        let pair: { indexA: number; indexB: number; lineA: number; lineB: number; path: string | null } | null = null;
        let removed: { index: number; line: number; path: string | null } | null = null;
        for (let index = 0; index + 1 < rows.length; index += 1) {
          const row = rows[index];
          if (removed === null && isRemoved(row) && usable(row)) {
            const line = numberOf(row, 'old');
            if (Number.isFinite(line)) removed = { index, line, path: pathOf(row) };
          }
          if (pair !== null) continue;
          const next = rows[index + 1];
          if (hostOf(next) !== hostOf(row) || isRemoved(row) || isRemoved(next)) continue;
          if (!usable(row) || !usable(next)) continue;
          const lineA = numberOf(row, 'new');
          const lineB = numberOf(next, 'new');
          if (!Number.isFinite(lineA) || !Number.isFinite(lineB) || lineB <= lineA) continue;
          pair = { indexA: index, indexB: index + 1, lineA, lineB, path: pathOf(row) };
        }
        return { pair, removed, total: rows.length };
      });

      /** 滚到视口中间：rapid 的文件头是 sticky 的，贴在顶上的行会被盖住，拖下去选不到字。 */
      const centerOn = async (index: number) => {
        await cellAt(index).evaluate((node: Element) => node.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(600);
      };

      // 逐个候选行滚过去，直到当前视口里真的凑出一对相邻行（外加一行删除行）
      let pair: { indexA: number; indexB: number; lineA: number; lineB: number; path: string | null } | null = null;
      let removed: { index: number; line: number; path: string | null } | null = null;
      const rowCount = await page.locator(rowSelector).count();
      for (let candidate = 0; candidate < rowCount && (pair === null || removed === null); candidate += 1) {
        await centerOn(candidate);
        const visible = await pickVisibleRows();
        pair ??= visible.pair;
        if (removed === null && visible.removed) {
          await centerOn(visible.removed.index);
          removed = (await pickVisibleRows()).removed;
        }
      }
      expect(pair, `${view} 视图找不到屏幕上相邻的两行可拖`).not.toBeNull();
      expect(removed, `${view} 视图找不到屏幕上的删除行`).not.toBeNull();

      const drag = async (fromIndex: number, to: number | 'panel') => {
        // diff 是异步渲染的，拖拽撞上行内节点被换掉就会选空：重试到真有选区为止
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // 每次重试都先把行滚回视口中间：虚拟化渲染下坐标随时会过期，拖着屏幕外的点会选到导航栏
          await centerOn(fromIndex);
          if (to !== 'panel') await centerOn(to);
          const first = (await cellAt(fromIndex).boundingBox())!;
          const end = to === 'panel'
            ? { x: 1270, y: first.y, height: first.height, width: 8 }
            : (await cellAt(to).boundingBox())!;
          await page.mouse.move(first.x + 10, first.y + first.height / 2);
          await page.mouse.down();
          await page.mouse.move(end.x + Math.min(200, end.width - 10), end.y + end.height / 2, { steps: 12 });
          await page.mouse.up();
          await page.waitForTimeout(400);
          const captured = await page.evaluate(() => {
            const selection = window.__ra.captureCodeSelection(document, '');
            const dom = document.getSelection();
            return {
              selected: (dom?.toString() ?? '').slice(0, 60),
              cap: selection ? { ...selection, isCode: window.__ra.isCodeSelection(selection) } : null,
            };
          });
          await page.evaluate(() => document.getSelection()?.removeAllRanges());
          if (captured.cap?.isCode) return captured.cap;
        }
        return null;
      };

      const single = await drag(pair!.indexA, pair!.indexA);
      const cross = await drag(pair!.indexA, pair!.indexB);
      // 面板 fixed 盖在右侧：终点拖到视口右缘（面板位置），选区不能被当成「面板内选区」丢掉
      const outside = await drag(pair!.indexA, 'panel');
      const deleted = await drag(removed!.index, removed!.index);

      for (const [label, captured] of [['single', single], ['cross', cross], ['end-on-panel', outside]] as const) {
        expect(captured, `${view} 视图 ${label} 拖选没拿到代码选区`).not.toBeNull();
        expect(captured!.filePath, `${view} 视图 ${label} 拖选没读到文件路径`).toBe(pair!.path);
        expect(captured!.startLine, `${view} 视图 ${label} 拖选行号读错`).toBe(pair!.lineA);
        expect(captured!.side, `${view} 视图 ${label} 拖选侧别读错`).toBe('new');
      }
      expect(cross!.endLine, `${view} 视图跨行拖选没收敛出 endLine`).toBe(pair!.lineB);
      expect(outside!.endLine! >= outside!.startLine!, `${view} 视图终点落面板外时 endLine 反而变小`).toBe(true);
      // 删除行只有旧侧行号：拖上去必须判成 old 侧，否则发布位置会挂到不存在的新侧行
      expect(deleted, `${view} 视图删除行拖选没拿到代码选区`).not.toBeNull();
      expect(deleted!.side, `${view} 视图删除行侧别读错`).toBe('old');
      expect(deleted!.startLine, `${view} 视图删除行行号读错`).toBe(removed!.line);
    }
  });

  test('维度②③：真实 position 逐形态发一遍，GitLab 全收；发不了的必须给 reasonCode', async () => {
    const matrix = await ensureMatrixMr();
    test.skip(matrix === undefined, `${matrixProject} 上没能准备好矩阵沙箱 MR（需要 GITLAB_PAT）`);
    const project = encodeURIComponent(matrix!.projectPath);
    const files = matrix!.files;
    const created: string[] = [];

    const draft = (input: Partial<Finding> & { path: string; line: number }): Finding => ({
      id: `matrix-${Math.random().toString(36).slice(2)}`, fingerprint: 'matrix',
      endLine: input.line, side: 'new', category: 'bug', severity: 'medium', confidence: 'high',
      title: 'MATRIX', content: 'inline publish matrix probe', evidence: [],
      existingCode: '', suggestionCode: '', comment: `MATRIX-PROBE ${input.path}:${input.line}`,
      source: 'model', status: 'draft', ...input,
    } as Finding);

    const publish = async (candidate: Finding) => {
      const position = resolvePublishPosition(candidate, files);
      if (!position.publishable) return { position, status: undefined as number | undefined };
      const anchored = position.finding;
      const discussionPosition: DiscussionPosition = {
        path: anchored.path, oldPath: anchored.oldPath, newPath: anchored.newPath,
        startLine: anchored.line, endLine: anchored.endLine, side: anchored.side,
        ...position.lines, diffRefs: matrix!.diffRefs,
      };
      const response = await fetch(
        `${realGitlabUrl}/api/v4/projects/${project}/merge_requests/${matrix!.iid}/discussions`,
        {
          method: 'POST',
          headers: { 'PRIVATE-TOKEN': gitlabPat, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: buildDiscussionPayload({ body: `MATRIX-PROBE ${anchored.path}:${anchored.line}`, position: discussionPosition }).toString(),
        },
      );
      const body = await response.text();
      if (response.status < 300) {
        const noteId = (JSON.parse(body) as { notes?: { id: number }[] }).notes?.[0]?.id;
        if (noteId) created.push(String(noteId));
      }
      return { position, status: response.status, detail: body.slice(0, 200) };
    };

    const shapeOf = (file: FileDiff) => (file.newFile ? 'new-file'
      : file.deletedFile ? 'deleted-file' : file.renamedFile ? 'renamed-file' : 'modified-file');

    const results: { shape: string; kind: string; path: string; line: number; side: string; status?: number; reasonCode?: string; corrected?: boolean; outLine?: number; detail?: string }[] = [];
    for (const file of files) {
      const shape = shapeOf(file);
      const path = file.deletedFile ? file.oldPath : file.newPath;
      for (const kind of ['added', 'removed', 'context'] as const) {
        const line = file.lines.find((item) => item.kind === kind);
        if (!line) continue;
        const side = kind === 'removed' ? 'old' : 'new';
        const lineNo = (side === 'new' ? line.newLine : line.oldLine)!;
        const outcome = await publish(draft({ path, line: lineNo, endLine: lineNo, side, existingCode: line.text }));
        results.push({
          shape, kind, path, line: lineNo, side, status: outcome.status,
          reasonCode: outcome.position.reasonCode, corrected: outcome.position.corrected,
          outLine: outcome.position.finding.line, detail: outcome.detail,
        });
      }
      // diff 之外的行（完整文件上下文里模型看得到的那些）：GitLab 一律不收，必须有明确 reasonCode
      const headPath = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
      if (!file.deletedFile && file.lines.length > 0) {
        const inDiff = new Set(file.lines.map((item) => item.newLine));
        const raw = await gitlabApi(`/projects/${project}/repository/files/${encodeURIComponent(headPath)}/raw?ref=${matrix!.diffRefs.headSha}`);
        const outside = String(raw.data).split('\n')
          .map((text, index) => ({ text, line: index + 1 }))
          .find((item) => item.text.trim().length > 8 && !inDiff.has(item.line));
        if (outside) {
          const outcome = await publish(draft({
            path: headPath, line: outside.line, endLine: outside.line, existingCode: outside.text,
            anchor: { source: 'full-file', publishable: false },
          }));
          results.push({
            shape, kind: 'outside-diff', path: headPath, line: outside.line, side: 'new', status: outcome.status,
            reasonCode: outcome.position.reasonCode, corrected: outcome.position.corrected,
            outLine: outcome.position.finding.line, detail: outcome.detail,
          });
        }
      }
    }

    /**
     * 收尾：矩阵自己发出去的评论一条不留。留着的行内评论会在 diff 行之间撑出 notes_holder，
     * 下一次跑 DOM 矩阵时行与行就不相邻了（删讨论要用 notes 端点，discussions?note_id= 在 19.x 上 404）。
     */
    const noteIds = [...created];
    for (let round = 0; round < 20; round += 1) {
      const leftover = await gitlabApi(`/projects/${project}/merge_requests/${matrix!.iid}/discussions?per_page=100`);
      const list = Array.isArray(leftover.data) ? leftover.data : [];
      const strays = list.flatMap((discussion: any) => (discussion.notes ?? [])
        .filter((note: any) => typeof note.body === 'string' && note.body.startsWith('MATRIX-PROBE'))
        .map((note: any) => note.id));
      if (strays.length === 0) break;
      noteIds.push(...strays);
      for (const id of strays) {
        await gitlabApi(`/projects/${project}/merge_requests/${matrix!.iid}/notes/${id}`, { method: 'DELETE' });
      }
    }
    for (const id of created) {
      await gitlabApi(`/projects/${project}/merge_requests/${matrix!.iid}/notes/${id}`, { method: 'DELETE' });
    }
    const afterClean = await gitlabApi(`/projects/${project}/merge_requests/${matrix!.iid}/discussions?per_page=100`);
    const leftovers = (Array.isArray(afterClean.data) ? afterClean.data : [])
      .filter((discussion: any) => String(discussion.notes?.[0]?.body ?? '').startsWith('MATRIX-PROBE'));
    expect(leftovers, '矩阵没有把自己发出的行内评论清理干净').toHaveLength(0);

    const inline = results.filter((row) => row.kind !== 'outside-diff');
    const rejected = inline.filter((row) => row.status !== 201);
    expect(rejected, '真实 diff 行上发行内评论被 GitLab 拒了').toEqual([]);
    // 每种文件形态都要真的发出去过，否则覆盖率是假的
    for (const shape of ['new-file', 'deleted-file', 'renamed-file', 'modified-file']) {
      expect(inline.some((row) => row.shape === shape && row.status === 201), `${shape} 没有成功发出行内评论`).toBe(true);
    }
    /**
     * diff 之外的行：GitLab 收不下（实测把「隐藏的 N 行」全展开也没用，REST 的 position 校验只认 3 行上下文的 diff）。
     * 允许的结局只有两种，且都不能悄悄挂在模型报的那一行上：
     *   ① 判为不可发布并给出 reasonCode（UI 明示为什么是全文评论）
     *   ② 按 existingCode 重定位到 diff 内的行，并打上 corrected 标记（UI 明示改了行号）
     */
    const outside = results.filter((row) => row.kind === 'outside-diff');
    expect(outside.length, '没量到 diff 之外的行').toBeGreaterThan(0);
    for (const row of outside) {
      const blockedWithReason = row.status === undefined && Boolean(row.reasonCode);
      const relocatedAndFlagged = row.status === 201 && row.corrected === true && row.outLine !== row.line;
      expect(
        blockedWithReason || relocatedAndFlagged,
        `diff 之外的行既没说原因也没标记重定位：${row.path}:${row.line} → ${JSON.stringify(row)}`,
      ).toBe(true);
    }
  });

  test('维度③：被评审 MR 上 GitLab 自己标的文件状态如实透传', async () => {
    // 用户实际在评审的 MR：GitLab 对超出上限的文件给 too_large/collapsed 标记并且不返回 diff 内容
    const ref = /^(?:https?:\/\/[^/]+)?\/(?<project>.+)\/-\/merge_requests\/(?<iid>\d+)/.exec(realMrUrl)?.groups;
    test.skip(ref === undefined, 'GITLAB_MR_URL 不是 MR diffs 地址');
    const project = encodeURIComponent(ref!.project);
    const raw = await gitlabApi(`/projects/${project}/merge_requests/${ref!.iid}/diffs?per_page=100`);
    const flagged = (Array.isArray(raw.data) ? raw.data : [])
      .filter((item: any) => item.too_large || item.collapsed || item.generated_file || (item.diff === '' && item.renamed_file));
    test.skip(flagged.length === 0, '这个 MR 上没有被 GitLab 标记的文件');

    const files = (raw.data as any[]).map(normalizeFileDiff);
    for (const item of flagged) {
      const file = files.find((candidate) => candidate.newPath === item.new_path)!;
      expect(file.tooLarge, `${item.new_path} 的 too_large 没透传`).toBe(Boolean(item.too_large));
      expect(file.collapsed, `${item.new_path} 的 collapsed 没透传`).toBe(Boolean(item.collapsed));
      expect(file.generated, `${item.new_path} 的 generated_file 没透传`).toBe(Boolean(item.generated_file));
      if (item.too_large || item.collapsed) {
        expect(file.diff, `${item.new_path} 被 GitLab 标记却还带了 diff 内容`).toBe('');
        const position = resolvePublishPosition({
          id: 'flagged', fingerprint: 'fp', path: item.new_path, line: 5, endLine: 5, side: 'new',
          category: 'bug', severity: 'medium', confidence: 'high', title: 'T', content: 'C', evidence: [],
          existingCode: 'anything', suggestionCode: '', comment: 'C', source: 'model', status: 'draft',
        } as Finding, files);
        expect(position.publishable, `${item.new_path} 不该被判为可发行内`).toBe(false);
        expect(position.reasonCode).toBe('diff-collapsed');
        expect(position.reason, `${item.new_path} 的原因文案没说清 GitLab 的标记`).toContain(
          item.too_large ? '过大' : '折叠',
        );
      }
    }
  });

  test('维度③：GitLab 折叠掉的文件（空 diff）给出专门的原因，幻影行不再混进 diff', async () => {
    const matrix = await ensureMatrixMr();
    test.skip(matrix === undefined, `${matrixProject} 上没能准备好矩阵沙箱 MR（需要 GITLAB_PAT）`);
    const files = matrix!.files;

    // 末尾换行切出来的空串不是 diff 行：混进去会多出一个不存在的行号，发出去必被 400
    for (const file of files) {
      const last = file.lines.at(-1);
      expect(last?.text === '' && last?.kind === 'context', `${file.newPath} 末尾多了一行幻影 context`).toBe(false);
    }

    const collapsed = normalizeFileDiff({ old_path: 'apps/report/index.html', new_path: 'apps/report/index.html', diff: '' });
    const position = resolvePublishPosition({
      id: 'collapsed', fingerprint: 'fp', path: 'apps/report/index.html', line: 12, endLine: 12, side: 'new',
      category: 'bug', severity: 'medium', confidence: 'high', title: 'T', content: 'C', evidence: [],
      existingCode: '<html></html>', suggestionCode: '', comment: 'C', source: 'model', status: 'draft',
    } as Finding, [collapsed, ...files]);

    expect(position.publishable).toBe(false);
    expect(position.reasonCode).toBe('diff-collapsed');
    expect(position.reason).toContain('没有返回');
  });
});
