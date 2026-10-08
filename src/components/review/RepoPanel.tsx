import { useEffect, useMemo, useState } from 'react';
import { Database, GitBranch, HardDrive, Loader2, ScanLine, Search, Trash2, X } from 'lucide-react';
import { Banner, Btn, EmptyState, Pill, tokens as C } from '../ui/modern';
import type { RepoIndexStatus } from '../../core/repo-index';
import type { CallChainNode, SymbolDef, SymbolRef } from '../../core/symbols';

const backendLabel: Record<RepoIndexStatus['backend'], string> = {
  'opfs-worker': 'OPFS · 独立 Worker',
  'opfs-async': 'OPFS · 主线程',
  memory: '内存（不持久化）',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export interface RepoPanelProps {
  status: RepoIndexStatus;
  enabled: boolean;
  hasMr: boolean;
  maxIndexes: number;
  onIndex: () => void;
  onCancel: () => void;
  onClear: () => void;
  onActivate: (ref: string) => void;
  onRemove: (ref: string) => void;
  onOpenSettings: () => void;
  scanning: boolean;
  onScan: () => void;
  onSearch: (query: string) => { defs: SymbolDef[]; refs: SymbolRef[] };
  onCallChain: (symbol: string, depth: number) => CallChainNode | null;
}

export function RepoPanel(props: RepoPanelProps) {
  const { status, enabled, hasMr, maxIndexes } = props;
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [chain, setChain] = useState<{ symbol: string; node: CallChainNode | null; depth: number } | undefined>(undefined);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useMemo(
    () => (status.state === 'ready' && debounced.trim() ? props.onSearch(debounced) : { defs: [], refs: [] }),
    [debounced, status.state, props],
  );

  const indexing = status.state === 'indexing';
  const percent = status.progress.total > 0
    ? Math.round((status.progress.done / status.progress.total) * 100)
    : 0;

  return (
    <div className="ra-scroll" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ padding: 12, border: `1px solid ${C.border}`, borderRadius: C.radiusLg, background: C.bgSubtle }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
          <span style={{ display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: 13, background: C.ruleBg, color: C.rule }}>
            <Database size={14} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>仓库索引</span>
          <Pill>{backendLabel[status.backend]}</Pill>
          {status.state === 'ready' && <Pill tone="success">已就绪</Pill>}
          {indexing && <Pill tone="warning">索引中</Pill>}
          {status.state === 'error' && <Pill tone="danger">失败</Pill>}
        </div>

        <div style={{ fontSize: 11.5, color: C.textSecondary, lineHeight: 1.7 }}>
          GitLab REST 没有符号级 API。这里把仓库文件缓存到浏览器本地（OPFS），
          构建符号表后提供<strong>符号搜索</strong>与<strong>调用链</strong>，
          并让 Review / 对话的 Agent 可以调用 <code style={mono}>symbol_search</code>、<code style={mono}>call_chain</code> 工具，
          把「Diff 外的调用点」带进提示词。
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 10 }}>
          {[
            ['文件', String(status.files)],
            ['体积', formatBytes(status.bytes)],
            ['符号', String(status.symbols)],
            ['引用', String(status.refs)],
          ].map(([label, value]) => (
            <div key={label} style={{ padding: '6px 8px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: C.radiusSm }}>
              <div style={{ fontSize: 10, color: C.textMuted }}>{label}</div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text, ...mono }}>{value}</div>
            </div>
          ))}
        </div>

        {status.ref && (
          <div style={{ marginTop: 8, fontSize: 10.5, color: C.textMuted, ...mono }}>
            ref {status.ref.slice(0, 12)}{status.indexedAt ? ` · ${new Date(status.indexedAt).toLocaleString('zh-CN')}` : ''}
            {status.skipped.files > 0 ? ` · 跳过 ${status.skipped.files} 个文件（${formatBytes(status.skipped.bytes)}）` : ''}
          </div>
        )}

        {indexing && (
          <div style={{ marginTop: 10 }}>
            <div style={{ height: 5, borderRadius: 3, background: C.border, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${percent}%`, background: C.primary, transition: 'width 0.2s ease' }} />
            </div>
            <div style={{ marginTop: 4, fontSize: 10.5, color: C.textMuted, ...mono }}>
              {status.progress.done}/{status.progress.total}{status.progress.current ? ` · ${status.progress.current}` : ''}
            </div>
          </div>
        )}

        {status.error && status.state !== 'ready' && (
          <div style={{ marginTop: 8 }}>
            <Banner tone="danger" title="索引失败">{status.error}</Banner>
          </div>
        )}

        <div style={{ display: 'flex', gap: 7, marginTop: 11, flexWrap: 'wrap' }}>
          {indexing ? (
            <Btn variant="outline" size="sm" icon={<X size={12} />} onClick={props.onCancel}>取消索引</Btn>
          ) : (
            <Btn
              variant="primary" size="sm" icon={<Database size={12} />}
              disabled={!enabled || !hasMr}
              title={!hasMr ? '需要在 MR / commit 页面建立索引' : undefined}
              onClick={props.onIndex}
            >
              {status.state === 'ready' ? '更新索引' : '建立索引'}
            </Btn>
          )}
          <Btn
            variant="outline" size="sm" icon={<ScanLine size={12} />}
            disabled={!enabled || status.state !== 'ready' || indexing || props.scanning}
            title={status.state !== 'ready' ? '需要先建立索引' : '对已索引文件跑确定性规则（无 diff 位置，不可发布）'}
            onClick={props.onScan}
          >
            {props.scanning ? '扫描中…' : '扫描已索引文件'}
          </Btn>
          <Btn variant="ghost" size="sm" icon={<Trash2 size={12} />} disabled={indexing || status.files === 0} onClick={props.onClear}>
            清除本地缓存
          </Btn>
          {!enabled && (
            <Btn variant="outline" size="sm" onClick={props.onOpenSettings}>在设置中启用</Btn>
          )}
        </div>
        {!enabled && (
          <div style={{ marginTop: 7, fontSize: 11, color: C.textMuted }}>仓库索引已在设置中关闭。</div>
        )}
      </div>

      {status.state === 'ready' && status.currentRef && status.ref !== status.currentRef && (
        <Banner
          tone="warning" icon={<GitBranch size={14} />}
          title="载入的索引与当前 head 不一致"
          action={hasMr ? <Btn size="sm" variant="primary" onClick={props.onIndex}>更新到当前 head</Btn> : undefined}
        >
          当前载入 {status.label}（{status.ref.slice(0, 8)}），页面 head 是 {status.currentRef.slice(0, 8)}。
          符号与调用链可能已过期，Review 也不会注入这份仓库上下文。
        </Banner>
      )}

      <RegistryCard
        status={status}
        maxIndexes={maxIndexes}
        onActivate={props.onActivate}
        onRemove={props.onRemove}
        onClear={props.onClear}
      />

      {status.state === 'ready' && (
        <>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: C.textMuted }} />
            <input
              value={query} onChange={(event) => { setQuery(event.target.value); setChain(undefined); }}
              placeholder="搜索符号：函数 / 方法 / 类 / 类型…"
              aria-label="符号搜索" autoComplete="off"
              style={{
                width: '100%', height: 32, padding: '0 10px 0 28px', borderRadius: C.radius,
                border: `1.5px solid ${C.border}`, background: C.bg, fontSize: 12, color: C.text, outline: 'none', ...mono,
              }}
            />
          </div>

          {debounced.trim() && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {results.defs.length === 0 && results.refs.length === 0 && (
                <EmptyState title={`没有匹配「${debounced}」的符号`}>
                  试试更短的前缀；索引只覆盖已缓存的代码文件。
                </EmptyState>
              )}
              {results.defs.map((def) => (
                <button
                  key={`${def.path}:${def.line}:${def.name}`} type="button"
                  onClick={() => setChain({ symbol: def.name, node: props.onCallChain(def.name, 2), depth: 2 })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', textAlign: 'left',
                    border: `1px solid ${chain?.symbol === def.name ? C.primary : C.border}`,
                    borderRadius: C.radiusSm, background: chain?.symbol === def.name ? C.primaryLight : C.bg,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <Pill tone={def.kind === 'class' || def.kind === 'type' ? 'model' : 'rule'}>{def.kind}</Pill>
                  <span style={{ fontSize: 12, fontWeight: 600, color: C.text, ...mono }}>{def.name}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, color: C.textMuted, ...mono }}>
                    {def.path}:{def.line}
                  </span>
                  <GitBranch size={12} style={{ color: C.textMuted, flexShrink: 0 }} />
                </button>
              ))}
              {results.refs.length > 0 && (
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginTop: 2 }}>引用 / 调用点（{results.refs.length}）</div>
              )}
              {results.refs.slice(0, 40).map((ref, index) => (
                <div key={`${ref.path}:${ref.line}:${index}`} style={{
                  display: 'flex', gap: 7, padding: '4px 9px', border: `1px solid ${C.border}`,
                  borderRadius: C.radiusSm, background: C.bg, alignItems: 'baseline',
                }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: ref.call ? C.primary : C.textMuted, flexShrink: 0 }}>
                    {ref.call ? '调用' : '引用'}
                  </span>
                  <span style={{ fontSize: 10.5, color: C.textMuted, flexShrink: 0, ...mono }}>{ref.path}:{ref.line}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: C.textSecondary, ...mono }}>
                    {ref.text}
                  </span>
                </div>
              ))}
            </div>
          )}

          {chain && (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: C.radiusLg, padding: 10, background: C.bg }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                <GitBranch size={13} style={{ color: C.primary }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: C.text, ...mono }}>{chain.symbol}</span>
                <span style={{ fontSize: 11, color: C.textMuted }}>调用链（向上 {chain.depth} 层，启发式）</span>
                <span style={{ flex: 1 }} />
                <button type="button" aria-label="关闭调用链" onClick={() => setChain(undefined)}
                  style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 2 }}>
                  <X size={13} />
                </button>
              </div>
              {chain.node ? <ChainNode node={chain.node} depth={0} /> : <div style={{ fontSize: 11, color: C.textMuted }}>索引不可用。</div>}
            </div>
          )}
        </>
      )}

      {status.state === 'idle' && !indexing && (
        <EmptyState icon={<Database size={18} />} title="还没有建立索引">
          {hasMr
            ? '建立索引会按当前 head ref 拉取仓库代码文件并缓存到浏览器本地（受设置中的文件数 / 体积上限约束），之后符号搜索、调用链和 Review 的仓库上下文才可用。'
            : '请在 MR 或 commit 页面建立索引。'}
        </EmptyState>
      )}
      {indexing && status.progress.total === 0 && (
        <EmptyState icon={<Loader2 size={18} className="ra-spin" />} title="正在读取仓库文件清单…">
          通过 GitLab repository tree API 递归列举文件。
        </EmptyState>
      )}
    </div>
  );
}

function RegistryCard({ status, maxIndexes, onActivate, onRemove, onClear }: {
  status: RepoIndexStatus;
  maxIndexes: number;
  onActivate: (ref: string) => void;
  onRemove: (ref: string) => void;
  onClear: () => void;
}) {
  const totalBytes = status.registry.reduce((total, entry) => total + entry.bytes, 0);
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: C.radiusLg, padding: 11, background: C.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <HardDrive size={13} style={{ color: C.textSecondary }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>已缓存索引</span>
        <span style={{ fontSize: 10.5, color: C.textMuted }}>{status.registry.length}/{maxIndexes} 份 · {formatBytes(totalBytes)}</span>
        <span style={{ flex: 1 }} />
        {status.storage.usage !== undefined && (
          <span style={{ fontSize: 10, color: C.textMuted, ...mono }} title="浏览器站点存储用量 / 配额">
            站点存储 {formatBytes(status.storage.usage)}{status.storage.quota ? ` / ${formatBytes(status.storage.quota)}` : ''}
          </span>
        )}
        <button type="button" onClick={onClear} disabled={status.registry.length === 0}
          title="删除全部本地索引" aria-label="删除全部本地索引"
          style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 2, opacity: status.registry.length === 0 ? 0.4 : 1 }}>
          <Trash2 size={13} />
        </button>
      </div>

      {status.registry.length === 0 ? (
        <div style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.7 }}>
          还没有缓存。每个 branch / commit 的索引各自独立保存，切换 MR 时命中同 ref 可直接恢复；
          超过 {maxIndexes} 份会自动清理最旧的。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {[...status.registry]
            .sort((a, b) => b.indexedAt.localeCompare(a.indexedAt))
            .map((entry) => {
              const active = entry.ref === status.ref;
              const isHead = entry.ref === status.currentRef;
              return (
                <div key={entry.ref} style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px',
                  border: `1px solid ${active ? C.primary : C.border}`,
                  background: active ? C.primaryLight : C.bgSubtle, borderRadius: C.radiusSm,
                }}>
                  <GitBranch size={12} style={{ color: active ? C.primary : C.textMuted, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entry.label}
                      </span>
                      <span style={{ fontSize: 10, color: C.textMuted, ...mono }}>{entry.ref.slice(0, 8)}</span>
                      {active && <Pill tone="success">已载入</Pill>}
                      {isHead && <Pill>当前 head</Pill>}
                    </div>
                    <div style={{ fontSize: 10, color: C.textMuted, marginTop: 1, ...mono }}>
                      {entry.files} 文件 · {formatBytes(entry.bytes)} · {entry.symbols} 符号 · {new Date(entry.indexedAt).toLocaleString('zh-CN')}
                    </div>
                  </div>
                  {!active && (
                    <Btn size="sm" variant="outline" onClick={() => onActivate(entry.ref)}>载入</Btn>
                  )}
                  <Btn size="sm" variant="ghost" onClick={() => onRemove(entry.ref)} title="删除这份索引" ariaLabel={`删除索引 ${entry.label}`}>
                    <Trash2 size={12} />
                  </Btn>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function ChainNode({ node, depth }: { node: CallChainNode; depth: number }) {
  return (
    <div style={{ marginLeft: depth > 0 ? 14 : 0, borderLeft: depth > 0 ? `2px solid ${C.border}` : 'none', paddingLeft: depth > 0 ? 10 : 0 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: C.text, ...mono }}>
        {node.symbol}
        {node.def && <span style={{ fontWeight: 400, color: C.textMuted }}> · {node.def.path}:{node.def.line}</span>}
      </div>
      {node.callers.length === 0 ? (
        <div style={{ fontSize: 11, color: C.textMuted, padding: '2px 0 6px' }}>没有发现调用点。</div>
      ) : (
        <div style={{ padding: '2px 0 6px' }}>
          {node.callers.map((caller, index) => (
            <div key={`${caller.path}:${caller.line}:${index}`} style={{ fontSize: 11, color: C.textSecondary, padding: '1px 0', ...mono }}>
              └ {caller.path}:{caller.line} ← {caller.symbol}
            </div>
          ))}
        </div>
      )}
      {node.children.map((child) => <ChainNode key={`${child.symbol}-${child.children.length}`} node={child} depth={depth + 1} />)}
    </div>
  );
}

const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' };
