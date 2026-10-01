import { beforeEach, describe, expect, it } from 'vitest';
import { loadSettings } from '../../src/core/settings';

describe('mcp settings migration', () => {
  beforeEach(() => localStorage.clear());

  it('migrates the legacy single serverUrl into a server list', async () => {
    localStorage.setItem('review-agent-settings-v1', JSON.stringify({
      mcp: { enabled: true, serverUrl: 'http://127.0.0.1:3000/mcp' },
    }));
    const settings = await loadSettings();
    expect(settings.mcp.enabled).toBe(true);
    expect(settings.mcp.servers).toEqual([
      { id: 'mcp-1', name: 'MCP 1', url: 'http://127.0.0.1:3000/mcp', enabled: true },
    ]);
  });

  it('keeps an existing server list untouched', async () => {
    localStorage.setItem('review-agent-settings-v1', JSON.stringify({
      mcp: { enabled: false, servers: [{ id: 'x', name: 'X', url: 'http://x/mcp', enabled: false }] },
    }));
    const settings = await loadSettings();
    expect(settings.mcp.servers).toEqual([{ id: 'x', name: 'X', url: 'http://x/mcp', enabled: false }]);
  });
});
