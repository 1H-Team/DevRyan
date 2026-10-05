import { afterEach, expect, spyOn, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { withExecutionSummary } from './execution-admission.js';

const roots = [];
const test = (name, body) => bunTest(name, body, 60_000);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-lock-timing-')); roots.push(root);
  const directory = path.join(root, 'project'), storage = path.join(root, 'private');
  await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
  const timings = [], diagnostics = [];
  const runtime = createSessionMutationRuntime({ directory: storage, onLockTiming: (timing) => timings.push(timing),
    onDiagnostic: (record) => diagnostics.push(record) });
  return { runtime, directory, timings, diagnostics };
}
// Holds the owner lock of the first transaction that checks its ledger HEAD.
const holdFirstTransaction = (ms) => {
  const access = fs.access.bind(fs);
  let held = false;
  return spyOn(fs, 'access').mockImplementation(async (file, ...rest) => {
    if (!held && String(file).endsWith(`${path.sep}git${path.sep}HEAD`)) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return access(file, ...rest);
  });
};

test('native registration outside any execution context reports lock wait and hold time, and journals contention', async () => {
  const f = await fixture();
  const spy = holdFirstTransaction(300);
  try {
    await Promise.all([
      f.runtime.registerNativeSession({ directory: f.directory, sessionID: 'ses_first' }),
      f.runtime.registerNativeSession({ directory: f.directory, sessionID: 'ses_second' }),
    ]);
  } finally { spy.mockRestore(); }
  expect(f.timings).toHaveLength(2);
  for (const timing of f.timings) expect(timing).toMatchObject({ operation: 'registerNativeSession', wrote: true, failed: false });
  expect(f.timings.map((timing) => timing.sessionID).sort()).toEqual(['ses_first', 'ses_second']);
  // Whichever acquired first held the lock; the other queued behind it.
  const [holder, waiter] = [...f.timings].sort((a, b) => b.holdMs - a.holdMs);
  expect(holder.holdMs).toBeGreaterThanOrEqual(290);
  expect(waiter.waitMs).toBeGreaterThanOrEqual(250);
  expect(waiter.queueMs).toBeLessThanOrEqual(waiter.waitMs);
  // No admission summary carries them, so the slow acquisitions are journaled here.
  const journaled = f.diagnostics.filter((record) => record.phase === 'ledger_lock');
  expect(journaled).toEqual(expect.arrayContaining([
    expect.objectContaining({ state: 'completed', slow: true, action: 'registerNativeSession', sessionID: 'ses_first',
      steps: expect.stringMatching(/^queue_wait:1\/\d+,lock_wait:1\/\d+,lock_hold:1\/\d+$/) }),
    expect.objectContaining({ state: 'completed', slow: true, action: 'registerNativeSession', sessionID: 'ses_second' }),
  ]));
});

test('lock wait and hold join an active execution summary instead of a separate journal record', async () => {
  const f = await fixture();
  const records = [];
  await withExecutionSummary({ sessionID: 'ses_summary' }, () => f.runtime.registerNativeSession({ directory: f.directory, sessionID: 'ses_summary' }),
    { phase: 'direct_finish', minMs: 0, onDiagnostic: (record) => records.push(record) });
  const summary = records.find((record) => record.phase === 'direct_finish');
  expect(summary.steps).toMatch(/(^|,)lock_wait:1\/\d+(,|$)/);
  expect(summary.steps).toMatch(/(^|,)lock_hold:1\/\d+(,|$)/);
  expect(f.timings).toEqual([expect.objectContaining({ operation: 'registerNativeSession', sessionID: 'ses_summary' })]);
  expect(f.diagnostics.filter((record) => record.phase === 'ledger_lock')).toEqual([]);
});

test('direct finishes and background ledger builds name their lock operation', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.directory, 'a.txt'), 'a\n');
  await git(f.directory, ['add', 'a.txt']);
  await git(f.directory, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '--quiet', '-m', 'init']);
  expect(await f.runtime.warm({ directory: f.directory })).toMatchObject({ built: true });
  expect(f.timings.some((timing) => timing.operation === 'ledger_warm_install' && !timing.sessionID)).toBe(true);
  const identity = { directory: f.directory, sessionID: 'ses_direct', userMessageID: 'msg_user', messageID: 'msg_assistant', callID: 'call_1' };
  const { generation } = await f.runtime.admitDirect(identity);
  await f.runtime.finishDirect({ ...identity, token: '00000000-0000-4000-8000-000000000001', generation, executionFingerprint: 'a'.repeat(64) });
  expect(f.timings.at(-1)).toMatchObject({ operation: 'finishDirect', sessionID: 'ses_direct', wrote: true, failed: false });
  expect(f.timings.at(-1).holdMs).toBeGreaterThanOrEqual(0);
});
