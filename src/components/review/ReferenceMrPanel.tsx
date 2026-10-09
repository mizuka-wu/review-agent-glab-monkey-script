import { useState, type CSSProperties } from 'react';
import { AlertTriangle, ChevronDown, ExternalLink, GitMerge, History, Loader2, Plus, X } from 'lucide-react';
import { Btn, tokens as C } from '../ui/modern';
import { mrLinkKey, mrLinkLabel, mrWebUrl, type MrLinkParseFailure } from '../../core/reference-mrs';
import type { ReferenceMr } from '../../core/types';

export interface ReferenceCandidate {
  key: string;
  label: string;
  title: string;
  meta: string;
  group: 'history' | 'recent';
  checked: boolean;
}

export interface ReferenceMrPanelProps {
  references: ReferenceMr[];
  input: string;
  onInputChange: (value: string) => void;
  /** 解析输入框里的链接并逐个拉取。 */
  onAddLinks: () => void;
  onRemove: (key: string) => void;
  busy: boolean;
  invalid: MrLinkParseFailure[];
  onDismissInvalid: () => void;
  candidates: ReferenceCandidate[];
  candidatesLoading: boolean;
  candidatesError: string;
  onLoadCandidates: () => void;
  onToggleCandidate: (key: string) => void;
  disabled?: boolean;
}

const statusStyle: Record<ReferenceMr['status'], { fg: string; bg: string; border: string; label: string }> = {
  ready: { fg: C.success, bg: C.successBg, border: '#b7e4c7', label: '已就绪' },
  loading: { fg: C.textSecondary, bg: C.bgMuted, border: C.border, label: '拉取中' },
  failed: { fg: C.danger, bg: C.dangerBg, border: '#f6bcbc', label: '拉取失败' },
};

/**
 * 其他 MR 只是当前这次评审的参考资料：这里不产出 Finding，也不会成为发布目标，
 * 所以面板只负责「加进来 / 看清楚状态 / 拿掉」，失败原因原样摊开给用户。
 */
export function ReferenceMrPanel({
  references, input, onInputChange, onAddLinks, onRemove, busy, invalid, onDismissInvalid,
  candidates, candidatesLoading, candidatesError, onLoadCandidates, onToggleCandidate, disabled,
}: ReferenceMrPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const ready = references.filter((reference) => reference.status === 'ready').length;
  const failed = references.filter((reference) => reference.status === 'failed').length;
  const loading = references.filter((reference) => reference.status === 'loading').length;
  const summary = references.length === 0
    ? '未附加'
    : [
      ready > 0 ? `${ready} 个已就绪` : '',
      loading > 0 ? `${loading} 个拉取中` : '',
      failed > 0 ? `${failed} 个失败` : '',
    ].filter(Boolean).join(' · ');

  const rowStyle: CSSProperties = {
    display: 'flex', alignItems: 'flex-start', gap: 7, padding: '6px 8px', borderRadius: C.radiusSm,
    border: `1px solid ${C.border}`, background: C.bg,
  };

  const openPicker = () => {
    const next = !pickerOpen;
    setPickerOpen(next);
    if (next) onLoadCandidates();
  };

  const groups: { key: ReferenceCandidate['group']; title: string; hint: string }[] = [
    { key: 'history', title: '本工具评审过的 MR', hint: '本地记录，置顶' },
    { key: 'recent', title: 'GitLab 最近活动', hint: 'updated_desc，跨项目' },
  ];

  return (
    <section aria-label="参考 MR" style={{ border: `1px solid ${C.border}`, borderRadius: C.radiusLg, background: C.bgSubtle, overflow: 'hidden' }}>
      <button
        type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '7px 9px', border: 0,
          background: 'transparent', cursor: 'pointer', textAlign: 'left', color: C.text,
        }}
      >
        <GitMerge size={13} style={{ color: C.textSecondary, flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, fontWeight: 700 }}>参考 MR</span>
        <span style={{ fontSize: 10.5, color: failed > 0 ? C.danger : C.textMuted }}>{summary}</span>
        <span style={{ flex: 1 }} />
        <ChevronDown size={13} style={{ color: C.textMuted, transform: expanded ? 'rotate(180deg)' : 'none', transition: C.transition }} />
      </button>

      {expanded && (
        <div style={{ padding: '0 9px 9px', display: 'flex', flexDirection: 'column', gap: 7, borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 10.5, lineHeight: 1.6, color: C.textMuted, paddingTop: 7 }}>
            跨项目的一次改动可以把配套 MR 拉进来当参考：它们的 diff 会标注成只读上下文，和当前 MR 一起送进同一次规则检查与 AI 评审。
            <strong style={{ color: C.textSecondary }}>Finding、行内评论与发布目标始终只针对当前 MR。</strong>
          </div>

          <textarea
            aria-label="参考 MR 链接" autoComplete="off" rows={2} value={input} disabled={disabled}
            placeholder={'粘贴其他 MR 链接，换行或空格分隔，例如：\nhttps://gitlab.example.com/group/sdk/-/merge_requests/12'}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onAddLinks();
              }
            }}
            style={{
              width: '100%', resize: 'vertical', padding: 7, borderRadius: C.radiusSm, border: `1px solid ${C.border}`,
              fontSize: 11.5, lineHeight: 1.6, fontFamily: 'ui-monospace, monospace', color: C.text, background: C.bg, outline: 'none',
            }}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Btn size="sm" variant="outline" icon={busy ? <Loader2 size={12} className="ra-spin" /> : <Plus size={12} />}
              disabled={disabled || busy || !input.trim()} onClick={onAddLinks}>
              {busy ? '拉取中' : '解析并拉取'}
            </Btn>
            <Btn size="sm" variant="ghost" icon={<History size={12} />} disabled={disabled} onClick={openPicker}>
              {pickerOpen ? '收起候选列表' : '从最近活动选择'}
            </Btn>
            <span style={{ fontSize: 10.5, color: C.textMuted }}>⌘/Ctrl + Enter 也可以拉取</span>
          </div>

          {invalid.length > 0 && (
            <div style={{ padding: '6px 8px', borderRadius: C.radiusSm, border: `1px solid #f6bcbc`, background: C.dangerBg }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#991b1b' }}>
                <AlertTriangle size={12} />
                {invalid.length} 个链接没有加进来
                <span style={{ flex: 1 }} />
                <button type="button" aria-label="忽略链接解析提示" onClick={onDismissInvalid}
                  style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, color: '#991b1b', display: 'grid', placeItems: 'center' }}>
                  <X size={12} />
                </button>
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 10.5, color: '#991b1b', lineHeight: 1.6 }}>
                {invalid.map((item) => <li key={item.input}><code style={{ fontFamily: 'ui-monospace, monospace' }}>{item.input}</code>：{item.reason}</li>)}
              </ul>
            </div>
          )}

          {references.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {references.map((reference) => {
                const key = mrLinkKey(reference.ref);
                const tone = statusStyle[reference.status];
                return (
                  <div key={key} style={rowStyle} data-reference={key} data-reference-status={reference.status}>
                    <span style={{
                      flexShrink: 0, marginTop: 1, padding: '1px 6px', borderRadius: 10, fontSize: 9.5, fontWeight: 700,
                      color: tone.fg, background: tone.bg, border: `1px solid ${tone.border}`,
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                    }}>
                      {reference.status === 'loading' && <Loader2 size={9} className="ra-spin" />}
                      {tone.label}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <a href={mrWebUrl(reference.ref)} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 11, fontWeight: 700, color: C.primary, fontFamily: 'ui-monospace, monospace', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          {mrLinkLabel(reference.ref)}<ExternalLink size={9} />
                        </a>
                        {reference.status === 'ready' && (
                          <span style={{ fontSize: 10, color: C.textMuted }}>
                            {reference.files.length} 个变更文件{reference.headSha ? ` · head ${reference.headSha.slice(0, 8)}` : ''}
                          </span>
                        )}
                      </div>
                      {reference.title && (
                        <div style={{ fontSize: 10.5, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {reference.title}
                        </div>
                      )}
                      {reference.error && (
                        <div style={{ marginTop: 2, fontSize: 10.5, lineHeight: 1.5, color: reference.status === 'failed' ? '#991b1b' : C.warning }}>
                          {reference.error}
                        </div>
                      )}
                    </div>
                    <button type="button" aria-label={`移除参考 MR ${mrLinkLabel(reference.ref)}`} disabled={disabled}
                      onClick={() => onRemove(key)}
                      style={{ border: 0, background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer', padding: 2, color: C.textMuted, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {pickerOpen && (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: C.radiusSm, background: C.bg, padding: 6 }}>
              {candidatesLoading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.textMuted }}>
                  <Loader2 size={12} className="ra-spin" />正在读取 GitLab 最近活动 MR…
                </div>
              )}
              {candidatesError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 10.5, lineHeight: 1.6, color: '#991b1b' }}>
                  <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>最近活动列表读取失败：{candidatesError}。可以直接把 MR 链接粘到上面的输入框。</span>
                </div>
              )}
              {groups.map((group) => {
                const items = candidates.filter((candidate) => candidate.group === group.key);
                if (items.length === 0) return null;
                return (
                  <div key={group.key} style={{ marginTop: group.key === 'recent' ? 6 : 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {group.title}<span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> · {group.hint}</span>
                    </div>
                    {items.map((candidate) => (
                      <label key={candidate.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', cursor: 'pointer' }}>
                        <input type="checkbox" autoComplete="off" checked={candidate.checked} disabled={disabled}
                          onChange={() => onToggleCandidate(candidate.key)} aria-label={`选择 ${candidate.label}`} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: C.text, fontFamily: 'ui-monospace, monospace', flexShrink: 0 }}>{candidate.label}</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {candidate.title}
                        </span>
                        <span style={{ fontSize: 9.5, color: C.textMuted, flexShrink: 0 }}>{candidate.meta}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
              {!candidatesLoading && !candidatesError && candidates.length === 0 && (
                <div style={{ fontSize: 10.5, color: C.textMuted }}>没有可用的候选 MR：本工具还没有评审记录，GitLab 也没有返回最近活动的 MR。</div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
