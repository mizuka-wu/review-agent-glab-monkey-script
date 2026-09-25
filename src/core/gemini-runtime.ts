import { diffContext } from './diff';
import type {
  ChatMessage,
  CodeSelection,
  FileDiff,
  RuntimeSettings,
} from './types';

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role?: string;
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: { content?: GeminiContent }[];
  error?: { message?: string; code?: number };
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

export class GeminiRuntime {
  constructor(private readonly settings: RuntimeSettings) {}

  get configured() {
    return Boolean(
      this.settings.modelBaseUrl &&
        this.settings.model &&
        this.settings.apiKey,
    );
  }

  private endpoint(action: string) {
    const base = this.settings.modelBaseUrl.replace(/\/$/, '');
    return `${base}/v1beta/models/${this.settings.model}:${action}?key=${this.settings.apiKey}`;
  }

  async complete(
    messages: GeminiContent[],
    system: string,
    options: { json?: boolean; signal?: AbortSignal } = {},
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body: Record<string, unknown> = {
        contents: messages,
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: {
          temperature: this.settings.effort === 'fast' ? 0 : 0.2,
          ...(options.json ? { responseMimeType: 'application/json' } : {}),
        },
      };

      const response = await fetch(this.endpoint('generateContent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as GeminiResponse;
      if (!response.ok || payload.error) {
        const message = payload.error?.message ?? `Gemini API 返回 HTTP ${response.status}`;
        if (attempt < 2 && shouldRetry(response.status)) {
          await wait(250 * 2 ** attempt, options.signal);
          continue;
        }
        throw new Error(message);
      }

      const content = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .join('');
      if (!content) throw new Error('Gemini API 没有返回文本内容');
      return content;
    }
    throw new Error('Gemini API 重试次数已用尽');
  }

  async chat(
    messages: ChatMessage[],
    selection: CodeSelection | undefined,
    signal?: AbortSignal,
  ) {
    const history = messages
      .filter((message) => message.role !== 'system' && !message.error)
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.attachment
          ? `${message.content}\n\n${selectionContext(message.attachment)}`
          : message.content,
        }],
      })) as GeminiContent[];

    const contextMessages: GeminiContent[] = [
      ...(selection && !messages.some((message) => message.attachment)
        ? [{ role: 'user', parts: [{ text: selectionContext(selection) }] }]
        : []),
      ...history,
    ];

    return this.complete(
      contextMessages,
      '你是 GitLab 代码评审助手。只基于给出的代码回答，明确区分已确认事实和推断。回答使用简体中文，避免编译造文件内容。',
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

    const system =
      `你是代码评审引擎。输出严格 JSON：{"findings":[{"path","line","endLine","side","category","severity","confidence","title","content","evidence":[{"path","lines","quote"}],"existingCode","suggestionCode","comment"}]}。category 只能是 bug/security/performance/maintainability/test；severity 只能是 critical/high/medium/low；confidence 只能是 high/medium/low。existingCode 必须是目标文件中的连续原文；跨文件证据使用 evidence.path。主 Finding 应优先锚定 Diff 行，完整文件只能作为上下文或证据，不能单独作为可发布位置。${strictness}${language === 'en-US' ? ' Write findings in English.' : ' 所有字段使用简体中文。'}`;

    return this.complete(
      [{ role: 'user', parts: [{ text: context }] }],
      system,
      { json: true, signal },
    );
  }

  async testConnection(signal?: AbortSignal) {
    const response = await fetch(this.endpoint('generateContent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Gemini API 返回 HTTP ${response.status}`);
    return true;
  }
}
