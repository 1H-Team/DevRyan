import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRecordStore } from './record-store.js';
import {
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
