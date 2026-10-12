import type { RuntimeSettings } from './types';

/** 每个项目保留的补充要求历史条数上限，超出裁掉最旧的。 */
export const PROJECT_PROMPT_HISTORY_LIMIT = 10;

export type ProjectPromptMap = Record<string, string>;
export type ProjectPromptHistoryMap = Record<string, string[]>;

export interface ProjectPromptState {
  prompts: ProjectPromptMap;
  history: ProjectPromptHistoryMap;
}

/**
 * 历史统一成「最新在前」的 trim 后文本：丢掉空白项、按内容去重（保留最靠前那条）、截断到上限。
 * 存 trim 后的值，去重和 ↑↓ 翻历史才对「同样内容」表现一致；注入评审时本来也会再 trim 一次。
 */
export function normalizeProjectPromptHistory(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result.slice(0, PROJECT_PROMPT_HISTORY_LIMIT);
}

/** 保存点语义：新值置顶，同样内容只留最近一条（等于把旧的那条提到最前），空值不入历史。 */
export function pushProjectPromptHistory(history: string[], value: string): string[] {
  const entry = value.trim();
  if (!entry) return history;
  return normalizeProjectPromptHistory([entry, ...history]);
}

export function removeProjectPromptHistory(history: string[], value: string): string[] {
  return history.filter((entry) => entry !== value);
}

/**
 * 旧版 projectPrompts 是「每项目一个单值」，升级成历史列表：已存的单值变成该项目唯一一条历史，
 * 一条都不丢。值为空的键直接扔掉（清空本来就等于没有补充要求），已有历史则原样归一化保留。
 */
export function migrateProjectPrompts(prompts: unknown, history: unknown): ProjectPromptState {
  const legacyPrompts = (prompts && typeof prompts === 'object' ? prompts : {}) as Record<string, unknown>;
  const legacyHistory = (history && typeof history === 'object' ? history : {}) as Record<string, unknown>;

  const nextPrompts: ProjectPromptMap = {};
  for (const [key, value] of Object.entries(legacyPrompts)) {
    if (typeof value === 'string' && value.trim()) nextPrompts[key] = value;
  }

  const nextHistory: ProjectPromptHistoryMap = {};
  for (const [key, value] of Object.entries(legacyHistory)) {
    const entries = normalizeProjectPromptHistory(value);
    if (entries.length > 0) nextHistory[key] = entries;
  }
  for (const [key, value] of Object.entries(nextPrompts)) {
    if (!nextHistory[key]) nextHistory[key] = [value.trim()];
  }
  return { prompts: nextPrompts, history: nextHistory };
}

export function projectPromptHistoryOf(settings: RuntimeSettings, key: string): string[] {
  if (!key) return [];
  return (settings.projectPromptHistory ?? {})[key] ?? [];
}

export function countProjectPromptEntries(history: ProjectPromptHistoryMap): number {
  return Object.values(history ?? {}).reduce((total, entries) => total + entries.length, 0);
}

/** 打字过程只改「当前值」，历史留到保存点再追加，否则每敲一个字都会多出一条历史。 */
export function setProjectPrompt(settings: RuntimeSettings, key: string, value: string): RuntimeSettings {
  if (!key) return settings;
  const prompts: ProjectPromptMap = { ...(settings.projectPrompts ?? {}) };
  if (value.trim()) prompts[key] = value;
  else delete prompts[key];
  return { ...settings, projectPrompts: prompts };
}

/** 保存点：落当前值 + 追加历史。清空只删当前值，历史保留，方便 ↑ 把刚才那条捞回来。 */
export function commitProjectPrompt(settings: RuntimeSettings, key: string, value: string): RuntimeSettings {
  if (!key) return settings;
  const history: ProjectPromptHistoryMap = { ...(settings.projectPromptHistory ?? {}) };
  const entries = pushProjectPromptHistory(history[key] ?? [], value);
  if (entries.length > 0) history[key] = entries;
  else delete history[key];
  return { ...setProjectPrompt(settings, key, value), projectPromptHistory: history };
}

/** 删除整个项目：当前值和该项目全部历史一起清掉。 */
export function removeProjectPrompt(settings: RuntimeSettings, key: string): RuntimeSettings {
  const prompts: ProjectPromptMap = { ...(settings.projectPrompts ?? {}) };
  const history: ProjectPromptHistoryMap = { ...(settings.projectPromptHistory ?? {}) };
  delete prompts[key];
  delete history[key];
  return { ...settings, projectPrompts: prompts, projectPromptHistory: history };
}

/** 只删历史里的一条噪声记录，当前生效值不动。 */
export function removeProjectPromptEntry(settings: RuntimeSettings, key: string, entry: string): RuntimeSettings {
  const history: ProjectPromptHistoryMap = { ...(settings.projectPromptHistory ?? {}) };
  const entries = removeProjectPromptHistory(history[key] ?? [], entry);
  if (entries.length > 0) history[key] = entries;
  else delete history[key];
  return { ...settings, projectPromptHistory: history };
}
