import { describe, expect, it, vi } from 'vitest';

import { createWebManagedOrchestrationRuntime } from './runtime.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const submitParams = (index, overrides = {}) => ({
  idempotencyKey: `root-message-task-${index}`,
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Task ${index}`,
  prompt: `Run task ${index}.`,
  ...overrides,
});

const createPersistence = () => {
  let snapshot = null;
  return {
    async load() { return snapshot; },
    async save(value) { snapshot = structuredClone(value); },
  };
};

describe('web managed orchestration runtime', () => {
  it('inspects and confirms a safe orchestrator-to-builder handoff', async () => {
    const runs = [];
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        start(task) {
          const result = deferred();
          runs.push({ result, task });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_handoff_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_handoff_${++index}`;
      })(),
      now: () => 1_000,
    });
    const grouped = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { dispatchGroupId: 'msg_parent' }),
    });
    await runtime.handleRpc({
      method: 'submit',
      params: submitParams(2, {
        dispatchGroupId: null,
        idempotencyKey: 'council-task',
      }),
    });

    const inspection = await runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      },
    });
    expect(inspection).toMatchObject({
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      state: 'confirmation_required',
      failures: [],
    });
    expect(inspection.tasks.map(({ task }) => task.taskId)).toEqual([grouped.task.taskId]);
    expect(inspection.tasks[0].task).not.toHaveProperty('prompt');
    expect(inspection.tasks[0].task).not.toHaveProperty('idempotencyKey');
    expect(inspection.tasks[0].task).not.toHaveProperty('dispatchGroupId');
    expect(inspection.tasks[0].task).not.toHaveProperty('leaseToken');

    const confirmed = await runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: true,
        idempotencyKey: 'switch-web-01',
      },
    });
    expect(confirmed).toMatchObject({
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      state: 'clear',
      failures: [],
      tasks: [{
        task: { taskId: grouped.task.taskId, status: 'aborted' },
        resultEnvelope: { action: 'abandon' },
      }],
    });
    expect(confirmed).not.toHaveProperty('idempotencyKey');
    expect(runs).toHaveLength(2);
    await runtime.shutdown();
  });

  it('validates handoff scope and confirmation before scheduler mutation', async () => {
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
    });

    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'builder',
        toMode: 'orchestrator',
        confirm: false,
      },
    })).rejects.toMatchObject({ code: 'invalid_handoff_scope', statusCode: 400 });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: true,
      },
    })).rejects.toMatchObject({ code: 'missing_idempotency_key', statusCode: 400 });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      },
    })).rejects.toMatchObject({ code: 'invalid_handoff_scope', statusCode: 400 });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: 'false',
      },
    })).rejects.toMatchObject({ code: 'invalid_handoff_scope', statusCode: 400 });
    await runtime.shutdown();
  });

  it('waits on a root-scoped private dispatch barrier and keeps its group out of projections', async () => {
    const runs = [];
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        start(task) {
          const result = deferred();
          runs.push({ result, task });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_barrier',
      createLeaseToken: () => 'dvr_lease_barrier',
      now: () => 1_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { dispatchGroupId: 'msg_parent' }),
    });
    expect(submitted.task).not.toHaveProperty('dispatchGroupId');
    expect(await runtime.handleRpc({
      method: 'barrier',
      params: { rootSessionId: 'ses_other' },
    })).toEqual({ state: 'clear', taskIds: [] });

    const barrier = runtime.handleRpc({
      method: 'barrier',
      params: { rootSessionId: 'ses_root' },
    });
    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    expect(await barrier).toEqual({
      state: 'awaiting_acknowledgement',
      taskIds: [submitted.task.taskId],
    });

    await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: submitted.task.taskId,
        rootSessionId: 'ses_root',
        action: 'continue',
        idempotencyKey: 'continue-barrier',
      },
    });
    expect(await runtime.handleRpc({
      method: 'barrier',
      params: { rootSessionId: 'ses_root' },
    })).toEqual({ state: 'clear', taskIds: [] });
    await runtime.shutdown();
  });

  it('owns one three-slot scheduler, deterministic queue, and safe event projection', async () => {
    const runs = [];
    const events = [];
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        start(task) {
          const result = deferred();
          runs.push({ task, result });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
        async shutdown() {},
      },
      publishEvent: (event) => events.push(event),
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_web_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_web_${++index}`;
      })(),
      now: () => 1_000,
    });
    await runtime.initialize();

    const submitted = [];
    for (let index = 1; index <= 5; index += 1) {
      submitted.push(await runtime.handleRpc({
        method: 'submit',
        params: submitParams(index, index === 1 ? { timeoutAt: 1_500 } : {}),
      }));
    }
    await runtime.flush();

    expect(runs.map((run) => run.task.taskId)).toEqual([
      'dvr_task_web_1',
      'dvr_task_web_2',
      'dvr_task_web_3',
    ]);
    expect(submitted[3].task.status).toBe('queued');
    expect(submitted[4].task.status).toBe('queued');
    expect(submitted.every(({ task }) => task.timeoutAt === 1_801_000)).toBe(true);
    expect(submitted.every(({ task }) => !('prompt' in task))).toBe(true);
    expect(events.every((event) => !('prompt' in event.properties.task))).toBe(true);

    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    await runtime.flush();
    expect(runs[3].task.taskId).toBe('dvr_task_web_4');
    await runtime.shutdown();
  });

  it('gives retry, resume, and retry-in-place follow-ups a fresh default deadline', async () => {
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() {
          return { status: 'failed', failureReason: 'temporary failure', resumable: true };
        },
        async resume() {
          return { status: 'failed', failureReason: 'temporary failure', resumable: true };
        },
        async retryInPlace() {
          return { status: 'failed', failureReason: 'temporary failure', resumable: true };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
        async shutdown() {},
      },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_deadline_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_deadline_${++index}`;
      })(),
      now: () => 10_000,
    });
    const originals = [];
    for (let index = 1; index <= 3; index += 1) {
      originals.push(await runtime.handleRpc({
        method: 'submit',
        params: submitParams(index, { childSessionId: `ses_child_${index}` }),
      }));
    }
    await runtime.flush();

    const actions = ['retry', 'resume', 'retry_in_place'];
    for (let index = 0; index < actions.length; index += 1) {
      const result = await runtime.handleRpc({
        method: 'acknowledge',
        params: {
          taskId: originals[index].task.taskId,
          rootSessionId: 'ses_root',
          directory: '/workspace',
          action: actions[index],
          idempotencyKey: `ack-${actions[index]}`,
        },
      });
      expect(result.followUpTask.task.timeoutAt).toBe(1_810_000);
    }

    await runtime.shutdown();
  });

  it('maps the grouped agent retry ceiling to HTTP 409', async () => {
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() {
          return { status: 'failed', failureReason: 'usage limit', resumable: true };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_retry_limit_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_retry_limit_${++index}`;
      })(),
      now: () => 10_000,
    });
    const original = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { dispatchGroupId: 'msg_parent' }),
    });
    await runtime.flush();
    const firstRecovery = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: original.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'grouped-retry-1',
      },
    });
    await runtime.flush();

    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: firstRecovery.followUpTask.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'grouped-retry-2',
      },
    })).rejects.toMatchObject({ code: 'managed_retry_limit_reached', statusCode: 409 });

    await runtime.shutdown();
  });

  it('preserves the private Council three-minute deadline class', async () => {
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() { return await new Promise(() => {}); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_council_deadline',
      createLeaseToken: () => 'dvr_lease_council_deadline',
      now: () => 10_000,
    });

    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, {
        deadlineClass: 'council',
        timeoutAt: 190_000,
      }),
    });

    expect(submitted.task.timeoutAt).toBe(190_000);
    await runtime.shutdown();
  });

  it('enforces root scope for private status and cancellation calls', async () => {
    const abort = vi.fn(async () => ({ aborted: true }));
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() { return await new Promise(() => {}); },
        abort,
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_scoped',
      createLeaseToken: () => 'dvr_lease_scoped',
      now: () => 1_000,
    });
    const submitted = await runtime.handleRpc({ method: 'submit', params: submitParams(1) });

    await expect(runtime.handleRpc({
      method: 'status',
      params: { taskId: submitted.task.taskId, rootSessionId: 'ses_other' },
    })).rejects.toMatchObject({ code: 'task_scope_mismatch', statusCode: 403 });
    await expect(runtime.handleRpc({
      method: 'cancel',
      params: { taskId: submitted.task.taskId, rootSessionId: 'ses_other' },
    })).rejects.toMatchObject({ code: 'task_scope_mismatch', statusCode: 403 });
    expect(abort).not.toHaveBeenCalled();

    const cancelled = await runtime.handleRpc({
      method: 'cancel',
      params: { taskId: submitted.task.taskId, rootSessionId: 'ses_root' },
    });
    expect(cancelled.task.status).toBe('aborted');
    expect(abort).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  it('starts one private host, reports recovery warnings, and releases all owners', async () => {
    const host = {
      start: vi.fn(async () => ({
        DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:43210/rpc',
        DEVRYAN_ORCHESTRATION_TOKEN: 'opaque-token',
      })),
      stop: vi.fn(async () => undefined),
      getEnvironment: vi.fn(() => null),
      getDiagnostics: vi.fn(() => ({ started: true, activeRequests: 0 })),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: {
        async load() { return null; },
        async save() {},
        getDiagnostics() {
          return { recoveryWarning: 'ledger quarantined', quarantinedPath: '/private/corrupt' };
        },
      },
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
        shutdown: vi.fn(async () => undefined),
      },
      privateHost: host,
    });

    const first = await runtime.prepareBridge();
    expect(await runtime.prepareBridge()).toEqual(first);
    await runtime.initialize();
    expect((await runtime.getSnapshot()).recoveryWarning).toBe('ledger quarantined');
    expect((await runtime.getSnapshot())).not.toHaveProperty('quarantinedPath');

    await runtime.shutdown();
    expect(host.start).toHaveBeenCalledTimes(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps managed tools unavailable for configured external OpenCode', async () => {
    const runtime = createWebManagedOrchestrationRuntime({
      isManagedOpenCode: () => false,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
    });

    await expect(runtime.prepareBridge()).rejects.toMatchObject({
      code: 'managed_runtime_unavailable',
      statusCode: 503,
    });
    await expect(runtime.handleRpc({ method: 'submit', params: submitParams(1) }))
      .rejects.toMatchObject({ code: 'managed_runtime_unavailable', statusCode: 503 });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      },
    })).rejects.toMatchObject({ code: 'managed_runtime_unavailable', statusCode: 503 });
    expect((await runtime.getSnapshot())).toMatchObject({ available: false, tasks: [] });
    await runtime.shutdown();
  });
});
