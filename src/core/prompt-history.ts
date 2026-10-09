export const PROMPT_HISTORY_KEY = 'review-agent-prompt-history-v1';
export const PROMPT_HISTORY_LIMIT = 20;

/** index 为 -1 表示没有翻历史，输入框里是用户自己写的草稿。 */
export interface PromptHistoryBrowse {
  index: number;
  saved: string;
}

export const idleBrowse: PromptHistoryBrowse = { index: -1, saved: '' };

export function loadPromptHistory(key: string = PROMPT_HISTORY_KEY): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return dedupePrompts(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return [];
  }
}

export function savePromptHistory(entries: string[], key: string = PROMPT_HISTORY_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(entries.slice(0, PROMPT_HISTORY_LIMIT)));
  } catch { /* 忽略存储失败（超配额等） */ }
}

function dedupePrompts(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const value = entry.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result.slice(0, PROMPT_HISTORY_LIMIT);
}

/** 新提交的 prompt 置顶，同样内容只留最近一条。 */
export function pushPromptHistory(entries: string[], text: string): string[] {
  const value = text.trim();
  if (!value) return entries;
  return dedupePrompts([value, ...entries]);
}

export function removePromptHistory(entries: string[], text: string): string[] {
  return entries.filter((entry) => entry !== text);
}

/**
 * ↑ 取更旧的一条，↓ 回到更新的一条；翻到底把进入历史前的草稿还回去。
 * 返回 undefined 表示这一侧已经没有内容可翻，调用方不要拦截按键。
 */
export function stepPromptHistory(
  entries: string[],
  browse: PromptHistoryBrowse,
  direction: 'older' | 'newer',
  draft: string,
): { browse: PromptHistoryBrowse; value: string } | undefined {
  if (entries.length === 0) return undefined;
  if (direction === 'older') {
    const index = browse.index + 1;
    if (index > entries.length - 1) return undefined;
    return {
      browse: { index, saved: browse.index === -1 ? draft : browse.saved },
      value: entries[index],
    };
  }
  if (browse.index === -1) return undefined;
  const index = browse.index - 1;
  return index === -1
    ? { browse: idleBrowse, value: browse.saved }
    : { browse: { index, saved: browse.saved }, value: entries[index] };
}

/** 多行草稿里 ↑↓ 首先要移动光标：只有光标已在首行/末行时才翻历史。 */
export function caretAllowsHistory(
  value: string,
  caret: { start: number; end: number },
  direction: 'older' | 'newer',
): boolean {
  return direction === 'older'
    ? !value.slice(0, caret.start).includes('\n')
    : !value.slice(caret.end).includes('\n');
}
