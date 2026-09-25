import { diffContext } from './diff';
import type {
  ChatMessage,
  CodeSelection,
  FileDiff,
  RuntimeSettings,
} from './types';

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
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
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
    };
  }

  async complete(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    options: { json?: boolean; signal?: AbortSignal } = {},
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(endpoint(this.settings.modelBaseUrl, '/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.settings.model,
          messages,
          temperature: this.settings.effort === 'fast' ? 0 : 0.2,
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: options.signal,
      });

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
      return content;
    }
    throw new Error('模型服务重试次数已用尽');
  }

  async chat(
    messages: ChatMessage[],
    selection: CodeSelection | undefined,
    signal?: AbortSignal,
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
      { signal },
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
}
