import {
  createManagedTaskScheduler,
  toManagedTaskEvent,
} from '@openchamber/orchestration-runtime';

import { createAtomicManagedOrchestrationLedger } from './atomic-ledger.js';
import { createWebManagedOpenCodeExecutor } from './open-code-executor.js';
import { createManagedOrchestrationPrivateHost } from './private-host.js';

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;

const ERROR_STATUS_BY_CODE = Object.freeze({
  child_session_conflict: 409,
  duplicate_idempotency_key: 409,
  invalid_result_action: 400,
  ledger_capacity_exceeded: 507,
  managed_runtime_unavailable: 503,
  mode_lease_active: 409,
  mode_lease_conflict: 409,
  parent_not_found: 404,
  parent_scope_mismatch: 403,
  result_already_acknowledged: 409,
  result_already_acknowledging: 409,
  result_not_found: 404,
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
    maxConcurrency: 3,
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

  const handleRpcInternal = async ({ method, params = {} }, context = {}) => {
    await ensureInitialized();
    switch (method) {
      case 'submit': {
        const timeoutAt = Number.isFinite(params.timeoutAt)
          ? params.timeoutAt
          : now() + DEFAULT_TASK_TIMEOUT_MS;
        const task = await scheduler.submit({
          idempotencyKey: params.idempotencyKey,
          rootSessionId: params.rootSessionId,
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
        const settled = await scheduler.waitForTask(task.taskId, { signal: context.signal });
        return projectTaskResult(settled);
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
        const result = await scheduler.acknowledgeResult(task.taskId, {
          action: params.action,
          idempotencyKey: params.idempotencyKey,
          ...(params.providerId ? { providerId: params.providerId } : {}),
          ...(params.modelId ? { modelId: params.modelId } : {}),
          ...(params.agent ? { agent: params.agent } : {}),
          ...(params.variant !== undefined ? { variant: params.variant } : {}),
          ...(params.label ? { label: params.label } : {}),
          ...(params.prompt ? { prompt: params.prompt } : {}),
          ...(Number.isFinite(params.timeoutAt) ? { timeoutAt: params.timeoutAt } : {}),
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
