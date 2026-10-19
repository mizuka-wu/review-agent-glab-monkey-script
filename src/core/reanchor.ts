/**
 * 行内评论 409（position 的 base_sha / head_sha 与 MR 当前 diff_refs 不匹配）后的重锚。
 *
 * 跑完评审到点发布之间，MR 常被 push 新 commit：head_sha 一变，之前算好的 position 全部作废，
 * 老逻辑一撞 409 就整批降级成 MR 级全文评论——这是用户反馈里最高频的降级原因，而 409 本身只说明
 * 「手里拿的是旧 diff_refs」。重新拉一次 MR 的 diff_refs + diff、在新 diff 上重跑 anchor
 * （内容印证 / 模糊修正 / 全文那条既有降级链照走），行内位置基本都能救回来。
 *
 * 会话按「一次发布动作」共享：整批只刷新一次，第一条 409 之后剩下的评论直接用新 refs 重算位置，
 * 不必每条各自撞一次 409。重锚只由 409 触发、每条评论只重锚一次，不存在循环。
 */
import { resolvePublishPosition, type PublishPosition } from './anchor';
import { debugBus } from './debug-bus';
import type {
  DiffRefs,
  DiscussionPosition,
  FileDiff,
  Finding,
  MergeRequestContext,
  PositionReanchorResult,
} from './types';


/**
 * 重锚要重新读的那一份快照：diff_refs 与 diff 必须来自同一次响应。
 * 分两次请求取 sha 与行号，中间 MR 被 push 就会拿旧行号配新 sha（或反过来），
 * GitLab 一律以 `line_code can't be blank` 400 拒掉，比 409 更难查。
 */
export interface ReanchorSource {
  fetchSnapshot: () => Promise<ReanchorSnapshot>;
}

/** 重锚后的位置：publish 是 anchor 的完整解析结果（不可发布时带原因），position 只有可发布时才有。 */
export interface ReanchorPosition {
  publish: PublishPosition;
  position?: DiscussionPosition;
}

export interface ReanchorSnapshot {
  context: MergeRequestContext;
  files: FileDiff[];
}

export interface ReanchorSession {
  /** 刷新出来的 MR 上下文与 diff；这一批还没撞过 409 时为 undefined。 */
  snapshot(): ReanchorSnapshot | undefined;
  /** 批量共享：刷新过就用新 diff + 新 refs 重算位置，后续评论不必各自撞一次 409。 */
  positionFor(finding: Finding): ReanchorPosition | undefined;
  /** 409 后重锚一次：给出新 position，或给出重锚不出来的原因（交给降级文案）。 */
  reanchor(finding: Finding, from: DiscussionPosition): Promise<PositionReanchorResult>;
}

/**
 * anchor 的解析结果 → GitLab 行内评论要的 position；不可发布返回 undefined。
 * 没有真实 diff 行的行号配对（publish.lines）也返回 undefined：缺了配对只能按 side 填一侧，
 * context 行那样填 GitLab 直接 400，宁可降级为全文评论。
 */
export function toDiscussionPosition(publish: PublishPosition, diffRefs: DiffRefs): DiscussionPosition | undefined {
  if (!publish.publishable || !publish.lines) return undefined;
  const finding = publish.finding;
  return {
    path: finding.path,
    oldPath: finding.oldPath ?? finding.path,
    newPath: finding.newPath ?? finding.path,
    startLine: finding.line,
    endLine: finding.endLine,
    side: finding.side,
    ...publish.lines,
    diffRefs,
  };
}

const short = (sha: string) => sha.slice(0, 8);

export function createReanchorSession(source: ReanchorSource): ReanchorSession {
  let snapshot: ReanchorSnapshot | undefined;
  let pending: Promise<ReanchorSnapshot | undefined> | undefined;
  let failure: string | undefined;

  /** 整批只刷新一次：并发调用共用同一个 Promise，拉取失败也不重试，别把发布链路拖住。 */
  const refresh = () => {
    pending ??= source.fetchSnapshot()
      .then((fresh): ReanchorSnapshot | undefined => {
        snapshot = fresh;
        debugBus.count('publish-409-refresh');
        debugBus.log('info', 'publish', 'MR 已更新，重新拉取了同源的 diff_refs 与 diff', [
          `head=${short(fresh.context.diffRefs.headSha)}`,
          `base=${short(fresh.context.diffRefs.baseSha)}`,
          `start=${short(fresh.context.diffRefs.startSha)}`,
          `files=${fresh.files.length}`,
        ].join(' · '));
        return snapshot;
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error.message : String(error);
        debugBus.log('warn', 'publish', '重锚失败：重新拉取 MR diff 快照出错', failure);
        return undefined;
      });
    return pending;
  };

  // 位置只从新快照的真实 diff 行上重新锚定：旧行号一律不采信（resolvePublishPosition 本来也不采信）
  const resolve = (finding: Finding, refs: ReanchorSnapshot): ReanchorPosition => {
    const publish = resolvePublishPosition(finding, refs.files);
    return { publish, position: toDiscussionPosition(publish, refs.context.diffRefs) };
  };

  return {
    snapshot: () => snapshot,
    positionFor: (finding) => (snapshot ? resolve(finding, snapshot) : undefined),

    async reanchor(finding, from) {
      const refs = await refresh();
      if (!refs) return { reason: `重新拉取 MR diff_refs 失败：${failure ?? '未知原因'}` };
      const { publish, position } = resolve(finding, refs);
      const moved = `oldHead=${short(from.diffRefs.headSha)} · oldLine=${from.startLine} → newHead=${short(refs.context.diffRefs.headSha)}`;
      if (!position) {
        const reason = publish.reason ?? '新的 Diff 中找不到这一行';
        debugBus.log('warn', 'publish', `409 重锚后仍定位不到行内位置，降级为全文评论 ${finding.path}:${finding.line}`,
          `code=${publish.reasonCode ?? 'unknown'} · ${moved} · reason=${reason}`);
        return { reason };
      }
      debugBus.log('info', 'publish', `409 重锚：已在新 diff 上重新定位行内位置 ${finding.path}`,
        `${moved} · newLine=${position.startLine}${position.endLine > position.startLine ? `-${position.endLine}` : ''}`);
      return { position };
    },
  };
}
