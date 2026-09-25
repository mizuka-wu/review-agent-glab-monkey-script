import type { AgentMessage, ModelRuntime, ToolCallResponse } from './model-runtime';
import type { GitLabToolExecutor, ToolCall, ToolDefinition, ToolResult } from './agent-tools';
import { GITLAB_TOOLS, MAX_TOOL_ITERATIONS } from './agent-tools';

export interface AgentLoopEvent {
  type: 'tool_call' | 'tool_result' | 'text' | 'error' | 'max_iterations';
  message: string;
  detail?: {
    toolName?: string;
    toolCallId?: string;
    content?: string;
    isError?: boolean;
    iteration?: number;
  };
}

export interface AgentLoopResult {
  text: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  events: AgentLoopEvent[];
  iterations: number;
}

const TOOL_SYSTEM_PROMPT = `你是 GitLab 代码评审助手。你可以调用工具来获取仓库中更多上下文信息，以做出更准确的评审。

可用工具：
- file_read: 读取仓库中指定文件的完整内容
- search_code: 在仓库中搜索代码关键词
- git_log: 查看文件的提交历史

使用工具后，根据返回的信息给出最终回答。不要重复调用相同的工具。回答使用简体中文。`;

export async function runAgentLoop(
  runtime: ModelRuntime,
  executor: GitLabToolExecutor,
  initialMessages: AgentMessage[],
  options: {
    signal?: AbortSignal;
    onEvent?: (event: AgentLoopEvent) => void;
    maxIterations?: number;
  } = {},
): Promise<AgentLoopResult> {
  const tools: ToolDefinition[] = GITLAB_TOOLS;
  const maxIterations = options.maxIterations ?? MAX_TOOL_ITERATIONS;
  const messages: AgentMessage[] = [...initialMessages];
  const allToolCalls: ToolCall[] = [];
  const allToolResults: ToolResult[] = [];
  const events: AgentLoopEvent[] = [];
  let iterations = 0;

  const emit = (event: AgentLoopEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };

  while (iterations < maxIterations) {
    iterations += 1;

    let response: ToolCallResponse;
    try {
      response = await runtime.callWithTools(messages, tools, TOOL_SYSTEM_PROMPT, { signal: options.signal });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      emit({ type: 'error', message: `模型调用失败: ${error instanceof Error ? error.message : String(error)}` });
      break;
    }

    if (response.type === 'text') {
      emit({ type: 'text', message: '模型返回最终回答', detail: { iteration: iterations } });
      return {
        text: response.content,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        events,
        iterations,
      };
    }

    // Tool calls requested
    const calls = response.calls;
    allToolCalls.push(...calls);

    for (const call of calls) {
      emit({
        type: 'tool_call',
        message: `调用工具 ${call.name}`,
        detail: { toolName: call.name, toolCallId: call.id, iteration: iterations },
      });

      const result = await executor.execute(call);
      allToolResults.push(result);

      emit({
        type: 'tool_result',
        message: result.isError ? `工具 ${call.name} 执行失败` : `工具 ${call.name} 返回结果`,
        detail: {
          toolName: call.name,
          toolCallId: call.id,
          content: result.content.slice(0, 200),
          isError: result.isError,
          iteration: iterations,
        },
      });

      // Append tool result to messages
      messages.push({
        role: 'tool',
        content: result.content,
        toolCallId: result.toolCallId,
        toolName: result.name,
      });
    }

    // If we've done all iterations but still have tool calls, stop
    if (iterations >= maxIterations) {
      emit({ type: 'max_iterations', message: `已达最大工具调用轮数 (${maxIterations})` });
      return {
        text: `已在 ${maxIterations} 轮工具调用后停止。以下是工具获取的上下文信息，供你参考。`,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        events,
        iterations,
      };
    }
  }

  return {
    text: 'Agent 未能生成最终回答。',
    toolCalls: allToolCalls,
    toolResults: allToolResults,
    events,
    iterations,
  };
}
