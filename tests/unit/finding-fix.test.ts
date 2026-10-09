import { describe, expect, it } from 'vitest';
import {
  applyUnifiedPatch, buildFixPayload, buildUnifiedDiff, createFixPlan, describeFixFailure,
  fixCommitDescription, fixCommitMessage, fixSystemPrompt, isFixCandidate, MAX_FIX_FILE_CHARACTERS,
  parseFixResponse, parseUnifiedPatch, validateFixedContent,
} from '../../src/core/finding-fix';
import { GitLabApiError } from '../../src/core/gitlab-adapter';
import type { Finding } from '../../src/core/types';

const finding = (input: Partial<Finding> = {}): Finding => ({
  id: 'ra-f1', fingerprint: 'ra-f1', path: 'src/payment.ts', line: 2, endLine: 2, side: 'new',
  category: 'security', severity: 'high', confidence: 'high',
  title: '硬编码 API Key 应移至安全配置',
  content: '新增赋值把密钥写进了源文件。',
  evidence: [{ path: 'src/payment.ts', lines: 'L2', quote: 'const apiKey = "sk-live-123";' }],
  existingCode: 'const apiKey = "sk-live-123";',
  suggestionCode: 'const apiKey = readSecret("payment-key");',
  comment: '发现硬编码 API Key。',
  source: 'rule', status: 'draft',
  ruleId: 'builtin-hardcoded-secret', rulePackName: '内置规则',
  ...input,
});

const source = [
  'export function pay(amount: number) {',
  '  const apiKey = "sk-live-123";',
  '  return charge(apiKey, amount);',
  '}',
  '',
].join('\n');

describe('fix candidates', () => {
  it('accepts a rule hit that points at a concrete line', () => {
    expect(isFixCandidate(finding())).toBe(true);
  });

  it('accepts a model finding with a suggested replacement or evidence', () => {
    expect(isFixCandidate(finding({ source: 'model', ruleId: undefined, suggestionCode: '' }))).toBe(true);
    expect(isFixCandidate(finding({
      source: 'model', ruleId: undefined, suggestionCode: '', evidence: [],
    }))).toBe(false);
  });

  it('rejects vague findings without a code anchor', () => {
    expect(isFixCandidate(finding({ source: 'model', existingCode: '   ' }))).toBe(false);
    expect(isFixCandidate(finding({ line: 0, endLine: 0 }))).toBe(false);
    expect(isFixCandidate(finding({ path: '' }))).toBe(false);
  });

  it('rejects speculative and architecture-level findings', () => {
    expect(isFixCandidate(finding({ source: 'model', confidence: 'low' }))).toBe(false);
    expect(isFixCandidate(finding({ fileLevel: true, title: '本次变更缺少回归测试' }))).toBe(false);
    expect(isFixCandidate(finding({ deletedFile: true }))).toBe(false);
  });
});

describe('commit message reuse', () => {
  it('uses the finding title verbatim as the commit message', () => {
    expect(fixCommitMessage(finding())).toBe('硬编码 API Key 应移至安全配置');
  });

  it('builds the description out of the finding body, evidence and suggestion', () => {
    const description = fixCommitDescription(finding());
    expect(description).toContain('新增赋值把密钥写进了源文件。');
    expect(description).toContain('src/payment.ts L2');
    expect(description).toContain('const apiKey = "sk-live-123";');
    expect(description).toContain('const apiKey = readSecret("payment-key");');
    expect(description).toContain('src/payment.ts:2');
    expect(description).toContain('规则 `builtin-hardcoded-secret` · 内置规则');
  });

  it('says the finding came from the model when there is no rule id', () => {
    expect(fixCommitDescription(finding({ source: 'model', ruleId: undefined }))).toContain('来源：AI 评审');
  });
});

describe('fix prompt', () => {
  it('asks for strict JSON in both languages', () => {
    expect(fixSystemPrompt('zh-CN')).toContain('{"patch"');
    expect(fixSystemPrompt('en-US')).toContain('{"patch"');
  });

  it('hands the model the finding and the numbered current file content', () => {
    const payload = buildFixPayload(finding(), source);
    expect(payload).toContain('硬编码 API Key 应移至安全配置');
    expect(payload).toContain('src/payment.ts:2');
    expect(payload).toContain('2:   const apiKey = "sk-live-123";');
    expect(payload).toContain('const apiKey = readSecret("payment-key");');
  });

  it('refuses to send an oversized file instead of truncating it', () => {
    expect(() => buildFixPayload(finding(), 'x'.repeat(MAX_FIX_FILE_CHARACTERS + 1)))
      .toThrow(/超过自动修复上限/);
  });
});

describe('unified patch', () => {
  const patch = [
    '@@ -1,4 +1,4 @@',
    ' export function pay(amount: number) {',
    '-  const apiKey = "sk-live-123";',
    '+  const apiKey = readSecret("payment-key");',
    '   return charge(apiKey, amount);',
    ' }',
  ].join('\n');

  it('applies a hunk against the current content', () => {
    expect(applyUnifiedPatch(source, patch)).toContain('  const apiKey = readSecret("payment-key");');
    expect(applyUnifiedPatch(source, patch)).not.toContain('sk-live-123');
  });

  it('keeps a trailing newline and applies several hunks in order', () => {
    const twoHunks = [
      '@@ -1,2 +1,2 @@',
      '-export function pay(amount: number) {',
      '+export function pay(amount: number): Promise<string> {',
      '   const apiKey = "sk-live-123";',
      '@@ -3,2 +3,2 @@',
      '-  return charge(apiKey, amount);',
      '+  return charge(apiKey, amount, { idempotencyKey: apiKey });',
      ' }',
    ].join('\n');
    const fixed = applyUnifiedPatch(source, twoHunks);
    expect(fixed.endsWith('}\n')).toBe(true);
    expect(fixed).toContain('Promise<string>');
    expect(fixed).toContain('idempotencyKey');
  });

  it('tolerates a wrong line number when the context matches exactly once', () => {
    const offset = patch.replace('@@ -1,4 +1,4 @@', '@@ -40,4 +40,4 @@');
    expect(applyUnifiedPatch(source, offset)).toContain('readSecret');
  });

  it('inserts lines for a zero-length hunk', () => {
    const insert = '@@ -1,0 +2,1 @@\n+  // reviewed\n';
    expect(applyUnifiedPatch(source, insert).split('\n')[1]).toBe('  // reviewed');
  });

  it('ignores diff headers, prose after the patch and no-newline markers', () => {
    const noisy = [
      'diff --git a/src/payment.ts b/src/payment.ts',
      '--- a/src/payment.ts',
      '+++ b/src/payment.ts',
      patch,
      '\\ No newline at end of file',
      '以上就是我的修复建议。',
    ].join('\n');
    expect(applyUnifiedPatch(source, noisy)).toContain('readSecret');
  });

  it('reads a removed line whose content itself starts with dashes', () => {
    const before = 'run(\n--verbose\n)\n';
    const dashed = '@@ -1,3 +1,3 @@\n run(\n---verbose\n+--quiet\n )\n';
    expect(applyUnifiedPatch(before, dashed)).toBe('run(\n--quiet\n)\n');
  });

  it('fails loudly when the context is not in the file', () => {
    const stale = patch.replace('  return charge(apiKey, amount);', '  return charge(apiKey);');
    expect(() => applyUnifiedPatch(source, stale)).toThrow(/hunk 无法应用/);
  });

  it('fails instead of guessing when the context matches twice', () => {
    const duplicated = 'let a = 1;\nlet b = 2;\nlet a = 1;\n';
    // 声明的行号对不上，全文又匹配到两处：不猜，直接失败
    expect(() => applyUnifiedPatch(duplicated, '@@ -9,1 +9,1 @@\n-let a = 1;\n+let a = 2;\n'))
      .toThrow(/匹配到多处/);
    // 声明行号能对上时按行号走，不当成歧义
    expect(applyUnifiedPatch(duplicated, '@@ -1,1 +1,1 @@\n-let a = 1;\n+let a = 2;\n').split('\n')[0])
      .toBe('let a = 2;');
  });

  it('rejects a response without any hunk header', () => {
    expect(() => parseUnifiedPatch('这里应该改成 readSecret()')).toThrow(/缺少 @@ hunk 头/);
  });
});

describe('fix response parsing', () => {
  it('accepts a patch answer', () => {
    const result = parseFixResponse(
      JSON.stringify({ patch: '@@ -2,1 +2,1 @@\n-  const apiKey = "sk-live-123";\n+  const apiKey = readSecret("payment-key");\n' }),
      source,
    );
    expect(result.mode).toBe('patch');
    expect(result.content).toContain('readSecret');
  });

  it('accepts a full-file answer, fenced json and fenced content included', () => {
    const fixed = source.replace('sk-live-123', 'readSecret("payment-key")');
    const plain = parseFixResponse(JSON.stringify({ content: fixed }), source);
    expect(plain.mode).toBe('content');
    expect(plain.content).toBe(fixed);

    const fenced = parseFixResponse('```json\n{"content":"```ts\\nA\\n```"}\n```', 'B\n');
    expect(fenced.content).toBe('A');
  });

  it('reports why an unusable answer was dropped', () => {
    expect(() => parseFixResponse('我觉得应该改成 readSecret()', source)).toThrow(/没有返回可解析的 JSON/);
    expect(() => parseFixResponse('{"fix":"readSecret()"}', source)).toThrow(/既没有 patch 也没有 content/);
    expect(() => parseFixResponse(JSON.stringify({ content: '   \n' }), source)).toThrow(/修复内容为空/);
    expect(() => parseFixResponse(JSON.stringify({ content: source }), source)).toThrow(/没有做出修改/);
    expect(() => parseFixResponse(JSON.stringify({ patch: '@@ -9,1 +9,1 @@\n-nope\n+yep\n' }), source))
      .toThrow(/hunk 无法应用/);
  });

  it('drops a result that looks truncated or bloated', () => {
    const before = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`).join('\n');
    const truncated = 'const value0 = 0;\n';
    expect(() => validateFixedContent(before, truncated)).toThrow(/疑似输出被截断/);
    expect(() => validateFixedContent('a\n', `${'a\n'.repeat(100)}${'x'.repeat(8192)}`)).toThrow(/体积异常/);
  });
});

describe('diff preview', () => {
  it('renders the changed lines with their real numbers', () => {
    const diff = buildUnifiedDiff('src/payment.ts', source, source.replace('"sk-live-123"', 'readSecret("k")'));
    expect(diff.split('\n')[0]).toBe('--- a/src/payment.ts');
    expect(diff.split('\n')[1]).toBe('+++ b/src/payment.ts');
    expect(diff).toContain('@@ -1,4 +1,4 @@');
    expect(diff).toContain('-  const apiKey = "sk-live-123";');
    expect(diff).toContain('+  const apiKey = readSecret("k");');
  });

  it('returns nothing when the content did not change and shows a new file as all added', () => {
    expect(buildUnifiedDiff('a.ts', source, source)).toBe('');
    expect(buildUnifiedDiff('a.ts', '', 'x\ny\n')).toBe('--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,2 @@\n+x\n+y');
  });
});

describe('fix plan', () => {
  it('commits to the MR source branch and reuses the finding as commit message', () => {
    const fixed = source.replace('"sk-live-123"', 'readSecret("k")');
    const plan = createFixPlan({ finding: finding(), branch: 'feature/payment', before: source, content: fixed });
    expect(plan.findingId).toBe('ra-f1');
    expect(plan.branch).toBe('feature/payment');
    expect(plan.message).toBe('硬编码 API Key 应移至安全配置');
    expect(plan.description).toContain('新增赋值把密钥写进了源文件。');
    expect(plan.changes).toEqual([{
      path: 'src/payment.ts', action: 'update', before: source, content: fixed,
    }]);
    expect(plan.patch).toContain('readSecret("k")');
  });
});

describe('commit failure wording', () => {
  it('translates the GitLab status into a reason the user can act on', () => {
    expect(describeFixFailure(new GitLabApiError(403, 'GitLab API 403：forbidden', 'forbidden')))
      .toContain('没有向该分支推送的权限');
    expect(describeFixFailure(new GitLabApiError(409, 'GitLab API 409：conflict', 'conflict')))
      .toContain('分支状态冲突');
    expect(describeFixFailure(new GitLabApiError(400, 'GitLab API 400：bad request')))
      .toContain('GitLab 拒绝了这次提交');
    expect(describeFixFailure(new GitLabApiError(500, 'GitLab API 500：boom'))).toBe('GitLab API 500：boom');
    expect(describeFixFailure(new Error('补丁第 1 个 hunk 无法应用'))).toBe('补丁第 1 个 hunk 无法应用');
  });
});
