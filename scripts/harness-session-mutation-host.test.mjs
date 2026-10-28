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
