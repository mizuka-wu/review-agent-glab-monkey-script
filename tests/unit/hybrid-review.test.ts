import { describe, expect, it } from 'vitest';
import { corroborateFindings } from '../../src/core/finding-hardening';
import { BUILT_IN_PACK, detectLanguage, isCommentLine, runRulePackReview } from '../../src/core/rule-packs';
import { inspectConfiguration, isModelConfigured } from '../../src/core/settings';
import { defaultSettings } from '../../src/core/settings';
import type { DiffLine, FileDiff, Finding, RuntimeSettings } from '../../src/core/types';

function makeFile(path: string, addedLines: string[]): FileDiff {
  const lines: DiffLine[] = addedLines.map((text, index) => ({
    hunkId: 'h1', newLine: index + 1, kind: 'added' as const, text,
  }));
  return {
    oldPath: path, newPath: path,
    diff: addedLines.map((line) => `+${line}`).join('\n'),
    newFile: false, deletedFile: false, renamedFile: false, lines,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1', fingerprint: 'fp1', path: 'src/a.ts', line: 2, endLine: 2, side: 'new',
    category: 'security', severity: 'high', confidence: 'medium',
    title: '代码中疑似硬编码敏感信息', content: '模型给出的说明。',
    evidence: [{ path: 'src/a.ts', lines: 'L2', quote: 'const apiKey = "x";' }],
    existingCode: 'const apiKey = "x";', suggestionCode: '', comment: 'comment',
    source: 'model', status: 'draft', ...overrides,
  };
}

describe('corroborateFindings', () => {
  it('merges rule and model hits on the same line and category', () => {
    const rule = makeFinding({ source: 'rule', fingerprint: 'fp-rule', ruleId: 'builtin-hardcoded-secret', confidence: 'high' });
    const model = makeFinding({ fingerprint: 'fp-model' });
    const merged = corroborateFindings([rule], [model]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      source: 'model', corroborated: 'rule', ruleId: 'builtin-hardcoded-secret', confidence: 'high',
    });
    expect(merged[0].content).toContain('builtin-hardcoded-secret');
  });

  it('keeps the higher severity of the two sources', () => {
    const rule = makeFinding({ source: 'rule', fingerprint: 'fp-rule', severity: 'critical' });
    const model = makeFinding({ fingerprint: 'fp-model', severity: 'medium' });
    expect(corroborateFindings([rule], [model])[0].severity).toBe('critical');
  });

  it('does not merge different categories on the same line', () => {
    const rule = makeFinding({ source: 'rule', fingerprint: 'fp-rule', category: 'maintainability', title: '新增调试日志可能泄漏运行时信息' });
    const model = makeFinding({ fingerprint: 'fp-model' });
    const result = corroborateFindings([rule], [model]);
    expect(result).toHaveLength(2);
    expect(result.every((finding) => !finding.corroborated)).toBe(true);
  });

  it('does not merge hits on different files or lines', () => {
    const rule = makeFinding({ source: 'rule', fingerprint: 'fp-rule', path: 'src/b.ts' });
    const far = makeFinding({ source: 'rule', fingerprint: 'fp-far', path: 'src/a.ts', line: 40, endLine: 40 });
    const model = makeFinding({ fingerprint: 'fp-model' });
    expect(corroborateFindings([rule, far], [model])).toHaveLength(3);
  });
});

describe('rule language scoping', () => {
  it('detects languages from file names', () => {
    expect(detectLanguage('src/app.tsx')).toBe('ts');
    expect(detectLanguage('internal/x.go')).toBe('go');
    expect(detectLanguage('Dockerfile')).toBe('shell');
    expect(detectLanguage('README.md')).toBe('markdown');
  });

  it('only fires language scoped rules on matching files', () => {
    const ts = makeFile('src/app.ts', ['console.log("x")']);
    const py = makeFile('src/app.py', ['console.log("x")']);
    const fromTs = runRulePackReview([ts], [BUILT_IN_PACK]);
    const fromPy = runRulePackReview([py], [BUILT_IN_PACK]);
    expect(fromTs.some((f) => f.ruleId === 'builtin-console-log')).toBe(true);
    expect(fromPy.some((f) => f.ruleId === 'builtin-console-log')).toBe(false);
  });

  it('skips commented out code but keeps TODO markers', () => {
    expect(isCommentLine('  // console.log(1)', 'ts')).toBe(true);
    expect(isCommentLine('# print(1)', 'python')).toBe(true);
    expect(isCommentLine('console.log(1)', 'ts')).toBe(false);

    const file = makeFile('src/app.ts', ['// console.log("x")', '// TODO: handle retry']);
    const findings = runRulePackReview([file], [BUILT_IN_PACK]);
    expect(findings.some((f) => f.ruleId === 'builtin-console-log')).toBe(false);
    expect(findings.some((f) => f.ruleId === 'builtin-todo-marker')).toBe(true);
  });

  it('reports occurrences when a rule hits many lines', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `console.log(${index});`);
    const findings = runRulePackReview([makeFile('src/app.ts', lines)], [BUILT_IN_PACK])
      .filter((f) => f.ruleId === 'builtin-console-log');
    expect(findings).toHaveLength(8);
    expect(findings[0].occurrences).toBe(12);
  });

  it('flags language specific correctness rules', () => {
    const java = makeFile('src/Pay.java', ['private static SimpleDateFormat FORMAT = new SimpleDateFormat("yyyy");', 'if (status.equals("ACTIVE")) {']);
    const kotlin = makeFile('src/Pay.kt', ['val user = repo.find(id)!!']);
    const javaFindings = runRulePackReview([java], [BUILT_IN_PACK]);
    const kotlinFindings = runRulePackReview([kotlin], [BUILT_IN_PACK]);
    expect(javaFindings.some((f) => f.ruleId === 'builtin-thread-unsafe-shared-state')).toBe(true);
    expect(javaFindings.some((f) => f.ruleId === 'builtin-java-equals-on-variable')).toBe(true);
    expect(kotlinFindings.some((f) => f.ruleId === 'builtin-kotlin-notnull-assertion')).toBe(true);
  });

  it('flags sql injection, xss and disabled tls verification', () => {
    const file = makeFile('src/repo.ts', [
      'const sql = `SELECT * FROM users WHERE id = ${id}`;',
      'node.innerHTML = userComment;',
      'const agent = new https.Agent({ rejectUnauthorized: false });',
    ]);
    const ids = runRulePackReview([file], [BUILT_IN_PACK]).map((f) => f.ruleId);
    expect(ids).toEqual(expect.arrayContaining(['builtin-sql-injection', 'builtin-xss-sink', 'builtin-tls-verify-disabled']));
  });
});

describe('configuration readiness', () => {
  const base: RuntimeSettings = { ...defaultSettings };

  it('requires an API key for the official OpenAI endpoint', () => {
    const settings = { ...base, modelBaseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' };
    expect(isModelConfigured(settings)).toBe(false);
    expect(inspectConfiguration(settings).issues.map((issue) => issue.field)).toContain('apiKey');
  });

  it('allows keyless enterprise gateways', () => {
    const settings = { ...base, modelBaseUrl: 'https://llm.internal.example/v1', model: 'qwen-max', apiKey: '' };
    expect(isModelConfigured(settings)).toBe(true);
    expect(inspectConfiguration(settings).modelReady).toBe(true);
  });

  it('reports every missing field', () => {
    const settings = { ...base, modelBaseUrl: '', model: '', apiKey: '' };
    expect(inspectConfiguration(settings).issues).toHaveLength(2);
  });
});
