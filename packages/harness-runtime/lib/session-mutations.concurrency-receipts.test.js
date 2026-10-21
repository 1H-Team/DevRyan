import { afterEach, describe, expect, spyOn } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { createSessionChangeRuntime } from './session-changes.js';
import { openChangeStore, changeKey } from './session-changes-store.js';
import { withExecutionAdmission } from './execution-admission.js';
import { cleanupRoots, fixture, ledgerState, manyFiles, roots, SMALL_BATCHES, test, withEnv } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);
test('expired concurrent admissions never run after a held publication and a later prompt succeeds', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ onMaterialize: async () => { entered(); await held; } });
  await f.write('x', 'old');
  const owner = await f.begin('owner', 'p0', 'c0');
  await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
  const publication = f.finish(owner);
  await started;
  const diagnostics = [];
  const attempts = Array.from({ length: 4 }, (_, i) => {
    const input = { sessionID: `s${i}`, callID: `c${i}` };
    return withExecutionAdmission(input, () => f.begin(input.sessionID, `p${i}`, input.callID), {
      timeoutMs: 100, onDiagnostic: (record) => diagnostics.push(record),
    });
  });
  attempts.push(withExecutionAdmission({ sessionID: 'prompt' }, () => f.runtime.registerPrompt({
    directory: f.directory, sessionID: 'prompt', userMessageID: 'p-next',
  }), { timeoutMs: 100 }));
  const settledAttempts = Promise.allSettled(attempts);
  try {
    const other = await fixture();
    await expect(withExecutionAdmission({ sessionID: 'other' }, () => other.runtime.assertAdmission({
      directory: other.directory, sessionID: 'other',
    }))).resolves.toEqual({ admitted: true });
    const results = await settledAttempts;
    expect(results.every((result) => result.status === 'rejected' && result.reason.code === 'local_execution_timeout')).toBe(true);
    expect(diagnostics.filter((row) => row.phase === 'queue_wait' && row.state === 'failed')).toHaveLength(4);
    expect(diagnostics.some((row) => 'directory' in row || 'args' in row)).toBe(false);
  } finally { release(); await publication; }
  await f.runtime.drain();
  expect(await f.runtime.activeLeases({ directory: f.directory })).toHaveLength(0);
  await expect(f.runtime.registerPrompt({ directory: f.directory, sessionID: 'prompt', userMessageID: 'p-next' })).resolves.toHaveProperty('sequence');
  expect(await f.read('x')).toBe('new');
});

test('cancellation during reconciliation discards preparation and allows a subsequent tool', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  const f = await fixture(); await f.write('x', 'preserved');
  const controller = new AbortController();
  const cancelled = Object.assign(new Error('local_execution_timeout'), { code: 'local_execution_timeout' });
  const phases = [];
  await expect(withExecutionAdmission({ sessionID: 'cancelled', callID: 'c' }, () => f.begin('cancelled', 'p', 'c'), {
    signal: controller.signal,
    onDiagnostic: (record) => {
      phases.push(record);
      if (record.phase === 'reconciliation' && record.state === 'started') controller.abort(cancelled);
    },
  })).rejects.toBe(cancelled);
  expect(phases.some((row) => row.phase === 'reconciliation' && row.state === 'failed')).toBe(true);
  expect((await f.runtime.leaseForCall({ directory: f.directory, sessionID: 'cancelled', callID: 'c' })).state).toBe('cancelled');
  await expect(f.begin('cancelled', 'p', 'c')).rejects.toMatchObject({ code: 'execution_cancelled' });
  const healthy = await f.begin('healthy', 'p2', 'c2');
  expect(await fs.readFile(path.join(healthy.viewDirectory, 'x'), 'utf8')).toBe('preserved');
});


test('slow reconciliation retains I/O ownership while unrelated control admission remains available', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  const f = await fixture(); await f.write('slow.txt', 'preserve me');
  let release, enter;
  const held = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  const readFile = fs.readFile.bind(fs);
  const open = fs.open.bind(fs);
  const probe = spyOn(fs, 'open').mockImplementation(async (file, ...options) => {
    if (String(file) === path.join(await fs.realpath(f.directory), 'slow.txt')) { enter(); await held; }
    return open(file, ...options);
  });
  const phases = [];
  let ownerSettled = false;
  const owner = withExecutionAdmission({ sessionID: 's0', callID: 'c0' }, () => f.begin('s0', 'p0', 'c0'), {
    timeoutMs: 1000, onDiagnostic: (row) => phases.push(row),
  }).then((result) => { ownerSettled = true; return result; }, (cause) => { ownerSettled = true; return cause; });
  let waiting = Promise.resolve([]);
  try {
    await Promise.race([entered, owner.then(() => { throw new Error('fixture failed before reconciliation'); })]);
    waiting = Promise.allSettled([
      ...Array.from({ length: 3 }, (_, index) => withExecutionAdmission({ sessionID: `s${index + 1}` },
        () => f.begin(`s${index + 1}`, `p${index + 1}`, `c${index + 1}`), { timeoutMs: 1000 })),
      withExecutionAdmission({ sessionID: 'prompt' }, () => f.runtime.registerPrompt({ directory: f.directory,
        sessionID: 'prompt', userMessageID: 'next' }), { timeoutMs: 5000 }),
    ]);
    const results = await waiting;
    expect(results.slice(0, 3).every((result) => result.status === 'rejected' && result.reason.code === 'local_execution_timeout')).toBe(true);
    expect(results[3].status).toBe('fulfilled');
    expect(ownerSettled).toBe(false);
  } finally {
    release(); await owner; await waiting; probe.mockRestore();
  }
  expect((await owner).code).toBe('local_execution_timeout');
  expect(phases.some((row) => row.phase === 'reconciliation' && row.state === 'failed')).toBe(true);
  await f.runtime.drain();
  expect(await f.runtime.activeLeases({ directory: f.directory })).toHaveLength(0);
  const healthy = await f.begin('healthy', 'p-ok', 'c-ok');
  expect(await readFile(path.join(healthy.viewDirectory, 'slow.txt'), 'utf8')).toBe('preserve me');
});

test('32 warm reservations meet the admission budget before any materialization', async () => {
  const f = await fixture(); await f.write('file', 'base');
  const warm = await f.begin('warm', 'warm-prompt', 'warm-call'); await f.finish(warm);
  const started = performance.now();
  const leases = await Promise.all(Array.from({ length: 32 }, (_, i) => f.runtime.reserve({ directory: f.directory,
    sessionID: `parallel-${i}`, userMessageID: `prompt-${i}`, messageID: `assistant-${i}`, callID: `call-${i}` })));
  expect(performance.now() - started).toBeLessThan(25_000);
  expect(leases.every(lease => lease.state === 'preparing')).toBe(true);
  expect(new Set(leases.map(lease => lease.token)).size).toBe(32);
});

test('large execution receipts are lazy streams with bounded chunks', async () => {
  const f = await fixture(); await f.write('large', Buffer.alloc(9 * 1024 * 1024, 97));
  const lease = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(lease.viewDirectory, 'large'), Buffer.alloc(9 * 1024 * 1024, 98)); await f.finish(lease);
  const receipt = await f.runtime.executionReceipt({ directory: f.directory, token: lease.token });
  const after = receipt.files[0].after;
  expect(after.bytes).toBeUndefined(); expect(after.sha256).toHaveLength(64);
  let size = 0;
  for await (const chunk of after.byteStream) { expect(chunk.length).toBeLessThanOrEqual(128 * 1024); size += chunk.length; }
  expect(size).toBe(9 * 1024 * 1024);
  const changes = createSessionChangeRuntime({ directory: path.join(f.root, 'changes') });
  try {
    // Read fresh iterables: the size check above deliberately consumed one.
    const input = await f.runtime.executionReceipt({ directory: f.directory, token: lease.token });
    await changes.recordReceipt(input);
    expect(await changes.summarize({ directory: f.directory, rootSessionID: 'a' }))
      .toMatchObject({ fileCount: 1, coverage: 'complete' });
  } finally { await changes.drain(); }
});

test('exhausted storage cancels preparation without publication and permits recovery', async () => {
  const f = await fixture(); await f.write('preserved', 'user content');
  const lease = await f.runtime.reserve({ directory: f.directory, sessionID: 'a', userMessageID: 'pa', messageID: 'ma', callID: 'ca' });
  const space = spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0n, bsize: 4096n });
  try {
    await expect(f.runtime.prepare(lease)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' })).rejects.toBeDefined();
    expect(await f.read('preserved')).toBe('user content');
    expect(await f.runtime.activeLeases({ directory: f.directory })).toHaveLength(0);
  } finally { space.mockRestore(); }
  const recovered = await f.begin('b', 'pb', 'cb');
  expect(await fs.readFile(path.join(recovered.viewDirectory, 'preserved'), 'utf8')).toBe('user content');
});

test('live execution bases survive pruning and cleanup only releases terminal leases', async () => {
  const f = await fixture(); await f.write('preserved', 'base');
  const lease = await f.begin('a', 'pa', 'ca');
  const gitDirectory = path.join(f.storage, changeKey(lease.projectDirectory), 'git');
  const command = (args) => git(f.directory, ['--git-dir', gitDirectory, ...args]);
  const pinned = (await command(['rev-parse', lease.snapshotRef])).toString().trim();
  expect(await f.runtime.cleanupLease({ directory: f.directory, token: lease.token })).toBe(false);
  await command(['gc', '--prune=now']);
  expect((await command(['rev-parse', lease.snapshotRef])).toString().trim()).toBe(pinned);
  const evidence = path.join(path.dirname(lease.viewDirectory), 'termination.json');
  await fs.writeFile(evidence, 'retained fixture evidence');
  await f.runtime.cancelLease({ directory: f.directory, token: lease.token });
  expect(await f.runtime.cleanupLease({ directory: f.directory, token: lease.token })).toBe(true);
  expect(await fs.readFile(evidence, 'utf8')).toBe('retained fixture evidence');
  await expect(command(['rev-parse', '--verify', lease.snapshotRef])).rejects.toBeDefined();
});


test('changing file stamps stop preparation with a retryable error and no stale base', async () => {
  const f = await fixture(); await f.write('hot', 'original');
  const target = await fs.realpath(path.join(f.directory, 'hot'));
  const original = fs.lstat.bind(fs); let reads = 0;
  const changing = spyOn(fs, 'lstat').mockImplementation(async (file, options) => {
    if (file === target) { reads++; await f.write('hot', `write-${reads}`); }
    return original(file, options);
  });
  try { await expect(f.begin('s', 'u', 'c')).rejects.toMatchObject({ code: 'workspace_changing', status: 503 }); }
  finally { changing.mockRestore(); }
  expect(reads).toBeLessThan(20);
  const lease = await f.runtime.leaseForCall({ directory: f.directory, sessionID: 's', callID: 'c' });
  expect(lease.state).toBe('cancelled'); expect(lease.cleaned).toBe(true);
  const retry = await f.begin('s', 'u', 'retry');
  expect(await fs.readFile(path.join(retry.viewDirectory, 'hot'), 'utf8')).toBe(await f.read('hot'));
});

test('concurrent ledger changes are bounded independently of stable file stamps', async () => {
  const f = await fixture(); await f.write('hot', 'original');
  await f.begin('baseline', 'u0', 'c0');
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory))), gitDir = path.join(root, 'git');
  const churn = async () => {
    const db = await openChangeStore(root, gitDir);
    for await (const { key, value } of db.entries('files')) {
      delete value.published.observation;
      value.published.sequence = (value.published.sequence ?? 0) + 1;
      db.set(key, value);
    }
    await db.commit();
  };
  await churn();
  // Churn once per inspection, at the object-store probe every inspection makes.
  const original = fs.lstat.bind(fs); let changes = 0;
  const changing = spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (/^[a-f0-9]{64}$/.test(path.basename(String(args[0]))) && path.dirname(String(args[0])) === path.join(root, 'objects')) { changes++; await churn(); }
    return original(...args);
  });
  try { await expect(f.begin('s', 'u', 'c')).rejects.toMatchObject({ code: 'workspace_changing' }); }
  finally { changing.mockRestore(); }
  expect(changes).toBe(4); expect(await f.read('hot')).toBe('original');
});

test('terminal cleanup survives restart and removes read-only private directories without following symlinks', async () => {
  const f = await fixture(); await f.write('x', 'base');
  const lease = await f.begin('s', 'u', 'c');
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  const ro = path.join(lease.viewDirectory, 'readonly'); await fs.mkdir(ro);
  await fs.writeFile(path.join(ro, 'result'), 'accepted'); await fs.chmod(ro, 0o555);
  const external = path.join(f.root, 'external'); await fs.mkdir(external, { mode: 0o555 });
  await fs.symlink(external, path.join(lease.viewDirectory, 'external'));
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }), { flag: 'wx', mode: 0o600 });
  await f.finish(lease);
  await fs.chmod(path.join(f.directory, 'readonly'), 0o755);
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  expect((await restarted.pendingCleanup({ directory: f.directory })).map((row) => row.token)).toContain(lease.token);
  await expect(restarted.cleanupLease(lease)).resolves.toBe(true);
  expect((await fs.stat(external)).mode & 0o777).toBe(0o555);
  expect(await f.read('readonly/result')).toBe('accepted');
  expect(await restarted.pendingCleanup({ directory: f.directory })).toEqual([]);
  expect((await restarted.leaseForCall({ directory: f.directory, sessionID: 's', callID: 'c' })).cleaned).toBe(true);
});

test('cleanup recovers a legacy orphan pin and retains uncertain process receipts', async () => {
  const f = await fixture(); await f.write('x', 'base'); const lease = await f.begin('s', 'u', 'c');
  const root = path.join(f.storage, changeKey(lease.projectDirectory)), gitDir = path.join(root, 'git');
  const db = await openChangeStore(root, gitDir), leaseKey = `leases/${changeKey(lease.token)}.json`;
  const durable = await db.get(leaseKey); delete durable.snapshotRef; db.set(leaseKey, durable); await db.commit();
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  await f.runtime.cancelLease(lease);
  await expect(f.runtime.cleanupLease(lease)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.runtime.pendingCleanup({ directory: f.directory }))).toHaveLength(1);
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    JSON.stringify({ terminated: true, confined: true, cancelled: true, exitCode: 1 }), { flag: 'wx', mode: 0o600 });
  await f.runtime.cleanupLease(lease);
  expect((await git(root, ['--git-dir', gitDir, 'for-each-ref', 'refs/devryan/leases/'])).toString()).toBe('');
});


test('slow unchanged workspace enumeration keeps concurrent preparation making progress', async () => {
  const { withExecutionPreparation } = await import('./execution-admission.js');
  const f = await fixture();
  for (let i = 0; i < 24; i++) {
    await fs.mkdir(path.join(f.directory, `d${i}`));
    await f.write(`d${i}/file`, 'unchanged');
  }
  const warm = await f.begin('warm', 'p0', 'c0'); await f.finish(warm);
  const readdir = fs.readdir.bind(fs);
  const reads = spyOn(fs, 'readdir').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(f.directory)) await new Promise(resolve => setTimeout(resolve, 35));
    return readdir(...args);
  });
  try {
    const leases = await Promise.all(['a', 'b'].map(id => withExecutionPreparation({ sessionID: id },
      () => f.begin(id, `p-${id}`, `c-${id}`), { stallMs: 700 })));
    for (const lease of leases) {
      expect(await fs.readFile(path.join(lease.viewDirectory, 'd0/file'), 'utf8')).toBe('unchanged');
      await f.finish(lease);
    }
  } finally { reads.mockRestore(); await f.runtime.drain(); }
});

test('execution outcome queries never create a ledger for an unmanaged project', async () => {
  const f = await fixture();
  const outcomes = await f.runtime.executionOutcomes({ directory: f.directory, sessionID: 'ses_unmanaged',
    calls: [{ messageID: 'msg_assistant', callID: 'call_one' }] });
  expect(outcomes).toEqual([{ sessionID: 'ses_unmanaged', messageID: 'msg_assistant', callID: 'call_one', outcome: 'uncertain' }]);
  await expect(fs.readdir(f.storage)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.runtime.executionOutcomes({ directory: f.directory, sessionID: 'ses_unmanaged',
    calls: [{ messageID: '', callID: 'call_one' }] })).rejects.toMatchObject({ code: 'invalid_capture_identity' });
});

test('registered sessions, prompts, admission and lease lookups answer while another process holds the ledger lock', async () => {
  const { withExecutionAdmission } = await import('./execution-admission.js');
  const { withCrossProcessFileLock } = await import('./atomic-file.js');
  const f = await fixture();
  await f.write('x', 'old');
  const registered = await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'steady', userMessageID: 'p1' });
  const native = await f.runtime.registerNativeSession({ directory: f.directory, sessionID: 'native', parentID: 'steady' });
  const owner = await f.begin('owner', 'p0', 'c0');
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const lockPath = path.join(f.storage, changeKey(await fs.realpath(f.directory)), 'owner.lock');
  const holder = withCrossProcessFileLock(lockPath, async () => { entered(); await held; }, { timeoutMs: 5_000 });
  await started;
  try {
    const fast = { timeoutMs: 1_000 };
    await expect(withExecutionAdmission({ sessionID: 'native' }, () => f.runtime.registerNativeSession({
      directory: f.directory, sessionID: 'native', parentID: 'steady' }), fast)).resolves.toEqual(native);
    await expect(withExecutionAdmission({ sessionID: 'steady' }, () => f.runtime.registerPrompt({
      directory: f.directory, sessionID: 'steady', userMessageID: 'p1' }), fast)).resolves.toEqual(registered);
    await expect(withExecutionAdmission({ sessionID: 'steady' }, () => f.runtime.assertAdmission({
      directory: f.directory, sessionID: 'steady' }), fast)).resolves.toEqual({ admitted: true });
    await expect(withExecutionAdmission({ sessionID: 'owner' }, () => f.runtime.leaseForCall({
      directory: f.directory, sessionID: 'owner', callID: 'c0' }), fast)).resolves.toMatchObject({ token: owner.token });
    // A new prompt needs a durable write and still waits for the lock.
    await expect(withExecutionAdmission({ sessionID: 'steady' }, () => f.runtime.registerPrompt({
      directory: f.directory, sessionID: 'steady', userMessageID: 'p2' }), { timeoutMs: 150 }))
      .rejects.toMatchObject({ code: 'local_execution_timeout' });
    await expect(withExecutionAdmission({ sessionID: 'new-native' }, () => f.runtime.registerNativeSession({
      directory: f.directory, sessionID: 'new-native', parentID: 'steady' }), { timeoutMs: 150 }))
      .rejects.toMatchObject({ code: 'local_execution_timeout' });
  } finally { release(); await holder; }
  await expect(f.runtime.registerNativeSession({ directory: f.directory, sessionID: 'native' }))
    .rejects.toMatchObject({ code: 'invalid_session_lineage' });
  await fs.mkdir(path.join(f.directory, 'nested'));
  await expect(f.runtime.registerNativeSession({ directory: path.join(f.directory, 'nested'), sessionID: 'native', parentID: 'steady' }))
    .rejects.toMatchObject({ code: 'session_directory_mismatch' });
});

test('a lease lookup never reports absence while a reservation for the call is queued', async () => {
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ onMaterialize: async () => { entered(); await held; } });
  await f.write('x', 'old');
  const owner = await f.begin('owner', 'p0', 'c0');
  await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
  const publication = f.finish(owner);
  await started;
  const scope = { directory: f.directory, sessionID: 's', userMessageID: 'u', messageID: 'm', callID: 'c' };
  const reserving = f.runtime.reserve(scope);
  const lookup = f.runtime.leaseForCall(scope);
  release(); await publication;
  const lease = await reserving;
  expect(await lookup).toMatchObject({ token: lease.token });
});

test('lock-free reads fail closed when a materialization needs recovery', async () => {
  const f = await fixture({ onMaterialize: () => { throw new Error('fixture crash'); } });
  await f.write('x', '0'); const a = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), '1'); await expect(f.finish(a)).rejects.toThrow('fixture crash');
  await f.write('x', 'foreign');
  const restarted = createSessionMutationRuntime({ directory: f.storage });
  await expect(restarted.registerNativeSession({ directory: f.directory, sessionID: 'a' })).rejects.toMatchObject({ code: 'mutation_recovery_required' });
  await expect(restarted.assertAdmission({ directory: f.directory, sessionID: 'a' })).rejects.toMatchObject({ code: 'mutation_recovery_required' });
  await expect(restarted.executionOutcomes({ directory: f.directory, sessionID: 'a', calls: [{ messageID: 'pa-assistant', callID: 'ca' }] }))
    .rejects.toMatchObject({ code: 'mutation_recovery_required' });
});

test('a caller queued behind an un-admitted publication follows its progress', async () => {
  const { withExecutionAdmission, executionProgress } = await import('./execution-admission.js');
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ onMaterialize: async () => {
    entered();
    for (let n = 0; n < 12; n++) { await new Promise((resolve) => setTimeout(resolve, 50)); executionProgress(); }
  } });
  await f.write('x', 'old');
  const owner = await f.begin('owner', 'p0', 'c0');
  await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
  const publication = f.finish(owner); // production 'finish' runs without an admission context
  await started;
  await expect(withExecutionAdmission({ sessionID: 'queued' }, () => f.runtime.registerPrompt({
    directory: f.directory, sessionID: 'queued', userMessageID: 'q1' }), { timeoutMs: 5_000, idleMs: 200 }))
    .resolves.toMatchObject({ sequence: expect.any(Number) });
  await publication;
});

test('a caller queued behind a progressing lock holder is not expired by the idle deadline', async () => {
  const { withExecutionAdmission, executionProgress } = await import('./execution-admission.js');
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ onMaterialize: async () => {
    entered();
    for (let i = 0; i < 12; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); executionProgress(); }
  } });
  await f.write('x', 'old');
  const owner = await f.begin('owner', 'p0', 'c0');
  await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
  const publication = withExecutionAdmission({ sessionID: 'owner' }, () => f.finish(owner), { timeoutMs: 10_000 });
  await started;
  const queued = withExecutionAdmission({ sessionID: 'queued' }, () => f.runtime.registerPrompt({
    directory: f.directory, sessionID: 'queued', userMessageID: 'q1' }), { timeoutMs: 5_000, idleMs: 200 });
  await expect(queued).resolves.toMatchObject({ sequence: expect.any(Number) });
  await publication;
});

test('leaving the queue is progress: a long queue wait is never expired right after acquiring the lock', async () => {
  const { withExecutionAdmission, executionProgress } = await import('./execution-admission.js');
  for (let run = 0; run < 5; run++) {
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const f = await fixture({ onMaterialize: async () => {
      entered();
      // The holder works (with progress) for well over the queued caller's idle window.
      for (let n = 0; n < 120; n++) { await new Promise((resolve) => setTimeout(resolve, 5)); executionProgress(); }
    } });
    await f.write('x', 'old');
    const owner = await f.begin('owner', 'p0', 'c0');
    await fs.writeFile(path.join(owner.viewDirectory, 'x'), 'new');
    const publication = withExecutionAdmission({ sessionID: 'owner' }, () => f.finish(owner), { timeoutMs: 10_000 });
    await started;
    await expect(withExecutionAdmission({ sessionID: 'queued' }, () => f.runtime.registerPrompt({
      directory: f.directory, sessionID: 'queued', userMessageID: 'q1' }), { timeoutMs: 10_000, idleMs: 250 }))
      .resolves.toMatchObject({ sequence: expect.any(Number) });
    await publication;
  }
});
