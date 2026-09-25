import { describe, expect, it } from 'vitest';
import { applyFindingEdit, findingEditableFields } from '../../src/core/finding-edit';
import type { Finding } from '../../src/core/types';

const finding: Finding = {
  id: 'finding-1', fingerprint: 'ra-fingerprint', path: 'src/a.ts', line: 4, endLine: 4, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Original', content: 'Original content',
  evidence: [], existingCode: 'code()', suggestionCode: '', comment: 'Original comment', source: 'model', status: 'draft',
};

describe('finding edit', () => {
  it('updates editable fields without changing stable identity', () => {
    const edited = applyFindingEdit(finding, {
      ...findingEditableFields(finding),
      title: '  Updated   title ',
      content: 'Updated content',
      comment: 'Updated comment',
      severity: 'high',
    });

    expect(edited).toMatchObject({
      id: 'finding-1',
      fingerprint: 'ra-fingerprint',
      title: 'Updated title',
      severity: 'high',
      edited: true,
    });
  });

  it('rejects empty required text fields', () => {
    expect(() => applyFindingEdit(finding, {
      ...findingEditableFields(finding),
      title: ' ',
    })).toThrow('标题不能为空');
  });
});
