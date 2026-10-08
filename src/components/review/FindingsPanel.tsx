import { useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCheck, ChevronDown, ChevronRight, FileText, Inbox, ListChecks, Loader2,
  Download, MessageSquarePlus, RotateCcw, Share2, ShieldCheck, Sparkles, SquareCheckBig, ThumbsUp, X,
} from 'lucide-react';
import {
  Banner, Btn, ConfirmButton, EmptyState, IconButton, Pill, Segmented, sourceTone, tokens as C,
} from '../ui/modern';
import { FindingCard } from './FindingCard';
import type { FindingEdit } from '../../core/finding-edit';
import type { Finding, ReviewStageReport } from '../../core/types';

export type SourceFilter = 'all' | 'rule' | 'model';
export type SortKey = 'severity' | 'path' | 'source';

const categoryLabel = { bug: '缺陷', security: '安全', performance: '性能', maintainability: '可维护性', test: '测试' };
export const statusLabel: Record<Finding['status'], string> = { draft: '待处理', ignored: '已忽略', published: '已发布', failed: '发布失败', fixed: '已修复' };
export const severityLabel: Record<Finding['severity'], string> = { critical: '严重', high: '高', medium: '中', low: '低' };
const severityOrder: Record<Finding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** 合并过的 Finding 同时属于两个来源，任一筛选都应该能看到它。 */
function involves(finding: Finding, source: 'rule' | 'model'): boolean {
  return finding.source === source || finding.corroborated === source;
}

const selectStyle: React.CSSProperties = {
  height: 26, padding: '0 6px', borderRadius: C.radiusSm, border: `1px solid ${C.border}`,
  fontSize: 11, color: C.textSecondary, background: C.bg, cursor: 'pointer', outline: 'none',
  maxWidth: 92,
};

export interface FindingsPanelProps {
  findings: Finding[];
  running: boolean;
  stages?: { rules: ReviewStageReport; model: ReviewStageReport };
  warnings: string[];
  error: string;
  modelReady: boolean;
  rulesOnlyMode: boolean;
  enabledRuleCount: number;
  canPublish: boolean;
  publishDisabledReason?: string;
  canApprove: boolean;
  quickBusy: boolean;
  onApprove: () => void;
  onPublishAllInline: () => void;
  onSummaryComment: () => void;
  onExportFindings: () => void;
  onExportDelegation: () => void;
  canDelegate: boolean;
  expandedId: string;
  selectedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onSelectPublishable: () => void;
  onClearSelection: () => void;
  onBatchPublish: () => void;
  onLocate: (finding: Finding) => void;
  onCopy: (finding: Finding) => void;
  onPublish: (finding: Finding) => void;
  onIgnore: (finding: Finding) => void;
  onMarkFixed: (finding: Finding) => void;
  onEdit: (id: string, edit: FindingEdit) => void;
  onOpenSettings: () => void;
  onDismissError: () => void;
}

export function FindingsPanel(props: FindingsPanelProps) {
  const {
    findings, running, stages, warnings, error, modelReady, rulesOnlyMode, enabledRuleCount,
    canPublish, publishDisabledReason, canApprove, quickBusy, expandedId, selectedIds,
  } = props;

  const [source, setSource] = useState<SourceFilter>('all');
  const [severity, setSeverity] = useState('all');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState<SortKey>('severity');
  const [limit, setLimit] = useState(30);
  const [showWarnings, setShowWarnings] = useState(false);

  const counts = useMemo(() => ({
    rule: findings.filter((f) => involves(f, 'rule')).length,
    model: findings.filter((f) => involves(f, 'model')).length,
    both: findings.filter((f) => Boolean(f.corroborated)).length,
    high: findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length,
    draft: findings.filter((f) => f.status === 'draft').length,
  }), [findings]);

  const visible = useMemo(() => {
    let result = findings;
    if (source !== 'all') result = result.filter((f) => involves(f, source));
    if (severity !== 'all') result = result.filter((f) => f.severity === severity);
    if (category !== 'all') result = result.filter((f) => f.category === category);
    if (status !== 'all') result = result.filter((f) => f.status === status);
    return [...result].sort((a, b) => {
      if (sort === 'path') return a.path.localeCompare(b.path) || a.line - b.line;
      if (sort === 'source') {
        if (a.source !== b.source) return a.source === 'rule' ? -1 : 1;
        return severityOrder[a.severity] - severityOrder[b.severity] || a.path.localeCompare(b.path);
      }
      return severityOrder[a.severity] - severityOrder[b.severity]
        || (a.source === b.source ? 0 : a.source === 'rule' ? -1 : 1)
        || a.path.localeCompare(b.path) || a.line - b.line;
    });
  }, [findings, source, severity, category, status, sort]);

  const groups = useMemo(() => {
    if (source !== 'all') return [{ key: source, items: visible }];
    const rule = visible.filter((f) => f.source === 'rule');
    const model = visible.filter((f) => f.source === 'model');
    return ([['rule', rule], ['model', model]] as const).filter(([, items]) => items.length > 0)
      .map(([key, items]) => ({ key, items }));
  }, [source, visible]);

  const filterActive = source !== 'all' || severity !== 'all' || category !== 'all' || status !== 'all';
  const publishableCount = findings.filter((f) => f.status === 'draft' && f.anchor?.publishable !== false).length;

  if (error && findings.length === 0) {
    return (
      <div style={{ padding: 12 }}>
        <Banner tone="danger" icon={<AlertTriangle size={14} />} title="Review 未能完成" onDismiss={props.onDismissError}>
          {error}
        </Banner>
      </div>
    );
  }

  if (findings.length === 0 && !running) {
    return (
      <EmptyState
        icon={<Inbox size={18} />}
        title={stages ? '没有发现需要处理的问题' : '还没有运行 Review'}
      >
        {stages
          ? <>规则检查{stages.rules.ran ? `已执行 ${stages.rules.rules} 条规则` : '未执行'}
            {stages.model.ran ? `，AI 评审已完成` : modelReady ? '' : '；未配置模型，AI 评审已跳过'}。当前变更没有命中任何问题。</>
          : <>点击「开始 Review」：先在浏览器本地跑确定性规则检查（{enabledRuleCount} 条规则，零 token）
            {modelReady ? '，再叠加 AI 深度评审。' : '。配置 API Key 后可叠加 AI 深度评审。'}</>}
      </EmptyState>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0 }}>
      {/* Summary */}
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}`, background: C.bgSubtle, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{findings.length} 个问题</span>
          {counts.high > 0 && <Pill tone="danger" count={counts.high}>高危</Pill>}
          <span style={{ flex: 1 }} />
          {counts.rule > 0 && <Pill tone="rule" count={counts.rule}>{sourceTone.rule.label}</Pill>}
          {counts.model > 0 && <Pill tone="model" count={counts.model}>{sourceTone.model.label}</Pill>}
          {counts.both > 0 && <Pill tone="success" count={counts.both}>相互印证</Pill>}
          {warnings.length > 0 && (
            <IconButton
              icon={showWarnings ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              label="运行说明" onClick={() => setShowWarnings((v) => !v)} active={showWarnings}
            />
          )}
        </div>

        {showWarnings && (
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: C.textSecondary, lineHeight: 1.7 }}>
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        )}

        {modelReady && rulesOnlyMode && (
          <Banner tone="info" icon={<ShieldCheck size={14} />} title="仅规则模式">
            已按设置跳过 AI 评审，只运行 {stages?.rules.rules ?? enabledRuleCount} 条本地规则。可在「设置 → 审查设置」切回「规则 + AI」。
          </Banner>
        )}
        {modelReady && stages && !stages.model.ran && stages.model.error && (
          <Banner tone="danger" icon={<AlertTriangle size={14} />} title="AI 评审失败，已保留规则结果">
            {stages.model.error}
          </Banner>
        )}

        {/* Filters */}
        <Segmented
          value={source} onChange={(v) => { setSource(v as SourceFilter); setLimit(30); }}
          style={{ padding: 2 }}
            options={[
              { value: 'all', label: `全部 ${findings.length}` },
              { value: 'rule', label: `规则 ${counts.rule}` },
              { value: 'model', label: `AI ${counts.model}` },
            ]}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <select autoComplete="off" aria-label="严重度筛选" value={severity} onChange={(e) => { setSeverity(e.target.value); setLimit(30); }} style={selectStyle}>
            <option value="all">全部严重度</option>
            {Object.entries(severityLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select autoComplete="off" aria-label="分类筛选" value={category} onChange={(e) => { setCategory(e.target.value); setLimit(30); }} style={selectStyle}>
            <option value="all">全部分类</option>
            {Object.entries(categoryLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select autoComplete="off" aria-label="状态筛选" value={status} onChange={(e) => { setStatus(e.target.value); setLimit(30); }} style={selectStyle}>
            <option value="all">全部状态</option>
            {Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select autoComplete="off" aria-label="排序方式" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={selectStyle}>
            <option value="severity">按严重度</option>
            <option value="source">按来源</option>
            <option value="path">按文件</option>
          </select>
          <span style={{ flex: 1 }} />
          {filterActive && (
            <IconButton
              icon={<X size={13} />} label="清除筛选"
              onClick={() => { setSource('all'); setSeverity('all'); setCategory('all'); setStatus('all'); setLimit(30); }}
            />
          )}
        </div>
      </div>

      {/* List */}
      <div className="ra-scroll" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', padding: '8px 10px 12px', scrollPaddingTop: 34 }}>
        {visible.length === 0 && running ? (
          <EmptyState icon={<Loader2 size={18} className="ra-spin" />} title="正在收集结果">
            规则检查在本地执行，模型分析可能需要十几秒。结果会按来源分组出现在这里。
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon={<ListChecks size={18} />} title="没有符合筛选条件的结果">
            当前筛选组合下没有问题。清除筛选可查看全部 {findings.length} 个。
          </EmptyState>
        ) : groups.map((group) => {
          const tone = sourceTone[group.key as 'rule' | 'model'];
          return (
            <section key={group.key} style={{ marginBottom: 12 }}>
              {source === 'all' && groups.length > 1 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '5px 2px 6px',
                  position: 'sticky', top: 0, background: C.bg, zIndex: 1,
                  borderBottom: `1px solid ${C.border}`, marginBottom: 6,
                }}>
                  <span style={{ display: 'flex', color: tone.fg }}>
                    {group.key === 'rule' ? <ShieldCheck size={13} /> : <Sparkles size={13} />}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: tone.fg }}>
                    {group.key === 'rule' ? '规则命中 · 确定性检查' : 'AI 评审 · 模型分析'}
                  </span>
                  <span style={{ fontSize: 10, color: C.textMuted }}>{group.items.length}</span>
                  <span style={{ flex: 1, height: 1, background: C.border }} />
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {group.items.slice(0, limit).map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    expanded={expandedId === finding.id}
                    selected={selectedIds.has(finding.id)}
                    publishDisabled={!canPublish || finding.anchor?.publishable === false}
                    publishDisabledReason={
                      finding.anchor?.publishable === false ? '该 Finding 只锚定到完整文件，无法作为行级评论发布'
                        : publishDisabledReason
                    }
                    onToggle={() => props.onToggleExpand(finding.id)}
                    onSelect={() => props.onToggleSelect(finding.id)}
                    onLocate={() => props.onLocate(finding)}
                    onCopy={() => props.onCopy(finding)}
                    onPublish={() => props.onPublish(finding)}
                    onIgnore={() => props.onIgnore(finding)}
                    onMarkFixed={() => props.onMarkFixed(finding)}
                    onEdit={(edit) => props.onEdit(finding.id, edit)}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {visible.length > limit && (
          <Btn fullWidth variant="outline" size="sm" icon={<ChevronDown size={13} />} onClick={() => setLimit((n) => n + 30)}>
            显示更多（剩余 {visible.length - limit}）
          </Btn>
        )}
      </div>

      {/* Quick actions */}
      {(canApprove || findings.length > 0) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
          borderTop: `1px solid ${C.border}`, background: C.bg, flexShrink: 0,
        }}>
          <ConfirmButton
            label="一键 Approve" confirmLabel="确认 Approve？" icon={<ThumbsUp size={13} />}
            disabled={!canApprove || quickBusy} onConfirm={props.onApprove}
          />
          <ConfirmButton
            label={publishableCount > 0 ? `一键行内评论 (${publishableCount})` : '一键行内评论'}
            confirmLabel="确认发布？" icon={<MessageSquarePlus size={13} />}
            disabled={publishableCount === 0 || !canPublish || quickBusy} onConfirm={props.onPublishAllInline}
          />
          <span style={{ flex: 1 }} />
          <ConfirmButton
            label="总评论" confirmLabel="确认发布？" icon={<FileText size={13} />}
            disabled={findings.length === 0 || !canPublish || quickBusy} onConfirm={props.onSummaryComment}
          />
          <Btn size="sm" variant="ghost" icon={<Download size={13} />} disabled={findings.length === 0} onClick={props.onExportFindings}>
            导出 JSON
          </Btn>
          <Btn size="sm" variant="ghost" icon={<Share2 size={13} />} disabled={!props.canDelegate} onClick={props.onExportDelegation}>
            Delegation
          </Btn>
        </div>
      )}

      {/* Batch bar */}
      {counts.draft > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
          borderTop: `1px solid ${C.border}`, background: C.bgSubtle, flexShrink: 0,
        }}>
          {selectedIds.size > 0 ? (
            <>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.primary }}>已选 {selectedIds.size}</span>
              <Btn size="sm" variant="ghost" onClick={props.onClearSelection}>取消选择</Btn>
              <span style={{ flex: 1 }} />
              <Btn size="sm" variant="primary" icon={<CheckCheck size={13} />} disabled={!canPublish} onClick={props.onBatchPublish}>
                批量发布
              </Btn>
            </>
          ) : (
            <>
              <Btn size="sm" variant="ghost" icon={<SquareCheckBig size={13} />} disabled={!canPublish} onClick={props.onSelectPublishable}>
                选择全部可发布
              </Btn>
              <span style={{ flex: 1 }} />
              <Btn size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={props.onOpenSettings}>
                调整规则
              </Btn>
            </>
          )}
        </div>
      )}
    </div>
  );
}
