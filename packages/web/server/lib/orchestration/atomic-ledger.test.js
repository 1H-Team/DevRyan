import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createManagedTaskRecord } from '@openchamber/orchestration-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { createAtomicManagedOrchestrationLedger } from './atomic-ledger.js';

const temporaryDirectories = [];

const createOwnedLedger = async (options) => {
  const ledger = createAtomicManagedOrchestrationLedger({
    heartbeatIntervalMs: 0,
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

  it('hydrates legacy tasks without dispatch groups or read-only policy instead of quarantining them', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const ledger = await createOwnedLedger({ dataDirectory });
    const legacyTask = { ...queuedTask(1) };
    delete legacyTask.dispatchGroupId;
    delete legacyTask.readOnly;
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, JSON.stringify(snapshot([legacyTask])), { mode: 0o600 });

    const loaded = await ledger.load();

    expect(loaded.tasks[0].dispatchGroupId).toBeNull();
    expect(loaded.tasks[0].readOnly).toBe(false);
    expect(ledger.getDiagnostics().quarantinedPath).toBeNull();
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
    });
    const second = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
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

  it('recovers only a stale lock whose process is confirmed dead', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const first = createAtomicManagedOrchestrationLedger({
      dataDirectory,
      heartbeatIntervalMs: 0,
      pid: 12_345,
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
});
