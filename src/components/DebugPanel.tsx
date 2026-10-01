import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, Copy, Download, Trash2 } from 'lucide-react';
import {
  debugBus, type DebugLevel, type DebugLogEntry, type DebugNetworkEntry, type DebugPromptEntry,
} from '../core/debug-bus';
import { Btn, IconButton, Segmented, tokens as C } from './ui/modern';
import type { DiagnosticEntry } from '../core/capabilities';
import type { AgentLoopEvent } from '../core/agent-loop';
import type { UsageSummary } from '../core/usage';
import { formatCost, formatTokenCount } from '../core/usage';

export type { DebugLogEntry };

export interface DebugPanelProps {
  diagnostics: DiagnosticEntry[];
  toolEvents: AgentLoopEvent[];
  usageSummary: UsageSummary | null;
  reviewStatus: string;
  findingsCount: number;
  filesCount: number;
  modelConfigured: boolean;
  mcpEnabled: boolean;
}

type Pane = 'logs' | 'network' | 'prompts' | 'state';

const levelColor: Record<DebugLevel, string> = {
  debug: '#8a9bb0', info: '#245fc7', warn: '#b8860b', error: '#d3453b',
};

function useBus() {
  const subscribe = useMemo(() => (listener: () => void) => debugBus.subscribe(listener), []);
  const version = useSyncExternalStore(subscribe, () => debugBus.getLogs().length + debugBus.getNetwork().length * 1000 + debugBus.getPrompts().length * 1000000);
  void version;
  return { logs: debugBus.getLogs(), network: debugBus.getNetwork(), prompts: debugBus.getPrompts() };
}

function timeOf(iso: string) {
  try {
    const date = new Date(iso);
    return `${date.toLocaleTimeString('zh-CN', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  } catch {
    return iso.slice(11, 23);
  }
}

const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' };

function Row({ head, children, defaultOpen = false }: { head: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: `1px solid ${C.border}` }}>
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', padding: '5px 8px',
          border: 0, background: open ? C.bgSubtle : 'transparent', cursor: 'pointer', textAlign: 'left',
          fontSize: 11, lineHeight: 1.5, ...mono,
        }}
      >
        <span style={{ color: C.textMuted, flexShrink: 0, marginTop: 1 }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>{head}</span>
      </button>
      {open && <div style={{ padding: '4px 10px 8px 26px', fontSize: 11, color: C.textSecondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...mono }}>{children}</div>}
    </div>
  );
}

function matches(text: string, query: string) {
  return query.trim() === '' || text.toLowerCase().includes(query.trim().toLowerCase());
}

export function DebugPanel(props: DebugPanelProps) {
  const { logs, network, prompts } = useBus();
  const [pane, setPane] = useState<Pane>('logs');
  const [level, setLevel] = useState<'all' | DebugLevel>('all');
  const [query, setQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs.length, network.length, prompts.length, autoScroll, pane]);

  const filteredLogs = logs.filter((entry) =>
    (level === 'all' || entry.level === level)
    && matches(`${entry.source} ${entry.message} ${entry.detail ?? ''}`, query));
  const filteredNetwork = network.filter((entry) =>
    matches(`${entry.kind} ${entry.method} ${entry.url} ${entry.status ?? ''} ${entry.error ?? ''}`, query));
  const filteredPrompts = prompts.filter((entry) =>
    matches(`${entry.stage} ${entry.model ?? ''} ${entry.error ?? ''} ${entry.messages.map((m) => m.content).join(' ')}`, query));

  const exportBundle = async () => {
    const bundle = debugBus.exportBundle();
    await navigator.clipboard?.writeText(bundle);
    const blob = new Blob([bundle], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `review-agent-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0, background: C.bg }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${C.border}`, background: C.bgSubtle, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Segmented
            value={pane} onChange={(value) => setPane(value as Pane)} style={{ flex: 1, padding: 2 }}
            options={[
              { value: 'logs', label: `日志 ${logs.length}` },
              { value: 'network', label: `网络 ${network.length}` },
              { value: 'prompts', label: `提示词 ${prompts.length}` },
              { value: 'state', label: '状态' },
            ]}
          />
          <IconButton icon={<Copy size={13} />} label="复制并下载调试包（JSON）" onClick={() => void exportBundle()} />
          <IconButton icon={<Trash2 size={13} />} label="清空调试记录" onClick={() => debugBus.clear()} />
        </div>
        {pane !== 'state' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              value={query} onChange={(event) => setQuery(event.target.value)} placeholder="过滤关键字…"
              aria-label="过滤调试记录"
              style={{
                flex: 1, height: 26, padding: '0 8px', borderRadius: C.radiusSm, border: `1px solid ${C.border}`,
                fontSize: 11, color: C.text, background: C.bg, outline: 'none', ...mono,
              }}
            />
            {pane === 'logs' && (
              <select value={level} onChange={(event) => setLevel(event.target.value as typeof level)} aria-label="日志级别"
                style={{ height: 26, borderRadius: C.radiusSm, border: `1px solid ${C.border}`, fontSize: 11, color: C.textSecondary, background: C.bg }}>
                <option value="all">全部级别</option>
                <option value="debug">debug</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.textMuted, cursor: 'pointer', flexShrink: 0 }}>
              <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} style={{ accentColor: C.primary }} />
              自动滚动
            </label>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="ra-scroll" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto' }}>
        {pane === 'logs' && (filteredLogs.length === 0
          ? <EmptyHint text={logs.length === 0 ? '还没有日志。操作面板（Review / 对话 / 索引）会产生记录，console.warn / error 也会被捕获。' : '没有匹配的日志。'} />
          : filteredLogs.map((entry) => (
            <Row key={entry.id} head={
              <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: C.textMuted, flexShrink: 0 }}>{timeOf(entry.ts)}</span>
                <span style={{ color: levelColor[entry.level], fontWeight: 700, flexShrink: 0 }}>{entry.level}</span>
                <span style={{ color: C.textSecondary, flexShrink: 0 }}>[{entry.source}]</span>
                <span style={{ color: C.text }}>{entry.message}</span>
              </span>
            }>
              {entry.detail ?? '（无详情）'}
            </Row>
          )))}

        {pane === 'network' && (filteredNetwork.length === 0
          ? <EmptyHint text="还没有网络记录。GitLab API、模型调用、MCP、仓库索引的请求都会记录在这里（含耗时与状态码）。" />
          : filteredNetwork.map((entry) => <NetworkRow key={entry.id} entry={entry} />))}

        {pane === 'prompts' && (filteredPrompts.length === 0
          ? <EmptyHint text="还没有提示词记录。发起 Review / 对话 / Agent 工具调用后，这里可以看到发给模型的完整 system 与消息内容。" />
          : filteredPrompts.map((entry) => <PromptRow key={entry.id} entry={entry} />))}

        {pane === 'state' && <StatePane {...props} />}
      </div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div style={{ padding: '24px 16px', fontSize: 12, color: C.textMuted, textAlign: 'center', lineHeight: 1.7 }}>{text}</div>;
}

function NetworkRow({ entry }: { entry: DebugNetworkEntry }) {
  const bad = entry.error || (entry.status !== undefined && entry.status >= 400);
  return (
    <Row head={
      <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: C.textMuted, flexShrink: 0 }}>{timeOf(entry.ts)}</span>
        <span style={{
          color: entry.kind === 'model' ? C.ai : entry.kind === 'gitlab' ? C.primary : C.rule,
          fontWeight: 700, flexShrink: 0,
        }}>{entry.kind}</span>
        <span style={{ color: C.textSecondary, flexShrink: 0 }}>{entry.method}</span>
        <span style={{ color: bad ? C.danger : C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.url}</span>
        <span style={{ color: bad ? C.danger : C.success, flexShrink: 0 }}>{entry.status ?? entry.error ?? ''}</span>
        <span style={{ color: C.textMuted, flexShrink: 0 }}>{entry.ms}ms</span>
      </span>
    }>
      {entry.error ? `错误：${entry.error}\n` : ''}
      {entry.bytes !== undefined ? `响应大小：${(entry.bytes / 1024).toFixed(1)} KB\n` : ''}
      {entry.transport ? `传输：${entry.transport}\n` : ''}
      完整 URL：{entry.url}
    </Row>
  );
}

function PromptRow({ entry }: { entry: DebugPromptEntry }) {
  return (
    <Row head={
      <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: C.textMuted, flexShrink: 0 }}>{timeOf(entry.ts)}</span>
        <span style={{ color: C.ai, fontWeight: 700, flexShrink: 0 }}>{entry.stage}</span>
        <span style={{ color: C.textSecondary, flexShrink: 0 }}>{entry.model}</span>
        {entry.tokens && <span style={{ color: C.textMuted, flexShrink: 0 }}>↑{entry.tokens.input} ↓{entry.tokens.output}</span>}
        <span style={{ color: entry.error ? C.danger : C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.error ?? `${entry.messages.length} 条消息 · 响应 ${entry.response?.length ?? 0} 字符`}
        </span>
      </span>
    }>
      {entry.error ? `错误：${entry.error}\n\n` : ''}
      {entry.tools && entry.tools.length > 0 ? `可用工具：${entry.tools.join(', ')}\n\n` : ''}
      {entry.system ? `── system ──\n${entry.system}\n\n` : ''}
      {entry.messages.map((message, index) => `── [${index}] ${message.role} (${message.characters} 字符) ──\n${message.content}\n`).join('\n')}
      {entry.response ? `\n── response ──\n${entry.response}` : ''}
    </Row>
  );
}

function StatePane(props: DebugPanelProps) {
  const snapshot = debugBus.snapshot();
  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          ['Review 状态', props.reviewStatus],
          ['Findings', String(props.findingsCount)],
          ['变更文件', String(props.filesCount)],
          ['模型已配置', props.modelConfigured ? '是' : '否'],
          ['MCP', props.mcpEnabled ? '启用' : '关闭'],
          ['Token 调用', props.usageSummary ? String(props.usageSummary.callCount) : '0'],
          ['Token 用量', props.usageSummary ? `${formatTokenCount(props.usageSummary.totalInputTokens)} / ${formatTokenCount(props.usageSummary.totalOutputTokens)}` : '0'],
          ['估算费用', props.usageSummary ? formatCost(props.usageSummary.totalEstimatedCost) : '$0'],
        ].map(([label, value]) => (
          <div key={label} style={{ padding: '6px 9px', background: C.bgSubtle, border: `1px solid ${C.border}`, borderRadius: C.radiusSm }}>
            <div style={{ fontSize: 10, color: C.textMuted }}>{label}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, ...mono }}>{value}</div>
          </div>
        ))}
      </div>

      <Section title="GitLab 能力探测">
        {props.diagnostics.length === 0
          ? '暂无诊断记录。'
          : props.diagnostics.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} style={{ padding: '3px 0', color: entry.level === 'error' ? C.danger : entry.level === 'warn' ? C.warning : C.textSecondary }}>
              [{entry.level}] {entry.source}: {entry.message}{entry.detail ? ` — ${entry.detail}` : ''}
            </div>
          ))}
      </Section>

      <Section title="Agent 工具事件">
        {props.toolEvents.length === 0
          ? '本次对话没有工具调用。'
          : props.toolEvents.map((event, index) => (
            <div key={`${event.type}-${index}`} style={{ padding: '3px 0', color: event.type === 'error' ? C.danger : C.textSecondary }}>
              {event.message}{event.detail?.content ? ` — ${event.detail.content}` : ''}
            </div>
          ))}
      </Section>

      <Section title="运行时快照（settings 已脱敏）">
        <pre style={{ margin: 0, fontSize: 10.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...mono }}>
          {JSON.stringify(snapshot, null, 2)}
        </pre>
      </Section>

      <div>
        <Btn size="sm" variant="outline" icon={<Download size={12} />} onClick={() => void navigator.clipboard?.writeText(debugBus.exportBundle())}>
          复制调试包 JSON
        </Btn>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
      <div style={{ fontSize: 11, lineHeight: 1.7, color: C.textSecondary, ...mono }}>{children}</div>
    </div>
  );
}
