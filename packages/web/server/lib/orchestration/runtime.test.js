import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createManagedTaskRecord } from '@openchamber/orchestration-runtime';

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

const createWaitScheduler = () => {
  const task = createManagedTaskRecord({
    taskId: 'dvr_task_wait_rpc',
    idempotencyKey: 'wait-rpc',
    rootSessionId: 'ses_root',
    parentTaskId: null,
    directory: '/workspace',
    sequence: 1,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: 'Wait RPC',
    prompt: 'Wait for this task.',
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: 1_000,
    timeoutAt: null,
  });
  return {
    task,
    scheduler: {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn(() => task),
      getResultEnvelope: vi.fn(() => null),
      waitForTask: vi.fn(async () => task),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    },
  };
};

describe('web managed orchestration runtime', () => {
  it('exposes durable provider-recovery continuations through the private bridge', async () => {
    const continuations = [{
      sourceTaskId: 'dvr_task_limited',
      taskId: 'dvr_task_recovered',
      rootSessionId: 'ses_root',
      childSessionId: 'ses_child',
      directory: '/workspace',
    }];
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      listReadyProviderRecoveryContinuations: vi.fn(() => continuations),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
    });

    await expect(runtime.handleRpc({
      method: 'list_provider_recovery_continuations',
      params: { sessionId: 'ses_child' },
    })).resolves.toEqual({ continuations });
    expect(scheduler.listReadyProviderRecoveryContinuations).toHaveBeenCalledWith({
      sessionId: 'ses_child',
    });

    await runtime.shutdown();
  });

  it('validates and clamps private wait slices before forwarding them to the scheduler', async () => {
    const { scheduler } = createWaitScheduler();
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
    });
    const waitParams = {
      taskId: 'dvr_task_wait_rpc',
      rootSessionId: 'ses_root',
      directory: '/workspace',
    };

    await runtime.handleRpc({ method: 'wait', params: waitParams });
    await runtime.handleRpc({ method: 'wait', params: { ...waitParams, waitTimeoutMs: 1 } });
    await runtime.handleRpc({ method: 'wait', params: { ...waitParams, waitTimeoutMs: 30_000 } });

    expect(scheduler.waitForTask.mock.calls.map(([, options]) => options)).toEqual([
      { signal: undefined },
      { signal: undefined, timeoutMs: 1 },
      { signal: undefined, timeoutMs: 25_000 },
    ]);

    for (const waitTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, '1000', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runtime.handleRpc({
        method: 'wait',
        params: { ...waitParams, waitTimeoutMs },
      })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
    }
    expect(scheduler.waitForTask).toHaveBeenCalledTimes(3);
    await runtime.shutdown();
  });

  it('waits for a result action and projects its same-scope follow-up task', async () => {
    const original = createManagedTaskRecord({
      taskId: 'dvr_task_limited',
      idempotencyKey: 'limited-task',
      rootSessionId: 'ses_root',
      parentTaskId: null,
      directory: '/workspace',
      sequence: 1,
      mode: 'orchestrator',
      providerId: 'opencode-go',
      modelId: 'glm-5.2',
      agent: 'explorer',
      variant: 'high',
      label: 'Limited task',
      prompt: 'Inspect the project.',
      attempt: 1,
      priorTaskId: null,
      executionKind: 'start',
      createdAt: 1_000,
      timeoutAt: null,
    });
    const followUp = createManagedTaskRecord({
      taskId: 'dvr_task_recovered',
      idempotencyKey: 'recovered-task',
      rootSessionId: 'ses_root',
      parentTaskId: null,
      childSessionId: 'ses_child',
      directory: '/workspace',
      sequence: 2,
      mode: 'orchestrator',
      providerId: 'openai',
      modelId: 'gpt-5.6-terra',
      agent: 'explorer',
      variant: 'high',
      label: 'Recovered task',
      prompt: 'Continue the inspection.',
      attempt: 2,
      priorTaskId: original.taskId,
      executionKind: 'retry_in_place',
      createdAt: 2_000,
      timeoutAt: null,
    });
    const resultEnvelope = {
      taskId: original.taskId,
      action: 'retry_in_place',
      followUpTaskId: followUp.taskId,
    };
    const waitForResultAction = vi.fn(async () => resultEnvelope);
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn((taskId) => (
        taskId === original.taskId ? original : taskId === followUp.taskId ? followUp : null
      )),
      getResultEnvelope: vi.fn(() => null),
      waitForResultAction,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
    });
    const controller = new AbortController();

    const result = await runtime.handleRpc({
      method: 'wait_result_action',
      params: {
        taskId: original.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
      },
    }, { signal: controller.signal });

    expect(waitForResultAction).toHaveBeenCalledWith(original.taskId, {
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      resultEnvelope,
      followUpTask: {
        task: {
          taskId: followUp.taskId,
          rootSessionId: 'ses_root',
          childSessionId: 'ses_child',
          status: 'queued',
        },
      },
    });
    await runtime.shutdown();
  });

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
      params: submitParams(1, { dispatchGroupId: 'msg_parent', readOnly: true }),
    });
    expect(submitted.task).not.toHaveProperty('dispatchGroupId');
    expect(submitted.task).not.toHaveProperty('readOnly');
    expect(runs[0].task.readOnly).toBe(true);
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

  it('owns one unbounded scheduler with immediate admission and safe event projection', async () => {
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
    submitted.push(await runtime.handleRpc({
      method: 'submit',
      params: submitParams(6, { rootSessionId: 'ses_second_root' }),
    }));
    await runtime.flush();

    expect(runs.map((run) => run.task.taskId)).toEqual([
      'dvr_task_web_1',
      'dvr_task_web_2',
      'dvr_task_web_3',
      'dvr_task_web_4',
      'dvr_task_web_5',
      'dvr_task_web_6',
    ]);
    expect(submitted[3].task.status).toBe('starting');
    expect(submitted[4].task.status).toBe('starting');
    expect(submitted[5].task.status).toBe('starting');
    expect(submitted.every(({ task }) => task.timeoutAt === 1_801_000)).toBe(true);
    expect(submitted.every(({ task }) => !('prompt' in task))).toBe(true);
    expect(events.every((event) => !('prompt' in event.properties.task))).toBe(true);

    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    await runtime.flush();
    expect(runs).toHaveLength(6);
    await runtime.shutdown();
  });

  it('projects exhausted usage as immediate manual recovery on web and Electron', async () => {
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() { return { status: 'failed', failureReason: 'out of usage', resumable: true }; },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_usage_limit',
      createLeaseToken: () => 'dvr_lease_usage_limit',
      now: () => 1_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, {
        childSessionId: 'ses_child_usage_limit',
        dispatchGroupId: 'msg_parent',
      }),
    });
    await runtime.flush();

    const status = await runtime.handleRpc({
      method: 'status',
      params: { taskId: submitted.task.taskId, rootSessionId: 'ses_root' },
    });

    expect(status.task).toMatchObject({
      status: 'failed',
      failureReason: 'out of usage',
      failureKind: 'provider_usage_limit',
      agentRetryAvailable: false,
    });
    expect(status.resultEnvelope).toMatchObject({ resumable: true, action: null });
    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: submitted.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'resume',
        idempotencyKey: 'agent-rate-limit-resume',
      },
    })).rejects.toMatchObject({ code: 'manual_model_recovery_required', statusCode: 409 });
    await runtime.shutdown();
  });

  it('enforces a 60-minute Oracle deadline for starts and follow-ups', async () => {
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() {
          return { status: 'failed', failureReason: 'temporary failure', resumable: true };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
        async shutdown() {},
      },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_oracle_deadline_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_oracle_deadline_${++index}`;
      })(),
      now: () => 10_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { agent: 'oracle', timeoutAt: 1_810_000 }),
    });
    expect(submitted.task.timeoutAt).toBe(3_610_000);
    await runtime.flush();

    const retried = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: submitted.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'retry-oracle-deadline',
      },
    });
    expect(retried.followUpTask.task.timeoutAt).toBe(3_610_000);
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
          ...(actions[index] === 'retry_in_place' ? {
            providerId: 'openai',
            modelId: 'gpt-5.4',
            variant: null,
          } : {}),
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
          return { status: 'failed', failureReason: 'provider connection ended', resumable: true };
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
    const acquireOwnership = vi.fn(async () => undefined);
    const releaseOwnership = vi.fn(async () => true);
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
        acquireOwnership,
        releaseOwnership,
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
    expect(acquireOwnership).toHaveBeenCalledTimes(1);
    expect(releaseOwnership).toHaveBeenCalledTimes(1);
  });

  it('fails closed when another process owns the ledger and suppresses recovery scans', async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-runtime-owner-'));
    const createScheduler = () => ({
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    });
    const firstScheduler = createScheduler();
    const secondScheduler = createScheduler();
    const firstHost = {
      start: vi.fn(async () => ({
        DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:41001/rpc',
        DEVRYAN_ORCHESTRATION_TOKEN: 'first-token',
      })),
      stop: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const secondHost = {
      start: vi.fn(async () => ({
        DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:41002/rpc',
        DEVRYAN_ORCHESTRATION_TOKEN: 'second-token',
      })),
      stop: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const first = createWebManagedOrchestrationRuntime({
      dataDirectory,
      scheduler: firstScheduler,
      executor: {},
      privateHost: firstHost,
    });
    const second = createWebManagedOrchestrationRuntime({
      dataDirectory,
      scheduler: secondScheduler,
      executor: {},
      privateHost: secondHost,
    });

    try {
      await first.prepareBridge();
      await expect(second.prepareBridge()).rejects.toMatchObject({
        code: 'managed_orchestration_owner_conflict',
        statusCode: 409,
      });
      await expect(second.getSnapshot()).resolves.toMatchObject({
        available: false,
        bridgeReady: false,
        recoveryWarning: expect.stringContaining('another DevRyan runtime'),
        tasks: [],
      });
      expect(secondHost.start).not.toHaveBeenCalled();
      expect(secondScheduler.initialize).not.toHaveBeenCalled();

      await first.shutdown();
      await expect(second.prepareBridge()).resolves.toMatchObject({
        DEVRYAN_ORCHESTRATION_TOKEN: 'second-token',
      });
    } finally {
      await Promise.allSettled([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDirectory, { recursive: true, force: true });
    }
  }, 15_000);

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
