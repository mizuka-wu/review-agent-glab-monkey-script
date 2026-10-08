import { useState } from 'react';
import { Check, CheckCheck, ChevronDown, ChevronRight, Copy, Crosshair, Edit3, EyeOff, MessageSquarePlus, Save, X } from 'lucide-react';
import { findingEditableFields, type FindingEdit } from '../../core/finding-edit';
import { Markdown } from '../Markdown';
import { Badge, Pill, sourceTone, tokens as C } from '../ui/modern';
import type { Finding, FindingCategory, FindingConfidence, FindingSeverity } from '../../core/types';

const severityLabel: Record<FindingSeverity, string> = { critical: '严重', high: '高', medium: '中', low: '低' };
const categoryLabel: Record<FindingCategory, string> = {
  bug: '缺陷', security: '安全', performance: '性能', maintainability: '可维护性', test: '测试',
};
const confidenceLabel: Record<FindingConfidence, string> = { high: '高', medium: '中', low: '低' };

const severityColor: Record<FindingSeverity, { fg: string; bg: string; bar: string }> = {
  critical: { fg: '#991b1b', bg: '#fee2e2', bar: '#b91c1c' },
  high: { fg: '#b91c1c', bg: '#feecec', bar: '#dc2626' },
  medium: { fg: '#92400e', bg: C.warningBg, bar: C.warning },
  low: { fg: '#475569', bg: '#eef1f5', bar: '#94a3b8' },
};

interface FindingCardProps {
  finding: Finding;
  expanded: boolean;
  selected?: boolean;
  publishDisabled: boolean;
  publishDisabledReason?: string;
  /** 本条 Finding 自身不可发布的原因（行号无法修正等），会直接显示在卡片上。 */
  publishIssue?: string;
  onToggle: () => void;
  onSelect?: () => void;
  onLocate: () => void;
  onCopy: () => void;
  onPublish: () => void;
  onIgnore: () => void;
  onMarkFixed: () => void;
  onEdit: (edit: FindingEdit) => void;
}

function ActionButton({ icon, children, onClick, disabled, title, primary, danger }: {
  icon?: React.ReactNode; children: React.ReactNode; onClick: () => void;
  disabled?: boolean; title?: string; primary?: boolean; danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} title={title}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 26, padding: '0 8px',
        borderRadius: C.radiusSm, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer', transition: C.transition,
        border: `1px solid ${primary ? C.primary : danger && hover ? '#f3c1c1' : C.border}`,
        background: primary ? (hover ? C.primaryHover : C.primary) : hover ? C.bgMuted : C.bg,
        color: primary ? '#fff' : danger ? C.danger : C.textSecondary,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {icon}{children}
    </button>
  );
}

export function FindingCard({
  finding, expanded, selected, publishDisabled, publishDisabledReason, publishIssue,
  onToggle, onSelect, onLocate, onCopy, onPublish, onIgnore, onMarkFixed, onEdit,
}: FindingCardProps) {
  const [edit, setEdit] = useState<FindingEdit | undefined>();
  const editInvalid = !edit?.title.trim() || !edit?.content.trim() || !edit?.comment.trim();
  const severity = severityColor[finding.severity];
  const tone = sourceTone[finding.source === 'rule' ? 'rule' : 'model'];
  const codePreview = finding.existingCode.trim().split('\n')[0] ?? '';

  const startEdit = () => setEdit(findingEditableFields(finding));
  const saveEdit = () => {
    if (!edit || editInvalid) return;
    onEdit(edit);
    setEdit(undefined);
  };

  const statusPill = finding.status === 'published'
    ? <Pill tone="success">已发布</Pill>
    : finding.status === 'ignored'
      ? <Pill>已忽略</Pill>
      : finding.status === 'failed'
        ? <Pill tone="danger">发布失败</Pill>
        : null;

  return (
    <article
      data-finding-id={finding.id}
      data-finding-source={finding.source}
      style={{
        background: C.bg, border: `1px solid ${C.border}`, borderLeft: `3px solid ${severity.bar}`,
        borderRadius: C.radius, overflow: 'hidden', opacity: finding.status === 'ignored' ? 0.62 : 1,
        transition: C.transition,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '7px 9px 7px 8px' }}>
        {onSelect && (
          <input
            type="checkbox" checked={selected ?? false} autoComplete="off" onChange={onSelect}
            aria-label="选择此 Finding" title="选择后可批量发布"
            style={{ marginTop: 4, width: 13, height: 13, accentColor: C.primary, cursor: 'pointer', flexShrink: 0 }}
          />
        )}
        <button
          type="button" onClick={onToggle} aria-expanded={expanded}
          style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 3 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 4,
              fontSize: 10, fontWeight: 700, background: severity.bg, color: severity.fg, lineHeight: '16px',
            }}>{severityLabel[finding.severity]}</span>
            <span title={finding.corroborated ? '规则与 AI 独立命中同一处问题，已合并' : tone.hint} style={{
              display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 4,
              fontSize: 10, fontWeight: 700, lineHeight: '16px',
              background: finding.corroborated ? C.successBg : tone.bg,
              color: finding.corroborated ? C.success : tone.fg,
              border: `1px solid ${finding.corroborated ? '#b6e6c6' : finding.source === 'rule' ? C.ruleBorder : C.aiBorder}`,
            }}>
              {finding.corroborated ? '规则 + AI' : finding.source === 'rule' ? '规则' : 'AI'}
            </span>
            <span style={{ fontSize: 10, fontWeight: 600, color: C.textMuted }}>{categoryLabel[finding.category]}</span>
            {finding.source === 'model' && (
              <span style={{ fontSize: 10, color: C.textMuted }}>置信度 {confidenceLabel[finding.confidence]}</span>
            )}
            {finding.occurrences && finding.occurrences > 1 && <Pill tone="neutral" count={finding.occurrences}>处</Pill>}
            {finding.edited && <Pill>已编辑</Pill>}
            {statusPill}
            <span style={{ marginLeft: 'auto', display: 'flex', color: C.textMuted, flexShrink: 0 }}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, lineHeight: 1.45, paddingRight: 4 }}>{finding.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, minWidth: 0 }}>
            <code style={{
              fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: C.textMuted,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0,
            }}>{finding.path.replace(/^.*\//, '')}:{finding.line}{finding.endLine > finding.line ? `-${finding.endLine}` : ''}</code>
            {!expanded && codePreview && (
              <code style={{
                flex: 1, minWidth: 0, fontSize: 10.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: C.textSecondary, background: C.bgSubtle, border: `1px solid ${C.border}`,
                borderRadius: 4, padding: '1px 5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{codePreview}</code>
            )}
          </div>
        </button>
      </div>

      {expanded && (
        <div className="ra-scroll" style={{ padding: '9px 10px 10px', borderTop: `1px solid ${C.border}`, background: C.bgSubtle, maxHeight: 320, overflowY: 'auto' }}>
          {edit ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <EditField label="标题" id={`finding-title-${finding.id}`}>
                <input id={`finding-title-${finding.id}`} autoComplete="off" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} style={inputStyle} />
              </EditField>
              <EditField label="说明" id={`finding-content-${finding.id}`}>
                <textarea id={`finding-content-${finding.id}`} autoComplete="off" value={edit.content} rows={4} onChange={(e) => setEdit({ ...edit, content: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
              </EditField>
              <EditField label="评论草稿" id={`finding-comment-${finding.id}`} hint="发布到 GitLab 的正文，支持 Markdown">
                <textarea id={`finding-comment-${finding.id}`} autoComplete="off" value={edit.comment} rows={6} onChange={(e) => setEdit({ ...edit, comment: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
              </EditField>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <EditField label="分类" id={`finding-category-${finding.id}`}>
                  <select id={`finding-category-${finding.id}`} autoComplete="off" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value as FindingEdit['category'] })} style={inputStyle}>
                    {Object.entries(categoryLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </EditField>
                <EditField label="严重度" id={`finding-severity-${finding.id}`}>
                  <select id={`finding-severity-${finding.id}`} autoComplete="off" value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value as FindingEdit['severity'] })} style={inputStyle}>
                    {Object.entries(severityLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </EditField>
                <EditField label="置信度" id={`finding-confidence-${finding.id}`}>
                  <select id={`finding-confidence-${finding.id}`} autoComplete="off" value={edit.confidence} onChange={(e) => setEdit({ ...edit, confidence: e.target.value as FindingEdit['confidence'] })} style={inputStyle}>
                    {Object.entries(confidenceLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </EditField>
              </div>
              {editInvalid && <div style={{ fontSize: 11, color: C.danger }}>标题、说明和评论草稿都不能为空。</div>}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: C.text }}><Markdown content={finding.content} /></div>

              {finding.ruleId && (
                <div style={{ marginTop: 8, fontSize: 11, color: C.rule, background: C.ruleBg, border: `1px solid ${C.ruleBorder}`, borderRadius: C.radiusSm, padding: '5px 8px' }}>
                  {finding.corroborated ? '规则同时命中：' : '确定性规则命中：'}<code style={{ fontFamily: 'ui-monospace, monospace' }}>{finding.ruleId}</code>
                  {finding.rulePackName && <span style={{ color: C.textSecondary }}> · {finding.rulePackName}</span>}
                  <span style={{ color: C.textSecondary }}>（可在「设置 → 规则包」中调整或关闭）</span>
                </div>
              )}

              {finding.evidence.length > 0 && (
                <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {finding.evidence.map((evidence) => (
                    <div key={`${evidence.path}-${evidence.lines}-${evidence.quote}`} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: C.radiusSm, padding: '5px 8px' }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: C.textMuted, fontFamily: 'ui-monospace, monospace' }}>
                        {evidence.path}{evidence.lines ? ` · ${evidence.lines}` : ''}
                      </div>
                      {evidence.quote && (
                        <pre style={{ margin: '3px 0 0', fontSize: 11, lineHeight: 1.5, color: C.textSecondary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{evidence.quote}</pre>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {finding.existingCode && (
                <div style={{ marginTop: 9, borderRadius: C.radiusSm, overflow: 'hidden', border: `1px solid ${C.border}` }}>
                  <pre style={{ margin: 0, padding: '6px 8px', fontSize: 11, lineHeight: 1.55, background: '#fdecec', color: '#8b1a1a', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>- {finding.existingCode}</pre>
                  {finding.suggestionCode && (
                    <pre style={{ margin: 0, padding: '6px 8px', fontSize: 11, lineHeight: 1.55, background: '#e9f7ef', color: '#14663c', borderTop: `1px solid ${C.border}`, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>+ {finding.suggestionCode}</pre>
                  )}
                </div>
              )}

              {publishIssue && (
                <div style={{ marginTop: 8 }}>
                  <Badge text={publishIssue} color="warning" />
                </div>
              )}
              {finding.anchor?.corrected && (
                <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted }}>
                  原行号不在当前 Diff 内，已按 Finding 内容自动修正到第 {finding.line} 行。
                </div>
              )}
              {finding.anchor?.relocatedFromPath && (
                <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted }}>
                  已按 existingCode 从 <code style={{ fontFamily: 'ui-monospace, monospace' }}>{finding.anchor.relocatedFromPath}</code> 重定位到当前文件。
                </div>
              )}
            </>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
            {edit ? (
              <>
                <ActionButton icon={<X size={12} />} onClick={() => setEdit(undefined)}>取消</ActionButton>
                <ActionButton icon={<Save size={12} />} primary onClick={saveEdit} disabled={editInvalid}>保存修改</ActionButton>
              </>
            ) : (
              <>
                <ActionButton icon={<Edit3 size={12} />} onClick={startEdit} disabled={finding.status === 'published'}>编辑</ActionButton>
                <ActionButton icon={<Crosshair size={12} />} onClick={onLocate} title="在页面 Diff 中高亮定位">定位</ActionButton>
                <ActionButton icon={<Copy size={12} />} onClick={onCopy}>复制评论</ActionButton>
                <ActionButton
                  icon={finding.status === 'published' ? <Check size={12} /> : <MessageSquarePlus size={12} />}
                  primary onClick={onPublish}
                  disabled={publishDisabled || finding.status === 'published' || finding.status === 'ignored'}
                  title={publishDisabled ? (publishDisabledReason ?? '当前页面无法发布行级评论') : '创建 GitLab 行级 Discussion'}
                >
                  {finding.status === 'published' ? '已发布' : '发布到 GitLab'}
                </ActionButton>
                <ActionButton icon={<EyeOff size={12} />} danger onClick={onIgnore} disabled={finding.status !== 'draft'}>忽略</ActionButton>
                <ActionButton icon={<CheckCheck size={12} />} onClick={onMarkFixed} disabled={finding.status === 'published'} title="标记为已修复">已修复</ActionButton>
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: C.radiusSm, border: `1.5px solid ${C.border}`,
  fontSize: 12, color: C.text, background: C.bg, outline: 'none', boxSizing: 'border-box',
};

function EditField({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary }}>
        {label}{hint && <span style={{ fontWeight: 400, color: C.textMuted }}> · {hint}</span>}
      </label>
      {children}
    </div>
  );
}
