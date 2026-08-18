import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRecordStore } from './record-store.js';
import {
  WORKTREE_BOOTSTRAP_STAGES,
  createWorktreeBootstrapRuntime,
  validateWorktreeBootstrapReceipt,
} from './worktree-bootstrap.js';

const temporaryDirectories = [];

const makeRuntime = async (effects = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-worktree-ops-'));
  temporaryDirectories.push(directory);
  const store = createRecordStore({
    directory,
    validateRecord: validateWorktreeBootstrapReceipt,
    logger: { warn() {} },
  });
  return {
    directory,
    runtime: createWorktreeBootstrapRuntime({
      store,
      effects: {
        worktreeExists: async () => true,
        ...effects,
      },
    }),
  };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('durable worktree bootstrap state machine', () => {
  test('orders the post-checkout hook immediately after population', () => {
    expect(WORKTREE_BOOTSTRAP_STAGES).toEqual([
      'prepare_remote',
      'create_worktree',
      'sync_project_metadata',
      'populate_worktree',
      'run_post_checkout_hook',
      'configure_upstream',
      'run_project_setup',
      'run_requested_setup',
      'complete',
    ]);
  });

  test('migrates version 1 and 2 receipts without retroactively running terminal hooks', () => {
    const legacyStages = Object.fromEntries(WORKTREE_BOOTSTRAP_STAGES
      .filter((stage) => stage !== 'run_post_checkout_hook')
      .map((stage) => [stage, {
        status: stage === 'complete' ? 'completed' : 'skipped',
        startedAt: null,
        finishedAt: 10,
        error: null,
      }]));
    const base = {
      operationId: 'legacy-operation',
      idempotencyKey: 'legacy-request',
      fingerprint: 'legacy-fingerprint',
      directory: '/tmp/legacy-worktree',
      stage: 'complete',
      status: 'ready',
      stages: legacyStages,
      attempt: 1,
      tombstone: false,
      warnings: [],
      error: null,
      metadata: {},
      result: null,
      createdAt: 1,
      updatedAt: 10,
    };

    const migratedV1 = validateWorktreeBootstrapReceipt({ ...base, version: 1 });
    const migratedV2 = validateWorktreeBootstrapReceipt({ ...base, version: 2, ownerId: 'owner-2' });
    expect(migratedV1).toMatchObject({
      version: 3,
      ownerId: 'local-admin',
      stages: { run_post_checkout_hook: { status: 'skipped' } },
    });
    expect(migratedV2).toMatchObject({
      version: 3,
      ownerId: 'owner-2',
      stages: { run_post_checkout_hook: { status: 'skipped' } },
    });
  });

  test('migrates in-flight receipts according to legacy stage progress', () => {
    const stageState = () => ({ status: 'queued', startedAt: null, finishedAt: null, error: null });
    const stages = Object.fromEntries(WORKTREE_BOOTSTRAP_STAGES
      .filter((stage) => stage !== 'run_post_checkout_hook')
      .map((stage) => [stage, stageState()]));
    for (const stage of ['prepare_remote', 'create_worktree', 'sync_project_metadata', 'populate_worktree']) {
      stages[stage].status = 'completed';
    }
    const base = {
      version: 2,
      ownerId: 'owner',
      operationId: 'legacy-in-flight',
      idempotencyKey: 'legacy-in-flight-key',
      fingerprint: 'fingerprint',
      directory: '/tmp/legacy-in-flight',
      stage: 'populate_worktree',
      status: 'queued',
      stages,
      attempt: 1,
      tombstone: false,
      warnings: [],
      error: null,
      metadata: {},
      result: null,
      createdAt: 1,
      updatedAt: 2,
    };

    expect(validateWorktreeBootstrapReceipt(base).stages.run_post_checkout_hook.status).toBe('queued');
    const later = structuredClone(base);
    later.operationId = 'legacy-later';
    later.idempotencyKey = 'legacy-later-key';
    later.stage = 'configure_upstream';
    later.status = 'running';
    later.stages.configure_upstream.status = 'running';
    later.stages.configure_upstream.startedAt = 2;
    expect(validateWorktreeBootstrapReceipt(later).stages.run_post_checkout_hook.status).toBe('skipped');
  });

  test('joins concurrent identical idempotent requests and rejects changed fingerprints', async () => {
    const { runtime } = await makeRuntime();
    const input = {
      idempotencyKey: 'request-1',
      fingerprint: 'same',
      directory: '/tmp/worktree-one',
    };
    const [first, second] = await Promise.all([
      runtime.beginOperation(input),
      runtime.beginOperation(input),
    ]);
    expect(first.receipt.operationId).toBe(second.receipt.operationId);
    expect([first.replay, second.replay].sort()).toEqual([false, true]);

    await expect(runtime.beginOperation({ ...input, fingerprint: 'changed' })).rejects.toMatchObject({
      code: 'WORKTREE_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    });
  });

  test('single-flights matching requests by resolved directory across idempotency keys', async () => {
    const { runtime } = await makeRuntime();
    const directory = '/tmp/worktree-directory-single-flight';
    const first = await runtime.beginOperation({
      idempotencyKey: 'directory-request-1',
      fingerprint: 'same-directory-request',
      directory,
    });
    const joined = await runtime.beginOperation({
      idempotencyKey: 'directory-request-2',
      fingerprint: 'same-directory-request',
      directory: path.join('/tmp', '.', 'worktree-directory-single-flight'),
    });

    expect(joined.replay).toBe(true);
    expect(joined.receipt.operationId).toBe(first.receipt.operationId);
    expect(await runtime.listActive()).toHaveLength(1);
    expect(await runtime.getByDirectory(directory)).toMatchObject({
      operationId: first.receipt.operationId,
    });
  });

  test('rejects conflicting setup and maintenance for a busy directory', async () => {
    const { runtime } = await makeRuntime();
    const directory = '/tmp/worktree-directory-busy';
    await runtime.beginOperation({
      idempotencyKey: 'directory-busy-1',
      fingerprint: 'first',
      directory,
    });

    await expect(runtime.beginOperation({
      idempotencyKey: 'directory-busy-2',
      fingerprint: 'conflicting',
      directory,
    })).rejects.toMatchObject({
      code: 'WORKTREE_DIRECTORY_BUSY',
      statusCode: 409,
    });
    await expect(runtime.runDirectoryMaintenance(directory, async () => undefined)).rejects.toMatchObject({
      code: 'WORKTREE_DIRECTORY_BUSY',
      statusCode: 409,
    });
  });

  test('blocks setup while directory maintenance is active', async () => {
    const { runtime } = await makeRuntime();
    const directory = '/tmp/worktree-maintenance-busy';
    let releaseMaintenance;
    let markMaintenanceStarted;
    const maintenanceReleased = new Promise((resolve) => {
      releaseMaintenance = resolve;
    });
    const maintenanceStarted = new Promise((resolve) => {
      markMaintenanceStarted = resolve;
    });
    const maintenance = runtime.runDirectoryMaintenance(directory, () => {
      markMaintenanceStarted();
      return maintenanceReleased;
    });
    await maintenanceStarted;

    await expect(runtime.beginOperation({
      idempotencyKey: 'maintenance-conflict',
      fingerprint: 'setup',
      directory,
    })).rejects.toMatchObject({
      code: 'WORKTREE_DIRECTORY_BUSY',
      statusCode: 409,
    });

    releaseMaintenance();
    await maintenance;
  });

  test('supersedes a terminal receipt for a changed fingerprint only when requested', async () => {
    const { runtime } = await makeRuntime();
    const input = {
      idempotencyKey: 'request-supersede',
      fingerprint: 'first',
      directory: '/tmp/worktree-supersede',
    };
    const first = await runtime.beginOperation(input);
    await runtime.fail(first.receipt.operationId, new Error('first request failed'));

    await expect(runtime.beginOperation({ ...input, fingerprint: 'second' })).rejects.toMatchObject({
      code: 'WORKTREE_IDEMPOTENCY_CONFLICT',
    });

    const second = await runtime.beginOperation({
      ...input,
      fingerprint: 'second',
      supersedeTerminal: true,
    });
    expect(second.replay).toBe(false);
    expect(second.receipt.operationId).not.toBe(first.receipt.operationId);
    expect(await runtime.getReceipt(first.receipt.operationId)).toMatchObject({
      tombstone: true,
      supersededAt: expect.any(Number),
    });

    const replay = await runtime.beginOperation({
      ...input,
      fingerprint: 'second',
      supersedeTerminal: true,
    });
    expect(replay).toMatchObject({ replay: true });
    expect(replay.receipt.operationId).toBe(second.receipt.operationId);
  });

  test('does not supersede a queued or running receipt', async () => {
    const { runtime } = await makeRuntime();
    const first = await runtime.beginOperation({
      idempotencyKey: 'request-running',
      fingerprint: 'first',
      directory: '/tmp/worktree-running',
    });
    expect(first.receipt.status).toBe('queued');

    await expect(runtime.beginOperation({
      idempotencyKey: 'request-running',
      fingerprint: 'second',
      directory: '/tmp/worktree-running',
      supersedeTerminal: true,
    })).rejects.toMatchObject({
      code: 'WORKTREE_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    });
  });

  test('surfaces warning stages but fails a known setup error', async () => {
    const calls = [];
    const { runtime } = await makeRuntime({
      populate_worktree: async () => calls.push('populate'),
      configure_upstream: async () => {
        throw new Error('no upstream');
      },
      run_project_setup: async () => {
        throw new Error('setup exited 1');
      },
    });
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'request-2',
      directory: '/tmp/worktree-two',
    });
    await runtime.executeStage(receipt.operationId, 'prepare_remote', async () => undefined);
    await runtime.executeStage(receipt.operationId, 'create_worktree', async () => undefined);
    await runtime.executeStage(receipt.operationId, 'sync_project_metadata', async () => undefined);

    const settled = await runtime.queue(receipt.operationId);

    expect(calls).toEqual(['populate']);
    expect(settled.status).toBe('failed');
    expect(settled.stage).toBe('run_project_setup');
    expect(settled.warnings[0]).toMatchObject({ stage: 'configure_upstream' });
  });

  test('marks an interrupted setup as needs attention and resumes deterministic work', async () => {
    const { directory, runtime } = await makeRuntime({
      populate_worktree: async () => undefined,
      run_project_setup: async () => new Promise(() => {}),
    });
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'request-3',
      directory: '/tmp/worktree-three',
    });
    const raw = await runtime.getReceipt(receipt.operationId);
    raw.stage = 'run_project_setup';
    raw.status = 'running';
    raw.stages.run_project_setup.status = 'running';
    raw.stages.run_project_setup.startedAt = Date.now();
    const store = createRecordStore({
      directory,
      validateRecord: validateWorktreeBootstrapReceipt,
      logger: { warn() {} },
    });
    await store.writeRecord(raw.operationId, raw);

    const restarted = createWorktreeBootstrapRuntime({ store, effects: { worktreeExists: async () => true } });
    await restarted.reconcileOnStartup();

    expect(await restarted.getReceipt(raw.operationId)).toMatchObject({
      status: 'needs_attention',
      stage: 'run_project_setup',
    });
  });

  test('reports receipt-less existing worktrees as not applicable and missing paths as 404', async () => {
    const { runtime } = await makeRuntime({ worktreeExists: async (directory) => directory.endsWith('existing') });
    expect(await runtime.getByDirectory('/tmp/existing')).toMatchObject({ status: 'not_applicable' });
    await expect(runtime.getByDirectory('/tmp/missing')).rejects.toMatchObject({
      code: 'WORKTREE_NOT_FOUND',
      statusCode: 404,
    });
  });

  test('retries the failed stage without replaying completed stages', async () => {
    let populateAttempts = 0;
    let createAttempts = 0;
    const { runtime } = await makeRuntime({
      create_worktree: async () => {
        createAttempts += 1;
      },
      populate_worktree: async () => {
        populateAttempts += 1;
        if (populateAttempts === 1) throw new Error('temporary populate failure');
      },
    });
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'request-retry',
      directory: '/tmp/worktree-retry',
    });
    const first = await runtime.queue(receipt.operationId);
    expect(first).toMatchObject({ status: 'failed', stage: 'populate_worktree' });

    await runtime.retry(receipt.operationId);
    await runtime.drain();
    expect(await runtime.getReceipt(receipt.operationId)).toMatchObject({
      status: 'ready',
      attempt: 2,
    });
    expect(createAttempts).toBe(1);
    expect(populateAttempts).toBe(2);
  });

  test('never replays a completed post-checkout hook stage', async () => {
    let hookRuns = 0;
    const { runtime } = await makeRuntime({
      run_post_checkout_hook: async () => {
        hookRuns += 1;
        return { presence: true, exitStatus: 0, durationMs: 4 };
      },
    });
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'hook-once',
      directory: '/tmp/hook-once',
    });

    expect((await runtime.queue(receipt.operationId)).status).toBe('ready');
    expect((await runtime.queue(receipt.operationId)).status).toBe('ready');
    expect(hookRuns).toBe(1);
    expect((await runtime.getReceipt(receipt.operationId)).stages.run_post_checkout_hook).toMatchObject({
      status: 'completed',
      output: { presence: true, exitStatus: 0, durationMs: 4 },
    });
  });

  test('marks an interrupted post-checkout hook needs attention and retries only after explicit action', async () => {
    const { directory, runtime } = await makeRuntime();
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'interrupted-hook',
      directory: '/tmp/interrupted-hook',
    });
    const raw = await runtime.getReceipt(receipt.operationId);
    raw.stage = 'run_post_checkout_hook';
    raw.status = 'running';
    raw.stages.run_post_checkout_hook.status = 'running';
    raw.stages.run_post_checkout_hook.startedAt = Date.now() - 10;
    const store = createRecordStore({
      directory,
      validateRecord: validateWorktreeBootstrapReceipt,
      logger: { warn() {} },
    });
    await store.writeRecord(raw.operationId, raw);

    let hookRuns = 0;
    const restarted = createWorktreeBootstrapRuntime({
      store,
      effects: {
        worktreeExists: async () => true,
        run_post_checkout_hook: async () => {
          hookRuns += 1;
          return { presence: true, exitStatus: 0, durationMs: 3 };
        },
      },
    });
    await restarted.reconcileOnStartup();
    expect(hookRuns).toBe(0);
    expect(await restarted.getReceipt(raw.operationId)).toMatchObject({
      status: 'needs_attention',
      stage: 'run_post_checkout_hook',
      stages: {
        run_post_checkout_hook: {
          status: 'needs_attention',
          output: { failureExcerpt: expect.stringContaining('interrupted') },
        },
      },
    });

    await restarted.retry(raw.operationId);
    await restarted.drain();
    expect(hookRuns).toBe(1);
    expect(await restarted.getReceipt(raw.operationId)).toMatchObject({ status: 'ready', attempt: 2 });
  });

  test('persists migrated legacy receipts as version 3 during initialization', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-worktree-migration-'));
    temporaryDirectories.push(directory);
    const unvalidatedStore = createRecordStore({ directory, logger: { warn() {} } });
    const stages = Object.fromEntries(WORKTREE_BOOTSTRAP_STAGES
      .filter((stage) => stage !== 'run_post_checkout_hook')
      .map((stage) => [stage, { status: 'queued', startedAt: null, finishedAt: null, error: null }]));
    await unvalidatedStore.writeRecord('legacy-durable', {
      version: 2,
      ownerId: 'owner',
      operationId: 'legacy-durable',
      idempotencyKey: 'legacy-durable-key',
      fingerprint: 'legacy-durable-fingerprint',
      directory: '/tmp/legacy-durable',
      stage: 'populate_worktree',
      status: 'queued',
      stages,
      attempt: 1,
      tombstone: false,
      warnings: [],
      error: null,
      metadata: {},
      result: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const store = createRecordStore({
      directory,
      validateRecord: validateWorktreeBootstrapReceipt,
      logger: { warn() {} },
    });
    const migrated = createWorktreeBootstrapRuntime({ store, effects: { worktreeExists: async () => true } });
    await migrated.initialize();

    const envelope = JSON.parse(await fs.readFile(path.join(directory, 'legacy-durable.json'), 'utf8'));
    expect(envelope.record).toMatchObject({
      version: 3,
      stages: { run_post_checkout_hook: { status: 'queued' } },
    });
  });

  test('reconciles a crash immediately after the durable creation receipt', async () => {
    const { directory, runtime } = await makeRuntime();
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'request-restart',
      directory: '/tmp/worktree-restart',
      metadata: {
        primaryWorktree: '/tmp/primary',
        worktreeAddArgs: ['worktree', 'add', '/tmp/worktree-restart'],
      },
    });
    const raw = await runtime.getReceipt(receipt.operationId);
    raw.stage = 'create_worktree';
    raw.status = 'running';
    raw.stages.prepare_remote.status = 'completed';
    raw.stages.create_worktree.status = 'running';
    raw.stages.create_worktree.startedAt = Date.now();
    const store = createRecordStore({
      directory,
      validateRecord: validateWorktreeBootstrapReceipt,
      logger: { warn() {} },
    });
    await store.writeRecord(raw.operationId, raw);

    const calls = [];
    const restarted = createWorktreeBootstrapRuntime({
      store,
      effects: {
        create_worktree: async (saved) => calls.push(saved.metadata.worktreeAddArgs),
        populate_worktree: async () => undefined,
        worktreeExists: async () => false,
      },
    });
    await restarted.reconcileOnStartup();
    await restarted.drain();

    expect(calls).toEqual([['worktree', 'add', '/tmp/worktree-restart']]);
    expect(await restarted.getReceipt(raw.operationId)).toMatchObject({ status: 'ready' });
  });

  test('tombstones removed operations so background work cannot resurrect them', async () => {
    let calls = 0;
    const { runtime } = await makeRuntime({
      populate_worktree: async () => {
        calls += 1;
      },
    });
    const { receipt } = await runtime.beginOperation({
      idempotencyKey: 'request-removed',
      directory: '/tmp/worktree-removed',
    });
    await runtime.markRemoved(receipt.directory);
    await runtime.queue(receipt.operationId);

    expect(calls).toBe(0);
    expect(await runtime.getReceipt(receipt.operationId)).toMatchObject({
      status: 'removed',
      tombstone: true,
    });
    await expect(runtime.retry(receipt.operationId)).rejects.toMatchObject({
      code: 'WORKTREE_RETRY_INVALID',
    });
  });
});
