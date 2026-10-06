import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createManagedTaskRecord } from '@openchamber/orchestration-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { createAtomicManagedOrchestrationLedger } from './atomic-ledger.js';

const temporaryDirectories = [];

const createOwnedLedger = async (options) => {
  const ledger = createAtomicManagedOrchestrationLedger({
    heartbeatIntervalMs: 0,
    process: new EventEmitter(),
    ...options,
  });
  await ledger.acquireOwnership();
  return ledger;
};

const createTemporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-orchestration-ledger-'));
  temporaryDirectories.push(directory);
  return directory;
};

const queuedTask = (index) => createManagedTaskRecord({
  taskId: `dvr_task_${index}`,
  idempotencyKey: `task-${index}`,
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  sequence: index,
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Task ${index}`,
  prompt: `Run task ${index}.`,
  attempt: 1,
  priorTaskId: null,
  executionKind: 'start',
  createdAt: 1_000 + index,
  timeoutAt: null,
});

const snapshot = (tasks = []) => ({
  version: 1,
  tasks,
  resultEnvelopes: [],
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const windowsFixture = () => {
  const records = new Map(), writes = [], state = { active: true, closed: 0 }, controller = new AbortController();
  const files = { maxBytes: 64 * 1024 * 1024, ensureDirectory: async () => {},
    read: async file => { const value = records.get(file); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value; },
    write: async (file, bytes, { expected } = {}) => {
      expect(expected).toBe(records.get(file) ?? null); writes.push({ file, bytes: Buffer.from(bytes), expected });
      records.set(file, { identity: { fileId: String(writes.length) }, bytes: Buffer.from(bytes) });
    },
    quarantine: async (file, previous) => { expect(previous).toBe(records.get(file)); records.delete(file); return `${file}.native-backup`; },
  };
  const keeper = { signal: controller.signal, assert: () => { if (!state.active) throw Object.assign(new Error('lost'), { code: 'execution_owner_lost' }); },
    close: async () => { state.closed++; state.active = false; } };
  const create = (options = {}) => createAtomicManagedOrchestrationLedger({ platform: 'win32', dataDirectory: '/fixture/private',
    windowsLedgerOwner: files, windowsLauncher: 'constructor-only', createWindowsKeeper: async () => keeper, logger: { warn: () => {} },
    fs: new Proxy({}, { get: () => () => { throw new Error('Node filesystem fallback'); } }), ...options });
  return { records, writes, state, files, keeper, create };
};

describe('Windows native managed ledger constructor', () => {
  it('uses kernel ownership and exact native CAS without Node filesystem, PID probes or heartbeat recovery', async () => {
    const fixture = windowsFixture(), ledger = fixture.create({ isProcessAlive: () => { throw new Error('PID fallback'); } });
    await ledger.acquireOwnership(); await ledger.save(snapshot([queuedTask(1)]));
    expect(await ledger.load()).toEqual(snapshot([queuedTask(1)])); expect(fixture.writes).toHaveLength(1);
    expect(await ledger.releaseOwnership()).toBe(true); expect(fixture.state.closed).toBe(1);
    await expect(ledger.save(snapshot())).rejects.toMatchObject({ code: 'managed_orchestration_owner_conflict' });
  });
  it('compacts a ledger larger than 16 MiB and keeps its first exact native backup', async () => {
    const fixture = windowsFixture(), ledger = fixture.create(); await ledger.acquireOwnership();
    const old = Buffer.from(JSON.stringify(snapshot(Array.from({ length: 68 }, (_, index) => ({ ...queuedTask(index + 1), prompt: 'x'.repeat(256 * 1024) })))));
    fixture.records.set(ledger.filePath, { identity: { fileId: 'legacy64-bound' }, bytes: old });
    expect((await ledger.load()).tasks).toHaveLength(68);
    await ledger.save(snapshot());
    const backup = fixture.records.get(ledger.filePath + '.before-compaction'); expect(backup.bytes.equals(old)).toBe(true);
    await ledger.save(snapshot([queuedTask(2)])); expect(fixture.records.get(ledger.filePath + '.before-compaction')).toBe(backup);
    await ledger.releaseOwnership();
  });
  it('quarantines only the exact malformed snapshot captured by the retained owner', async () => {
    const fixture = windowsFixture(), ledger = fixture.create(); await ledger.acquireOwnership();
    fixture.records.set(ledger.filePath, { identity: { fileId: 'corrupt' }, bytes: Buffer.from('{broken') });
    expect(await ledger.load()).toBeNull(); expect(fixture.records.has(ledger.filePath)).toBe(false);
    expect(ledger.getDiagnostics().quarantinedPath).toBe(`${ledger.filePath}.native-backup`);
    await ledger.releaseOwnership();
  });
  it('lost keepers fence the old instance before writes and after in-flight publication', async () => {
    const fixture = windowsFixture(), ledger = fixture.create(); await ledger.acquireOwnership();
    const write = fixture.files.write; fixture.files.write = async (...args) => { await write(...args); fixture.state.active = false; };
    await expect(ledger.save(snapshot())).rejects.toMatchObject({ code: 'managed_orchestration_ownership_lost' });
    expect(ledger.getDiagnostics().writeCount).toBe(0);
    await expect(ledger.save(snapshot())).rejects.toMatchObject({ code: 'managed_orchestration_ownership_lost' });
    expect(fixture.writes).toHaveLength(1);
    await expect(ledger.releaseOwnership()).rejects.toMatchObject({ code: 'managed_orchestration_ownership_lost' });
    expect(fixture.state.closed).toBe(1);
  });
  it('drains admitted native writes before releasing the keeper and rejects new writes during release', async () => {
    const fixture = windowsFixture(), ledger = fixture.create(); await ledger.acquireOwnership();
    let releaseWrite, started; const writing = new Promise(resolve => { started = resolve; });
    const waiting = new Promise(resolve => { releaseWrite = resolve; }), write = fixture.files.write;
    fixture.files.write = async (...args) => { started(); await waiting; await write(...args); };
    const save = ledger.save(snapshot()); await writing; const release = ledger.releaseOwnership();
    await expect(ledger.save(snapshot([queuedTask(2)]))).rejects.toMatchObject({ code: 'managed_orchestration_owner_conflict' });
    expect(fixture.state.closed).toBe(0); releaseWrite(); await save; expect(await release).toBe(true); expect(fixture.state.closed).toBe(1);
  });
  it('refuses missing, ordinary16MiB or oversized constructor owners and unknown kernel lock settlement', async () => {
    const fixture = windowsFixture();
    for (const windowsLedgerOwner of [undefined, { ...fixture.files, maxBytes: 16 * 1024 * 1024 }]) {
      expect(() => fixture.create({ windowsLedgerOwner })).toThrow('managed_orchestration_windows_authority_unavailable');
    }
    expect(() => fixture.create({ maxReadBytes: 64 * 1024 * 1024 + 1 })).toThrow('managed_orchestration_windows_authority_unavailable');
    const ledger = fixture.create({ createWindowsKeeper: async () => { throw Object.assign(new Error('uncertain'), { code: 'execution_owner_termination_unconfirmed' }); } });
    await expect(ledger.acquireOwnership()).rejects.toMatchObject({ code: 'execution_owner_termination_unconfirmed' }); expect(fixture.writes).toHaveLength(0);
  });
});

describe('atomic managed orchestration ledger', () => {
  it('atomically persists and restores a private JSON snapshot', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory });
    const expected = snapshot([{ ...queuedTask(1), readOnly: true }]);

    await ledger.save(expected);

    expect(await ledger.load()).toEqual(expected);
    expect((await fs.stat(ledger.filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(ledger.filePath))).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('hydrates legacy tasks without dispatch identity or read-only policy instead of quarantining them', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory });
    const legacyTask = { ...queuedTask(1) };
    delete legacyTask.dispatchGroupId;
    delete legacyTask.dispatchCallId;
    delete legacyTask.dispatchWaveId;
    delete legacyTask.readOnly;
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, JSON.stringify(snapshot([legacyTask])), { mode: 0o600 });

    const loaded = await ledger.load();

    expect(loaded.tasks[0].dispatchGroupId).toBeNull();
    expect(loaded.tasks[0].dispatchCallId).toBeNull();
    expect(loaded.tasks[0].dispatchWaveId).toBeNull();
    expect(loaded.tasks[0].readOnly).toBe(false);
    expect(loaded.tasks[0].recoveryLineageId).toBeNull();
    expect(loaded.tasks[0].childPromptedAt).toBeNull();
    expect(loaded.tasks[0].firstAssistantPartAt).toBeNull();
    expect(ledger.getDiagnostics().quarantinedPath).toBeNull();
  });

  it('hydrates legacy result envelopes without provider reset or auto-resume state', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory });
    const task = {
      ...queuedTask(1),
      status: 'failed',
      childSessionId: 'ses_child',
      leaseToken: 'dvr_lease_failed',
      startedAt: 1_100,
      finishedAt: 1_200,
      failureReason: 'out of usage',
      partial: false,
    };
    delete task.recoveryLineageId;
    delete task.childPromptedAt;
    delete task.firstAssistantPartAt;
    const legacyEnvelope = {
      owner: 'devryan',
      envelopeId: 'dvr_result_1_1',
      taskId: task.taskId,
      rootSessionId: task.rootSessionId,
      parentTaskId: null,
      childSessionId: task.childSessionId,
      directory: task.directory,
      sequence: 1,
      status: 'failed',
      partial: false,
      failureReason: task.failureReason,
      attempt: 1,
      priorTaskId: null,
      executionKind: 'start',
      recoverablePreview: '',
      canonicalRefs: [],
      resumable: true,
      createdAt: 1_200,
      acknowledgedAt: null,
      action: null,
      followUpTaskId: null,
    };
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, JSON.stringify({
      version: 1,
      tasks: [task],
      resultEnvelopes: [legacyEnvelope],
    }), { mode: 0o600 });

    const loaded = await ledger.load();

    expect(loaded.resultEnvelopes[0]).toMatchObject({ providerResetAt: null, autoResume: null });
    expect(loaded.tasks[0]).toMatchObject({ recoveryLineageId: null, childPromptedAt: null });
    expect(ledger.getDiagnostics().quarantinedPath).toBeNull();
  });

  it('reads a ledger larger than the write cap instead of quarantining it', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory });
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    // 22 MiB of ordinary records, as a version with a longer history wrote.
    const tasks = Array.from({ length: 22 * 32 }, (_, index) => ({ ...queuedTask(index + 1), prompt: 'x'.repeat(32 * 1024) }));
    await fs.writeFile(ledger.filePath, JSON.stringify({ version: 1, tasks, resultEnvelopes: [] }));
    expect((await fs.stat(ledger.filePath)).size).toBeGreaterThan(21 * 1024 * 1024);
    const loaded = await ledger.load();
    expect(loaded.tasks).toHaveLength(tasks.length);
    expect(ledger.getDiagnostics().quarantinedPath).toBeNull();
    await ledger.releaseOwnership();
  });

  it('keeps the previous ledger once before a save that removes most of a large one', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory, logger: {} });
    const backup = `${ledger.filePath}.before-compaction`;
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    const large = JSON.stringify({ version: 1, tasks: [{ ...queuedTask(1), prompt: 'x'.repeat(6 * 1024 * 1024) }], resultEnvelopes: [] });
    await fs.writeFile(ledger.filePath, large);

    await ledger.save(snapshot([queuedTask(2)]));
    expect(await fs.readFile(backup, 'utf8')).toBe(large);
    expect((await fs.stat(backup)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(ledger.filePath, 'utf8')).tasks.map((task) => task.taskId)).toEqual(['dvr_task_2']);

    // Only the first large compaction is kept.
    await fs.writeFile(ledger.filePath, large.replace('Task 1', 'Later'));
    await ledger.save(snapshot([queuedTask(3)]));
    expect(await fs.readFile(backup, 'utf8')).toBe(large);
    await ledger.releaseOwnership();

    // Ordinary saves keep nothing.
    const small = await createOwnedLedger({ dataDirectory: await createTemporaryDirectory() });
    await small.save(snapshot([queuedTask(1), queuedTask(2)]));
    await small.save(snapshot([]));
    await expect(fs.stat(`${small.filePath}.before-compaction`)).rejects.toMatchObject({ code: 'ENOENT' });
    await small.releaseOwnership();
  });

  it('serializes overlapping saves in invocation order', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory });

    await Promise.all([
      ledger.save(snapshot([queuedTask(1)])),
      ledger.save(snapshot([queuedTask(2)])),
      ledger.save(snapshot([queuedTask(3)])),
    ]);

    expect((await ledger.load()).tasks.map((task) => task.taskId)).toEqual(['dvr_task_3']);
  });

  it('quarantines malformed JSON before starting from an explicit empty state', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const warnings = [];
    const ledger = await createOwnedLedger({
      dataDirectory,
      logger: { warn: (...args) => warnings.push(args) },
      now: () => 1_234,
    });
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, '{not-json', { mode: 0o600 });

    expect(await ledger.load()).toBeNull();
    const diagnostics = ledger.getDiagnostics();
    expect(diagnostics.recoveryWarning).toContain('quarantined');
    expect(diagnostics.quarantinedPath).toContain('ledger.json.corrupt-1234');
    expect(warnings).toHaveLength(1);
    await expect(fs.readFile(diagnostics.quarantinedPath, 'utf8')).resolves.toBe('{not-json');
    await expect(fs.stat(ledger.filePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await ledger.save(snapshot());
    expect(await ledger.load()).toEqual(snapshot());
    await expect(fs.readFile(diagnostics.quarantinedPath, 'utf8')).resolves.toBe('{not-json');
  });

  it('quarantines a schema-valid envelope that contradicts its task', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory, now: () => 2_000 });
    const task = {
      ...queuedTask(1),
      status: 'failed',
      childSessionId: 'ses_child',
      leaseToken: 'dvr_lease_failed',
      startedAt: 1_100,
      finishedAt: 1_200,
      failureReason: 'provider failed',
      partial: false,
    };
    const invalid = {
      version: 1,
      tasks: [task],
      resultEnvelopes: [{
        owner: 'devryan',
        envelopeId: 'dvr_result_1_1',
        taskId: task.taskId,
        rootSessionId: task.rootSessionId,
        parentTaskId: null,
        childSessionId: task.childSessionId,
        directory: task.directory,
        sequence: 1,
        status: 'completed',
        partial: false,
        failureReason: task.failureReason,
        attempt: 1,
        priorTaskId: null,
        executionKind: 'start',
        recoverablePreview: '',
        canonicalRefs: [],
        resumable: false,
        createdAt: 1_200,
        acknowledgedAt: null,
        action: null,
        followUpTaskId: null,
      }],
    };
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, JSON.stringify(invalid), { mode: 0o600 });

    expect(await ledger.load()).toBeNull();
    expect(ledger.getDiagnostics().recoveryWarning).toContain(
      'result envelope status does not match task dvr_task_1',
    );
  });

  it('allows only one live ledger owner for a data directory', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const first = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      process: new EventEmitter(),
    });
    const second = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      process: new EventEmitter(),
    });

    await first.acquireOwnership();
    await expect(second.acquireOwnership()).rejects.toMatchObject({
      code: 'managed_orchestration_owner_conflict',
      statusCode: 409,
    });
    expect(second.getDiagnostics().ownership.state).toBe('conflict');

    await first.releaseOwnership();
    await expect(second.acquireOwnership()).resolves.toBeUndefined();
    expect(second.getDiagnostics().ownership.state).toBe('owned');
    await second.releaseOwnership();
  });

  it('recovers a lock whose process is dead even when the heartbeat is still fresh', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const first = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      pid: 12_345,
      process: new EventEmitter(),
    });
    await first.acquireOwnership();

    let randomSequence = 0;
    const second = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      ownerStaleMs: 45_000,
      now: () => 2_000,
      pid: 67_890,
      isProcessAlive: async (pid) => pid !== 12_345,
      randomId: () => `0123456789abcdef${String(randomSequence += 1).padStart(16, '0')}`,
      process: new EventEmitter(),
    });

    await expect(second.acquireOwnership()).resolves.toBeUndefined();
    expect(second.getDiagnostics().ownership.state).toBe('owned');
    await expect(first.save(snapshot())).rejects.toMatchObject({
      code: 'managed_orchestration_ownership_lost',
    });
    await second.releaseOwnership();
  });

  it('refuses to steal a lock whose process is still alive even when the heartbeat is stale', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const first = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      pid: 12_345,
      process: new EventEmitter(),
    });
    await first.acquireOwnership();
    const ownerPath = path.join(path.dirname(first.filePath), 'owner.lock');
    await fs.utimes(ownerPath, new Date(1_000), new Date(1_000));

    const second = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      ownerStaleMs: 1_000,
      now: () => 10_000,
      pid: 67_890,
      isProcessAlive: async () => true,
      process: new EventEmitter(),
    });

    await expect(second.acquireOwnership()).rejects.toMatchObject({
      code: 'managed_orchestration_owner_conflict',
      statusCode: 409,
    });
    await first.releaseOwnership();
  });

  it('recovers only a stale lock whose process is confirmed dead', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const first = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      pid: 12_345,
      process: new EventEmitter(),
    });
    await first.acquireOwnership();
    const ownerPath = path.join(path.dirname(first.filePath), 'owner.lock');
    await fs.utimes(ownerPath, new Date(1_000), new Date(1_000));

    let randomSequence = 0;
    const second = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      ownerStaleMs: 1_000,
      now: () => 10_000,
      pid: 67_890,
      isProcessAlive: async (pid) => pid !== 12_345,
      randomId: () => `0123456789abcdef${String(randomSequence += 1).padStart(16, '0')}`,
      process: new EventEmitter(),
    });

    await expect(second.acquireOwnership()).resolves.toBeUndefined();
    await expect(first.save(snapshot())).rejects.toMatchObject({
      code: 'managed_orchestration_ownership_lost',
      statusCode: 409,
    });
    expect(first.getDiagnostics().ownership.state).toBe('lost');
    await second.releaseOwnership();
  });

  it('fences ledger reads and writes after the owner token changes', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory });
    await ledger.save(snapshot([queuedTask(1)]));
    const ownerPath = path.join(path.dirname(ledger.filePath), 'owner.lock');
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    await fs.writeFile(ownerPath, `${JSON.stringify({
      ...owner,
      token: 'fedcba9876543210fedcba9876543210',
    })}\n`, { mode: 0o600 });

    await expect(ledger.load()).rejects.toMatchObject({
      code: 'managed_orchestration_ownership_lost',
    });
    await expect(ledger.save(snapshot())).rejects.toMatchObject({
      code: 'managed_orchestration_ownership_lost',
    });
  });

  it('releases the owner lock without waiting for an in-flight save', async () => {
    const dataDirectory = await createTemporaryDirectory();
    let releaseSave;
    const gate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    let pendingSaveStarted = false;
    const fsApi = new Proxy(fs, {
      get(target, property) {
        if (property === 'rename') {
          return async (from, to) => {
            if (String(to).endsWith(`${path.sep}ledger.json`)) {
              pendingSaveStarted = true;
              await gate;
            }
            return fs.rename(from, to);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ledger = await createOwnedLedger({ dataDirectory, fs: fsApi });
    const pending = ledger.save(snapshot());
    const startedAt = Date.now();
    while (!pendingSaveStarted) {
      if (Date.now() - startedAt > 2_000) {
        throw new Error('in-flight save did not start');
      }
      await new Promise((resolve) => setImmediate(resolve));
    }

    const released = ledger.releaseOwnership();
    const ownerPath = path.join(path.dirname(ledger.filePath), 'owner.lock');
    try {
      const lockGoneAt = Date.now();
      while (nodeFs.existsSync(ownerPath)) {
        if (Date.now() - lockGoneAt > 2_000) {
          throw new Error('owner lock was not released during an in-flight save');
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      releaseSave();
    }
    await expect(released).resolves.toBe(true);
    await pending.catch(() => undefined);
  });

  it('unlinks the owner lock on process exit while this runtime still holds the token', async () => {
    const { EventEmitter } = await import('node:events');
    const fakeProcess = new EventEmitter();
    const dataDirectory = await createTemporaryDirectory();
    const ledger = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      process: fakeProcess,
    });
    await ledger.acquireOwnership();
    const ownerPath = path.join(path.dirname(ledger.filePath), 'owner.lock');
    await expect(fs.readFile(ownerPath, 'utf8')).resolves.toContain('"pid"');

    fakeProcess.emit('exit');

    await expect(fs.stat(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
