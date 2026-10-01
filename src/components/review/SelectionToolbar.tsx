import { useState } from 'react';
import { Copy, MessageSquare, Sparkles, X } from 'lucide-react';
import { tokens as C } from '../ui/modern';
import type { CodeSelection } from '../../core/types';

interface Props {
  state: CodeSelection;
  onAsk: () => void;
  onReview: () => void;
  onCopy: () => void;
  onClose: () => void;
}

function ToolButton({ icon, label, onClick, primary }: {
  icon: React.ReactNode; label: string; onClick: () => void; primary?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button" onClick={onClick} title={label}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: primary ? '0 9px' : '0 7px',
        borderRadius: C.radiusSm, border: 0, cursor: 'pointer', fontSize: 11, fontWeight: 600,
        background: primary ? (hover ? C.primaryHover : C.primary) : hover ? 'rgba(255,255,255,0.14)' : 'transparent',
        color: primary ? '#fff' : '#e7ecf3', transition: C.transition, whiteSpace: 'nowrap',
      }}
    >
      {icon}{primary ? label : <span className="ra-sr-only">{label}</span>}
    </button>
  );
}

export function SelectionToolbar({ state, onAsk, onReview, onCopy, onClose }: Props) {
  const lines = state.endLine - state.startLine + 1;
  return (
    <div
      role="toolbar" aria-label="代码选区操作"
      style={{
        position: 'fixed', zIndex: 2147483400, top: state.top, left: state.left,
        display: 'flex', alignItems: 'center', gap: 3, padding: 4,
        background: C.headerBg, borderRadius: C.radius,
        boxShadow: '0 8px 22px rgba(15,23,42,0.35), 0 2px 6px rgba(15,23,42,0.2)',
        border: '1px solid rgba(255,255,255,0.10)',
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span style={{ fontSize: 10, color: C.headerMuted, padding: '0 6px 0 4px', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
        {state.filePath.replace(/^.*\//, '')}:{state.startLine}{lines > 1 ? `-${state.endLine}` : ''}
      </span>
      <ToolButton primary icon={<MessageSquare size={13} />} label="问一下" onClick={onAsk} />
      <ToolButton icon={<Sparkles size={13} />} label="Review 这段" onClick={onReview} />
      <ToolButton icon={<Copy size={13} />} label="复制选中代码" onClick={onCopy} />
      <ToolButton icon={<X size={13} />} label="关闭工具栏" onClick={onClose} />
    </div>
  );
}
