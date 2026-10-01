import { describe, expect, it } from 'vitest';
import { buildDelegationContext } from '../../src/core/delegation';
import { normalizeFileDiff } from '../../src/core/diff';
import { BUILT_IN_PACK } from '../../src/core/rule-packs';

describe('buildDelegationContext', () => {
  it('bundles file selection, resolved rules, diff and output schema', () => {
    const files = [normalizeFileDiff({
      old_path: 'src/a.ts', new_path: 'src/a.ts',
      diff: '@@ -1 +1,2 @@\n-old\n+const apiKey = "sk-live-1";\n+use(apiKey);',
    })];
    const text = buildDelegationContext({
      files, packs: [BUILT_IN_PACK], background: '支付重试需求',
      meta: { project: 'g/p', mergeRequestIid: 7, headSha: 'abc123' },
    });
    expect(text).toContain('src/a.ts（+2 -1）');
    expect(text).toContain('builtin-hardcoded-secret');
    expect(text).toContain('const apiKey = "sk-live-1";');
    expect(text).toContain('支付重试需求');
    expect(text).toContain('!7');
    expect(text).toContain('只输出 JSON 数组');
  });
});
