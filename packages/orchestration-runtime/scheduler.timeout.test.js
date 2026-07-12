import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';

const input = (index, overrides = {}) => ({
  idempotencyKey: `timeout-${index}`,
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Timeout ${index}`,
  prompt: `Timeout task ${index}.`,
  timeoutAt: null,
  ...overrides,
});

const createClock = () => {
  let now = 1_000;
  let timerId = 0;
  const timers = new Map();
  return {
    now: () => now,
    schedule(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, dueAt: now + delay });
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

describe('managed scheduler timeouts', () => {
  test('aborts only the timed-out active task and records a failed result', async () => {
    const clock = createClock();
    const aborts = [];
    const never = new Promise(() => {});
    let taskCounter = 0;
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) {
          await control.setChildSessionId('ses_child');
          await control.markAccepted();
          return await never;
        },
        async abort(task) { aborts.push(task.taskId); return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() {
          return { recoverablePreview: 'partial before timeout' };
        },
      },
      now: clock.now,
      scheduleTimeout: clock.schedule,
      cancelTimeout: clock.cancel,
      createTaskId: () => `dvr_task_${++taskCounter}`,
      createLeaseToken: () => `dvr_lease_${taskCounter}`,
    });

    const task = await scheduler.submit(input(1, { timeoutAt: 1_500 }));
    await clock.advance(500);
    await scheduler.flush();

    expect(aborts).toEqual([task.taskId]);
    expect(scheduler.getTask(task.taskId)).toMatchObject({
      status: 'failed',
      failureReason: 'Managed task timed out at 1500',
      partial: true,
      recoverablePreview: 'partial before timeout',
    });
    expect(clock.count()).toBe(0);
  });

  test('expires a queued task without aborting an unrelated child', async () => {
    const clock = createClock();
    const aborts = [];
    const never = new Promise(() => {});
    let taskCounter = 0;
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) { await control.markAccepted(); return await never; },
        async abort(task) { aborts.push(task.taskId); return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      now: clock.now,
      scheduleTimeout: clock.schedule,
      cancelTimeout: clock.cancel,
      createTaskId: () => `dvr_task_${++taskCounter}`,
      createLeaseToken: () => `dvr_lease_${taskCounter}`,
    });
    const tasks = [];
    for (let index = 1; index <= 4; index += 1) {
      tasks.push(await scheduler.submit(input(index, {
        timeoutAt: index === 4 ? 1_250 : null,
      })));
    }

    await clock.advance(250);
    await scheduler.flush();

    expect(scheduler.getTask(tasks[3].taskId)).toMatchObject({
      status: 'aborted',
      failureReason: 'Managed task timed out at 1250',
    });
    expect(aborts).toEqual([]);
  });

  test('bounds a hung provider abort and settles interrupted instead of deadlocking', async () => {
    const never = new Promise(() => {});
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) { await control.markAccepted(); return await never; },
        async abort() { return await never; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      abortTimeoutMs: 10,
      createTaskId: () => 'dvr_task_hung_abort',
      createLeaseToken: () => 'dvr_lease_hung_abort',
      now: () => 1_000,
    });
    const task = await scheduler.submit(input(1));

    const settled = await scheduler.cancelTask(task.taskId, { reason: 'Manual stop' });

    expect(settled.status).toBe('interrupted');
    expect(settled.failureReason).toBe('Provider abort did not settle within 10ms');
  });
});
