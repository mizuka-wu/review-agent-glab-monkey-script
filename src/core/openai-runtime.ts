import { diffContext } from './diff';
import { selectionLines } from './selection';
import { isModelConfigured } from './settings';
import { httpRequest, httpTransport, RequestTimeoutError, TimeoutSignal, timeoutSeconds, type HttpResponse } from './http';
import { debugBus, type DebugExchangeInput } from './debug-bus';
import type { ToolCall, ToolDefinition } from './agent-tools';
import { parseOpenAIUsage, recordUsage } from './usage';
import { reflectSystemPrompt } from './reflection';
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
  choices?: { message?: { content?: string; tool_calls?: OpenAIToolCall[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface StreamChunk {
  choices?: {
    delta?: { content?: string; reasoning_content?: string };
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function shouldRetry(status: number) {
  // 507 = 服务端内存不足（如 omlx 装不下模型），重试无意义，直接报错。
  return status === 408 || status === 429 || (status >= 500 && status !== 507);
}

/** 非流式模型调用的总超时（GM 传输此前也是这个量级，避免大 Review 被过早掐断）。 */
export const MODEL_REQUEST_TIMEOUT_MS = 180_000;
/** 流式首包超时：连接建立后一直没有第一个 chunk。 */
export const MODEL_STREAM_FIRST_CHUNK_TIMEOUT_MS = 120_000;
/** 流式空闲超时：中途长时间没有任何新数据（思考阶段的 reasoning chunk 也算数据）。 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 120_000;
/** 探测类请求（/models、测试连接）快速失败。 */
export const MODEL_PROBE_TIMEOUT_MS = 15_000;
/** 超时最多尝试 2 次：网络黑洞时不能让用户在 running 状态里等太久。 */
const TIMEOUT_MAX_ATTEMPTS = 2;

function streamTimeoutMessage(detail: string) {
  return `模型流式响应超时（${timeoutSeconds(MODEL_STREAM_IDLE_TIMEOUT_MS)} ${detail}）`;
}

interface StreamLikeResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text: string;
  contentType: string;
}

/** 流式优先走 fetch；被 CSP/CORS 拦截时回退到 GM 一次性请求（无逐 token 渲染）。 */
async function fetchStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  guard: TimeoutSignal,
): Promise<StreamLikeResponse> {
  guard.arm(MODEL_STREAM_FIRST_CHUNK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'POST', headers, body, signal: guard.signal });
    return { ok: response.ok, status: response.status, body: response.body, text: '', contentType: response.headers.get('content-type') ?? '' };
  } catch (error) {
    // 首包超时不降级到 GM：服务端没回应，换成一次性请求只会等更久。
    if (guard.timedOut) {
      throw guard.attribute(error, `模型服务首包超时（${timeoutSeconds(MODEL_STREAM_FIRST_CHUNK_TIMEOUT_MS)} 未收到任何数据）`, true);
    }
    if (guard.signal.aborted || (error as Error).name === 'AbortError') throw error;
    const fallback = await httpRequest(url, {
      method: 'POST', headers, body, signal: guard.signal, timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    });
    return { ok: fallback.status >= 200 && fallback.status < 300, status: fallback.status, body: null, text: fallback.text, contentType: '' };
  }
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

/** 选区进提示词：页面 DOM 取不到行号时明示未知，绝不给模型编造行号。 */
function selectionContext(selection?: CodeSelection) {
  if (!selection) return '';
  const lines = selectionLines(selection);
  return [
    `Selected file: ${selection.filePath}`,
    `Location: ${lines ? `${selection.side}:${lines}` : 'unknown (the page exposed no line number; do not invent one)'}`,
    '```text',
    selection.text,
    '```',
  ].join('\n');
}

function chatSystemPrompt(language: 'zh-CN' | 'en-US') {
  return language === 'en-US'
    ? 'You are a GitLab code review assistant. Answer only based on the given code. Clearly distinguish confirmed facts from inference. Do not fabricate file contents.'
    : '你是 GitLab 代码评审助手。只基于给出的代码回答，明确区分已确认事实和推断。回答使用简体中文，避免编译造文件内容。';
}

export function reviewSystemPrompt(language: 'zh-CN' | 'en-US', strictness: string) {
  const lang = language === 'en-US' ? ' Write findings in English.' : ' 所有字段使用简体中文。';
  return `你是代码评审引擎。输出严格 JSON：{"findings":[{"path","line","endLine","side","category","severity","confidence","title","content","evidence":[{"path","lines","quote"}],"existingCode","suggestionCode","comment"}]}。category 只能是 bug/security/performance/maintainability/test；severity 只能是 critical/high/medium/low；confidence 只能是 high/medium/low。existingCode 必须是目标文件中的连续原文；跨文件证据使用 evidence.path。主 Finding 应优先锚定 Diff 行，完整文件只能作为上下文或证据，不能单独作为可发布位置。${strictness}${lang}`;
}

export class OpenAIRuntime {
  constructor(private readonly settings: RuntimeSettings) {}

  get configured() {
    return isModelConfigured(this.settings);
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
    options: { json?: boolean; signal?: AbortSignal; onToken?: (token: string) => void; onThinking?: (token: string) => void; stage?: string } = {},
  ) {
    const stage = options.stage ?? 'chat';
    const system = messages.find((message) => message.role === 'system')?.content;
    const conversation = messages.filter((message) => message.role !== 'system');
    try {
      const content = await this.runComplete(messages, options);
      const conversationWithThinking = this.lastThinking
        ? [...conversation, { role: 'thinking', content: this.lastThinking.slice(0, 4000) }]
        : conversation;
      debugBus.prompt({
        stage, model: this.settings.model, system, messages: conversationWithThinking,
        response: content.slice(0, 4000), tokens: this.lastTokens,
      });
      return content;
    } catch (error) {
      debugBus.prompt({
        stage, model: this.settings.model, system, messages: conversation,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private lastTokens: { input: number; output: number } | undefined;
  private lastThinking = '';

  /** 把一次 HTTP 往返的完整请求 / 响应交给调试总线（响应字段在调用点补齐）。 */
  private commitExchange(
    exchange: DebugExchangeInput,
    startedAt: number,
    patch: Partial<Pick<DebugExchangeInput, 'status' | 'responseText' | 'content' | 'reasoning' | 'finishReason' | 'usage' | 'error'>>,
  ) {
    debugBus.exchange({ ...exchange, ...patch, ms: Date.now() - startedAt });
  }

  private async runComplete(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    options: { json?: boolean; signal?: AbortSignal; onToken?: (token: string) => void; onThinking?: (token: string) => void; stage?: string } = {},
  ) {
    this.lastThinking = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const useStream = Boolean(options.onToken);
      // 用户取消与超时共用一个 signal：guard.timedOut 区分两者，取消不会被当成超时。
      const guard = new TimeoutSignal(options.signal);

      try {
        const payloadBody = JSON.stringify({
          model: this.settings.model,
          messages,
          temperature: this.settings.effort === 'fast' ? 0 : 0.2,
          stream: useStream,
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
          ...(this.settings.thinking === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        });
        const requestHeaders = this.headers();
        const requestUrl = this.buildUrl('/chat/completions');
        const startedAt = Date.now();
        const exchange: DebugExchangeInput = {
          stage: options.stage ?? 'chat',
          model: this.settings.model,
          stream: useStream,
          attempt: attempt + 1,
          url: requestUrl,
          headers: requestHeaders,
          body: payloadBody,
          transport: useStream ? 'fetch' : httpTransport(),
          ms: 0,
          responseText: '',
          content: '',
          reasoning: '',
          chunks: [],
        };

        let response: StreamLikeResponse;
        try {
          response = useStream
            ? await fetchStream(requestUrl, requestHeaders, payloadBody, guard)
            : await httpRequest(requestUrl, {
              method: 'POST',
              headers: requestHeaders,
              body: payloadBody,
              signal: guard.signal,
              timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
            }).then((result) => ({
              ok: result.status >= 200 && result.status < 300,
              status: result.status,
              body: null,
              text: result.text,
              contentType: '',
            }));
        } catch (error) {
          this.commitExchange(exchange, startedAt, { error: error instanceof Error ? error.message : String(error) });
          // 超时与 429/5xx 一样进重试，但次数更少：网络黑洞时不能一直转圈。
          if (attempt + 1 < TIMEOUT_MAX_ATTEMPTS && error instanceof RequestTimeoutError && error.retryable) {
            await wait(250 * 2 ** attempt, options.signal);
            continue;
          }
          throw error;
        }
        exchange.status = response.status;

        if (useStream && response.ok && response.body && response.contentType.includes('text/event-stream')) {
          // Parse SSE stream
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let content = '';
          let buffer = '';
          let done = false;
          let streamUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

          try {
            while (!done) {
              const { done: streamDone, value } = await reader.read();
              // 收到数据后把「首包超时」换成「空闲超时」。
              guard.arm(MODEL_STREAM_IDLE_TIMEOUT_MS);
              if (streamDone) break;
              buffer += decoder.decode(value, { stream: true });

              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') { done = true; break; }
                try {
                  const chunk = JSON.parse(data) as StreamChunk;
                  if (chunk.usage) streamUsage = chunk.usage;
                  const choice = chunk.choices?.[0];
                  const finishReason = choice?.finish_reason ?? undefined;
                  if (finishReason) exchange.finishReason = finishReason;
                  const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
                  if (delta) {
                    content += delta;
                    exchange.chunks.push({ kind: 'content', text: delta, finishReason });
                    options.onToken?.(delta);
                  }
                  const reasoning = choice?.delta?.reasoning_content ?? choice?.message?.reasoning_content ?? '';
                  if (reasoning) {
                    this.lastThinking += reasoning;
                    exchange.chunks.push({ kind: 'reasoning', text: reasoning });
                    options.onThinking?.(reasoning);
                  }
                } catch {
                  // Skip malformed chunks
                }
              }
            }
            // Flush remaining decoder buffer
            buffer += decoder.decode();
          } catch (streamError) {
            const timedOut = guard.timedOut;
            const aborted = !timedOut && (streamError as Error).name === 'AbortError';
            const failure = timedOut ? new RequestTimeoutError(streamTimeoutMessage('没有新数据'), false) : streamError;
            this.commitExchange(exchange, startedAt, {
              content,
              reasoning: this.lastThinking,
              usage: streamUsage && { input: streamUsage.prompt_tokens ?? 0, output: streamUsage.completion_tokens ?? 0 },
              error: aborted
                ? '已取消'
                : timedOut && content
                  ? '流式响应超时，已保留部分内容'
                  : failure instanceof Error ? failure.message : String(failure),
            });
            if (aborted) throw streamError;
            if (content) return content; // Return partial content
            throw failure;
          }

          debugBus.network({
            kind: 'model', method: 'POST', url: `${this.settings.modelBaseUrl}/chat/completions (stream)`,
            status: response.status, ms: Date.now() - startedAt, transport: 'fetch',
          });
          if (streamUsage?.prompt_tokens || streamUsage?.completion_tokens) {
            this.lastTokens = { input: streamUsage.prompt_tokens ?? 0, output: streamUsage.completion_tokens ?? 0 };
            void recordUsage('openai', this.settings.model, this.lastTokens.input, this.lastTokens.output);
          }
          this.commitExchange(exchange, startedAt, {
            content,
            reasoning: this.lastThinking,
            usage: streamUsage && { input: streamUsage.prompt_tokens ?? 0, output: streamUsage.completion_tokens ?? 0 },
            error: content ? undefined : '模型服务没有返回文本内容',
          });
          if (!content) throw new Error('模型服务没有返回文本内容');
          return content;
        }

        if (useStream && response.ok) {
          // 服务端忽略 stream 或未返回 SSE：一次性读完并整体回调，保证 UI 仍有输出。
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let fullText = response.body ? '' : response.text;
          if (response.body) {
            try {
              for (;;) {
                const { done: readDone, value } = await reader.read();
                guard.arm(MODEL_STREAM_IDLE_TIMEOUT_MS);
                if (readDone) break;
                fullText += decoder.decode(value, { stream: true });
              }
              fullText += decoder.decode();
            } catch (readError) {
              const timedOut = guard.timedOut;
              this.commitExchange(exchange, startedAt, { responseText: fullText, error: timedOut ? '流式响应超时' : '已取消' });
              throw timedOut ? new RequestTimeoutError(streamTimeoutMessage('没有新数据'), false) : readError;
            }
          }
          const parsed = (JSON.parse(fullText || 'null') ?? {}) as ChatCompletionResponse;
          const content = parsed.choices?.[0]?.message?.content ?? fullText;
          const usage = parseOpenAIUsage(parsed as unknown as Record<string, unknown>);
          this.lastTokens = { input: usage.inputTokens, output: usage.outputTokens };
          debugBus.network({
            kind: 'model', method: 'POST', url: `${this.settings.modelBaseUrl}/chat/completions (stream-fallback)`,
            status: response.status, ms: Date.now() - startedAt, bytes: fullText.length, transport: 'fetch',
          });
          if (usage.inputTokens > 0 || usage.outputTokens > 0) {
            void recordUsage('openai', this.settings.model, usage.inputTokens, usage.outputTokens);
          }
          this.commitExchange(exchange, startedAt, {
            responseText: fullText,
            content,
            reasoning: this.lastThinking,
            finishReason: parsed.choices?.[0]?.finish_reason ?? undefined,
            usage: { input: usage.inputTokens, output: usage.outputTokens },
            error: content ? undefined : '模型服务没有返回文本内容',
          });
          if (!content) throw new Error('模型服务没有返回文本内容');
          options.onToken?.(content);
          return content;
        }

        const payload = (JSON.parse(response.text || 'null') ?? {}) as ChatCompletionResponse;
        if (!response.ok || payload.error) {
          const message = payload.error?.message ?? `模型服务返回 HTTP ${response.status}（${requestUrl}）`;
          this.commitExchange(exchange, startedAt, { responseText: response.text, error: message });
          if (attempt < 2 && shouldRetry(response.status)) {
            await wait(250 * 2 ** attempt, options.signal);
            continue;
          }
          throw new Error(message);
        }

        const content = payload.choices?.[0]?.message?.content;

        // Record usage
        const usage = parseOpenAIUsage(payload as unknown as Record<string, unknown>);
        this.lastTokens = { input: usage.inputTokens, output: usage.outputTokens };
        debugBus.network({
          kind: 'model', method: 'POST', url: `${this.settings.modelBaseUrl}/chat/completions`,
          status: response.status, ms: Date.now() - startedAt,
          bytes: response.text.length, transport: httpTransport(),
        });
        if (usage.inputTokens > 0 || usage.outputTokens > 0) {
          void recordUsage('openai', this.settings.model, usage.inputTokens, usage.outputTokens);
        }
        this.commitExchange(exchange, startedAt, {
          responseText: response.text,
          content: content ?? '',
          finishReason: payload.choices?.[0]?.finish_reason ?? undefined,
          usage: { input: usage.inputTokens, output: usage.outputTokens },
          error: content ? undefined : '模型服务没有返回文本内容',
        });
        if (!content) throw new Error('模型服务没有返回文本内容');

        return content;
      } finally {
        guard.dispose();
      }
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
          content: chatSystemPrompt(this.settings.language),
        },
        ...(selection && !messages.some((message) => message.attachment)
          ? [{ role: 'user' as const, content: selectionContext(selection) }]
          : []),
        ...history,
      ],
      { signal, onToken, stage: 'chat' },
    );
  }

  async review(
    files: FileDiff[],
    selection: CodeSelection | undefined,
    language: RuntimeSettings['language'],
    signal?: AbortSignal,
    background?: string,
    options?: { onToken?: (token: string) => void; onThinking?: (token: string) => void; projectPrompt?: string },
  ) {
    const context = [
      selection ? selectionContext(selection) : diffContext(files),
      background ? `\n\n业务背景：\n${background}` : '',
      options?.projectPrompt?.trim()
        ? `\n\n## 项目补充要求（该项目维护者配置，与上述内容冲突时以本节为准）\n${options.projectPrompt.trim()}`
        : '',
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
          content: reviewSystemPrompt(language, strictness),
        },
        { role: 'user', content: context },
      ],
      { json: true, signal, stage: 'review', onToken: options?.onToken, onThinking: options?.onThinking },
    );
  }

  async reflect(payload: string, language: RuntimeSettings['language'], signal?: AbortSignal) {
    return this.complete(
      [
        { role: 'system', content: reflectSystemPrompt(language) },
        { role: 'user', content: payload },
      ],
      { json: true, signal, stage: 'reflection' },
    );
  }

  async testConnection(signal?: AbortSignal) {
    const response = await httpRequest(this.buildUrl('/models'), { headers: this.headers(), signal, timeoutMs: MODEL_PROBE_TIMEOUT_MS });
    if (response.status < 200 || response.status >= 300) throw new Error(`模型服务返回 HTTP ${response.status}`);
    return true;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await httpRequest(this.buildUrl('/models'), { headers: this.headers(), signal, timeoutMs: MODEL_PROBE_TIMEOUT_MS });
    if (response.status < 200 || response.status >= 300) throw new Error(`模型服务返回 HTTP ${response.status}`);
    const data = JSON.parse(response.text || 'null') as { data?: Array<{ id: string }> } | null;
    return (data?.data ?? []).map(m => m.id).sort();
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

    const startedAt = Date.now();
    const requestUrl = this.buildUrl('/chat/completions');
    const requestHeaders = this.headers();
    const payloadBody = JSON.stringify({
      model: this.settings.model,
      messages: openaiMessages,
      tools: openaiTools,
      temperature: this.settings.effort === 'fast' ? 0 : 0.2,
      ...(this.settings.thinking === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    });
    const exchange: DebugExchangeInput = {
      stage: 'tools', model: this.settings.model, stream: false, attempt: 1,
      url: requestUrl, headers: requestHeaders, body: payloadBody,
      transport: httpTransport(), ms: 0, responseText: '', content: '', reasoning: '', chunks: [],
    };

    let response: HttpResponse;
    try {
      response = await httpRequest(requestUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: payloadBody,
        signal: options.signal,
        timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      this.commitExchange(exchange, startedAt, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    exchange.status = response.status;

    const payload = (JSON.parse(response.text || 'null') ?? {}) as ChatCompletionResponse;
    debugBus.network({
      kind: 'model', method: 'POST', url: `${this.settings.modelBaseUrl}/chat/completions (tools)`,
      status: response.status, ms: Date.now() - startedAt, bytes: response.text.length, transport: httpTransport(),
    });
    const message = payload.choices?.[0]?.message;
    const usage = parseOpenAIUsage(payload as unknown as Record<string, unknown>);
    this.commitExchange(exchange, startedAt, {
      responseText: response.text,
      content: message?.content ?? JSON.stringify(message?.tool_calls ?? []),
      finishReason: payload.choices?.[0]?.finish_reason ?? undefined,
      usage: { input: usage.inputTokens, output: usage.outputTokens },
      error: response.status < 200 || response.status >= 300 || payload.error
        ? payload.error?.message ?? `模型服务返回 HTTP ${response.status}`
        : undefined,
    });
    if (response.status < 200 || response.status >= 300 || payload.error) {
      debugBus.prompt({
        stage: 'tools', model: this.settings.model, system, messages,
        tools: tools.map((tool) => tool.name),
        error: payload.error?.message ?? `模型服务返回 HTTP ${response.status}`,
      });
      throw new Error(payload.error?.message ?? `模型服务返回 HTTP ${response.status}`);
    }
    debugBus.prompt({
      stage: 'tools', model: this.settings.model, system, messages,
      tools: tools.map((tool) => tool.name),
      response: JSON.stringify(message ?? {}).slice(0, 4000),
    });

    if (message?.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_calls',
        calls: message.tool_calls.map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            // Model returned invalid JSON in arguments; use empty args
          }
          return { id: tc.id, name: tc.function.name, arguments: args };
        }),
      };
    }

    return { type: 'text', content: message?.content ?? '' };
  }
}
