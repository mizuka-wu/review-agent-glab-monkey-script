import { Copy, MessageSquare, Sparkles, X } from 'lucide-react';
import type { CodeSelection } from '../../core/types';

interface Props {
  state: CodeSelection;
  onAsk: () => void;
  onReview: () => void;
  onCopy: () => void;
  onClose: () => void;
}

export function SelectionToolbar({ state, onAsk, onReview, onCopy, onClose }: Props) {
  return (
    <div className="fixed z-[100] flex items-center gap-1 p-1 rounded-lg bg-panel-header text-panel-header-foreground shadow-xl" role="toolbar" aria-label="代码选区操作" style={{ top: state.top, left: state.left }} onMouseDown={(event) => event.preventDefault()}>
      <button type="button" onClick={onAsk}><MessageSquare size={14} />问一下</button>
      <button type="button" onClick={onReview}><Sparkles size={14} />Review 这段</button>
      <button type="button" onClick={onCopy} aria-label="复制选中代码"><Copy size={14} /></button>
      <button type="button" onClick={onClose} aria-label="关闭工具栏"><X size={14} /></button>
    </div>
  );
}
