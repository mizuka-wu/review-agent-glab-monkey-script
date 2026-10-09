import { useState, useRef, useEffect, type ReactNode, type CSSProperties } from 'react';
import { ChevronDown, Check, Copy, X } from 'lucide-react';

// ─── Design tokens ───
const C = {
  primary: '#245fc7', primaryHover: '#1d4fa8', primaryLight: '#e8f0fe',
  bg: '#ffffff', bgSubtle: '#f8f9fb', bgMuted: '#f0f3f7',
  text: '#1a2332', textSecondary: '#5a6b80', textMuted: '#8a9bb0',
  border: '#dfe3e9', borderFocus: '#245fc7',
  success: '#16a34a', successBg: '#dcfce7',
  danger: '#dc2626', dangerBg: '#fee2e2',
  warning: '#d97706', warningBg: '#fef3c7',
  shadow: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
  shadowLg: '0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)',
  radius: 8, radiusSm: 6, radiusLg: 12,
  transition: 'all 0.15s ease',
  /** 确定性规则检查（本地，零 token） */
  rule: '#0f766e', ruleBg: '#e6f4f2', ruleBorder: '#b7ddd8',
  /** 模型评审（消耗 token） */
  ai: '#6d28d9', aiBg: '#f1ebfe', aiBorder: '#d6c6f9',
  info: '#245fc7', infoBg: '#e8f0fe',
  headerBg: '#1b2233', headerText: '#f2f5f9', headerMuted: '#9fadbf',
};

export type SourceTone = 'rule' | 'model';

export const sourceTone: Record<SourceTone, { label: string; fg: string; bg: string; border: string; hint: string }> = {
  rule: { label: '规则', fg: C.rule, bg: C.ruleBg, border: C.ruleBorder, hint: '确定性规则命中 · 本地执行，不消耗 token' },
  model: { label: 'AI', fg: C.ai, bg: C.aiBg, border: C.aiBorder, hint: '模型评审 · 消耗 token，需人工复核' },
};

// ─── Card ───
export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      background: C.bg, borderRadius: C.radiusLg, border: `1px solid ${C.border}`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03)',
      transition: 'all 0.2s ease',
      ...style,
    }}>{children}</div>
  );
}

export function CardHeader({ icon, title, desc, badge, actions }: {
  icon?: ReactNode; title: string; desc?: string; badge?: { text: string; color?: string }; actions?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
      {icon && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: C.radius, background: C.primaryLight, color: C.primary, flexShrink: 0 }}>{icon}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{title}</div>
        {desc && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{desc}</div>}
      </div>
      {badge && <Badge text={badge.text} color={badge.color} />}
      {actions}
    </div>
  );
}

export function CardBody({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ padding: 16, ...style }}>{children}</div>;
}

// ─── Badge ───
export function Badge({ text, color, icon }: { text: string; color?: string; icon?: ReactNode }) {
  const bg = color === 'success' ? C.successBg : color === 'danger' ? C.dangerBg : color === 'warning' ? C.warningBg : C.primaryLight;
  const fg = color === 'success' ? C.success : color === 'danger' ? C.danger : color === 'warning' ? C.warning : C.primary;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: bg, color: fg, whiteSpace: 'nowrap' }}>
      {icon}{text}
    </span>
  );
}

// ─── Button ───
export function Btn({ children, variant = 'secondary', size = 'md', icon, onClick, disabled, loading, style, fullWidth, title, ariaLabel }: {
  children?: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; onClick?: () => void;
  disabled?: boolean; loading?: boolean; style?: CSSProperties; fullWidth?: boolean;
  title?: string; ariaLabel?: string;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: C.radiusSm, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
    transition: C.transition, border: '1px solid transparent', whiteSpace: 'nowrap',
    opacity: disabled ? 0.5 : 1,
    ...(fullWidth && { width: '100%' }),
    ...(active && !disabled && { transform: 'translateY(1px)' }),
  };

  const sizes = { sm: { height: 28, padding: '0 10px', fontSize: 12 }, md: { height: 34, padding: '0 14px', fontSize: 13 }, lg: { height: 40, padding: '0 18px', fontSize: 14 } };

  const variants: Record<string, CSSProperties> = {
    primary: { background: hover ? C.primaryHover : C.primary, color: '#fff', borderColor: hover ? C.primaryHover : C.primary },
    secondary: { background: hover ? '#e9ecf1' : C.bgMuted, color: C.text, borderColor: C.border },
    outline: { background: hover ? C.bgSubtle : 'transparent', color: C.text, borderColor: C.border },
    ghost: { background: hover ? C.bgMuted : 'transparent', color: C.textSecondary, borderColor: 'transparent' },
    danger: { background: hover ? '#b91c1c' : C.danger, color: '#fff', borderColor: hover ? '#b91c1c' : C.danger },
  };

  return (
    <button type="button" disabled={disabled || loading} onClick={onClick} title={title} aria-label={ariaLabel}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)} onMouseUp={() => setActive(false)}
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}>
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  );
}

// ─── Spinner ───
export function Spinner({ size = 16, color = C.primary }: { size?: number; color?: string }) {
  return (
    <span style={{ display: 'inline-block', width: size, height: size, border: `2px solid ${color}33`, borderTopColor: color, borderRadius: '50%', animation: 'ra-spin 0.6s linear infinite' }} />
  );
}

// ─── Copy ───
/** 非安全上下文（http 自建 GitLab）没有 navigator.clipboard，退回 execCommand。 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

export function CopyBtn({ text, label = '复制', size = 'sm', variant = 'outline', style }: {
  text: string | (() => string); label?: string; size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'; style?: CSSProperties;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1800);
    return () => clearTimeout(timer);
  }, [state]);

  const labels = { idle: label, ok: '已复制', fail: '复制失败' };
  const caption = labels[state];
  return (
    <Btn
      size={size}
      variant={state === 'ok' ? 'primary' : state === 'fail' ? 'danger' : variant}
      icon={state === 'ok' ? <Check size={12} /> : state === 'fail' ? <X size={12} /> : <Copy size={12} />}
      title={caption}
      ariaLabel={caption}
      style={style}
      onClick={() => {
        const value = typeof text === 'function' ? text() : text;
        void copyText(value).then((ok) => setState(ok ? 'ok' : 'fail'), () => setState('fail'));
      }}
    >{caption}</Btn>
  );
}

// ─── Input ───
export function Input({ value, onChange, placeholder, type = 'text', icon, rightIcon, style, mono, list, autoComplete }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  type?: string; icon?: ReactNode; rightIcon?: ReactNode; style?: CSSProperties; mono?: boolean; list?: string;
  autoComplete?: string;
}) {
  const [focus, setFocus] = useState(false);
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px',
        borderRadius: C.radius,
        background: focus ? C.bg : hover ? '#fafbfc' : C.bgSubtle,
        border: `1.5px solid ${focus ? C.borderFocus : hover ? '#c4cad2' : C.border}`,
        boxShadow: focus ? `0 0 0 3px ${C.primary}20, 0 1px 2px rgba(0,0,0,0.05)` : '0 1px 2px rgba(0,0,0,0.04)',
        transition: 'all 0.2s ease',
        ...style,
      }}
    >
      {icon && <span style={{ color: focus ? C.primary : C.textMuted, display: 'flex', flexShrink: 0, transition: 'color 0.15s' }}>{icon}</span>}
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} list={list}
        autoComplete={autoComplete ?? (type === 'password' ? 'new-password' : 'off')}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: C.text, fontFamily: mono ? 'ui-monospace, monospace' : 'inherit', minWidth: 0 }}
      />
      {rightIcon}
    </div>
  );
}

// ─── Select (custom dropdown) ───
export function Select({ value, onChange, options, placeholder, style }: {
  value: string; onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string; style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 38,
          padding: '0 12px', borderRadius: C.radius,
          background: open ? C.bg : C.bgSubtle,
          border: `1.5px solid ${open ? C.borderFocus : C.border}`,
          boxShadow: open ? `0 0 0 3px ${C.primary}20, 0 1px 2px rgba(0,0,0,0.05)` : '0 1px 2px rgba(0,0,0,0.04)',
          cursor: 'pointer', fontSize: 13, color: C.text,
          transition: 'all 0.2s ease',
          textAlign: 'left',
        }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? C.text : C.textMuted }}>
          {selected?.label || placeholder || '请选择'}
        </span>
        <ChevronDown size={15} style={{ color: C.textMuted, flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 100,
          background: C.bg, borderRadius: C.radiusLg, border: `1px solid ${C.border}`,
          boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
          maxHeight: 240, overflowY: 'auto', padding: 4,
          animation: 'ra-fade-in 0.15s ease',
        }}>
          {options.map((opt, i) => (
            <button key={opt.value} type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(-1)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '7px 10px', borderRadius: C.radiusSm, border: 0, cursor: 'pointer',
                fontSize: 13, color: C.text, textAlign: 'left',
                background: opt.value === value ? C.primaryLight : hoverIdx === i ? C.bgMuted : 'transparent',
                transition: C.transition,
              }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
              {opt.value === value && <Check size={14} style={{ color: C.primary, flexShrink: 0 }} />}
            </button>
          ))}
          {options.length === 0 && (
            <div style={{ padding: '12px 10px', fontSize: 12, color: C.textMuted, textAlign: 'center' }}>无可用选项</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SegmentedControl ───
export function Segmented({ value, onChange, options, style }: {
  value: string; onChange: (v: string) => void;
  options: Array<{ value: string; label: string; icon?: ReactNode }>;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: C.radius, background: C.bgMuted, ...style }}>
      {options.map(opt => (
        <button key={opt.value} type="button" onClick={() => onChange(opt.value)}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            padding: '6px 12px', borderRadius: C.radiusSm, border: 0, cursor: 'pointer',
            fontSize: 12, fontWeight: value === opt.value ? 600 : 400,
            background: value === opt.value ? C.bg : 'transparent',
            color: value === opt.value ? C.primary : C.textSecondary,
            boxShadow: value === opt.value ? C.shadow : 'none',
            transition: C.transition,
          }}>
          {opt.icon}{opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Toggle ───
export function Toggle({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: 11, border: 0, cursor: 'pointer',
        background: checked ? C.primary : C.border,
        transition: C.transition, position: 'relative', padding: 0,
      }}>
      <span style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3,
        width: 16, height: 16, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.15)', transition: 'left 0.15s ease',
      }} />
    </button>
  );
}

// ─── Field ───
export function Field({ label, required, hint, children, style }: {
  label: string; required?: boolean; hint?: string; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.text, letterSpacing: '0.01em' }}>{label}</label>
        {required && <span style={{ fontSize: 10, fontWeight: 700, color: C.danger, background: C.dangerBg, padding: '1px 5px', borderRadius: 4 }}>必填</span>}
        {hint && <span style={{ fontSize: 11, color: C.textMuted }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ─── Section divider with label ───
export function Divider({ label, style }: { label?: string; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '8px 0', ...style }}>
      <div style={{ flex: 1, height: 1, background: C.border }} />
      {label && <span style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>}
      <div style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

// ─── Icon button ───
export function IconButton({ icon, label, onClick, active, tone = 'light', disabled, badge }: {
  icon: ReactNode; label: string; onClick?: () => void; active?: boolean; disabled?: boolean;
  tone?: 'light' | 'dark'; badge?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const dark = tone === 'dark';
  return (
    <button
      type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', display: 'grid', placeItems: 'center', width: 28, height: 28,
        borderRadius: C.radiusSm, border: 0, cursor: disabled ? 'not-allowed' : 'pointer',
        background: active ? (dark ? 'rgba(255,255,255,0.16)' : C.primaryLight)
          : hover ? (dark ? 'rgba(255,255,255,0.10)' : C.bgMuted) : 'transparent',
        color: active ? (dark ? '#fff' : C.primary) : dark ? C.headerMuted : C.textSecondary,
        transition: C.transition, opacity: disabled ? 0.4 : 1, padding: 0,
      }}
    >
      {icon}
      {badge && <span style={{ position: 'absolute', top: 3, right: 3, width: 6, height: 6, borderRadius: '50%', background: C.danger }} />}
    </button>
  );
}

// ─── Pill / count badge ───
export function Pill({ children, tone, count }: { children: ReactNode; tone?: SourceTone | 'neutral' | 'danger' | 'warning' | 'success'; count?: number }) {
  const palette = tone === 'rule' ? { fg: C.rule, bg: C.ruleBg }
    : tone === 'model' ? { fg: C.ai, bg: C.aiBg }
    : tone === 'danger' ? { fg: C.danger, bg: C.dangerBg }
    : tone === 'warning' ? { fg: C.warning, bg: C.warningBg }
    : tone === 'success' ? { fg: C.success, bg: C.successBg }
    : { fg: C.textSecondary, bg: C.bgMuted };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 20,
      fontSize: 11, fontWeight: 600, lineHeight: '17px', background: palette.bg, color: palette.fg, whiteSpace: 'nowrap',
    }}>
      {children}
      {typeof count === 'number' && <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.85 }}>{count}</span>}
    </span>
  );
}

// ─── Banner ───
export function Banner({ tone = 'info', title, children, action, onDismiss, icon }: {
  tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode;
  action?: ReactNode; onDismiss?: () => void; icon?: ReactNode;
}) {
  const palette = tone === 'warning' ? { fg: '#92400e', bg: C.warningBg, border: '#fcd9a0' }
    : tone === 'danger' ? { fg: '#991b1b', bg: C.dangerBg, border: '#f6bcbc' }
    : tone === 'success' ? { fg: '#166534', bg: C.successBg, border: '#b6e6c6' }
    : { fg: '#1e40af', bg: C.infoBg, border: '#c3d7f8' };
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 11px',
      background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: C.radius,
      color: palette.fg, fontSize: 12, lineHeight: 1.55,
    }}>
      {icon && <span style={{ display: 'flex', marginTop: 1, flexShrink: 0 }}>{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: children ? 2 : 0 }}>{title}</div>}
        {children && <div style={{ opacity: 0.92 }}>{children}</div>}
        {action && <div style={{ marginTop: 7 }}>{action}</div>}
      </div>
      {onDismiss && (
        <button type="button" aria-label="关闭提示" onClick={onDismiss}
          style={{ border: 0, background: 'transparent', cursor: 'pointer', color: palette.fg, opacity: 0.6, display: 'flex', padding: 0, marginTop: 1 }}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

// ─── Empty state ───
export function EmptyState({ icon, title, children, action }: {
  icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '28px 20px', textAlign: 'center' }}>
      {icon && <div style={{ display: 'grid', placeItems: 'center', width: 40, height: 40, borderRadius: 20, background: C.bgMuted, color: C.textMuted }}>{icon}</div>}
      <div style={{ fontSize: 13, fontWeight: 600, color: C.textSecondary }}>{title}</div>
      {children && <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.6, maxWidth: 320 }}>{children}</div>}
      {action}
    </div>
  );
}

// ─── Tabs ───
export function Tabs<T extends string>({ value, onChange, items }: {
  value: T; onChange: (v: T) => void;
  items: { value: T; label: string; icon?: ReactNode; count?: number; dot?: boolean; title?: string }[];
}) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 2, padding: '0 8px', background: C.headerBg, borderBottom: `1px solid rgba(255,255,255,0.08)` }}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button key={item.value} type="button" role="tab" aria-selected={active} title={item.title} onClick={() => onChange(item.value)}
            style={{
              position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '8px 10px 9px', border: 0, background: 'transparent', cursor: 'pointer',
              fontSize: 12, fontWeight: active ? 700 : 500,
              color: active ? '#fff' : C.headerMuted, transition: C.transition,
            }}>
            {item.icon}
            {item.label}
            {typeof item.count === 'number' && item.count > 0 && (
              <span style={{
                minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, fontSize: 10, fontWeight: 700,
                display: 'inline-grid', placeItems: 'center', fontVariantNumeric: 'tabular-nums',
                background: active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)',
                color: active ? '#fff' : C.headerMuted,
              }}>{item.count}</span>
            )}
            {item.dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.danger }} />}
            {active && <span style={{ position: 'absolute', left: 8, right: 8, bottom: 0, height: 2, borderRadius: 2, background: '#5b9af0' }} />}
          </button>
        );
      })}
    </div>
  );
}

// ─── Keyframes injection ───
export function InjectAnimations() {
  return (
    <style>{`
      @keyframes ra-spin { to { transform: rotate(360deg); } }
      @keyframes ra-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      .ra-select-option:hover { background: ${C.bgMuted}; }
      .ra-spin { animation: ra-spin 0.9s linear infinite; }
      .ra-scroll { scrollbar-width: thin; scrollbar-color: #c8cfd9 transparent; }
      .ra-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
      .ra-scroll::-webkit-scrollbar-thumb { background: #c8cfd9; border-radius: 4px; }
      .ra-scroll::-webkit-scrollbar-thumb:hover { background: #aab4c2; }
      .ra-scroll::-webkit-scrollbar-track { background: transparent; }
    `}</style>
  );
}

export const tokens = C;

// ─── ConfirmButton（两步确认，防误触的高影响操作）───
export function ConfirmButton({ label, confirmLabel = '确认？', onConfirm, disabled, icon, variant = 'outline', size = 'sm', title }: {
  label: string; confirmLabel?: string; onConfirm: () => void;
  disabled?: boolean; icon?: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg'; title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Btn
      variant={armed ? 'primary' : variant}
      size={size}
      icon={icon}
      disabled={disabled}
      title={title}
      ariaLabel={armed ? confirmLabel : label}
      onClick={() => {
        if (armed) { setArmed(false); onConfirm(); } else { setArmed(true); }
      }}
    >{armed ? confirmLabel : label}</Btn>
  );
}
