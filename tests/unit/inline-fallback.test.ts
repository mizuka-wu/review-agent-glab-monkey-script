import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePublishPosition } from '../../src/core/anchor';
import { debugBus } from '../../src/core/debug-bus';
import { normalizeFileDiff } from '../../src/core/diff';
import {
  INLINE_FALLBACK_PREFIX, formatInlineFallback, inlineFallbackCause, logInlineFallback, positionParams,
} from '../../src/core/inline-fallback';
import type { DiscussionPosition, Finding } from '../../src/core/types';

const TOKEN = 'glpat-SuperSecretTokenValue123';
/** 服务端拒绝的原话：400 的 body 才是定位降级的关键证据，必须原样进日志。 */
const REJECTION = "Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}";

const finding = (input: Partial<Finding> = {}): Finding => ({
  id: 'f1', fingerprint: 'fp', path: 'src/payment.ts', line: 9, endLine: 10, side: 'new',
  category: 'security', severity: 'high', confidence: 'high', title: '硬编码密钥', content: 'Content',
  evidence: [], existingCode: 'const apiKey = "sk-live-1";', suggestionCode: '', comment: 'Comment',
  source: 'model', status: 'draft',
  ...input,
});

const payment = normalizeFileDiff({
  old_path: 'src/payment.ts', new_path: 'src/payment.ts',
  diff: '@@ -8,3 +8,5 @@\n function pay() {\n+  const apiKey = "sk-live-1";\n+  return charge(apiKey);\n }',
});

const diffRefs = { baseSha: 'base-sha', headSha: 'head-sha-abcdef', startSha: 'start-sha' };

/** 行内可发布时的校验结果：App 发布时手里的就是这一份。 */
const publishable = () => resolvePublishPosition(finding(), [payment]);

/** 行内不可发布（路径不在 diff 里）时的校验结果。 */
const blocked = () => resolvePublishPosition(
  finding({ id: 'b1', path: 'src/missing.ts', line: 42, endLine: 42, existingCode: 'nope();' }),
  [payment],
);

const attempted: DiscussionPosition = {
  path: 'src/payment.ts', oldPath: 'src/payment.ts', newPath: 'src/payment.ts',
  startLine: 9, endLine: 10, side: 'new',
  start: { newLine: 9 }, end: { newLine: 10 },
  diffRefs,
};

const rejected = {
  finding: finding(),
  position: publishable(),
  attempted,
  downgrade: { reason: `GitLab 拒绝了这个行内位置（${REJECTION}）`, status: 400, serverMessage: `GitLab API 400：{"message":"400 Bad request - ${REJECTION}"}` },
  files: [payment],
  diffRefs,
  body: 'Comment',
};

const text = (lines: string[]) => lines.join('\n');

beforeEach(() => {
  debugBus.clear('all');
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('降级判定：只有「本来要发行内、结果发成全文」才算', () => {
  it('行内被 GitLab 拒了 → inline-rejected，带上状态码与服务端原话', () => {
    expect(inlineFallbackCause(rejected)).toMatchObject({
      cause: 'inline-rejected', reasonCode: 'inline-rejected', status: 400,
    });
    expect(inlineFallbackCause(rejected)?.reason).toContain('line_code');
    expect(inlineFallbackCause(rejected)?.serverMessage).toContain('400 Bad request');
  });

  it('发布前就判定行内不可用 → position-blocked，reasonCode 取自锚定结果', () => {
    const cause = inlineFallbackCause({ finding: blocked().finding, position: blocked(), files: [payment], diffRefs });
    expect(cause).toMatchObject({ cause: 'position-blocked', reasonCode: 'path-not-in-diff' });
    expect(cause?.reason).toContain('不在当前 Diff 中');
  });

  it('用户主动发全文（没有位置校验信息、也没有服务端拒绝）不算降级', () => {
    expect(inlineFallbackCause({ finding: finding(), body: 'Comment' })).toBeUndefined();
    expect(inlineFallbackCause({ finding: finding(), position: publishable(), attempted, body: 'Comment' })).toBeUndefined();
  });
});

describe('日志内容：原因 + 当时的完整参数，用户复制 console 就能发来排查', () => {
  it('每行都带 [inline-fallback] 前缀，能整段复制也能单行 grep', () => {
    const lines = formatInlineFallback(rejected, inlineFallbackCause(rejected)!);
    expect(lines.length).toBeGreaterThan(6);
    expect(lines.every((line) => line.startsWith(`${INLINE_FALLBACK_PREFIX} `))).toBe(true);
    expect(lines[0]).toContain('行内评论降级为全文评论');
  });

  it('行内被拒：还原实际发出的 position 全量参数、diff_refs 与服务端响应', () => {
    const log = text(formatInlineFallback(rejected, inlineFallbackCause(rejected)!));
    expect(log).toContain('reasonCode=inline-rejected');
    expect(log).toContain('status=400');
    expect(log).toContain('position[position_type]=text');
    expect(log).toContain('position[base_sha]=base-sha');
    expect(log).toContain('position[head_sha]=head-sha-abcdef');
    expect(log).toContain('position[new_path]=src/payment.ts');
    expect(log).toContain('position[old_path]=src/payment.ts');
    expect(log).toContain('position[new_line]=10');
    expect(log).toContain('position[line_range][start][new_line]=9');
    expect(log).toContain('position[line_range][end][new_line]=10');
    expect(log).toContain('head_sha=head-sha-abcdef');
    expect(log).toContain('server: HTTP 400');
    expect(log).toContain('line_code');
    expect(log).toContain('side=new');
    expect(log).toContain('lineKind=added');
    // GitLab 到底给了这个文件的哪些行：「第 N 行为什么不在 diff 里」的直接答案
    expect(log).toContain('diff: file=src/payment.ts');
    expect(log).toContain('newLines=8-11');
    expect(log).toContain('oldLines=8-9');
    // 正文不进日志，只留长度
    expect(log).toContain('body=7 字符');
    expect(log).not.toContain('Comment');
  });

  it('发布前拦下：说清 position 没发出，并给出 reasonCode、锚定输入与结果', () => {
    const blockedPosition = blocked();
    const log = text(formatInlineFallback(
      { finding: blockedPosition.finding, position: blockedPosition, files: [payment], diffRefs },
      inlineFallbackCause({ finding: blockedPosition.finding, position: blockedPosition })!,
    ));
    expect(log).toContain('reasonCode=path-not-in-diff');
    expect(log).toContain('cause=position-blocked');
    expect(log).toContain('position: 未发出（发布前已判定行内不可用）');
    expect(log).toContain('anchor-input: path=src/missing.ts · line=42 · side=new');
    expect(log).toContain('snippet=1 行/7 字符');
    expect(log).toContain('head_sha=head-sha-abcdef');
    expect(log).toContain('diff: 当前 Diff 里没有 src/missing.ts（共 1 个文件）');
    expect(log).not.toContain('server:');
  });

  it('锚定后的位置带上真实 diff 行号配对（GitLab 就是按这个算 line_code）', () => {
    const log = text(formatInlineFallback(rejected, inlineFallbackCause(rejected)!));
    expect(log).toContain('anchor-result: source=diff · publishable=true');
    expect(log).toContain('lines.end={new_line=10}');
    expect(positionParams(attempted)).toContain('position[head_sha]=head-sha-abcdef');
  });

  it('页面上有这一行时记录行号来源（span id / data 属性）与视图类型', () => {
    document.body.innerHTML = `
      <div class="diff-file" data-file-path="src/payment.ts">
        <table class="text-file"><tbody>
          <tr class="line_holder" id="abc1234_8_9">
            <td class="old_line line_numbers"></td>
            <td class="new_line line_numbers"><a data-line-number="9" href="#abc1234_8_9">9</a></td>
            <td class="line_content new"><span id="LC9">  const apiKey = "sk-live-1";</span></td>
          </tr>
        </tbody></table>
      </div>`;
    const log = text(formatInlineFallback(rejected, inlineFallbackCause(rejected)!));
    expect(log).toContain('view=classic');
    expect(log).toContain('rowFound=true');
    expect(log).toContain('rowId=abc1234_8_9');
    expect(log).toContain('lineCode=abc1234_8_9');
    expect(log).toContain('data-line-number=9');
    expect(log).toContain('id#LC9');
  });

  it('页面是 Rapid Diffs 时如实报视图类型，找不到行就说找不到', () => {
    document.body.innerHTML = '<div class="rd-diff-file"><table><tbody><tr class="rd-hunk-lines">'
      + '<td class="rd-line-number" data-position="new"><a class="rd-line-link" data-line-number="3">3</a></td>'
      + '<td class="rd-line-content">code</td></tr></tbody></table></div>';
    const log = text(formatInlineFallback(rejected, inlineFallbackCause(rejected)!));
    expect(log).toContain('view=rapid');
    expect(log).toContain('rowFound=false');
  });

  it('带选区时把选区一起记下来', () => {
    const log = text(formatInlineFallback(
      { ...rejected, selection: { filePath: 'src/payment.ts', side: 'new', startLine: 9, endLine: 10, text: 'x'.repeat(30), top: 0, left: 0 } },
      inlineFallbackCause(rejected)!,
    ));
    expect(log).toContain('selection: payment.ts:9-10 · side=new · 30 字符');
  });

  it('PAT / token 永不进日志：设置里的令牌、服务端 body、代码片段都脱敏或只记规模', () => {
    const log = text(formatInlineFallback({
      ...rejected,
      finding: finding({ existingCode: `const token = "${TOKEN}";`, comment: TOKEN }),
      downgrade: { reason: `GitLab 拒绝了这个行内位置（${TOKEN}）`, status: 400, serverMessage: `GitLab API 400：{"message":"unauthorized ${TOKEN}"}` },
      body: TOKEN,
    }, inlineFallbackCause({
      ...rejected,
      downgrade: { reason: TOKEN, status: 400, serverMessage: TOKEN },
    })!));
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('SuperSecret');
    expect(log).toContain('[REDACTED]');
    expect(log).toContain(`body=${TOKEN.length} 字符`);
  });
});

describe('发布出口：降级才出声，console 与调试面板各留一份', () => {
  it('降级时 console.warn 打整段现场，调试面板同步留一条完整日志', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cause = logInlineFallback(rejected);

    expect(cause?.cause).toBe('inline-rejected');
    expect(warn).toHaveBeenCalledTimes(1);
    const printed = String(warn.mock.calls[0][0]);
    expect(printed).toContain(`${INLINE_FALLBACK_PREFIX} 行内评论降级为全文评论`);
    expect(printed).toContain('reasonCode=inline-rejected');
    expect(printed).toContain('position[head_sha]=head-sha-abcdef');
    expect(printed).toContain('server: HTTP 400');

    const entries = debugBus.getLogs().filter((entry) => entry.source === 'publish');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'warn' });
    expect(entries[0].message.startsWith(INLINE_FALLBACK_PREFIX)).toBe(true);
    expect(entries[0].detail).toContain('reason:');
    expect(entries[0].detail).toContain('position[head_sha]=head-sha-abcdef');
    // 导出包里也得有，用户不打开 console 也能导出发来
    expect(debugBus.exportBundle()).toContain('inline-fallback');
  });

  it('主动发全文（不是降级）不打这条日志', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(logInlineFallback({ finding: finding(), body: 'Comment' })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(debugBus.getLogs()).toHaveLength(0);
  });

  it('行内发布成功也不打', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(logInlineFallback({ finding: finding(), position: publishable(), attempted, body: 'Comment' })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
