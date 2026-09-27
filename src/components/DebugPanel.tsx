import { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronRight, Trash2, Download, Copy } from 'lucide-react';
import type { DiagnosticEntry } from '../core/capabilities';
import type { AgentLoopEvent } from '../core/agent-loop';
import type { UsageSummary } from '../core/usage';
import { formatTokenCount, formatCost } from '../core/usage';

export interface DebugLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
  detail?: string;
}

interface DebugPanelProps {
  logs: DebugLogEntry[];
  diagnostics: DiagnosticEntry[];
  toolEvents: AgentLoopEvent[];
  usageSummary: UsageSummary | null;
  reviewStatus: string;
  findingsCount: number;
  filesCount: number;
  modelConfigured: boolean;
  mcpEnabled: boolean;
  onClearLogs: () => void;
}

const levelColors: Record<string, string> = {
  info: '#245fc7',
  warn: '#b8860b',
  error: '#d3453b',
  debug: '#5a6b80',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return iso.slice(11, 23);
  }
}

function LogRow({ entry, expanded, onToggle }: { entry: DebugLogEntry; expanded: boolean; onToggle: () => void }) {
  const color = levelColors[entry.level] || '#5a6b80';
  return (
    <div style={{ borderBottom: '1px solid #e8edf3' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%',
          padding: '5px 8px', border: 0, background: 'transparent', cursor: 'pointer',
          textAlign: 'left', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5,
        }}
      >
        <span style={{ color: '#8a9bb0', flexShrink: 0, fontSize: 10, marginTop: 1 }}>{formatTime(entry.timestamp)}</span>
        <span style={{
          color: '#ffffff', background: color, borderRadius: 3, padding: '0 4px',
          fontSize: 9, fontWeight: 600, flexShrink: 0, marginTop: 1, minWidth: 32, textAlign: 'center',
        }}>{entry.level.toUpperCase()}</span>
        <span style={{ color: '#5a6b80', flexShrink: 0, fontSize: 10, marginTop: 1, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.source}</span>
        <span style={{ color: '#1a2332', flex: 1, wordBreak: 'break-all' }}>
          {entry.message}
          {entry.detail && (
            <span style={{ color: '#5a6b80', marginLeft: 4, cursor: 'pointer' }}>
              {expanded ? '▼' : '▶'}
            </span>
          )}
        </span>
      </button>
      {expanded && entry.detail && (
        <pre style={{
          margin: '0 8px 6px 40px', padding: '6px 8px', background: '#f4f6f9',
          borderRadius: 4, fontSize: 10, fontFamily: 'monospace', color: '#2d3748',
          overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200,
        }}>{entry.detail}</pre>
      )}
    </div>
  );
}

export function DebugPanel({
  logs, diagnostics, toolEvents, usageSummary,
  reviewStatus, findingsCount, filesCount, modelConfigured, mcpEnabled,
  onClearLogs,
}: DebugPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error' | 'debug'>('all');
  const [section, setSection] = useState<'logs' | 'state' | 'network'>('logs');
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter);

  const handleExport = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.level}] [${l.source}] ${l.message}${l.detail ? '\n  ' + l.detail : ''}`).join('\n');
    void navigator.clipboard?.writeText(text);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Section tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #d4dae3', background: '#f4f6f9', flexShrink: 0 }}>
        {([['logs', '日志'], ['state', '状态'], ['network', '网络']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSection(key)}
            style={{
              padding: '7px 14px', border: 0, cursor: 'pointer', fontSize: 12, fontWeight: 500,
              color: section === key ? '#245fc7' : '#5a6b80',
              borderBottom: section === key ? '2px solid #245fc7' : '2px solid transparent',
              background: section === key ? '#ffffff' : 'transparent',
            }}
          >{label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button type="button" onClick={handleExport} title="复制日志" style={{ padding: '7px 10px', border: 0, background: 'transparent', cursor: 'pointer', color: '#5a6b80' }}>
          <Copy size={13} />
        </button>
        <button type="button" onClick={onClearLogs} title="清空日志" style={{ padding: '7px 10px', border: 0, background: 'transparent', cursor: 'pointer', color: '#5a6b80' }}>
          <Trash2 size={13} />
        </button>
      </div>

      {section === 'logs' && (
        <>
          {/* Level filter */}
          <div style={{ display: 'flex', gap: 4, padding: '6px 8px', borderBottom: '1px solid #e8edf3', flexShrink: 0 }}>
            {(['all', 'info', 'warn', 'error', 'debug'] as const).map(level => (
              <button
                key={level}
                type="button"
                onClick={() => setFilter(level)}
                style={{
                  padding: '2px 8px', borderRadius: 10, border: '1px solid #d4dae3', cursor: 'pointer',
                  fontSize: 10, fontWeight: 500,
                  background: filter === level ? '#245fc7' : '#ffffff',
                  color: filter === level ? '#ffffff' : '#5a6b80',
                  borderColor: filter === level ? '#245fc7' : '#d4dae3',
                }}
              >{level === 'all' ? '全部' : level}</button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#8a9bb0', alignSelf: 'center' }}>{filtered.length} 条</span>
          </div>
          {/* Log list */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#8a9bb0', fontSize: 12 }}>暂无日志</div>
            ) : filtered.map(entry => (
              <LogRow
                key={entry.id}
                entry={entry}
                expanded={expandedId === entry.id}
                onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              />
            ))}
            <div ref={logEndRef} />
          </div>
        </>
      )}

      {section === 'state' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
          <StateSection title="运行状态">
            <StateRow label="Review 状态" value={reviewStatus} />
            <StateRow label="Findings 数量" value={String(findingsCount)} />
            <StateRow label="Diff 文件数" value={String(filesCount)} />
            <StateRow label="模型已配置" value={modelConfigured ? '✓ 是' : '✗ 否'} valueColor={modelConfigured ? '#1a7a42' : '#d3453b'} />
            <StateRow label="MCP 启用" value={mcpEnabled ? '✓ 是' : '✗ 否'} valueColor={mcpEnabled ? '#1a7a42' : '#8a9bb0'} />
          </StateSection>

          {usageSummary && usageSummary.callCount > 0 && (
            <StateSection title="Token 用量">
              <StateRow label="总调用次数" value={String(usageSummary.callCount)} />
              <StateRow label="输入 Tokens" value={formatTokenCount(usageSummary.totalInputTokens)} />
              <StateRow label="输出 Tokens" value={formatTokenCount(usageSummary.totalOutputTokens)} />
              <StateRow label="估算费用" value={formatCost(usageSummary.totalEstimatedCost)} />
              {Object.entries(usageSummary.byModel).map(([key, data]) => (
                <StateRow key={key} label={key} value={`${formatTokenCount(data.inputTokens)} → ${formatTokenCount(data.outputTokens)}`} />
              ))}
            </StateSection>
          )}

          {diagnostics.length > 0 && (
            <StateSection title={`能力诊断 (${diagnostics.length})`}>
              {diagnostics.map((d, i) => (
                <div key={i} style={{ padding: '5px 0', borderTop: '1px solid #e8edf3', fontSize: 11, fontFamily: 'monospace' }}>
                  <span style={{ color: levelColors[d.level] || '#5a6b80', fontWeight: 600, marginRight: 6 }}>{d.level}</span>
                  <span style={{ color: '#5a6b80', marginRight: 6 }}>[{d.source}]</span>
                  <span style={{ color: '#1a2332' }}>{d.message}</span>
                  {d.detail && <div style={{ color: '#8a9bb0', marginTop: 2, fontSize: 10 }}>{d.detail}</div>}
                </div>
              ))}
            </StateSection>
          )}

          {toolEvents.length > 0 && (
            <StateSection title={`Agent 工具调用 (${toolEvents.length})`}>
              {toolEvents.map((e, i) => (
                <div key={i} style={{ padding: '5px 0', borderTop: '1px solid #e8edf3', fontSize: 11, fontFamily: 'monospace' }}>
                  <span style={{ color: '#245fc7', fontWeight: 600, marginRight: 6 }}>{e.type}</span>
                  <span style={{ color: '#1a2332' }}>{JSON.stringify(e).slice(0, 200)}</span>
                </div>
              ))}
            </StateSection>
          )}
        </div>
      )}

      {section === 'network' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
          <div style={{ color: '#8a9bb0', fontSize: 12, textAlign: 'center', padding: 24 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>🌐</div>
            网络请求日志在「日志」标签中查看
            <div style={{ marginTop: 8, fontSize: 11 }}>所有 API 调用会以 [network] 源记录</div>
          </div>
        </div>
      )}
    </div>
  );
}

function StateSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 12, border: '1px solid #d4dae3', borderRadius: 8, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          padding: '8px 10px', border: 0, background: '#f4f6f9', cursor: 'pointer',
          fontSize: 12, fontWeight: 600, color: '#1a2332', textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && <div style={{ padding: '4px 10px 8px' }}>{children}</div>}
    </div>
  );
}

function StateRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11, borderBottom: '1px solid #f0f3f7' }}>
      <span style={{ color: '#5a6b80' }}>{label}</span>
      <strong style={{ color: valueColor || '#1a2332', fontFamily: 'monospace' }}>{value}</strong>
    </div>
  );
}
