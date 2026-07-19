import { describe, expect, test } from 'bun:test';

import {
  compareManagedTaskQueueOrder,
  createManagedTaskScheduler,
} from './scheduler.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createHarness = async () => {
  let taskCounter = 0;
  let leaseCounter = 0;
  const runs = [];
  const executor = {
    start: (task, taskControl) => {
      const run = { task, taskControl, result: deferred() };
      runs.push(run);
      return run.result.promise;
    },
    resume: () => {
      throw new Error('resume not expected');
    },
    abort: async () => undefined,
    reconcile: async () => ({ state: 'unavailable' }),
    readRecoverableResult: async () => ({ preview: '', canonicalRefs: [] }),
  };
  const published = [];
  const scheduler = createManagedTaskScheduler({
    executor,
    now: () => 1_000,
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    publishEvent: (event) => published.push(event),
  });
  await scheduler.initialize();
  return { executor, published, runs, scheduler };
};

const submitInput = (index, overrides = {}) => ({
  idempotencyKey: `task-${index}`,
  rootSessionId: 'ses_root',
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

describe('managed scheduler admission', () => {
  test('admits every submitted task immediately without a scheduler concurrency cap', async () => {
    const { runs, scheduler } = await createHarness();

    const tasks = [];
    for (let index = 1; index <= 5; index += 1) {
      tasks.push(await scheduler.submit(submitInput(index)));
    }

    expect(runs.map((run) => run.task.taskId)).toEqual([
      'dvr_task_1',
      'dvr_task_2',
      'dvr_task_3',
      'dvr_task_4',
      'dvr_task_5',
    ]);
    expect(scheduler.getTask('dvr_task_1').status).toBe('starting');
    expect(scheduler.getTask('dvr_task_3').status).toBe('starting');
    expect(scheduler.getTask('dvr_task_4').status).toBe('starting');
    expect(scheduler.getTask('dvr_task_5').status).toBe('starting');

    await runs[1].taskControl.markAccepted();
    expect(scheduler.getTask('dvr_task_2').status).toBe('running');
    expect(scheduler.getTask('dvr_task_4').status).toBe('starting');
  });

  test('admits every child across independent roots without cross-root coordination', async () => {
    const { runs, scheduler } = await createHarness();

    await Promise.all([
      ...Array.from({ length: 4 }, (_, index) => (
        scheduler.submit(submitInput(index + 1))
      )),
      ...Array.from({ length: 4 }, (_, index) => (
        scheduler.submit(submitInput(index + 5, {
          rootSessionId: 'ses_second_root',
        }))
      )),
    ]);

    expect(runs.map((run) => run.task.rootSessionId)).toEqual([
      'ses_root',
      'ses_root',
      'ses_root',
      'ses_root',
      'ses_second_root',
      'ses_second_root',
      'ses_second_root',
      'ses_second_root',
    ]);
    expect(scheduler.listTasks().every((task) => task.status === 'starting')).toBe(true);
  });

  test('returns one task and dispatch for repeated idempotency keys', async () => {
    const { runs, scheduler } = await createHarness();

    const [first, second] = await Promise.all([
      scheduler.submit(submitInput(1)),
      scheduler.submit(submitInput(1)),
    ]);

    expect(first.taskId).toBe(second.taskId);
    expect(scheduler.listTasks()).toHaveLength(1);
    expect(runs).toHaveLength(1);
  });

  test('starts every task when many submissions race', async () => {
    const { runs, scheduler } = await createHarness();

    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      scheduler.submit(submitInput(index + 1))
    )));

    expect(runs).toHaveLength(20);
    expect(scheduler.listTasks().every((task) => task.status === 'starting')).toBe(true);
  });

  test('launches later roots without waiting for earlier work to settle', async () => {
    const { runs, scheduler } = await createHarness();

    for (let index = 1; index <= 4; index += 1) {
      await scheduler.submit(submitInput(index));
    }
    await scheduler.submit(submitInput(5, {
      rootSessionId: 'ses_newer_root',
      idempotencyKey: 'newer-root-task',
    }));

    expect(runs.map((run) => run.task.taskId)).toEqual([
      'dvr_task_1',
      'dvr_task_2',
      'dvr_task_3',
      'dvr_task_4',
      'dvr_task_5',
    ]);
    expect(scheduler.getTask('dvr_task_4').status).toBe('starting');
    expect(scheduler.getTask('dvr_task_5').status).toBe('starting');
  });

  test('isolates builder and orchestrator graph ownership until live work settles', async () => {
    const { runs, scheduler } = await createHarness();

    const builder = await scheduler.submit(submitInput(1, { mode: 'builder' }));
    await expect(scheduler.submit(submitInput(2, { mode: 'orchestrator' })))
      .rejects.toThrow('root ses_root is leased to builder mode');
    await expect(scheduler.releaseModeLease('ses_root', 'builder'))
      .rejects.toThrow('cannot release mode lease while managed tasks are active');

    await runs[0].taskControl.markAccepted();
    runs[0].result.resolve({ status: 'completed' });
    await scheduler.flush();

    expect(scheduler.getTask(builder.taskId).status).toBe('completed');
    const orchestrator = await scheduler.submit(submitInput(2, { mode: 'orchestrator' }));
    expect(orchestrator.mode).toBe('orchestrator');
  });

  test('rejects a parent from another managed root graph with a useful error', async () => {
    const { scheduler } = await createHarness();
    const parent = await scheduler.submit(submitInput(1));

    await expect(scheduler.submit(submitInput(2, {
      rootSessionId: 'ses_other_root',
      parentTaskId: parent.taskId,
    }))).rejects.toThrow(
      `parent task ${parent.taskId} does not belong to the requested root graph`,
    );
  });

  test('orders queued records by sequence, creation time, then task ID', () => {
    const make = (sequence, createdAt, taskId) => ({ sequence, createdAt, taskId });
    const records = [
      make(2, 1_000, 'dvr_task_c'),
      make(1, 2_000, 'dvr_task_b'),
      make(1, 1_000, 'dvr_task_c'),
      make(1, 1_000, 'dvr_task_a'),
    ];

    expect(records.sort(compareManagedTaskQueueOrder).map((task) => task.taskId)).toEqual([
      'dvr_task_a',
      'dvr_task_c',
      'dvr_task_b',
      'dvr_task_c',
    ]);
  });
});
