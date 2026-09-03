import {
  createManagedTerminalErrorRegistry,
  createManagedTaskScheduler,
  isManagedModelAvailableInCatalog,
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
} from '@openchamber/orchestration-runtime';

import { createAtomicManagedOrchestrationLedger } from './atomic-ledger.js';
import {
  createClaudeCompatibilityPreambleResolver,
  resolveManagedTaskTurnBudget,
} from './claude-compatibility.js';
import { createWebManagedOpenCodeExecutor } from './open-code-executor.js';
import { createManagedOrchestrationPrivateHost } from './private-host.js';

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const DESIGNER_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const FIXER_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const ORACLE_TASK_TIMEOUT_MS = 15 * 60 * 1_000;
const COUNCIL_TASK_TIMEOUT_MS = 3 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 25_000;
const AUTO_RESUME_HOST_DEFER_MS = 30_000;
// Acknowledge outcomes that mean the parked result already moved on; the
// scheduler treats them as a settled attempt rather than a host failure.
const AUTO_RESUME_SETTLED_CODES = new Set([
  'auto_resume_stale',
  'result_already_acknowledged',
  'result_already_acknowledging',
]);

const resolveMinimumTaskTimeoutMs = (agent) => {
  const normalizedAgent = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  if (normalizedAgent === 'designer') return DESIGNER_TASK_TIMEOUT_MS;
  if (normalizedAgent === 'fixer') return FIXER_TASK_TIMEOUT_MS;
  if (normalizedAgent === 'oracle') return ORACLE_TASK_TIMEOUT_MS;
  return DEFAULT_TASK_TIMEOUT_MS;
};

const resolveSubmitTimeoutAt = (params, now) => {
  const submittedAt = now();
  if (params.deadlineClass === 'council') return submittedAt + COUNCIL_TASK_TIMEOUT_MS;
  const minimumTimeoutAt = submittedAt + resolveMinimumTaskTimeoutMs(params.agent);
  return Number.isFinite(params.timeoutAt)
    ? Math.max(params.timeoutAt, minimumTimeoutAt)
    : minimumTimeoutAt;
};

const resolveRequestedTimeoutAt = (params, now) => {
  if (params.timeoutSeconds === undefined) return params.timeoutAt;
  if (!Number.isSafeInteger(params.timeoutSeconds) || params.timeoutSeconds < 1) {
    throw new TypeError('timeoutSeconds must be a positive safe integer');
  }
  return now() + params.timeoutSeconds * 1_000;
};

const resolveWaitTimeoutMs = (params) => {
  if (params.waitTimeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(params.waitTimeoutMs) || params.waitTimeoutMs < 1) {
    throw new TypeError('waitTimeoutMs must be a positive safe integer');
  }
  return Math.min(params.waitTimeoutMs, MAX_WAIT_TIMEOUT_MS);
};

const resolveReadOnly = (params) => {
  if (params.readOnly === undefined) return false;
  if (typeof params.readOnly !== 'boolean') {
    throw new TypeError('readOnly must be a boolean');
  }
  return params.readOnly;
};

const ERROR_STATUS_BY_CODE = Object.freeze({
  auto_resume_not_applicable: 409,
  auto_resume_stale: 409,
  child_session_conflict: 409,
  duplicate_idempotency_key: 409,
  handoff_conflict: 409,
  handoff_in_progress: 409,
  invalid_handoff_scope: 400,
  invalid_recovery_continuation_claim: 400,
  invalid_result_action: 400,
  ledger_capacity_exceeded: 507,
  manual_model_recovery_required: 409,
  managed_retry_limit_reached: 409,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED: 409,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED: 409,
  managed_agent_model_unavailable: 409,
  managed_orchestration_owner_mismatch: 403,
  managed_orchestration_owner_unavailable: 503,
  CONTEXT_MODE_RECOVERY_PENDING: 503,
  provider_prompt_rejection_requires_fresh_retry: 409,
  provider_prompt_rejection_requires_reframed_prompt: 409,
  managed_orchestration_owner_conflict: 409,
  managed_orchestration_ownership_lost: 409,
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

const OWNERSHIP_WARNING = 'Managed orchestration is unavailable because another DevRyan runtime owns this data directory. Close the other runtime or configure a separate OPENCHAMBER_DATA_DIR.';

const isOwnershipError = (error) => (
  error?.code === 'managed_orchestration_owner_conflict'
  || error?.code === 'managed_orchestration_ownership_lost'
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
  const getWorkAdmissionBlock = options.getWorkAdmissionBlock ?? (() => null);
  const publishEvent = options.publishEvent ?? (() => undefined);
  const resolveAgentExecution = typeof options.resolveAgentExecution === 'function'
    ? options.resolveAgentExecution
    : null;
  // Auto-resume host hooks. The owner key scopes provider breakers per account
  // (`'local'` for a single-user host); the backup execution is the agent's
  // configured backup model; the reset probe asks Meridian when a limit lifts.
  const resolveAutoResumeOwnerKey = typeof options.resolveOwnerKey === 'function'
    ? options.resolveOwnerKey
    : () => 'local';
  const resolveAutoResumeBackupExecution = typeof options.resolveBackupExecution === 'function'
    ? options.resolveBackupExecution
    : () => null;
  const resolveAutoResumeProviderReset = typeof options.resolveProviderReset === 'function'
    ? options.resolveProviderReset
    : () => null;
  const persistence = options.persistence ?? createAtomicManagedOrchestrationLedger({
    dataDirectory: options.dataDirectory,
    logger,
  });
  const terminalErrors = options.terminalErrors ?? createManagedTerminalErrorRegistry({ now });
  const validateAgentExecution = typeof options.validateAgentExecution === 'function'
    ? options.validateAgentExecution
    : typeof options.buildOpenCodeUrl === 'function'
      ? async ({ directory, providerId, modelId }) => {
          if (providerId === 'cursor-acp') return null;
          try {
            const url = new URL(String(options.buildOpenCodeUrl('/config/providers', '')));
            if (directory) url.searchParams.set('directory', directory);
            const response = await (options.fetchImpl ?? fetch)(url, {
              headers: {
                accept: 'application/json',
                ...options.getOpenCodeAuthHeaders?.(),
              },
              signal: AbortSignal.timeout(5_000),
            });
            if (!response.ok) return null;
            return isManagedModelAvailableInCatalog(await response.json(), providerId, modelId);
          } catch {
            return null;
          }
        }
      : null;
  const executor = options.executor ?? createWebManagedOpenCodeExecutor({
    buildOpenCodeUrl: options.buildOpenCodeUrl,
    getOpenCodeAuthHeaders: options.getOpenCodeAuthHeaders,
    cursorSdkRuntime: options.cursorSdkRuntime,
    fetchImpl: options.fetchImpl,
    readTerminalError: (input) => terminalErrors.read(input),
    // Claude compatibility mode drops opencode's system prompt for Anthropic-routed
    // children, so their agent rules travel inside the first task prompt instead.
    resolveTaskPromptPreamble: options.resolveTaskPromptPreamble
      ?? createClaudeCompatibilityPreambleResolver({ now }),
    // Designer/fixer tool loops get an assistant-turn backstop (wrap-up prompt,
    // then abort) so a runaway child cannot burn the whole task timeout.
    resolveTaskTurnBudget: options.resolveTaskTurnBudget ?? resolveManagedTaskTurnBudget,
  });
  // One automatic resume attempt for a result parked on a definite provider
  // usage limit. It re-enters the acknowledge RPC exactly as a user's Try Again
  // would, plus the internal generation guard the scheduler uses to reject a
  // stale attempt; the host defers (never fails) while work admission is blocked.
  const attemptAutoResume = async (params) => {
    const block = getWorkAdmissionBlock();
    if (block) {
      return {
        outcome: 'deferred',
        retryAfterMs: AUTO_RESUME_HOST_DEFER_MS,
        reason: block.code || 'CONTEXT_MODE_RECOVERY_PENDING',
      };
    }
    try {
      const result = await handleRpcInternal({ method: 'acknowledge', params }, { autoResume: true });
      return {
        outcome: 'started',
        followUpTaskId: typeof result?.followUpTask?.taskId === 'string' ? result.followUpTask.taskId : null,
      };
    } catch (rawError) {
      const error = normalizeRuntimeError(rawError);
      const code = typeof error?.code === 'string' && error.code ? error.code : 'attempt_failed';
      if (AUTO_RESUME_SETTLED_CODES.has(code)) return { outcome: 'started', followUpTaskId: null };
      if (error?.statusCode === 503) {
        return { outcome: 'deferred', retryAfterMs: AUTO_RESUME_HOST_DEFER_MS, reason: code };
      }
      return {
        outcome: 'rejected',
        code,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const scheduler = options.scheduler ?? createManagedTaskScheduler({
    executor,
    persistence,
    now,
    publishEvent,
    logger,
    ...(options.createTaskId ? { createTaskId: options.createTaskId } : {}),
    ...(options.createLeaseToken ? { createLeaseToken: options.createLeaseToken } : {}),
    // Host launch admission (sub-agent cap + memory pressure). Absent → the
    // scheduler admits every queued task immediately, as before.
    ...(typeof options.admitLaunch === 'function' ? { admitLaunch: options.admitLaunch } : {}),
    autoResume: {
      resolveOwnerKey: resolveAutoResumeOwnerKey,
      resolveBackupExecution: resolveAutoResumeBackupExecution,
      resolveProviderReset: resolveAutoResumeProviderReset,
      attempt: attemptAutoResume,
    },
  });

  let privateHost;
  let bridgeEnvironment = null;
  let bridgePromise = null;
  let initializePromise = null;
  let initialized = false;
  let ownershipPromise = null;
  let ownershipAcquired = false;
  let recoveryWarningPublished = false;
  let shutdownPromise = null;

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

  const ensureOwnership = () => {
    if (ownershipAcquired) {
      return Promise.resolve().then(() => persistence.verifyOwnership?.());
    }
    if (ownershipPromise) return ownershipPromise;
    ownershipPromise = (async () => {
      await persistence.acquireOwnership?.();
      ownershipAcquired = true;
    })().finally(() => {
      ownershipPromise = null;
    });
    return ownershipPromise;
  };

  const initialize = () => {
    assertAvailable();
    if (initialized) return ensureOwnership();
    if (initializePromise) return initializePromise;
    initializePromise = ensureOwnership().then(() => scheduler.initialize()).then(async () => {
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
    await ensureOwnership();
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

  const getResultReadScopedTask = (params) => {
    const task = getScopedTask(params);
    const directory = typeof params?.directory === 'string' ? params.directory.trim() : '';
    if (!directory || task.directory !== directory) {
      throw createRuntimeError(
        'task_scope_mismatch',
        `managed task ${task.taskId} does not belong to the requesting directory`,
        403,
      );
    }
    return task;
  };

  const projectTaskResult = (task, resultMode) => {
    const envelope = scheduler.getResultEnvelope(task.taskId);
    return projectManagedTaskResultForMode(
      projectTask(task, envelope),
      envelope,
      resultMode,
    );
  };

  const projectHandoffResult = (scope, result, resultMode) => ({
    rootSessionId: scope.rootSessionId,
    fromMode: scope.fromMode,
    toMode: scope.toMode,
    state: result.state,
    tasks: result.taskIds
      .map((taskId) => scheduler.getTask(taskId))
      .filter(Boolean)
      .map((task) => projectTaskResult(task, resultMode)),
    failures: result.failures,
  });

  const resolveAdmittedAgentExecution = async (params, readOnly) => {
    const requested = {
      providerId: typeof params.providerId === 'string' ? params.providerId.trim() : '',
      modelId: typeof params.modelId === 'string' ? params.modelId.trim() : '',
      variant: typeof params.variant === 'string' && params.variant.trim() ? params.variant.trim() : null,
    };
    const resolved = !resolveAgentExecution || params.deadlineClass === 'council'
      ? requested
      : await resolveAgentExecution({
          rootSessionId: params.rootSessionId,
          directory: params.directory,
          agent: params.agent,
          fallbackExecution: requested,
        });
    let admitted = resolved;
    if (
      readOnly
      && !supportsManagedReadOnlyProvider(resolved.providerId)
      && requested.providerId
      && requested.modelId
      && supportsManagedReadOnlyProvider(requested.providerId)
    ) {
      admitted = requested;
    }
    if (validateAgentExecution) {
      const available = await validateAgentExecution({
        directory: params.directory,
        providerId: admitted.providerId,
        modelId: admitted.modelId,
      });
      if (available === false) {
        throw createRuntimeError(
          'managed_agent_model_unavailable',
          `Managed model is unavailable: ${admitted.providerId}/${admitted.modelId}`,
          409,
        );
      }
    }
    return admitted;
  };

  const handleRpcInternal = async ({ method, params = {} }, context = {}) => {
    await ensureInitialized();
    const resultMode = resolveManagedResultMode(params.resultMode);
    switch (method) {
      case 'submit': {
        assertWorkAdmission();
        const timeoutAt = resolveSubmitTimeoutAt(params, now);
        const readOnly = resolveReadOnly(params);
        const agent = typeof params.agent === 'string' ? params.agent.trim() : '';
        const admittedExecution = await resolveAdmittedAgentExecution(params, readOnly);
        const providerId = admittedExecution.providerId;
        if (readOnly && agent && !supportsManagedReadOnlyAgent(agent)) {
          throw createRuntimeError(
            MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
            MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE,
            409,
          );
        }
        if (readOnly && providerId && !supportsManagedReadOnlyProvider(providerId)) {
          throw createRuntimeError(
            MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED,
            MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE,
            409,
          );
        }
        const task = await scheduler.submit({
          idempotencyKey: params.idempotencyKey,
          rootSessionId: params.rootSessionId,
          dispatchGroupId: params.dispatchGroupId ?? null,
          dispatchCallId: params.dispatchCallId ?? null,
          parentTaskId: params.parentTaskId ?? null,
          childSessionId: params.childSessionId ?? null,
          directory: params.directory,
          mode: params.mode,
          readOnly,
          providerId: admittedExecution.providerId,
          modelId: admittedExecution.modelId,
          agent: params.agent,
          variant: admittedExecution.variant ?? null,
          label: params.label,
          prompt: params.prompt,
          allowDuplicate: params.allowDuplicate === true,
          timeoutAt,
        });
        return projectTaskResult(task, resultMode);
      }
      case 'wait': {
        const task = getScopedTask(params);
        const waitTimeoutMs = resolveWaitTimeoutMs(params);
        const settled = await scheduler.waitForTask(task.taskId, {
          signal: context.signal,
          ...(waitTimeoutMs === undefined ? {} : { timeoutMs: waitTimeoutMs }),
        });
        return projectTaskResult(settled, resultMode);
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
      case 'claim_provider_recovery_continuation': {
        const task = getScopedTask(params);
        return await scheduler.claimProviderRecoveryContinuation({
          taskId: task.taskId,
          rootSessionId: task.rootSessionId,
          directory: task.directory,
          claimantId: typeof params.claimantId === 'string' ? params.claimantId.trim() : '',
        });
      }
      case 'release_provider_recovery_continuation': {
        const task = getScopedTask(params);
        return await scheduler.releaseProviderRecoveryContinuation({
          taskId: task.taskId,
          rootSessionId: task.rootSessionId,
          directory: task.directory,
          claimantId: typeof params.claimantId === 'string' ? params.claimantId.trim() : '',
        });
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
        return projectHandoffResult(scope, result, resultMode);
      }
      case 'status': {
        return projectTaskResult(getScopedTask(params), resultMode);
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
            resultCursor: params.resultCursor,
          }),
        };
      }
      case 'acknowledge': {
        const task = getScopedTask(params);
        if (['retry', 'resume', 'retry_in_place', 'recover_in_place'].includes(params.action)) {
          assertWorkAdmission();
        }
        const timeoutAt = resolveSubmitTimeoutAt({
          timeoutAt: resolveRequestedTimeoutAt(params, now),
          agent: params.agent || task.agent,
        }, now);
        const agentRetryExecution = ['retry', 'resume'].includes(params.action) && params.agent
          ? await resolveAdmittedAgentExecution({ ...params, rootSessionId: task.rootSessionId, directory: task.directory }, task.readOnly)
          : null;
        const result = await scheduler.acknowledgeResult(task.taskId, {
          action: params.action,
          idempotencyKey: params.idempotencyKey,
          ...(agentRetryExecution?.providerId
            ? { providerId: agentRetryExecution.providerId }
            : (params.providerId ? { providerId: params.providerId } : {})),
          ...(agentRetryExecution?.modelId
            ? { modelId: agentRetryExecution.modelId }
            : (params.modelId ? { modelId: params.modelId } : {})),
          ...(params.agent ? { agent: params.agent } : {}),
          ...(agentRetryExecution
            ? { variant: agentRetryExecution.variant ?? null }
            : (params.variant !== undefined ? { variant: params.variant } : {})),
          ...(params.label ? { label: params.label } : {}),
          ...(params.prompt ? { prompt: params.prompt } : {}),
          timeoutAt,
          // Only the scheduler's own auto-resume attempt may carry the generation
          // guard; routes and the private host never forward it.
          ...(context.autoResume === true && Number.isSafeInteger(params.autoResumeGeneration)
            ? { autoResumeGeneration: params.autoResumeGeneration }
            : {}),
        });
        return {
          ...projectManagedResultEnvelope(task, result.envelope, resultMode),
          followUpTask: result.followUpTask
            ? projectTaskResult(result.followUpTask, resultMode)
            : null,
        };
      }
      case 'set_auto_resume': {
        const task = getScopedTask(params);
        if (typeof params.enabled !== 'boolean') {
          throw createRuntimeError('invalid_request', 'enabled must be a boolean', 400);
        }
        const result = await scheduler.setResultAutoResume(task.taskId, { enabled: params.enabled });
        return projectManagedResultEnvelope(task, result.envelope, resultMode);
      }
      default:
        throw createRuntimeError('rpc_method_not_found', `Unknown managed orchestration method: ${method}`, 404);
    }
  };

  // Auxiliary handlers ride the same loopback bridge (plugins already hold its
  // URL + token) without touching scheduler init or managed-mode availability.
  const auxiliaryRpcHandlers = options.auxiliaryRpcHandlers ?? {};

  const handleRpc = async (request, context) => {
    try {
      const auxiliary = typeof request?.method === 'string'
        ? auxiliaryRpcHandlers[request.method]
        : undefined;
      if (typeof auxiliary === 'function') {
        return await auxiliary(request.params ?? {}, context);
      }
      return await handleRpcInternal(request, context);
    } catch (error) {
      throw normalizeRuntimeError(error);
    }
  };

  privateHost = options.privateHost ?? createManagedOrchestrationPrivateHost({ handleRpc });

  const prepareBridge = async () => {
    assertAvailable();
    await ensureOwnership();
    if (bridgeEnvironment) return bridgeEnvironment;
    if (bridgePromise) return await bridgePromise;
    bridgePromise = (async () => {
      bridgeEnvironment = await privateHost.start();
      return bridgeEnvironment;
    })().finally(() => {
      bridgePromise = null;
    });
    return await bridgePromise;
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
    try {
      await ensureInitialized();
    } catch (error) {
      if (!isOwnershipError(error)) throw error;
      return {
        available: false,
        bridgeReady: false,
        recoveryWarning: OWNERSHIP_WARNING,
        tasks: [],
        resultEnvelopes: [],
      };
    }
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
      const ownershipResult = ownershipAcquired
        ? await Promise.resolve().then(() => persistence.releaseOwnership?.()).then(
          () => ({ status: 'fulfilled' }),
          (reason) => ({ status: 'rejected', reason }),
        )
        : { status: 'fulfilled' };
      ownershipAcquired = false;
      terminalErrors.clear();
      const errors = [hostResult, schedulerResult, ownershipResult]
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
    processOpenCodeEvent: (payload) => {
      const observed = terminalErrors.observe(payload);
      // A deleted root session can never receive its follow-up, so its parked
      // auto-resume plans stop here instead of firing into a missing session.
      if (payload?.type === 'session.deleted') {
        const sessionId = payload.properties?.info?.id;
        if (
          initialized
          && typeof sessionId === 'string'
          && sessionId
          && typeof scheduler.cancelAutoResumeForSession === 'function'
        ) {
          scheduler.cancelAutoResumeForSession(sessionId, 'session_deleted').catch((error) => {
            logger.warn?.('[ManagedOrchestration] Failed to cancel auto-resume for a deleted session', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
      return observed;
    },
    shutdown,
    flush: () => scheduler.flush(),
    getDiagnostics() {
      const persistenceDiagnostics = persistence.getDiagnostics?.() ?? {};
      return {
        available: isManagedOpenCode(),
        bridge: privateHost.getDiagnostics?.() ?? null,
        ledger: {
          recoveryWarning: persistenceDiagnostics.recoveryWarning ?? null,
          ownership: persistenceDiagnostics.ownership ?? {
            state: ownershipAcquired ? 'owned' : 'unavailable',
          },
        },
        scheduler: scheduler.getDiagnostics(),
      };
    },
  };
};
