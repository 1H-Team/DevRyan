import {
  createManagedTaskScheduler,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE,
  projectManagedResultEnvelope,
  projectManagedTaskResult as projectManagedTaskResultForMode,
  readManagedResultReference,
  resolveManagedResultMode,
  supportsManagedReadOnlyAgent,
  supportsManagedReadOnlyProvider,
  toManagedTaskEvent,
  type ManagedTaskExecutor,
  type ManagedTaskMode,
  type ManagedTaskResultAction,
  type ManagedTaskScheduler,
} from '@openchamber/orchestration-runtime';

import {
  createVsCodeManagedOpenCodeExecutor,
  type VsCodeCursorSdkRuntimeAdapter,
  type VsCodeManagedOpenCodeManagerAdapter,
} from './managedOpenCodeExecutor';
import {
  createVsCodeManagedOrchestrationHost,
  type ManagedOrchestrationBridgeEnvironment,
  type ManagedOrchestrationRpcContext,
  type ManagedOrchestrationRpcRequest,
  type VsCodeManagedOrchestrationPrivateHost,
} from './managedOrchestrationHost';
import {
  createVsCodeManagedOrchestrationLedger,
  type VsCodeManagedOrchestrationPersistence,
} from './managedOrchestrationPersistence';

export { createVsCodeManagedOpenCodeExecutor } from './managedOpenCodeExecutor';
export { createVsCodeManagedOrchestrationHost } from './managedOrchestrationHost';
export { createVsCodeManagedOrchestrationLedger } from './managedOrchestrationPersistence';

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const DESIGNER_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const FIXER_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const ORACLE_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const COUNCIL_TASK_TIMEOUT_MS = 3 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 25_000;

const resolveMinimumTaskTimeoutMs = (agent: unknown) => {
  const normalizedAgent = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  if (normalizedAgent === 'designer') return DESIGNER_TASK_TIMEOUT_MS;
  if (normalizedAgent === 'fixer') return FIXER_TASK_TIMEOUT_MS;
  if (normalizedAgent === 'oracle') return ORACLE_TASK_TIMEOUT_MS;
  return DEFAULT_TASK_TIMEOUT_MS;
};

const resolveSubmitTimeoutAt = (params: Record<string, unknown>, now: () => number) => {
  const submittedAt = now();
  if (params.deadlineClass === 'council') return submittedAt + COUNCIL_TASK_TIMEOUT_MS;
  const minimumTimeoutAt = submittedAt + resolveMinimumTaskTimeoutMs(params.agent);
  return typeof params.timeoutAt === 'number' && Number.isFinite(params.timeoutAt)
    ? Math.max(params.timeoutAt, minimumTimeoutAt)
    : minimumTimeoutAt;
};

const resolveRequestedTimeoutAt = (params: Record<string, unknown>, now: () => number) => {
  if (params.timeoutSeconds === undefined) return params.timeoutAt;
  if (typeof params.timeoutSeconds !== 'number'
    || !Number.isSafeInteger(params.timeoutSeconds)
    || params.timeoutSeconds < 1) {
    throw new TypeError('timeoutSeconds must be a positive safe integer');
  }
  return now() + params.timeoutSeconds * 1_000;
};

const resolveWaitTimeoutMs = (params: Record<string, unknown>) => {
  const value = params.waitTimeoutMs;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('waitTimeoutMs must be a positive safe integer');
  }
  return Math.min(value, MAX_WAIT_TIMEOUT_MS);
};

const resolveReadOnly = (params: Record<string, unknown>) => {
  const value = params.readOnly;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError('readOnly must be a boolean');
  return value;
};

type Logger = Pick<Console, 'warn'>;
type RuntimeError = Error & { code?: string; statusCode?: number };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const ERROR_STATUS_BY_CODE: Record<string, number> = {
  child_session_conflict: 409,
  duplicate_idempotency_key: 409,
  handoff_conflict: 409,
  handoff_in_progress: 409,
  invalid_handoff_scope: 400,
  invalid_result_action: 400,
  ledger_capacity_exceeded: 507,
  manual_model_recovery_required: 409,
  managed_retry_limit_reached: 409,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED: 409,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED: 409,
  CONTEXT_MODE_RECOVERY_PENDING: 503,
  provider_prompt_rejection_requires_fresh_retry: 409,
  provider_prompt_rejection_requires_reframed_prompt: 409,
  managed_runtime_unavailable: 503,
  missing_recovery_model: 400,
  missing_idempotency_key: 400,
  mode_lease_active: 409,
  mode_lease_conflict: 409,
  parent_not_found: 404,
  parent_scope_mismatch: 403,
  result_already_acknowledged: 409,
  result_already_acknowledging: 409,
  invalid_result_cursor: 400,
  result_reference_mismatch: 409,
  result_not_found: 404,
  result_not_provider_usage_limited: 409,
  result_not_resumable: 409,
  rpc_method_not_found: 404,
  scheduler_shut_down: 503,
  task_not_found: 404,
  task_scope_mismatch: 403,
};

const createRuntimeError = (code: string, message: string, statusCode = ERROR_STATUS_BY_CODE[code] ?? 400) => {
  const error: RuntimeError = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const normalizeRuntimeError = (error: unknown) => {
  if (!isRecord(error)) return error;
  const runtimeError = error as unknown as RuntimeError;
  if (typeof runtimeError.code !== 'string' || !runtimeError.code) {
    const invalidInput = error instanceof TypeError || error instanceof RangeError;
    runtimeError.code = invalidInput ? 'invalid_request' : 'managed_orchestration_internal_error';
    runtimeError.statusCode = invalidInput ? 400 : 500;
  } else if (!Number.isSafeInteger(runtimeError.statusCode)) {
    runtimeError.statusCode = ERROR_STATUS_BY_CODE[runtimeError.code] ?? 400;
  }
  return runtimeError;
};

const requireString = (params: Record<string, unknown>, field: string) => {
  const value = typeof params[field] === 'string' ? params[field].trim() : '';
  if (!value) throw new TypeError(`${field} is required`);
  return value;
};

const requireContentString = (params: Record<string, unknown>, field: string) => {
  const value = params[field];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value;
};

const optionalString = (params: Record<string, unknown>, field: string) => {
  const value = typeof params[field] === 'string' ? params[field].trim() : '';
  return value || null;
};

const optionalContentString = (params: Record<string, unknown>, field: string) => {
  const value = params[field];
  return typeof value === 'string' && value.trim() ? value : null;
};

const requireMode = (value: unknown): ManagedTaskMode => {
  if (value !== 'builder' && value !== 'orchestrator') {
    throw new TypeError('mode must be builder or orchestrator');
  }
  return value;
};

const requireResultAction = (value: unknown): ManagedTaskResultAction => {
  if (value !== 'continue' && value !== 'resume' && value !== 'retry' && value !== 'recover_in_place' && value !== 'retry_in_place' && value !== 'abandon') {
    throw new TypeError('action must be continue, resume, retry, recover_in_place, retry_in_place, or abandon');
  }
  return value;
};

const normalizeHandoffParams = (params: Record<string, unknown>) => {
  const rootSessionId = optionalString(params, 'rootSessionId');
  if (!rootSessionId) {
    throw createRuntimeError('invalid_handoff_scope', 'rootSessionId is required', 400);
  }
  if (params.fromMode !== 'orchestrator' || params.toMode !== 'builder') {
    throw createRuntimeError(
      'invalid_handoff_scope',
      'only orchestrator-to-builder handoff is supported',
      400,
    );
  }
  if (typeof params.confirm !== 'boolean') {
    throw createRuntimeError('invalid_handoff_scope', 'confirm must be a boolean', 400);
  }
  const idempotencyKey = optionalString(params, 'idempotencyKey');
  if (params.confirm && !idempotencyKey) {
    throw createRuntimeError(
      'missing_idempotency_key',
      'handoff idempotencyKey is required when confirm is true',
      400,
    );
  }
  return {
    rootSessionId,
    fromMode: 'orchestrator' as const,
    toMode: 'builder' as const,
    confirm: params.confirm,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
};

export type VsCodeManagedOrchestrationRuntime = {
  prepareBridge(): Promise<ManagedOrchestrationBridgeEnvironment>;
  initialize(): Promise<void>;
  handleRpc(request: ManagedOrchestrationRpcRequest, context?: ManagedOrchestrationRpcContext): Promise<unknown>;
  getSnapshot(options?: { rootSessionId?: string }): Promise<{
    available: boolean;
    bridgeReady: boolean;
    recoveryWarning: string | null;
    tasks: unknown[];
    resultEnvelopes: unknown[];
  }>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  getDiagnostics(): unknown;
};

export const createVsCodeManagedOrchestrationRuntime = (options: {
  storageDirectory: string;
  manager?: VsCodeManagedOpenCodeManagerAdapter;
  cursorSdkRuntime?: VsCodeCursorSdkRuntimeAdapter | null;
  persistence?: VsCodeManagedOrchestrationPersistence;
  executor?: ManagedTaskExecutor;
  scheduler?: ManagedTaskScheduler;
  privateHost?: VsCodeManagedOrchestrationPrivateHost;
  publishEvent?: (event: unknown) => void | Promise<void>;
  isManagedOpenCode?: () => boolean;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  createTaskId?: () => string;
  createLeaseToken?: () => string;
  getWorkAdmissionBlock?: () => { code: string; error: string } | null;
}): VsCodeManagedOrchestrationRuntime => {
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const isManagedOpenCode = options.isManagedOpenCode ?? (() => (
    options.manager?.getDebugInfo?.().mode !== 'external'
  ));
  const publishEvent = options.publishEvent ?? (() => undefined);
  const getWorkAdmissionBlock = options.getWorkAdmissionBlock ?? (() => null);
  const persistence = options.persistence ?? createVsCodeManagedOrchestrationLedger({
    storageDirectory: options.storageDirectory,
    logger,
  });
  const executor = options.executor ?? (() => {
    if (!options.manager) throw new TypeError('manager is required when executor is not provided');
    return createVsCodeManagedOpenCodeExecutor({
      manager: options.manager,
      cursorSdkRuntime: options.cursorSdkRuntime,
      fetchImpl: options.fetchImpl,
    });
  })();
  const scheduler = options.scheduler ?? createManagedTaskScheduler({
    executor,
    persistence,
    now,
    publishEvent,
    logger,
    ...(options.createTaskId ? { createTaskId: options.createTaskId } : {}),
    ...(options.createLeaseToken ? { createLeaseToken: options.createLeaseToken } : {}),
  });

  let bridgeEnvironment: ManagedOrchestrationBridgeEnvironment | null = null;
  let initialized = false;
  let initializePromise: Promise<void> | null = null;
  let recoveryWarningPublished = false;
  let shutdownPromise: Promise<void> | null = null;

  const assertWorkAdmission = () => {
    const block = getWorkAdmissionBlock();
    if (!block) return;
    throw createRuntimeError(
      block.code || 'CONTEXT_MODE_RECOVERY_PENDING',
      block.error || 'Context-mode recovery is pending',
      503,
    );
  };

  const assertAvailable = () => {
    if (!isManagedOpenCode()) {
      throw createRuntimeError(
        'managed_runtime_unavailable',
        'DevRyan-managed orchestration is unavailable for configured external OpenCode runtimes',
        503,
      );
    }
  };

  const initialize = () => {
    assertAvailable();
    if (initialized) return Promise.resolve();
    if (initializePromise) return initializePromise;
    initializePromise = scheduler.initialize().then(async () => {
      initialized = true;
      const recoveryWarning = persistence.getDiagnostics?.().recoveryWarning ?? null;
      if (recoveryWarning && !recoveryWarningPublished) {
        recoveryWarningPublished = true;
        try {
          await publishEvent({
            type: 'openchamber:managed-orchestration-warning',
            properties: { message: recoveryWarning },
          });
        } catch (error) {
          logger.warn('[ManagedOrchestration] Failed to publish VS Code recovery warning', {
            reason: errorMessage(error),
          });
        }
      }
    }).finally(() => { initializePromise = null; });
    return initializePromise;
  };

  const ensureInitialized = async () => {
    assertAvailable();
    if (!initialized) await initialize();
  };

  const projectTask = (task: ReturnType<ManagedTaskScheduler['getTask']>) => {
    if (!task) throw createRuntimeError('task_not_found', 'managed task was not found', 404);
    return toManagedTaskEvent(task, scheduler.getResultEnvelope(task.taskId)).properties.task;
  };

  const assertTaskScope = (
    task: NonNullable<ReturnType<ManagedTaskScheduler['getTask']>>,
    params: Record<string, unknown>,
  ) => {
    const rootSessionId = requireString(params, 'rootSessionId');
    if (task.rootSessionId !== rootSessionId) {
      throw createRuntimeError(
        'task_scope_mismatch',
        `managed task ${task.taskId} does not belong to the requesting root session`,
        403,
      );
    }
    const directory = optionalString(params, 'directory');
    if (directory && task.directory !== directory) {
      throw createRuntimeError(
        'task_scope_mismatch',
        `managed task ${task.taskId} does not belong to the requesting directory`,
        403,
      );
    }
  };

  const getScopedTask = (params: Record<string, unknown>) => {
    const taskId = requireString(params, 'taskId');
    const task = scheduler.getTask(taskId);
    if (!task) throw createRuntimeError('task_not_found', `managed task ${taskId} was not found`, 404);
    assertTaskScope(task, params);
    return task;
  };

  const getResultReadScopedTask = (params: Record<string, unknown>) => {
    const taskId = requireString(params, 'taskId');
    const task = scheduler.getTask(taskId);
    if (!task) throw createRuntimeError('task_not_found', `managed task ${taskId} was not found`, 404);
    const rootSessionId = optionalString(params, 'rootSessionId');
    const directory = optionalString(params, 'directory');
    if (!rootSessionId || task.rootSessionId !== rootSessionId) {
      throw createRuntimeError(
        'task_scope_mismatch',
        `managed task ${task.taskId} does not belong to the requesting root session`,
        403,
      );
    }
    if (!directory || task.directory !== directory) {
      throw createRuntimeError(
        'task_scope_mismatch',
        `managed task ${task.taskId} does not belong to the requesting directory`,
        403,
      );
    }
    return task;
  };

  const projectTaskResult = (
    task: NonNullable<ReturnType<ManagedTaskScheduler['getTask']>>,
    resultMode?: 'eager' | 'reference',
  ) => {
    const envelope = scheduler.getResultEnvelope(task.taskId);
    return projectManagedTaskResultForMode(projectTask(task), envelope, resultMode);
  };

  const projectHandoffResult = (
    scope: ReturnType<typeof normalizeHandoffParams>,
    result: Awaited<ReturnType<ManagedTaskScheduler['inspectAgentHandoff']>>,
    resultMode?: 'eager' | 'reference',
  ) => ({
    rootSessionId: scope.rootSessionId,
    fromMode: scope.fromMode,
    toMode: scope.toMode,
    state: result.state,
    tasks: result.taskIds
      .map((taskId) => scheduler.getTask(taskId))
      .filter((task): task is NonNullable<typeof task> => Boolean(task))
      .map((task) => projectTaskResult(task, resultMode)),
    failures: result.failures,
  });

  const handleRpcInternal = async (
    request: ManagedOrchestrationRpcRequest,
    context: ManagedOrchestrationRpcContext = {},
  ) => {
    await ensureInitialized();
    const params = request.params ?? {};
    const resultMode = resolveManagedResultMode(params.resultMode);
    switch (request.method) {
      case 'submit': {
        assertWorkAdmission();
        const timeoutAt = resolveSubmitTimeoutAt(params, now);
        const readOnly = resolveReadOnly(params);
        const providerId = requireString(params, 'providerId');
        const agent = requireString(params, 'agent');
        if (readOnly && !supportsManagedReadOnlyAgent(agent)) {
          throw createRuntimeError(
            MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
            MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE,
            409,
          );
        }
        if (readOnly && !supportsManagedReadOnlyProvider(providerId)) {
          throw createRuntimeError(
            MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED,
            MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE,
            409,
          );
        }
        const task = await scheduler.submit({
          idempotencyKey: requireString(params, 'idempotencyKey'),
          rootSessionId: requireString(params, 'rootSessionId'),
          dispatchGroupId: optionalString(params, 'dispatchGroupId'),
          dispatchCallId: optionalString(params, 'dispatchCallId'),
          parentTaskId: optionalString(params, 'parentTaskId'),
          childSessionId: optionalString(params, 'childSessionId'),
          directory: requireString(params, 'directory'),
          mode: requireMode(params.mode),
          readOnly,
          providerId,
          modelId: requireString(params, 'modelId'),
          agent,
          variant: optionalString(params, 'variant'),
          label: requireString(params, 'label'),
          prompt: requireContentString(params, 'prompt'),
          timeoutAt,
        });
        return projectTaskResult(task, resultMode);
      }
      case 'wait': {
        const task = getScopedTask(params);
        const waitTimeoutMs = resolveWaitTimeoutMs(params);
        return projectTaskResult(await scheduler.waitForTask(task.taskId, {
          signal: context.signal,
          ...(waitTimeoutMs === undefined ? {} : { timeoutMs: waitTimeoutMs }),
        }), resultMode);
      }
      case 'wait_result_action': {
        const task = getScopedTask(params);
        const resultEnvelope = await scheduler.waitForResultAction(task.taskId, {
          signal: context.signal,
        });
        const followUpTask = resultEnvelope.followUpTaskId
          ? scheduler.getTask(resultEnvelope.followUpTaskId)
          : null;
        return {
          ...projectManagedResultEnvelope(task, resultEnvelope, resultMode),
          followUpTask: followUpTask ? projectTaskResult(followUpTask, resultMode) : null,
        };
      }
      case 'barrier':
        return await scheduler.waitForDispatchBarrier(
          requireString(params, 'rootSessionId'),
          { signal: context.signal },
        );
      case 'barrier_status':
        return await scheduler.inspectDispatchBarrier(requireString(params, 'rootSessionId'));
      case 'list_provider_recovery_continuations': {
        const sessionId = optionalString(params, 'sessionId');
        return {
          continuations: scheduler.listReadyProviderRecoveryContinuations({
            ...(sessionId ? { sessionId } : {}),
          }),
        };
      }
      case 'handoff': {
        const scope = normalizeHandoffParams(params);
        const result = scope.confirm
          ? await scheduler.confirmAgentHandoff({
            rootSessionId: scope.rootSessionId,
            fromMode: scope.fromMode,
            toMode: scope.toMode,
            idempotencyKey: scope.idempotencyKey as string,
          })
          : await scheduler.inspectAgentHandoff({
            rootSessionId: scope.rootSessionId,
            fromMode: scope.fromMode,
            toMode: scope.toMode,
          });
        return projectHandoffResult(scope, result, resultMode);
      }
      case 'status':
        return projectTaskResult(getScopedTask(params), resultMode);
      case 'snapshot':
        return await getSnapshot({ rootSessionId: requireString(params, 'rootSessionId') });
      case 'cancel': {
        const task = getScopedTask(params);
        const reason = optionalString(params, 'reason') ?? undefined;
        const cancelled = params.cascade === true
          ? await scheduler.cancelTask(task.taskId, { cascade: true, ...(reason ? { reason } : {}) })
          : await scheduler.cancelTask(task.taskId, { cascade: false, ...(reason ? { reason } : {}) });
        return Array.isArray(cancelled)
          ? { tasks: cancelled.map((entry) => projectTaskResult(entry, resultMode)) }
          : projectTaskResult(cancelled, resultMode);
      }
      case 'read_result': {
        const task = getResultReadScopedTask(params);
        const resultEnvelope = scheduler.getResultEnvelope(task.taskId);
        if (!resultEnvelope) {
          throw createRuntimeError(
            'result_not_found',
            `managed result for task ${task.taskId} was not found`,
            404,
          );
        }
        return {
          resultReference: readManagedResultReference({
            task,
            resultEnvelope,
            resultCursor: typeof params.resultCursor === 'string' ? params.resultCursor : '',
          }),
        };
      }
      case 'acknowledge': {
        const task = getScopedTask(params);
        if (['retry', 'resume', 'retry_in_place', 'recover_in_place'].includes(String(params.action))) {
          assertWorkAdmission();
        }
        const providerId = optionalString(params, 'providerId');
        const modelId = optionalString(params, 'modelId');
        const agent = optionalString(params, 'agent');
        const label = optionalString(params, 'label');
        const prompt = optionalContentString(params, 'prompt');
        const timeoutAt = resolveSubmitTimeoutAt({
          timeoutAt: resolveRequestedTimeoutAt(params, now),
          agent: agent ?? task.agent,
        }, now);
        const result = await scheduler.acknowledgeResult(task.taskId, {
          action: requireResultAction(params.action),
          idempotencyKey: requireString(params, 'idempotencyKey'),
          ...(providerId ? { providerId } : {}),
          ...(modelId ? { modelId } : {}),
          ...(agent ? { agent } : {}),
          ...(params.variant !== undefined ? { variant: optionalString(params, 'variant') } : {}),
          ...(label ? { label } : {}),
          ...(prompt ? { prompt } : {}),
          timeoutAt,
        });
        return {
          ...projectManagedResultEnvelope(task, result.envelope, resultMode),
          followUpTask: result.followUpTask
            ? projectTaskResult(result.followUpTask, resultMode)
            : null,
        };
      }
      default:
        throw createRuntimeError('rpc_method_not_found', `Unknown managed orchestration method: ${request.method}`, 404);
    }
  };

  const handleRpc = async (
    request: ManagedOrchestrationRpcRequest,
    context?: ManagedOrchestrationRpcContext,
  ) => {
    try {
      return await handleRpcInternal(request, context);
    } catch (error) {
      throw normalizeRuntimeError(error);
    }
  };

  const privateHost = options.privateHost ?? createVsCodeManagedOrchestrationHost({ handleRpc });

  const prepareBridge = async () => {
    assertAvailable();
    if (bridgeEnvironment) return bridgeEnvironment;
    bridgeEnvironment = await privateHost.start();
    return bridgeEnvironment;
  };

  async function getSnapshot({ rootSessionId }: { rootSessionId?: string } = {}) {
    if (!isManagedOpenCode()) {
      return {
        available: false,
        bridgeReady: false,
        recoveryWarning: null,
        tasks: [],
        resultEnvelopes: [],
      };
    }
    await ensureInitialized();
    const tasks = scheduler.listTasks({ rootSessionId });
    return {
      available: true,
      bridgeReady: Boolean(bridgeEnvironment),
      recoveryWarning: persistence.getDiagnostics?.().recoveryWarning ?? null,
      tasks: tasks.map(projectTask),
      resultEnvelopes: scheduler.listResultEnvelopes({ rootSessionId }),
    };
  }

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const [hostResult, schedulerResult] = await Promise.allSettled([
        privateHost.stop(),
        scheduler.shutdown(),
      ]);
      bridgeEnvironment = null;
      const errors = [hostResult, schedulerResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'managed orchestration shutdown failed');
    })();
    return shutdownPromise;
  };

  return {
    prepareBridge,
    initialize,
    handleRpc,
    getSnapshot,
    flush: () => scheduler.flush(),
    shutdown,
    getDiagnostics: () => ({
      available: isManagedOpenCode(),
      bridge: privateHost.getDiagnostics?.() ?? null,
      ledger: { recoveryWarning: persistence.getDiagnostics?.().recoveryWarning ?? null },
      scheduler: scheduler.getDiagnostics(),
    }),
  };
};
