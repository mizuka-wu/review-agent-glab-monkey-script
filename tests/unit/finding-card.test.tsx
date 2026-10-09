import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindingCard } from '../../src/components/review/FindingCard';
import type { Finding } from '../../src/core/types';

const finding: Finding = {
  id: 'finding-1', fingerprint: 'ra-fingerprint', path: 'src/a.ts', line: 4, endLine: 4, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Original', content: 'Original content',
  evidence: [], existingCode: '', suggestionCode: '', comment: 'Original comment', source: 'model', status: 'draft',
};

const cardProps = {
  finding,
  expanded: true,
  publishDisabled: false,
  onToggle: () => undefined,
  onLocate: () => undefined,
  onCopy: () => undefined,
  onPublish: () => undefined,
  onIgnore: () => undefined,
  onMarkFixed: () => undefined,
};

afterEach(cleanup);

describe('FindingCard', () => {
  it('labels the publish entry by its publish mode', () => {
    const { rerender } = render(<FindingCard {...cardProps} publishMode="inline" />);
    expect(screen.getByRole('button', { name: '行内评论' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '行内评论' })).toHaveAttribute('title', '行内评论：挂在 diff 第 4 行上');
    expect(screen.getByText('行内 L4')).toBeVisible();

    rerender(<FindingCard {...cardProps} publishMode="full" publishIssue="Diff 中找不到第 4 行" />);
    expect(screen.getByRole('button', { name: '全文评论' })).toBeEnabled();
    expect(screen.getByText('全文')).toBeVisible();
    expect(screen.getByText('将发布为全文评论：Diff 中找不到第 4 行')).toBeVisible();
  });

  it('edits finding text and submits the normalized update', () => {
    const onEdit = vi.fn();
    render(<FindingCard {...cardProps} publishMode="inline" onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Updated title' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Updated title',
      content: 'Original content',
      comment: 'Original comment',
    }));
  });
});
