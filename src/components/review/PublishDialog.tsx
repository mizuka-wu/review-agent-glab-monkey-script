import { useEffect, type ReactNode } from 'react';
import { AlertTriangle, MessageSquare, X } from 'lucide-react';
import { Banner, Btn, tokens as C } from '../ui/modern';
import type { Finding } from '../../core/types';

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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
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

export function PublishDialog({ finding, body, onBodyChange, publishing, meta, onCancel, onConfirm }: {
  finding: Finding;
  body: string;
  onBodyChange: (value: string) => void;
  publishing: boolean;
  meta: { projectPath: string; mergeRequestIid?: number; headSha?: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      labelId="publish-title"
      title="发布到 GitLab"
      subtitle={`${meta.projectPath}${meta.mergeRequestIid ? ` · MR !${meta.mergeRequestIid}` : ''}${meta.headSha ? ` · head ${meta.headSha.slice(0, 8)}` : ''}`}
      onClose={onCancel}
      footer={
        <>
          <Btn variant="outline" onClick={onCancel}>返回修改</Btn>
          <Btn variant="primary" icon={<MessageSquare size={13} />} loading={publishing} disabled={!body.trim()} onClick={onConfirm}>
            {publishing ? '发布中…' : '确认发布'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div style={{ padding: '8px 10px', background: C.bgSubtle, border: `1px solid ${C.border}`, borderRadius: C.radiusSm }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary }}>{finding.title}</div>
          <div style={{ marginTop: 3, fontSize: 11, color: C.textMuted, fontFamily: 'ui-monospace, monospace' }}>
            {finding.path}:{finding.line}{finding.endLine > finding.line ? `-${finding.endLine}` : ''} · {finding.side === 'new' ? '新版本' : '旧版本'}
          </div>
        </div>

        {finding.anchor?.publishable === false && (
          <Banner tone="warning" icon={<AlertTriangle size={14} />} title="无法作为行级评论">
            该 Finding 只锚定到完整文件，不在当前 Diff 行上。发布将退化为 MR 级评论。
          </Banner>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label htmlFor="publish-body" style={{ fontSize: 12, fontWeight: 600, color: C.text }}>评论内容</label>
          <textarea
            id="publish-body" value={body} rows={10} onChange={(event) => onBodyChange(event.target.value)}
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

export function BatchPublishDialog({ findings, publishing, meta, onCancel, onConfirm }: {
  findings: Finding[];
  publishing: boolean;
  meta: { projectPath: string; mergeRequestIid?: number; headSha?: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const preview = findings.slice(0, 10);
  return (
    <Dialog
      labelId="batch-publish-title"
      title="批量发布到 GitLab"
      subtitle={`${meta.projectPath}${meta.mergeRequestIid ? ` · MR !${meta.mergeRequestIid}` : ''}${meta.headSha ? ` · head ${meta.headSha.slice(0, 8)}` : ''}`}
      onClose={onCancel}
      footer={
        <>
          <Btn variant="outline" onClick={onCancel}>取消</Btn>
          <Btn variant="primary" icon={<MessageSquare size={13} />} loading={publishing} disabled={findings.length === 0} onClick={onConfirm}>
            {publishing ? '发布中…' : `确认批量发布 ${findings.length} 条`}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: C.textSecondary }}>
          将为选中的 {findings.length} 个 Finding 逐条创建行级 Discussion，失败的条目会保留在列表中。
        </div>
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
