import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createManagedTaskRecord,
  createManagedTaskResultEnvelope,
} from '@openchamber/orchestration-runtime';

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

const createTerminalPair = (suffix, recoverablePreview, overrides = {}) => {
  const queued = createManagedTaskRecord({
    taskId: `dvr_task_${suffix}`,
    idempotencyKey: `terminal-${suffix}`,
    rootSessionId: 'ses_root',
    parentTaskId: null,
    childSessionId: `ses_child_${suffix}`,
    directory: '/workspace',
    sequence: overrides.sequence ?? 1,
    mode: 'orchestrator',
    providerId: 'openai',
    modelId: 'gpt-5.6-sol',
    agent: 'explorer',
    variant: 'high',
    label: `Terminal ${suffix}`,
    prompt: `Complete ${suffix}.`,
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: 1_000,
    timeoutAt: null,
  });
  const task = {
    ...queued,
    status: overrides.status ?? 'completed',
    startedAt: 1_100,
    finishedAt: 1_200,
    failureReason: overrides.failureReason ?? null,
    partial: overrides.partial ?? false,
    recoverablePreview,
    canonicalRefs: [{ type: 'message', id: `msg_${suffix}` }],
  };
  const resultEnvelope = createManagedTaskResultEnvelope(task, {
    sequence: (overrides.sequence ?? 1) + 100,
    createdAt: 1_300,
    resumable: overrides.resumable ?? false,
  });
  return { task, resultEnvelope };
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
  it('rejects an exact catalog miss before scheduler admission and tolerates unknown catalogs', async () => {
    const scheduler = {
      submit: vi.fn(async () => createTerminalPair('catalog', '').task),
      getResultEnvelope: vi.fn(() => null),
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const validateAgentExecution = vi.fn(async () => false);
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
      validateAgentExecution,
    });

    await expect(runtime.handleRpc({ method: 'submit', params: submitParams(1) }))
      .rejects.toMatchObject({ code: 'managed_agent_model_unavailable', statusCode: 409 });
    expect(scheduler.submit).not.toHaveBeenCalled();
    expect(validateAgentExecution).toHaveBeenCalledWith({
      directory: '/workspace',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
    });

    validateAgentExecution.mockResolvedValueOnce(null);
    await expect(runtime.handleRpc({ method: 'submit', params: submitParams(2) })).resolves.toBeDefined();
    expect(scheduler.submit).toHaveBeenCalledTimes(1);
  });

  it('blocks only work-launching RPC actions during context-mode recovery', async () => {
    const { task } = createWaitScheduler();
    const submit = vi.fn();
    const acknowledgeResult = vi.fn(async () => ({
      envelope: { taskId: task.taskId, action: 'continue' },
      followUpTask: null,
    }));
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      submit,
      getTask: vi.fn(() => task),
      getResultEnvelope: vi.fn(() => null),
      acknowledgeResult,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
      getWorkAdmissionBlock: () => ({
        code: 'CONTEXT_MODE_RECOVERY_PENDING',
        error: 'Context-mode recovery is pending',
      }),
    });

    await expect(runtime.handleRpc({ method: 'submit', params: submitParams(1) }))
      .rejects.toMatchObject({ code: 'CONTEXT_MODE_RECOVERY_PENDING', statusCode: 503 });
    expect(submit).not.toHaveBeenCalled();
    await expect(runtime.handleRpc({
      method: 'status',
      params: { taskId: task.taskId, rootSessionId: task.rootSessionId, directory: task.directory },
    })).resolves.toMatchObject({ task: { taskId: task.taskId } });
    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: task.taskId,
        rootSessionId: task.rootSessionId,
        directory: task.directory,
        action: 'continue',
        idempotencyKey: 'continue-during-recovery',
      },
    })).resolves.toMatchObject({ resultEnvelope: { taskId: task.taskId } });
    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: task.taskId,
        rootSessionId: task.rootSessionId,
        directory: task.directory,
        action: 'retry',
        idempotencyKey: 'retry-during-recovery',
      },
    })).rejects.toMatchObject({ code: 'CONTEXT_MODE_RECOVERY_PENDING', statusCode: 503 });
    expect(acknowledgeResult).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it('rejects read-only Designer before scheduler admission', async () => {
    const submit = vi.fn();
    const publishEvent = vi.fn();
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      submit,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      publishEvent,
      executor: { async start() { throw new Error('must not start'); } },
    });

    await expect(runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { readOnly: true, agent: 'designer' }),
    })).rejects.toMatchObject({
      code: 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED',
      statusCode: 409,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('rejects incompatible read-only providers before scheduler admission', async () => {
    const submit = vi.fn();
    const publishEvent = vi.fn();
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      submit,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      publishEvent,
      executor: { async start() { throw new Error('must not start'); } },
    });

    await expect(runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { readOnly: true, providerId: 'cursor-acp' }),
    })).rejects.toMatchObject({
      code: 'MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED',
      statusCode: 409,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('repeats owner model resolution at admission while preserving plan-safe and Council executions', async () => {
    const resolveAgentExecution = vi.fn(async () => ({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      variant: 'high',
      source: 'personal',
    }));
    let taskIndex = 0;
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() { return await new Promise(() => {}); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      resolveAgentExecution,
      createTaskId: () => `dvr_task_owner_${++taskIndex}`,
      createLeaseToken: () => `dvr_lease_owner_${taskIndex}`,
      now: () => 10_000,
    });

    const personal = await runtime.handleRpc({ method: 'submit', params: submitParams(1) });
    expect(personal.task).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      variant: 'high',
    });

    resolveAgentExecution.mockResolvedValueOnce({
      providerId: 'cursor-acp',
      modelId: 'composer-2.5',
      variant: 'high',
      source: 'personal',
    });
    const planSafe = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(2, {
        readOnly: true,
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'medium',
      }),
    });
    expect(planSafe.task).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      variant: 'medium',
    });

    const council = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(3, {
        deadlineClass: 'council',
        providerId: 'openai',
        modelId: 'gpt-5.5',
        agent: 'councillor',
      }),
    });
    expect(council.task).toMatchObject({ providerId: 'openai', modelId: 'gpt-5.5' });
    expect(resolveAgentExecution).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

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

  it('exposes task-scoped provider-recovery continuation claims through the private bridge', async () => {
    const { task } = createWaitScheduler();
    const claimProviderRecoveryContinuation = vi.fn(async () => ({
      claimed: true,
      expiresAt: 61_000,
    }));
    const releaseProviderRecoveryContinuation = vi.fn(async () => ({ released: true }));
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn(() => task),
      claimProviderRecoveryContinuation,
      releaseProviderRecoveryContinuation,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
    });
    const params = {
      taskId: task.taskId,
      rootSessionId: task.rootSessionId,
      directory: task.directory,
      claimantId: 'plugin-instance',
    };

    await expect(runtime.handleRpc({
      method: 'claim_provider_recovery_continuation',
      params,
    })).resolves.toEqual({ claimed: true, expiresAt: 61_000 });
    await expect(runtime.handleRpc({
      method: 'release_provider_recovery_continuation',
      params,
    })).resolves.toEqual({ released: true });
    expect(claimProviderRecoveryContinuation).toHaveBeenCalledWith(params);
    expect(releaseProviderRecoveryContinuation).toHaveBeenCalledWith(params);

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

  it('keeps private results eager by default, pages explicit references, and leaves UI snapshots eager', async () => {
    const preview = `large:${'🙂e\u0301'.repeat(2_000)}:result`;
    const { task, resultEnvelope } = createTerminalPair('reference', preview);
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn((taskId) => taskId === task.taskId ? task : null),
      getResultEnvelope: vi.fn((taskId) => taskId === task.taskId ? resultEnvelope : null),
      listTasks: vi.fn(() => [task]),
      listResultEnvelopes: vi.fn(() => [resultEnvelope]),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
    });
    const scope = {
      taskId: task.taskId,
      rootSessionId: task.rootSessionId,
      directory: task.directory,
    };

    const eager = await runtime.handleRpc({ method: 'status', params: scope });
    expect(eager).toMatchObject({
      task: { recoverablePreview: preview },
      resultEnvelope: { recoverablePreview: preview },
    });
    expect(eager).not.toHaveProperty('resultReference');

    const projected = await runtime.handleRpc({
      method: 'status',
      params: { ...scope, resultMode: 'reference' },
    });
    expect(projected.task).not.toHaveProperty('recoverablePreview');
    expect(projected.resultEnvelope).not.toHaveProperty('recoverablePreview');
    expect(projected.resultEnvelope).toMatchObject({
      failureReason: null,
      canonicalRefs: resultEnvelope.canonicalRefs,
      action: null,
    });

    let reference = projected.resultReference;
    const pages = [reference.text];
    while (!reference.complete) {
      const page = await runtime.handleRpc({
        method: 'read_result',
        params: { ...scope, resultCursor: reference.nextCursor },
      });
      reference = page.resultReference;
      pages.push(reference.text);
    }
    expect(pages.join('')).toBe(preview);

    const snapshot = await runtime.getSnapshot({ rootSessionId: task.rootSessionId });
    expect(snapshot.tasks[0].recoverablePreview).toBe(preview);
    expect(snapshot.resultEnvelopes[0].recoverablePreview).toBe(preview);
    await expect(runtime.handleRpc({
      method: 'status',
      params: { ...scope, resultMode: 'lazy' },
    })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });

    await runtime.shutdown();
  });

  it('projects every model-facing task-result wrapper only after a matching retained envelope', async () => {
    const preview = 'x'.repeat(9_000);
    const original = createTerminalPair('original', preview, { sequence: 1 });
    const descendant = createTerminalPair('descendant', preview, { sequence: 2 });
    const followUp = createTerminalPair('follow_up', preview, { sequence: 3 });
    const acknowledgedEnvelope = {
      ...original.resultEnvelope,
      acknowledgedAt: 2_000,
      action: 'retry',
      followUpTaskId: followUp.task.taskId,
    };
    const tasks = new Map([
      [original.task.taskId, original.task],
      [descendant.task.taskId, descendant.task],
      [followUp.task.taskId, followUp.task],
    ]);
    const envelopes = new Map([
      [original.task.taskId, acknowledgedEnvelope],
      [descendant.task.taskId, descendant.resultEnvelope],
      [followUp.task.taskId, followUp.resultEnvelope],
    ]);
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      submit: vi.fn(async () => original.task),
      getTask: vi.fn((taskId) => tasks.get(taskId) ?? null),
      getResultEnvelope: vi.fn((taskId) => envelopes.get(taskId) ?? null),
      waitForTask: vi.fn(async () => original.task),
      cancelTask: vi.fn(async () => [original.task, descendant.task]),
      acknowledgeResult: vi.fn(async () => ({
        envelope: acknowledgedEnvelope,
        followUpTask: followUp.task,
      })),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
      now: () => 10_000,
    });
    const scope = {
      taskId: original.task.taskId,
      rootSessionId: original.task.rootSessionId,
      directory: original.task.directory,
      resultMode: 'reference',
    };

    const responses = [
      await runtime.handleRpc({ method: 'submit', params: {
        ...submitParams(1),
        resultMode: 'reference',
      } }),
      await runtime.handleRpc({ method: 'status', params: scope }),
      await runtime.handleRpc({ method: 'wait', params: scope }),
      await runtime.handleRpc({ method: 'cancel', params: { ...scope, cascade: true } }),
      await runtime.handleRpc({ method: 'acknowledge', params: {
        ...scope,
        action: 'retry',
        idempotencyKey: 'ack-reference',
      } }),
    ];

    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain('recoverablePreview');
    }
    expect(responses[0]).toHaveProperty('resultReference');
    expect(responses[3].tasks).toHaveLength(2);
    expect(responses[3].tasks.every((entry) => entry.resultReference)).toBe(true);
    expect(responses[4]).toMatchObject({
      resultReference: { taskId: original.task.taskId },
      followUpTask: { resultReference: { taskId: followUp.task.taskId } },
    });

    await runtime.shutdown();
  });

  it('enforces strict result scope and stable cursor errors without mutating scheduler state', async () => {
    const preview = 'x'.repeat(9_000);
    const pair = createTerminalPair('cursor_errors', preview);
    let retainedEnvelope = pair.resultEnvelope;
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn((taskId) => taskId === pair.task.taskId ? pair.task : null),
      getResultEnvelope: vi.fn(() => retainedEnvelope),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
    });
    const scope = {
      taskId: pair.task.taskId,
      rootSessionId: pair.task.rootSessionId,
      directory: pair.task.directory,
    };
    const projected = await runtime.handleRpc({
      method: 'status',
      params: { ...scope, resultMode: 'reference' },
    });
    const resultCursor = projected.resultReference.nextCursor;

    for (const params of [
      { ...scope, rootSessionId: 'ses_other', resultCursor },
      { ...scope, directory: '/other', resultCursor },
      { taskId: scope.taskId, directory: scope.directory, resultCursor },
      { taskId: scope.taskId, rootSessionId: scope.rootSessionId, resultCursor },
    ]) {
      await expect(runtime.handleRpc({ method: 'read_result', params }))
        .rejects.toMatchObject({ code: 'task_scope_mismatch', statusCode: 403 });
    }
    await expect(runtime.handleRpc({
      method: 'read_result',
      params: { ...scope, resultCursor: 'malformed' },
    })).rejects.toMatchObject({ code: 'invalid_result_cursor', statusCode: 400 });

    retainedEnvelope = null;
    await expect(runtime.handleRpc({ method: 'read_result', params: { ...scope, resultCursor } }))
      .rejects.toMatchObject({ code: 'result_not_found', statusCode: 404 });
    retainedEnvelope = { ...pair.resultEnvelope, envelopeId: 'dvr_result_replaced_2' };
    await expect(runtime.handleRpc({ method: 'read_result', params: { ...scope, resultCursor } }))
      .rejects.toMatchObject({ code: 'result_reference_mismatch', statusCode: 409 });
    retainedEnvelope = { ...pair.resultEnvelope, failureReason: 'contract mismatch' };
    const mismatch = await runtime.handleRpc({
      method: 'status',
      params: { ...scope, resultMode: 'reference' },
    });
    expect(mismatch.task.recoverablePreview).toBe(preview);
    expect(mismatch.resultEnvelope.recoverablePreview).toBe(preview);
    expect(mismatch).not.toHaveProperty('resultReference');
    await expect(runtime.handleRpc({ method: 'read_result', params: { ...scope, resultCursor } }))
      .rejects.toMatchObject({ code: 'result_reference_mismatch', statusCode: 409 });

    scheduler.getTask.mockReturnValueOnce(null);
    await expect(runtime.handleRpc({ method: 'read_result', params: { ...scope, resultCursor } }))
      .rejects.toMatchObject({ code: 'task_not_found', statusCode: 404 });
    expect(scheduler.getResultEnvelope).not.toHaveBeenCalledWith('dvr_task_mutated');
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
      params: submitParams(1, {
        dispatchGroupId: 'msg_parent',
        dispatchCallId: 'call_barrier_start',
        readOnly: true,
      }),
    });
    expect(submitted.task).not.toHaveProperty('dispatchGroupId');
    expect(submitted.task).not.toHaveProperty('readOnly');
    expect(submitted.task.dispatchCallId).toBe('call_barrier_start');
    expect(runs[0].task.dispatchCallId).toBe('call_barrier_start');
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

  it('enforces fresh rewritten-prompt recovery for provider prompt rejection', async () => {
    const failureReason = 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.';
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() { return { status: 'failed', failureReason, resumable: true }; },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_prompt_rejected',
      createLeaseToken: () => 'dvr_lease_prompt_rejected',
      now: () => 1_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, {
        childSessionId: 'ses_child_prompt_rejected',
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
      failureKind: 'provider_prompt_rejected',
      agentRetryAvailable: true,
    });
    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: submitted.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'resume',
        idempotencyKey: 'prompt-rejected-resume',
      },
    })).rejects.toMatchObject({
      code: 'provider_prompt_rejection_requires_fresh_retry',
      statusCode: 409,
    });
    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: submitted.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'prompt-rejected-retry-without-prompt',
      },
    })).rejects.toMatchObject({
      code: 'provider_prompt_rejection_requires_reframed_prompt',
      statusCode: 409,
    });
    await runtime.shutdown();
  });

  it.each(['designer', 'fixer'])('enforces a 60-minute %s deadline for starts and follow-ups', async (agent) => {
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
        return () => `dvr_task_specialist_deadline_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_specialist_deadline_${++index}`;
      })(),
      now: () => 10_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { agent, timeoutAt: 1_810_000 }),
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
        idempotencyKey: `retry-${agent}-deadline`,
      },
    });
    expect(retried.followUpTask.task.timeoutAt).toBe(3_610_000);
    await runtime.shutdown();
  });

  it('defaults Oracle to 15 minutes and preserves an explicit 30-minute deep-review window', async () => {
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
    const focused = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { agent: 'oracle', timeoutAt: 610_000 }),
    });
    expect(focused.task.timeoutAt).toBe(910_000);

    const deep = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(2, { agent: 'oracle', timeoutAt: 1_810_000 }),
    });
    expect(deep.task.timeoutAt).toBe(1_810_000);
    await runtime.flush();

    const retried = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: deep.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'retry-oracle-deep-deadline',
      },
    });
    expect(retried.followUpTask.task.timeoutAt).toBe(1_810_000);
    await runtime.shutdown();
  });

  it('gives Designer retry, resume, and retry-in-place follow-ups a fresh 60-minute deadline', async () => {
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
        params: submitParams(index, { agent: 'designer', childSessionId: `ses_child_${index}` }),
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
      expect(result.followUpTask.task.timeoutAt).toBe(3_610_000);
    }

    await runtime.shutdown();
  });

  it('carries a long source window into follow-ups and lets timeoutSeconds extend it', async () => {
    const TWO_HOURS = 2 * 60 * 60 * 1_000;
    const runtime = createWebManagedOrchestrationRuntime({
      persistence: createPersistence(),
      executor: {
        async start() {
          return { status: 'failed', failureReason: 'Managed task timed out at 20000', resumable: true };
        },
        async resume() {
          return { status: 'failed', failureReason: 'Managed task timed out at 30000', resumable: true };
        },
        async retryInPlace() {
          return { status: 'failed', failureReason: 'Managed task timed out at 40000', resumable: true };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' }; },
        async readRecoverableResult() { return {}; },
        async shutdown() {},
      },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_window_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_window_${++index}`;
      })(),
      now: () => 10_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, {
        childSessionId: 'ses_child_window',
        timeoutAt: 10_000 + TWO_HOURS,
      }),
    });
    expect(submitted.task.timeoutAt).toBe(10_000 + TWO_HOURS);
    await runtime.flush();

    // A 2h task that times out must not silently drop to the 30-minute default when it
    // is continued; the remaining work was sized against the original window.
    const resumed = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: submitted.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'resume',
        idempotencyKey: 'window-inherit-resume',
      },
    });
    expect(resumed.followUpTask.task.timeoutAt).toBe(10_000 + TWO_HOURS);
    await runtime.flush();

    const extended = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: resumed.followUpTask.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry_in_place',
        idempotencyKey: 'window-extend-retry',
        providerId: 'openai',
        modelId: 'gpt-5.4',
        variant: null,
        timeoutSeconds: 4 * 60 * 60,
      },
    });
    expect(extended.followUpTask.task.timeoutAt).toBe(10_000 + 4 * 60 * 60 * 1_000);

    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: submitted.task.taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'resume',
        idempotencyKey: 'window-invalid-timeout',
        timeoutSeconds: 0,
      },
    })).rejects.toThrow('timeoutSeconds must be a positive safe integer');

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

  it('dispatches auxiliary RPC methods without touching scheduler initialization', async () => {
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    };
    const report = vi.fn((params) => ({ accepted: true, sampleID: params.sampleID }));
    const runtime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
      auxiliaryRpcHandlers: { telemetry_report: report },
    });

    await expect(runtime.handleRpc({
      method: 'telemetry_report',
      params: { sampleID: 'sample_1', value: 10 },
    })).resolves.toEqual({ accepted: true, sampleID: 'sample_1' });
    expect(report).toHaveBeenCalledWith(
      { sampleID: 'sample_1', value: 10 },
      undefined,
    );
    expect(scheduler.initialize).not.toHaveBeenCalled();

    // Auxiliary validation failures surface as normalized invalid_request errors.
    const throwingRuntime = createWebManagedOrchestrationRuntime({
      scheduler,
      persistence: createPersistence(),
      executor: { async start() { throw new Error('must not start'); } },
      auxiliaryRpcHandlers: {
        telemetry_report: () => { throw new TypeError('sampleID is required'); },
      },
    });
    await expect(throwingRuntime.handleRpc({
      method: 'telemetry_report',
      params: {},
    })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });

    await runtime.shutdown();
    await throwingRuntime.shutdown();
  });
});
