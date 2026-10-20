import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { resolvePublishPosition } from '../../src/core/anchor';
import { debugBus } from '../../src/core/debug-bus';
import { buildDiscussionPayload, GitLabAdapter } from '../../src/core/gitlab-adapter';
import { CURL_TOKEN_PLACEHOLDER, PUBLISH_REQUEST_PREFIX } from '../../src/core/publish-request-log';
import { toDiscussionPosition } from '../../src/core/reanchor';
import { sha1Hex } from '../../src/core/sha1';
import type {
  DiscussionPosition, DiffLine, FileDiff, Finding, MergeRequestRef, PageContext,
} from '../../src/core/types';

/**
 * anchor → GitLab position 的真实链路验证（真实 GitLab）。
 *
 * inline-matrix 量的是「拿真实行号 + 真实代码发得出去吗」；这里量的是产品真正走的那条路：
 * 模型报的行号一律不采信，位置由当前 diff 的真实行重新锚定，sha 与行号取自同一份版本响应。
 * 三类行都要真的 201，锚不上的必须在发请求之前就降级，400 一条都不许出现。
 */

const realGitlabUrl = process.env.GITLAB_URL || '';
const realMrUrl = process.env.GITLAB_MR_URL || '';
const gitlabPat = process.env.GITLAB_PAT || '';
const isRealGitlab = Boolean(realGitlabUrl && realMrUrl);

/** 沙箱 MR：只读它们的 diff，发出去的评论跑完全部删掉。 */
const SANDBOXES = [
  { projectPath: 'test/test', iid: 7 },
  { projectPath: 'test/test', iid: 6 },
  { projectPath: 'test/y-mxgraph', iid: 1 },
];

const MARKER = 'POSITION-REANCHOR-PROBE';

function loose(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/** 用生产代码读快照：diff_refs 与 diff 必须同源，测试里另抄一份就读不出改动。 */
function adapterFor(projectPath: string, iid: number) {
  const page: PageContext = { origin: realGitlabUrl, route: 'diff', projectPath, mergeRequestIid: iid };
  const fetcher = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set('PRIVATE-TOKEN', gitlabPat);
    return fetch(String(input), { ...init, headers });
  };
  return new GitLabAdapter(page, '', fetcher);
}

function refFor(sandbox: { projectPath: string; iid: number }): MergeRequestRef {
  return { origin: realGitlabUrl, projectPath: sandbox.projectPath, mergeRequestIid: sandbox.iid };
}

async function postDiscussion(
  sandbox: { projectPath: string; iid: number },
  position: DiscussionPosition,
  body: string,
) {
  const response = await fetch(
    `${realGitlabUrl}/api/v4/projects/${encodeURIComponent(sandbox.projectPath)}/merge_requests/${sandbox.iid}/discussions`,
    {
      method: 'POST',
      // form 编码的嵌套 position 在老 GitLab + GM 链路上会被解析成畸形结构（400 position 必须是有效的 json schema）：一律发 JSON
      headers: { 'PRIVATE-TOKEN': gitlabPat, 'Content-Type': 'application/json' },
      body: buildDiscussionPayload({ body, position }),
    },
  );
  return { status: response.status, text: await response.text() };
}

const draft = (input: Partial<Finding> & { path: string; line: number }): Finding => ({
  id: `probe-${Math.random().toString(36).slice(2)}`, fingerprint: 'probe',
  endLine: input.line, side: 'new', category: 'bug', severity: 'medium', confidence: 'high',
  title: 'PROBE', content: 'position reanchor probe', evidence: [],
  existingCode: '', suggestionCode: '', comment: `${MARKER} ${input.path}:${input.line}`,
  source: 'model', status: 'draft', ...input,
} as Finding);

/** 这一行在同侧真实 diff 行里是不是唯一：不唯一的片段本来就该判多候选，不能拿来验 201。 */
function uniqueOnSide(file: FileDiff, row: DiffLine, side: 'old' | 'new') {
  const wanted = loose(row.text);
  const same = file.lines.filter((line) =>
    (side === 'new' ? line.newLine : line.oldLine) !== undefined && loose(line.text) === wanted);
  return same.length === 1;
}

/** 连续两行组成的片段在该侧真实 diff 行里是不是只出现一次：不唯一的会被 anchor 判多候选。 */
function snippetUnique(file: FileDiff, rows: DiffLine[], side: 'old' | 'new') {
  const target = rows.map((row) => loose(row.text));
  const entries = file.lines.filter((line) => (side === 'new' ? line.newLine : line.oldLine) !== undefined);
  let hits = 0;
  for (let index = 0; index + target.length <= entries.length; index += 1) {
    if (target.every((text, offset) => loose(entries[index + offset].text) === text)) hits += 1;
  }
  return hits === 1;
}

function pickRow(file: FileDiff, kind: DiffLine['kind']) {
  return file.lines
    .filter((row) => row.kind === kind && row.text.trim().length >= 12)
    .find((row) => uniqueOnSide(file, row, kind === 'removed' ? 'old' : 'new'));
}

/** 沙箱 MR 上跑完就把探针评论删干净：留下的评论会污染后面每一次 DOM / 发布验证。 */
async function cleanProbes(sandbox: { projectPath: string; iid: number }) {
  const project = encodeURIComponent(sandbox.projectPath);
  const api = async (path: string, method = 'GET') => {
    const response = await fetch(`${realGitlabUrl}/api/v4${path}`, {
      method, headers: { 'PRIVATE-TOKEN': gitlabPat },
    });
    const text = await response.text();
    try { return { status: response.status, data: JSON.parse(text) as unknown } } catch { return { status: response.status, data: text } }
  };
  for (let round = 0; round < 20; round += 1) {
    const listed = await api(`/projects/${project}/merge_requests/${sandbox.iid}/discussions?per_page=100`);
    const discussions = Array.isArray(listed.data) ? listed.data as { notes?: { id: number; body?: string }[] }[] : [];
    const strays = discussions.flatMap((discussion) => (discussion.notes ?? [])
      .filter((note) => typeof note.body === 'string' && note.body.startsWith(MARKER))
      .map((note) => note.id));
    if (strays.length === 0) return;
    for (const id of strays) {
      await api(`/projects/${project}/merge_requests/${sandbox.iid}/notes/${id}`, 'DELETE');
    }
  }
}

/** 真实发出的那份 JSON body 里的 position：断言一律走解析后的结构。 */
interface SentEndpoint { line_code?: string; type?: string; old_line?: number; new_line?: number }
interface SentPosition {
  position_type?: string; base_sha?: string; head_sha?: string; start_sha?: string;
  old_path?: string; new_path?: string; old_line?: number; new_line?: number;
  line_range?: { start: SentEndpoint; end: SentEndpoint };
}

function sentPosition(position: DiscussionPosition, body: string): SentPosition {
  const payload = buildDiscussionPayload({ body, position });
  expect(payload, '发布 body 里不许再有 form 平铺键').not.toContain('position[');
  return (JSON.parse(payload) as { position?: SentPosition }).position!;
}

interface Row {
  sandbox: string;
  kind: string;
  path: string;
  modelLine: number;
  realLine: number;
  side: string;
  status?: number;
  detail?: string;
  params: SentPosition;
  reasonCode?: string;
  corrected?: boolean;
}

test.describe('anchor → GitLab position 重新锚定（真实 GitLab）', () => {
  test.skip(!isRealGitlab, '需要 GITLAB_URL / GITLAB_MR_URL');
  test.skip(!gitlabPat, '需要 GITLAB_PAT');
  test.describe.configure({ timeout: 300_000 });

  test('三类 diff 行都按内容重新锚定后真实发布 201，模型行号故意报偏也照样挂对行', async () => {
    const results: Row[] = [];

    for (const sandbox of SANDBOXES) {
      const adapter = adapterFor(sandbox.projectPath, sandbox.iid);
      const snapshot = await adapter.fetchMrDiffSnapshot(refFor(sandbox));
      const label = `${sandbox.projectPath}!${sandbox.iid}`;

      // 快照自带的三个 sha 都得有值：position 的 diff_refs 只能从这一份取
      expect(snapshot.context.diffRefs.headSha, `${label} 快照没有 head_sha`).toMatch(/^[0-9a-f]{7,40}$/);
      expect(snapshot.context.diffRefs.baseSha, `${label} 快照没有 base_sha`).toMatch(/^[0-9a-f]{7,40}$/);
      expect(snapshot.context.diffRefs.startSha, `${label} 快照没有 start_sha`).toMatch(/^[0-9a-f]{7,40}$/);
      expect(snapshot.files.length, `${label} 快照没有 diff`).toBeGreaterThan(0);

      for (const file of snapshot.files) {
        for (const kind of ['added', 'removed', 'context'] as const) {
          const row = pickRow(file, kind);
          if (!row) continue;
          const side = kind === 'removed' ? 'old' : 'new';
          const realLine = (side === 'new' ? row.newLine : row.oldLine)!;
          const path = file.newPath === '/dev/null' ? file.oldPath : file.newPath;

          // 模型行号整体报偏 11 行：位置必须由内容重新锚定回来，而不是拿这个行号发出去
          const candidate = draft({
            path, line: realLine + 11, endLine: realLine + 11, side, existingCode: row.text,
            comment: `${MARKER} ${label} ${kind} ${path}:${realLine}`,
          });
          const publish = resolvePublishPosition(candidate, snapshot.files);
          const position = toDiscussionPosition(publish, snapshot.context.diffRefs);

          expect(publish.publishable, `${label} ${kind} 行没能重新锚定：${publish.reason}`).toBe(true);
          expect(publish.corrected, `${label} ${kind} 行没有标记为重新锚定`).toBe(true);
          expect(publish.finding.line, `${label} ${kind} 行锚错了行`).toBe(realLine);
          expect(publish.finding.path).toBe(path);

          const params = sentPosition(position!, candidate.comment);
          // 三类行各自的行号配对：added 只有 new_line、removed 只有 old_line、context 两个都有
          if (kind === 'added') {
            expect(params.new_line, `${label} added 行少了 new_line`).toBe(realLine);
            expect(params.old_line, `${label} added 行多带了 old_line`).toBeUndefined();
          } else if (kind === 'removed') {
            expect(params.old_line, `${label} removed 行少了 old_line`).toBe(realLine);
            expect(params.new_line, `${label} removed 行多带了 new_line`).toBeUndefined();
          } else {
            expect(params.new_line, `${label} context 行少了 new_line`).toBe(row.newLine);
            expect(params.old_line, `${label} context 行少了 old_line`).toBe(row.oldLine);
          }
          // 路径必须是 diff 里的真实路径：rename 时两侧各写各的，且不许带 a/ b/ 前缀
          expect(params.new_path).toBe(file.newPath === '/dev/null' ? file.oldPath : file.newPath);
          expect(params.old_path).toBe(file.oldPath === '/dev/null' ? file.newPath : file.oldPath);
          expect(params.base_sha).toBe(snapshot.context.diffRefs.baseSha);
          expect(params.head_sha).toBe(snapshot.context.diffRefs.headSha);
          expect(params.start_sha).toBe(snapshot.context.diffRefs.startSha);

          const posted = await postDiscussion(sandbox, position!, candidate.comment);
          results.push({
            sandbox: label, kind, path, modelLine: realLine + 11, realLine, side,
            status: posted.status, detail: posted.text.slice(0, 200), params,
            corrected: publish.corrected,
          });
        }
      }
    }

    await Promise.all(SANDBOXES.map((sandbox) => cleanProbes(sandbox)));

    for (const kind of ['added', 'removed', 'context']) {
      expect(results.filter((row) => row.kind === kind && row.status === 201).length,
        `${kind} 行没有真实发布成功过`).toBeGreaterThan(0);
    }
    const rejected = results.filter((row) => row.status !== 201);
    expect(rejected.map((row) => `${row.sandbox} ${row.kind} ${row.path}:${row.realLine} → ${row.status} ${row.detail}`),
      '重新锚定后的 position 被 GitLab 拒了').toEqual([]);
    expect(results.filter((row) => row.status === 400), '出现了 400').toHaveLength(0);
    expect(results.length, '三类行没都量到').toBeGreaterThanOrEqual(3);

    // 评论清零
    for (const sandbox of SANDBOXES) {
      const response = await fetch(
        `${realGitlabUrl}/api/v4/projects/${encodeURIComponent(sandbox.projectPath)}/merge_requests/${sandbox.iid}/discussions?per_page=100`,
        { headers: { 'PRIVATE-TOKEN': gitlabPat } },
      );
      const discussions = await response.json() as { notes?: { body?: string }[] }[];
      const leftovers = discussions.filter((discussion) =>
        String(discussion.notes?.[0]?.body ?? '').startsWith(MARKER));
      expect(leftovers, `${sandbox.projectPath}!${sandbox.iid} 上留下了探针评论`).toHaveLength(0);
    }
  });

  test('锚不上就在发请求之前降级：无匹配 / 多候选都不猜行号', async () => {
    const sandbox = SANDBOXES[0];
    const adapter = adapterFor(sandbox.projectPath, sandbox.iid);
    const snapshot = await adapter.fetchMrDiffSnapshot(refFor(sandbox));
    const file = snapshot.files.find((candidate) => pickRow(candidate, 'added') ?? pickRow(candidate, 'context'));
    test.skip(file === undefined, '沙箱 MR 里没有可用的 diff 行');

    const row = pickRow(file!, 'added') ?? pickRow(file!, 'context')!;
    const path = file!.newPath === '/dev/null' ? file!.oldPath : file!.newPath;
    const realLine = row.newLine ?? row.oldLine!;

    // ① 行号是真实 diff 行，但内容与那一行对不上 → 无匹配，不发请求
    const contradicted = resolvePublishPosition(draft({
      path, line: realLine, endLine: realLine,
      existingCode: `const notInTheDiff_${Date.now()} = 1;`,
    }), snapshot.files);
    expect(contradicted.publishable).toBe(false);
    expect(contradicted.reasonCode).toBe('reanchor-no-match');
    expect(contradicted.reason).toContain('重新锚定失败：无匹配');
    expect(toDiscussionPosition(contradicted, snapshot.context.diffRefs)).toBeUndefined();

    // ② 完全没有可比对内容 → 也不拿行号硬发
    const noSnippet = resolvePublishPosition(draft({ path, line: realLine, endLine: realLine, existingCode: '' }), snapshot.files);
    expect(noSnippet.publishable).toBe(false);
    expect(noSnippet.reasonCode).toBe('reanchor-no-match');
    expect(noSnippet.reason).toContain('没有可比对的代码片段');

    // ③ 同一段代码出现在两个文件里 → 多候选，说清命中几处
    const twin: FileDiff = { ...file!, oldPath: `probe/twin-${file!.oldPath}`, newPath: `probe/twin-${file!.newPath}` };
    const ambiguous = resolvePublishPosition(draft({
      path: 'probe/not-in-mr.ts', line: realLine, endLine: realLine, existingCode: row.text,
    }), [file!, twin]);
    expect(ambiguous.publishable).toBe(false);
    expect(ambiguous.reasonCode).toBe('reanchor-ambiguous');
    expect(ambiguous.reason).toContain('重新锚定失败：多候选');
    expect(ambiguous.reason).toContain('命中 2 处');
    expect(toDiscussionPosition(ambiguous, snapshot.context.diffRefs)).toBeUndefined();

    // ④ 同一文件内同侧重复的行也是多候选（真实 MR 里能找到就用真实的验）
    const repeated = snapshot.files
      .flatMap((candidate) => candidate.lines
        .filter((line) => line.text.trim().length >= 12)
        .filter((line) => !uniqueOnSide(candidate, line, line.kind === 'removed' ? 'old' : 'new'))
        .map((line) => ({ file: candidate, line })))
      .find((entry) => entry.file.lines.filter((candidate) =>
        loose(candidate.text) === loose(entry.line.text)
        && (entry.line.kind === 'removed' ? candidate.oldLine : candidate.newLine) !== undefined).length >= 2);
    if (repeated) {
      const duplicate = resolvePublishPosition(draft({
        path: repeated.file.newPath, line: repeated.line.newLine ?? repeated.line.oldLine!,
        endLine: repeated.line.newLine ?? repeated.line.oldLine!, existingCode: repeated.line.text,
      }), snapshot.files);
      expect(duplicate.publishable, `重复片段应当判多候选：${duplicate.reason}`).toBe(false);
      expect(duplicate.reasonCode).toBe('reanchor-ambiguous');
    }
  });

  test('stale diff_refs：混一次请求的 sha 就会被 GitLab 拒，同源快照才发得出去', async () => {
    const sandbox = SANDBOXES[0];
    const adapter = adapterFor(sandbox.projectPath, sandbox.iid);
    const snapshot = await adapter.fetchMrDiffSnapshot(refFor(sandbox));
    const file = snapshot.files.find((candidate) => pickRow(candidate, 'added') ?? pickRow(candidate, 'context'));
    test.skip(file === undefined, '沙箱 MR 里没有可用的 diff 行');

    const row = pickRow(file!, 'added') ?? pickRow(file!, 'context')!;
    const path = file!.newPath === '/dev/null' ? file!.oldPath : file!.newPath;
    const realLine = row.newLine ?? row.oldLine!;
    const candidate = draft({ path, line: realLine, endLine: realLine, existingCode: row.text });
    const publish = resolvePublishPosition(candidate, snapshot.files);
    expect(publish.publishable).toBe(true);

    // 行号与路径都对，只把 head_sha 换成另一次请求里的 sha（这里用 base_sha 顶替）：GitLab 直接拒
    const stale = toDiscussionPosition(publish, {
      ...snapshot.context.diffRefs, headSha: snapshot.context.diffRefs.baseSha,
    })!;
    const staleBody = `${MARKER} stale-refs ${path}:${realLine}`;
    const rejected = await postDiscussion(sandbox, stale, staleBody);
    expect(rejected.status, `stale head_sha 居然被收下了：${rejected.text}`).toBeGreaterThanOrEqual(400);

    // 同一份快照出来的 refs + 行号才是同源的：一模一样的行号，只换回快照里的 sha 就 201
    const fresh = toDiscussionPosition(publish, snapshot.context.diffRefs)!;
    const accepted = await postDiscussion(sandbox, fresh, `${MARKER} fresh-refs ${path}:${realLine}`);

    await cleanProbes(sandbox);

    expect(accepted.status, `同源快照的 position 被拒了：${accepted.text}`).toBe(201);
    // 400 归零：能被脚本发出去的 position 里不再有「行号对、sha 不对」这种形态
    const leftover = await fetch(
      `${realGitlabUrl}/api/v4/projects/${encodeURIComponent(sandbox.projectPath)}/merge_requests/${sandbox.iid}/discussions?per_page=100`,
      { headers: { 'PRIVATE-TOKEN': gitlabPat } },
    );
    const discussions = await leftover.json() as { notes?: { body?: string }[] }[];
    expect(discussions.filter((discussion) => String(discussion.notes?.[0]?.body ?? '').startsWith(MARKER))).toHaveLength(0);
  });

  /**
   * line_range 的起止端点只发 line_code + type：old_line / new_line 在 GitLab 16/17 上类型对撞
   * （gitlab#572121）——API 参数层声明成 String、position.json 校验层是 integer|null，
   * 传整数过不了参数层、传字符串过不了 schema 层，两头都是 400。行号一律编进 line_code
   * （`SHA1(path)_old_new`，缺侧为 0）。这里两件事都要量：
   * ① 发出去的端点恰好两个键，line_code 与真实 diff 行的配对逐字对齐；
   * ② 真实 GitLab 照收（201），并且原样把 {line_code, type} 存下来，不自己补行号键。
   */
  test('多行评论：line_range 只发 line_code + type，真实发布仍 201 且被原样存下', async () => {
    const results: {
      sandbox: string; pair: string; path: string; side: string; status?: number; detail?: string;
      params: SentPosition; stored?: unknown; types: string[];
    }[] = [];
    const PER_SANDBOX = 3;
    // 真正量到「缺侧编成 0」的端点数：光看 201 证明不了 added / removed 端点的 line_code 里那个 0
    let zeroEncoded = 0;

    for (const sandbox of SANDBOXES) {
      const label = `${sandbox.projectPath}!${sandbox.iid}`;
      const adapter = adapterFor(sandbox.projectPath, sandbox.iid);
      const snapshot = await adapter.fetchMrDiffSnapshot(refFor(sandbox));
      // 一段连续两行、内容够长、且这一对在文件里唯一（不唯一的片段本来就该判多候选，量不到 201）
      const candidates: { file: FileDiff; rows: [DiffLine, DiffLine]; side: 'old' | 'new'; mixed: boolean }[] = [];
      for (const file of snapshot.files) {
        for (const side of ['new', 'old'] as const) {
          const entries = file.lines.filter((line) => (side === 'new' ? line.newLine : line.oldLine) !== undefined);
          const value = (line: DiffLine) => (side === 'new' ? line.newLine! : line.oldLine!);
          for (let index = 0; index + 1 < entries.length; index += 1) {
            const rows = [entries[index], entries[index + 1]] as [DiffLine, DiffLine];
            if (value(rows[1]) !== value(rows[0]) + 1 || rows[0].hunkId !== rows[1].hunkId) continue;
            if (rows.some((row) => row.text.trim().length < 12)) continue;
            if (!snippetUnique(file, rows, side)) continue;
            candidates.push({ file, rows, side, mixed: rows[0].kind !== rows[1].kind });
          }
        }
      }

      // 起止两行形态不同的优先：一条 payload 就能同时量到 type='old' 与 type='new'
      const picked: typeof candidates = [];
      for (const mixed of [true, false]) {
        for (const candidate of candidates.filter((entry) => entry.mixed === mixed)) {
          const pair = candidate.rows.map((row) => row.kind).join('+');
          if (picked.some((entry) => entry.rows.map((row) => row.kind).join('+') === pair)) continue;
          picked.push(candidate);
        }
      }

      for (const { file, rows, side } of picked.slice(0, PER_SANDBOX)) {
        const path = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
        const startLine = side === 'new' ? rows[0].newLine! : rows[0].oldLine!;
        const snippet = rows.map((row) => row.text).join('\n');
        const pair = rows.map((row) => row.kind).join('+');

        // 模型行号照旧整体报偏 11 行：范围必须由内容重新锚定回真实的两行
        const candidate = draft({
          path, line: startLine + 11, endLine: startLine + 12, side, existingCode: snippet,
          comment: `${MARKER} multiline ${label} ${pair} ${path}:${startLine}`,
        });
        const publish = resolvePublishPosition(candidate, snapshot.files);
        expect(publish.publishable, `${label} ${pair} 多行没能重新锚定：${publish.reason}`).toBe(true);
        expect(publish.finding.line, `${label} ${pair} 多行起点锚错了`).toBe(startLine);
        expect(publish.finding.endLine, `${label} ${pair} 多行终点锚错了`).toBe(startLine + 1);

        const position = toDiscussionPosition(publish, snapshot.context.diffRefs)!;
        const params = sentPosition(position, candidate.comment);

        // line_code 口径照抄 GitLab：SHA1(new_path.presence || old_path)_old_new，缺的一侧补 0
        const fileHash = sha1Hex(String(params.new_path));
        const types: string[] = [];
        for (const endpoint of ['start', 'end'] as const) {
          const sent = params.line_range![endpoint];
          const ref = endpoint === 'start' ? publish.lines!.start : publish.lines!.end;
          expect(sent.line_code, `${label} ${pair} ${endpoint} 缺 line_code`)
            .toBe(`${fileHash}_${ref.oldLine ?? 0}_${ref.newLine ?? 0}`);
          expect(sent.type, `${label} ${pair} ${endpoint} 的 type 不合文档口径`)
            .toBe(ref.oldLine === undefined && ref.newLine !== undefined ? 'new' : 'old');
          // additionalProperties: false，且 gitlab#572121 的对撞键一个都不发：端点恰好两个键
          expect(Object.keys(sent).sort(), `${label} ${pair} ${endpoint} 的键不是 line_code + type`)
            .toEqual(['line_code', 'type']);
          expect(sent.old_line, `${label} ${pair} ${endpoint} 又发了 old_line`).toBeUndefined();
          expect(sent.new_line, `${label} ${pair} ${endpoint} 又发了 new_line`).toBeUndefined();
          types.push(String(sent.type));
          if (ref.oldLine === undefined || ref.newLine === undefined) zeroEncoded += 1;
        }

        const posted = await postDiscussion(sandbox, position, candidate.comment);
        let stored: unknown;
        try {
          stored = (JSON.parse(posted.text) as { notes?: { position?: { line_range?: unknown } }[] })
            .notes?.[0]?.position?.line_range;
        } catch { stored = posted.text.slice(0, 200); }

        results.push({
          sandbox: label, pair, path, side, status: posted.status, detail: posted.text.slice(0, 200),
          params, stored, types,
        });
      }

      await cleanProbes(sandbox);
    }

    expect(results.length, '沙箱 MR 里一段连续两行都没量到').toBeGreaterThan(0);
    const rejected = results.filter((row) => row.status !== 201);
    expect(rejected.map((row) => `${row.sandbox} ${row.pair} ${row.path} → ${row.status} ${row.detail}`),
      '只发 line_code + type 后多行评论被 GitLab 拒了').toEqual([]);
    expect(results.filter((row) => row.status === 400), '出现了 400').toHaveLength(0);

    // GitLab 原样存下我们发的两个键：不会自己补 old_line / new_line，也不会改 line_code / type
    for (const row of results) {
      const stored = row.stored as { start?: Record<string, unknown>; end?: Record<string, unknown> };
      for (const endpoint of ['start', 'end'] as const) {
        const sent = row.params.line_range![endpoint];
        expect(stored?.[endpoint], `${row.sandbox} ${row.pair} ${endpoint} 没被存下来`)
          .toEqual({ line_code: sent.line_code, type: sent.type });
        expect(Object.keys(stored![endpoint]!).sort(), `${row.sandbox} ${row.pair} ${endpoint} 存下来的键不是两个`)
          .toEqual(['line_code', 'type']);
      }
    }

    // type 的三态判定真的被量到：新增行 'new'、上下文 / 删除行 'old'
    const observed = new Set(results.flatMap((row) => row.types));
    expect(observed.has('new'), '没量到新增行端点（type=new）').toBe(true);
    expect(observed.has('old'), '没量到上下文 / 删除行端点（type=old）').toBe(true);
    // 缺侧编进 line_code 的 0 也真的被量到并 201：added 端点 `…_0_N`、removed 端点 `…_N_0`
    expect(zeroEncoded, '一个缺侧编 0 的端点都没量到').toBeGreaterThan(0);
  });

  /**
   * 用户老实例上 0.4.24（JSON 直发）仍然 400，脚本侧的 position 参数已经推断过两轮都没命中，
   * 只剩「真实发出的那一条请求」这一个证据来源。这里在真实 GitLab 上各发一条：
   * ① 故意坏的 position（行号远在 diff 之外）必被拒 → [inline-request] 必须留下 error 级现场，
   *    含完整 URL、headers（PAT 脱敏）、body 原文、响应原文与一条 curl；
   * ② 锚定后的真 position 必 201 → 同样留一份 debug 级现场。
   * 并且把日志里那条 curl 原样执行一遍（只替换 <PAT>）：能跑出同一个 400 才证明用户复制过去就能重放。
   */
  test('发布现场日志：真实 400 带完整请求与可执行 curl，真实 201 打 debug 级', async () => {
    const sandbox = SANDBOXES[0];
    // Playwright 的 Node 环境里没有 document：request() 只在建 POST headers 时读一次页面 csrf meta
    (globalThis as { document?: unknown }).document ??= { querySelector: () => null };
    const adapter = new GitLabAdapter(
      { origin: realGitlabUrl, route: 'diff', projectPath: sandbox.projectPath, mergeRequestIid: sandbox.iid },
      gitlabPat,
    );
    const snapshot = await adapter.fetchMrDiffSnapshot(refFor(sandbox));
    const file = snapshot.files.find((candidate) => pickRow(candidate, 'added') ?? pickRow(candidate, 'context'));
    test.skip(file === undefined, '沙箱 MR 里没有可用的 diff 行');

    const row = pickRow(file!, 'added') ?? pickRow(file!, 'context')!;
    const path = file!.newPath === '/dev/null' ? file!.oldPath : file!.newPath;
    const realLine = row.newLine ?? row.oldLine!;
    const endpoint = `${realGitlabUrl}/api/v4/projects/${encodeURIComponent(sandbox.projectPath)}`
      + `/merge_requests/${sandbox.iid}/discussions`;
    const scenes = () => debugBus.getLogs().filter((entry) => entry.message.startsWith(PUBLISH_REQUEST_PREFIX));
    const text = (entry: { message: string; detail?: string }) => `${entry.message}\n${entry.detail ?? ''}`;

    // ① 坏 position：sha 与路径都真，只有行号在 diff 之外；正文里带一个单引号，顺便验 curl 转义
    const brokenLine = realLine + 900000;
    const brokenBody = `${MARKER} broken-position it's ${path}:${brokenLine}`;
    debugBus.clear('all');
    await expect(adapter.createDiscussion(refFor(sandbox), {
      body: brokenBody,
      position: {
        path, startLine: brokenLine, endLine: brokenLine, side: 'new',
        end: { newLine: brokenLine }, diffRefs: snapshot.context.diffRefs,
      },
    })).rejects.toThrow();

    const failed = scenes();
    expect(failed.length, '真实 400 没留下 [inline-request] 现场').toBe(1);
    expect(failed[0].level).toBe('error');
    const failedText = text(failed[0]);
    expect(failed[0].message).toContain(`POST ${endpoint}`);
    expect(failedText).toMatch(/HTTP \d{3}（失败）/);
    expect(failedText).toContain('payload=inline');
    expect(failedText).toContain('Content-Type=application/json');
    expect(failedText).toContain('Accept=application/json');
    // PAT 脱敏：只留首尾 4 位与长度，原值一个字都不许出现
    expect(failedText).toContain(`PRIVATE-TOKEN=${gitlabPat.slice(0, 4)}…${gitlabPat.slice(-4)}（${gitlabPat.length} 字符）`);
    expect(failedText).not.toContain(gitlabPat);
    // body 原文：position 结构、行号、sha 全在里面，且与实际发出的字节一致
    const sentBody = buildDiscussionPayload({
      body: brokenBody,
      position: {
        path, startLine: brokenLine, endLine: brokenLine, side: 'new',
        end: { newLine: brokenLine }, diffRefs: snapshot.context.diffRefs,
      },
    });
    expect(failedText).toContain(`${PUBLISH_REQUEST_PREFIX} body(${sentBody.length} 字符): ${sentBody}`);
    expect(failedText).toContain(`"new_line":${brokenLine}`);
    expect(failedText).toContain(`"head_sha":"${snapshot.context.diffRefs.headSha}"`);
    // 响应原文：GitLab 自己那句拒绝理由
    expect(failedText).toContain(`${PUBLISH_REQUEST_PREFIX} response: HTTP`);
    expect(failedText).toMatch(/position|line_code|note/i);

    // curl 重放命令：单行、带 <PAT> 占位、body 里的单引号已转义，原样执行得到同一个拒绝
    const curlLine = failedText.split('\n').find((line) => line.includes('curl -sS'));
    expect(curlLine, '现场里没有 curl 重放命令').toBeDefined();
    const command = curlLine!.slice(curlLine!.indexOf('curl -sS'));
    expect(command).toContain(`-X POST '${endpoint}'`);
    expect(command).toContain(`-H 'Content-Type: application/json'`);
    expect(command).toContain(`-H 'PRIVATE-TOKEN: ${CURL_TOKEN_PLACEHOLDER}'`);
    expect(command).toContain(`--data '${sentBody.replace(/'/g, `'\\''`)}'`);
    expect(command).toContain(`it'\\''s`);
    expect(command.split('\n')).toHaveLength(1);
    const replay = execFileSync('bash', ['-c', command.replaceAll(CURL_TOKEN_PLACEHOLDER, gitlabPat)], { encoding: 'utf8' });
    expect(replay, 'curl 重放没跑出 GitLab 的拒绝响应').toMatch(/message|position|line_code/i);

    // ② 真 position：内容重新锚定后真实 201，同样留一份 debug 级现场
    const candidate = draft({
      path, line: realLine + 11, endLine: realLine + 11, side: 'new', existingCode: row.text,
      comment: `${MARKER} request-log ${path}:${realLine}`,
    });
    const publish = resolvePublishPosition(candidate, snapshot.files);
    expect(publish.publishable, `锚定失败：${publish.reason}`).toBe(true);
    const position = toDiscussionPosition(publish, snapshot.context.diffRefs)!;
    debugBus.clear('logs');
    const created = await adapter.createDiscussion(refFor(sandbox), { body: candidate.comment, position });
    expect(created.id).not.toBe('');

    const succeeded = scenes();
    expect(succeeded.length, '真实 201 没留下 [inline-request] 现场').toBe(1);
    expect(succeeded[0].level).toBe('debug');
    const okText = text(succeeded[0]);
    expect(okText).toContain('HTTP 201（成功）');
    expect(okText).toContain('payload=inline');
    expect(okText).toContain(buildDiscussionPayload({ body: candidate.comment, position }));
    expect(okText).toContain('curl -sS -X POST');
    expect(okText).not.toContain(gitlabPat);
    // 面板导出包里也是同一份现场：用户不用翻 console 也能把它发过来
    expect(debugBus.exportBundle()).toContain('inline-request');

    await cleanProbes(sandbox);
  });
});
