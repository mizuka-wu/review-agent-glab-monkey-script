import { describe, expect, it } from 'vitest';
import { reviewSystemPrompt } from '../../src/core/openai-runtime';

describe('reviewSystemPrompt', () => {
  it('keeps the system prompt stable (project prompt travels in the user message)', () => {
    expect(reviewSystemPrompt('zh-CN', '优先精确率。')).not.toContain('项目补充要求');
    expect(reviewSystemPrompt('en-US', 'prefer precision')).toContain('Write findings in English');
  });
});
