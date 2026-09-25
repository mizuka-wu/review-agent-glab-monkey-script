import { describe, expect, it, vi } from 'vitest';
import { CompositeToolExecutor, GitLabToolExecutor, GITLAB_TOOLS, MAX_TOOL_ITERATIONS } from '../../src/core/agent-tools';
import { runAgentLoop, type AgentLoopEvent } from '../../src/core/agent-loop';
import type { AgentMessage, ModelRuntime, ToolCallResponse } from '../../src/core/model-runtime';

function makeRuntime(responses: ToolCallResponse[]): ModelRuntime {
  let callCount = 0;
  return {
    configured: true,
    chat: vi.fn(),
    review: vi.fn(),
    testConnection: vi.fn(),
    callWithTools: vi.fn(async () => {
      const response = responses[callCount];
      callCount += 1;
      return response;
    }),
  };
}

function makeExecutor() {
  const mockExecute = vi.fn(async (call: { id: string; name: string }) => ({
    toolCallId: call.id,
    name: call.name,
    content: `result of ${call.name}`,
    isError: false,
  }));
  const mockGitlab = { execute: mockExecute } as unknown as GitLabToolExecutor;
  const executor = new CompositeToolExecutor(mockGitlab);
  return { executor, mockExecute };
}

const initialMessages: AgentMessage[] = [
  { role: 'user', content: 'review this code' },
];

describe('agent-tools', () => {
  it('defines three GitLab tools', () => {
    expect(GITLAB_TOOLS).toHaveLength(3);
    expect(GITLAB_TOOLS.map((t) => t.name)).toContain('file_read');
    expect(GITLAB_TOOLS.map((t) => t.name)).toContain('search_code');
    expect(GITLAB_TOOLS.map((t) => t.name)).toContain('git_log');
  });

  it('has valid schema for each tool', () => {
    for (const tool of GITLAB_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.required.length).toBeGreaterThan(0);
    }
  });

  it('MAX_TOOL_ITERATIONS is positive', () => {
    expect(MAX_TOOL_ITERATIONS).toBeGreaterThan(0);
    expect(MAX_TOOL_ITERATIONS).toBeLessThanOrEqual(10);
  });
});

describe('runAgentLoop', () => {
  it('returns text immediately when model does not call tools', async () => {
    const runtime = makeRuntime([{ type: 'text', content: 'final answer' }]);
    const { executor } = makeExecutor();

    const result = await runAgentLoop(runtime, executor, initialMessages);
    expect(result.text).toBe('final answer');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.iterations).toBe(1);
  });

  it('executes tool calls and continues the loop', async () => {
    const runtime = makeRuntime([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc1', name: 'file_read', arguments: { path: 'src/app.ts' } }],
      },
      { type: 'text', content: 'answer after tool' },
    ]);
    const { executor, mockExecute } = makeExecutor();

    const result = await runAgentLoop(runtime, executor, initialMessages);
    expect(result.text).toBe('answer after tool');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolResults).toHaveLength(1);
    expect(result.iterations).toBe(2);
    expect(mockExecute).toHaveBeenCalledWith({
      id: 'tc1',
      name: 'file_read',
      arguments: { path: 'src/app.ts' },
    });
  });

  it('handles multiple tool calls in one iteration', async () => {
    const runtime = makeRuntime([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc1', name: 'file_read', arguments: { path: 'a.ts' } },
          { id: 'tc2', name: 'search_code', arguments: { query: 'test' } },
        ],
      },
      { type: 'text', content: 'done' },
    ]);
    const { executor } = makeExecutor();

    const result = await runAgentLoop(runtime, executor, initialMessages);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolResults).toHaveLength(2);
    expect(result.iterations).toBe(2);
  });

  it('stops at max iterations', async () => {
    const runtime = makeRuntime(
      Array.from({ length: MAX_TOOL_ITERATIONS + 2 }, (_, i) => ({
        type: 'tool_calls' as const,
        calls: [{ id: `tc${i}`, name: 'file_read', arguments: { path: 'x.ts' } }],
      })),
    );
    const { executor } = makeExecutor();

    const result = await runAgentLoop(runtime, executor, initialMessages);
    expect(result.iterations).toBe(MAX_TOOL_ITERATIONS);
    expect(result.events.some((e) => e.type === 'max_iterations')).toBe(true);
  });

  it('emits events during tool execution', async () => {
    const runtime = makeRuntime([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc1', name: 'file_read', arguments: { path: 'src/app.ts' } }],
      },
      { type: 'text', content: 'ok' },
    ]);
    const { executor } = makeExecutor();
    const collectedEvents: AgentLoopEvent[] = [];

    await runAgentLoop(runtime, executor, initialMessages, {
      onEvent: (event) => collectedEvents.push(event),
    });

    expect(collectedEvents.some((e) => e.type === 'tool_call')).toBe(true);
    expect(collectedEvents.some((e) => e.type === 'tool_result')).toBe(true);
    expect(collectedEvents.some((e) => e.type === 'text')).toBe(true);
  });

  it('handles tool execution errors gracefully', async () => {
    const runtime = makeRuntime([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc1', name: 'file_read', arguments: {} }],
      },
      { type: 'text', content: 'fallback answer' },
    ]);
    const mockGitlab = {
      execute: vi.fn(async (call: { id: string; name: string }) => ({
        toolCallId: call.id,
        name: call.name,
        content: 'error: missing path',
        isError: true,
      })),
    } as unknown as GitLabToolExecutor;
    const executor = new CompositeToolExecutor(mockGitlab);

    const result = await runAgentLoop(runtime, executor, initialMessages);
    expect(result.text).toBe('fallback answer');
    expect(result.toolResults[0].isError).toBe(true);
  });

  it('passes tool results back to the model in conversation', async () => {
    const runtime = makeRuntime([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc1', name: 'search_code', arguments: { query: 'auth' } }],
      },
      { type: 'text', content: 'based on search results...' },
    ]);
    const { executor } = makeExecutor();

    await runAgentLoop(runtime, executor, initialMessages);

    const callArgs = (runtime.callWithTools as ReturnType<typeof vi.fn>).mock.calls[1];
    const messages: AgentMessage[] = callArgs[0];
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toBe('result of search_code');
    expect(toolMessages[0].toolCallId).toBe('tc1');
    expect(toolMessages[0].toolName).toBe('search_code');
  });
});
