import { AnthropicRuntime } from './anthropic-runtime';
import { GeminiRuntime } from './gemini-runtime';
import { OpenAIRuntime } from './openai-runtime';
import type {
  ChatMessage,
  CodeSelection,
  FileDiff,
  RuntimeSettings,
} from './types';

export interface ModelRuntime {
  configured: boolean;
  chat(messages: ChatMessage[], selection: CodeSelection | undefined, signal?: AbortSignal): Promise<string>;
  review(files: FileDiff[], selection: CodeSelection | undefined, language: RuntimeSettings['language'], signal?: AbortSignal, background?: string): Promise<string>;
  testConnection(signal?: AbortSignal): Promise<boolean>;
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
