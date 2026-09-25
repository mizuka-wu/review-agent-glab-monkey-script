import { Bot, Check, Copy, MessageSquare, Sparkles, X } from 'lucide-react';
import type { ToolbarState } from '../types';

interface SelectionToolbarProps {
  state: ToolbarState;
  onAsk: () => void;
  onReview: () => void;
  onCopy: () => void;
  onClose: () => void;
}

export function SelectionToolbar({
  state,
  onAsk,
  onReview,
  onCopy,
  onClose,
}: SelectionToolbarProps) {
  return (
    <div
      className="ra-selection-toolbar"
      role="toolbar"
      aria-label="代码选区操作"
      style={{ top: state.top, left: state.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={onAsk} title="对选中代码提问">
        <MessageSquare size={14} aria-hidden="true" />
        问一下
      </button>
      <button type="button" onClick={onReview} title="Review 选中代码">
        <Sparkles size={14} aria-hidden="true" />
        Review 这段
      </button>
      <button type="button" onClick={onCopy} title="复制选中代码">
        <Copy size={14} aria-hidden="true" />
        <Check size={0} aria-hidden="true" />
      </button>
      <button type="button" onClick={onClose} title="关闭工具栏" aria-label="关闭工具栏">
        <X size={14} aria-hidden="true" />
      </button>
      <span className="sr-only" style={{ display: 'none' }}>
        <Bot size={14} aria-hidden="true" />
      </span>
    </div>
  );
}
