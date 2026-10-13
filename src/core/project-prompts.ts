import type { ProjectPromptHistoryEntry, RuntimeSettings } from './types';

/** 全局历史池上限：所有项目共用一个池子，超出裁掉最旧的。 */
export const GLOBAL_PROMPT_HISTORY_LIMIT = 30;

export type ProjectPromptMap = Record<string, string>;
export type ProjectPromptHistoryPool = ProjectPromptHistoryEntry[];

export interface ProjectPromptState {
  prompts: ProjectPromptMap;
  history: ProjectPromptHistoryPool;
}

/** 旧版按项目分桶的历史：{ [projectKey]: string[] }，摊平进全局池时给每条打上来源项目。 */
function flattenLegacyHistoryMap(map: Record<string, unknown>): ProjectPromptHistoryPool {
  const flat: ProjectPromptHistoryPool = [];
  for (const [key, entries] of Object.entries(map)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      flat.push({ value: entry, projectKey: key });
    }
  }
  return flat;
}

/**
 * 历史统一成「最新在前」的 trim 后条目：丢掉空白项、按内容去重（保留最靠前那条）、截断到全局上限。
 * 存 trim 后的值，去重和历史列表里的条目才对「同样内容」表现一致；注入评审时本来也会再 trim 一次。
 * 兼容三种落盘形态：全局池 [{value,projectKey}]、旧版按项目分桶的 Record、以及更早的纯字符串数组。
 */
export function normalizeProjectPromptHistory(pool: unknown): ProjectPromptHistoryPool {
  const raw: unknown[] = Array.isArray(pool)
    ? pool
    : pool && typeof pool === 'object'
      ? flattenLegacyHistoryMap(pool as Record<string, unknown>)
      : [];
  const seen = new Set<string>();
  const result: ProjectPromptHistoryPool = [];
  for (const item of raw) {
    const entry = (typeof item === 'string' ? { value: item, projectKey: '' } : item) as Partial<ProjectPromptHistoryEntry>;
    const value = typeof entry?.value === 'string' ? entry.value.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push({ value, projectKey: typeof entry.projectKey === 'string' ? entry.projectKey.trim() : '' });
  }
  return result.slice(0, GLOBAL_PROMPT_HISTORY_LIMIT);
}

/** 保存点语义：新值置顶，同样内容只留最近一条（等于把旧的那条提到最前，来源项目也跟着更新），空值不入历史。 */
export function pushProjectPromptHistory(pool: ProjectPromptHistoryPool, value: string, projectKey: string): ProjectPromptHistoryPool {
  const entry = value.trim();
  if (!entry) return pool;
  return normalizeProjectPromptHistory([{ value: entry, projectKey }, ...pool]);
}

export function removeProjectPromptHistory(pool: ProjectPromptHistoryPool, value: string): ProjectPromptHistoryPool {
  return pool.filter((entry) => entry.value !== value);
}

/** 删整个项目时连带清掉它在池子里的条目；别的项目存过的照旧留着。 */
export function removeProjectPromptHistoryByProject(pool: ProjectPromptHistoryPool, projectKey: string): ProjectPromptHistoryPool {
  return pool.filter((entry) => entry.projectKey !== projectKey);
}

/**
 * 三级迁移，一条都不丢：
 * 1) 最早版本只有「每项目一个单值」projectPrompts → 该项目的唯一一条历史；
 * 2) 中间版本按项目分桶 projectPromptHistory（Record）→ 按 key 顺序摊平进全局池，跨项目去重、截到上限；
 * 3) 已经是全局池 → 原样归一化。
 * 值为空的键直接扔掉（清空本来就等于没有补充要求）；池子里还没有该项目任何条目时，才用当前值补一条，
 * 已有历史则不拿没保存过的草稿覆盖。
 */
export function migrateProjectPrompts(prompts: unknown, history: unknown): ProjectPromptState {
  const legacyPrompts = (prompts && typeof prompts === 'object' ? prompts : {}) as Record<string, unknown>;

  const nextPrompts: ProjectPromptMap = {};
  for (const [key, value] of Object.entries(legacyPrompts)) {
    if (typeof value === 'string' && value.trim()) nextPrompts[key] = value;
  }

  const pool = normalizeProjectPromptHistory(history);
  const keysWithHistory = new Set(pool.map((entry) => entry.projectKey));
  const seen = new Set(pool.map((entry) => entry.value));
  for (const [key, value] of Object.entries(nextPrompts)) {
    if (keysWithHistory.has(key)) continue;
    const entry = value.trim();
    if (seen.has(entry)) continue;
    seen.add(entry);
    pool.push({ value: entry, projectKey: key });
  }
  return { prompts: nextPrompts, history: pool.slice(0, GLOBAL_PROMPT_HISTORY_LIMIT) };
}

/** 起始页与设置页共用同一个全局池：读到什么形态都归一化成条目数组。 */
export function projectPromptHistoryPool(settings: RuntimeSettings): ProjectPromptHistoryPool {
  return normalizeProjectPromptHistory(settings.projectPromptHistory);
}

export function countProjectPromptEntries(pool: unknown): number {
  return normalizeProjectPromptHistory(pool).length;
}

/** 池子里出现过的来源项目数，设置页用它说明这 N 条历史跨了多少个项目。 */
export function countHistoryProjects(pool: unknown): number {
  return new Set(normalizeProjectPromptHistory(pool).map((entry) => entry.projectKey).filter(Boolean)).size;
}

/** 打字过程只改「当前值」，历史留到保存点再追加，否则每敲一个字都会多出一条历史。 */
export function setProjectPrompt(settings: RuntimeSettings, key: string, value: string): RuntimeSettings {
  if (!key) return settings;
  const prompts: ProjectPromptMap = { ...(settings.projectPrompts ?? {}) };
  if (value.trim()) prompts[key] = value;
  else delete prompts[key];
  return { ...settings, projectPrompts: prompts };
}

/** 保存点：落当前值 + 追加进全局池（带上来源项目）。清空只删当前值，历史保留，方便从列表把刚才那条捞回来。 */
export function commitProjectPrompt(settings: RuntimeSettings, key: string, value: string): RuntimeSettings {
  if (!key) return settings;
  const pool = pushProjectPromptHistory(projectPromptHistoryPool(settings), value, key);
  return { ...setProjectPrompt(settings, key, value), projectPromptHistory: pool };
}

/** 删除整个项目：当前值和该项目在全局池里的条目一起清掉。 */
export function removeProjectPrompt(settings: RuntimeSettings, key: string): RuntimeSettings {
  const prompts: ProjectPromptMap = { ...(settings.projectPrompts ?? {}) };
  delete prompts[key];
  return {
    ...settings,
    projectPrompts: prompts,
    projectPromptHistory: removeProjectPromptHistoryByProject(projectPromptHistoryPool(settings), key),
  };
}

/** 只删池子里的一条噪声记录，当前生效值不动。 */
export function removeProjectPromptEntry(settings: RuntimeSettings, entry: string): RuntimeSettings {
  return { ...settings, projectPromptHistory: removeProjectPromptHistory(projectPromptHistoryPool(settings), entry) };
}
