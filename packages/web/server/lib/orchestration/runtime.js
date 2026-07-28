import {
  createManagedTaskScheduler,
  toManagedTaskEvent,
} from '@openchamber/orchestration-runtime';

import { createAtomicManagedOrchestrationLedger } from './atomic-ledger.js';
import { createWebManagedOpenCodeExecutor } from './open-code-executor.js';
import { createManagedOrchestrationPrivateHost } from './private-host.js';

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const ORACLE_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const COUNCIL_TASK_TIMEOUT_MS = 3 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 25_000;

const resolveMinimumTaskTimeoutMs = (agent) => (
  typeof agent === 'string' && agent.trim().toLowerCase() === 'oracle'
    ? ORACLE_TASK_TIMEOUT_MS
    : DEFAULT_TASK_TIMEOUT_MS
);

const resolveSubmitTimeoutAt = (params, now) => {
  const submittedAt = now();
  if (params.deadlineClass === 'council') return submittedAt + COUNCIL_TASK_TIMEOUT_MS;
  const minimumTimeoutAt = submittedAt + resolveMinimumTaskTimeoutMs(params.agent);
  return Number.isFinite(params.timeoutAt)
    ? Math.max(params.timeoutAt, minimumTimeoutAt)
    : minimumTimeoutAt;
};

const resolveWaitTimeoutMs = (params) => {
  if (params.waitTimeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(params.waitTimeoutMs) || params.waitTimeoutMs < 1) {
    throw new TypeError('waitTimeoutMs must be a positive safe integer');
  }
  return Math.min(params.waitTimeoutMs, MAX_WAIT_TIMEOUT_MS);
};

const ERROR_STATUS_BY_CODE = Object.freeze({
  child_session_conflict: 409,
  duplicate_idempotency_key: 409,
  handoff_conflict: 409,
  handoff_in_progress: 409,
  invalid_handoff_scope: 400,
  invalid_result_action: 400,
  ledger_capacity_exceeded: 507,
  manual_model_recovery_required: 409,
  managed_retry_limit_reached: 409,
  managed_runtime_unavailable: 503,
  missing_recovery_model: 400,
  missing_idempotency_key: 400,
  mode_lease_active: 409,
  mode_lease_conflict: 409,
  parent_not_found: 404,
  parent_scope_mismatch: 403,
  result_already_acknowledged: 409,
  result_already_acknowledging: 409,
  result_not_found: 404,
  result_not_provider_usage_limited: 409,
  result_not_resumable: 409,
  rpc_method_not_found: 404,
  scheduler_shut_down: 503,
  task_not_found: 404,
  task_scope_mismatch: 403,
});

const createRuntimeError = (code, message, statusCode = ERROR_STATUS_BY_CODE[code] ?? 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const normalizeRuntimeError = (error) => {
  if (!error || typeof error !== 'object') return error;
  if (typeof error.code !== 'string' || !error.code) {
    const invalidInput = error instanceof TypeError || error instanceof RangeError;
    error.code = invalidInput ? 'invalid_request' : 'managed_orchestration_internal_error';
    error.statusCode = invalidInput ? 400 : 500;
    return error;
  }
  if (!Number.isSafeInteger(error.statusCode)) {
    error.statusCode = ERROR_STATUS_BY_CODE[error.code] ?? 400;
  }
  return error;
};

const projectTask = (task, envelope = null) => (
  toManagedTaskEvent(task, envelope).properties.task
);

const normalizeHandoffParams = (params) => {
  const rootSessionId = typeof params?.rootSessionId === 'string'
    ? params.rootSessionId.trim()
    : '';
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
  const idempotencyKey = typeof params.idempotencyKey === 'string'
    ? params.idempotencyKey.trim()
    : '';
  if (params.confirm && !idempotencyKey) {
    throw createRuntimeError(
      'missing_idempotency_key',
      'handoff idempotencyKey is required when confirm is true',
      400,
    );
  }
  return {
    rootSessionId,
    fromMode: 'orchestrator',
    toMode: 'builder',
    confirm: params.confirm,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
};

export const createWebManagedOrchestrationRuntime = (options = {}) => {
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const isManagedOpenCode = options.isManagedOpenCode ?? (() => true);
  const publishEvent = options.publishEvent ?? (() => undefined);
  const persistence = options.persistence ?? createAtomicManagedOrchestrationLedger({
    dataDirectory: options.dataDirectory,
    logger,
  });
  const executor = options.executor ?? createWebManagedOpenCodeExecutor({
    buildOpenCodeUrl: options.buildOpenCodeUrl,
    getOpenCodeAuthHeaders: options.getOpenCodeAuthHeaders,
    cursorSdkRuntime: options.cursorSdkRuntime,
    fetchImpl: options.fetchImpl,
  });
  const scheduler = options.scheduler ?? createManagedTaskScheduler({
    executor,
    persistence,
    now,
    publishEvent,
    logger,
    ...(options.createTaskId ? { createTaskId: options.createTaskId } : {}),
    ...(options.createLeaseToken ? { createLeaseToken: options.createLeaseToken } : {}),
  });

  let privateHost;
  let bridgeEnvironment = null;
  let initializePromise = null;
  let initialized = false;
  let recoveryWarningPublished = false;
  let shutdownPromise = null;

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
          logger.warn?.('[ManagedOrchestration] Failed to publish recovery warning', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return undefined;
    }).finally(() => {
      initializePromise = null;
    });
    return initializePromise;
  };

  const ensureInitialized = async () => {
    assertAvailable();
    if (!initialized) await initialize();
  };

  const assertTaskScope = (task, params) => {
    const rootSessionId = typeof params?.rootSessionId === 'string'
      ? params.rootSessionId.trim()
      : '';
    if (!rootSessionId || task.rootSessionId !== rootSessionId) {
      throw createRuntimeError(
        'task_scope_mismatch',
        `managed task ${task.taskId} does not belong to the requesting root session`,
        403,
      );
    }
    if (
      typeof params?.directory === 'string'
      && params.directory.trim()
      && task.directory !== params.directory.trim()
    ) {
      throw createRuntimeError(
        'task_scope_mismatch',
        `managed task ${task.taskId} does not belong to the requesting directory`,
        403,
      );
    }
  };

  const getScopedTask = (params) => {
    const taskId = typeof params?.taskId === 'string' ? params.taskId.trim() : '';
    const task = taskId ? scheduler.getTask(taskId) : null;
    if (!task) {
      throw createRuntimeError('task_not_found', `managed task ${taskId || '(missing)'} was not found`, 404);
    }
    assertTaskScope(task, params);
    return task;
  };

  const projectTaskResult = (task) => {
    const envelope = scheduler.getResultEnvelope(task.taskId);
    return {
      task: projectTask(task, envelope),
      ...(envelope ? { resultEnvelope: envelope } : {}),
    };
  };

  const projectHandoffResult = (scope, result) => ({
    rootSessionId: scope.rootSessionId,
    fromMode: scope.fromMode,
    toMode: scope.toMode,
    state: result.state,
    tasks: result.taskIds
      .map((taskId) => scheduler.getTask(taskId))
      .filter(Boolean)
      .map(projectTaskResult),
    failures: result.failures,
  });

  const handleRpcInternal = async ({ method, params = {} }, context = {}) => {
    await ensureInitialized();
    switch (method) {
      case 'submit': {
        const timeoutAt = resolveSubmitTimeoutAt(params, now);
        const task = await scheduler.submit({
          idempotencyKey: params.idempotencyKey,
          rootSessionId: params.rootSessionId,
          dispatchGroupId: params.dispatchGroupId ?? null,
          parentTaskId: params.parentTaskId ?? null,
          childSessionId: params.childSessionId ?? null,
          directory: params.directory,
          mode: params.mode,
          providerId: params.providerId,
          modelId: params.modelId,
          agent: params.agent,
          variant: params.variant ?? null,
          label: params.label,
          prompt: params.prompt,
          timeoutAt,
        });
        return projectTaskResult(task);
      }
      case 'wait': {
        const task = getScopedTask(params);
        const waitTimeoutMs = resolveWaitTimeoutMs(params);
        const settled = await scheduler.waitForTask(task.taskId, {
          signal: context.signal,
          ...(waitTimeoutMs === undefined ? {} : { timeoutMs: waitTimeoutMs }),
        });
        return projectTaskResult(settled);
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
          resultEnvelope,
          followUpTask: followUpTask ? projectTaskResult(followUpTask) : null,
        };
      }
      case 'barrier': {
        const rootSessionId = typeof params.rootSessionId === 'string'
          ? params.rootSessionId.trim()
          : '';
        if (!rootSessionId) {
          throw createRuntimeError('task_scope_mismatch', 'rootSessionId is required', 403);
        }
        return await scheduler.waitForDispatchBarrier(rootSessionId, { signal: context.signal });
      }
      case 'barrier_status': {
        const rootSessionId = typeof params.rootSessionId === 'string'
          ? params.rootSessionId.trim()
          : '';
        if (!rootSessionId) {
          throw createRuntimeError('task_scope_mismatch', 'rootSessionId is required', 403);
        }
        return await scheduler.inspectDispatchBarrier(rootSessionId);
      }
      case 'list_provider_recovery_continuations': {
        const sessionId = typeof params.sessionId === 'string'
          ? params.sessionId.trim()
          : '';
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
            idempotencyKey: scope.idempotencyKey,
          })
          : await scheduler.inspectAgentHandoff({
            rootSessionId: scope.rootSessionId,
            fromMode: scope.fromMode,
            toMode: scope.toMode,
          });
        return projectHandoffResult(scope, result);
      }
      case 'status': {
        return projectTaskResult(getScopedTask(params));
      }
      case 'snapshot': {
        const rootSessionId = typeof params.rootSessionId === 'string'
          ? params.rootSessionId.trim()
          : '';
        if (!rootSessionId) {
          throw createRuntimeError('task_scope_mismatch', 'rootSessionId is required', 403);
        }
        return await getSnapshot({ rootSessionId });
      }
      case 'cancel': {
        const task = getScopedTask(params);
        const cancelled = await scheduler.cancelTask(task.taskId, {
          cascade: params.cascade === true,
          ...(typeof params.reason === 'string' && params.reason.trim()
            ? { reason: params.reason.trim() }
            : {}),
        });
        return Array.isArray(cancelled)
          ? { tasks: cancelled.map((entry) => projectTaskResult(entry)) }
          : projectTaskResult(cancelled);
      }
      case 'acknowledge': {
        const task = getScopedTask(params);
        const timeoutAt = resolveSubmitTimeoutAt({
          timeoutAt: params.timeoutAt,
          agent: params.agent || task.agent,
        }, now);
        const result = await scheduler.acknowledgeResult(task.taskId, {
          action: params.action,
          idempotencyKey: params.idempotencyKey,
          ...(params.providerId ? { providerId: params.providerId } : {}),
          ...(params.modelId ? { modelId: params.modelId } : {}),
          ...(params.agent ? { agent: params.agent } : {}),
          ...(params.variant !== undefined ? { variant: params.variant } : {}),
          ...(params.label ? { label: params.label } : {}),
          ...(params.prompt ? { prompt: params.prompt } : {}),
          timeoutAt,
        });
        return {
          resultEnvelope: result.envelope,
          followUpTask: result.followUpTask
            ? projectTaskResult(result.followUpTask)
            : null,
        };
      }
      default:
        throw createRuntimeError('rpc_method_not_found', `Unknown managed orchestration method: ${method}`, 404);
    }
  };

  const handleRpc = async (request, context) => {
    try {
      return await handleRpcInternal(request, context);
    } catch (error) {
      throw normalizeRuntimeError(error);
    }
  };

  privateHost = options.privateHost ?? createManagedOrchestrationPrivateHost({ handleRpc });

  const prepareBridge = async () => {
    assertAvailable();
    if (bridgeEnvironment) return bridgeEnvironment;
    bridgeEnvironment = await privateHost.start();
    return bridgeEnvironment;
  };

  async function getSnapshot({ rootSessionId } = {}) {
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
      tasks: tasks.map((task) => projectTask(task, scheduler.getResultEnvelope(task.taskId))),
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
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'managed orchestration shutdown failed');
      }
    })();
    return shutdownPromise;
  };

  return {
    prepareBridge,
    initialize,
    handleRpc,
    getSnapshot,
    shutdown,
    flush: () => scheduler.flush(),
    getDiagnostics() {
      return {
        available: isManagedOpenCode(),
        bridge: privateHost.getDiagnostics?.() ?? null,
        ledger: {
          recoveryWarning: persistence.getDiagnostics?.().recoveryWarning ?? null,
        },
        scheduler: scheduler.getDiagnostics(),
      };
    },
  };
};
