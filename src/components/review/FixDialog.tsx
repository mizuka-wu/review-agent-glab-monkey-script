import { AlertTriangle, FileCode2, GitCommitVertical, RefreshCw } from 'lucide-react';
import { Banner, Btn, Spinner, tokens as C } from '../ui/modern';
import { Dialog } from './PublishDialog';
import type { FixPlan } from '../../core/finding-fix';
import { findingLocation } from '../../core/findings';
import type { Finding } from '../../core/types';

/** generating = 正在拉文件 / 等模型；ready = 拿到修复方案等确认；committing = 正在提交。 */
export type FixStage = 'generating' | 'ready' | 'committing';

const monoStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, lineHeight: 1.55,
};

function diffColor(line: string) {
  if (line.startsWith('+')) return { background: '#e9f7ef', color: '#14663c' };
  if (line.startsWith('-')) return { background: '#fdecec', color: '#8b1a1a' };
  if (line.startsWith('@@')) return { background: C.primaryLight, color: C.primary };
  return { background: 'transparent', color: C.textSecondary };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, marginBottom: 4 }}>{children}</div>;
}

export function FixDialog({ finding, plan, stage, error, meta, onCancel, onRetry, onConfirm }: {
  finding: Finding;
  /** 生成失败时为空：弹窗只展示原因，确认按钮不可用，不落半截结果。 */
  plan?: FixPlan;
  stage: FixStage;
  error: string;
  meta: { projectPath: string; mergeRequestIid?: number; branch: string };
  onCancel: () => void;
  onRetry: () => void;
  onConfirm: () => void;
}) {
  const busy = stage !== 'ready';
  const change = plan?.changes[0];
  // --- / +++ 是文件头，不算改动行
  const changedLines = plan
    ? plan.patch.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length
    : 0;

  return (
    <Dialog
      labelId="fix-title"
      title="应用修复"
      subtitle={`${meta.projectPath}${meta.mergeRequestIid ? ` · MR !${meta.mergeRequestIid}` : ''} · 提交到源分支 ${meta.branch}`}
      onClose={stage === 'committing' ? () => undefined : onCancel}
      footer={
        <>
          <Btn variant="outline" onClick={onCancel} disabled={stage === 'committing'}>取消</Btn>
          <Btn variant="ghost" icon={<RefreshCw size={13} />} onClick={onRetry} disabled={busy}>重新生成</Btn>
          <Btn
            variant="primary" icon={<GitCommitVertical size={13} />} loading={stage === 'committing'}
            disabled={!plan || busy}
            title={plan ? `提交到 ${meta.branch}` : '修复方案还没生成成功'}
            onClick={onConfirm}
          >
            {stage === 'committing' ? '提交中…' : '确认提交'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div style={{ padding: '8px 10px', background: C.bgSubtle, border: `1px solid ${C.border}`, borderRadius: C.radiusSm }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary }}>{finding.title}</div>
          <div style={{ marginTop: 3, fontSize: 11, color: C.textMuted, ...monoStyle }}>{findingLocation(finding)}</div>
        </div>

        {stage === 'generating' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 2px', color: C.textMuted, fontSize: 12 }}>
            <Spinner size={14} />
            正在读取 {finding.path} 的当前内容并生成修复…
          </div>
        )}

        {error && (
          <Banner tone="danger" icon={<AlertTriangle size={14} />} title={plan ? '提交没有成功' : '修复没有生成'}>
            {error}
          </Banner>
        )}

        {plan && change && (
          <>
            <div>
              <SectionLabel>将提交的文件</SectionLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', background: C.bgSubtle, border: `1px solid ${C.border}`, borderRadius: C.radiusSm }}>
                <span style={{ display: 'flex', color: C.textMuted }}><FileCode2 size={13} /></span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: C.text, ...monoStyle }}>
                  {change.path}
                </span>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: C.warningBg, color: C.warning }}>
                  {change.action === 'create' ? '新增' : '修改'}
                </span>
                <span style={{ fontSize: 10, color: C.textMuted, ...monoStyle }}>{changedLines} 行变更</span>
              </div>
            </div>

            <div>
              <SectionLabel>Diff 预览</SectionLabel>
              <pre
                className="ra-scroll" aria-label="修复 Diff 预览"
                style={{
                  margin: 0, padding: '6px 8px', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word', border: `1px solid ${C.border}`, borderRadius: C.radiusSm, background: C.bg,
                  ...monoStyle,
                }}
              >
                {plan.patch.split('\n').map((line, index) => (
                  <div key={index} style={diffColor(line)}>{line || ' '}</div>
                ))}
              </pre>
            </div>

            <div>
              <SectionLabel>Commit 信息（直接复用 Finding）</SectionLabel>
              <div style={{ padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: C.radiusSm, background: C.bg }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{plan.message}</div>
                <pre
                  className="ra-scroll"
                  style={{
                    margin: '5px 0 0', maxHeight: 130, overflow: 'auto', whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word', fontSize: 11, lineHeight: 1.5, color: C.textMuted,
                    fontFamily: 'inherit',
                  }}
                >
                  {plan.description}
                </pre>
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: C.textMuted }}>
                只写入源分支 <code style={monoStyle}>{meta.branch}</code>，目标分支不受影响；提交后可在 MR 里看到这次改动。
              </div>
            </div>
          </>
        )}

      </div>
    </Dialog>
  );
}
