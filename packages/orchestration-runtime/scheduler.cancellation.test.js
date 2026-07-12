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
  idempotencyKey: `cancel-${index}`,
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Cancel task ${index}`,
  prompt: `Perform cancel task ${index}.`,
  timeoutAt: null,
  ...overrides,
});

const createHarness = async () => {
  let taskCounter = 0;
  let leaseCounter = 0;
  const runs = [];
  const aborts = [];
  const scheduler = createManagedTaskScheduler({
    executor: {
      async start(task, control) {
        const run = { task, control, result: deferred() };
        runs.push(run);
        await control.setChildSessionId(`ses_child_${task.taskId}`);
        await control.markAccepted();
        return await run.result.promise;
      },
      async abort(task) {
        aborts.push(task.taskId);
        return { aborted: true };
      },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult(task) {
        return {
          recoverablePreview: `partial ${task.taskId}`,
          canonicalRefs: [{ type: 'message', id: `msg_${task.taskId}` }],
        };
      },
    },
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    now: () => 1_000,
  });
  await scheduler.initialize();
  return { aborts, runs, scheduler };
};

describe('managed scheduler cancellation', () => {
  test('cancels a queued task without touching a running child', async () => {
    const { aborts, scheduler } = await createHarness();
    const tasks = [];
    for (let index = 1; index <= 4; index += 1) {
      tasks.push(await scheduler.submit(input(index)));
    }

    const cancelled = await scheduler.cancelTask(tasks[3].taskId, {
      reason: 'No longer needed',
    });

    expect(cancelled.status).toBe('aborted');
    expect(cancelled.failureReason).toBe('No longer needed');
    expect(aborts).toEqual([]);
    expect(scheduler.listTasks().slice(0, 3).every((task) => task.status === 'running')).toBe(true);
    expect(scheduler.getResultEnvelope(tasks[3].taskId).status).toBe('aborted');
  });

  test('aborts only the selected child, retains partial output, and ignores late completion', async () => {
    const { aborts, runs, scheduler } = await createHarness();
    const first = await scheduler.submit(input(1));
    const second = await scheduler.submit(input(2));

    const cancelled = await scheduler.cancelTask(first.taskId, { reason: 'Manual stop' });

    expect(aborts).toEqual([first.taskId]);
    expect(cancelled.status).toBe('aborted');
    expect(cancelled.partial).toBe(true);
    expect(cancelled.recoverablePreview).toBe(`partial ${first.taskId}`);
    expect(cancelled.canonicalRefs).toEqual([
      { type: 'message', id: `msg_${first.taskId}` },
    ]);
    expect(scheduler.getTask(second.taskId).status).toBe('running');

    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'late duplicate' });
    await scheduler.flush();
    expect(scheduler.getTask(first.taskId).status).toBe('aborted');
    expect(scheduler.listResultEnvelopes().filter((item) => item.taskId === first.taskId)).toHaveLength(1);
  });

  test('cascades only through explicit managed descendants', async () => {
    const { aborts, scheduler } = await createHarness();
    const parent = await scheduler.submit(input(1));
    const child = await scheduler.submit(input(2, { parentTaskId: parent.taskId }));
    const sibling = await scheduler.submit(input(3));

    const cancelled = await scheduler.cancelTask(parent.taskId, {
      cascade: true,
      reason: 'Parent stopped',
    });

    expect(cancelled.map((task) => task.taskId)).toEqual([child.taskId, parent.taskId]);
    expect(aborts).toEqual([child.taskId, parent.taskId]);
    expect(scheduler.getTask(sibling.taskId).status).toBe('running');
  });

  test('is idempotent for repeated cancellation', async () => {
    const { aborts, scheduler } = await createHarness();
    const task = await scheduler.submit(input(1));

    const first = await scheduler.cancelTask(task.taskId, { reason: 'Stop once' });
    const second = await scheduler.cancelTask(task.taskId, { reason: 'Stop twice' });

    expect(second).toEqual(first);
    expect(aborts).toEqual([task.taskId]);
    expect(scheduler.listResultEnvelopes()).toHaveLength(1);
  });
});
