import { describe, expect, it } from 'vitest';
import { parseReflectionVerdicts, reflectFindings } from '../../src/core/reflection';
import type { Finding } from '../../src/core/types';

function finding(id: string): Finding {
  return {
    id, fingerprint: id, path: 'src/a.ts', line: 1, endLine: 1, side: 'new',
    category: 'bug', severity: 'high', confidence: 'high', title: 't', content: 'c',
    evidence: [{ path: 'src/a.ts', lines: 'L1', quote: 'q' }], existingCode: '', suggestionCode: '',
    comment: 'cm', source: 'model', status: 'draft',
  };
}

describe('parseReflectionVerdicts', () => {
  it('parses plain and prose-wrapped JSON', () => {
    expect(parseReflectionVerdicts('[{"id":"a","keep":false,"reason":"风格"}]'))
      .toEqual([{ id: 'a', keep: false, reason: '风格' }]);
    expect(parseReflectionVerdicts('思考…\n[{"id":"a","keep":true,"reason":"ok"}]\n结束'))
      .toEqual([{ id: 'a', keep: true, reason: 'ok' }]);
  });

  it('returns empty for invalid payloads', () => {
    expect(parseReflectionVerdicts('not json')).toEqual([]);
    expect(parseReflectionVerdicts('[{"id":"a"}]')).toEqual([]);
  });
});

describe('reflectFindings', () => {
  it('drops unknown ids and keeps known verdicts', async () => {
    const runtime = { reflect: async () => '[{"id":"a","keep":false,"reason":"重复"},{"id":"zz","keep":false,"reason":"x"}]' };
    const verdicts = await reflectFindings(runtime, [finding('a')], 'zh-CN');
    expect(verdicts).toEqual([{ id: 'a', keep: false, reason: '重复' }]);
  });
});
