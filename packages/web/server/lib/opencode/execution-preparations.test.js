import { test, expect } from 'vitest';
import { createExecutionPreparations, recoverExecutionLeases } from './execution-preparations.js';
import { executionSignal, withExecutionAdmission } from '@openchamber/harness-runtime/lib/execution-admission.js';

test('preparation is started once and polling never replays it', async () => {
  let complete, calls = 0;
  const owner = { signal: new AbortController().signal, assert() {} };
  const lease = { token: 'one', directory: '/fixture', scope: {}, state: 'preparing' };
  const runtime = { prepare: () => { calls++; return new Promise((resolve) => { complete = resolve; }); }, cleanupLease: async () => true, cancelLease: async () => {} };
  const jobs = createExecutionPreparations({ runtime, owner, pollMs: 1 });
  try {
    jobs.start(lease); jobs.start(lease);
    expect((await jobs.poll(lease)).state).toBe('preparing');
    complete({ ...lease, state: 'ready' });
    expect((await jobs.poll(lease)).state).toBe('ready');
    expect(calls).toBe(1);
  } finally { jobs.forget(lease.token); await jobs.drain(); }
});

test('cancellation waits for owned I/O even after its signal aborts', async () => {
  let complete, signal;
  const lease = { token: 'one', directory: '/fixture', scope: {} };
  const runtime = { prepare: () => { signal = executionSignal(); return new Promise((resolve) => { complete = resolve; }); }, cleanupLease: async () => true, cancelLease: async () => {} };
  const jobs = createExecutionPreparations({ runtime, owner: { signal: new AbortController().signal, assert() {} } });
  jobs.start(lease);
  let settled = false;
  const cancellation = jobs.cancel(lease).then(() => { settled = true; });
  await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(settled).toBe(false);
  complete(lease);
  await cancellation;
  expect(settled).toBe(true);
});

test('a lost authenticated poller cancels preparation without launching a writer', async () => {
  let complete, signal, cancelled = 0;
  const lease = { token: 'one', directory: '/fixture', scope: {} };
  const runtime = { prepare: () => { signal = executionSignal(); return new Promise((resolve) => { complete = resolve; }); },
    cleanupLease: async () => true, cancelLease: async () => { cancelled++; } };
  const jobs = createExecutionPreparations({ runtime, owner: { signal: new AbortController().signal, assert() {} }, ownerTimeoutMs: 10 });
  jobs.start(lease);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(signal.aborted).toBe(true);
  complete(lease);
  await jobs.drain();
  expect(cancelled).toBeGreaterThan(0);
});

test('lost ready poller cleans after settlement and cannot race an accepted claim', async () => {
  for (const claimed of [false, true]) {
    let cancelled = 0, cleaned = 0;
    const lease = { token: 'ready', directory: '/fixture', scope: {} };
    const runtime = { prepare: async () => lease, cancelLease: async () => { cancelled++; }, cleanupLease: async () => { cleaned++; return true; } };
    const jobs = createExecutionPreparations({ runtime, owner: { signal: new AbortController().signal, assert() {} }, ownerTimeoutMs: 15 });
    jobs.start(lease); await jobs.poll(lease);
    if (claimed) await jobs.claim(lease, async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    else await new Promise(resolve => setTimeout(resolve, 45));
    await jobs.drain();
    expect(cancelled).toBe(claimed ? 0 : 1); expect(cleaned).toBe(claimed ? 0 : 1);
  }
});

test('an uncertain lease cannot block unrelated recovery or cleanup', async () => {
  const cancelled = [], cleaned = [], failures = [];
  const unknown = { token: 'uncertain', ownerID: 'dead', directory: '/fixture', viewDirectory: '/missing-fixture/view', executionKind: 'process' };
  const safe = { token: 'safe', ownerID: 'dead', directory: '/fixture' };
  const pending = [{ token: 'failed-cleanup', ownerID: 'dead' }, safe, { token: 'live', ownerID: 'alive' }];
  const runtime = { activeLeases: async () => [unknown, safe], pendingCleanup: async () => pending,
    cancelLease: async (lease) => { cancelled.push(lease.token); },
    cleanupLease: async (lease) => { if (lease.token === 'failed-cleanup') throw new Error('fixture'); cleaned.push(lease.token); return true; } };
  await recoverExecutionLeases({ runtime, directory: '/fixture', ownerLost: async (lease) => lease.ownerID === 'dead', onFailure: (error) => failures.push(error) });
  expect(cancelled).toEqual(['safe']); expect(cleaned).toEqual(['safe']); expect(failures).toHaveLength(2);
});


test('slow identity and lease lookup consume the poll budget without cancelling preparation', async () => {
  let complete, launches = 0, cancelled = 0;
  const lease = { token: 'budget', directory: '/fixture', scope: {} };
  const owner = { signal: new AbortController().signal, assert() {} };
  const runtime = { prepare: () => new Promise(resolve => { complete = resolve; }),
    cleanupLease: async () => true, cancelLease: async () => { cancelled++; } };
  const jobs = createExecutionPreparations({ runtime, owner });
  const diagnostics = [];
  jobs.start(lease);
  try {
    for (let i = 0; i < 2; i++) {
      const result = await withExecutionAdmission({}, async () => {
        // Scaled-down request budget leaves less than the response headroom.
        await new Promise(resolve => setTimeout(resolve, 120));
        return jobs.poll(lease);
      }, { timeoutMs: 1100, onDiagnostic: event => diagnostics.push(event) });
      expect(result.state).toBe('preparing');
    }
    expect(cancelled).toBe(0);
    complete(lease);
    expect((await jobs.poll(lease)).state).toBe('ready');
    await jobs.claim(lease, async () => { launches++; });
    await expect(jobs.claim(lease, async () => { launches++; })).rejects.toMatchObject({ code: 'execution_not_ready' });
    expect(launches).toBe(1);
    expect(diagnostics.filter(event => event.phase === 'poll_wait' && event.state === 'completed')).toHaveLength(2);
  } finally { complete(lease); await jobs.drain(); }
});

test('cleanup failure preserves the original preparation failure', async () => {
  const lease = { token: 'failed', directory: '/fixture', scope: {} };
  const diagnostics = [];
  const runtime = {
    prepare: async () => { throw Object.assign(new Error('stalled'), { code: 'execution_preparation_stalled' }); },
    cancelLease: async () => { throw new Error('cleanup failed'); }, cleanupLease: async () => true,
  };
  const jobs = createExecutionPreparations({ runtime, owner: { signal: new AbortController().signal, assert() {} },
    onDiagnostic: event => diagnostics.push(event) });
  try {
    jobs.start(lease);
    expect((await jobs.poll(lease)).error.code).toBe('execution_preparation_stalled');
    expect(diagnostics.some(event => event.phase === 'cleanup' && event.state === 'failed')).toBe(true);
  } finally { jobs.forget(lease.token); await jobs.drain(); }
});
