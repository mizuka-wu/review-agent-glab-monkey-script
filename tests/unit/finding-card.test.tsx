import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FindingCard } from '../../src/components/review/FindingCard';
import type { Finding } from '../../src/core/types';

const finding: Finding = {
  id: 'finding-1', fingerprint: 'ra-fingerprint', path: 'src/a.ts', line: 4, endLine: 4, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Original', content: 'Original content',
  evidence: [], existingCode: '', suggestionCode: '', comment: 'Original comment', source: 'model', status: 'draft',
};

describe('FindingCard', () => {
  it('edits finding text and submits the normalized update', () => {
    const onEdit = vi.fn();
    render(<FindingCard
      finding={finding}
      expanded
      publishDisabled={false}
      onToggle={() => undefined}
      onLocate={() => undefined}
      onCopy={() => undefined}
      onPublish={() => undefined}
      onIgnore={() => undefined}
      onEdit={onEdit}
    />);

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
