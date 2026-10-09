import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FindingsPanel, type FindingsPanelProps } from '../../src/components/review/FindingsPanel';
import { BatchPublishDialog, PublishDialog } from '../../src/components/review/PublishDialog';
import type { Finding, PublishMode } from '../../src/core/types';

const draft = (input: Partial<Finding> = {}): Finding => ({
  id: 'f1', fingerprint: 'fp', path: 'src/a.ts', line: 2, endLine: 2, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
  evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment', source: 'model', status: 'draft',
  ...input,
});

const noop = () => undefined;
const OUT_OF_DIFF = 'Diff 中找不到第 99 行，且无法按 Finding 内容自动修正位置';
const RUNNING = '评审进行中，请等本次 Review 结束后再发布';

function panelProps(overrides: Partial<FindingsPanelProps> = {}): FindingsPanelProps {
  return {
    findings: [draft()],
    running: false,
    warnings: [],
    error: '',
    modelReady: true,
    rulesOnlyMode: false,
    enabledRuleCount: 1,
    canPublish: true,
    publishPositionIssue: () => undefined,
    publishMode: () => 'inline',
    publishable: (finding) => finding.status === 'draft' && Boolean(finding.comment.trim()),
    canApprove: true,
    quickBusy: false,
    onApprove: noop,
    onPublishAll: noop,
    onSummaryComment: noop,
    onExportFindings: noop,
    onExportDelegation: noop,
    canDelegate: false,
    expandedId: 'f1',
    selectedIds: new Set<string>(),
    onToggleExpand: noop,
    onToggleSelect: noop,
    onSelectPublishable: noop,
    onClearSelection: noop,
    onBatchPublish: noop,
    onLocate: noop,
    onCopy: noop,
    onPublish: noop,
    onIgnore: noop,
    onMarkFixed: noop,
    onEdit: noop,
    onOpenSettings: noop,
    onDismissError: noop,
    ...overrides,
  };
}

const meta = { projectPath: 'group/project', mergeRequestIid: 7, headSha: 'head-sha' };

afterEach(cleanup);

describe('FindingsPanel publish gating', () => {
  it('keeps every publish entry enabled when the position resolves', () => {
    render(<FindingsPanel {...panelProps()} />);
    expect(screen.getByRole('button', { name: '行内评论' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /一键行内评论 \(1\)/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: '选择全部可发布' })).toBeEnabled();
    expect(screen.getByText('行内 L2')).toBeVisible();
  });

  it('disables every publish entry with a reason while a review is running', () => {
    render(<FindingsPanel {...panelProps({ running: true, canPublish: false, publishDisabledReason: RUNNING })} />);
    expect(screen.getByRole('button', { name: '行内评论' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '行内评论' })).toHaveAttribute('title', RUNNING);
    expect(screen.getByRole('button', { name: /一键行内评论/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /一键行内评论/ })).toHaveAttribute('title', RUNNING);
    expect(screen.getByRole('button', { name: '总评论' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '选择全部可发布' })).toBeDisabled();
  });

  it('keeps a finding without a resolvable line publishable as a full-text comment', () => {
    render(<FindingsPanel {...panelProps({
      findings: [draft({ line: 99 })],
      publishPositionIssue: () => OUT_OF_DIFF,
      publishMode: () => 'full',
    })} />);
    expect(screen.getByRole('button', { name: '全文评论' })).toBeEnabled();
    expect(screen.getByText('全文')).toBeVisible();
    expect(screen.getByText(`将发布为全文评论：${OUT_OF_DIFF}`)).toBeVisible();
    expect(screen.getByRole('button', { name: /一键全文评论 \(1\)/ })).toBeEnabled();
  });

  it('skips findings without a comment body', () => {
    render(<FindingsPanel {...panelProps({ findings: [draft({ comment: '  ' })] })} />);
    expect(screen.getByRole('button', { name: '一键发布' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '一键发布' })).toHaveAttribute('title', '没有可发布的 Finding：评论内容为空');
  });

  it('labels the batch button with the mode of the selection', () => {
    const findings = [draft(), draft({ id: 'f2', line: 9, existingCode: 'const y = 2;' })];
    const modes: Record<string, PublishMode> = { f1: 'inline', f2: 'full' };
    render(<FindingsPanel {...panelProps({
      findings,
      selectedIds: new Set(['f1', 'f2']),
      publishMode: (finding) => modes[finding.id],
      publishPositionIssue: (finding) => (finding.id === 'f2' ? OUT_OF_DIFF : undefined),
    })} />);
    expect(screen.getByRole('button', { name: '批量发布 (2)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '一键发布 (2)' })).toBeEnabled();
    expect(screen.getAllByText('行内 1 · 全文 1')).toHaveLength(2);
  });

  it('disables batch publishing when no selected finding can be published', () => {
    render(<FindingsPanel {...panelProps({
      selectedIds: new Set(['f1', 'f2']),
      publishable: () => false,
    })} />);
    expect(screen.getByRole('button', { name: /批量发布/ })).toBeDisabled();
    expect(screen.getByText('可发布 0')).toBeVisible();
  });

  it('counts only publishable findings in the batch button', () => {
    render(<FindingsPanel {...panelProps({
      findings: [draft(), draft({ id: 'f2', line: 9, comment: '' })],
      selectedIds: new Set(['f1', 'f2']),
    })} />);
    expect(screen.getByRole('button', { name: '批量行内评论 (1)' })).toBeEnabled();
    expect(screen.getByText('可发布 1')).toBeVisible();
  });
});

describe('publish dialogs', () => {
  it('confirms an inline comment when the position resolves', () => {
    render(<PublishDialog
      finding={draft()} body="comment" onBodyChange={noop} publishing={false} mode="inline"
      meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('dialog', { name: '发布行内评论' })).toBeVisible();
    expect(screen.getByRole('button', { name: '确认行内评论' })).toBeEnabled();
    expect(screen.getByText('行内 L2 · src/a.ts:2 · 新版本')).toBeVisible();
  });

  it('falls back to a full-text comment instead of blocking an unresolvable line', () => {
    render(<PublishDialog
      finding={draft({ line: 99 })} body="comment" onBodyChange={noop} publishing={false}
      mode="full" positionIssue={OUT_OF_DIFF} meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('dialog', { name: '发布全文评论' })).toBeVisible();
    expect(screen.getByRole('button', { name: '确认全文评论' })).toBeEnabled();
    expect(screen.getByText('将发布为 MR 级全文评论')).toBeVisible();
    expect(screen.getByText(OUT_OF_DIFF)).toBeVisible();
    expect(screen.getByText('全文（不带行位置） · src/a.ts:99')).toBeVisible();
  });

  it('blocks confirming while the panel is blocked', () => {
    render(<PublishDialog
      finding={draft()} body="comment" onBodyChange={noop} publishing={false} mode="inline"
      blockReason={RUNNING} meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认行内评论' })).toBeDisabled();
    expect(screen.getByText('当前无法发布')).toBeVisible();
    expect(screen.getByText(RUNNING)).toBeVisible();
  });

  it('blocks confirming when the comment body is empty', () => {
    render(<PublishDialog
      finding={draft()} body="  " onBodyChange={noop} publishing={false} mode="inline"
      meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认行内评论' })).toBeDisabled();
  });

  it('reports an auto-corrected position before confirming', () => {
    render(<PublishDialog
      finding={draft({ line: 2, anchor: { source: 'diff', publishable: true, corrected: true } })}
      body="comment" onBodyChange={noop} publishing={false} mode="inline" meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认行内评论' })).toBeEnabled();
    expect(screen.getByText('评论位置已自动修正')).toBeVisible();
  });

  it('labels the batch confirm button with the mode of the batch', () => {
    render(<BatchPublishDialog
      findings={[draft(), draft({ id: 'f2' })]} publishing={false} publishMode={() => 'full'}
      skipped={2} meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认批量全文评论 2 条' })).toBeEnabled();
    expect(screen.getAllByText('全文')).toHaveLength(2);
    expect(screen.getByText('已跳过 2 条选中的 Finding')).toBeVisible();
    expect(screen.getByText('它们不是待处理草稿，或评论内容为空。')).toBeVisible();
  });

  it('keeps the confirm button enabled only for findings that can be published', () => {
    render(<BatchPublishDialog
      findings={[draft()]} publishing={false} publishMode={() => 'inline'} meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认批量行内评论 1 条' })).toBeEnabled();
    expect(screen.getByText('行内 L2')).toBeVisible();
  });

  it('blocks batch publishing while the panel is blocked', () => {
    render(<BatchPublishDialog
      findings={[draft()]} publishing={false} publishMode={() => 'inline'} blockReason={RUNNING}
      meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认批量行内评论 1 条' })).toBeDisabled();
    expect(screen.getByText('当前无法发布')).toBeVisible();
  });
});
