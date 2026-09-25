import type { GitLabAdapter } from './gitlab-adapter';
import type { MergeRequestRef } from './types';

// --- Tool schema types ---

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean';
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

// --- Tool execution result ---

export type ToolExecuteResult = { content: string } | { error: string };

// --- GitLab tool definitions ---

export const FILE_READ_TOOL: ToolDefinition = {
  name: 'file_read',
  description: '读取仓库中指定文件的内容。用于查看 Diff 涉及文件的完整上下文、被引用但未在 Diff 中的文件、或配置文件。返回文件前 500 行。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，如 src/utils/auth.ts' },
    },
    required: ['path'],
  },
};

export const SEARCH_CODE_TOOL: ToolDefinition = {
  name: 'search_code',
  description: '在仓库中搜索代码关键词。用于查找函数定义、变量引用、import 来源或使用模式。返回匹配的代码片段及位置。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词或短语' },
    },
    required: ['query'],
  },
};

export const GIT_LOG_TOOL: ToolDefinition = {
  name: 'git_log',
  description: '查看指定文件的最近提交历史。用于了解变更背景、作者和频率。返回最近 10 条提交。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
  },
};

export const GITLAB_TOOLS: ToolDefinition[] = [
  FILE_READ_TOOL,
  SEARCH_CODE_TOOL,
  GIT_LOG_TOOL,
];

// --- Tool executor ---

export class GitLabToolExecutor {
  constructor(
    private readonly adapter: GitLabAdapter,
    private readonly mrRef: MergeRequestRef,
    private readonly headSha: string,
  ) {}

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    try {
      let result: ToolExecuteResult;
      switch (toolCall.name) {
        case 'file_read':
          result = await this.fileRead(toolCall.arguments);
          break;
        case 'search_code':
          result = await this.searchCode(toolCall.arguments);
          break;
        case 'git_log':
          result = await this.gitLog(toolCall.arguments);
          break;
        default:
          result = { error: `未知工具: ${toolCall.name}` };
      }
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: 'error' in result ? result.error : result.content,
        isError: 'error' in result,
      };
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: `工具执行失败: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  private async fileRead(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const path = String(args.path ?? '');
    if (!path) return { error: '缺少 path 参数' };
    const content = await this.adapter.getFile(path, this.headSha);
    const lines = content.split('\n');
    const truncated = lines.length > 500
      ? [...lines.slice(0, 500), `... (${lines.length - 500} more lines)`]
      : lines;
    return { content: `文件: ${path} (ref: ${this.headSha.slice(0, 8)})\n${truncated.join('\n')}` };
  }

  private async searchCode(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const query = String(args.query ?? '');
    if (!query) return { error: '缺少 query 参数' };
    const results = await this.adapter.searchCode(query, this.headSha);
    if (results.length === 0) return { content: `未找到匹配 "${query}" 的代码。` };
    const formatted = results.slice(0, 10).map(
      (item) => `${item.path}:${item.line}\n${item.snippet}`,
    ).join('\n---\n');
    return { content: `搜索 "${query}" 的结果 (${results.length} 条，显示前 10 条):\n${formatted}` };
  }

  private async gitLog(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const path = String(args.path ?? '');
    if (!path) return { error: '缺少 path 参数' };
    const commits = await this.adapter.getGitLog(path, this.headSha);
    if (commits.length === 0) return { content: `文件 ${path} 没有提交历史。` };
    const formatted = commits.map(
      (commit) => `${commit.sha} ${commit.date.slice(0, 10)} ${commit.author}: ${commit.message}`,
    ).join('\n');
    return { content: `${path} 的最近提交:\n${formatted}` };
  }
}

// --- Max iterations guard ---

export const MAX_TOOL_ITERATIONS = 5;
