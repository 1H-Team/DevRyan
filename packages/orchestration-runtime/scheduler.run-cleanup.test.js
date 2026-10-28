import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';

const input = (overrides = {}) => ({
  idempotencyKey: 'cleanup-task',
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'designer',
  variant: null,
  label: 'Cleanup task',
  prompt: 'Start a server and check it.',
  timeoutAt: null,
  ...overrides,
});

// A scheduler whose executor runs one child session to `status`, with a
// persistence that keeps every snapshot (and can be reloaded).
const harness = ({ stopAttemptRuns, load = null, childSession = 'ses_child', status = 'completed', timers, onRunCleanup } = {}) => {
  let taskCounter = 0, leaseCounter = 0;
  const snapshots = [];
  const scheduler = createManagedTaskScheduler({
    executor: {
      async start(_task, control) {
        if (childSession) await control.setChildSessionId(childSession);
        await control.markAccepted();
        return { status, recoverablePreview: 'done', canonicalRefs: [] };
      },
      async abort() {},
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return { recoverablePreview: '', canonicalRefs: [] }; },
    },
    persistence: {
      async load() { return load; },
      async save(snapshot) { snapshots.push(structuredClone(snapshot)); },
    },
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    ...(stopAttemptRuns ? { stopAttemptRuns } : {}),
    ...(onRunCleanup ? { onRunCleanup } : {}),
    ...(timers ? { scheduleTimeout: timers.schedule, cancelTimeout: timers.cancel } : {}),
  });
  return { scheduler, snapshots };
};
const settledCleanup = async (scheduler, taskId, state = 'done') => {
  for (let tries = 0; tries < 400 && scheduler.getResultEnvelope(taskId)?.runCleanup?.state !== state; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return scheduler.getResultEnvelope(taskId)?.runCleanup;
};
// Timers the test fires by hand.
const manualTimers = () => {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    schedule: (callback, delayMs) => { const id = next++; pending.set(id, { callback, delayMs }); return id; },
    cancel: (id) => { pending.delete(id); },
    fire(predicate = () => true) {
      for (const [id, timer] of [...pending]) if (predicate(timer)) { pending.delete(id); timer.callback(); }
    },
  };
};

describe('managed task run cleanup', () => {
  test('a settled attempt records a durable cleanup intent and stops its runs once the commit is released', async () => {
    const calls = [], observed = [];
    let scheduler, snapshots;
    const stopAttemptRuns = async (request) => {
      calls.push(request);
      // Durable before any run is stopped.
      expect(snapshots.at(-1).resultEnvelopes.at(-1).runCleanup).toMatchObject({ state: 'pending', taskId: request.taskId });
      // Outside the exclusive section: a call that needs it completes (it would deadlock inside).
      await expect(scheduler.verifyTaskDispatch(request.taskId, request.leaseToken)).rejects.toThrow();
      return { stopped: 2 };
    };
    ({ scheduler, snapshots } = harness({ stopAttemptRuns, onRunCleanup: (row) => observed.push(row) }));
    await scheduler.initialize();
    const submitted = await scheduler.submit(input());
    const settled = await scheduler.waitForTask(submitted.taskId);
    expect(settled.status).toBe('completed');
    expect(await settledCleanup(scheduler, submitted.taskId)).toEqual({ state: 'done', taskId: submitted.taskId, leaseToken: settled.leaseToken,
      childSessionId: 'ses_child', attempts: 0, stopped: 2 });
    expect(calls).toEqual([{ childSessionId: 'ses_child', directory: '/workspace', taskId: submitted.taskId, leaseToken: settled.leaseToken,
      settledAt: scheduler.getResultEnvelope(submitted.taskId).createdAt, reason: 'task_settled' }]);
    expect(observed).toEqual([expect.objectContaining({ taskId: submitted.taskId, rootSessionId: 'ses_root', state: 'done', stopped: 2 })]);
    // Cleanup bookkeeping does not advance the result's collection sequence.
    expect(scheduler.getResultEnvelope(submitted.taskId).sequence).toBe(snapshots.find((snapshot) => snapshot.resultEnvelopes.length)
      .resultEnvelopes.at(-1).sequence);
    await scheduler.shutdown();
  });

  test('a failed cleanup stays visible, is retried with backoff and then completes', async () => {
    const timers = manualTimers(), observed = [];
    let failures = 1;
    const { scheduler } = harness({ timers, onRunCleanup: (row) => observed.push(row.state),
      stopAttemptRuns: async () => {
        if (failures-- > 0) throw Object.assign(new Error('host not ready'), { code: 'mutation_runtime_unavailable' });
        return { stopped: 1 };
      } });
    await scheduler.initialize();
    const submitted = await scheduler.submit(input());
    await scheduler.waitForTask(submitted.taskId);
    expect(await settledCleanup(scheduler, submitted.taskId, 'failed')).toMatchObject({ state: 'failed', code: 'mutation_runtime_unavailable', attempts: 1 });
    const retries = [...timers.pending.values()].filter((timer) => timer.delayMs === 5_000);
    expect(retries).toHaveLength(1);
    timers.fire((timer) => timer.delayMs === 5_000);
    const done = await settledCleanup(scheduler, submitted.taskId);
    expect(done).toMatchObject({ state: 'done', attempts: 1, stopped: 1 });
    expect(done.code).toBeUndefined();
    expect(observed).toEqual(['failed', 'done']);
    await scheduler.shutdown();
  });

  test('an unfinished cleanup survives a restart and completes after it', async () => {
    let release;
    const first = harness({ stopAttemptRuns: () => new Promise((resolve) => { release = resolve; }) });
    await first.scheduler.initialize();
    const submitted = await first.scheduler.submit(input());
    await first.scheduler.waitForTask(submitted.taskId);
    await first.scheduler.shutdown();
    release?.({ stopped: 0 });
    const persisted = first.snapshots.at(-1);
    expect(persisted.resultEnvelopes.at(-1).runCleanup.state).toBe('pending');
    const calls = [];
    const second = harness({ load: persisted, stopAttemptRuns: async (request) => { calls.push(request.taskId); return { stopped: 1 }; } });
    await second.scheduler.initialize();
    expect(await settledCleanup(second.scheduler, submitted.taskId)).toMatchObject({ state: 'done', stopped: 1 });
    expect(calls).toEqual([submitted.taskId]);
    await second.scheduler.shutdown();
  });

  test('no intent without a child session or without the host capability', async () => {
    const withoutChild = harness({ childSession: null, status: 'failed', stopAttemptRuns: async () => ({ stopped: 0 }) });
    await withoutChild.scheduler.initialize();
    const failed = await withoutChild.scheduler.submit(input());
    await withoutChild.scheduler.waitForTask(failed.taskId);
    expect(withoutChild.scheduler.getResultEnvelope(failed.taskId).runCleanup).toBeUndefined();
    await withoutChild.scheduler.shutdown();
    const withoutHost = harness();
    await withoutHost.scheduler.initialize();
    const completed = await withoutHost.scheduler.submit(input());
    await withoutHost.scheduler.waitForTask(completed.taskId);
    expect(withoutHost.scheduler.getResultEnvelope(completed.taskId).runCleanup).toBeUndefined();
    await withoutHost.scheduler.shutdown();
  });

  test('childAttempt names the active attempt, none once settled, unknown before initialization', async () => {
    let finish, observed;
    const { scheduler } = harness();
    expect(scheduler.childAttempt('ses_child', '/workspace')).toEqual({ state: 'unknown' });
    const running = createManagedTaskScheduler({
      executor: {
        async start(task, control) {
          await control.setChildSessionId('ses_child');
          await control.markAccepted();
          observed = running.childAttempt('ses_child', '/workspace');
          await new Promise((resolve) => { finish = resolve; });
          return { status: 'completed', recoverablePreview: '', canonicalRefs: [] };
        },
        async abort() {},
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return { recoverablePreview: '', canonicalRefs: [] }; },
      },
      createTaskId: () => 'dvr_task_attempt',
      createLeaseToken: () => 'dvr_lease_attempt',
    });
    await running.initialize();
    const submitted = await running.submit(input());
    for (let tries = 0; tries < 400 && !finish; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(observed).toEqual({ taskId: submitted.taskId, leaseToken: 'dvr_lease_attempt' });
    expect(running.childAttempt('ses_other', '/workspace')).toBeNull();
    expect(running.childAttempt('ses_child', '/elsewhere')).toBeNull();
    finish();
    await running.waitForTask(submitted.taskId);
    expect(running.childAttempt('ses_child', '/workspace')).toEqual({ state: 'none' });
    await running.shutdown();
  });
});
