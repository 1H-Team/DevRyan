import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const input = (index, overrides = {}) => ({
  idempotencyKey: `handoff-${index}`,
  rootSessionId: 'ses_root',
  dispatchGroupId: 'msg_dispatch_01',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Handoff task ${index}`,
  prompt: `Perform handoff task ${index}.`,
  timeoutAt: null,
  ...overrides,
});

const handoffScope = {
  rootSessionId: 'ses_root',
  fromMode: 'orchestrator',
  toMode: 'builder',
};

const createHarness = async ({
  abortGate = null,
  abortResponses = [],
  abortTimeoutMs,
  attachChildSessions = false,
  persistence,
} = {}) => {
  let taskCounter = 0;
  let leaseCounter = 0;
  const aborts = [];
  const runs = [];
  const scheduler = createManagedTaskScheduler({
    persistence,
    executor: {
      async start(task, control) {
        const result = deferred();
        runs.push({ control, result, task });
        if (attachChildSessions && !task.childSessionId) {
          await control.setChildSessionId(`ses_child_${task.taskId}`);
        }
        await control.markAccepted();
        return await result.promise;
      },
      async abort(task) {
        aborts.push(task.taskId);
        if (abortGate) await abortGate.promise;
        const response = abortResponses.length > 0
          ? abortResponses.shift()
          : { aborted: true };
        if (response instanceof Error) throw response;
        return await response;
      },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return {}; },
    },
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    ...(abortTimeoutMs ? { abortTimeoutMs } : {}),
    now: () => 1_000 + taskCounter,
  });
  await scheduler.initialize();
  return { aborts, runs, scheduler };
};

describe('managed scheduler orchestrator-to-builder handoff', () => {
  test('inspects without mutation and ignores Council and legacy ungrouped work', async () => {
    const { scheduler } = await createHarness();
    const grouped = await scheduler.submit(input(1));
    await scheduler.submit(input(2, {
      dispatchGroupId: null,
      idempotencyKey: 'council-ungrouped',
    }));
    const before = scheduler.getSnapshot();

    expect(await scheduler.inspectAgentHandoff(handoffScope)).toEqual({
      state: 'confirmation_required',
      taskIds: [grouped.taskId],
      failures: [],
    });
    expect(scheduler.getSnapshot()).toEqual(before);
  });

  test('exposes non-blocking active and unreviewed barrier states', async () => {
    const { runs, scheduler } = await createHarness();
    const task = await scheduler.submit(input(1));

    expect(await scheduler.inspectDispatchBarrier('ses_root')).toEqual({
      state: 'active',
      taskIds: [task.taskId],
    });

    runs[0].result.resolve({ status: 'completed' });
    await scheduler.waitForTask(task.taskId);

    expect(await scheduler.inspectDispatchBarrier('ses_root')).toEqual({
      state: 'awaiting_acknowledgement',
      taskIds: [task.taskId],
    });
  });

  test('cancels active work, abandons terminal results, and verifies the barrier is clear', async () => {
    const { aborts, scheduler } = await createHarness();
    const first = await scheduler.submit(input(1));
    const second = await scheduler.submit(input(2));

    const result = await scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-01',
    });

    expect(result).toEqual({
      state: 'clear',
      taskIds: [first.taskId, second.taskId],
      failures: [],
    });
    expect(aborts).toEqual([first.taskId, second.taskId]);
    expect(scheduler.getTask(first.taskId).status).toBe('aborted');
    expect(scheduler.getTask(second.taskId).status).toBe('aborted');
    expect(scheduler.getResultEnvelope(first.taskId).action).toBe('abandon');
    expect(scheduler.getResultEnvelope(second.taskId).action).toBe('abandon');
    expect((await scheduler.inspectDispatchBarrier('ses_root')).state).toBe('clear');
  });

  test('abandons a parked manual-recovery result only through confirmed handoff', async () => {
    const { runs, scheduler } = await createHarness({ attachChildSessions: true });
    const original = await scheduler.submit(input(1));
    runs[0].result.resolve({
      status: 'failed',
      failureReason: 'initial provider failure',
      resumable: true,
    });
    await scheduler.waitForTask(original.taskId);

    const retry = await scheduler.acknowledgeResult(original.taskId, {
      action: 'retry',
      idempotencyKey: 'handoff-manual-recovery-retry',
    });
    runs[1].result.resolve({
      status: 'failed',
      failureReason: 'retry provider failure',
      resumable: true,
    });
    const parked = await scheduler.waitForTask(retry.followUpTask.taskId);

    await expect(scheduler.acknowledgeResult(parked.taskId, {
      action: 'abandon',
      idempotencyKey: 'ordinary-manual-recovery-abandon',
    })).rejects.toMatchObject({ code: 'manual_model_recovery_required' });

    await expect(scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-manual-recovery',
    })).resolves.toEqual({
      state: 'clear',
      taskIds: [parked.taskId],
      failures: [],
    });
    expect(scheduler.getResultEnvelope(parked.taskId).action).toBe('abandon');
    expect((await scheduler.inspectDispatchBarrier('ses_root')).state).toBe('clear');
  });

  test('rejects new grouped starts while cleanup is locked but leaves ungrouped work alone', async () => {
    const abortGate = deferred();
    const { aborts, scheduler } = await createHarness({ abortGate });
    await scheduler.submit(input(1));
    const cleanup = scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-locked',
    });

    while (aborts.length === 0) await Promise.resolve();
    await expect(scheduler.submit(input(2)))
      .rejects.toThrow('orchestrator-to-builder handoff is in progress');
    await expect(scheduler.submit(input(3, { dispatchGroupId: null }))).resolves.toMatchObject({
      dispatchGroupId: null,
    });

    abortGate.resolve();
    await expect(cleanup).resolves.toMatchObject({ state: 'clear' });
  });

  test('coalesces repeated confirmation and rejects conflicting cleanup requests', async () => {
    const abortGate = deferred();
    const { aborts, scheduler } = await createHarness({ abortGate });
    await scheduler.submit(input(1));
    const first = scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-repeat',
    });
    const repeated = scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-repeat',
    });

    while (aborts.length === 0) await Promise.resolve();
    await expect(scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-conflict',
    })).rejects.toThrow('another handoff is already in progress');

    abortGate.resolve();
    expect(await first).toEqual(await repeated);
    expect(aborts).toHaveLength(1);
    await expect(scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-repeat',
    })).resolves.toMatchObject({ state: 'clear', failures: [] });
  });

  test('continues after per-task failures, stays retryable, and always releases the lock', async () => {
    let failSecondAbandon = false;
    const persistence = {
      async load() { return null; },
      async save(state) {
        if (
          failSecondAbandon
          && state.resultEnvelopes.some((envelope) => (
            envelope.taskId === 'dvr_task_2' && envelope.action === 'abandon'
          ))
        ) {
          throw new Error('private persistence failure');
        }
      },
    };
    const { runs, scheduler } = await createHarness({ persistence });
    const first = await scheduler.submit(input(1));
    runs[0].result.resolve({ status: 'completed' });
    await scheduler.waitForTask(first.taskId);
    await scheduler.flush();
    const second = await scheduler.submit(input(2));
    runs[1].result.resolve({ status: 'completed' });
    await scheduler.waitForTask(second.taskId);
    failSecondAbandon = true;

    expect(await scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-partial',
    })).toEqual({
      state: 'blocked',
      taskIds: [first.taskId, second.taskId],
      failures: [{
        taskId: second.taskId,
        code: 'cleanup_failed',
        message: 'Managed task cleanup failed',
      }],
    });
    expect(scheduler.getResultEnvelope(first.taskId).action).toBe('abandon');
    expect(scheduler.getResultEnvelope(second.taskId).action).toBeNull();

    await expect(scheduler.submit(input(3))).resolves.toMatchObject({
      dispatchGroupId: 'msg_dispatch_01',
    });
    await scheduler.cancelTask('dvr_task_3');
    failSecondAbandon = false;
    await expect(scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-partial',
    })).resolves.toMatchObject({ state: 'clear', failures: [] });
  });

  for (const [scenario, firstAbort, abortTimeoutMs] of [
    ['provider rejects the abort', new Error('private provider failure'), undefined],
    ['provider declines the abort', { aborted: false }, undefined],
    ['provider abort times out', new Promise(() => {}), 5],
  ]) {
    test(`never clears while ${scenario} and retries after confirmed termination`, async () => {
      const { scheduler } = await createHarness({
        abortResponses: [firstAbort, { aborted: true }],
        abortTimeoutMs,
      });
      const task = await scheduler.submit(input(1));

      expect(await scheduler.confirmAgentHandoff({
        ...handoffScope,
        idempotencyKey: `switch-unconfirmed-${scenario}`,
      })).toEqual({
        state: 'blocked',
        taskIds: [task.taskId],
        failures: [{
          taskId: task.taskId,
          code: 'cleanup_failed',
          message: 'Managed task cleanup failed',
        }],
      });
      expect(scheduler.getTask(task.taskId).status).toBe('running');
      expect(scheduler.getDiagnostics().activeLaunchCount).toBe(1);
      expect(scheduler.getResultEnvelope(task.taskId)).toBeNull();

      await expect(scheduler.confirmAgentHandoff({
        ...handoffScope,
        idempotencyKey: `switch-unconfirmed-${scenario}`,
      })).resolves.toMatchObject({ state: 'clear', failures: [] });
      expect(scheduler.getTask(task.taskId).status).toBe('aborted');
      expect(scheduler.getResultEnvelope(task.taskId).action).toBe('abandon');
    });
  }

  test('re-aborts a live interrupted launch left by ordinary cancellation before clearing', async () => {
    const { aborts, scheduler } = await createHarness({
      abortResponses: [{ aborted: false }, { aborted: true }],
    });
    const task = await scheduler.submit(input(1));

    await expect(scheduler.cancelTask(task.taskId)).resolves.toMatchObject({
      status: 'interrupted',
    });
    expect(scheduler.getDiagnostics().activeLaunchCount).toBe(1);

    await expect(scheduler.confirmAgentHandoff({
      ...handoffScope,
      idempotencyKey: 'switch-after-ordinary-cancel',
    })).resolves.toMatchObject({ state: 'clear', failures: [] });
    expect(aborts).toEqual([task.taskId, task.taskId]);
    expect(scheduler.getResultEnvelope(task.taskId).action).toBe('abandon');
  });
});
