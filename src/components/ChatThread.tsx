import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Bot, FileText, History, Plus, Send, Settings2, Sparkles, Square, Trash2, User, Wrench, X } from 'lucide-react';
import { Markdown } from './Markdown';
import { Btn, EmptyState, tokens as C } from './ui/modern';
import type { AgentLoopEvent } from '../core/agent-loop';
import type { ChatSession } from '../core/chat-sessions';
import type { ChatMessage, CodeSelection } from '../core/types';

export interface ChatThreadProps {
  messages: ChatMessage[];
  sessions: ChatSession[];
  activeSessionId: string;
  onNewSession: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  responding: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text: string) => void;
  onStop?: () => void;
  attachment?: CodeSelection;
  onClearAttachment?: () => void;
  toolEvents?: AgentLoopEvent[];
  suggestions?: string[];
  modelReady: boolean;
  onOpenSettings: () => void;
  modelPicker?: ReactNode;
}

const COMPOSER_MAX_HEIGHT = 140;

export function ChatThread({
  messages, sessions, activeSessionId, onNewSession, onSwitchSession, onDeleteSession,
  responding, draft, onDraftChange, onSend, onStop,
  attachment, onClearAttachment, toolEvents = [], suggestions = [], modelReady, onOpenSettings, modelPicker,
}: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [showSessions, setShowSessions] = useState(false);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const headerIconBtn: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, border: 0,
    background: 'transparent', cursor: responding ? 'default' : 'pointer', color: C.textSecondary, padding: 0,
    borderRadius: C.radiusSm, flexShrink: 0, opacity: responding ? 0.4 : 1,
  };

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, responding, showTrace]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (!text || responding) return;
    onSend(text);
  };

  const traceEvents = toolEvents.filter((event) => event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'error');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0, background: C.bg }}>
      {modelPicker && (
        <div style={{ padding: '8px 12px 0', flexShrink: 0 }}>{modelPicker}</div>
      )}
      {/* 会话栏：标题 + 历史 + 新建 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: `1px solid ${C.border}`, flexShrink: 0, position: 'relative' }}>
        <span
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 600, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={activeSession?.title}
        >
          {activeSession?.title ?? '新会话'}
        </span>
        <button type="button" aria-label="会话历史" disabled={responding} onClick={() => setShowSessions((value) => !value)} style={headerIconBtn}>
          <History size={13} />
        </button>
        <button type="button" aria-label="新建会话" disabled={responding} onClick={onNewSession} style={headerIconBtn}>
          <Plus size={13} />
        </button>
        {showSessions && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setShowSessions(false)} />
            <div
              className="ra-scroll"
              style={{
                position: 'absolute', top: '100%', right: 12, marginTop: 4, zIndex: 21, width: 270, maxHeight: 280,
                overflowY: 'auto', background: C.bgSubtle, border: `1px solid ${C.border}`, borderRadius: C.radiusSm,
                boxShadow: '0 10px 28px rgba(0,0,0,.2)', padding: 4,
              }}
            >
              {sessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => { onSwitchSession(session.id); setShowSessions(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 7px', borderRadius: C.radiusSm,
                    cursor: 'pointer', background: session.id === activeSessionId ? C.primaryLight : 'transparent',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {session.title}
                  </span>
                  <span style={{ fontSize: 9.5, color: C.textMuted, flexShrink: 0 }}>
                    {session.updatedAt.slice(5, 16).replace('T', ' ')}
                  </span>
                  <button
                    type="button" aria-label="删除会话" disabled={responding}
                    onClick={(event) => { event.stopPropagation(); onDeleteSession(session.id); }}
                    style={{ ...headerIconBtn, width: 18, height: 18, color: C.textMuted }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div ref={scrollRef} className="ra-scroll" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', padding: '10px 12px 4px' }}>
        {messages.length === 0 ? (
          <EmptyState icon={<Bot size={18} />} title="向 Review Agent 提问">
            在 GitLab Diff 里划词可以直接带上代码上下文；也可以询问整个 MR 的变更意图、风险点和测试建议。
          </EmptyState>
        ) : messages.map((message) => <MessageBubble key={message.id} message={message} />)}

        {traceEvents.length > 0 && (
          <div style={{ margin: '6px 0 10px' }}>
            <button
              type="button" onClick={() => setShowTrace((v) => !v)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, border: 0, background: 'transparent',
                cursor: 'pointer', padding: 0, fontSize: 11, fontWeight: 600, color: C.textMuted,
              }}
            >
              <Wrench size={12} />
              {showTrace ? '收起' : '展开'}工具调用轨迹（{traceEvents.length}）
            </button>
            {showTrace && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11, color: C.textSecondary, lineHeight: 1.7 }}>
                {traceEvents.map((event, index) => (
                  <li key={`${event.type}-${index}`}>
                    <code style={{ fontFamily: 'ui-monospace, monospace', color: event.type === 'error' ? C.danger : C.textSecondary }}>
                      {event.message}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {responding && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0 10px', fontSize: 11, color: C.textMuted }}>
            <span style={{ display: 'flex', color: C.ai }}><Sparkles size={12} /></span>
            模型正在思考…
          </div>
        )}
      </div>

      {/* Composer */}
      <div style={{ flexShrink: 0, borderTop: `1px solid ${C.border}`, background: C.bgSubtle, padding: '8px 10px 10px' }}>
        {attachment && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, padding: '4px 8px',
            borderRadius: C.radiusSm, background: C.primaryLight, border: `1px solid #c9dcf8`,
          }}>
            <FileText size={12} style={{ color: C.primary, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: C.primary, fontFamily: 'ui-monospace, monospace' }}>
              {attachment.filePath}:{attachment.startLine}-{attachment.endLine}
            </span>
            {onClearAttachment && (
              <button type="button" aria-label="移除代码附件" onClick={onClearAttachment}
                style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.primary, opacity: 0.6, display: 'flex', padding: 0 }}>
                <X size={12} />
              </button>
            )}
          </div>
        )}

        {!modelReady && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, padding: '5px 8px',
            borderRadius: C.radiusSm, background: C.warningBg, border: '1px solid #fcd9a0',
            fontSize: 11, color: '#92400e', lineHeight: 1.5,
          }}>
            <span style={{ flex: 1 }}>对话和 AI 评审需要配置模型 API Key；规则检查无需配置即可使用。</span>
            <Btn size="sm" variant="outline" icon={<Settings2 size={12} />} onClick={onOpenSettings}>去配置</Btn>
          </div>
        )}

        {suggestions.length > 0 && messages.length === 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 7 }}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion} type="button" onClick={() => onSend(suggestion)} disabled={responding}
                style={{
                  padding: '4px 9px', borderRadius: 20, fontSize: 11, cursor: responding ? 'not-allowed' : 'pointer',
                  border: `1px solid ${C.border}`, background: C.bg, color: C.textSecondary, transition: C.transition,
                }}
              >{suggestion}</button>
            ))}
          </div>
        )}

        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 6, padding: '6px 6px 6px 10px',
          background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: C.radiusLg,
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)', transition: C.transition,
        }}>
          <textarea
            ref={textareaRef}
            aria-label="消息输入框" autoComplete="off"
            rows={1}
            value={draft}
            placeholder={modelReady ? '提问，或粘贴代码…（Enter 发送 / Shift+Enter 换行）' : '未配置模型，暂不能对话；可先运行规则检查'}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return; // IME 选词回车不发送
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            style={{
              flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', resize: 'none',
              fontSize: 12.5, lineHeight: 1.55, color: C.text, fontFamily: 'inherit',
              maxHeight: COMPOSER_MAX_HEIGHT, padding: '4px 0',
            }}
          />
          {responding && onStop ? (
            <button type="button" aria-label="停止生成" onClick={onStop}
              style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: C.radiusSm, border: `1px solid ${C.border}`, background: C.bg, color: C.danger, cursor: 'pointer', flexShrink: 0 }}>
              <Square size={12} />
            </button>
          ) : (
            <button
              type="button" aria-label="发送消息" onClick={submit} disabled={!draft.trim() || responding}
              style={{
                display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: C.radiusSm,
                border: 0, flexShrink: 0, cursor: draft.trim() && !responding ? 'pointer' : 'not-allowed',
                background: draft.trim() && !responding ? C.primary : C.bgMuted,
                color: draft.trim() && !responding ? '#fff' : C.textMuted, transition: C.transition,
              }}
            ><Send size={13} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div style={{ display: 'flex', gap: 7, marginBottom: 10, alignItems: 'flex-start' }}>
      <div style={{
        display: 'grid', placeItems: 'center', width: 22, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 1,
        background: isUser ? C.bgMuted : C.aiBg, color: isUser ? C.textSecondary : C.ai,
      }}>
        {isUser ? <User size={12} /> : <Bot size={12} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {message.attachment && (
          <div style={{
            display: 'inline-block', marginBottom: 3, padding: '1px 6px', borderRadius: 4,
            background: C.bgSubtle, border: `1px solid ${C.border}`,
            fontSize: 10, color: C.textMuted, fontFamily: 'ui-monospace, monospace',
          }}>
            {message.attachment.filePath}:{message.attachment.startLine}-{message.attachment.endLine}
          </div>
        )}
        <div style={{
          padding: '7px 10px', borderRadius: C.radiusLg, fontSize: 12.5, lineHeight: 1.65,
          background: message.error ? C.dangerBg : isUser ? C.bgMuted : C.bgSubtle,
          border: `1px solid ${message.error ? '#f6bcbc' : C.border}`,
          color: message.error ? '#991b1b' : C.text, wordBreak: 'break-word',
        }}>
          {isUser || message.error
            ? <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
            : <Markdown content={message.content} />}
        </div>
        {message.findings && message.findings.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 11, color: C.textMuted }}>
            本次产生 {message.findings.length} 个 Finding，见「结果」标签页。
          </div>
        )}
      </div>
    </div>
  );
}
