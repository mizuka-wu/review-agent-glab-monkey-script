import { describe, expect, it } from 'vitest';
import { normalizeFileDiff } from '../../src/core/diff';
import { runRuleReview } from '../../src/core/rules';

describe('deterministic review rules', () => {
  it('reports real risky changes and missing tests', () => {
    const file = normalizeFileDiff({
      old_path: 'src/payment.ts',
      new_path: 'src/payment.ts',
      diff: [
        '@@ -1,2 +1,4 @@',
        ' export function pay() {',
        '+  const apiKey = "sk-live-123";',
        '+  console.log(apiKey);',
        '+  return handle(error as any);',
        ' }',
      ].join('\n'),
    });
    const findings = runRuleReview([file]);
    expect(findings.map((finding) => finding.category)).toEqual(
      expect.arrayContaining(['security', 'maintainability', 'bug', 'test']),
    );
    expect(findings.every((finding) => finding.source === 'rule' && finding.line > 0)).toBe(true);
  });

  it('does not report missing tests when tests are part of the change', () => {
    const implementation = normalizeFileDiff({
      old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new;',
    });
    const test = normalizeFileDiff({
      old_path: 'src/a.test.ts', new_path: 'src/a.test.ts', diff: '@@ -1 +1 @@\n-a\n+expect(new).toBeDefined();',
    });
    expect(runRuleReview([implementation, test]).some((finding) => finding.category === 'test')).toBe(false);
  });
});
