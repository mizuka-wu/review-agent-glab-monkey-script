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
  const btnClass = 'inline-flex items-center gap-1.5 min-h-[30px] px-2.5 py-1 text-[11px] font-semibold rounded text-white bg-transparent border-0 cursor-pointer hover:bg-white/15 transition-colors';
  return (
    <div className="fixed z-[100] flex items-center gap-0.5 p-1 rounded-lg bg-[#1e2536] text-white shadow-xl" role="toolbar" aria-label="代码选区操作" style={{ top: state.top, left: state.left }} onMouseDown={(event) => event.preventDefault()}>
      <button type="button" className={btnClass} onClick={onAsk}><MessageSquare size={14} />问一下</button>
      <button type="button" className={btnClass} onClick={onReview}><Sparkles size={14} />Review 这段</button>
      <button type="button" className={btnClass} onClick={onCopy} aria-label="复制选中代码"><Copy size={14} /></button>
      <button type="button" className={btnClass} onClick={onClose} aria-label="关闭工具栏"><X size={14} /></button>
    </div>
  );
}
