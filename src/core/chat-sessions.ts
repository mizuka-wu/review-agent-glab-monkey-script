import type { ChatMessage } from './types';

/**
 * 聊天会话：全局单池（不按 MR 区分），多会话 + 新建/切换/删除 + 持久化。
 */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export const CHAT_STORAGE_KEY = 'review-agent-chat-v1';
const MESSAGE_LIMIT = 50;

export function newChatSession(): ChatSession {
  const now = new Date().toISOString();
  return { id: `chat-${now}-${Math.random().toString(36).slice(2, 8)}`, title: '新会话', createdAt: now, updatedAt: now, messages: [] };
}

export function deriveChatTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!firstUser) return '新会话';
  const text = firstUser.content.trim().replace(/\s+/g, ' ');
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

export function loadChatSessions(key: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const sessions = parsed.filter(
      (item): item is ChatSession =>
        typeof item === 'object' && item !== null
        && typeof (item as ChatSession).id === 'string'
        && Array.isArray((item as ChatSession).messages),
    );
    return sessions.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
  } catch {
    return [];
  }
}

export function saveChatSessions(key: string, sessions: ChatSession[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(sessions));
  } catch { /* 忽略存储失败（超配额等） */ }
}

export function trimSessionMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MESSAGE_LIMIT);
}
