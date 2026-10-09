import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROMPT_HISTORY_KEY, PROMPT_HISTORY_LIMIT, caretAllowsHistory, idleBrowse, loadPromptHistory,
  pushPromptHistory, removePromptHistory, savePromptHistory, stepPromptHistory,
} from '../../src/core/prompt-history';

describe('prompt history storage', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty and round-trips through localStorage', () => {
    expect(loadPromptHistory()).toEqual([]);
    savePromptHistory(['第一条', '第二条']);
    expect(JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) ?? '[]')).toEqual(['第一条', '第二条']);
    expect(loadPromptHistory()).toEqual(['第一条', '第二条']);
  });

  it('keeps its own key, separate from the chat session store', () => {
    expect(PROMPT_HISTORY_KEY).toBe('review-agent-prompt-history-v1');
    expect(PROMPT_HISTORY_KEY).not.toBe('review-agent-chat-v1');
    savePromptHistory(['prompt']);
    expect(localStorage.getItem('review-agent-chat-v1')).toBeNull();
  });

  it('puts the newest prompt first, drops repeats and keeps at most 20', () => {
    let entries: string[] = [];
    entries = pushPromptHistory(entries, '第一次提问');
    entries = pushPromptHistory(entries, '第二次提问');
    expect(entries).toEqual(['第二次提问', '第一次提问']);

    entries = pushPromptHistory(entries, '第一次提问');
    expect(entries).toEqual(['第一次提问', '第二次提问']);

    for (let index = 0; index < 30; index += 1) entries = pushPromptHistory(entries, `问题 ${index}`);
    expect(entries).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(entries[0]).toBe('问题 29');
    expect(entries).not.toContain('第一次提问');
  });

  it('ignores blank prompts and trims surrounding whitespace', () => {
    const entries = pushPromptHistory(['保留'], '   ');
    expect(entries).toEqual(['保留']);
    expect(pushPromptHistory([], "  检查这段变更的并发安全  ")).toEqual(['检查这段变更的并发安全']);
  });

  it('keeps multi-line prompts intact so a recalled prompt resubmits the same thing', () => {
    const prompt = '第一行\n第二行';
    expect(pushPromptHistory([], prompt)).toEqual([prompt]);
  });

  it('removes a single entry', () => {
    expect(removePromptHistory(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('survives garbage in storage', () => {
    localStorage.setItem(PROMPT_HISTORY_KEY, '{不是 JSON');
    expect(loadPromptHistory()).toEqual([]);
    localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify({ nope: true }));
    expect(loadPromptHistory()).toEqual([]);
    localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(['ok', 42, null, '  ', 'ok']));
    expect(loadPromptHistory()).toEqual(['ok']);
  });

  it('caps on save as well as on push', () => {
    savePromptHistory(Array.from({ length: 40 }, (_, index) => `问题 ${index}`));
    expect(loadPromptHistory()).toHaveLength(PROMPT_HISTORY_LIMIT);
  });
});

describe('prompt history browsing', () => {
  const entries = ['最新', '上一条', '最早'];

  it('walks older then back to newer, restoring the untouched draft', () => {
    let browse = idleBrowse;
    const older = stepPromptHistory(entries, browse, 'older', '写到一半的草稿');
    expect(older).toMatchObject({ value: '最新', browse: { index: 0, saved: '写到一半的草稿' } });

    browse = older!.browse;
    const second = stepPromptHistory(entries, browse, 'older', '最新');
    expect(second).toMatchObject({ value: '上一条', browse: { index: 1, saved: '写到一半的草稿' } });

    browse = second!.browse;
    expect(stepPromptHistory(entries, browse, 'older', '上一条')).toMatchObject({ value: '最早', browse: { index: 2 } });

    browse = { index: 2, saved: '写到一半的草稿' };
    expect(stepPromptHistory(entries, browse, 'older', '最早')).toBeUndefined();

    expect(stepPromptHistory(entries, browse, 'newer', '最早')).toMatchObject({ value: '上一条', browse: { index: 1 } });
    browse = { index: 1, saved: '写到一半的草稿' };
    expect(stepPromptHistory(entries, browse, 'newer', '上一条')).toMatchObject({ value: '最新', browse: { index: 0 } });
    browse = { index: 0, saved: '写到一半的草稿' };
    expect(stepPromptHistory(entries, browse, 'newer', '最新')).toEqual({ browse: idleBrowse, value: '写到一半的草稿' });
  });

  it('does not hijack the arrow keys when there is no history', () => {
    expect(stepPromptHistory([], idleBrowse, 'older', '草稿')).toBeUndefined();
    expect(stepPromptHistory(entries, idleBrowse, 'newer', '草稿')).toBeUndefined();
  });

  it('only takes over ↑↓ when the caret is already on the first/last line', () => {
    expect(caretAllowsHistory('单行', { start: 2, end: 2 }, 'older')).toBe(true);
    expect(caretAllowsHistory('第一行\n第二行', { start: 3, end: 3 }, 'older')).toBe(true);
    expect(caretAllowsHistory('第一行\n第二行', { start: 4, end: 4 }, 'older')).toBe(false);
    expect(caretAllowsHistory('第一行\n第二行', { start: 8, end: 8 }, 'newer')).toBe(true);
    expect(caretAllowsHistory('第一行\n第二行', { start: 1, end: 1 }, 'newer')).toBe(false);
    expect(caretAllowsHistory('第一行\n第二行', { start: 0, end: 3 }, 'newer')).toBe(false);
  });
});
