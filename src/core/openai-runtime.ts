import { diffContext } from './diff';
import type { ToolCall, ToolDefinition, ToolResult } from './agent-tools';
import { parseOpenAIUsage, recordUsage } from './usage';
import type {
  ChatMessage,
  CodeSelection,
  FileDiff,
  RuntimeSettings,
} from './types';

export type ToolCallResponse = { type: 'text'; content: string } | { type: 'tool_calls'; calls: ToolCall[] };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string; tool_calls?: OpenAIToolCall[] } }[];
  error?: { message?: string };
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function shouldRetry(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function selectionContext(selection?: CodeSelection) {
  if (!selection) return '';
  return [
    `选中文件：${selection.filePath}`,
    `位置：${selection.side}:${selection.startLine}-${selection.endLine}`,
    '```text',
    selection.text,
    '```',
  ].join('\n');
}

export class OpenAIRuntime {
  constructor(private readonly settings: RuntimeSettings) {}

  get configured() {
    return Boolean(
      this.settings.modelBaseUrl &&
        this.settings.model &&
        (this.settings.apiKey || !this.settings.modelBaseUrl.includes('api.openai.com')),
    );
  }

  private headers() {
    const auth = this.settings.auth;
    const base: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    // Custom headers from auth settings
    if (auth?.customHeaders) {
      Object.assign(base, auth.customHeaders);
    }

    // Auth mode
    if (this.settings.apiKey) {
      const mode = auth?.mode ?? 'bearer';
      if (mode === 'bearer') {
        base['Authorization'] = `Bearer ${this.settings.apiKey}`;
      } else if (mode === 'api-key-header') {
        base[auth?.apiKeyHeader || 'api-key'] = this.settings.apiKey;
      } else if (mode === 'custom') {
        base[auth?.apiKeyHeader || 'Authorization'] = this.settings.apiKey;
      }
      // query-param mode: key goes in URL, not headers
    }

    return base;
  }

  private buildUrl(path: string): string {
    const auth = this.settings.auth;
    let url = endpoint(this.settings.modelBaseUrl, path);
    if (this.settings.apiKey && auth?.mode === 'query-param') {
      const param = auth.apiKeyQueryParam || 'key';
      url += `${url.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(this.settings.apiKey)}`;
    }
    return url;
  }

  async complete(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    options: { json?: boolean; signal?: AbortSignal; onToken?: (token: string) => void } = {},
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const useStream = Boolean(options.onToken) && !options.json;

      const response = await fetch(this.buildUrl('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.settings.model,
          messages,
          temperature: this.settings.effort === 'fast' ? 0 : 0.2,
          stream: useStream,
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: options.signal,
      });

      if (useStream && response.ok && response.body) {
        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let content = '';
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') break;
              try {
                const chunk = JSON.parse(data) as ChatCompletionResponse;
                const delta = (chunk.choices?.[0]?.message as Record<string, unknown> | undefined)?.content
                  ?? (chunk.choices?.[0] as Record<string, unknown> | undefined)?.delta?.content
                  ?? '';
                if (delta) {
                  content += delta;
                  options.onToken?.(delta);
                }
              } catch {
                // Skip malformed chunks
              }
            }
          }
        } catch (streamError) {
          if ((streamError as Error).name === 'AbortError') throw streamError;
          if (content) return content; // Return partial content
          throw streamError;
        }

        if (!content) throw new Error('模型服务没有返回文本内容');
        return content;
      }

      const payload = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
      if (!response.ok || payload.error) {
        const message = payload.error?.message ?? `模型服务返回 HTTP ${response.status}`;
        if (attempt < 2 && shouldRetry(response.status)) {
          await wait(250 * 2 ** attempt, options.signal);
          continue;
        }
        throw new Error(message);
      }

      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('模型服务没有返回文本内容');

      // Record usage
      const usage = parseOpenAIUsage(payload as unknown as Record<string, unknown>);
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        void recordUsage('openai', this.settings.model, usage.inputTokens, usage.outputTokens);
      }

      return content;
    }
    throw new Error('模型服务重试次数已用尽');
  }

  async chat(
    messages: ChatMessage[],
    selection: CodeSelection | undefined,
    signal?: AbortSignal,
    onToken?: (token: string) => void,
  ) {
    const history = messages
      .filter((message) => message.role !== 'system' && !message.error)
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.attachment
          ? `${message.content}\n\n${selectionContext(message.attachment)}`
          : message.content,
      }));

    return this.complete(
      [
        {
          role: 'system',
          content:
            '你是 GitLab 代码评审助手。只基于给出的代码回答，明确区分已确认事实和推断。回答使用简体中文，避免编译造文件内容。',
        },
        ...(selection && !messages.some((message) => message.attachment)
          ? [{ role: 'user' as const, content: selectionContext(selection) }]
          : []),
        ...history,
      ],
      { signal, onToken },
    );
  }

  async review(
    files: FileDiff[],
    selection: CodeSelection | undefined,
    language: RuntimeSettings['language'],
    signal?: AbortSignal,
    background?: string,
  ) {
    const context = [
      selection ? selectionContext(selection) : diffContext(files),
      background ? `\n\n业务背景：\n${background}` : '',
    ].join('');
    const strictness =
      this.settings.effort === 'thorough'
        ? '可报告更多问题，但仍须给出可复核证据。'
        : this.settings.effort === 'fast'
          ? '只报告高置信度问题。'
          : '优先精确率，排除风格偏好和猜测。';

    return this.complete(
      [
        {
          role: 'system',
          content:
            `你是代码评审引擎。输出严格 JSON：{"findings":[{"path","line","endLine","side","category","severity","confidence","title","content","evidence":[{"path","lines","quote"}],"existingCode","suggestionCode","comment"}]}。category 只能是 bug/security/performance/maintainability/test；severity 只能是 critical/high/medium/low；confidence 只能是 high/medium/low。existingCode 必须是目标文件中的连续原文；跨文件证据使用 evidence.path。主 Finding 应优先锚定 Diff 行，完整文件只能作为上下文或证据，不能单独作为可发布位置。${strictness}${language === 'en-US' ? ' Write findings in English.' : ' 所有字段使用简体中文。'}`,
        },
        { role: 'user', content: context },
      ],
      { json: true, signal },
    );
  }

  async testConnection(signal?: AbortSignal) {
    const response = await fetch(endpoint(this.settings.modelBaseUrl, '/models'), {
      headers: this.headers(),
      signal,
    });
    if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
    return true;
  }

  async callWithTools(
    messages: { role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }[],
    tools: ToolDefinition[],
    system: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolCallResponse> {
    const openaiTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const openaiMessages = [
      { role: 'system' as const, content: system },
      ...messages,
    ];

    const response = await fetch(endpoint(this.settings.modelBaseUrl, '/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.settings.model,
        messages: openaiMessages,
        tools: openaiTools,
        temperature: this.settings.effort === 'fast' ? 0 : 0.2,
      }),
      signal: options.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `模型服务返回 HTTP ${response.status}`);
    }

    const message = payload.choices?.[0]?.message;
    if (message?.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_calls',
        calls: message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        })),
      };
    }

    return { type: 'text', content: message?.content ?? '' };
  }
}
