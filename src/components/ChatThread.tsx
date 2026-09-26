import { useCallback, useRef, Component, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  fromThreadMessageLike,
  useExternalStoreRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { Thread } from './assistant-ui/elements/thread.aui';
import type { ChatMessage } from '../core/types';

function toAuiMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    const msg = fromThreadMessageLike({
      id: m.id,
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.error ? `⚠ ${m.content}` : m.content,
    } as ThreadMessageLike);
    return {
      ...msg,
      content: (msg.content ?? []).map((part: Record<string, unknown>) => ({
        ...part,
        status: part.status ?? { type: 'complete' },
      })),
    };
  });
}

class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

interface ChatThreadProps {
  messages: ChatMessage[];
  responding: boolean;
  onSend: (text: string) => void;
}

function SimpleChatFallback({ messages, onSend }: ChatThreadProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((msg) => (
          <div key={msg.id} className="mb-3">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">{msg.role === 'user' ? '你' : 'Agent'}</div>
            <div className={`p-2.5 rounded-lg text-xs whitespace-pre-wrap ${msg.role === 'user' ? 'bg-info/10' : 'bg-muted'}`}>{msg.content}</div>
          </div>
        ))}
      </div>
      <form className="p-3 border-t border-border" onSubmit={(e) => {
        e.preventDefault();
        const input = (e.target as HTMLFormElement).querySelector('textarea');
        if (input?.value.trim()) { onSend(input.value.trim()); input.value = ''; }
      }}>
        <textarea placeholder="输入问题…" className="w-full p-2 text-xs rounded-md border border-border bg-card" rows={2} />
      </form>
    </div>
  );
}

export function ChatThread({ messages, responding, onSend }: ChatThreadProps) {
  // Use ref for messages to avoid recreating adapter
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Stable onNew callback
  const onNewRef = useRef(onSend);
  onNewRef.current = onSend;

  const onNew = useCallback(async (msg: { content: unknown }) => {
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.map((part: { text?: string }) => part?.text ?? '').join('');
    }
    if (text.trim()) onNewRef.current(text.trim());
  }, []);

  // Stable adapter with getter for messages
  const adapterRef = useRef<ExternalStoreAdapter | null>(null);
  if (!adapterRef.current) {
    adapterRef.current = {
      get messages() {
        return toAuiMessages(messagesRef.current);
      },
      onNew,
      setMessages: (msgs: unknown[]) => {
        // Convert back to our format and update
        const converted = msgs.map((m: Record<string, unknown>) => {
          const content = Array.isArray(m.content)
            ? m.content.map((p: { text?: string }) => p?.text ?? '').join('')
            : typeof m.content === 'string' ? m.content : '';
          return {
            id: String(m.id ?? ''),
            role: m.role === 'user' ? 'user' : 'assistant',
            content,
          } as ChatMessage;
        });
        messagesRef.current = converted;
      },
    } as ExternalStoreAdapter;
  }

  const runtime = useExternalStoreRuntime(adapterRef.current);

  return (
    <ErrorBoundary fallback={<SimpleChatFallback messages={messages} responding={responding} onSend={onSend} />}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
    </ErrorBoundary>
  );
}
