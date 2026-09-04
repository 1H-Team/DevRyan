import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createManagedTaskRecord,
  createManagedTaskResultEnvelope,
  MANAGED_CONTEXT_MODE_WRITABLE_PROMPT,
  type ManagedOrchestrationState,
  type ManagedResultReference,
  type ManagedTaskExecutor,
  type ManagedTaskExecutorResult,
  type ManagedTaskRecord,
  type ManagedTaskResultEnvelope,
  type ManagedTaskScheduler,
} from '@openchamber/orchestration-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createVsCodeManagedOpenCodeExecutor,
  createVsCodeManagedOrchestrationHost,
  createVsCodeManagedOrchestrationLedger,
  createVsCodeManagedOrchestrationRuntime,
} from './managedOrchestrationRuntime';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-vscode-orchestration-'));
  temporaryDirectories.push(directory);
  return directory;
};

const queuedTask = (index: number) => createManagedTaskRecord({
  taskId: `dvr_task_${index}`,
  idempotencyKey: `task-${index}`,
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  sequence: index,
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Task ${index}`,
  prompt: `Run task ${index}.`,
  attempt: 1,
  priorTaskId: null,
  executionKind: 'start',
  createdAt: 1_000 + index,
  timeoutAt: null,
});

const submitParams = (index: number, overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: `root-message-task-${index}`,
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator' as const,
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Task ${index}`,
  prompt: `Run task ${index}.`,
  ...overrides,
});

const getTask = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('task' in value)) {
    throw new TypeError('expected task result');
  }
  const task = value.task;
  if (!task || typeof task !== 'object') throw new TypeError('expected task record');
  return task as {
    taskId: string;
    status: string;
    childSessionId?: string | null;
    dispatchCallId?: string | null;
    timeoutAt: number | null;
  };
};

const getFollowUpTask = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('followUpTask' in value)) {
    throw new TypeError('expected follow-up task result');
  }
  return getTask(value.followUpTask);
};

const createPersistence = () => {
  let state: ManagedOrchestrationState | null = null;
  return {
    async load() { return state; },
    async save(value: ManagedOrchestrationState) { state = structuredClone(value); },
  };
};

const createTerminalPair = (
  suffix: string,
  recoverablePreview: string,
  overrides: {
    sequence?: number;
    status?: ManagedTaskRecord['status'];
    failureReason?: string | null;
    partial?: boolean;
    resumable?: boolean;
  } = {},
) => {
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
  const task: ManagedTaskRecord = {
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

const getResultReference = (value: unknown): ManagedResultReference => {
  if (!value || typeof value !== 'object' || !('resultReference' in value)) {
    throw new TypeError('expected managed result reference wrapper');
  }
  const reference = value.resultReference;
  if (!reference || typeof reference !== 'object') {
    throw new TypeError('expected managed result reference');
  }
  return reference as ManagedResultReference;
};

const deferred = () => {
  let resolve!: (value: ManagedTaskExecutorResult) => void;
  const promise = new Promise<ManagedTaskExecutorResult>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

// Auto-resume planning and attempts run on real zero-delay timers; poll until
// the scheduler reaches the expected durable state.
const waitFor = async <T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 5_000,
): Promise<T> => {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('VS Code managed orchestration owner', () => {
  it('rejects an exact catalog miss before scheduler admission and tolerates unknown catalogs', async () => {
    const scheduler = {
      submit: vi.fn(async () => createTerminalPair('catalog', '').task),
      getResultEnvelope: vi.fn(() => null),
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const validateAgentExecution = vi.fn(async () => false as boolean | null);
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      } as ManagedTaskExecutor,
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
    const task = queuedTask(1);
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
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
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

  it('routes set_auto_resume through task scope, validates enabled, and projects the envelope', async () => {
    const { task, resultEnvelope } = createTerminalPair('auto_resume', 'parked', {
      status: 'failed',
      failureReason: 'out of usage',
      resumable: true,
    });
    const updated = { ...resultEnvelope, autoResume: { enabled: false, state: 'cancelled' } };
    const setResultAutoResume = vi.fn<(
      taskId: string,
      options: { enabled: boolean },
    ) => Promise<{ envelope: typeof updated }>>(async () => ({ envelope: updated }));
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn(() => task),
      getResultEnvelope: vi.fn(() => resultEnvelope),
      setResultAutoResume,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
    });

    await expect(runtime.handleRpc({
      method: 'set_auto_resume',
      params: { taskId: task.taskId, rootSessionId: 'ses_other', enabled: false },
    })).rejects.toMatchObject({ code: 'task_scope_mismatch', statusCode: 403 });
    await expect(runtime.handleRpc({
      method: 'set_auto_resume',
      params: { taskId: task.taskId, rootSessionId: task.rootSessionId, enabled: 'no' },
    })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
    expect(setResultAutoResume).not.toHaveBeenCalled();

    await expect(runtime.handleRpc({
      method: 'set_auto_resume',
      params: { taskId: task.taskId, rootSessionId: task.rootSessionId, directory: task.directory, enabled: false },
    })).resolves.toEqual({ resultEnvelope: updated });
    expect(setResultAutoResume).toHaveBeenCalledWith(task.taskId, { enabled: false });

    for (const code of ['auto_resume_not_applicable', 'auto_resume_stale']) {
      setResultAutoResume.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await expect(runtime.handleRpc({
        method: 'set_auto_resume',
        params: { taskId: task.taskId, rootSessionId: task.rootSessionId, enabled: true },
      })).rejects.toMatchObject({ code, statusCode: 409 });
    }
    await runtime.shutdown();
  });

  it('drops autoResumeGeneration from acknowledgements that do not come from the auto-resume attempt', async () => {
    const task = queuedTask(1);
    const acknowledgeResult = vi.fn<(
      taskId: string,
      options: Record<string, unknown>,
    ) => Promise<{ envelope: { taskId: string; action: string }; followUpTask: null }>>(async () => ({
      envelope: { taskId: task.taskId, action: 'continue' },
      followUpTask: null,
    }));
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn(() => task),
      getResultEnvelope: vi.fn(() => null),
      acknowledgeResult,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
    });

    await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: task.taskId,
        rootSessionId: task.rootSessionId,
        directory: task.directory,
        action: 'continue',
        idempotencyKey: 'continue-public',
        autoResumeGeneration: 3,
      },
    });
    expect(acknowledgeResult).toHaveBeenCalledTimes(1);
    expect(acknowledgeResult.mock.calls[0][1]).not.toHaveProperty('autoResumeGeneration');
    expect(acknowledgeResult.mock.calls[0][1]).toMatchObject({ action: 'continue', idempotencyKey: 'continue-public' });
    await runtime.shutdown();
  });

  it('cancels auto-resume plans for deleted sessions once the scheduler is initialized', async () => {
    const task = queuedTask(1);
    const cancelAutoResumeForSession = vi.fn<(
      sessionId: string,
      reason: string,
    ) => Promise<{ cancelledTaskIds: string[] }>>(async () => ({
      cancelledTaskIds: [task.taskId],
    }));
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn(() => task),
      getResultEnvelope: vi.fn(() => null),
      cancelAutoResumeForSession,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
    });
    const deleted = { type: 'session.deleted', properties: { info: { id: 'ses_root' } } };

    runtime.processOpenCodeEvent(deleted);
    expect(cancelAutoResumeForSession).not.toHaveBeenCalled();

    await runtime.initialize();
    runtime.processOpenCodeEvent(deleted);
    runtime.processOpenCodeEvent({ type: 'session.updated', properties: { info: { id: 'ses_root' } } });
    runtime.processOpenCodeEvent({ type: 'session.deleted', properties: {} });
    await Promise.resolve();
    expect(cancelAutoResumeForSession).toHaveBeenCalledTimes(1);
    expect(cancelAutoResumeForSession).toHaveBeenCalledWith('ses_root', 'session_deleted');
    await runtime.shutdown();
  });

  it('defers automatic resume attempts while work admission is blocked, then resumes on the backup model', async () => {
    let block: { code: string; error: string } | null = null;
    const starts: ManagedTaskRecord[] = [];
    const firstStart = deferred();
    const resolveBackupExecution = vi.fn(async () => ({ providerId: 'openai', modelId: 'gpt-5.4', variant: 'high' }));
    const resolveProviderReset = vi.fn(async () => null);
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        start(task) {
          starts.push(task);
          return firstStart.promise;
        },
        // Auto-resume acknowledges with retry_in_place, so the follow-up runs
        // through the executor's in-place retry path; a child completes only
        // once the executor accepted it.
        async retryInPlace(task, control) {
          starts.push(task);
          await control.markAccepted();
          return { status: 'completed' as const, recoverablePreview: 'done on the backup model' };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
      getWorkAdmissionBlock: () => block,
      resolveOwnerKey: () => 'user:owner',
      resolveBackupExecution,
      resolveProviderReset,
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_auto_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_auto_${++index}`;
      })(),
      now: () => 1_000,
    });
    const submitted = getTask(await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { childSessionId: 'ses_child_auto', dispatchGroupId: 'msg_parent' }),
    }));
    // Block admission only once the child is running, then let it hit the limit.
    block = { code: 'CONTEXT_MODE_RECOVERY_PENDING', error: 'Context-mode recovery is pending' };
    firstStart.resolve({ status: 'failed', failureReason: 'out of usage', resumable: true });
    await runtime.flush();
    type ParkedStatus = {
      resultEnvelope?: {
        action: string | null;
        autoResume?: (Record<string, unknown> & { nextAttemptAt?: number | null; state?: string }) | null;
      };
    };
    const status = async () => await runtime.handleRpc({
      method: 'status',
      params: { taskId: submitted.taskId, rootSessionId: 'ses_root' },
    }) as ParkedStatus;
    const diagnostics = () => runtime.getDiagnostics() as { scheduler: { pendingAutoResumeCount: number } };

    // The scheduler planned the backup attempt, the host answered "deferred"
    // (admission blocked), and the plan re-armed 30 s out without a follow-up.
    const parked = await waitFor(async () => {
      const current = await status();
      return current.resultEnvelope?.autoResume?.nextAttemptAt === 31_000 ? current : null;
    });
    expect(parked.resultEnvelope?.action).toBeNull();
    expect(parked.resultEnvelope?.autoResume).toMatchObject({
      enabled: true,
      state: 'scheduled',
      attemptCount: 0,
      hostFailures: 0,
      lastError: null,
      nextAttemptAt: 31_000,
      target: { kind: 'backup', providerId: 'openai', modelId: 'gpt-5.4', variant: 'high' },
    });
    expect(starts).toHaveLength(1);
    expect(resolveBackupExecution).toHaveBeenCalledWith({
      rootSessionId: 'ses_root',
      directory: '/workspace',
      agent: 'explorer',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
    });
    expect(resolveProviderReset).toHaveBeenCalledWith({
      providerId: 'github-copilot',
      ownerKey: 'user:owner',
      directory: '/workspace',
      rootSessionId: 'ses_root',
    });
    expect(diagnostics().scheduler.pendingAutoResumeCount).toBe(1);

    // Lift the block and re-plan immediately through the UI toggle: the attempt
    // now acknowledges the parked result itself and starts the backup child.
    block = null;
    await runtime.handleRpc({
      method: 'set_auto_resume',
      params: { taskId: submitted.taskId, rootSessionId: 'ses_root', enabled: false },
    });
    const enabled = await runtime.handleRpc({
      method: 'set_auto_resume',
      params: { taskId: submitted.taskId, rootSessionId: 'ses_root', enabled: true },
    }) as ParkedStatus;
    expect(enabled.resultEnvelope?.autoResume).toMatchObject({ enabled: true, state: 'planning' });
    type Snapshot = {
      tasks: Array<{ taskId: string; status: string }>;
      resultEnvelopes: Array<{
        taskId: string;
        action: string | null;
        followUpTaskId?: string | null;
        autoResume: { state: string } | null;
      }>;
    };
    const settled = await waitFor(async () => {
      const snapshot = await runtime.getSnapshot({ rootSessionId: 'ses_root' }) as unknown as Snapshot;
      const followUp = snapshot.tasks.find((entry) => entry.taskId === 'dvr_task_auto_2');
      const source = snapshot.resultEnvelopes.find((entry) => entry.taskId === submitted.taskId);
      return followUp?.status === 'completed' && source?.autoResume?.state === 'succeeded' ? snapshot : null;
    });
    expect(settled.resultEnvelopes.find((entry) => entry.taskId === submitted.taskId)).toMatchObject({
      action: 'retry_in_place',
      followUpTaskId: 'dvr_task_auto_2',
      autoResume: { state: 'succeeded', lastAttemptTaskId: 'dvr_task_auto_2', target: { kind: 'backup' } },
    });
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({
      taskId: 'dvr_task_auto_2',
      priorTaskId: submitted.taskId,
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
      executionKind: 'retry_in_place',
    });
    expect(diagnostics().scheduler.pendingAutoResumeCount).toBe(0);
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
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      publishEvent,
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
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
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      publishEvent,
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
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

  it('matches the web provider-recovery continuation bridge contract', async () => {
    const continuations = [{
      sourceTaskId: 'dvr_task_limited',
      taskId: 'dvr_task_recovered',
      rootSessionId: 'ses_root',
      childSessionId: 'ses_child',
      directory: '/workspace',
    }];
    const listReadyProviderRecoveryContinuations = vi.fn(() => continuations);
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      listReadyProviderRecoveryContinuations,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
    });

    await expect(runtime.handleRpc({
      method: 'list_provider_recovery_continuations',
      params: { sessionId: 'ses_child' },
    })).resolves.toEqual({ continuations });
    expect(listReadyProviderRecoveryContinuations).toHaveBeenCalledWith({
      sessionId: 'ses_child',
    });

    await runtime.shutdown();
  });

  it('matches the web provider-recovery continuation claim bridge contract', async () => {
    const task = queuedTask(1);
    const claimProviderRecoveryContinuation = vi.fn<ManagedTaskScheduler['claimProviderRecoveryContinuation']>(
      async () => ({ claimed: true, expiresAt: 61_000 }),
    );
    const releaseProviderRecoveryContinuation = vi.fn<ManagedTaskScheduler['releaseProviderRecoveryContinuation']>(
      async () => ({ released: true }),
    );
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn(() => task),
      claimProviderRecoveryContinuation,
      releaseProviderRecoveryContinuation,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
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

  it('matches web validation and clamping for private wait slices', async () => {
    const task = queuedTask(1);
    const waitForTask = vi.fn<ManagedTaskScheduler['waitForTask']>(async () => task);
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn(() => task),
      getResultEnvelope: vi.fn(() => null),
      waitForTask,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
    });
    const waitParams = {
      taskId: task.taskId,
      rootSessionId: 'ses_root',
      directory: '/workspace',
    };

    await runtime.handleRpc({ method: 'wait', params: waitParams });
    await runtime.handleRpc({ method: 'wait', params: { ...waitParams, waitTimeoutMs: 1 } });
    await runtime.handleRpc({ method: 'wait', params: { ...waitParams, waitTimeoutMs: 30_000 } });

    expect(waitForTask.mock.calls.map(([, options]) => options)).toEqual([
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
    expect(waitForTask).toHaveBeenCalledTimes(3);
    await runtime.shutdown();
  });

  it('keeps private results eager by default, pages explicit references, and leaves snapshots eager', async () => {
    const preview = `large:${'🙂e\u0301'.repeat(2_000)}:result`;
    const { task, resultEnvelope } = createTerminalPair('reference', preview);
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn((taskId: string) => taskId === task.taskId ? task : null),
      getResultEnvelope: vi.fn((taskId: string) => taskId === task.taskId ? resultEnvelope : null),
      listTasks: vi.fn(() => [task]),
      listResultEnvelopes: vi.fn(() => [resultEnvelope]),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
    });
    const scope = {
      taskId: task.taskId,
      rootSessionId: task.rootSessionId,
      directory: task.directory,
    };

    await expect(runtime.handleRpc({ method: 'status', params: scope })).resolves.toMatchObject({
      task: { recoverablePreview: preview },
      resultEnvelope: { recoverablePreview: preview },
    });
    const projected = await runtime.handleRpc({
      method: 'status',
      params: { ...scope, resultMode: 'reference' },
    });
    expect(projected).toMatchObject({
      task: expect.not.objectContaining({ recoverablePreview: expect.anything() }),
      resultEnvelope: expect.objectContaining({
        failureReason: null,
        canonicalRefs: resultEnvelope.canonicalRefs,
        action: null,
      }),
    });

    let reference = getResultReference(projected);
    const pages = [reference.text];
    while (!reference.complete) {
      const page = await runtime.handleRpc({
        method: 'read_result',
        params: { ...scope, resultCursor: reference.nextCursor },
      });
      reference = getResultReference(page);
      pages.push(reference.text);
    }
    expect(pages.join('')).toBe(preview);

    const snapshot = await runtime.getSnapshot({ rootSessionId: task.rootSessionId });
    expect(snapshot.tasks).toMatchObject([{ recoverablePreview: preview }]);
    expect(snapshot.resultEnvelopes).toMatchObject([{ recoverablePreview: preview }]);
    await expect(runtime.handleRpc({
      method: 'status',
      params: { ...scope, resultMode: 'lazy' },
    })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
    await runtime.shutdown();
  });

  it('projects submit, status, wait, cascade, acknowledgement, and nested follow-up wrappers', async () => {
    const preview = 'x'.repeat(9_000);
    const original = createTerminalPair('original', preview, { sequence: 1 });
    const descendant = createTerminalPair('descendant', preview, { sequence: 2 });
    const followUp = createTerminalPair('follow_up', preview, { sequence: 3 });
    const acknowledgedEnvelope: ManagedTaskResultEnvelope = {
      ...original.resultEnvelope,
      acknowledgedAt: 2_000,
      action: 'retry',
      followUpTaskId: followUp.task.taskId,
    };
    const tasks = new Map<string, ManagedTaskRecord>([
      [original.task.taskId, original.task],
      [descendant.task.taskId, descendant.task],
      [followUp.task.taskId, followUp.task],
    ]);
    const envelopes = new Map<string, ManagedTaskResultEnvelope>([
      [original.task.taskId, acknowledgedEnvelope],
      [descendant.task.taskId, descendant.resultEnvelope],
      [followUp.task.taskId, followUp.resultEnvelope],
    ]);
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      submit: vi.fn(async () => original.task),
      getTask: vi.fn((taskId: string) => tasks.get(taskId) ?? null),
      getResultEnvelope: vi.fn((taskId: string) => envelopes.get(taskId) ?? null),
      waitForTask: vi.fn(async () => original.task),
      cancelTask: vi.fn(async () => [original.task, descendant.task]),
      acknowledgeResult: vi.fn(async () => ({
        envelope: acknowledgedEnvelope,
        followUpTask: followUp.task,
      })),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
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
    expect(responses[3]).toMatchObject({
      tasks: [
        { resultReference: { taskId: original.task.taskId } },
        { resultReference: { taskId: descendant.task.taskId } },
      ],
    });
    expect(responses[4]).toMatchObject({
      resultReference: { taskId: original.task.taskId },
      followUpTask: { resultReference: { taskId: followUp.task.taskId } },
    });
    await runtime.shutdown();
  });

  it('matches web strict scope, missing-result, malformed-cursor, and mismatch errors', async () => {
    const preview = 'x'.repeat(9_000);
    const pair = createTerminalPair('cursor_errors', preview);
    let retainedEnvelope: ManagedTaskResultEnvelope | null = pair.resultEnvelope;
    const getTaskMock = vi.fn((taskId: string) => taskId === pair.task.taskId ? pair.task : null);
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: getTaskMock,
      getResultEnvelope: vi.fn(() => retainedEnvelope),
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
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
    const nextCursor = getResultReference(projected).nextCursor;
    expect(typeof nextCursor).toBe('string');
    if (typeof nextCursor !== 'string') throw new Error('expected a result cursor');
    const resultCursor = nextCursor;

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
    await expect(runtime.handleRpc({
      method: 'status',
      params: { ...scope, resultMode: 'reference' },
    })).resolves.toMatchObject({
      task: { recoverablePreview: preview },
      resultEnvelope: { recoverablePreview: preview },
    });
    await expect(runtime.handleRpc({ method: 'read_result', params: { ...scope, resultCursor } }))
      .rejects.toMatchObject({ code: 'result_reference_mismatch', statusCode: 409 });

    getTaskMock.mockReturnValueOnce(null);
    await expect(runtime.handleRpc({ method: 'read_result', params: { ...scope, resultCursor } }))
      .rejects.toMatchObject({ code: 'task_not_found', statusCode: 404 });
    await runtime.shutdown();
  });

  it('matches web result-action waiting and follow-up projection', async () => {
    const original = queuedTask(1);
    const followUp = queuedTask(2);
    const resultEnvelope: ManagedTaskResultEnvelope = {
      owner: 'devryan',
      envelopeId: 'dvr_result_1_1',
      taskId: original.taskId,
      rootSessionId: 'ses_root',
      parentTaskId: null,
      childSessionId: 'ses_child',
      directory: '/workspace',
      sequence: 1,
      status: 'failed',
      partial: true,
      failureReason: 'Monthly usage limit reached',
      attempt: 1,
      priorTaskId: null,
      executionKind: 'start',
      recoverablePreview: 'Partial child result',
      canonicalRefs: [],
      resumable: true,
      createdAt: 2_000,
      acknowledgedAt: 2_100,
      action: 'retry_in_place',
      followUpTaskId: followUp.taskId,
      providerResetAt: null,
      autoResume: null,
    };
    const waitForResultAction = vi.fn<ManagedTaskScheduler['waitForResultAction']>(
      async () => resultEnvelope,
    );
    const scheduler = {
      initialize: vi.fn(async () => undefined),
      getTask: vi.fn((taskId: string) => (
        taskId === original.taskId ? original : taskId === followUp.taskId ? followUp : null
      )),
      getResultEnvelope: vi.fn(() => null),
      waitForResultAction,
      shutdown: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      getDiagnostics: vi.fn(() => ({})),
    } as unknown as ManagedTaskScheduler;
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      scheduler,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
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
          status: 'queued',
        },
      },
    });
    await runtime.shutdown();
  });

  it('matches the web handoff validation and safe task projection', async () => {
    const runs: Array<{ result: ReturnType<typeof deferred> }> = [];
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        start() {
          const result = deferred();
          runs.push({ result });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_vscode_handoff',
      createLeaseToken: () => 'dvr_lease_vscode_handoff',
      now: () => 1_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, {
        dispatchGroupId: 'msg_parent',
        dispatchCallId: 'call_vscode_handoff',
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
    }) as { state: string; tasks: Array<{ task: Record<string, unknown> }> };
    expect(inspection.state).toBe('confirmation_required');
    expect(inspection.tasks[0].task.taskId).toBe(getTask(submitted).taskId);
    expect(inspection.tasks[0].task).not.toHaveProperty('prompt');
    expect(inspection.tasks[0].task).not.toHaveProperty('idempotencyKey');
    expect(inspection.tasks[0].task).not.toHaveProperty('dispatchGroupId');
    expect(inspection.tasks[0].task.dispatchCallId).toBe('call_vscode_handoff');
    expect(inspection.tasks[0].task).not.toHaveProperty('leaseToken');

    const confirmed = await runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: true,
        idempotencyKey: 'switch-vscode-01',
      },
    }) as { state: string; tasks: Array<{ task: Record<string, unknown> }> };
    expect(confirmed.state).toBe('clear');
    expect(confirmed.tasks[0].task).toMatchObject({ status: 'aborted' });

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
    expect(runs).toHaveLength(1);
    await runtime.shutdown();
  });

  it('persists a private atomic ledger under extension storage', async () => {
    const storageDirectory = await createTemporaryDirectory();
    const ledger = createVsCodeManagedOrchestrationLedger({ storageDirectory });
    const expected = {
      version: 1 as const,
      tasks: [{ ...queuedTask(1), readOnly: true }],
      resultEnvelopes: [],
    };

    await ledger.save(expected);

    expect(await ledger.load()).toEqual(expected);
    expect(ledger.filePath.startsWith(storageDirectory)).toBe(true);
    expect((await fs.stat(ledger.filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(ledger.filePath))).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('hydrates legacy tasks without dispatch identity or read-only policy instead of quarantining them', async () => {
    const storageDirectory = await createTemporaryDirectory();
    const ledger = createVsCodeManagedOrchestrationLedger({ storageDirectory });
    const legacyTask = { ...queuedTask(1) } as Record<string, unknown>;
    delete legacyTask.dispatchGroupId;
    delete legacyTask.dispatchCallId;
    delete legacyTask.dispatchWaveId;
    delete legacyTask.readOnly;
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, JSON.stringify({
      version: 1,
      tasks: [legacyTask],
      resultEnvelopes: [],
    }), { mode: 0o600 });

    const loaded = await ledger.load();

    expect(loaded?.tasks[0].dispatchGroupId).toBeNull();
    expect(loaded?.tasks[0].dispatchCallId).toBeNull();
    expect(loaded?.tasks[0].dispatchWaveId).toBeNull();
    expect(loaded?.tasks[0].readOnly).toBe(false);
    expect(ledger.getDiagnostics?.().quarantinedPath).toBeNull();
  });

  it('publishes a visible recovery warning after quarantining an invalid ledger', async () => {
    const storageDirectory = await createTemporaryDirectory();
    const ledger = createVsCodeManagedOrchestrationLedger({ storageDirectory });
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, '{invalid json', { mode: 0o600 });
    const events: unknown[] = [];
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory,
      persistence: ledger,
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
      publishEvent: (event) => { events.push(event); },
      logger: { warn: vi.fn() },
    });

    await runtime.initialize();

    expect(events).toEqual([{
      type: 'openchamber:managed-orchestration-warning',
      properties: { message: expect.stringContaining('ledger was quarantined') },
    }]);
    await runtime.shutdown();
  });

  it('binds a token-authenticated private IPv4 RPC host and releases it', async () => {
    const handleRpc = vi.fn(async (request: unknown) => request);
    const host = createVsCodeManagedOrchestrationHost({ handleRpc });
    const environment = await host.start();

    try {
      expect(environment.DEVRYAN_ORCHESTRATION_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rpc$/);
      const unauthorized = await fetch(environment.DEVRYAN_ORCHESTRATION_URL, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'status', params: {} }),
      });
      expect(unauthorized.status).toBe(401);
      expect(handleRpc).not.toHaveBeenCalled();

      const accepted = await fetch(environment.DEVRYAN_ORCHESTRATION_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${environment.DEVRYAN_ORCHESTRATION_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'status', params: { taskId: 'dvr_task_1' } }),
      });
      expect(accepted.status).toBe(200);
      expect(handleRpc).toHaveBeenCalledTimes(1);
    } finally {
      await host.stop();
    }

    expect(host.getDiagnostics()).toMatchObject({ started: false, activeRequests: 0 });
    await expect(fetch(environment.DEVRYAN_ORCHESTRATION_URL)).rejects.toThrow();
  });

  it('owns one unbounded scheduler with immediate admission and prompt-free projections', async () => {
    const runs: Array<{ taskId: string; prompt: string; result: ReturnType<typeof deferred> }> = [];
    const events: unknown[] = [];
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        start(task) {
          const result = deferred();
          runs.push({ taskId: task.taskId, prompt: task.prompt, result });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
        async shutdown() {},
      },
      publishEvent: (event) => { events.push(event); },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_vscode_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_vscode_${++index}`;
      })(),
      now: () => 1_000,
    });

    const submitted: unknown[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const params = submitParams(index, index === 1 ? { timeoutAt: 1_500 } : {});
      if (index === 1) params.prompt = '  preserve RPC prompt whitespace\n';
      submitted.push(await runtime.handleRpc({ method: 'submit', params }));
    }
    submitted.push(await runtime.handleRpc({
      method: 'submit',
      params: submitParams(6, { rootSessionId: 'ses_second_root' }),
    }));
    await runtime.flush();

    expect(runs.map((run) => run.taskId)).toEqual([
      'dvr_task_vscode_1',
      'dvr_task_vscode_2',
      'dvr_task_vscode_3',
      'dvr_task_vscode_4',
      'dvr_task_vscode_5',
      'dvr_task_vscode_6',
    ]);
    expect(runs[0].prompt).toBe('  preserve RPC prompt whitespace\n');
    expect(getTask(submitted[3]).status).toBe('starting');
    expect(getTask(submitted[4]).status).toBe('starting');
    expect(getTask(submitted[5]).status).toBe('starting');
    expect(submitted.every((result) => getTask(result).timeoutAt === 1_801_000)).toBe(true);
    expect(submitted.every((result) => !('prompt' in getTask(result)))).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    await runtime.flush();
    expect(runs).toHaveLength(6);
    await runtime.shutdown();
  });

  it('projects exhausted usage as immediate manual recovery with web-runtime parity', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() { return { status: 'failed' as const, failureReason: 'out of usage', resumable: true }; },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
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
      params: { taskId: getTask(submitted).taskId, rootSessionId: 'ses_root' },
    }) as { task: Record<string, unknown>; resultEnvelope: Record<string, unknown> };

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
        taskId: getTask(submitted).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'resume',
        idempotencyKey: 'agent-rate-limit-resume',
      },
    })).rejects.toMatchObject({ code: 'manual_model_recovery_required', statusCode: 409 });
    await runtime.shutdown();
  });

  it('enforces fresh rewritten-prompt recovery with web-runtime parity', async () => {
    const failureReason = 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.';
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() { return { status: 'failed' as const, failureReason, resumable: true }; },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
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

    const taskId = getTask(submitted).taskId;
    const status = await runtime.handleRpc({
      method: 'status',
      params: { taskId, rootSessionId: 'ses_root' },
    }) as { task: Record<string, unknown> };
    expect(status.task).toMatchObject({
      status: 'failed',
      failureKind: 'provider_prompt_rejected',
      agentRetryAvailable: true,
    });
    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId,
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
        taskId,
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
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() {
          return { status: 'failed' as const, failureReason: 'temporary failure', resumable: true };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
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
    expect(getTask(submitted).timeoutAt).toBe(3_610_000);
    await runtime.flush();

    const retried = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(submitted).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: `retry-${agent}-deadline`,
      },
    });
    expect(getFollowUpTask(retried).timeoutAt).toBe(3_610_000);
    await runtime.shutdown();
  });

  it('defaults Oracle to 15 minutes and preserves an explicit 30-minute deep-review window', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() {
          return { status: 'failed' as const, failureReason: 'temporary failure', resumable: true };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
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
    expect(getTask(focused).timeoutAt).toBe(910_000);

    const deep = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(2, { agent: 'oracle', timeoutAt: 1_810_000 }),
    });
    expect(getTask(deep).timeoutAt).toBe(1_810_000);
    await runtime.flush();

    const retried = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(deep).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'retry-oracle-deep-deadline',
      },
    });
    expect(getFollowUpTask(retried).timeoutAt).toBe(1_810_000);
    await runtime.shutdown();
  });

  it('waits on a root-scoped private dispatch barrier with web-runtime parity', async () => {
    const runs: Array<{ result: ReturnType<typeof deferred>; task: ManagedTaskRecord }> = [];
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        start(task) {
          const result = deferred();
          runs.push({ result, task });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
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
    expect(getTask(submitted)).not.toHaveProperty('dispatchGroupId');
    expect(getTask(submitted)).not.toHaveProperty('readOnly');
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
      taskIds: [getTask(submitted).taskId],
    });

    await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(submitted).taskId,
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

  it('floors Designer follow-up deadlines, inherits longer source windows, and accepts explicit extensions', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
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
        async reconcile() { return { state: 'unavailable' as const }; },
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
    const originals: unknown[] = [];
    for (let index = 1; index <= 3; index += 1) {
      originals.push(await runtime.handleRpc({
        method: 'submit',
        params: submitParams(index, { agent: 'designer', childSessionId: `ses_child_${index}` }),
      }));
    }
    await runtime.flush();

    const actions = ['retry', 'resume', 'retry_in_place'] as const;
    for (let index = 0; index < actions.length; index += 1) {
      const result = await runtime.handleRpc({
        method: 'acknowledge',
        params: {
          taskId: getTask(originals[index]).taskId,
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
      }) as { followUpTask: unknown };
      expect(getTask(result.followUpTask).timeoutAt).toBe(3_610_000);
    }

    const longSource = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(4, {
        childSessionId: 'ses_child_long_window',
        timeoutAt: 10_000 + 2 * 60 * 60 * 1_000,
      }),
    });
    await runtime.flush();
    const extended = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(longSource).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'resume',
        idempotencyKey: 'ack-long-window',
        timeoutSeconds: 4 * 60 * 60,
      },
    }) as { followUpTask: unknown };
    expect(getTask(extended.followUpTask).timeoutAt).toBe(10_000 + 4 * 60 * 60 * 1_000);

    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(longSource).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'resume',
        idempotencyKey: 'ack-invalid-window',
        timeoutSeconds: 0,
      },
    })).rejects.toThrow('timeoutSeconds must be a positive safe integer');

    await runtime.shutdown();
  });

  it('maps the grouped agent retry ceiling to HTTP 409', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() {
          return {
            status: 'failed' as const,
            failureReason: 'provider connection ended',
            resumable: true,
          };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
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
        taskId: getTask(original).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'grouped-retry-1',
      },
    }) as { followUpTask: unknown };
    await runtime.flush();

    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(firstRecovery.followUpTask).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'grouped-retry-2',
      },
    })).rejects.toMatchObject({ code: 'managed_retry_limit_reached', statusCode: 409 });

    await runtime.shutdown();
  });

  it('preserves the private Council three-minute deadline class', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() { return await new Promise<ManagedTaskExecutorResult>(() => {}); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
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

    expect(getTask(submitted).timeoutAt).toBe(190_000);
    await runtime.shutdown();
  });

  it('does not expose a bridge or scheduler API to configured external OpenCode', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      isManagedOpenCode: () => false,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
    });

    await expect(runtime.prepareBridge()).rejects.toMatchObject({
      code: 'managed_runtime_unavailable',
      statusCode: 503,
    });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      },
    })).rejects.toMatchObject({ code: 'managed_runtime_unavailable', statusCode: 503 });
    expect(await runtime.getSnapshot()).toMatchObject({ available: false, tasks: [] });
    await runtime.shutdown();
  });

  it('routes normal and Cursor children through their authoritative owners', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const cursorSdkRuntime = {
      handlePromptAsync: vi.fn(async () => ({ handled: true, status: 204 })),
      getSessionStatus: vi.fn(() => ({ ses_cursor: { type: 'idle' } })),
      getSessionMessages: vi.fn(async () => [{
        info: { id: 'msg_cursor', role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: 'cursor result' }],
      }]),
      abortSession: vi.fn(async () => true),
      deleteSessionState: vi.fn(async () => true),
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const pathname = new URL(url).pathname;
      if (pathname === '/session' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const id = body.title === 'Cursor child' ? 'ses_cursor' : 'ses_normal';
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (pathname.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      if (pathname === '/session/status') return new Response(JSON.stringify({ ses_normal: { type: 'idle' } }));
      if (pathname.endsWith('/message')) return new Response(JSON.stringify([{
        info: { id: 'msg_normal', role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: 'normal result' }],
      }]));
      throw new Error(`unexpected request ${pathname}`);
    });
    const manager = {
      getApiUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
    };
    const executor = createVsCodeManagedOpenCodeExecutor({
      manager,
      cursorSdkRuntime,
      fetchImpl,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const control = {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
      async recordProgress() { return true; },
    };

    const normal = await executor.start({
      ...queuedTask(1),
      label: 'Normal child',
      prompt: '  preserve prompt whitespace\n',
    }, control);
    expect(normal.recoverablePreview).toBe('normal result');
    const promptRequest = requests.find(({ url }) => new URL(url).pathname.endsWith('/prompt_async'));
    expect(JSON.parse(String(promptRequest?.init?.body))).toMatchObject({
      tools: expect.objectContaining({
        'resend_*': false,
        'mcp__resend__*': false,
        ctx_execute: true,
        mcp__context_mode__ctx_execute: true,
        ctx_index: true,
        mcp__context_mode__ctx_index: true,
        task: false,
      }),
      parts: [{
        type: 'text',
        text: `${MANAGED_CONTEXT_MODE_WRITABLE_PROMPT}\n\n  preserve prompt whitespace\n`,
      }],
    });

    const cursor = await executor.start({
      ...queuedTask(2),
      providerId: 'cursor-acp',
      modelId: 'composer-2',
      agent: 'builder',
      label: 'Cursor child',
    }, control);
    expect(cursor.recoverablePreview).toBe('cursor result');
    expect(cursorSdkRuntime.handlePromptAsync).toHaveBeenCalledTimes(1);
    expect(requests.filter(({ url }) => new URL(url).pathname === '/session/status')).toHaveLength(1);
  });

  it('preserves structured Zen free-tier status metadata for immediate recovery', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let statusReads = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const pathname = new URL(url).pathname;
      if (pathname === '/session/status') {
        statusReads += 1;
        return new Response(JSON.stringify({
          ses_zen: statusReads === 1
            ? {
              type: 'retry',
              message: 'Subscribe to continue',
              action: { reason: 'free_tier_limit' },
              next: Date.now() + (4 * 60 * 60 * 1_000),
            }
            : { type: 'idle' },
        }));
      }
      if (pathname.endsWith('/message')) {
        return new Response(JSON.stringify([{
          info: { id: 'msg_partial', role: 'assistant', finish: 'tool-calls' },
          parts: [{ type: 'text', text: 'Partial work' }],
        }]));
      }
      if (pathname.endsWith('/abort')) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${init?.method} ${pathname}`);
    });
    const executor = createVsCodeManagedOpenCodeExecutor({
      manager: {
        getApiUrl: () => 'http://127.0.0.1:4096',
        getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      },
      fetchImpl,
      pollIntervalMs: 0,
    });

    await expect(executor.observe!({
      ...queuedTask(99),
      childSessionId: 'ses_zen',
      status: 'running',
    }, {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
      async recordProgress() { return true; },
    })).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'Provider usage limit reached: Subscribe to continue',
      recoverablePreview: 'Partial work',
      resumable: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests.some(({ url, init }) => (
      new URL(url).pathname.endsWith('/abort') && init?.method === 'POST'
    ))).toBe(true);
  });

  it('single-flights overlapping status observers by exact URL and polls again after settlement', async () => {
    let releaseStatus!: () => void;
    const firstStatusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    let statusRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/session/status') {
        statusRequests += 1;
        if (statusRequests === 1) await firstStatusGate;
        return new Response(JSON.stringify({
          ses_alpha: { type: 'idle' },
          ses_beta: { type: 'idle' },
        }));
      }
      if (url.pathname.endsWith('/message')) {
        const sessionId = url.pathname.split('/')[2];
        return new Response(JSON.stringify([{
          info: { id: `msg_${sessionId}`, role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: `${sessionId} result` }],
        }]));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const executor = createVsCodeManagedOpenCodeExecutor({
      manager: {
        getApiUrl: () => 'http://127.0.0.1:4096',
        getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      },
      fetchImpl,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const observe = (sessionId: string) => executor.observe!({
      ...queuedTask(sessionId === 'ses_alpha' ? 201 : 202),
      taskId: `dvr_task_${sessionId}`,
      childSessionId: sessionId,
      directory: '/workspace',
      providerId: 'openai',
      status: 'running',
    }, {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
      async recordProgress() { return true; },
    });

    const alpha = observe('ses_alpha');
    const beta = observe('ses_beta');
    await vi.waitFor(() => expect(statusRequests).toBe(1));
    releaseStatus();
    await expect(Promise.all([alpha, beta])).resolves.toMatchObject([
      { status: 'completed', recoverablePreview: 'ses_alpha result' },
      { status: 'completed', recoverablePreview: 'ses_beta result' },
    ]);
    expect(statusRequests).toBe(1);

    await expect(observe('ses_alpha')).resolves.toMatchObject({ status: 'completed' });
    expect(statusRequests).toBe(2);
  });

  it('does not share status requests across directory or resolved-port URL changes', async () => {
    const statusUrls: string[] = [];
    const releaseStatusRequests: Array<() => void> = [];
    let activePort = 4096;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/session/status') {
        statusUrls.push(url.toString());
        await new Promise<void>((resolve) => { releaseStatusRequests.push(resolve); });
        return new Response(JSON.stringify({
          ses_one: { type: 'idle' },
          ses_two: { type: 'idle' },
          ses_port_a: { type: 'idle' },
          ses_port_b: { type: 'idle' },
        }));
      }
      if (url.pathname.endsWith('/message')) {
        const sessionId = url.pathname.split('/')[2];
        return new Response(JSON.stringify([{
          info: { id: `msg_${sessionId}`, role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'done' }],
        }]));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const executor = createVsCodeManagedOpenCodeExecutor({
      manager: {
        getApiUrl: () => `http://127.0.0.1:${activePort}`,
        getOpenCodeAuthHeaders: () => ({}),
      },
      fetchImpl,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const observe = (sessionId: string, directory: string, index: number) => executor.observe!({
      ...queuedTask(index),
      taskId: `dvr_task_${sessionId}`,
      childSessionId: sessionId,
      directory,
      providerId: 'openai',
      status: 'running',
    }, {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
      async recordProgress() { return true; },
    });

    const differentDirectories = [
      observe('ses_one', '/workspace/one', 203),
      observe('ses_two', '/workspace/two', 204),
    ];
    await vi.waitFor(() => expect(statusUrls).toHaveLength(2));
    releaseStatusRequests.splice(0).forEach((release) => release());
    await Promise.all(differentDirectories);
    expect(new Set(statusUrls.map((url) => new URL(url).search))).toEqual(new Set([
      '?directory=%2Fworkspace%2Fone',
      '?directory=%2Fworkspace%2Ftwo',
    ]));

    const firstPort = observe('ses_port_a', '/workspace/port', 205);
    await vi.waitFor(() => expect(statusUrls).toHaveLength(3));
    activePort = 4097;
    const secondPort = observe('ses_port_b', '/workspace/port', 206);
    await vi.waitFor(() => expect(statusUrls).toHaveLength(4));
    releaseStatusRequests.splice(0).forEach((release) => release());
    await Promise.all([firstPort, secondPort]);
    expect(statusUrls.slice(2).map((url) => new URL(url).port)).toEqual(['4096', '4097']);
  });

  it('uses the scheduler abort signal for a normal-provider abort request', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    });
    const executor = createVsCodeManagedOpenCodeExecutor({
      manager: {
        getApiUrl: () => 'http://127.0.0.1:4096',
        getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      },
      fetchImpl,
    });
    const controller = new AbortController();

    await expect(executor.abort({
      ...queuedTask(3),
      childSessionId: 'ses_abort_signal',
    }, { signal: controller.signal })).resolves.toEqual({ aborted: true });

    expect(requests).toHaveLength(1);
    expect(requests[0].init?.signal).toBe(controller.signal);
  });

  it('defers same-child reconciliation while the managed API URL is unavailable', async () => {
    const executor = createVsCodeManagedOpenCodeExecutor({
      manager: {
        getApiUrl: () => null,
        getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      },
      fetchImpl: vi.fn(),
    });

    await expect(executor.reconcile({
      ...queuedTask(4),
      childSessionId: 'ses_existing',
      status: 'running',
      leaseToken: 'dvr_lease_existing',
      startedAt: 1_100,
    })).resolves.toEqual({
      state: 'transient',
      failureReason: 'OpenCode API URL is unavailable',
    });
  });

  it('discards a stale Cursor child through both authoritative owners before prompting', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const cursorSdkRuntime = {
      handlePromptAsync: vi.fn(async () => ({ handled: true, status: 204 })),
      getSessionStatus: vi.fn(() => ({})),
      getSessionMessages: vi.fn(async () => []),
      abortSession: vi.fn(async () => true),
      deleteSessionState: vi.fn(async () => true),
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const pathname = new URL(url).pathname;
      if (pathname === '/session' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'ses_stale_cursor' }), { status: 200 });
      }
      if (pathname === '/session/ses_stale_cursor' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${init?.method} ${pathname}`);
    });
    const executor = createVsCodeManagedOpenCodeExecutor({
      manager: {
        getApiUrl: () => 'http://127.0.0.1:4096',
        getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      },
      cursorSdkRuntime,
      fetchImpl,
    });

    await expect(executor.start({
      ...queuedTask(3),
      providerId: 'cursor-acp',
      modelId: 'composer-2',
      agent: 'builder',
      label: 'Stale Cursor child',
    }, {
      async setChildSessionId() { return false; },
      async markAccepted() { throw new Error('must not accept'); },
      async recordProgress() { return true; },
    })).rejects.toThrow('lost launch ownership before provider prompt');

    expect(cursorSdkRuntime.handlePromptAsync).not.toHaveBeenCalled();
    expect(cursorSdkRuntime.abortSession).toHaveBeenCalledWith('ses_stale_cursor');
    expect(cursorSdkRuntime.deleteSessionState).toHaveBeenCalledWith('ses_stale_cursor');
    expect(requests.map(({ url, init }) => [new URL(url).pathname, init?.method])).toEqual([
      ['/session', 'POST'],
      ['/session/ses_stale_cursor', 'DELETE'],
    ]);
  });
});
