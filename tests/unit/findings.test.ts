import { describe, expect, it } from 'vitest';
import { normalizeFileDiff } from '../../src/core/diff';
import {
  buildSummaryComment,
  extractPartialFindings,
  fingerprintFinding,
  normalizeFindings,
  parseModelFindings,
  serializeFindingsExport,
} from '../../src/core/findings';

const file = normalizeFileDiff({
  old_path: 'src/a.ts',
  new_path: 'src/a.ts',
  diff: '@@ -1 +1 @@\n-old\n+const password = "secret";',
});

describe('finding pipeline', () => {
  it('creates stable fingerprints independent of whitespace and case', () => {
    const first = fingerprintFinding({ path: 'a.ts', existingCode: 'foo(  )', category: 'bug', title: 'Broken Flow', line: 4 });
    const second = fingerprintFinding({ path: 'a.ts', existingCode: 'foo()', category: 'bug', title: 'broken flow', line: 4 });
    expect(first).toBe(second);
    expect(first).not.toBe(fingerprintFinding({ path: 'a.ts', existingCode: 'foo()', category: 'bug', title: 'broken flow', line: 5 }));
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

describe('buildSummaryComment', () => {
  function finding(over: Partial<Finding>): Finding {
    return {
      id: 'f1', fingerprint: 'fp', path: 'src/a.ts', line: 3, endLine: 3, side: 'new',
      category: 'security', severity: 'high', confidence: 'high', title: '硬编码密钥',
      content: 'c', evidence: [], existingCode: '', suggestionCode: '', comment: 'cm',
      source: 'rule', status: 'draft', ...over,
    };
  }

  it('summarizes counts and lists findings', () => {
    const text = buildSummaryComment([
      finding({}),
      finding({ id: 'f2', severity: 'low', source: 'model', path: 'src/b.ts', line: 9, title: '调试日志' }),
    ]);
    expect(text).toContain('共 2 个问题');
    expect(text).toContain('严重 0 · 高 1 · 中 0 · 低 1');
    expect(text).toContain('[高][规则] 硬编码密钥 — `src/a.ts:3`');
    expect(text).toContain('[低][AI] 调试日志 — `src/b.ts:9`');
  });

  it('marks corroborated findings as 规则+AI', () => {
    const text = buildSummaryComment([finding({ corroborated: 'model' })]);
    expect(text).toContain('[高][规则+AI]');
  });
});

describe('extractPartialFindings', () => {
  const obj1 = '{"path":"a.ts","line":1,"title":"one"}';
  const obj2 = '{"path":"b.ts","line":2,"title":"two {braced} string"}';

  it('returns only fully closed objects while streaming', () => {
    expect(extractPartialFindings('{"findings":[')).toEqual([]);
    expect(extractPartialFindings(`{"findings":[${obj1},`)).toEqual([obj1]);
    expect(extractPartialFindings(`{"findings":[${obj1},${obj2}]}`)).toEqual([obj1, obj2]);
  });

  it('ignores braces inside strings', () => {
    const partial = `{"findings":[${obj2},` ;
    expect(extractPartialFindings(partial)).toEqual([obj2]);
  });

  it('returns empty for non-JSON prose', () => {
    expect(extractPartialFindings('让我想想…')).toEqual([]);
  });
});

describe('serializeFindingsExport', () => {
  it('emits counts, sources and anchor/evidence payloads', () => {
    const finding: Finding = {
      id: 'f1', fingerprint: 'fp', path: 'src/a.ts', line: 2, endLine: 2, side: 'new',
      category: 'security', severity: 'critical', confidence: 'high', title: 'secret',
      content: 'c', evidence: [{ path: 'src/a.ts', lines: 'L2', quote: 'sk-' }], existingCode: 'sk-',
      suggestionCode: '', comment: 'cm', source: 'rule', status: 'draft', ruleId: 'builtin-hardcoded-secret',
    };
    const parsed = JSON.parse(serializeFindingsExport([finding], { project: 'g/p', mergeRequestIid: 3, headSha: 'h' }));
    expect(parsed.version).toBe(1);
    expect(parsed.mr).toEqual({ project: 'g/p', mergeRequestIid: 3, headSha: 'h' });
    expect(parsed.counts).toMatchObject({ total: 1, bySeverity: { critical: 1 }, bySource: { rule: 1 } });
    expect(parsed.findings[0]).toMatchObject({ id: 'f1', ruleId: 'builtin-hardcoded-secret', line: 2 });
    expect(parsed.findings[0].evidence[0].quote).toBe('sk-');
  });
});
