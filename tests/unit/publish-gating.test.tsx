import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FindingsPanel, type FindingsPanelProps } from '../../src/components/review/FindingsPanel';
import { BatchPublishDialog, PublishDialog } from '../../src/components/review/PublishDialog';
import type { Finding } from '../../src/core/types';

const draft = (input: Partial<Finding> = {}): Finding => ({
  id: 'f1', fingerprint: 'fp', path: 'src/a.ts', line: 2, endLine: 2, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
  evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment', source: 'model', status: 'draft',
  ...input,
});

const noop = () => undefined;
const OUT_OF_DIFF = 'Diff 中找不到第 99 行，且无法按 Finding 内容自动修正位置';

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
    publishBlockReason: () => undefined,
    inlinePublishable: (finding) => finding.status === 'draft',
    canApprove: true,
    quickBusy: false,
    onApprove: noop,
    onPublishAllInline: noop,
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
    expect(screen.getByRole('button', { name: '发布到 GitLab' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /一键行内评论 \(1\)/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: '选择全部可发布' })).toBeEnabled();
  });

  it('disables every publish entry with a reason while a review is running', () => {
    render(<FindingsPanel {...panelProps({
      running: true, canPublish: false, publishDisabledReason: '评审进行中，请等本次 Review 结束后再发布',
    })} />);
    const reason = '评审进行中，请等本次 Review 结束后再发布';
    expect(screen.getByRole('button', { name: '发布到 GitLab' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '发布到 GitLab' })).toHaveAttribute('title', reason);
    expect(screen.getByRole('button', { name: /一键行内评论/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /一键行内评论/ })).toHaveAttribute('title', reason);
    expect(screen.getByRole('button', { name: '总评论' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '选择全部可发布' })).toBeDisabled();
  });

  it('disables a single finding whose line cannot be relocated and shows why', () => {
    render(<FindingsPanel {...panelProps({
      publishBlockReason: () => OUT_OF_DIFF,
      inlinePublishable: () => false,
    })} />);
    expect(screen.getByRole('button', { name: '发布到 GitLab' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '发布到 GitLab' })).toHaveAttribute('title', OUT_OF_DIFF);
    expect(screen.getByText(OUT_OF_DIFF)).toBeVisible();
    expect(screen.getByRole('button', { name: /一键行内评论/ })).toBeDisabled();
  });

  it('disables batch publishing when no selected finding can be published', () => {
    render(<FindingsPanel {...panelProps({
      selectedIds: new Set(['f1', 'f2']),
      inlinePublishable: () => false,
    })} />);
    expect(screen.getByRole('button', { name: /批量发布/ })).toBeDisabled();
    expect(screen.getByText('可发布 0')).toBeVisible();
  });

  it('counts only publishable findings in the batch button', () => {
    render(<FindingsPanel {...panelProps({
      findings: [draft(), draft({ id: 'f2', line: 9, existingCode: 'const y = 2;' })],
      selectedIds: new Set(['f1', 'f2']),
      publishBlockReason: (finding) => (finding.id === 'f2' ? OUT_OF_DIFF : undefined),
      inlinePublishable: (finding) => finding.status === 'draft' && finding.id !== 'f2',
    })} />);
    expect(screen.getByRole('button', { name: '批量发布 (1)' })).toBeEnabled();
    expect(screen.getByText('可发布 1')).toBeVisible();
  });
});

describe('publish dialogs', () => {
  it('blocks confirming a single finding that cannot be positioned', () => {
    render(<PublishDialog
      finding={draft({ line: 99 })} body="comment" onBodyChange={noop} publishing={false}
      blockReason={OUT_OF_DIFF} meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认发布' })).toBeDisabled();
    expect(screen.getByText('无法作为行级评论发布')).toBeVisible();
    expect(screen.getByText(OUT_OF_DIFF)).toBeVisible();
  });

  it('reports an auto-corrected position before confirming', () => {
    render(<PublishDialog
      finding={draft({ line: 2, anchor: { source: 'diff', publishable: true, corrected: true } })}
      body="comment" onBodyChange={noop} publishing={false} meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认发布' })).toBeEnabled();
    expect(screen.getByText('评论位置已自动修正')).toBeVisible();
  });

  it('keeps the confirm button enabled only for findings that can be published', () => {
    render(<BatchPublishDialog
      findings={[draft()]} publishing={false} skipped={2} meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认批量发布 1 条' })).toBeEnabled();
    expect(screen.getByText('已跳过 2 条选中的 Finding')).toBeVisible();
  });

  it('blocks batch publishing while the panel is blocked', () => {
    render(<BatchPublishDialog
      findings={[draft()]} publishing={false} blockReason="评审进行中，请等本次 Review 结束后再发布"
      meta={meta} onCancel={noop} onConfirm={noop}
    />);
    expect(screen.getByRole('button', { name: '确认批量发布 1 条' })).toBeDisabled();
    expect(screen.getByText('当前无法发布')).toBeVisible();
  });
});
