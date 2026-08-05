import { describe, expect, test } from 'bun:test';

import { createManagedTaskRecord } from './contract.js';
import { createManagedTaskResultEnvelope } from './result-envelope.js';
import { createManagedTaskScheduler } from './scheduler.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const input = (index, overrides = {}) => ({
  idempotencyKey: `task-${index}`,
  rootSessionId: 'ses_root',
  dispatchGroupId: 'msg_parent_01',
  dispatchCallId: 'call_dispatch_01',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Task ${index}`,
  prompt: `Perform task ${index}.`,
  timeoutAt: null,
  ...overrides,
});

const createHarness = async () => {
  let taskCounter = 0;
  let leaseCounter = 0;
  const runs = [];
  const scheduler = createManagedTaskScheduler({
    executor: {
      start(task, control) {
        const result = deferred();
        runs.push({ control, result, task });
        return result.promise;
      },
      async abort() { return { aborted: true }; },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return {}; },
    },
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    now: () => 1_000 + taskCounter,
  });
  await scheduler.initialize();
  return { runs, scheduler };
};

const disposition = (scheduler, taskId, action = 'continue') => (
  scheduler.acknowledgeResult(taskId, {
    action,
    idempotencyKey: `${action}-${taskId}`,
  })
);

describe('managed scheduler dispatch barrier', () => {
  test('waits for one active child, then locks until its result is dispositioned', async () => {
    const { runs, scheduler } = await createHarness();
    const task = await scheduler.submit(input(1));
    let barrierSettled = false;
    const barrier = scheduler.waitForDispatchBarrier('ses_root').then((result) => {
      barrierSettled = true;
      return result;
    });

    await Promise.resolve();
    expect(barrierSettled).toBe(false);

    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    expect(await barrier).toEqual({
      state: 'awaiting_acknowledgement',
      taskIds: [task.taskId],
    });

    await disposition(scheduler, task.taskId);
    expect(await scheduler.waitForDispatchBarrier('ses_root')).toEqual({
      state: 'clear',
      taskIds: [],
    });
  });

  test('waits through concurrent work and returns every unacknowledged result in queue order', async () => {
    const { runs, scheduler } = await createHarness();
    const first = await scheduler.submit(input(1));
    const second = await scheduler.submit(input(2));
    const barrier = scheduler.waitForDispatchBarrier('ses_root');

    expect(runs).toHaveLength(2);
    runs[0].result.resolve({ status: 'completed' });
    await scheduler.waitForTask(first.taskId);
    runs[1].result.resolve({ status: 'failed', failureReason: 'expected failure' });

    expect(await barrier).toEqual({
      state: 'awaiting_acknowledgement',
      taskIds: [first.taskId, second.taskId],
    });
  });

  test('ignores Council and legacy work without a dispatch group', async () => {
    const { scheduler } = await createHarness();
    await scheduler.submit(input(1, { dispatchGroupId: null }));

    expect(await scheduler.waitForDispatchBarrier('ses_root')).toEqual({
      state: 'clear',
      taskIds: [],
    });
  });

  test('treats cancellation as a terminal result that still needs disposition', async () => {
    const { scheduler } = await createHarness();
    const task = await scheduler.submit(input(1));
    const barrier = scheduler.waitForDispatchBarrier('ses_root');

    await scheduler.cancelTask(task.taskId, { reason: 'cancelled by parent' });

    expect(await barrier).toEqual({
      state: 'awaiting_acknowledgement',
      taskIds: [task.taskId],
    });
    await disposition(scheduler, task.taskId, 'abandon');
    expect((await scheduler.waitForDispatchBarrier('ses_root')).state).toBe('clear');
  });

  test('cleans up task waiters when a barrier wait is aborted', async () => {
    const { scheduler } = await createHarness();
    await scheduler.submit(input(1));
    const controller = new AbortController();
    const barrier = scheduler.waitForDispatchBarrier('ses_root', { signal: controller.signal });

    await Promise.resolve();
    controller.abort(new Error('stop waiting'));

    await expect(barrier).rejects.toThrow('stop waiting');
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
  });

  test('keeps retry and resume lineage in the original dispatch group', async () => {
    const { runs, scheduler } = await createHarness();
    const original = await scheduler.submit(input(1));
    runs[0].result.resolve({
      status: 'failed',
      failureReason: 'retry me',
      resumable: true,
    });
    expect(await scheduler.waitForDispatchBarrier('ses_root')).toEqual({
      state: 'awaiting_acknowledgement',
      taskIds: [original.taskId],
    });

    const retry = await disposition(scheduler, original.taskId, 'retry');
    expect(retry.followUpTask.dispatchGroupId).toBe(original.dispatchGroupId);
    expect(retry.followUpTask.dispatchCallId).toBe(original.dispatchCallId);
    const followUpBarrier = scheduler.waitForDispatchBarrier('ses_root');
    runs[1].result.resolve({ status: 'completed' });

    expect(await followUpBarrier).toEqual({
      state: 'awaiting_acknowledgement',
      taskIds: [retry.followUpTask.taskId],
    });
    await disposition(scheduler, retry.followUpTask.taskId);
    expect((await scheduler.waitForDispatchBarrier('ses_root')).state).toBe('clear');
  });

  test('hydrates legacy ledger records as ungrouped without locking historical results', async () => {
    const legacyTask = createManagedTaskRecord({
      taskId: 'dvr_task_legacy',
      idempotencyKey: 'legacy',
      rootSessionId: 'ses_root',
      dispatchGroupId: null,
      parentTaskId: null,
      directory: '/workspace',
      sequence: 1,
      mode: 'orchestrator',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: null,
      label: 'Legacy task',
      prompt: 'Legacy prompt',
      attempt: 1,
      priorTaskId: null,
      executionKind: 'start',
      createdAt: 1_000,
      timeoutAt: null,
    });
    const terminal = {
      ...legacyTask,
      status: 'completed',
      childSessionId: 'ses_legacy',
      leaseToken: 'dvr_lease_legacy',
      startedAt: 1_100,
      finishedAt: 1_200,
    };
    delete terminal.dispatchGroupId;
    delete terminal.dispatchCallId;
    const envelope = createManagedTaskResultEnvelope(
      { ...terminal, dispatchGroupId: null, dispatchCallId: null },
      { sequence: 1, createdAt: 1_200, resumable: false },
    );
    let savedState = null;
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() {
          return { version: 1, tasks: [terminal], resultEnvelopes: [envelope] };
        },
        async save(state) { savedState = state; },
      },
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      now: () => 2_000,
    });

    await scheduler.initialize();

    expect(scheduler.getTask(terminal.taskId).dispatchGroupId).toBeNull();
    expect(scheduler.getTask(terminal.taskId).dispatchCallId).toBeNull();
    expect(savedState.tasks[0].dispatchGroupId).toBeNull();
    expect(savedState.tasks[0].dispatchCallId).toBeNull();
    expect((await scheduler.waitForDispatchBarrier('ses_root')).state).toBe('clear');
  });
});
