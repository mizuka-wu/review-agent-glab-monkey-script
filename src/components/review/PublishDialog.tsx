import { useEffect, type ReactNode } from 'react';
import { AlertTriangle, FileText, MessageSquare, X } from 'lucide-react';
import { Banner, Btn, tokens as C } from '../ui/modern';
import { findingLocation, publishModeLabel, publishModeSummary } from '../../core/findings';
import type { Finding, PublishMode } from '../../core/types';

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 2147483100, display: 'grid', placeItems: 'center',
  padding: 18, background: 'rgba(15,20,30,0.55)', backdropFilter: 'blur(1px)',
};

const dialogStyle: React.CSSProperties = {
  width: 'min(560px, 100%)', maxHeight: 'calc(100vh - 36px)', overflowY: 'auto',
  background: C.bg, border: `1px solid ${C.border}`, borderRadius: C.radiusLg,
  boxShadow: C.shadowLg, display: 'flex', flexDirection: 'column',
};

function Dialog({ labelId, title, subtitle, onClose, children, footer }: {
  labelId: string; title: string; subtitle?: ReactNode; onClose: () => void;
  children: ReactNode; footer: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return; // IME 组合输入中不关弹窗
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={overlayStyle} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section style={dialogStyle} role="dialog" aria-modal="true" aria-labelledby={labelId}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '13px 15px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={labelId} style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>{title}</h2>
            {subtitle && <div style={{ marginTop: 3, fontSize: 11, color: C.textMuted, fontFamily: 'ui-monospace, monospace' }}>{subtitle}</div>}
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}
            style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 2 }}>
            <X size={16} />
          </button>
        </div>
        <div className="ra-scroll" style={{ padding: 15, overflowY: 'auto' }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 15px', borderTop: `1px solid ${C.border}`, background: C.bgSubtle }}>{footer}</div>
      </section>
    </div>
  );
}

export function PublishDialog({ finding, body, onBodyChange, publishing, mode, positionIssue, blockReason, meta, onCancel, onConfirm }: {
  finding: Finding;
  body: string;
  onBodyChange: (value: string) => void;
  publishing: boolean;
  /** 有可用 diff 行号 → 行内评论；没有 → MR 级全文评论。 */
  mode: PublishMode;
  /** 行号无法落到当前 Diff 的原因，用来说明为什么降级为全文评论。 */
  positionIssue?: string;
  /** 会导致发布失败的状态；非空时确认按钮直接禁用。 */
  blockReason?: string;
  meta: { projectPath: string; mergeRequestIid?: number; headSha?: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const inline = mode === 'inline';
  return (
    <Dialog
      labelId="publish-title"
      title={inline ? '发布行内评论' : '发布全文评论'}
      subtitle={`${meta.projectPath}${meta.mergeRequestIid ? ` · MR !${meta.mergeRequestIid}` : ''}${meta.headSha ? ` · head ${meta.headSha.slice(0, 8)}` : ''}`}
      onClose={onCancel}
      footer={
        <>
          <Btn variant="outline" onClick={onCancel}>返回修改</Btn>
          <Btn
            variant="primary" icon={inline ? <MessageSquare size={13} /> : <FileText size={13} />} loading={publishing}
            disabled={!body.trim() || Boolean(blockReason)}
            title={!body.trim() ? '评论内容不能为空' : blockReason}
            onClick={onConfirm}
          >
            {publishing ? '发布中…' : inline ? '确认行内评论' : '确认全文评论'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div style={{ padding: '8px 10px', background: C.bgSubtle, border: `1px solid ${C.border}`, borderRadius: C.radiusSm }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary }}>{finding.title}</div>
          <div style={{ marginTop: 3, fontSize: 11, color: C.textMuted, fontFamily: 'ui-monospace, monospace' }}>
            {inline ? `行内 L${finding.line}${finding.endLine > finding.line ? `-${finding.endLine}` : ''}` : '全文（不带行位置）'} · {findingLocation(finding)}{inline ? ` · ${finding.side === 'new' ? '新版本' : '旧版本'}` : ''}
          </div>
        </div>

        {blockReason && (
          <Banner tone="danger" icon={<AlertTriangle size={14} />} title="当前无法发布">
            {blockReason}
          </Banner>
        )}

        {!blockReason && !inline && (
          <Banner tone="warning" icon={<FileText size={14} />} title="将发布为 MR 级全文评论">
            {positionIssue ?? '当前没有可用的 diff 行号，评论会发布到 MR 评论区，正文里带上文件与行号。'}
          </Banner>
        )}

        {!blockReason && inline && finding.anchor?.corrected && (
          <Banner tone="info" title="评论位置已自动修正">
            原行号不在当前 Diff 行内，已按 Finding 内容重新定位到 {finding.path}:{finding.line}。
          </Banner>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label htmlFor="publish-body" style={{ fontSize: 12, fontWeight: 600, color: C.text }}>评论内容</label>
          <textarea
            id="publish-body" autoComplete="off" value={body} rows={10} onChange={(event) => onBodyChange(event.target.value)}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: C.radiusSm, border: `1.5px solid ${C.border}`,
              fontSize: 12, lineHeight: 1.6, color: C.text, background: C.bg, outline: 'none',
              resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: 11, color: C.textMuted }}>支持 Markdown，发布前可以再编辑一次。</div>
        </div>
      </div>
    </Dialog>
  );
}

export function BatchPublishDialog({ findings, publishing, publishMode, skipped = 0, blockReason, meta, onCancel, onConfirm }: {
  findings: Finding[];
  publishing: boolean;
  /** 每条会发成行内评论还是 MR 级全文评论。 */
  publishMode: (finding: Finding) => PublishMode;
  /** 已勾选但无法发布、会被跳过的条数。 */
  skipped?: number;
  /** 会导致发布失败的状态；非空时确认按钮直接禁用。 */
  blockReason?: string;
  meta: { projectPath: string; mergeRequestIid?: number; headSha?: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const preview = findings.slice(0, 10);
  const inline = findings.filter((finding) => publishMode(finding) === 'inline').length;
  const full = findings.length - inline;
  return (
    <Dialog
      labelId="batch-publish-title"
      title={`批量${publishModeLabel('', inline, full)}`}
      subtitle={`${meta.projectPath}${meta.mergeRequestIid ? ` · MR !${meta.mergeRequestIid}` : ''}${meta.headSha ? ` · head ${meta.headSha.slice(0, 8)}` : ''}`}
      onClose={onCancel}
      footer={
        <>
          <Btn variant="outline" onClick={onCancel}>取消</Btn>
          <Btn
            variant="primary" icon={<MessageSquare size={13} />} loading={publishing}
            disabled={findings.length === 0 || Boolean(blockReason)}
            title={blockReason ?? (findings.length === 0 ? '没有可发布的 Finding' : undefined)}
            onClick={onConfirm}
          >
            {publishing ? '发布中…' : `确认${publishModeLabel('批量', inline, full)} ${findings.length} 条`}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: C.textSecondary }}>
          将为选中的 {findings.length} 个 Finding 逐条创建评论（{publishModeSummary(inline, full) || '无可发布条目'}），
          行内位置不可用的会降级为 MR 级全文评论，失败的条目会保留在列表中。
        </div>
        {blockReason && (
          <Banner tone="danger" icon={<AlertTriangle size={14} />} title="当前无法发布">{blockReason}</Banner>
        )}
        {skipped > 0 && (
          <Banner tone="warning" icon={<AlertTriangle size={14} />} title={`已跳过 ${skipped} 条选中的 Finding`}>
            它们不是待处理草稿，或评论内容为空。
          </Banner>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {preview.map((finding) => (
            <div key={finding.id} style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px',
              background: C.bgSubtle, border: `1px solid ${C.border}`, borderRadius: C.radiusSm,
            }}>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, flexShrink: 0,
                background: finding.source === 'rule' ? C.ruleBg : C.aiBg,
                color: finding.source === 'rule' ? C.rule : C.ai,
              }}>{finding.source === 'rule' ? '规则' : 'AI'}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: C.text }}>
                {finding.title}
              </span>
              <span style={{ fontSize: 10, color: C.textMuted, fontFamily: 'ui-monospace, monospace', flexShrink: 0 }}>
                {finding.path.replace(/^.*\//, '')}:{finding.line}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4, flexShrink: 0,
                background: publishMode(finding) === 'inline' ? C.primaryLight : C.warningBg,
                color: publishMode(finding) === 'inline' ? C.primary : C.warning,
              }}>{publishMode(finding) === 'inline' ? `行内 L${finding.line}` : '全文'}</span>
            </div>
          ))}
          {findings.length > preview.length && (
            <div style={{ fontSize: 11, color: C.textMuted, padding: '2px 8px' }}>…还有 {findings.length - preview.length} 条</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
