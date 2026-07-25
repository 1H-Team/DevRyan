import { describe, expect, test } from 'bun:test';

import { createManagedTaskRecord } from './contract.js';
import { createManagedTaskResultEnvelope } from './result-envelope.js';
import { createManagedTaskScheduler } from './scheduler.js';

const record = (index, overrides = {}) => ({
  ...createManagedTaskRecord({
    taskId: `dvr_task_${index}`,
    idempotencyKey: `recover-${index}`,
    rootSessionId: 'ses_root',
    parentTaskId: null,
    directory: '/workspace',
    sequence: index,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: `Recover ${index}`,
    prompt: `Recover task ${index}.`,
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: 1_000 + index,
    timeoutAt: null,
  }),
  ...overrides,
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
    runByDelay(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      if (!entry) throw new Error(`No timer scheduled for ${delay}ms`);
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    },
  };
};

describe('managed scheduler restart recovery', () => {
  test('rejects a result envelope that contradicts its terminal task', async () => {
    const failed = record(1, {
      status: 'failed',
      childSessionId: 'ses_failed',
      leaseToken: 'dvr_lease_failed',
      startedAt: 1_100,
      finishedAt: 1_200,
      failureReason: 'provider failed',
      partial: true,
      recoverablePreview: 'partial output',
    });
    const envelope = createManagedTaskResultEnvelope(failed, {
      sequence: 1,
      createdAt: 1_200,
      resumable: false,
    });
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() {
          return {
            version: 1,
            tasks: [failed],
            resultEnvelopes: [{ ...envelope, status: 'completed' }],
          };
        },
        async save() {},
      },
      executor: {
        async start() { throw new Error('must not dispatch'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
    });

    await expect(scheduler.initialize()).rejects.toThrow(
      'result envelope status does not match task dvr_task_1',
    );
  });

  test('reconciles live and terminal children without replaying prompts', async () => {
    const observed = [];
    const starts = [];
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() {
          return {
            version: 1,
            tasks: [
              record(1, {
                status: 'running',
                childSessionId: 'ses_live',
                leaseToken: 'dvr_lease_live',
                startedAt: 1_100,
              }),
              record(2, {
                status: 'starting',
                childSessionId: 'ses_terminal',
                leaseToken: 'dvr_lease_terminal',
                startedAt: 1_200,
              }),
            ],
            resultEnvelopes: [],
          };
        },
        async save() {},
      },
      executor: {
        async start(task) { starts.push(task.taskId); return { status: 'completed' }; },
        async observe(task) {
          observed.push(task.taskId);
          return { status: 'completed', recoverablePreview: 'live child completed' };
        },
        async abort() { return { aborted: true }; },
        async reconcile(task) {
          if (task.childSessionId === 'ses_live') return { state: 'live', accepted: true };
          return {
            state: 'terminal',
            result: {
              status: 'completed',
              recoverablePreview: 'already terminal',
            },
          };
        },
        async readRecoverableResult() { return {}; },
      },
      now: () => 2_000,
    });

    await scheduler.initialize();
    const [live, terminal] = await Promise.all([
      scheduler.waitForTask('dvr_task_1'),
      scheduler.waitForTask('dvr_task_2'),
    ]);

    expect(starts).toEqual([]);
    expect(observed).toEqual(['dvr_task_1']);
    expect(live.status).toBe('completed');
    expect(terminal.status).toBe('completed');
    expect(scheduler.listResultEnvelopes()).toHaveLength(2);
  });

  test('marks an unavailable child interrupted while retaining recovery output', async () => {
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() {
          return {
            version: 1,
            tasks: [record(1, {
              status: 'running',
              childSessionId: 'ses_missing',
              leaseToken: 'dvr_lease_missing',
              startedAt: 1_100,
            })],
            resultEnvelopes: [],
          };
        },
        async save() {},
      },
      executor: {
        async start() { throw new Error('must not replay'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() {
          return {
            recoverablePreview: 'work recovered before restart',
            canonicalRefs: [{ type: 'message', id: 'msg_partial' }],
            resumable: false,
          };
        },
      },
      now: () => 2_000,
    });

    await scheduler.initialize();
    const task = scheduler.getTask('dvr_task_1');

    expect(task.status).toBe('interrupted');
    expect(task.partial).toBe(true);
    expect(task.failureReason).toBe('Child session ownership could not be recovered after restart');
    expect(task.recoverablePreview).toBe('work recovered before restart');
  });

  test('keeps a task active through transient reconciliation and observes the same child after recovery', async () => {
    const timers = createManualTimers();
    const starts = [];
    const observed = [];
    let reconciliationCount = 0;
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() {
          return {
            version: 1,
            tasks: [record(1, {
              status: 'running',
              childSessionId: 'ses_existing',
              leaseToken: 'dvr_lease_existing',
              startedAt: 1_100,
            })],
            resultEnvelopes: [],
          };
        },
        async save() {},
      },
      executor: {
        async start(task) { starts.push(task.taskId); return { status: 'completed' }; },
        async observe(task) {
          observed.push(task.childSessionId);
          return { status: 'completed', recoverablePreview: 'same child completed' };
        },
        async abort() { return { aborted: true }; },
        async reconcile() {
          reconciliationCount += 1;
          return reconciliationCount === 1
            ? { state: 'transient', failureReason: 'OpenCode port is not available' }
            : { state: 'live' };
        },
        async readRecoverableResult() { return {}; },
      },
      reconciliationRetryMs: 25,
      scheduleTimeout: timers.scheduleTimeout,
      cancelTimeout: timers.cancelTimeout,
      now: () => 2_000,
    });

    await scheduler.initialize();

    expect(scheduler.getTask('dvr_task_1').status).toBe('running');
    expect(scheduler.getResultEnvelope('dvr_task_1')).toBeNull();
    expect(scheduler.getDiagnostics().pendingReconciliationRetryCount).toBe(1);
    const settledPromise = scheduler.waitForTask('dvr_task_1');
    timers.runByDelay(25);
    const settled = await settledPromise;

    expect(settled.status).toBe('completed');
    expect(starts).toEqual([]);
    expect(observed).toEqual(['ses_existing']);
    expect(reconciliationCount).toBe(2);
    expect(scheduler.getDiagnostics().pendingReconciliationRetryCount).toBe(0);
    await scheduler.shutdown();
  });

  test('lets the task deadline settle a prolonged reconciliation outage and clears its retry', async () => {
    const timers = createManualTimers();
    let currentTime = 2_000;
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() {
          return {
            version: 1,
            tasks: [record(1, {
              status: 'running',
              childSessionId: 'ses_existing',
              leaseToken: 'dvr_lease_existing',
              startedAt: 1_100,
              timeoutAt: 2_100,
            })],
            resultEnvelopes: [],
          };
        },
        async save() {},
      },
      executor: {
        async start() { throw new Error('must not replay'); },
        async abort() { return { aborted: true }; },
        async reconcile() {
          return { state: 'transient', failureReason: 'OpenCode port is not available' };
        },
        async readRecoverableResult() { return {}; },
      },
      reconciliationRetryMs: 1_000,
      scheduleTimeout: timers.scheduleTimeout,
      cancelTimeout: timers.cancelTimeout,
      now: () => currentTime,
    });

    await scheduler.initialize();
    expect(scheduler.getDiagnostics()).toMatchObject({
      pendingTimeoutCount: 1,
      pendingReconciliationRetryCount: 1,
    });

    const settledPromise = scheduler.waitForTask('dvr_task_1');
    currentTime = 2_100;
    timers.runByDelay(100);
    const settled = await settledPromise;

    expect(settled).toMatchObject({
      status: 'failed',
      failureReason: 'Managed task timed out at 2100',
    });
    expect(scheduler.getDiagnostics()).toMatchObject({
      pendingTimeoutCount: 0,
      pendingReconciliationRetryCount: 0,
    });
    await scheduler.shutdown();
  });

  test('keeps queued order and dispatches every recovered task after restart', async () => {
    const starts = [];
    const never = new Promise(() => {});
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() {
          return {
            version: 1,
            tasks: [record(4), record(2), record(1), record(5), record(3)],
            resultEnvelopes: [],
          };
        },
        async save() {},
      },
      executor: {
        async start(task) { starts.push(task.taskId); return await never; },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createLeaseToken: (() => {
        let id = 0;
        return () => `dvr_lease_${++id}`;
      })(),
      now: () => 2_000,
    });

    await scheduler.initialize();

    expect(starts).toEqual([
      'dvr_task_1',
      'dvr_task_2',
      'dvr_task_3',
      'dvr_task_4',
      'dvr_task_5',
    ]);
    expect(scheduler.getTask('dvr_task_4').status).toBe('starting');
    expect(scheduler.getTask('dvr_task_5').status).toBe('starting');
  });

  test('does not publish or retain a task when its durable save fails', async () => {
    const events = [];
    let saveCount = 0;
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() { return null; },
        async save() {
          saveCount += 1;
          if (saveCount > 1) throw new Error('disk full');
        },
      },
      executor: {
        async start() { throw new Error('must not dispatch'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      publishEvent: (event) => events.push(event),
      createTaskId: () => 'dvr_task_unsaved',
      now: () => 1_000,
    });
    await scheduler.initialize();

    await expect(scheduler.submit({
      idempotencyKey: 'unsaved',
      rootSessionId: 'ses_root',
      parentTaskId: null,
      directory: '/workspace',
      mode: 'orchestrator',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: null,
      label: 'Unsaved task',
      prompt: 'Do not dispatch.',
      timeoutAt: null,
    })).rejects.toThrow('disk full');
    expect(scheduler.listTasks()).toEqual([]);
    expect(events).toEqual([]);
  });

  test('compacts persisted and in-memory terminal history at the configured boundary', async () => {
    const saves = [];
    const events = [];
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() {
          return {
            version: 1,
            tasks: [
              record(1, { status: 'completed', finishedAt: 1 }),
              record(2, { status: 'completed', finishedAt: 2 }),
              record(3, { status: 'completed', finishedAt: 3 }),
            ],
            resultEnvelopes: [],
          };
        },
        async save(snapshot) { saves.push(structuredClone(snapshot)); },
      },
      executor: {
        async start() { throw new Error('terminal history must not dispatch'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      maxTerminalRecords: 2,
      maxHistoryAgeMs: Number.POSITIVE_INFINITY,
      maxPersistedBytes: Number.POSITIVE_INFINITY,
      now: () => 10,
      publishEvent: (event) => { events.push(structuredClone(event)); },
    });

    await scheduler.initialize();
    await scheduler.flush();

    expect(scheduler.listTasks().map((task) => task.taskId)).toEqual(['dvr_task_2', 'dvr_task_3']);
    expect(saves.at(-1).tasks.map((task) => task.taskId)).toEqual(['dvr_task_2', 'dvr_task_3']);
    expect(scheduler.getDiagnostics().compactedTaskCount).toBe(1);
    expect(events).toContainEqual({
      type: 'openchamber:managed-task-removed',
      properties: {
        owner: 'devryan',
        taskId: 'dvr_task_1',
        rootSessionId: 'ses_root',
        directory: '/workspace',
        sequence: 1,
      },
    });
  });

  test('publishes live compaction before the task event that caused it', async () => {
    const events = [];
    let taskCounter = 0;
    let leaseCounter = 0;
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() { return null; },
        async save() {},
      },
      executor: {
        async start(_task, control) {
          await control.markAccepted();
          return { status: 'completed', recoverablePreview: 'done' };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      maxTerminalRecords: 1,
      maxHistoryAgeMs: Number.POSITIVE_INFINITY,
      maxPersistedBytes: Number.POSITIVE_INFINITY,
      createTaskId: () => `dvr_task_${++taskCounter}`,
      createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
      now: () => 1_000,
      publishEvent: (event) => { events.push(structuredClone(event)); },
    });
    const submit = (index) => scheduler.submit({
      idempotencyKey: `live-compact-${index}`,
      rootSessionId: 'ses_root',
      parentTaskId: null,
      directory: '/workspace',
      mode: 'orchestrator',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: null,
      label: `Task ${index}`,
      prompt: `Run ${index}.`,
      timeoutAt: null,
    });

    const first = await submit(1);
    await scheduler.waitForTask(first.taskId);
    const second = await submit(2);
    await scheduler.waitForTask(second.taskId);
    await scheduler.flush();

    const removalIndex = events.findIndex((event) => event.type === 'openchamber:managed-task-removed');
    const secondTerminalIndex = events.findIndex((event) => (
      event.type === 'openchamber:managed-task'
      && event.properties.task.taskId === second.taskId
      && event.properties.task.status === 'completed'
    ));
    expect(removalIndex).toBeGreaterThanOrEqual(0);
    expect(removalIndex).toBeLessThan(secondTerminalIndex);
    expect(scheduler.listTasks().map((task) => task.taskId)).toEqual([second.taskId]);
  });

  test('does not republish a terminal task compacted by its own commit', async () => {
    const events = [];
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() { return null; },
        async save() {},
      },
      executor: {
        async start(_task, control) {
          await control.markAccepted();
          return { status: 'completed', recoverablePreview: 'done' };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      maxTerminalRecords: 0,
      maxHistoryAgeMs: Number.POSITIVE_INFINITY,
      maxPersistedBytes: Number.POSITIVE_INFINITY,
      createTaskId: () => 'dvr_task_compacted_immediately',
      createLeaseToken: () => 'dvr_lease_compacted_immediately',
      now: () => 1_000,
      publishEvent: (event) => { events.push(structuredClone(event)); },
    });
    const task = await scheduler.submit({
      idempotencyKey: 'compact-immediately',
      rootSessionId: 'ses_root',
      parentTaskId: null,
      directory: '/workspace',
      mode: 'orchestrator',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: null,
      label: 'Compact immediately',
      prompt: 'Finish.',
      timeoutAt: null,
    });
    await scheduler.flush();

    const removalIndex = events.findIndex((event) => event.type === 'openchamber:managed-task-removed');
    expect(removalIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(removalIndex + 1)).toEqual([]);
    expect(scheduler.getTask(task.taskId)).toBeNull();
  });

  test('rejects new nonterminal work when protected state cannot fit the byte limit', async () => {
    const scheduler = createManagedTaskScheduler({
      persistence: {
        async load() { return null; },
        async save() {},
      },
      executor: {
        async start() { throw new Error('over-limit task must not dispatch'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      maxPersistedBytes: 128,
      createTaskId: () => 'dvr_task_over_limit',
      now: () => 1_000,
    });
    await scheduler.initialize();

    await expect(scheduler.submit({
      idempotencyKey: 'over-limit',
      rootSessionId: 'ses_root',
      parentTaskId: null,
      directory: '/workspace',
      mode: 'orchestrator',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: null,
      label: 'Over limit',
      prompt: 'This protected queued task cannot be compacted.',
      timeoutAt: null,
    })).rejects.toThrow('managed orchestration ledger cannot fit within 128 bytes');
    expect(scheduler.listTasks()).toEqual([]);
  });
});
