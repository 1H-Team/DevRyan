// Prepared-baseline reuse (DEVRYAN_PREPARED_BASELINE_REUSE=1): publication
// uses the base rows its own preparation staged, only while the lease ref
// still names the committed view tree, and otherwise reads the durable rows.
// Every result must equal the switch-off result.
import { afterEach, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { changeKey, openChangeStore } from './session-changes-store.js';
import { createSessionMutationRuntime, preparedBaselineUsage } from './session-mutations.js';
import { withExecutionTiming } from './execution-admission.js';
import { cleanupRoots, fixture, ledgerState, manyFiles, test, withEnv } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);

const ON = { DEVRYAN_PREPARED_BASELINE_REUSE: '1' };
const OFF = { DEVRYAN_PREPARED_BASELINE_REUSE: '0' };
const ledgerRoot = async (f) => path.join(f.storage, changeKey(await fs.realpath(f.directory)));
const cached = (token) => preparedBaselineUsage().entries.find((entry) => entry.token === token) ?? null;
const durableRows = async (f, lease) => {
  const root = await ledgerRoot(f), db = await openChangeStore(root, path.join(root, 'git'), { ref: lease.snapshotRef });
  const rows = [];
  for await (const row of db.list(`bases/${lease.token}/files`)) rows.push(row);
  return rows;
};
const terminate = (lease) => fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
  JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
// Publishes a claimed, terminated process lease; returns its result, receipt
// and finish summary steps.
const publish = async (f, lease, edit, runtime = f.runtime) => {
  await runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  await edit?.(lease.viewDirectory);
  await terminate(lease);
  const records = [];
  const result = await withExecutionTiming({ sessionID: lease.scope.sessionID, callID: lease.scope.callID },
    () => runtime.finish({ directory: f.directory, token: lease.token }),
    { phase: 'finish', minMs: 0, onDiagnostic: (record) => records.push(record) });
  const summary = records.find((record) => record.phase === 'finish' && record.state === 'completed');
  const steps = Object.fromEntries(String(summary?.steps ?? '').split(',').filter(Boolean)
    .map((step) => [step.split(':')[0], Number(step.split(':')[1].split('/')[0])]));
  // The durable publication receipt: before and after entry of every changed path.
  const root = await ledgerRoot(f), receipt = [];
  for await (const row of (await openChangeStore(root, path.join(root, 'git'))).list(`publications/${lease.token}/files`)) receipt.push(row);
  await runtime.cleanupLease({ directory: f.directory, token: lease.token });
  return { result, receipt, steps };
};
const edits = async (view) => {
  await fs.appendFile(path.join(view, 'd0/e0/f0.txt'), 'edited\n');
  await fs.writeFile(path.join(view, 'd1/e1/new.txt'), 'new\n');
  await fs.rm(path.join(view, 'd2/e2/f2.txt'));
  await fs.rename(path.join(view, 'd3/e3/f3.txt'), path.join(view, 'd3/moved.txt'));
  await fs.chmod(path.join(view, 'run.sh'), 0o700);
};
// Type, permission bits and bytes of every view entry except its Git metadata:
// what a formatter in the view reads.
async function describeView(base) {
  const rows = [];
  const walk = async (relative) => {
    for (const entry of await fs.readdir(path.join(base, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (name === '.git') continue;
      const full = path.join(base, name), stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) rows.push([name, 'link', await fs.readlink(full)]);
      else if (stat.isDirectory()) { rows.push([name, 'directory', stat.mode & 0o7777]); await walk(name); }
      else rows.push([name, 'file', stat.mode & 0o7777, (await fs.readFile(full)).toString('base64')]);
    }
  };
  await walk('');
  return rows.sort((left, right) => left[0].localeCompare(right[0]));
}
// Content identity of the receipt (hash, mode, deletion), independent of the fixture.
const comparable = ({ result, receipt }) => ({ files: result.files,
  receipt: receipt.map(({ path: file, before, after }) => [file, before && [before.hash, before.mode], after && [after.hash, after.mode]])
    .sort((left, right) => left[0].localeCompare(right[0])) });

for (const lazy of ['1', '0']) {
  test(`a prepared baseline equals the durable rows and publishes the switch-off result (lazy base runs ${lazy})`, async () => {
    const outcome = async (env) => withEnv({ ...env, DEVRYAN_LAZY_BASE_RUNS: lazy }, async () => {
      const f = await fixture();
      await manyFiles(f, 40);
      const lease = await f.begin('s', 'u1', 'c1');
      const view = await describeView(lease.viewDirectory);
      const durable = await durableRows(f, lease);
      const entry = cached(lease.token);
      const published = await publish(f, lease, edits);
      return { f, lease, view, durable, entry, published, state: await ledgerState(f) };
    });
    const off = await outcome(OFF), on = await outcome(ON);
    expect(off.entry).toBeNull();
    expect(off.published.steps).not.toHaveProperty('finish_baseline_prepared');
    // Accounted with setList's byte total over the exact stored rows.
    expect(on.entry).toEqual({ token: on.lease.token, rows: on.durable.length,
      bytes: on.durable.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) });
    expect(on.published.steps.finish_baseline_prepared).toBe(on.durable.length);
    // Publication consumed it; nothing is kept for a settled lease.
    expect(cached(on.lease.token)).toBeNull();
    // The receipt's before-entries come from the baseline rows.
    for (const row of on.published.receipt) {
      if (row.before) expect(row.before).toStrictEqual(on.durable.find((base) => base.path === row.path).entry);
    }
    expect(on.published.receipt.filter((row) => row.before).length).toBeGreaterThan(2);
    // Same view (formatter input), publication, receipt and ledger as with the switch off.
    expect(on.view).toEqual(off.view);
    expect(comparable(on.published)).toEqual(comparable(off.published));
    expect(on.state).toEqual(off.state);
    expect(on.published.result.files.length).toBeGreaterThan(3);
    expect(await on.f.read('d0/e0/f0.txt')).toBe('line 0\nedited\n');
  });
}

test('a lease ref that no longer names the committed view tree reads the durable rows', async () => withEnv(ON, async () => {
  const f = await fixture();
  await manyFiles(f, 20);
  const lease = await f.begin('s', 'u1', 'c1');
  expect(cached(lease.token)).not.toBeNull();
  // Move the lease ref to another tree holding the same base rows.
  const root = await ledgerRoot(f), db = await openChangeStore(root, path.join(root, 'git'), { ref: lease.snapshotRef });
  db.set('probe/marker.json', { moved: true });
  await db.commit();
  const { result, steps } = await publish(f, lease, (view) => fs.appendFile(path.join(view, 'd0/e0/f0.txt'), 'edited\n'));
  expect(steps.finish_baseline_prepared).toBe(0);
  expect(result.files).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
  expect(cached(lease.token)).toBeNull();
}));

test('one LRU budget: newer leases evict older ones, and a lease larger than the budget is never kept', async () => withEnv(ON, async () => {
  const probe = await fixture();
  await manyFiles(probe, 30);
  const sized = await probe.begin('s', 'u0', 'c0');
  const rows = (await durableRows(probe, sized)).length;
  await probe.runtime.cancelLease({ directory: probe.directory, token: sized.token });
  await probe.runtime.cleanupLease({ directory: probe.directory, token: sized.token });
  // Room for one lease's rows, not two.
  const f = await fixture({ preparedBaselines: { rows: Math.floor(rows * 1.5) } });
  await manyFiles(f, 30);
  const first = await f.begin('a', 'u1', 'c1');
  const second = await f.begin('b', 'u2', 'c2');
  expect(cached(first.token)).toBeNull();
  expect(cached(second.token)).toMatchObject({ rows });
  const edit = (view) => fs.appendFile(path.join(view, 'd0/e0/f0.txt'), 'edited\n');
  const missed = await publish(f, first, edit), hit = await publish(f, second, (view) => fs.appendFile(path.join(view, 'd1/e1/f1.txt'), 'edited\n'));
  expect(missed.steps.finish_baseline_prepared).toBe(0);
  expect(hit.steps.finish_baseline_prepared).toBe(rows);
  expect(missed.result.files).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
  expect(hit.result.files).toEqual([{ path: 'd1/e1/f1.txt', status: 'modified' }]);
  for (const budget of [{ rows: rows - 1 }, { bytes: 64 }]) {
    const small = await fixture({ preparedBaselines: budget });
    await manyFiles(small, 30);
    const lease = await small.begin('s', 'u1', 'c1');
    expect(cached(lease.token)).toBeNull();
    const { result, steps } = await publish(small, lease, edit);
    expect(steps.finish_baseline_prepared).toBe(0);
    expect(result.files).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
  }
  expect(() => createSessionMutationRuntime({ directory: f.storage, preparedBaselines: { rows: 0 } })).toThrow(TypeError);
}));

test('concurrent leases each publish from their own prepared baseline', async () => withEnv(ON, async () => {
  const f = await fixture();
  await manyFiles(f, 40);
  const sessions = ['a', 'b', 'c', 'd'];
  const leases = await Promise.all(sessions.map((sessionID, index) => f.begin(sessionID, `u${index}`, `c${index}`)));
  for (const lease of leases) expect(cached(lease.token)).not.toBeNull();
  const published = await Promise.all(leases.map((lease, index) => publish(f, lease,
    (view) => fs.appendFile(path.join(view, `d${index}/e${index}/f${index}.txt`), `edit ${index}\n`))));
  for (const [index, { result, steps }] of published.entries()) {
    expect(steps.finish_baseline_prepared).toBeGreaterThan(40);
    expect(result.files).toEqual([{ path: `d${index}/e${index}/f${index}.txt`, status: 'modified' }]);
  }
  const state = await ledgerState(f);
  for (const index of [0, 1, 2, 3]) expect(state[`d${index}/e${index}/f${index}.txt`].text).toEndWith(`edit ${index}\n`);
}));

test('cancellation after ready, cleanup, Revert and shutdown evict the entry; a restarted host reads durable rows', async () => withEnv(ON, async () => {
  const f = await fixture();
  await manyFiles(f, 20);
  const cancelled = await f.begin('s', 'u1', 'c1');
  expect(cached(cancelled.token)).not.toBeNull();
  await f.runtime.cancelLease({ directory: f.directory, token: cancelled.token, stoppedBy: 'operator' });
  expect(cached(cancelled.token)).toBeNull();
  await f.runtime.cleanupLease({ directory: f.directory, token: cancelled.token });

  // A Revert that fences a ready descendant lease: its publication fails and drops the entry.
  const root = await f.begin('root', 'p0', 'root0');
  await f.finish(root);
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'root', userMessageID: 'p1' });
  const child = await f.begin('child', 'pc1', 'child1', { parentID: 'root' });
  await fs.appendFile(path.join(child.viewDirectory, 'd0/e0/f0.txt'), 'child\n');
  expect(cached(child.token)).not.toBeNull();
  await f.revert('root', 'p1');
  await expect(f.finish(child)).rejects.toMatchObject({ code: 'execution_reverted' });
  expect(cached(child.token)).toBeNull();
  expect(await f.read('d0/e0/f0.txt')).toBe('line 0\n');

  // Shutdown drops this runtime's entries.
  const drained = await f.begin('s', 'u2', 'c2');
  expect(cached(drained.token)).not.toBeNull();
  await f.runtime.drain();
  expect(cached(drained.token)).toBeNull();
  expect((await publish(f, drained, (view) => fs.appendFile(path.join(view, 'd1/e1/f1.txt'), 'drained\n'))).steps.finish_baseline_prepared).toBe(0);

  // Another host over the same storage never uses this one's memory.
  const prepared = await f.begin('s', 'u3', 'c3');
  expect(cached(prepared.token)).not.toBeNull();
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  const { result, steps } = await publish(f, prepared, (view) => fs.appendFile(path.join(view, 'd2/e2/f2.txt'), 'restarted\n'), restarted);
  expect(steps.finish_baseline_prepared).toBe(0);
  expect(result.files).toEqual([{ path: 'd2/e2/f2.txt', status: 'modified' }]);
  expect(cached(prepared.token)).toBeNull();
  await restarted.drain();
}));
