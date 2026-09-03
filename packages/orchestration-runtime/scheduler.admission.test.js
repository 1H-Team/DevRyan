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
  test('rejects read-only Designer while accepting Explorer and writable Designer work', async () => {
    const { published, runs, scheduler } = await createHarness();

    await expect(scheduler.submit(submitInput(1, {
      readOnly: true,
      agent: 'designer',
    }))).rejects.toMatchObject({
      code: 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED',
    });

    const explorer = await scheduler.submit(submitInput(2, { readOnly: true }));
    const designer = await scheduler.submit(submitInput(3, { agent: 'designer' }));

    expect(explorer).toMatchObject({ agent: 'explorer', readOnly: true });
    expect(designer).toMatchObject({ agent: 'designer', readOnly: false });
    expect(runs.map((run) => run.task.agent)).toEqual(['explorer', 'designer']);
    expect(published).toHaveLength(4);
  });

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

const createManualTimers = () => {
  const timers = new Map();
  let nextId = 0;
  return {
    timers,
    scheduleTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    cancelTimeout(id) {
      timers.delete(id);
    },
    pendingByDelay(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay);
    },
    runByDelay(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      if (!entry) throw new Error(`No timer scheduled for ${delay}ms`);
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    },
  };
};

const createMemoryPersistence = () => {
  let snapshot = null;
  let saveCount = 0;
  return {
    async load() { return snapshot ? structuredClone(snapshot) : null; },
    async save(value) { snapshot = structuredClone(value); saveCount += 1; },
    get saveCount() { return saveCount; },
  };
};

const createLaunchAdmissionHarness = async ({
  admitLaunch,
  persistence = createMemoryPersistence(),
  now = () => 1_000,
  taskIdOffset = 0,
} = {}) => {
  let taskCounter = taskIdOffset;
  let leaseCounter = taskIdOffset;
  const runs = [];
  const aborts = [];
  const warnings = [];
  const timers = createManualTimers();
  const executor = {
    start: (task, taskControl) => {
      const run = { task, taskControl, result: deferred() };
      runs.push(run);
      return run.result.promise;
    },
    resume: () => {
      throw new Error('resume not expected');
    },
    abort: async (task) => {
      aborts.push(task.taskId);
      return { aborted: true };
    },
    reconcile: async () => ({ state: 'unavailable' }),
    readRecoverableResult: async () => ({ preview: '', canonicalRefs: [] }),
  };
  const scheduler = createManagedTaskScheduler({
    executor,
    persistence,
    now,
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    scheduleTimeout: timers.scheduleTimeout,
    cancelTimeout: timers.cancelTimeout,
    logger: { warn: (...args) => warnings.push(args) },
    ...(admitLaunch ? { admitLaunch } : {}),
  });
  await scheduler.initialize();
  return { aborts, persistence, runs, scheduler, timers, warnings };
};

const capAt = (limit) => ({ activeCount }) => (
  activeCount >= limit
    ? { admit: false, reason: 'capacity', limit, retryInMs: 5_000 }
    : { admit: true }
);

describe('managed scheduler launch admission', () => {
  test('holds the fifth of five submits at a cap of four and admits it when a running task finishes', async () => {
    const { aborts, persistence, runs, scheduler, timers } = await createLaunchAdmissionHarness({
      admitLaunch: capAt(4),
    });

    for (let index = 1; index <= 5; index += 1) {
      await scheduler.submit(submitInput(index));
    }

    expect(runs.map((run) => run.task.taskId)).toEqual([
      'dvr_task_1',
      'dvr_task_2',
      'dvr_task_3',
      'dvr_task_4',
    ]);
    const capacityReason = { kind: 'capacity', activeCount: 4, limit: 4, since: 1_000 };
    expect(scheduler.getTask('dvr_task_5')).toMatchObject({ status: 'queued', waitingReason: capacityReason });
    expect(scheduler.getDiagnostics()).toMatchObject({ admissionHeldCount: 1, admissionRetryPending: true });
    expect(timers.pendingByDelay(5_000)).toHaveLength(1);
    expect(runs.every((run) => run.task.waitingReason === null)).toBe(true);

    // An unchanged hold on retry neither rewrites the ledger nor stacks timers.
    const savesBeforeRetry = persistence.saveCount;
    timers.runByDelay(5_000);
    await scheduler.flush();
    expect(scheduler.getTask('dvr_task_5').waitingReason).toEqual(capacityReason);
    expect(persistence.saveCount).toBe(savesBeforeRetry);
    expect(timers.pendingByDelay(5_000)).toHaveLength(1);
    expect(runs).toHaveLength(4);

    await runs[1].taskControl.markAccepted();
    runs[1].result.resolve({ status: 'completed' });
    await scheduler.flush();

    expect(scheduler.getTask('dvr_task_2').status).toBe('completed');
    expect(scheduler.getTask('dvr_task_5')).toMatchObject({ status: 'starting', waitingReason: null });
    expect(runs.map((run) => run.task.taskId)).toEqual([
      'dvr_task_1',
      'dvr_task_2',
      'dvr_task_3',
      'dvr_task_4',
      'dvr_task_5',
    ]);
    expect(scheduler.getDiagnostics()).toMatchObject({ admissionHeldCount: 0, admissionRetryPending: false });
    expect(timers.pendingByDelay(5_000)).toHaveLength(0);
    expect(aborts).toEqual([]);
    expect(['dvr_task_1', 'dvr_task_3', 'dvr_task_4'].map((taskId) => scheduler.getTask(taskId).status))
      .toEqual(['starting', 'starting', 'starting']);
  });

  test('never lets a later queued task jump ahead of a held one', async () => {
    let holdSecond = true;
    const { runs, scheduler, timers } = await createLaunchAdmissionHarness({
      admitLaunch: ({ task }) => (
        holdSecond && task.taskId === 'dvr_task_2'
          ? { admit: false, reason: 'capacity', limit: 1 }
          : { admit: true }
      ),
    });

    for (let index = 1; index <= 3; index += 1) {
      await scheduler.submit(submitInput(index));
    }

    expect(runs.map((run) => run.task.taskId)).toEqual(['dvr_task_1']);
    expect(scheduler.getTask('dvr_task_2')).toMatchObject({
      status: 'queued',
      waitingReason: { kind: 'capacity', activeCount: 1, limit: 1, since: 1_000 },
    });
    expect(scheduler.getTask('dvr_task_3')).toMatchObject({ status: 'queued', waitingReason: null });
    expect(scheduler.getDiagnostics().admissionHeldCount).toBe(2);
    expect(timers.pendingByDelay(5_000)).toHaveLength(1);

    holdSecond = false;
    timers.runByDelay(5_000);
    await scheduler.flush();

    expect(runs.map((run) => run.task.taskId)).toEqual(['dvr_task_1', 'dvr_task_2', 'dvr_task_3']);
    expect(scheduler.listTasks().every((task) => task.status === 'starting' && task.waitingReason === null)).toBe(true);
  });

  test('holds every queued task under system pressure and admits once the hook clears', async () => {
    let pressured = true;
    const { runs, scheduler, timers } = await createLaunchAdmissionHarness({
      admitLaunch: () => (
        pressured
          ? { admit: false, reason: 'system_pressure', limit: 9, retryInMs: 15_000 }
          : { admit: true }
      ),
    });

    for (let index = 1; index <= 3; index += 1) {
      await scheduler.submit(submitInput(index));
    }

    expect(runs).toHaveLength(0);
    expect(scheduler.getTask('dvr_task_1').waitingReason)
      .toEqual({ kind: 'system_pressure', activeCount: 0, limit: null, since: 1_000 });
    expect(scheduler.getTask('dvr_task_2').waitingReason).toBeNull();
    expect(scheduler.getDiagnostics()).toMatchObject({ admissionHeldCount: 3, admissionRetryPending: true });
    expect(timers.pendingByDelay(15_000)).toHaveLength(1);

    pressured = false;
    timers.runByDelay(15_000);
    await scheduler.flush();

    expect(runs.map((run) => run.task.taskId)).toEqual(['dvr_task_1', 'dvr_task_2', 'dvr_task_3']);
    expect(scheduler.listTasks().every((task) => task.status === 'starting' && task.waitingReason === null)).toBe(true);
    expect(scheduler.getDiagnostics()).toMatchObject({ admissionHeldCount: 0, admissionRetryPending: false });
  });

  test('preserves since while the kind is unchanged and clamps retry delays', async () => {
    let clock = 1_000;
    let decision = { admit: false, reason: 'capacity', limit: 1, retryInMs: 10 };
    const { runs, scheduler, timers } = await createLaunchAdmissionHarness({
      admitLaunch: () => decision,
      now: () => clock,
    });

    await scheduler.submit(submitInput(1));
    expect(runs).toHaveLength(0);
    expect(scheduler.getTask('dvr_task_1').waitingReason)
      .toEqual({ kind: 'capacity', activeCount: 0, limit: 1, since: 1_000 });
    expect(timers.pendingByDelay(1_000)).toHaveLength(1);

    clock = 2_000;
    decision = { admit: false, reason: 'capacity', limit: 2, retryInMs: 600_000 };
    timers.runByDelay(1_000);
    await scheduler.flush();
    expect(scheduler.getTask('dvr_task_1').waitingReason)
      .toEqual({ kind: 'capacity', activeCount: 0, limit: 2, since: 1_000 });
    expect(timers.pendingByDelay(60_000)).toHaveLength(1);

    clock = 3_000;
    decision = { admit: false, reason: 'system_pressure' };
    timers.runByDelay(60_000);
    await scheduler.flush();
    expect(scheduler.getTask('dvr_task_1').waitingReason)
      .toEqual({ kind: 'system_pressure', activeCount: 0, limit: null, since: 3_000 });
    expect(timers.pendingByDelay(5_000)).toHaveLength(1);

    clock = 4_000;
    decision = { admit: false, reason: 'capacity', limit: 1 };
    timers.runByDelay(5_000);
    await scheduler.flush();
    expect(scheduler.getTask('dvr_task_1').waitingReason)
      .toEqual({ kind: 'capacity', activeCount: 0, limit: 1, since: 4_000 });
  });

  test('admits when the hook throws or returns an unknown reason', async () => {
    let mode = 'throw';
    const { runs, scheduler, warnings } = await createLaunchAdmissionHarness({
      admitLaunch: () => {
        if (mode === 'throw') throw new Error('admission exploded');
        return { admit: false, reason: 'mystery' };
      },
    });

    await scheduler.submit(submitInput(1));
    mode = 'unknown';
    await scheduler.submit(submitInput(2));

    expect(runs.map((run) => run.task.taskId)).toEqual(['dvr_task_1', 'dvr_task_2']);
    expect(scheduler.listTasks().every((task) => task.status === 'starting' && task.waitingReason === null)).toBe(true);
    expect(scheduler.getDiagnostics()).toMatchObject({ admissionHeldCount: 0, admissionRetryPending: false });
    expect(warnings.map(([message]) => message)).toEqual([
      '[ManagedOrchestration] Launch admission hook failed; admitting',
      '[ManagedOrchestration] Launch admission hook returned an unknown reason; admitting',
    ]);
  });

  test('reloads held queued tasks with their reason after a restart and pumps again', async () => {
    const persistence = createMemoryPersistence();
    let pressured = true;
    const admitLaunch = () => (pressured ? { admit: false, reason: 'system_pressure' } : { admit: true });
    const first = await createLaunchAdmissionHarness({ admitLaunch, persistence });
    await first.scheduler.submit(submitInput(1));
    await first.scheduler.submit(submitInput(2));
    expect(first.runs).toHaveLength(0);
    await first.scheduler.shutdown();

    const restarted = await createLaunchAdmissionHarness({
      admitLaunch,
      persistence,
      now: () => 5_000,
      taskIdOffset: 10,
    });

    expect(restarted.scheduler.getTask('dvr_task_1')).toMatchObject({
      status: 'queued',
      waitingReason: { kind: 'system_pressure', activeCount: 0, limit: null, since: 1_000 },
    });
    expect(restarted.scheduler.getTask('dvr_task_2')).toMatchObject({ status: 'queued', waitingReason: null });
    expect(restarted.scheduler.getDiagnostics()).toMatchObject({ admissionHeldCount: 2, admissionRetryPending: true });
    expect(restarted.runs).toHaveLength(0);

    pressured = false;
    restarted.timers.runByDelay(5_000);
    await restarted.scheduler.flush();

    expect(restarted.runs.map((run) => run.task.taskId)).toEqual(['dvr_task_1', 'dvr_task_2']);
    expect(restarted.scheduler.listTasks().every((task) => task.status === 'starting' && task.waitingReason === null))
      .toBe(true);
  });

  test('stops the admission retry timer at shutdown', async () => {
    const { scheduler, timers } = await createLaunchAdmissionHarness({ admitLaunch: capAt(0) });
    await scheduler.submit(submitInput(1));
    expect(timers.pendingByDelay(5_000)).toHaveLength(1);

    await scheduler.shutdown();

    expect(timers.pendingByDelay(5_000)).toHaveLength(0);
    expect(scheduler.getDiagnostics()).toMatchObject({ admissionRetryPending: false, shutDown: true });
  });
});
