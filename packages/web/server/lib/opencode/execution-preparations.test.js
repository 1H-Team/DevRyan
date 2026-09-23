import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { changeKey } from '@openchamber/harness-runtime/lib/session-changes-store.js';
import { withCrossProcessFileLock } from '@openchamber/harness-runtime/lib/atomic-file.js';
import { test, expect } from 'vitest';
import { createExecutionPreparations, recoverExecutionLeases } from './execution-preparations.js';
import { executionSignal, withExecutionAdmission } from '@openchamber/harness-runtime/lib/execution-admission.js';

test('authenticated polling remains available while reconciliation owns the ledger', async () => {
  let complete, launches = 0;
  const owner = { id: 'owner', signal: new AbortController().signal, assert() {} };
  const scope = { sessionID: 'ses_parent', messageID: 'msg_tool', userMessageID: 'msg_user', callID: 'call_one' };
  const lease = { token: 'poll-token', directory: '/fixture', scope, ownerID: owner.id,
    executionFingerprint: 'a'.repeat(64), state: 'preparing' };
  const runtime = { prepare: () => new Promise(resolve => { complete = resolve; }),
    cancelLease: async () => {}, cleanupLease: async () => true,
    leaseForCall: () => { throw new Error('Polling must not acquire the mutation ledger'); } };
  const jobs = createExecutionPreparations({ runtime, owner, pollMs: 1 });
  const input = { ...scope, token: lease.token, directory: lease.directory, tool: 'grep',
    argsDigest: lease.executionFingerprint, kind: 'process' };
  jobs.start(lease, input);
  try {
    for (const field of ['sessionID', 'messageID', 'callID', 'token', 'directory', 'tool', 'argsDigest', 'kind']) {
      await expect(jobs.pollAuthenticated({ ...input, [field]: 'wrong' })).rejects.toThrow();
    }
    for (let i = 0; i < 3; i++) {
      expect((await withExecutionAdmission(input, () => jobs.pollAuthenticated(input), { timeoutMs: 50 })).state).toBe('preparing');
    }
    complete({ ...lease, state: 'ready' });
    await jobs.poll(lease);
    expect((await jobs.pollAuthenticated(input)).state).toBe('ready');
    await jobs.claim(lease, async () => { launches++; });
    await expect(jobs.pollAuthenticated(input)).rejects.toThrow();
    expect(launches).toBe(1);
  } finally { complete(lease); await jobs.drain(); }
});

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


test('two sibling preparations remain pollable across a real held mutation lock and each claims once', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-poll-lock-')));
  const directory = path.join(root, 'project'), storage = path.join(root, 'ledger');
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'input.txt'), 'fixture');
  const runtime = createSessionMutationRuntime({ directory: storage });
  const owner = { id: 'fixture-owner', signal: new AbortController().signal, assert() {} };
  const jobs = createExecutionPreparations({ runtime, owner, pollMs: 1 });
  const inputs = [1, 2].map(n => ({ directory, sessionID: `session${n}`, userMessageID: `user${n}`,
    messageID: `assistant${n}`, callID: `call${n}`, tool: 'grep', kind: 'process', argsDigest: 'a'.repeat(64) }));
  const leases = [];
  let release;
  let held;
  try {
    for (const input of inputs) leases.push(await runtime.reserve({ ...input, ownerID: owner.id, executionFingerprint: input.argsDigest }));
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    held = withCrossProcessFileLock(path.join(storage, changeKey(directory), 'owner.lock'), async () => {
      acquired(); await new Promise(resolve => { release = resolve; });
    });
    await ready;
    leases.forEach((lease, i) => jobs.start(lease, inputs[i]));
    for (let round = 0; round < 3; round++) {
      const polls = await Promise.all(leases.map((lease, i) => withExecutionAdmission(inputs[i],
        () => jobs.pollAuthenticated({ ...inputs[i], token: lease.token }), { timeoutMs: 50 })));
      expect(polls.map(poll => poll.state)).toEqual(['preparing', 'preparing']);
      // Preparation outlives several request deadlines while the ledger is held.
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    release(); await held;
    for (let i = 0; i < leases.length; i++) {
      let result;
      const deadline = Date.now() + 10_000;
      do { result = await jobs.poll(leases[i]); } while (result.state === 'preparing' && Date.now() < deadline);
      expect(result.state).toBe('ready');
      await jobs.claim(leases[i], () => runtime.claimLease({ directory, token: leases[i].token, kind: 'process' }));
      await expect(jobs.claim(leases[i], () => { throw new Error('duplicate launch'); })).rejects.toThrow('execution_not_ready');
      await runtime.cancelUnstartedCall({ ...inputs[i], token: leases[i].token });
      await runtime.cleanupLease(leases[i]);
    }
  } finally {
    release?.(); await held; await jobs.drain(); await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

test('a transient cancellation failure stays retryable instead of pinning the job', async () => {
  let cancels = 0;
  const owner = { signal: new AbortController().signal, assert() {} };
  const lease = { token: 'retry-cancel', directory: '/fixture', scope: {}, state: 'preparing' };
  const runtime = { prepare: async () => ({ ...lease, state: 'ready' }), cleanupLease: async () => true,
    cancelLease: async () => { if (++cancels === 1) throw Object.assign(new Error('ledger busy'), { code: 'LOCK_TIMEOUT' }); } };
  const jobs = createExecutionPreparations({ runtime, owner, pollMs: 1 });
  jobs.start(lease);
  await jobs.poll(lease);
  await expect(jobs.cancel(lease)).rejects.toThrow('ledger busy');
  await expect(jobs.cancel(lease)).resolves.toBeUndefined();
  expect(cancels).toBe(2);
  await expect(jobs.poll(lease)).rejects.toMatchObject({ code: 'execution_owner_unavailable' });
});
