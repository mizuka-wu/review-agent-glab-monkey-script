import { beforeEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_PROMPT_HISTORY_LIMIT, commitProjectPrompt, countHistoryProjects, countProjectPromptEntries,
  migrateProjectPrompts, normalizeProjectPromptHistory, projectPromptHistoryPool, pushProjectPromptHistory,
  removeProjectPrompt, removeProjectPromptEntry, removeProjectPromptHistory,
  removeProjectPromptHistoryByProject, setProjectPrompt,
} from '../../src/core/project-prompts';
import { defaultSettings, loadSettings, saveSettings } from '../../src/core/settings';
import type { ProjectPromptHistoryEntry, RuntimeSettings } from '../../src/core/types';

const settings = (patch: Partial<RuntimeSettings> = {}): RuntimeSettings => ({ ...defaultSettings, ...patch });
const KEY = 'acme/app';
const OTHER = 'acme/other';
const entry = (value: string, projectKey: string): ProjectPromptHistoryEntry => ({ value, projectKey });
const values = (pool: ProjectPromptHistoryEntry[]) => pool.map((item) => item.value);

describe('全局历史池归一化', () => {
  it('全局上限 30 条（所有项目共用），最新在前', () => {
    expect(GLOBAL_PROMPT_HISTORY_LIMIT).toBe(30);
    let pool: ProjectPromptHistoryEntry[] = [];
    for (let index = 0; index < 40; index += 1) pool = pushProjectPromptHistory(pool, `第 ${index} 版`, KEY);
    expect(pool).toHaveLength(GLOBAL_PROMPT_HISTORY_LIMIT);
    expect(values(pool)[0]).toBe('第 39 版');
    expect(values(pool).at(-1)).toBe('第 10 版');
    expect(pool.every((item) => item.projectKey === KEY)).toBe(true);
  });

  it('两个项目交替保存也共用同一条 30 上限的队列', () => {
    let pool: ProjectPromptHistoryEntry[] = [];
    for (let index = 0; index < 20; index += 1) {
      pool = pushProjectPromptHistory(pool, `A 第 ${index} 版`, KEY);
      pool = pushProjectPromptHistory(pool, `B 第 ${index} 版`, OTHER);
    }
    expect(pool).toHaveLength(GLOBAL_PROMPT_HISTORY_LIMIT);
    expect(values(pool)[0]).toBe('B 第 19 版');
    expect(values(pool)[1]).toBe('A 第 19 版');
  });

  it('同样内容只留最近一条，重复保存把它提到最前', () => {
    const pool = pushProjectPromptHistory([entry('A', KEY), entry('B', KEY), entry('C', KEY)], 'C', KEY);
    expect(values(pool)).toEqual(['C', 'A', 'B']);
  });

  it('跨项目重复保存同内容时，来源项目跟着更新成最近那一次', () => {
    const pool = pushProjectPromptHistory([entry('共用要求', KEY), entry('A 独有', KEY)], '共用要求', OTHER);
    expect(pool).toEqual([entry('共用要求', OTHER), entry('A 独有', KEY)]);
  });

  it('去重按 trim 后的内容比较', () => {
    expect(pushProjectPromptHistory([entry('金额计算必须用 decimal', KEY)], '  金额计算必须用 decimal\n', OTHER))
      .toEqual([entry('金额计算必须用 decimal', OTHER)]);
  });

  it('空白内容不入历史，也不会把已有历史清掉', () => {
    expect(pushProjectPromptHistory([entry('A', KEY)], '   ', KEY)).toEqual([entry('A', KEY)]);
    expect(pushProjectPromptHistory([entry('A', KEY)], '', KEY)).toEqual([entry('A', KEY)]);
  });

  it('脏数据（非数组 / 非对象 / 空值）一律丢掉', () => {
    expect(normalizeProjectPromptHistory(undefined)).toEqual([]);
    expect(normalizeProjectPromptHistory('不是数组')).toEqual([]);
    expect(normalizeProjectPromptHistory([entry('保留', KEY), 42, null, { value: '  ' }, entry('保留', OTHER)]))
      .toEqual([entry('保留', KEY)]);
  });

  it('更早落盘的纯字符串数组也能读进来，来源项目留空', () => {
    expect(normalizeProjectPromptHistory(['老要求', '  ', '老要求'])).toEqual([{ value: '老要求', projectKey: '' }]);
  });

  it('removeProjectPromptHistory 只删指定那一条', () => {
    expect(removeProjectPromptHistory([entry('A', KEY), entry('B', OTHER), entry('C', KEY)], 'B'))
      .toEqual([entry('A', KEY), entry('C', KEY)]);
  });

  it('removeProjectPromptHistoryByProject 清掉一个项目的条目、别的项目照旧留着', () => {
    const pool = [entry('A', KEY), entry('B', OTHER), entry('C', KEY)];
    expect(removeProjectPromptHistoryByProject(pool, KEY)).toEqual([entry('B', OTHER)]);
    expect(removeProjectPromptHistoryByProject(pool, 'acme/unknown')).toEqual(pool);
  });
});

describe('三级迁移：单值 → 按项目历史 → 全局池', () => {
  it('一级：已存的单值变成该项目唯一一条历史，一条都不丢', () => {
    const state = migrateProjectPrompts({ [KEY]: '金额计算必须用 decimal' }, undefined);
    expect(state.prompts).toEqual({ [KEY]: '金额计算必须用 decimal' });
    expect(state.history).toEqual([entry('金额计算必须用 decimal', KEY)]);
  });

  it('一级：多个项目的旧单值按 key 顺序合并进同一个池子', () => {
    const state = migrateProjectPrompts({ 'acme/a': 'A 的要求', 'acme/b': 'B 的要求' }, undefined);
    expect(state.history).toEqual([entry('A 的要求', 'acme/a'), entry('B 的要求', 'acme/b')]);
  });

  it('二级：按项目分桶的历史摊平进全局池，各项目内保持原顺序', () => {
    const state = migrateProjectPrompts({}, { 'acme/a': ['a2', 'a1'], 'acme/b': ['b1'] });
    expect(state.history).toEqual([entry('a2', 'acme/a'), entry('a1', 'acme/a'), entry('b1', 'acme/b')]);
  });

  it('二级：跨项目重复内容只留一条，来源是排在前面的那个项目', () => {
    const state = migrateProjectPrompts({}, { 'acme/a': ['共用要求'], 'acme/b': ['共用要求', 'B 独有'] });
    expect(state.history).toEqual([entry('共用要求', 'acme/a'), entry('B 独有', 'acme/b')]);
  });

  it('二级：合并后超过全局上限被裁到 30，保留靠前的', () => {
    const state = migrateProjectPrompts({}, {
      'acme/a': Array.from({ length: 20 }, (_, i) => `a${i}`),
      'acme/b': Array.from({ length: 20 }, (_, i) => `b${i}`),
    });
    expect(state.history).toHaveLength(GLOBAL_PROMPT_HISTORY_LIMIT);
    expect(state.history[0]).toEqual(entry('a0', 'acme/a'));
    expect(state.history[29]).toEqual(entry('b9', 'acme/b'));
  });

  it('二级：已有历史时保留历史，不拿当前值覆盖', () => {
    const state = migrateProjectPrompts({ [KEY]: '第三版' }, { [KEY]: ['第三版', '第二版', '第一版'] });
    expect(state.history).toEqual([entry('第三版', KEY), entry('第二版', KEY), entry('第一版', KEY)]);
  });

  it('当前值还没进历史（打完字没失焦就关掉）时保留历史原样', () => {
    const state = migrateProjectPrompts({ [KEY]: '没保存过的草稿' }, { [KEY]: ['第一版'] });
    expect(state.prompts).toEqual({ [KEY]: '没保存过的草稿' });
    expect(state.history).toEqual([entry('第一版', KEY)]);
  });

  it('清空的键（空串 / 纯空白）既不留当前值也不造历史', () => {
    const state = migrateProjectPrompts({ 'acme/a': '', 'acme/b': '   ', 'acme/c': '留下' }, { 'acme/a': ['旧历史'] });
    expect(state.prompts).toEqual({ 'acme/c': '留下' });
    expect(state.history).toEqual([entry('旧历史', 'acme/a'), entry('留下', 'acme/c')]);
  });

  it('三级：已经是全局池的数据原样归一化，不再二次迁移', () => {
    const state = migrateProjectPrompts({ [KEY]: '第三版' }, [entry('第三版', KEY), entry('第一版', OTHER)]);
    expect(state.history).toEqual([entry('第三版', KEY), entry('第一版', OTHER)]);
  });

  it('三级：全局池里的脏条目和重复内容在迁移时被清掉', () => {
    const state = migrateProjectPrompts({}, [{ value: '  ' }, 42, entry('留下', OTHER), entry('留下', KEY)]);
    expect(state.history).toEqual([entry('留下', OTHER)]);
  });

  it('非字符串的脏 prompts 直接忽略', () => {
    expect(migrateProjectPrompts({ [KEY]: 42, 'x/y': null }, undefined)).toEqual({ prompts: {}, history: [] });
    expect(migrateProjectPrompts(undefined, undefined)).toEqual({ prompts: {}, history: [] });
  });

  it('loadSettings 一级：把磁盘上的旧单值升级成全局池里的一条', async () => {
    localStorage.clear();
    localStorage.setItem('review-agent-settings-v1', JSON.stringify({
      projectPrompts: { [KEY]: '金额计算必须用 decimal' },
    }));
    const loaded = await loadSettings();
    expect(loaded.projectPrompts).toEqual({ [KEY]: '金额计算必须用 decimal' });
    expect(loaded.projectPromptHistory).toEqual([entry('金额计算必须用 decimal', KEY)]);
  });

  it('loadSettings 二级：把磁盘上按项目分桶的历史合并成全局池', async () => {
    localStorage.clear();
    localStorage.setItem('review-agent-settings-v1', JSON.stringify({
      projectPromptHistory: { 'acme/a': ['a1'], 'acme/b': ['b1', 'b2'] },
    }));
    const loaded = await loadSettings();
    expect(loaded.projectPromptHistory).toEqual([entry('a1', 'acme/a'), entry('b1', 'acme/b'), entry('b2', 'acme/b')]);
  });

  it('loadSettings 三级：已经是全局池的磁盘数据原样读进来', async () => {
    localStorage.clear();
    localStorage.setItem('review-agent-settings-v1', JSON.stringify({
      projectPromptHistory: [entry('第一版', OTHER), entry('第二版', KEY)],
    }));
    const loaded = await loadSettings();
    expect(loaded.projectPromptHistory).toEqual([entry('第一版', OTHER), entry('第二版', KEY)]);
  });

  it('saveSettings/loadSettings 往返后历史与当前值都还在', async () => {
    localStorage.clear();
    const next = commitProjectPrompt(commitProjectPrompt(settings(), KEY, '第一版'), KEY, '第二版');
    await saveSettings(next);
    const loaded = await loadSettings();
    expect(loaded.projectPrompts[KEY]).toBe('第二版');
    expect(loaded.projectPromptHistory).toEqual([entry('第二版', KEY), entry('第一版', KEY)]);
  });

  it('没有任何旧数据时当前值是空对象、历史池是空数组', async () => {
    localStorage.clear();
    const loaded = await loadSettings();
    expect(loaded.projectPrompts).toEqual({});
    expect(loaded.projectPromptHistory).toEqual([]);
  });
});

describe('settings 层的当前值与保存点', () => {
  beforeEach(() => localStorage.clear());

  it('打字只改当前值，不产生历史', () => {
    const next = setProjectPrompt(settings(), KEY, '写到一半');
    expect(next.projectPrompts[KEY]).toBe('写到一半');
    expect(next.projectPromptHistory).toEqual([]);
  });

  it('失焦保存：当前值落盘并追加到池子最前，老版本自动保留', () => {
    let next = commitProjectPrompt(settings(), KEY, '第一版');
    next = commitProjectPrompt(next, KEY, '第二版');
    expect(next.projectPrompts[KEY]).toBe('第二版');
    expect(next.projectPromptHistory).toEqual([entry('第二版', KEY), entry('第一版', KEY)]);
  });

  it('清空后保存：当前值消失，历史保留以便捞回来', () => {
    const saved = commitProjectPrompt(settings(), KEY, '第一版');
    const cleared = setProjectPrompt(saved, KEY, '');
    expect(cleared.projectPrompts[KEY]).toBeUndefined();
    expect(cleared.projectPromptHistory).toEqual([entry('第一版', KEY)]);

    const committed = commitProjectPrompt(cleared, KEY, '');
    expect(committed.projectPrompts[KEY]).toBeUndefined();
    expect(committed.projectPromptHistory).toEqual([entry('第一版', KEY)]);
  });

  it('覆盖保存同样内容只是把它提到最前，不会翻倍', () => {
    let next = commitProjectPrompt(settings(), KEY, '第一版');
    next = commitProjectPrompt(next, KEY, '第二版');
    next = commitProjectPrompt(next, KEY, '第一版');
    expect(values(next.projectPromptHistory)).toEqual(['第一版', '第二版']);
  });

  it('不同项目共用一个池子：各自的条目都带来源项目', () => {
    let next = commitProjectPrompt(settings(), 'acme/a', 'A 的要求');
    next = commitProjectPrompt(next, 'acme/b', 'B 的要求');
    expect(next.projectPromptHistory).toEqual([entry('B 的要求', 'acme/b'), entry('A 的要求', 'acme/a')]);
    expect(projectPromptHistoryPool(next)).toEqual(next.projectPromptHistory);
  });

  it('按项目的当前值互不影响：保存 A 不动 B 的 prompts', () => {
    let next = commitProjectPrompt(settings(), 'acme/b', 'B 的要求');
    next = commitProjectPrompt(next, 'acme/a', 'A 的要求');
    next = setProjectPrompt(next, 'acme/a', 'A 写到一半');
    expect(next.projectPrompts).toEqual({ 'acme/a': 'A 写到一半', 'acme/b': 'B 的要求' });
    expect(values(next.projectPromptHistory)).toEqual(['A 的要求', 'B 的要求']);
  });

  it('projectPromptHistoryPool 读到分桶旧数据也返回全局条目（两个输入框共用同一入口）', () => {
    const legacy = settings({ projectPromptHistory: { 'acme/a': ['a1'], 'acme/b': ['b1'] } } as Partial<RuntimeSettings>);
    expect(projectPromptHistoryPool(legacy)).toEqual([entry('a1', 'acme/a'), entry('b1', 'acme/b')]);
    expect(projectPromptHistoryPool(settings())).toEqual([]);
  });

  it('没有 key（页面没有项目上下文）时原样返回', () => {
    const base = settings();
    expect(setProjectPrompt(base, '', '随便写')).toBe(base);
    expect(commitProjectPrompt(base, '', '随便写')).toBe(base);
  });

  it('删整个项目：当前值和它在池子里的条目一起清掉，别的项目留着', () => {
    let next = commitProjectPrompt(settings(), KEY, '第一版');
    next = commitProjectPrompt(next, OTHER, '别的项目');
    const removed = removeProjectPrompt(next, KEY);
    expect(removed.projectPrompts).toEqual({ [OTHER]: '别的项目' });
    expect(removed.projectPromptHistory).toEqual([entry('别的项目', OTHER)]);
  });

  it('只删池子里的噪声记录，当前生效值不动', () => {
    let next = commitProjectPrompt(settings(), KEY, '第一版');
    next = commitProjectPrompt(next, KEY, '第二版');
    next = removeProjectPromptEntry(next, '第一版');
    expect(next.projectPrompts[KEY]).toBe('第二版');
    expect(next.projectPromptHistory).toEqual([entry('第二版', KEY)]);

    const emptied = removeProjectPromptEntry(next, '第二版');
    expect(emptied.projectPromptHistory).toEqual([]);
    expect(emptied.projectPrompts[KEY]).toBe('第二版');
  });

  it('删掉别的项目存过的条目也不影响当前项目的当前值', () => {
    let next = commitProjectPrompt(settings(), OTHER, '别的项目的要求');
    next = commitProjectPrompt(next, KEY, '当前项目的要求');
    next = removeProjectPromptEntry(next, '别的项目的要求');
    expect(next.projectPromptHistory).toEqual([entry('当前项目的要求', KEY)]);
    expect(next.projectPrompts).toEqual({ [KEY]: '当前项目的要求', [OTHER]: '别的项目的要求' });
  });

  it('历史条数与来源项目数统计', () => {
    const pool = [entry('1', 'acme/a'), entry('2', 'acme/b'), entry('3', 'acme/a')];
    expect(countProjectPromptEntries(pool)).toBe(3);
    expect(countProjectPromptEntries([])).toBe(0);
    expect(countHistoryProjects(pool)).toBe(2);
    expect(countHistoryProjects([{ value: 'x', projectKey: '' }])).toBe(0);
    expect(countHistoryProjects({ 'acme/a': ['1'], 'acme/b': ['2'] })).toBe(2);
  });
});
