import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';

const input = {
  idempotencyKey: 'bounded-wait-task',
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: 'Bounded wait task',
  prompt: 'Exercise the managed wait contract.',
  timeoutAt: null,
};

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createClock = () => {
  let now = 1_000;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    schedule(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: now + delayMs });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      await Promise.resolve();
    },
    count: () => timers.size,
  };
};

const createHarness = async () => {
  const clock = createClock();
  const execution = deferred();
  const scheduler = createManagedTaskScheduler({
    executor: {
      async start(_task, control) {
        await control.setChildSessionId('ses_bounded_wait');
        await control.markAccepted();
        return await execution.promise;
      },
      async abort() { return { aborted: true }; },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return {}; },
    },
    now: clock.now,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    createTaskId: () => 'dvr_task_bounded_wait',
    createLeaseToken: () => 'dvr_lease_bounded_wait',
  });
  const task = await scheduler.submit(input);
  await scheduler.flush();
  return { clock, execution, scheduler, task };
};

const createResultActionHarness = async () => {
  const runs = [];
  let taskIndex = 0;
  const execute = async (task, control) => {
    if (!task.childSessionId) await control.setChildSessionId('ses_result_action');
    await control.markAccepted();
    const run = deferred();
    runs.push(run);
    return await run.promise;
  };
  const scheduler = createManagedTaskScheduler({
    executor: {
      start: execute,
      retryInPlace: execute,
      async abort() { return { aborted: true }; },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return {}; },
    },
    createTaskId: () => `dvr_task_result_action_${++taskIndex}`,
    createLeaseToken: () => `dvr_lease_result_action_${taskIndex}`,
  });
  const task = await scheduler.submit({
    ...input,
    idempotencyKey: 'result-action-task',
  });
  await scheduler.flush();
  runs[0].resolve({
    status: 'failed',
    failureKind: 'provider_usage_limit',
    failureReason: 'Monthly usage limit reached',
    recoverablePreview: 'Partial child result',
    resumable: true,
  });
  await scheduler.waitForTask(task.taskId);
  await scheduler.flush();
  return { runs, scheduler, task };
};

describe('managed scheduler task waits', () => {
  test('returns a cloned live snapshot when a bounded wait slice expires without mutating the task', async () => {
    const { clock, scheduler, task } = await createHarness();
    const before = scheduler.getTask(task.taskId);
    const wait = scheduler.waitForTask(task.taskId, { timeoutMs: 25_000 });
    await Promise.resolve();

    expect(clock.count()).toBe(1);
    await clock.advance(25_000);
    const snapshot = await wait;

    expect(snapshot).toMatchObject({ taskId: task.taskId, status: 'running', timeoutAt: null });
    expect(snapshot).not.toBe(scheduler.getTask(task.taskId));
    snapshot.label = 'mutated caller snapshot';
    expect(scheduler.getTask(task.taskId)).toEqual(before);
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    expect(clock.count()).toBe(0);
    await scheduler.shutdown();
  });

  test('cancels the wait-slice timer when the task becomes terminal first', async () => {
    const { clock, execution, scheduler, task } = await createHarness();
    const wait = scheduler.waitForTask(task.taskId, { timeoutMs: 25_000 });
    await Promise.resolve();

    execution.resolve({ status: 'completed', recoverablePreview: 'done' });
    await scheduler.flush();

    expect(await wait).toMatchObject({ status: 'completed' });
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    expect(clock.count()).toBe(0);
    await scheduler.shutdown();
  });

  test('cleans up the waiter and wait-slice timer on external abort', async () => {
    const { clock, scheduler, task } = await createHarness();
    const controller = new AbortController();
    const reason = new Error('caller stopped waiting');
    const wait = scheduler.waitForTask(task.taskId, {
      signal: controller.signal,
      timeoutMs: 25_000,
    });
    await Promise.resolve();

    controller.abort(reason);

    await expect(wait).rejects.toBe(reason);
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    expect(clock.count()).toBe(0);
    await scheduler.shutdown();
  });

  test('rejects supplied wait timeouts that are not positive finite numbers', async () => {
    const { execution, scheduler, task } = await createHarness();
    execution.resolve({ status: 'completed', recoverablePreview: 'done' });
    await scheduler.flush();

    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, '25000']) {
      await expect(scheduler.waitForTask(task.taskId, { timeoutMs }))
        .rejects.toThrow('timeoutMs must be a positive finite number');
    }

    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    await scheduler.shutdown();
  });

  test('keeps omitted task waits unbounded until terminal resolution', async () => {
    const { clock, execution, scheduler, task } = await createHarness();
    let resolved = false;
    const wait = scheduler.waitForTask(task.taskId).then((result) => {
      resolved = true;
      return result;
    });
    await Promise.resolve();

    await clock.advance(25_000);
    expect(resolved).toBe(false);
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(1);
    expect(clock.count()).toBe(0);

    execution.resolve({ status: 'completed', recoverablePreview: 'done' });
    await scheduler.flush();
    expect(await wait).toMatchObject({ status: 'completed' });
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    await scheduler.shutdown();
  });

  test('cleans up a bounded wait-slice timer during shutdown', async () => {
    const { clock, scheduler, task } = await createHarness();
    const wait = scheduler.waitForTask(task.taskId, { timeoutMs: 25_000 });
    await Promise.resolve();

    expect(clock.count()).toBe(1);
    await scheduler.shutdown();

    await expect(wait).rejects.toThrow('managed orchestration scheduler is shut down');
    expect(clock.count()).toBe(0);
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
  });

  test('keeps a result-action wait pending until explicit recovery acknowledgement', async () => {
    const { runs, scheduler, task } = await createResultActionHarness();
    let resolved = false;
    const wait = scheduler.waitForResultAction(task.taskId).then((result) => {
      resolved = true;
      return result;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(1);

    const acknowledgement = await scheduler.acknowledgeResult(task.taskId, {
      action: 'retry_in_place',
      idempotencyKey: 'recover-result-action-task',
      providerId: 'openai',
      modelId: 'gpt-5.6-terra',
      variant: 'high',
    });
    const envelope = await wait;

    expect(envelope).toMatchObject({
      taskId: task.taskId,
      action: 'retry_in_place',
      followUpTaskId: acknowledgement.followUpTask.taskId,
    });
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    const immediate = await scheduler.waitForResultAction(task.taskId);
    expect(immediate).toEqual(envelope);
    expect(immediate).not.toBe(envelope);

    await scheduler.flush();
    runs[1].resolve({ status: 'completed', recoverablePreview: 'Recovered result' });
    await scheduler.waitForTask(acknowledgement.followUpTask.taskId);
    await scheduler.shutdown();
  });

  test('cleans up a result-action waiter on external abort', async () => {
    const { scheduler, task } = await createResultActionHarness();
    const controller = new AbortController();
    const reason = new Error('caller stopped recovery');
    const wait = scheduler.waitForResultAction(task.taskId, { signal: controller.signal });
    await Promise.resolve();

    controller.abort(reason);

    await expect(wait).rejects.toBe(reason);
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
    await scheduler.shutdown();
  });

  test('rejects a pending result-action wait during shutdown', async () => {
    const { scheduler, task } = await createResultActionHarness();
    const wait = scheduler.waitForResultAction(task.taskId);
    await Promise.resolve();

    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(1);
    await scheduler.shutdown();

    await expect(wait).rejects.toThrow('managed orchestration scheduler is shut down');
    expect(scheduler.getDiagnostics().pendingWaiterCount).toBe(0);
  });
});
