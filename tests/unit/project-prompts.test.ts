import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROJECT_PROMPT_HISTORY_LIMIT, commitProjectPrompt, countProjectPromptEntries, migrateProjectPrompts,
  normalizeProjectPromptHistory, projectPromptHistoryOf, pushProjectPromptHistory, removeProjectPrompt,
  removeProjectPromptEntry, removeProjectPromptHistory, setProjectPrompt,
} from '../../src/core/project-prompts';
import { defaultSettings, loadSettings, saveSettings } from '../../src/core/settings';
import type { RuntimeSettings } from '../../src/core/types';

const settings = (patch: Partial<RuntimeSettings> = {}): RuntimeSettings => ({ ...defaultSettings, ...patch });
const KEY = 'acme/app';

describe('project prompt history 归一化', () => {
  it('每项目上限 10 条，最新在前', () => {
    expect(PROJECT_PROMPT_HISTORY_LIMIT).toBe(10);
    let entries: string[] = [];
    for (let index = 0; index < 15; index += 1) entries = pushProjectPromptHistory(entries, `第 ${index} 版`);
    expect(entries).toHaveLength(PROJECT_PROMPT_HISTORY_LIMIT);
    expect(entries[0]).toBe('第 14 版');
    expect(entries.at(-1)).toBe('第 5 版');
  });

  it('同样内容只留最近一条，重复保存把它提到最前', () => {
    const entries = pushProjectPromptHistory(['A', 'B', 'C'], 'C');
    expect(entries).toEqual(['C', 'A', 'B']);
  });

  it('去重按 trim 后的内容比较', () => {
    expect(pushProjectPromptHistory(['金额计算必须用 decimal'], '  金额计算必须用 decimal\n')).toEqual(['金额计算必须用 decimal']);
  });

  it('空白内容不入历史，也不会把已有历史清掉', () => {
    expect(pushProjectPromptHistory(['A'], '   ')).toEqual(['A']);
    expect(pushProjectPromptHistory(['A'], '')).toEqual(['A']);
  });

  it('脏数据（非数组 / 非字符串 / 空串）一律丢掉', () => {
    expect(normalizeProjectPromptHistory(undefined)).toEqual([]);
    expect(normalizeProjectPromptHistory('不是数组')).toEqual([]);
    expect(normalizeProjectPromptHistory(['保留', 42, null, '  ', '保留'])).toEqual(['保留']);
  });

  it('removeProjectPromptHistory 只删指定那一条', () => {
    expect(removeProjectPromptHistory(['A', 'B', 'C'], 'B')).toEqual(['A', 'C']);
  });
});

describe('旧单值 prompts 迁移成历史列表', () => {
  it('已存的单值变成该项目唯一一条历史，一条都不丢', () => {
    const state = migrateProjectPrompts({ [KEY]: '金额计算必须用 decimal' }, undefined);
    expect(state.prompts).toEqual({ [KEY]: '金额计算必须用 decimal' });
    expect(state.history).toEqual({ [KEY]: ['金额计算必须用 decimal'] });
  });

  it('多个项目的旧单值各自迁移', () => {
    const state = migrateProjectPrompts({ 'acme/a': 'A 的要求', 'acme/b': 'B 的要求' }, undefined);
    expect(state.history).toEqual({ 'acme/a': ['A 的要求'], 'acme/b': ['B 的要求'] });
  });

  it('已有历史时保留历史，不拿当前值覆盖', () => {
    const state = migrateProjectPrompts({ [KEY]: '第三版' }, { [KEY]: ['第三版', '第二版', '第一版'] });
    expect(state.history).toEqual({ [KEY]: ['第三版', '第二版', '第一版'] });
  });

  it('当前值还没进历史（打完字没失焦就关掉）时保留历史原样', () => {
    const state = migrateProjectPrompts({ [KEY]: '没保存过的草稿' }, { [KEY]: ['第一版'] });
    expect(state.prompts).toEqual({ [KEY]: '没保存过的草稿' });
    expect(state.history).toEqual({ [KEY]: ['第一版'] });
  });

  it('清空的键（空串 / 纯空白）既不留当前值也不造历史', () => {
    const state = migrateProjectPrompts({ 'acme/a': '', 'acme/b': '   ', 'acme/c': '留下' }, { 'acme/a': ['旧历史'] });
    expect(state.prompts).toEqual({ 'acme/c': '留下' });
    expect(state.history).toEqual({ 'acme/a': ['旧历史'], 'acme/c': ['留下'] });
  });

  it('历史里超出上限的旧数据在迁移时被裁掉', () => {
    const state = migrateProjectPrompts({}, { [KEY]: Array.from({ length: 14 }, (_, i) => `第 ${i} 版`) });
    expect(state.history[KEY]).toHaveLength(PROJECT_PROMPT_HISTORY_LIMIT);
    expect(state.history[KEY][0]).toBe('第 0 版');
  });

  it('非字符串的脏 prompts 直接忽略', () => {
    expect(migrateProjectPrompts({ [KEY]: 42, 'x/y': null }, undefined)).toEqual({ prompts: {}, history: {} });
    expect(migrateProjectPrompts(undefined, undefined)).toEqual({ prompts: {}, history: {} });
  });

  it('loadSettings 把磁盘上的旧单值升级成历史', async () => {
    localStorage.clear();
    localStorage.setItem('review-agent-settings-v1', JSON.stringify({
      projectPrompts: { [KEY]: '金额计算必须用 decimal' },
    }));
    const loaded = await loadSettings();
    expect(loaded.projectPrompts).toEqual({ [KEY]: '金额计算必须用 decimal' });
    expect(loaded.projectPromptHistory).toEqual({ [KEY]: ['金额计算必须用 decimal'] });
  });

  it('saveSettings/loadSettings 往返后历史与当前值都还在', async () => {
    localStorage.clear();
    const next = commitProjectPrompt(commitProjectPrompt(settings(), KEY, '第一版'), KEY, '第二版');
    await saveSettings(next);
    const loaded = await loadSettings();
    expect(loaded.projectPrompts[KEY]).toBe('第二版');
    expect(loaded.projectPromptHistory[KEY]).toEqual(['第二版', '第一版']);
  });

  it('没有任何旧数据时两个字段都是空对象', async () => {
    localStorage.clear();
    const loaded = await loadSettings();
    expect(loaded.projectPrompts).toEqual({});
    expect(loaded.projectPromptHistory).toEqual({});
  });
});

describe('settings 层的当前值与保存点', () => {
  beforeEach(() => localStorage.clear());

  it('打字只改当前值，不产生历史', () => {
    const next = setProjectPrompt(settings(), KEY, '写到一半');
    expect(next.projectPrompts[KEY]).toBe('写到一半');
    expect(next.projectPromptHistory).toEqual({});
  });

  it('失焦保存：当前值落盘并追加到历史最前，老版本自动保留', () => {
    let next = commitProjectPrompt(settings(), KEY, '第一版');
    next = commitProjectPrompt(next, KEY, '第二版');
    expect(next.projectPrompts[KEY]).toBe('第二版');
    expect(next.projectPromptHistory[KEY]).toEqual(['第二版', '第一版']);
  });

  it('清空后保存：当前值消失，历史保留以便 ↑ 捞回来', () => {
    const saved = commitProjectPrompt(settings(), KEY, '第一版');
    const cleared = setProjectPrompt(saved, KEY, '');
    expect(cleared.projectPrompts[KEY]).toBeUndefined();
    expect(cleared.projectPromptHistory[KEY]).toEqual(['第一版']);

    const committed = commitProjectPrompt(cleared, KEY, '');
    expect(committed.projectPrompts[KEY]).toBeUndefined();
    expect(committed.projectPromptHistory[KEY]).toEqual(['第一版']);
  });

  it('覆盖保存同样内容只是把它提到最前，不会翻倍', () => {
    let next = commitProjectPrompt(settings(), KEY, '第一版');
    next = commitProjectPrompt(next, KEY, '第二版');
    next = commitProjectPrompt(next, KEY, '第一版');
    expect(next.projectPromptHistory[KEY]).toEqual(['第一版', '第二版']);
  });

  it('每个项目的历史互不干扰', () => {
    let next = commitProjectPrompt(settings(), 'acme/a', 'A 的要求');
    next = commitProjectPrompt(next, 'acme/b', 'B 的要求');
    expect(next.projectPromptHistory).toEqual({ 'acme/a': ['A 的要求'], 'acme/b': ['B 的要求'] });
    expect(projectPromptHistoryOf(next, 'acme/a')).toEqual(['A 的要求']);
    expect(projectPromptHistoryOf(next, 'acme/unknown')).toEqual([]);
    expect(projectPromptHistoryOf(next, '')).toEqual([]);
  });

  it('没有 key（页面没有项目上下文）时原样返回', () => {
    const base = settings();
    expect(setProjectPrompt(base, '', '随便写')).toBe(base);
    expect(commitProjectPrompt(base, '', '随便写')).toBe(base);
  });

  it('删整个项目连历史一起清掉', () => {
    const saved = commitProjectPrompt(settings(), KEY, '第一版');
    const removed = removeProjectPrompt(saved, KEY);
    expect(removed.projectPrompts).toEqual({});
    expect(removed.projectPromptHistory).toEqual({});
  });

  it('只删历史里的噪声记录，当前生效值不动', () => {
    let next = commitProjectPrompt(settings(), KEY, '第一版');
    next = commitProjectPrompt(next, KEY, '第二版');
    next = removeProjectPromptEntry(next, KEY, '第一版');
    expect(next.projectPrompts[KEY]).toBe('第二版');
    expect(next.projectPromptHistory[KEY]).toEqual(['第二版']);

    const emptied = removeProjectPromptEntry(next, KEY, '第二版');
    expect(emptied.projectPromptHistory).toEqual({});
    expect(emptied.projectPrompts[KEY]).toBe('第二版');
  });

  it('历史条数统计跨项目累加', () => {
    expect(countProjectPromptEntries({ 'acme/a': ['1', '2'], 'acme/b': ['3'] })).toBe(3);
    expect(countProjectPromptEntries({})).toBe(0);
  });
});
