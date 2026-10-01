import { describe, expect, it } from 'vitest';
import { compactThinking, extractThinkingOutline } from '../../src/core/thinking';

describe('compactThinking', () => {
  it('folds long JSON drafts but keeps short ones', () => {
    const long = `{"findings": [{"path": "a.ts", "line": 1, "title": "${'x'.repeat(150)}"}]}`;
    const out = compactThinking(`先看看结构 ${long} 然后继续推理`);
    expect(out).toContain('〔JSON 草稿');
    expect(out).not.toContain('x'.repeat(150));
    expect(compactThinking('保留 {"a": 1} 短片段')).toContain('{"a": 1}');
  });

  it('folds code fences and collapses blank lines', () => {
    const out = compactThinking('推理一\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n\n\n推理二');
    expect(out).toContain('〔代码块');
    expect(out).not.toContain('\n\n\n');
    expect(out).toContain('推理一');
    expect(out).toContain('推理二');
  });

  it('keeps prose untouched', () => {
    expect(compactThinking('  先检查 cookies.txt 是否包含会话凭据…  ')).toBe('先检查 cookies.txt 是否包含会话凭据…');
  });
});

describe('extractThinkingOutline', () => {
  it('extracts bullets and a prose/json/code timeline', () => {
    const text = [
      '先检查 cookies.txt 是否包含会话凭据，发现 _gitlab_session 明文。',
      '```ts',
      'const a = 1;',
      '```',
      '{"findings": [{' + `"path": "a.ts", "title": "${'x'.repeat(140)}"` + '}]}',
      '建议把凭据移到密钥管理服务。',
    ].join('\n');
    const outline = extractThinkingOutline(text);
    expect(outline.bullets.length).toBeGreaterThanOrEqual(2);
    expect(outline.bullets.some((b) => b.includes('发现'))).toBe(true);
    const kinds = outline.timeline.map((segment) => segment.kind);
    expect(kinds).toContain('code');
    expect(kinds).toContain('json');
    expect(kinds).toContain('prose');
  });

  it('returns empty outline for empty input', () => {
    expect(extractThinkingOutline('')).toEqual({ bullets: [], timeline: [] });
  });
});
