import { describe, expect, it } from 'vitest';
import { normalizeFileDiff } from '../../src/core/diff';
import { fingerprintFinding, normalizeFindings, parseModelFindings } from '../../src/core/findings';

const file = normalizeFileDiff({
  old_path: 'src/a.ts',
  new_path: 'src/a.ts',
  diff: '@@ -1 +1 @@\n-old\n+const password = "secret";',
});

describe('finding pipeline', () => {
  it('creates stable fingerprints independent of whitespace and case', () => {
    const first = fingerprintFinding({ path: 'a.ts', existingCode: 'foo(  )', category: 'bug', title: 'Broken Flow' });
    const second = fingerprintFinding({ path: 'a.ts', existingCode: 'foo()', category: 'bug', title: 'broken flow' });
    expect(first).toBe(second);
  });

  it('normalizes enums, defaults and evidence', () => {
    const findings = normalizeFindings([{
      path: 'src/a.ts', line: 1, category: 'SECURITY', severity: 'HIGH', confidence: 'unknown',
      title: '  Hardcoded secret  ', content: ' Secret is committed. ', evidence: [{ quote: 'password' }],
    }], [file]);
    expect(findings[0]).toMatchObject({
      category: 'security', severity: 'high', confidence: 'medium', side: 'new', status: 'draft',
      evidence: [{ path: 'src/a.ts', quote: 'password' }],
    });
  });

  it('parses fenced JSON and removes duplicate findings', () => {
    const raw = `\`\`\`json
{"findings":[
  {"path":"src/a.ts","line":1,"category":"bug","title":"Duplicate","content":"same","existingCode":"x"},
  {"path":"src/a.ts","line":1,"category":"bug","title":"Duplicate","content":"same again","existingCode":"x"}
]}
\`\`\``;
    expect(parseModelFindings(raw, [file])).toHaveLength(1);
    expect(() => parseModelFindings('not json', [file])).toThrow(/有效 JSON/);
  });
});
