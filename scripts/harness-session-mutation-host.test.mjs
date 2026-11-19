// The session mutation runtime behind its worker thread (Node, as in the
// packaged Electron host) must answer exactly like the inline runtime: the
// same publications, receipts, bytes and error codes, with the caller's
// summary steps, cancellation, observers and input guards carried across the
// thread boundary.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createSessionMutationHost, sessionMutationWorkerEnabled, workerExecArgv } from '../packages/harness-runtime/lib/session-mutation-host.js';
import { createSessionMutationRuntime } from '../packages/harness-runtime/lib/session-mutations.js';
import { withExecutionAdmission, withExecutionPreparation } from '../packages/harness-runtime/lib/execution-admission.js';

const execute = promisify(execFile);
const digest = 'a'.repeat(64);

const project = async (files = 3) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-mutation-host-'));
  const directory = path.join(root, 'project'), storage = path.join(root, 'private');
  await fs.mkdir(directory);
  await execute('git', ['init', '--quiet', directory]);
  for (let index = 0; index < files; index += 1) {
    await fs.mkdir(path.join(directory, `d${index % 4}`), { recursive: true });
    await fs.writeFile(path.join(directory, `d${index % 4}`, `f${index}.txt`), `line ${index}\n`);
  }
  return { root, directory, storage, remove: () => fs.rm(root, { recursive: true, force: true }) };
};

// One confined edit and one direct read, as the host performs them.
const exercise = async (runtime, directory, { observed } = {}) => {
  const scope = (callID, user = 'u1') => ({ directory, sessionID: 's', userMessageID: user, messageID: `${user}-assistant`, callID });
  const records = [];
  const lease = await withExecutionPreparation(scope('edit'), () => runtime.begin(scope('edit')),
    { onDiagnostic: (record) => records.push(record), summary: { minMs: 0 } });
  const steps = records.find((record) => record.phase === 'preparation' && record.state === 'completed')?.steps ?? '';
  await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
  await fs.appendFile(path.join(lease.viewDirectory, 'd0', 'f0.txt'), 'edited\n');
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
  const published = await runtime.finish({ directory, token: lease.token });
  const receipt = await runtime.executionReceipt({ directory, token: lease.token });
  const bytes = [];
  for (const file of receipt.files) {
    const chunks = [];
    for await (const chunk of file.after.byteStream) { assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk); }
    bytes.push(Buffer.concat(chunks).toString());
  }
  await runtime.cleanupLease({ directory, token: lease.token });
  const { generation } = await runtime.admitDirect(scope('read', 'u2'));
  const token = randomUUID();
  const direct = await runtime.finishDirect({ ...scope('read', 'u2'), token, generation, executionFingerprint: digest });
  const mismatch = await runtime.finishDirect({ ...scope('read', 'u2'), token: randomUUID(), generation, executionFingerprint: digest })
    .then(() => null, (error) => ({ code: error.code, status: error.status, isError: error instanceof Error }));
  const outcomes = await runtime.executionOutcomes({ directory, sessionID: 's', calls: [{ messageID: 'u1-assistant', callID: 'edit' },
    { messageID: 'u2-assistant', callID: 'read' }] });
  return { steps, files: published.files, bytes, directFiles: direct.files, mismatch, outcomes: outcomes.map((row) => row.outcome),
    project: await fs.readFile(path.join(directory, 'd0', 'f0.txt'), 'utf8'), observed: observed?.splice(0) };
};

test('runs in a worker under Node and answers exactly like the inline runtime', async (t) => {
  assert.equal(sessionMutationWorkerEnabled({}), true);
  const inline = await project(), remote = await project();
  t.after(() => Promise.all([inline.remove(), remote.remove()]));
  const changes = { inline: [], remote: [] };
  const local = createSessionMutationRuntime({ directory: inline.storage, onChange: (change) => { changes.inline.push(change.files); } });
  const host = createSessionMutationHost({ directory: remote.storage, onChange: (change) => { changes.remote.push(change.files); } });
  t.after(() => host.close());
  assert.equal(typeof host.close, 'function');
  const expected = await exercise(local, inline.directory, { observed: changes.inline });
  const actual = await exercise(host, remote.directory, { observed: changes.remote });
  assert.deepEqual(actual.files, [{ path: 'd0/f0.txt', status: 'modified' }]);
  assert.deepEqual(actual.bytes, ['line 0\nedited\n']);
  assert.equal(actual.project, 'line 0\nedited\n');
  assert.deepEqual(actual.mismatch, { code: 'capture_identity_mismatch', status: 409, isError: true });
  assert.deepEqual(actual.outcomes, ['finished', 'finished']);
  assert.deepEqual({ ...actual, steps: undefined }, { ...expected, steps: undefined });
  // The worker's preparation steps reach the caller's summary.
  for (const phase of ['reconciliation', 'view_files', 'view_copied', 'view_commit', 'view_git']) assert.match(actual.steps, new RegExp(`(^|,)${phase}:`));
  assert.deepEqual(changes.remote, []);
});

test('runtime limits reach the worker', async (t) => {
  const fixture = await project(1);
  t.after(fixture.remove);
  const records = [];
  const host = createSessionMutationHost({ directory: fixture.storage, complexity: { warnEntries: 1, ceilingEntries: 2 },
    onDiagnostic: (record) => records.push(record) });
  t.after(() => host.close());
  const input = { directory: fixture.directory, sessionID: 's', userMessageID: 'u1', messageID: 'u1-assistant', callID: 'edit' };
  const lease = await host.begin(input);
  await fs.writeFile(path.join(lease.viewDirectory, 'd0', 'f0.txt'), 'LINE 0\n');
  await host.finish({ directory: fixture.directory, token: lease.token });
  // One replacement reaches a one-entry warning bound; the default bound is 250,000.
  assert.ok(records.some((record) => record.phase === 'ledger_document_complexity' && record.state === 'warning' && record.count >= 1));
});

test('stalls of the worker thread reach the host observer', async (t) => {
  const fixture = await project(40);
  t.after(fixture.remove);
  const stalls = [];
  // Any tick 1 ms late is a stall here; the shared clock waits for 1 s.
  const host = createSessionMutationHost({ directory: fixture.storage, stallClock: { tickMs: 5, stallMs: 1 }, onWorkerStall: (stall) => stalls.push(stall) });
  t.after(() => host.close());
  await exercise(host, fixture.directory);
  assert.ok(stalls.length > 0);
  for (const stall of stalls) assert.ok(Number.isFinite(stall.ms) && stall.ms >= 1 && stall.to > stall.from, JSON.stringify(stall));
});

test('caller cancellation stops a remote preparation and the next call prepares normally', async (t) => {
  const fixture = await project(400);
  t.after(fixture.remove);
  const host = createSessionMutationHost({ directory: fixture.storage });
  t.after(() => host.close());
  const input = (callID) => ({ directory: fixture.directory, sessionID: 's', userMessageID: `u-${callID}`, messageID: `u-${callID}-assistant`, callID });
  const controller = new AbortController();
  const cancelled = withExecutionAdmission(input('cancelled'), () => host.begin(input('cancelled')), { signal: controller.signal, timeoutMs: 60_000 });
  setTimeout(() => controller.abort(Object.assign(new Error('cancelled'), { code: 'execution_cancelled' })), 5);
  await assert.rejects(cancelled, (error) => error.code === 'execution_cancelled');
  const lease = await host.begin(input('next'));
  assert.equal(lease.state, 'ready');
  assert.equal(await fs.readFile(path.join(lease.viewDirectory, 'd3', 'f399.txt'), 'utf8'), 'line 399\n');
});

test('an input guard runs in the caller and its refusal fails the remote call', async (t) => {
  const fixture = await project();
  t.after(fixture.remove);
  const host = createSessionMutationHost({ directory: fixture.storage });
  t.after(() => host.close());
  const scope = { directory: fixture.directory, sessionID: 's', userMessageID: 'u', messageID: 'u-assistant', callID: 'denied' };
  await host.registerPrompt({ directory: fixture.directory, sessionID: 's', userMessageID: 'u' });
  const { revision } = await host.nativeAdmissionState({ directory: fixture.directory, sessionID: 's' });
  let checks = 0;
  await host.cancelUnstartedCall({ ...scope, requireAbsent: true, guard: { admissionRevision: revision, assertCurrent: () => { checks += 1; } } });
  assert.ok(checks >= 3);
  const revoked = Object.assign(new Error('native_permit_revoked'), { code: 'native_permit_revoked' });
  await assert.rejects(host.cancelUnstartedCall({ ...scope, callID: 'revoked', requireAbsent: true,
    guard: { admissionRevision: revision, assertCurrent: () => { throw revoked; } } }), (error) => error.code === 'native_permit_revoked');
  const outcomes = await host.executionOutcomes({ directory: fixture.directory, sessionID: 's',
    calls: [{ messageID: 'u-assistant', callID: 'denied' }, { messageID: 'u-assistant', callID: 'revoked' }] });
  assert.deepEqual(outcomes.map((row) => row.outcome), ['never_started', 'uncertain']);
});

test('a closed host fails calls with mutation_runtime_unavailable', async (t) => {
  const fixture = await project();
  t.after(fixture.remove);
  const host = createSessionMutationHost({ directory: fixture.storage });
  await host.projectDirectories();
  const status = await host.workerStatus();
  assert.equal(status.running, true);
  assert.equal(status.pendingCalls, 0);
  assert.ok(status.heapUsedMB === null || (Number.isInteger(status.heapUsedMB) && status.heapUsedMB > 0));
  await host.close();
  assert.equal((await host.workerStatus()).running, false);
  await assert.rejects(host.projectDirectories(), (error) => error.code === 'mutation_runtime_unavailable' && error.status === 503);
});

test('a host started from an inline entry (node --input-type=module -e) still starts its worker', async (t) => {
  // The release upgrade lane starts the server this way; the worker used to
  // inherit --input-type and die before loading.
  assert.deepEqual(workerExecArgv(['--input-type=module', '-e', 'code', '--max-old-space-size=100', '--eval=x', '-p', 'y']),
    ['--max-old-space-size=100']);
  assert.equal(workerExecArgv(['--max-old-space-size=100']), undefined);
  const fixture = await project();
  t.after(fixture.remove);
  const host = new URL('../packages/harness-runtime/lib/session-mutation-host.js', import.meta.url).href;
  const script = `const { createSessionMutationHost } = await import(${JSON.stringify(host)});
    const runtime = createSessionMutationHost({ directory: process.argv[1] });
    console.log(JSON.stringify(await runtime.projectDirectories())); await runtime.close();`;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script, fixture.storage], { env: { ...process.env, DEVRYAN_LEDGER_WORKER: '1' } });
  assert.deepEqual(JSON.parse(stdout.trim()), []);
});

test('the kill switch and an injected Git runner keep the runtime inline', () => {
  const previous = process.env.DEVRYAN_LEDGER_WORKER;
  try {
    process.env.DEVRYAN_LEDGER_WORKER = '0';
    assert.equal(sessionMutationWorkerEnabled({}), false);
    assert.equal(typeof createSessionMutationHost({ directory: os.tmpdir() }).close, 'undefined');
  } finally { if (previous === undefined) delete process.env.DEVRYAN_LEDGER_WORKER; else process.env.DEVRYAN_LEDGER_WORKER = previous; }
  assert.equal(sessionMutationWorkerEnabled({ gitRunner: {} }), false);
});

test('input guards and observers run in the context of the call that caused them', async (t) => {
  const fixture = await project();
  t.after(fixture.remove);
  const caller = new AsyncLocalStorage(), observed = [];
  const host = createSessionMutationHost({ directory: fixture.storage, onChange: () => { observed.push(caller.getStore() ?? null); } });
  t.after(() => host.close());
  const scope = { directory: fixture.directory, sessionID: 's', userMessageID: 'u', messageID: 'u-assistant' };
  await host.registerPrompt({ directory: fixture.directory, sessionID: 's', userMessageID: 'u' });
  const { revision } = await host.nativeAdmissionState({ directory: fixture.directory, sessionID: 's' });
  // A native permit guard asserts its controller from its caller's context.
  const guard = { admissionRevision: revision, assertCurrent: () => {
    if (caller.getStore() !== 'controller') throw Object.assign(new Error('native_permit_revoked'), { code: 'native_permit_revoked' });
  } };
  await caller.run('controller', () => host.cancelUnstartedCall({ ...scope, callID: 'guarded', requireAbsent: true, guard }));
  await assert.rejects(host.cancelUnstartedCall({ ...scope, callID: 'outside', requireAbsent: true, guard }),
    (error) => error.code === 'native_permit_revoked');
  await caller.run('editor', async () => {
    const lease = await host.begin({ ...scope, callID: 'edit' });
    await host.claimLease({ directory: fixture.directory, token: lease.token, kind: 'process' });
    await fs.appendFile(path.join(lease.viewDirectory, 'd0', 'f0.txt'), 'edited\n');
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
      JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
    await host.finish({ directory: fixture.directory, token: lease.token });
  });
  assert.deepEqual(observed, ['editor']);
});

// A worker that dies inside the owner lock. The lock file names this process,
// which lives on, so before the host removed such a lock every later call
// waited the 30 s lock timeout and failed until the app restarted. The worker
// is stopped from outside the product: the dual-run harness's crash preload
// ends the ledger's thread at a file operation of its lock protocol (it exits
// the thread, throws an uncaught error there, or blocks it for the test to
// terminate), in a host process of its own.
const crashPreload = fileURLToPath(new URL('./ledger-dual-run/ledger-preload.cjs', import.meta.url));
const hostModule = new URL('../packages/harness-runtime/lib/session-mutation-host.js', import.meta.url).href;
const atomicModule = new URL('../packages/harness-runtime/lib/atomic-file.js', import.meta.url).href;
// The child: hosts on one ledger, every Worker they start captured in order.
const lockChild = `
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import workerThreads from 'node:worker_threads';
const config = JSON.parse(process.argv[1]);
// A child that never reaches its result fails well inside the parent's 240 s limit.
setTimeout(() => { process.stderr.write('lock child: no result after 150 s\\n'); process.exit(2); }, 150_000).unref();
const workers = [];
const Base = workerThreads.Worker;
workerThreads.Worker = class extends Base { constructor(...args) { super(...args); workers.push(this); } };
syncBuiltinESMExports();
const { createSessionMutationHost } = await import(${JSON.stringify(hostModule)});
const { withCrossProcessFileLock } = await import(${JSON.stringify(atomicModule)});
const directory = path.join(config.root, 'project'), storage = path.join(config.root, 'private');
await fs.mkdir(directory);
execFileSync('git', ['init', '--quiet', directory]);
await fs.writeFile(path.join(directory, 'a.txt'), 'a\\n');
const journal = [];
// Maintenance off, so background work cannot reach a crash point meant for a call.
const maintenance = { looseObjects: 1_000_000_000, packs: 1_000_000_000, commits: 1_000_000_000 };
const host = () => createSessionMutationHost({ directory: storage, maintenance, onDiagnostic: (record) => { if (record.phase === 'ledger_worker') journal.push(record.code); } });
const input = (user) => ({ directory, sessionID: 's', userMessageID: user, messageID: user + '-assistant', callID: 'call-' + user });
const settle = async (promise) => { const started = Date.now(); try { await promise; return { ok: true, ms: Date.now() - started }; } catch (error) { return { ok: false, code: error.code, ms: Date.now() - started }; } };
const lockPath = () => { for (const name of readdirSync(storage)) if (existsSync(path.join(storage, name, 'git'))) return path.join(storage, name, 'owner.lock'); return null; };
const lockBytes = () => { try { return readFileSync(lockPath(), 'utf8'); } catch { return null; } };
const until = async (check, what) => { const deadline = Date.now() + 60_000; while (!check()) { if (Date.now() > deadline) throw new Error('lock child: timed out waiting for ' + what); await new Promise((resolve) => setTimeout(resolve, 10)); } };
// Evidence that a worker is waiting for a lock this process holds under
// another token: since audit line \`from\`, its thread reached the link of
// owner.lock at least twice while the file named this process. The preload's
// owner-lock:before fires before every attempt, so the second is a retry after
// the first found the file. A fixed sleep could end before the worker started.
const auditLines = () => { try { return readFileSync(config.audit, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const untilWaiting = (from, worker, what) => until(() => worker() !== undefined && auditLines().slice(from)
  .filter((entry) => entry.point === 'owner-lock:before' && entry.thread === worker().threadId && entry.lock === 'held').length >= 2, what);
// Armed once background work of earlier calls has settled, so only the call
// under test can reach the point. The drain before arming keeps that true
// whatever order the event loop runs work in; correctness must not depend on
// that ordering. One full-file run of the uncaught-error case failed before
// this drain was added; that failure was never reproduced.
const arm = () => writeFileSync(config.armFile, 'armed\\n');
const out = {};
if (config.mode === 'single') {
  const one = host();
  await one.warm({ directory }); await one.drain();
  arm();
  const dying = settle(one.begin(input('u1')));
  if (config.means === 'terminate') { await until(() => existsSync(config.marker), 'the worker to reach the crash point'); await workers.at(-1).terminate(); }
  out.dying = await dying;
  out.reached = existsSync(config.marker);
  out.next = await settle(one.begin(input('u2')));
  out.lock = lockBytes();
  await one.close();
} else if (config.mode === 'two-hosts') {
  const a = host(), b = host();
  await a.warm({ directory }); await b.warm({ directory }); await a.drain(); await b.drain();
  const [workerA, workerB] = workers;
  arm();
  const held = settle(a.begin(input('u1')));
  await until(() => existsSync(config.marker), 'the worker to reach the crash point');
  out.held = lockBytes();
  // B waits for A's lock; B's worker dies while waiting.
  const waiterFrom = auditLines().length;
  const waiting = settle(b.begin(input('u2')));
  await untilWaiting(waiterFrom, () => workerB, 'the worker of host B to wait for the lock of host A');
  await workerB.terminate();
  out.waiting = await waiting;
  out.afterWaiterDied = lockBytes();
  // B waits again on a new worker; A's worker dies holding.
  const nextFrom = auditLines().length, started = workers.length;
  const nextStarted = Date.now(), next = settle(b.begin(input('u3')));
  await untilWaiting(nextFrom, () => workers[started], 'the new worker of host B to wait for the lock of host A');
  await workerA.terminate();
  out.holderDiedMs = Date.now() - nextStarted;
  out.heldCall = await held;
  out.next = await next;
  out.again = await settle(a.begin(input('u4')));
  out.lock = lockBytes();
  await a.close(); await b.close();
} else if (config.mode === 'replaced') {
  const one = host();
  await one.warm({ directory }); await one.drain();
  arm();
  const dying = settle(one.begin(input('u1')));
  await until(() => existsSync(config.marker), 'the worker to reach the crash point');
  // While the worker is stopped, the lock becomes someone else's: same process, another token.
  const other = JSON.stringify({ ownerToken: 'f'.repeat(32), pid: process.pid, createdAt: Date.now() }) + '\\n';
  writeFileSync(lockPath(), other);
  await workers.at(-1).terminate();
  out.dying = await dying;
  out.kept = lockBytes() === other;
  // The holder of that lock releases it; the ledger then works.
  await fs.unlink(lockPath());
  out.next = await settle(one.begin(input('u2')));
  out.lock = lockBytes();
  await one.close();
} else if (config.mode === 'main-thread-holder') {
  // Another owner in this process (here the main thread) holds the lock; a worker dies waiting for it.
  const one = host();
  await one.warm({ directory }); await one.drain();
  let release, holding;
  const acquired = new Promise((resolve) => { holding = resolve; });
  const lock = withCrossProcessFileLock(lockPath(), () => { holding(); return new Promise((resolve) => { release = resolve; }); });
  await acquired;
  out.held = lockBytes();
  const waiterFrom = auditLines().length;
  const waiting = settle(one.begin(input('u1')));
  await untilWaiting(waiterFrom, () => workers.at(-1), 'the worker to wait for the lock the main thread holds');
  await workers.at(-1).terminate();
  out.waiting = await waiting;
  out.kept = lockBytes() === out.held;
  release(); await lock;
  out.next = await settle(one.begin(input('u2')));
  out.lock = lockBytes();
  await one.close();
}
out.journal = journal;
console.log(JSON.stringify(out));
`;
const runLockChild = async (t, config, crash) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-mutation-host-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'crash.marker'), armFile = path.join(root, 'crash.armed'), audit = path.join(root, 'audit.jsonl');
  const env = { ...process.env, DEVRYAN_LEDGER_WORKER: '1', LEDGER_DUAL_RUN_AUDIT: audit, ...(crash ? { LEDGER_DUAL_RUN_CRASH: JSON.stringify({ ...crash, marker, armFile }) } : {}) };
  const { stdout } = await execute(process.execPath, ['--require', crashPreload, '--input-type=module', '-e', lockChild,
    JSON.stringify({ ...config, root, marker, armFile, audit })], { env, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout.trim().split('\n').at(-1));
};

// Where the worker dies: before the lock file exists, holding it before the
// locked work runs, during the commit, and after it released the lock.
const lockStages = [
  { point: 'owner-lock:before', stage: 'before the lock file exists' },
  { point: 'owner-lock:after', stage: 'holding the lock, before the locked work', holds: true },
  { point: 'update-ref:before', stage: 'during the commit', holds: true },
  { point: 'owner-lock-release:after', stage: 'after it released the lock' },
];
for (const means of ['exit-thread', 'throw', 'terminate']) {
  test(`a worker that dies by ${means} at each stage of the owner lock leaves no lock behind; the next call through the host succeeds`, async (t) => {
    for (const { point, stage, holds } of lockStages) {
      const result = await runLockChild(t, { mode: 'single', means }, { point, nth: 1, action: means === 'terminate' ? 'hold' : means });
      const where = `${means} ${stage}: ${JSON.stringify(result)}`;
      assert.equal(result.reached, true, where);
      assert.deepEqual([result.dying.ok, result.dying.code], [false, 'mutation_runtime_unavailable'], where);
      assert.equal(result.next.ok, true, where);
      assert.equal(result.lock, null, where);
      // Exit and termination stop the thread before the link; a thrown error
      // ends it just after the link was started, which completes before the
      // thread is gone (a lock it held) unless it never ran (no lock). Either
      // way nothing is left.
      if (point === 'owner-lock:before' && means === 'throw') assert.ok(result.journal.length <= 1 && result.journal.every((code) => code === 'worker_lock_released'), where);
      else assert.deepEqual(result.journal, holds ? ['worker_lock_released'] : [], where);
    }
  });
}

test('two hosts in one process: a worker that dies waiting leaves the holder\'s lock; one that dies holding releases it to the waiter', async (t) => {
  const result = await runLockChild(t, { mode: 'two-hosts' }, { point: 'owner-lock:after', nth: 1, action: 'hold' });
  const where = JSON.stringify(result);
  assert.match(result.held ?? '', /"ownerToken":"[0-9a-f]{32}"/, where);
  assert.deepEqual([result.waiting.ok, result.waiting.code], [false, 'mutation_runtime_unavailable'], where);
  assert.equal(result.afterWaiterDied, result.held, where);
  assert.deepEqual([result.heldCall.ok, result.heldCall.code], [false, 'mutation_runtime_unavailable'], where);
  // The waiter's new worker took the lock only once the holder had died.
  assert.equal(result.next.ok, true, where);
  assert.ok(result.next.ms >= result.holderDiedMs, where);
  assert.equal(result.again.ok, true, where);
  assert.equal(result.lock, null, where);
  // Only the holder's death released a lock.
  assert.deepEqual(result.journal, ['worker_lock_released'], where);
});

test('a worker that dies waiting for a lock another owner of the process holds leaves that lock alone', async (t) => {
  const result = await runLockChild(t, { mode: 'main-thread-holder' });
  const where = JSON.stringify(result);
  assert.deepEqual([result.waiting.ok, result.waiting.code], [false, 'mutation_runtime_unavailable'], where);
  assert.equal(result.kept, true, where);
  assert.equal(result.next.ok, true, where);
  assert.equal(result.lock, null, where);
  assert.deepEqual(result.journal, [], where);
});

test('a dead worker\'s lock whose bytes changed meanwhile is someone else\'s and stays', async (t) => {
  const result = await runLockChild(t, { mode: 'replaced' }, { point: 'owner-lock:after', nth: 1, action: 'hold' });
  const where = JSON.stringify(result);
  assert.deepEqual([result.dying.ok, result.dying.code], [false, 'mutation_runtime_unavailable'], where);
  assert.equal(result.kept, true, where);
  assert.equal(result.next.ok, true, where);
  assert.equal(result.lock, null, where);
  assert.deepEqual(result.journal, [], where);
});
