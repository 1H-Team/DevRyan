import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';
import { toManagedTaskEvent } from './contract.js';
import { MANAGED_TASK_TIMEOUT_REASON_PREFIX } from './provider-retry-policy.js';

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
    const settled = scheduler.getTask(task.taskId);
    expect(settled).toMatchObject({
      status: 'failed',
      failureReason: `${MANAGED_TASK_TIMEOUT_REASON_PREFIX}1500`,
      partial: true,
      recoverablePreview: 'partial before timeout',
    });
    expect(toManagedTaskEvent(settled).properties.task.failureKind).toBe('deadline_exceeded');
    expect(clock.count()).toBe(0);
  });

  test('times out one of four concurrent tasks without aborting unrelated children', async () => {
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
      status: 'failed',
      failureReason: 'Managed task timed out at 1250',
    });
    expect(aborts).toEqual([tasks[3].taskId]);
  });

  test('bounds a hung provider abort and settles interrupted instead of deadlocking', async () => {
    const never = new Promise(() => {});
    let abortSignal = null;
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) { await control.markAccepted(); return await never; },
        async abort(_task, options) {
          abortSignal = options.signal;
          return await never;
        },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      abortTimeoutMs: 10,
      createTaskId: () => 'dvr_task_hung_abort',
      createLeaseToken: () => 'dvr_lease_hung_abort',
      logger: { warn() {} },
      now: () => 1_000,
    });
    const task = await scheduler.submit(input(1));

    const settled = await scheduler.cancelTask(task.taskId, { reason: 'Manual stop' });

    expect(settled.status).toBe('interrupted');
    expect(settled.failureReason).toBe('Manual stop');
    expect(abortSignal.aborted).toBe(true);
  });

  test('keeps a timed-out canonical child resumable when abort and recovery do not settle', async () => {
    const clock = createClock();
    const never = new Promise(() => {});
    const warnings = [];
    const resumedTasks = [];
    let abortSignal = null;
    let taskCounter = 0;
    let leaseCounter = 0;
    const scheduler = createManagedTaskScheduler({
      executor: {
        async start(_task, control) {
          await control.setChildSessionId('ses_timeout_child');
          await control.markAccepted();
          return await never;
        },
        async resume(task, control) {
          resumedTasks.push(task);
          await control.markAccepted();
          return {
            status: 'completed',
            recoverablePreview: 'late tool output recovered from canonical child',
          };
        },
        async abort(_task, options) {
          abortSignal = options.signal;
          return await never;
        },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() {
          throw new Error('The operation was aborted due to timeout');
        },
      },
      abortTimeoutMs: 10,
      now: clock.now,
      scheduleTimeout: clock.schedule,
      cancelTimeout: clock.cancel,
      createTaskId: () => `dvr_task_timeout_recovery_${++taskCounter}`,
      createLeaseToken: () => `dvr_lease_timeout_recovery_${++leaseCounter}`,
      logger: { warn: (...args) => warnings.push(args) },
    });

    const task = await scheduler.submit(input(1, { timeoutAt: 1_500 }));
    await clock.advance(500);
    await clock.advance(10);
    const settled = await scheduler.waitForTask(task.taskId);
    const envelope = scheduler.getResultEnvelope(task.taskId);

    expect(abortSignal.aborted).toBe(true);
    expect(settled).toMatchObject({
      childSessionId: 'ses_timeout_child',
      status: 'interrupted',
      failureReason: 'Managed task timed out at 1500',
      partial: false,
    });
    expect(envelope).toMatchObject({
      childSessionId: 'ses_timeout_child',
      failureReason: 'Managed task timed out at 1500',
      resumable: true,
    });
    expect(warnings).toContainEqual([
      '[ManagedOrchestration] Provider abort cleanup was not confirmed',
      {
        taskId: task.taskId,
        primaryReason: 'Managed task timed out at 1500',
        cleanupFailure: 'Provider abort did not settle within 10ms',
      },
    ]);

    const recovery = await scheduler.acknowledgeResult(task.taskId, {
      action: 'resume',
      idempotencyKey: 'resume-timeout-child',
    });
    const recovered = await scheduler.waitForTask(recovery.followUpTask.taskId);

    expect(recovery.followUpTask).toMatchObject({
      childSessionId: 'ses_timeout_child',
      executionKind: 'resume',
      priorTaskId: task.taskId,
    });
    expect(resumedTasks).toHaveLength(1);
    expect(resumedTasks[0].childSessionId).toBe('ses_timeout_child');
    expect(recovered).toMatchObject({
      status: 'completed',
      recoverablePreview: 'late tool output recovered from canonical child',
    });
  });
});
