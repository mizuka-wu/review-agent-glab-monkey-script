import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePublishPosition } from '../../src/core/anchor';
import { debugBus } from '../../src/core/debug-bus';
import { normalizeFileDiff } from '../../src/core/diff';
import { createReanchorSession, toDiscussionPosition, type ReanchorSource } from '../../src/core/reanchor';
import type { DiscussionPosition, FileDiff, MergeRequestContext } from '../../src/core/types';

const OLD_REFS = { baseSha: 'base-1', headSha: 'head-1', startSha: 'start-1' };
const NEW_REFS = { baseSha: 'base-1', headSha: 'head-2', startSha: 'start-1' };

/** 评审时的 diff：apiKey 在新侧第 9 行。 */
const oldFiles: FileDiff[] = [normalizeFileDiff({
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  diff: '@@ -8,2 +8,4 @@\n function pay() {\n+  const apiKey = "sk-live-1";\n+  return charge(apiKey);\n }',
})];

/** push 之后的 diff：上面多插了一行，apiKey 落到新侧第 10 行。 */
const newFiles: FileDiff[] = [normalizeFileDiff({
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  diff: '@@ -8,2 +8,5 @@\n function pay() {\n+  const traceId = nextTraceId();\n+  const apiKey = "sk-live-1";\n+  return charge(apiKey);\n }',
})];

/** push 之后这段代码整个没了：只剩另一个函数的 diff。 */
const rewrittenFiles: FileDiff[] = [normalizeFileDiff({
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  diff: '@@ -40,2 +40,3 @@\n function refund() {\n+  return gateway.refund();\n }',
})];

const context = (headSha: string): MergeRequestContext => ({
  origin: 'https://gitlab.test', projectPath: 'acme/app', mergeRequestIid: 248,
  title: 'pay', description: '', state: 'opened', sourceBranch: 'feature/pay', targetBranch: 'main',
  sha: headSha, diffRefs: { baseSha: 'base-1', headSha, startSha: 'start-1' },
});

const finding = {
  id: 'f1', fingerprint: 'fp', path: 'src/payment.ts', line: 9, endLine: 9, side: 'new' as const,
  category: 'security', severity: 'high' as const, confidence: 'high' as const,
  title: '硬编码密钥', content: '密钥不能写死', evidence: [],
  existingCode: 'const apiKey = "sk-live-1";', suggestionCode: '', comment: 'Comment',
  source: 'model' as const, status: 'draft' as const,
  anchor: { source: 'diff' as const, publishable: true },
};

const stalePosition: DiscussionPosition = {
  path: 'src/payment.ts', oldPath: 'src/payment.ts', newPath: 'src/payment.ts',
  startLine: 9, endLine: 9, side: 'new', start: { newLine: 9 }, end: { newLine: 9 },
  diffRefs: OLD_REFS,
};

/**
 * 默认按 push 之后的 MR 建模；files 可以换成「代码已被改掉」的版本。
 * 快照一次给出 diff_refs 与 diff：这两样必须同源，分开取就会拿旧行号配新 sha（GitLab 直接 400）。
 */
function source(options: { files?: FileDiff[]; fail?: string } = {}): ReanchorSource & {
  snapshotCalls: () => number;
} {
  const fetchSnapshot = options.fail
    ? vi.fn(async (): Promise<{ context: MergeRequestContext; files: FileDiff[] }> => {
      throw new Error(options.fail);
    })
    : vi.fn(async () => ({ context: context(NEW_REFS.headSha), files: options.files ?? newFiles }));
  return { fetchSnapshot, snapshotCalls: () => fetchSnapshot.mock.calls.length };
}

beforeEach(() => {
  debugBus.clear('all');
});

describe('toDiscussionPosition', () => {
  it('把 anchor 的解析结果翻成 GitLab 行内 position，不可发布就不给位置', () => {
    const publishable = resolvePublishPosition(finding, oldFiles);
    expect(toDiscussionPosition(publishable, OLD_REFS)).toMatchObject({
      path: 'src/payment.ts', startLine: 9, endLine: 9, side: 'new',
      start: { newLine: 9 }, end: { newLine: 9 }, diffRefs: OLD_REFS,
    });

    const blocked = resolvePublishPosition(
      { ...finding, path: 'src/missing.ts', existingCode: 'nothingLikeThis();' }, oldFiles,
    );
    expect(blocked.publishable).toBe(false);
    expect(toDiscussionPosition(blocked, OLD_REFS)).toBeUndefined();
  });
});

describe('409 重锚会话', () => {
  it('重新拉 diff_refs + diff，在新 diff 上按内容重算行号', async () => {
    const session = createReanchorSession(source());

    const result = await session.reanchor(finding, stalePosition);

    expect(result.reason).toBeUndefined();
    expect(result.position).toMatchObject({
      path: 'src/payment.ts', startLine: 10, endLine: 10, side: 'new',
      start: { newLine: 10 }, end: { newLine: 10 }, diffRefs: NEW_REFS,
    });
    expect(session.snapshot()?.context.diffRefs).toEqual(NEW_REFS);
    expect(debugBus.getCounters()['publish-409-refresh']).toBe(1);
  });

  it('旧行号在 push 之后指向别的代码时不按行号硬发，只认内容', async () => {
    const session = createReanchorSession(source());

    const result = await session.reanchor(finding, stalePosition);

    // 新 diff 的第 9 行是 traceId：行号一律不采信，按内容重定位到第 10 行
    expect(result.position?.startLine).toBe(10);
    expect(resolvePublishPosition(finding, newFiles).finding.line).toBe(10);
    expect(session.positionFor(finding)?.publish.corrected).toBe(true);
  });

  it('整批只刷新一次：连续重锚共用同一份 diff_refs 与 diff', async () => {
    const deps = source();
    const session = createReanchorSession(deps);

    await session.reanchor(finding, stalePosition);
    await session.reanchor({ ...finding, id: 'f2' }, stalePosition);
    await session.reanchor({ ...finding, id: 'f3' }, stalePosition);

    expect(deps.snapshotCalls()).toBe(1);
    expect(debugBus.getCounters()['publish-409-refresh']).toBe(1);
  });

  it('刷新过以后 positionFor 直接给新位置：后续评论不必各自撞一次 409', async () => {
    const session = createReanchorSession(source());
    expect(session.positionFor(finding)).toBeUndefined();
    expect(session.snapshot()).toBeUndefined();

    await session.reanchor(finding, stalePosition);

    const shared = session.positionFor({ ...finding, id: 'f2', line: 10, existingCode: 'return charge(apiKey);' });
    expect(shared?.position).toMatchObject({ startLine: 11, endLine: 11, diffRefs: NEW_REFS });
  });

  it('文件被 push 改掉、内容也找不到时给出原因，不硬发位置', async () => {
    const session = createReanchorSession(source({ files: rewrittenFiles }));

    const result = await session.reanchor(finding, stalePosition);

    expect(result.position).toBeUndefined();
    expect(result.reason).toContain('找不到');
    expect(session.positionFor(finding)?.publish.publishable).toBe(false);
    expect(debugBus.getLogs().some((entry) => entry.message.includes('409 重锚后仍定位不到行内位置'))).toBe(true);
  });

  it('重新拉快照失败时给出原因，不把异常抛回发布链路', async () => {
    const session = createReanchorSession(source({ fail: 'GitLab API 500：boom' }));

    const result = await session.reanchor(finding, stalePosition);

    expect(result.position).toBeUndefined();
    expect(result.reason).toContain('重新拉取 MR diff_refs 失败');
    expect(result.reason).toContain('boom');
    expect(session.snapshot()).toBeUndefined();
    // 失败也不再重试：整批只刷一次
    expect(await session.reanchor({ ...finding, id: 'f2' }, stalePosition)).toEqual(result);
  });

  it('重锚出的位置带新 head_sha，旧 position 的 head_sha 不再出现', async () => {
    const session = createReanchorSession(source());

    const { position } = await session.reanchor(finding, stalePosition);

    expect(position?.diffRefs.headSha).toBe('head-2');
    expect(JSON.stringify(position)).not.toContain('head-1');
  });
});
