import { describe, expect, it, vi } from 'vitest';
import { debugBus } from '../../src/core/debug-bus';

describe('debugBus', () => {
  it('records logs and notifies subscribers', () => {
    debugBus.clear();
    const listener = vi.fn();
    const unsubscribe = debugBus.subscribe(listener);
    debugBus.log('info', 'test', 'hello', 'detail');
    expect(listener).toHaveBeenCalled();
    expect(debugBus.getLogs()[0]).toMatchObject({ level: 'info', source: 'test', message: 'hello', detail: 'detail' });
    unsubscribe();
  });

  it('records network and prompt entries with caps applied lazily', () => {
    debugBus.clear();
    debugBus.network({ kind: 'gitlab', method: 'GET', url: '/api/v4/x', status: 200, ms: 12 });
    debugBus.network({ kind: 'model', method: 'POST', url: 'https://m/v1/chat/completions', status: 500, ms: 90, error: 'boom' });
    expect(debugBus.getNetwork()).toHaveLength(2);

    debugBus.prompt({
      stage: 'review', model: 'm', system: 'sys',
      messages: [{ role: 'user', content: 'x'.repeat(20000) }],
      response: 'ok',
    });
    const [entry] = debugBus.getPrompts();
    expect(entry.messages[0].characters).toBe(20000);
    expect(entry.messages[0].truncated).toBe(true);
    expect(entry.messages[0].content.length).toBeLessThan(9000);
  });

  it('merges snapshots from providers and isolates throwing providers', () => {
    debugBus.clear();
    const off1 = debugBus.registerSnapshot(() => ({ a: 1 }));
    const off2 = debugBus.registerSnapshot(() => { throw new Error('bad provider'); });
    const snapshot = debugBus.snapshot();
    expect(snapshot.a).toBe(1);
    expect(String(snapshot.snapshotError)).toContain('bad provider');
    off1();
    off2();
  });

  it('exports a bundle and clears scopes independently', () => {
    debugBus.clear();
    debugBus.log('warn', 'test', 'keep me');
    debugBus.network({ kind: 'repo', method: 'GET', url: '/tree', status: 200, ms: 1 });
    const bundle = JSON.parse(debugBus.exportBundle()) as { logs: unknown[]; network: unknown[]; snapshot: unknown };
    expect(bundle.logs).toHaveLength(1);
    expect(bundle.network).toHaveLength(1);
    expect(bundle.snapshot).toBeDefined();

    debugBus.clear('network');
    expect(debugBus.getNetwork()).toHaveLength(0);
    expect(debugBus.getLogs()).toHaveLength(1);
    debugBus.clear();
    expect(debugBus.getLogs()).toHaveLength(0);
  });
});
