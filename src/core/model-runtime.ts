import type { ToolCall, ToolDefinition } from './agent-tools';
import { AnthropicRuntime } from './anthropic-runtime';
import { GeminiRuntime } from './gemini-runtime';
import { OpenAIRuntime } from './openai-runtime';
import type {
  ChatMessage,
  CodeSelection,
  FileDiff,
  RuntimeSettings,
} from './types';

export type ToolCallResponse = { type: 'text'; content: string } | { type: 'tool_calls'; calls: ToolCall[] };

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ModelRuntime {
  configured: boolean;
  chat(messages: ChatMessage[], selection: CodeSelection | undefined, signal?: AbortSignal, onToken?: (token: string) => void): Promise<string>;
  review(files: FileDiff[], selection: CodeSelection | undefined, language: RuntimeSettings['language'], signal?: AbortSignal, background?: string): Promise<string>;
  testConnection(signal?: AbortSignal): Promise<boolean>;
  callWithTools(messages: AgentMessage[], tools: ToolDefinition[], system: string, options?: { signal?: AbortSignal }): Promise<ToolCallResponse>;
}

export function createModelRuntime(settings: RuntimeSettings): ModelRuntime {
  switch (settings.provider) {
    case 'anthropic':
      return new AnthropicRuntime(settings);
    case 'gemini':
      return new GeminiRuntime(settings);
    case 'openai':
    default:
      return new OpenAIRuntime(settings);
  }
}
