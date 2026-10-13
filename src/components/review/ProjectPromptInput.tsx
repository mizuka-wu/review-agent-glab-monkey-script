import { useRef, useState, type CSSProperties, type RefObject } from 'react';
import { History, Trash2 } from 'lucide-react';
import { GLOBAL_PROMPT_HISTORY_LIMIT } from '../../core/project-prompts';
import type { ProjectPromptHistoryEntry } from '../../core/types';
import { tokens as C } from '../ui/modern';

export interface ProjectPromptInputProps {
  ariaLabel: string;
  /** 当前生效的补充要求（受控）。 */
  value: string;
  /** 全局共用的历史池，最新在前，每条带来源项目。 */
  history: ProjectPromptHistoryEntry[];
  /** 打字实时更新当前值，不动历史。 */
  onChange: (value: string) => void;
  /** 失焦即保存点：把当前值追加进历史。 */
  onCommit: (value: string) => void;
  onRemoveEntry?: (entry: string) => void;
  disabled?: boolean;
  placeholder?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  style?: CSSProperties;
}

/**
 * 项目补充要求输入框：多行文本，↑↓ / Esc 一律交还给光标与人工编辑，历史只从输入框右上角的按钮进。
 * （旧版把 ↑↓ 劫持成翻历史，会打断正常输入，已按用户反馈撤掉。）
 * 历史池跨项目共用，所以每条右下角标出来源项目，选中只把 value 填回输入框。
 */
export function ProjectPromptInput({
  ariaLabel, value, history, onChange, onCommit, onRemoveEntry,
  disabled = false, placeholder, inputRef, style,
}: ProjectPromptInputProps) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const nodeRef = inputRef ?? fallbackRef;
  const [showHistory, setShowHistory] = useState(false);

  /** 列表上 mousedown 已 preventDefault：输入框不会失焦，也就不会在 click 落地前被 blur 关掉。 */
  const useEntry = (entry: ProjectPromptHistoryEntry) => {
    setShowHistory(false);
    onChange(entry.value);
    nodeRef.current?.focus();
  };

  const iconBtn: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, padding: 0,
    border: 0, background: 'transparent', borderRadius: C.radiusSm, cursor: 'pointer',
    color: C.textMuted, flexShrink: 0,
  };

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ position: 'relative' }}>
        <textarea
          ref={nodeRef}
          aria-label={ariaLabel}
          autoComplete="off"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => { setShowHistory(false); onCommit(value); }}
          style={{
            width: '100%', minHeight: 64, resize: 'vertical', padding: 7,
            borderRadius: C.radiusSm, border: `1px solid ${C.border}`, fontSize: 12, lineHeight: 1.6,
            fontFamily: 'inherit', color: C.text, background: C.bg, outline: 'none',
            ...style,
            ...(history.length > 0 ? { paddingRight: 56 } : {}),
          }}
        />
        {history.length > 0 && (
          <button
            type="button" aria-label="项目补充要求历史" aria-expanded={showHistory} disabled={disabled}
            onClick={() => setShowHistory((open) => !open)}
            title={`最近 ${history.length} 条保存过的补充要求（所有项目共用一个历史池），点开挑一条填回输入框`}
            style={{
              position: 'absolute', top: 5, right: 5, zIndex: 32, display: 'flex', alignItems: 'center', gap: 3,
              height: 20, padding: '0 6px', fontSize: 10.5, lineHeight: 1, borderRadius: C.radiusSm,
              border: `1px solid ${showHistory ? C.primary : C.border}`, cursor: disabled ? 'not-allowed' : 'pointer',
              background: showHistory ? C.primaryLight : C.bg, color: showHistory ? C.primary : C.textSecondary,
              transition: C.transition, opacity: disabled ? 0.4 : 1,
            }}
          ><History size={11} />{history.length}</button>
        )}
      </div>

      <div style={{ fontSize: 10.5, color: C.textMuted, overflowWrap: 'anywhere' }}>
        {history.length > 0
          ? `已保存 ${history.length} 条历史（所有项目共用，最多 ${GLOBAL_PROMPT_HISTORY_LIMIT} 条）· 点输入框右上角的历史按钮挑一条填回，↑↓ 只移动光标`
          : '失焦后自动存进历史，之后可以点历史按钮挑回之前写过的版本'}
      </div>

      {showHistory && history.length > 0 && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setShowHistory(false)} />
          <div
            role="listbox" aria-label="项目补充要求历史列表" className="ra-scroll"
            onMouseDown={(event) => event.preventDefault()}
            style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 31,
              maxHeight: 220, overflowY: 'auto', background: C.bgSubtle, border: `1px solid ${C.border}`,
              borderRadius: C.radiusSm, boxShadow: '0 10px 28px rgba(0,0,0,.2)', padding: 4,
            }}
          >
            {history.map((entry, index) => (
              <div
                key={`${index}-${entry.value.slice(0, 24)}`} role="option" aria-selected={entry.value === value}
                onClick={() => useEntry(entry)} title="点击填回输入框"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '5px 7px', borderRadius: C.radiusSm,
                  cursor: 'pointer', background: entry.value === value ? C.primaryLight : 'transparent',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    display: 'block', fontSize: 11, lineHeight: 1.5, color: C.text, whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word', maxHeight: 44, overflow: 'hidden',
                  }}>{entry.value}</span>
                  {entry.projectKey && (
                    <span style={{
                      display: 'block', marginTop: 2, textAlign: 'right', fontSize: 9.5, lineHeight: 1.3,
                      color: C.textMuted, overflowWrap: 'anywhere',
                    }}>{entry.projectKey}</span>
                  )}
                </span>
                {onRemoveEntry && (
                  <button
                    type="button" aria-label="删除这条补充要求"
                    onClick={(event) => { event.stopPropagation(); onRemoveEntry(entry.value); }}
                    style={iconBtn}
                  ><Trash2 size={11} /></button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
