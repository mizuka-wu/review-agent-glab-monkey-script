import { useRef, useState, type CSSProperties, type RefObject } from 'react';
import { History, Trash2 } from 'lucide-react';
import {
  caretAllowsHistory, idleBrowse, stepPromptHistory, type PromptHistoryBrowse,
} from '../../core/prompt-history';
import { PROJECT_PROMPT_HISTORY_LIMIT } from '../../core/project-prompts';
import { tokens as C } from '../ui/modern';

export interface ProjectPromptInputProps {
  ariaLabel: string;
  /** 当前生效的补充要求（受控）。 */
  value: string;
  /** 该项目已保存的历史，最新在前。 */
  history: string[];
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
 * 项目补充要求输入框：↑↓ 翻该项目历史、Esc 还原编辑中的内容，交互口径与主对话输入框一致
 * （同样复用 core/prompt-history 的 caretAllowsHistory / stepPromptHistory）。
 */
export function ProjectPromptInput({
  ariaLabel, value, history, onChange, onCommit, onRemoveEntry,
  disabled = false, placeholder, inputRef, style,
}: ProjectPromptInputProps) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const nodeRef = inputRef ?? fallbackRef;
  const [browse, setBrowse] = useState<PromptHistoryBrowse>(idleBrowse);
  const [showHistory, setShowHistory] = useState(false);

  /** 返回 true 表示这次 ↑↓ 归历史管，调用方要 preventDefault；已在翻历史时整段都归历史管。 */
  const step = (direction: 'older' | 'newer'): boolean => {
    const node = nodeRef.current;
    if (!node || history.length === 0) return false;
    if (browse.index === -1
      && !caretAllowsHistory(node.value, { start: node.selectionStart, end: node.selectionEnd }, direction)) return false;
    const stepped = stepPromptHistory(history, browse, direction, value);
    if (!stepped) return false;
    setBrowse(stepped.browse);
    setShowHistory(false);
    onChange(stepped.value);
    return true;
  };

  const cancel = () => {
    if (browse.index === -1) return;
    setBrowse(idleBrowse);
    onChange(browse.saved);
  };

  /** 列表上 mousedown 已 preventDefault：输入框不会失焦，也就不会在 click 落地前被 blur 关掉。 */
  const useEntry = (entry: string) => {
    setBrowse(idleBrowse);
    setShowHistory(false);
    onChange(entry);
    nodeRef.current?.focus();
  };

  const iconBtn: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, padding: 0,
    border: 0, background: 'transparent', borderRadius: C.radiusSm, cursor: 'pointer',
    color: C.textMuted, flexShrink: 0,
  };

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <textarea
        ref={nodeRef}
        aria-label={ariaLabel}
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => { setBrowse(idleBrowse); onChange(event.target.value); }}
        onBlur={() => { setBrowse(idleBrowse); setShowHistory(false); onCommit(value); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey
            && step(event.key === 'ArrowUp' ? 'older' : 'newer')) {
            event.preventDefault();
            return;
          }
          if (event.key === 'Escape' && browse.index >= 0) {
            event.preventDefault();
            cancel();
          }
        }}
        style={{
          width: '100%', minHeight: 64, resize: 'vertical', padding: 7,
          borderRadius: C.radiusSm, border: `1px solid ${C.border}`, fontSize: 12, lineHeight: 1.6,
          fontFamily: 'inherit', color: C.text, background: C.bg, outline: 'none',
          ...style,
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: C.textMuted }}>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          {browse.index >= 0
            ? `历史 ${browse.index + 1}/${history.length} · ↑↓ 切换 · Esc 回到编辑中的内容`
            : history.length > 0
              ? `已保存 ${history.length} 条历史（每项目最多 ${PROJECT_PROMPT_HISTORY_LIMIT} 条）· ↑ 翻上一条`
              : '失焦后自动存进历史，↑ 可以翻回之前写过的版本'}
        </span>
        {history.length > 0 && (
          <>
            <button
              type="button" aria-label="项目补充要求历史" aria-expanded={showHistory} disabled={disabled}
              onClick={() => setShowHistory((open) => !open)}
              title={`最近 ${history.length} 条保存过的补充要求（也可以在输入框里按 ↑）`}
              style={{ ...iconBtn, width: 'auto', gap: 3, padding: '1px 5px', color: showHistory ? C.primary : C.textMuted }}
            ><History size={11} />{history.length}</button>
            {showHistory && (
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
                      key={`${index}-${entry.slice(0, 24)}`} role="option" aria-selected={browse.index === index}
                      onClick={() => useEntry(entry)} title="点击填回输入框"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 7px', borderRadius: C.radiusSm,
                        cursor: 'pointer', background: browse.index === index ? C.primaryLight : 'transparent',
                      }}
                    >
                      <span style={{
                        flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.5, color: C.text, whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word', maxHeight: 44, overflow: 'hidden',
                      }}>{entry}</span>
                      {onRemoveEntry && (
                        <button
                          type="button" aria-label="删除这条补充要求"
                          onClick={(event) => { event.stopPropagation(); onRemoveEntry(entry); }}
                          style={iconBtn}
                        ><Trash2 size={11} /></button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
