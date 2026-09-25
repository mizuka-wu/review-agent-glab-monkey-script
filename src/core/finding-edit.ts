import type {
  Finding,
  FindingCategory,
  FindingConfidence,
  FindingSeverity,
} from './types';

export interface FindingEdit {
  title: string;
  content: string;
  comment: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
}

function normalizeTitle(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function required(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}不能为空`);
  return normalized;
}

export function findingEditableFields(finding: Finding): FindingEdit {
  return {
    title: finding.title,
    content: finding.content,
    comment: finding.comment,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
  };
}

export function applyFindingEdit(finding: Finding, edit: FindingEdit): Finding {
  return {
    ...finding,
    title: required(normalizeTitle(edit.title), '标题'),
    content: required(edit.content, '说明'),
    comment: required(edit.comment, '评论'),
    category: edit.category,
    severity: edit.severity,
    confidence: edit.confidence,
    edited: true,
  };
}
