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
      submitted.push(await runtime.handleRpc({ method: 'submit', params: submitParams(index) }));
    }
    await runtime.flush();

    expect(runs.map((run) => run.task.taskId)).toEqual([
      'dvr_task_web_1',
      'dvr_task_web_2',
      'dvr_task_web_3',
    ]);
    expect(submitted[3].task.status).toBe('queued');
    expect(submitted[4].task.status).toBe('queued');
    expect(submitted.every(({ task }) => !('prompt' in task))).toBe(true);
    expect(events.every((event) => !('prompt' in event.properties.task))).toBe(true);

    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    await runtime.flush();
    expect(runs[3].task.taskId).toBe('dvr_task_web_4');
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
    expect((await runtime.getSnapshot())).toMatchObject({ available: false, tasks: [] });
    await runtime.shutdown();
  });
});
