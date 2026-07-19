import { describe, expect, test } from 'bun:test';

import { createManagedOpenCodeExecutor } from './open-code-executor.js';
import { createManagedTaskScheduler } from './scheduler.js';

const input = {
  idempotencyKey: 'lease-task',
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: 'Lease task',
  prompt: 'Test the starting lease.',
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
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    schedule(callback, delay) {
      const timerId = ++id;
      timers.set(timerId, { callback, dueAt: now + delay });
      return timerId;
    },
    cancel(timerId) { timers.delete(timerId); },
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt);
      for (const [timerId, timer] of due) {
        timers.delete(timerId);
        timer.callback();
      }
      await Promise.resolve();
    },
    count: () => timers.size,
  };
};

describe('managed scheduler starting leases and shutdown', () => {
  test('reconciles a live child after the 60-second starting lease', async () => {
    const clock = createClock();
    let reconcileCount = 0;
    let observeCount = 0;
    const never = new Promise(() => {});
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) {
          await control.setChildSessionId('ses_live_child');
          return await never;
        },
        async observe() {
          observeCount += 1;
          return { status: 'completed', recoverablePreview: 'settled after reconcile' };
        },
        async abort() { return { aborted: true }; },
        async reconcile() {
          reconcileCount += 1;
          return { state: 'live' };
        },
        async readRecoverableResult() { return {}; },
      },
      now: clock.now,
      scheduleTimeout: clock.schedule,
      cancelTimeout: clock.cancel,
      createTaskId: () => 'dvr_task_lease',
      createLeaseToken: () => 'dvr_lease_lease',
    });
    const task = await scheduler.submit(input);

    expect(scheduler.getTask(task.taskId).status).toBe('starting');
    await clock.advance(60_000);
    await scheduler.flush();
    const settled = await scheduler.waitForTask(task.taskId);

    expect(reconcileCount).toBe(1);
    expect(observeCount).toBe(1);
    expect(settled.status).toBe('completed');
    expect(clock.count()).toBe(0);
  });

  test('interrupts a starting task when ownership cannot be proven', async () => {
    const clock = createClock();
    const never = new Promise(() => {});
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start() { return await never; },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() {
          return { recoverablePreview: 'partial before lost ownership' };
        },
      },
      now: clock.now,
      scheduleTimeout: clock.schedule,
      cancelTimeout: clock.cancel,
      createTaskId: () => 'dvr_task_lost',
      createLeaseToken: () => 'dvr_lease_lost',
    });
    const task = await scheduler.submit(input);

    await clock.advance(60_000);
    await scheduler.flush();

    expect(scheduler.getTask(task.taskId)).toMatchObject({
      status: 'interrupted',
      partial: true,
      recoverablePreview: 'partial before lost ownership',
    });
  });

  test('discards a child created after its starting lease loses ownership without prompting it', async () => {
    const clock = createClock();
    const creation = deferred();
    const lateSideEffect = deferred();
    const calls = [];
    const executor = createManagedOpenCodeExecutor({
      transport: {
        async createSession() {
          calls.push('create');
          return await creation.promise;
        },
        async promptSession() {
          calls.push('prompt');
          lateSideEffect.resolve();
        },
        async readSession() { return null; },
        async readStatus() { return { type: 'idle' }; },
        async readMessages() {
          return [{
            info: {
              id: 'msg_late',
              role: 'assistant',
              finish: 'stop',
              time: { completed: 2_000 },
            },
            parts: [{ type: 'text', text: 'must not run' }],
          }];
        },
        async abortSession() {
          calls.push('abort');
          return true;
        },
        async deleteSession() {
          calls.push('delete');
          lateSideEffect.resolve();
          return true;
        },
      },
      sleep: async () => undefined,
      idleStablePolls: 1,
    });
    const scheduler = createManagedTaskScheduler({
      executor,
      now: clock.now,
      scheduleTimeout: clock.schedule,
      cancelTimeout: clock.cancel,
      createTaskId: () => 'dvr_task_late_child',
      createLeaseToken: () => 'dvr_lease_late_child',
    });
    const task = await scheduler.submit({
      ...input,
      idempotencyKey: 'late-child',
    });

    await clock.advance(60_000);
    await scheduler.flush();
    expect(scheduler.getTask(task.taskId).status).toBe('interrupted');

    creation.resolve({ id: 'ses_late_child' });
    await lateSideEffect.promise;

    expect(calls).toEqual(['create', 'abort', 'delete']);
    expect(scheduler.getTask(task.taskId).status).toBe('interrupted');
  });

  test('shutdown clears owned timers/waiters and preserves active records for restart', async () => {
    const clock = createClock();
    let executorShutdownCount = 0;
    const never = new Promise(() => {});
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start() { return await never; },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
        async shutdown() { executorShutdownCount += 1; },
      },
      now: clock.now,
      scheduleTimeout: clock.schedule,
      cancelTimeout: clock.cancel,
      createTaskId: () => 'dvr_task_shutdown',
      createLeaseToken: () => 'dvr_lease_shutdown',
    });
    const task = await scheduler.submit({ ...input, timeoutAt: 100_000 });
    const waiter = scheduler.waitForTask(task.taskId);

    await scheduler.shutdown();

    await expect(waiter).rejects.toThrow('managed orchestration scheduler is shut down');
    expect(executorShutdownCount).toBe(1);
    expect(clock.count()).toBe(0);
    expect(scheduler.getTask(task.taskId).status).toBe('starting');
    expect(scheduler.getDiagnostics()).toMatchObject({
      pendingTimeoutCount: 0,
      pendingLeaseCount: 0,
      pendingWaiterCount: 0,
      activeLaunchCount: 0,
      shutDown: true,
    });
    await expect(scheduler.submit({ ...input, idempotencyKey: 'after-shutdown' }))
      .rejects.toThrow('managed orchestration scheduler is shut down');
  });

  test('closes the executor even when the final durable save fails', async () => {
    let saveCount = 0;
    let executorShutdownCount = 0;
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() { return null; },
        async save() {
          saveCount += 1;
          if (saveCount > 1) throw new Error('shutdown disk failure');
        },
      },
      executor: {
        async start() { throw new Error('must not dispatch'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
        async shutdown() { executorShutdownCount += 1; },
      },
    });
    await scheduler.initialize();

    await expect(scheduler.shutdown()).rejects.toThrow('shutdown disk failure');
    expect(executorShutdownCount).toBe(1);
  });

  test('does not overwrite a durable ledger when shutdown precedes initialization', async () => {
    let saveCount = 0;
    let executorShutdownCount = 0;
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() { throw new Error('load must not run'); },
        async save() { saveCount += 1; },
      },
      executor: {
        async start() { throw new Error('must not dispatch'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
        async shutdown() { executorShutdownCount += 1; },
      },
    });

    await scheduler.shutdown();

    expect(saveCount).toBe(0);
    expect(executorShutdownCount).toBe(1);
  });
});
