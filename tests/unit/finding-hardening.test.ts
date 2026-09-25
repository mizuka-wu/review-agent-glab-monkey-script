import { describe, expect, it } from 'vitest';
import {
  applyEffortBudget,
  calibrateSeverity,
  checkEvidenceSufficiency,
  hardenFindings,
  mergeSimilarFindings,
} from '../../src/core/finding-hardening';
import type { Finding, FileDiff } from '../../src/core/types';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    fingerprint: 'fp1',
    path: 'src/app.ts',
    line: 10,
    endLine: 10,
    side: 'new',
    category: 'bug',
    severity: 'medium',
    confidence: 'medium',
    title: 'Possible null dereference',
    content: 'The variable may be null when accessed without a guard.',
    evidence: [{ path: 'src/app.ts', lines: 'L10', quote: 'const x = obj.field;' }],
    existingCode: 'const x = obj.field;',
    suggestionCode: '',
    comment: 'Possible null dereference\n\nThe variable may be null.',
    source: 'model',
    status: 'draft',
    ...overrides,
  };
}

function makeFile(path: string): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    diff: '',
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    lines: [],
  };
}

const testFile = makeFile('src/app.ts');

describe('calibrateSeverity', () => {
  it('raises security low to medium', () => {
    const f = makeFinding({ category: 'security', severity: 'low' });
    expect(calibrateSeverity(f).severity).toBe('medium');
  });

  it('lowers maintainability high to medium', () => {
    const f = makeFinding({ category: 'maintainability', severity: 'high' });
    expect(calibrateSeverity(f).severity).toBe('medium');
  });

  it('lowers test critical to medium', () => {
    const f = makeFinding({ category: 'test', severity: 'critical' });
    expect(calibrateSeverity(f).severity).toBe('medium');
  });

  it('caps severity when evidence is empty', () => {
    const f = makeFinding({ severity: 'high', evidence: [] });
    expect(calibrateSeverity(f).severity).toBe('medium');
  });

  it('preserves severity when appropriate', () => {
    const f = makeFinding({ category: 'bug', severity: 'high' });
    expect(calibrateSeverity(f).severity).toBe('high');
  });
});

describe('checkEvidenceSufficiency', () => {
  it('passes well-evidenced finding', () => {
    const result = checkEvidenceSufficiency(makeFinding(), [testFile]);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('fails when existingCode is missing', () => {
    const result = checkEvidenceSufficiency(makeFinding({ existingCode: '', evidence: [] }), [testFile]);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes('existingCode'))).toBe(true);
  });

  it('fails when evidence is empty', () => {
    const result = checkEvidenceSufficiency(makeFinding({ evidence: [] }), [testFile]);
    expect(result.issues.some((i) => i.includes('证据'))).toBe(true);
    expect(result.score).toBeLessThan(1.0);
  });

  it('fails when file not in diff', () => {
    const otherFile = makeFile('src/other.ts');
    const result = checkEvidenceSufficiency(makeFinding(), [otherFile]);
    expect(result.issues.some((i) => i.includes('不在 Diff'))).toBe(true);
  });
});

describe('mergeSimilarFindings', () => {
  it('merges identical title/path/line findings', () => {
    const a = makeFinding({ id: 'a', content: 'short' });
    const b = makeFinding({ id: 'b', content: 'a much longer description of the issue' });
    const result = mergeSimilarFindings([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('a much longer description of the issue');
  });

  it('does not merge different titles', () => {
    const a = makeFinding({ id: 'a', title: 'Null dereference risk' });
    const b = makeFinding({ id: 'b', title: 'SQL injection vulnerability' });
    const result = mergeSimilarFindings([a, b]);
    expect(result).toHaveLength(2);
  });

  it('does not merge different paths', () => {
    const a = makeFinding({ id: 'a', path: 'src/a.ts' });
    const b = makeFinding({ id: 'b', path: 'src/b.ts' });
    const result = mergeSimilarFindings([a, b]);
    expect(result).toHaveLength(2);
  });

  it('does not merge different lines', () => {
    const a = makeFinding({ id: 'a', line: 10, endLine: 10 });
    const b = makeFinding({ id: 'b', line: 20, endLine: 20 });
    const result = mergeSimilarFindings([a, b]);
    expect(result).toHaveLength(2);
  });
});

describe('applyEffortBudget', () => {
  it('fast: only high confidence + high/critical severity', () => {
    const findings = [
      makeFinding({ id: 'a', confidence: 'high', severity: 'high' }),
      makeFinding({ id: 'b', confidence: 'medium', severity: 'high' }),
      makeFinding({ id: 'c', confidence: 'high', severity: 'medium' }),
    ];
    const result = applyEffortBudget(findings, 'fast');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('balanced: filters low confidence', () => {
    const findings = [
      makeFinding({ id: 'a', confidence: 'high' }),
      makeFinding({ id: 'b', confidence: 'low' }),
    ];
    const result = applyEffortBudget(findings, 'balanced');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('thorough: keeps everything', () => {
    const findings = [
      makeFinding({ id: 'a', confidence: 'high' }),
      makeFinding({ id: 'b', confidence: 'low' }),
      makeFinding({ id: 'c', severity: 'low' }),
    ];
    const result = applyEffortBudget(findings, 'thorough');
    expect(result).toHaveLength(3);
  });
});

describe('hardenFindings', () => {
  it('runs the full pipeline and reports stats', () => {
    const findings = [
      makeFinding({ id: 'a', category: 'security', severity: 'low', confidence: 'high' }),
      makeFinding({ id: 'b', content: 'x', existingCode: '', evidence: [] }),
    ];
    const result = hardenFindings(findings, [testFile], 'balanced');
    expect(result.severityAdjusted).toBeGreaterThanOrEqual(0);
    expect(result.findings.length).toBeLessThanOrEqual(findings.length);
    expect(result.evidenceChecks).toHaveLength(2);
  });
});
