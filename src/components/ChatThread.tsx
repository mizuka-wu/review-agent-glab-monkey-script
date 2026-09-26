import { useCallback, useMemo, Component, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  AuiProvider,
  fromThreadMessageLike,
  useExternalStoreRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { Thread } from './assistant-ui/elements/thread.aui';
import type { ChatMessage } from '../core/types';

function toAuiMessage(msg: ChatMessage): ThreadMessageLike {
  return {
    id: msg.id,
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.error ? `⚠ ${msg.content}` : msg.content,
  };
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

function SimpleChatFallback({ messages, responding, onSend }: ChatThreadProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((msg) => (
          <div key={msg.id} className="mb-3">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">{msg.role === 'user' ? '你' : 'Agent'}</div>
            <div className={`p-2.5 rounded-lg text-xs whitespace-pre-wrap ${msg.role === 'user' ? 'bg-info/10' : 'bg-muted'}`}>{msg.content}</div>
          </div>
        ))}
        {responding && <div className="text-xs text-muted-foreground">正在思考…</div>}
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

export function ChatThread(props: ChatThreadProps) {
  const { messages, responding, onSend } = props;

  const onNew = useCallback(async (msg: { content: unknown }) => {
    // content can be string or array of {type: 'text', text: string}
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((part: { type?: string; text?: string }) => part?.text ?? '')
        .join('');
    }
    if (text.trim()) onSend(text.trim());
  }, [onSend]);

  const convertedMessages = useMemo(
    () => messages.map((m) => {
      const msg = fromThreadMessageLike(toAuiMessage(m));
      // Ensure content parts have status field required by Thread component
      return {
        ...msg,
        content: (msg.content ?? []).map((part: Record<string, unknown>) => ({
          ...part,
          status: part.status ?? { type: 'complete' },
        })),
      };
    }),
    [messages],
  );

  const adapter: ExternalStoreAdapter = useMemo(() => ({
    messages: convertedMessages,
    onNew,
    isDisabled: responding,
  }), [convertedMessages, onNew, responding]);

  const runtime = useExternalStoreRuntime(adapter);

  return (
    <ErrorBoundary fallback={<SimpleChatFallback {...props} />}>
      <AuiProvider>
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread />
        </AssistantRuntimeProvider>
      </AuiProvider>
    </ErrorBoundary>
  );
}
