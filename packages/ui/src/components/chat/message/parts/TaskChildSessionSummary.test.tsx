import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { withDom } from '@/test/mountedDom';
let records: unknown[] = [];
let phase = 'busy';
const reads: Array<{ sessionID: string; limit: number; $query_toolOutput?: string }> = [];
mock.module('@/sync/sync-context', () => ({ useSessionMessageRecords: () => records, useEnsureSessionMessages: () => {} }));
mock.module('@/hooks/useSessionActivity', () => ({ useSessionActivity: () => ({ phase }) }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getScopedSdkClient: () => ({ session: { messages: async (query: typeof reads[number]) => { reads.push(query); return { data: [] }; } } }) } }));
mock.module('@/sync/sync-refs', () => ({ getSyncChildStores: () => ({ update: () => {} }) }));
mock.module('./TaskToolSummary', () => ({ TaskToolSummary: () => <span>child activity</span> }));
const { TaskChildSessionSummary } = await import('./TaskChildSessionSummary');

test('opened child uses SSE first, a bounded silence repair, one settlement read and cancels on close', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let nextID = 1;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    if (delay !== 20_000 && delay !== 2500) return originalSet(callback, delay);
    const id = nextID++; timers.set(id, callback); return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => { if (!timers.delete(Number(id))) originalClear(id); }) as typeof clearTimeout;
  const render = () => root.render(<TaskChildSessionSummary taskSessionId="child" currentDirectory="/fixture" isTaskActive isFinalized={false} activeLatched metadataEntries={[]} isMobile={false} isExpanded />);
  const tick = async () => act(async () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); });
  try {
    await act(async () => { render(); });
    expect(reads).toHaveLength(0);
    for (let i = 0; i < 20; i++) { records = []; await act(async () => { render(); }); }
    expect(reads).toHaveLength(0);
    expect(timers.size).toBe(1);
    await tick();
    expect(reads).toEqual([{ sessionID: 'child', limit: 30, $query_toolOutput: 'omit' }]);
    phase = 'idle'; await act(async () => { render(); }); await tick();
    expect(reads).toHaveLength(2);
    expect(timers.size).toBe(0);
    await act(async () => { root.unmount(); });
    expect(timers.size).toBe(0);
  } finally {
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
    await act(async () => { root.unmount(); });
  }
}));
