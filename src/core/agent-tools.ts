import type { GitLabAdapter } from './gitlab-adapter';
import type { RepoIndex } from './repo-index';

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

export const SYMBOL_SEARCH_TOOL: ToolDefinition = {
  name: 'symbol_search',
  description: '在本地仓库索引中按符号名搜索定义与引用（函数/方法/类/类型/常量）。比 search_code 精确：只匹配标识符边界，返回定义位置和调用点。索引未建立时该工具不可用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '符号名或部分名称，如 verifyToken' },
    },
    required: ['query'],
  },
};

export const CALL_CHAIN_TOOL: ToolDefinition = {
  name: 'call_chain',
  description: '查看符号的调用链：哪些函数调用了它，调用者又被谁调用（启发式静态分析，默认向上 2 层）。用于评估一处改动的影响面。',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '符号名，如 pay' },
      depth: { type: 'number', description: '向上追溯层数，默认 2，最大 3' },
    },
    required: ['symbol'],
  },
};

export const REPO_TOOLS: ToolDefinition[] = [SYMBOL_SEARCH_TOOL, CALL_CHAIN_TOOL];

export const GITLAB_TOOLS: ToolDefinition[] = [
  FILE_READ_TOOL,
  SEARCH_CODE_TOOL,
  GIT_LOG_TOOL,
];

// --- Tool executor ---

export class GitLabToolExecutor {
  constructor(
    private readonly adapter: GitLabAdapter,
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

// --- Repo index tools (symbol search / call chain) ---

export class RepoIndexToolExecutor {
  constructor(private readonly repoIndex: RepoIndex) {}

  get availableTools(): ToolDefinition[] {
    return this.repoIndex.ready ? REPO_TOOLS : [];
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const result = toolCall.name === 'symbol_search'
        ? this.symbolSearch(toolCall.arguments)
        : toolCall.name === 'call_chain'
          ? this.callChain(toolCall.arguments)
          : { error: `未知工具: ${toolCall.name}` };
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

  private symbolSearch(args: Record<string, unknown>): ToolExecuteResult {
    const query = String(args.query ?? '').trim();
    if (!query) return { error: '缺少 query 参数' };
    if (!this.repoIndex.ready) return { error: '仓库索引尚未建立，请先在「索引」标签页建立索引' };
    const { defs, refs } = this.repoIndex.search(query, 12);
    if (defs.length === 0 && refs.length === 0) return { content: `索引中没有匹配 "${query}" 的符号。` };
    const parts: string[] = [];
    if (defs.length > 0) {
      parts.push('定义：');
      for (const def of defs) {
        parts.push(`- ${def.path}:${def.line} ${def.kind} ${def.name}${def.exported ? ' (exported)' : ''} — ${def.signature}`);
      }
    }
    if (refs.length > 0) {
      parts.push('引用/调用点：');
      for (const ref of refs.slice(0, 24)) {
        parts.push(`- ${ref.path}:${ref.line}${ref.call ? ' 调用' : ' 引用'} — ${ref.text}`);
      }
    }
    return { content: parts.join('\n') };
  }

  private callChain(args: Record<string, unknown>): ToolExecuteResult {
    const symbol = String(args.symbol ?? '').trim();
    if (!symbol) return { error: '缺少 symbol 参数' };
    if (!this.repoIndex.ready) return { error: '仓库索引尚未建立，请先在「索引」标签页建立索引' };
    const depth = Math.min(3, Math.max(1, Number(args.depth ?? 2) || 2));
    const node = this.repoIndex.callChain(symbol, depth);
    if (!node) return { error: '索引不可用' };
    const lines: string[] = [];
    const walk = (current: typeof node, indent: string) => {
      const def = current.def ? `（定义于 ${current.def.path}:${current.def.line}）` : '（索引中无定义，可能来自依赖）';
      lines.push(`${indent}${current.symbol} ${def}`);
      if (current.callers.length === 0) {
        lines.push(`${indent}  └ 没有发现调用点`);
        return;
      }
      for (const caller of current.callers) {
        lines.push(`${indent}  └ ${caller.path}:${caller.line} ← ${caller.symbol} — ${caller.text}`);
      }
      for (const child of current.children) walk(child, `${indent}    `);
    };
    walk(node, '');
    return { content: lines.join('\n') };
  }
}

// --- Max iterations guard ---

export const MAX_TOOL_ITERATIONS = 5;

// --- Composite executor for GitLab + MCP tools ---

export interface ToolExecutorLike {
  availableTools: ToolDefinition[];
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}

export class CompositeToolExecutor {
  private readonly mcpToolNames = new Set<string>();
  private readonly extraExecutors: ToolExecutorLike[];

  constructor(
    private readonly gitlabExecutor: GitLabToolExecutor,
    private readonly mcpExecutor?: { callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>; availableTools: ToolDefinition[] },
    extraExecutors: ToolExecutorLike[] = [],
  ) {
    this.extraExecutors = extraExecutors;
    if (mcpExecutor) {
      for (const tool of mcpExecutor.availableTools) {
        this.mcpToolNames.add(tool.name);
      }
    }
  }

  get availableTools(): ToolDefinition[] {
    const tools = [...GITLAB_TOOLS];
    if (this.mcpExecutor) {
      tools.push(...this.mcpExecutor.availableTools);
    }
    for (const executor of this.extraExecutors) {
      tools.push(...executor.availableTools);
    }
    return tools;
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    for (const executor of this.extraExecutors) {
      if (executor.availableTools.some((tool) => tool.name === toolCall.name)) {
        return executor.execute(toolCall, signal);
      }
    }
    if (this.mcpToolNames.has(toolCall.name) && this.mcpExecutor) {
      return this.mcpExecutor.callTool(toolCall.name, toolCall.arguments, signal);
    }
    return this.gitlabExecutor.execute(toolCall);
  }
}
