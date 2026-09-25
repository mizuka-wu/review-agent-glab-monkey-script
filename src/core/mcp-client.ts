/**
 * MCP Client for Streamable HTTP transport only.
 *
 * Browser userscripts cannot spawn local processes (stdio transport),
 * so this client only supports HTTP-based MCP servers:
 *   - Streamable HTTP (MCP 2025-03-26+): POST to a single endpoint
 *   - HTTP+SSE (MCP 2024-11-05): POST to /message endpoint
 *
 * Configure the server URL to the MCP HTTP endpoint, e.g.:
 *   - http://127.0.0.1:3000/mcp  (Streamable HTTP)
 *   - http://127.0.0.1:3000/sse  (HTTP+SSE, message endpoint derived)
 */

// --- MCP JSON-RPC types ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

interface McpToolCallResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

// --- Transport (HTTP only) ---

type McpTransport = 'streamable-http' | 'sse';

/**
 * Auto-detect transport type from URL:
 * - URLs ending in /sse or /messages → SSE transport
 * - All other URLs → Streamable HTTP transport
 */
function detectTransport(url: string): McpTransport {
  return /\/(sse|messages?)(\?|$)/i.test(url) ? 'sse' : 'streamable-http';
}

function resolveEndpoint(url: string, transport: McpTransport): string {
  if (transport === 'sse') {
    // For SSE transport, the message endpoint is typically derived from the SSE endpoint
    // Streamable HTTP: just POST to the URL as-is
    return url.replace(/\/sse\/?$/i, '/messages');
  }
  return url;
}

function gmRequest(url: string, method: string, body: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const gm = (globalThis as typeof globalThis & {
      GM?: { xmlHttpRequest?: (details: Record<string, unknown>) => void };
    }).GM;

    if (gm?.xmlHttpRequest) {
      gm.xmlHttpRequest({
        method,
        url,
        data: body,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        onload: (response: { status: number; responseText: string }) => {
          resolve({ status: response.status, text: response.responseText });
        },
        onerror: () => reject(new Error('MCP 请求失败，请确认 MCP server 已启动且地址正确')),
        ontimeout: () => reject(new Error('MCP 请求超时')),
        ...(signal ? { signal } : {}),
      });
    } else {
      // Fallback to fetch (works when CORS allows it, e.g. localhost dev server)
      fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body,
        signal,
      })
        .then(async (response) => resolve({ status: response.status, text: await response.text() }))
        .catch((error) => reject(new Error(`MCP 请求失败: ${error instanceof Error ? error.message : String(error)}`)));
    }
  });
}

// --- MCP Client ---

export interface McpServerConfig {
  url: string;
  enabled: boolean;
}

export class McpClient {
  private idCounter = 0;
  private tools: ToolDefinition[] = [];
  private initialized = false;
  private readonly transport: McpTransport;
  private readonly endpoint: string;

  constructor(private readonly config: McpServerConfig) {
    this.transport = detectTransport(config.url);
    this.endpoint = resolveEndpoint(config.url, this.transport);
  }

  get connected() {
    return this.initialized;
  }

  get transportType(): string {
    return this.transport;
  }

  get availableTools(): ToolDefinition[] {
    return this.tools;
  }

  private async rpc(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.idCounter,
      method,
      params,
    };

    const { status, text } = await gmRequest(
      this.endpoint,
      'POST',
      JSON.stringify(request),
      signal,
    );

    if (status !== 200) {
      throw new Error(`MCP server 返回 HTTP ${status}`);
    }

    // Handle SSE-style response (text/event-stream)
    let responseText = text;
    if (text.includes('data:')) {
      const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
      if (dataLine) responseText = dataLine.slice(5).trim();
    }

    const response = JSON.parse(responseText) as JsonRpcResponse;
    if (response.error) {
      throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
    }

    return response.result ?? {};
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'review-agent-glab', version: '0.1.0' },
    }, signal);

    // After initialize, send initialized notification
    const notification = {
      jsonrpc: '2.0' as const,
      method: 'notifications/initialized',
      params: {},
    };
    await gmRequest(this.endpoint, 'POST', JSON.stringify(notification), signal).catch(() => {});

    // List tools
    await this.listTools(signal);
  }

  async listTools(signal?: AbortSignal): Promise<ToolDefinition[]> {
    const result = await this.rpc('tools/list', undefined, signal);
    const tools = (result.tools as McpToolSchema[]) ?? [];
    this.tools = tools.map((tool) => ({
      name: `mcp_${tool.name}`,
      description: `[MCP] ${tool.description ?? tool.name}`,
      parameters: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(tool.inputSchema?.properties ?? {}).map(([key, value]) => [
            key,
            {
              type: (value.type as ToolParameter['type']) ?? 'string',
              description: value.description ?? '',
              enum: value.enum,
            } satisfies ToolParameter,
          ]),
        ),
        required: tool.inputSchema?.required ?? [],
      },
    }));
    this.initialized = true;
    return this.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    // Strip the mcp_ prefix
    const mcpToolName = toolName.replace(/^mcp_/, '');

    const result = await this.rpc('tools/call', {
      name: mcpToolName,
      arguments: args,
    }, signal) as McpToolCallResult;

    const content = (result.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n');

    return {
      toolCallId: `mcp-${Date.now()}`,
      name: toolName,
      content: content || '(no output)',
      isError: result.isError ?? false,
    };
  }
}
