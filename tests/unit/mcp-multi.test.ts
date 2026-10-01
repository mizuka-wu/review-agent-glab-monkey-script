import { describe, expect, it } from 'vitest';
import { MultiMcpClient, type McpClient } from '../../src/core/mcp-client';

function stub(id: string, tools: string[]) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    availableTools: tools.map((name) => ({ name, description: `${id} tool`, parameters: {} })),
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { content: `${id}:${name}` };
    },
  };
  return { client: client as unknown as McpClient, calls };
}

describe('MultiMcpClient', () => {
  it('prefixes tool names and routes calls back to the owning server', async () => {
    const a = stub('a', ['search']);
    const b = stub('b', ['search', 'lint']);
    const multi = new MultiMcpClient([
      { id: 'a', client: a.client },
      { id: 'b', client: b.client },
    ]);
    expect(multi.availableTools.map((t) => t.name)).toEqual(['a__search', 'b__search', 'b__lint']);
    expect(multi.availableTools[1].description).toContain('[b]');
    const result = await multi.callTool('b__search', { q: 'x' });
    expect(result).toEqual({ content: 'b:search' });
    expect(b.calls).toEqual([{ name: 'search', args: { q: 'x' } }]);
    expect(a.calls).toEqual([]);
  });

  it('rejects unknown prefixed tools', async () => {
    const a = stub('a', ['search']);
    const multi = new MultiMcpClient([{ id: 'a', client: a.client }]);
    await expect(multi.callTool('nope', {})).rejects.toThrow(/未知 MCP 工具/);
  });
});
