import { createCompactResultHeader } from '@devryan/orchestration-runtime';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequiredCheckObserver } from './required-check-observer.js';
import {
  createManagedAssistantActivityRegistry,
  createManagedOperatorAbortRegistry,
  createManagedTerminalErrorRegistry,
  createManagedTaskScheduler,
  USER_STOPPED_RECOVERY,
  createManagedTaskRecord,
  formatManagedAssignmentContext,
  MANAGED_OVERLAP_READ_TOOLS,
  resolveHarnessPolicies,
  inspectManagedModelInCatalog,
  projectManagedModelValidationFailure,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE,
  projectManagedResultEnvelope,
  projectManagedTaskResult as projectManagedTaskResultForMode,
  readManagedResultReference,
  prepareManagedResultMetadata,
  isManagedMetadataCursor,
  resolveManagedResultMode,
  assertManagedToolOutputSize,
  fitManagedToolOutput,
  compactManagedTaskToolResult,
  MANAGED_TOOL_OUTPUT_MAX_BYTES,
  MANAGED_RESULT_PAGE_MAX_BYTES,
  MANAGED_RESULT_V2_PAGE_MAX_BYTES,
  supportsManagedReadOnlyAgent,
  supportsManagedReadOnlyProvider,
  toManagedTaskEvent,
  isAutoResumeActive,
  isManagedTaskId,
  MANAGED_TASK_ID_PREFIX,
  MANAGED_WAVE_ID_PREFIX,
} from '@devryan/orchestration-runtime';

import { createAtomicManagedOrchestrationLedger } from './atomic-ledger.js';
import {
  createClaudeCompatibilityPreambleResolver,
  resolveManagedTaskTurnBudget,
} from './claude-compatibility.js';
import { resolveGen2OpenCodeClient } from '../opencode/opencode-client-seam.js';
import { createWebManagedOpenCodeExecutor } from './open-code-executor.js';
import { createManagedOrchestrationPrivateHost } from './private-host.js';
import { createParentReadFreshness } from './parent-read-freshness.js';

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const DESIGNER_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const FIXER_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const ORACLE_TASK_TIMEOUT_MS = 15 * 60 * 1_000;
const COUNCIL_TASK_TIMEOUT_MS = 3 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 25_000;
const AGENT_CATALOG_TIMEOUT_MS = 5_000;
const AUTO_RESUME_HOST_DEFER_MS = 30_000;
const AUTO_RESUME_MAX_DEFER_MS = 5 * 60_000;
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
  managed_agent_catalog_unavailable: 503,
  managed_agent_model_unavailable: 409,
  managed_agent_unknown: 400,
  managed_dependency_unavailable: 503,
  managed_orchestration_internal_error: 500,
  invalid_request: 400,
  supabase_disconnected: 503,
  supabase_change_pending: 503,
  managed_orchestration_owner_mismatch: 403,
  managed_orchestration_owner_unavailable: 503,
  work_admission_blocked: 503,
  provider_prompt_rejection_requires_fresh_retry: 409,
  provider_prompt_rejection_requires_reframed_prompt: 409,
  managed_orchestration_owner_conflict: 409,
  managed_orchestration_ownership_lost: 409,
  managed_runtime_unavailable: 503,
  native_managed_task_lease_invalid: 403,
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

const modelValidationResult = (value) => {
  if (value === true || value?.status === 'available') return { status: 'available', reason: null };
  if (value?.status === 'unavailable' && ['provider_missing', 'model_missing', 'variant_missing'].includes(value.reason)) return value;
  return value === false ? { status: 'unavailable', reason: 'selection_unavailable' }
    : { status: 'unknown', reason: 'catalog_unavailable' };
};
const validationIdentity = (value) => typeof value === 'string' ? value.slice(0, 180).replace(/[\x00-\x1f\x7f]/g, '') : null;

// Transport-level failures of a host dependency (Supabase, loopback OpenCode)
// are retryable: callers must see 503, never a malformed 400/500.
const TRANSPORT_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const isDependencyUnavailable = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError'
  || (error instanceof TypeError && error.message === 'fetch failed')
  || (error?.name === 'SupabaseRequestError' && (error.status === 429 || error.status >= 500));

const normalizeRuntimeError = (error) => {
  if (!error || typeof error !== 'object') return error;
  if (error.nativeProcessUnsettled) return Object.assign(createRuntimeError('native_process_settlement_unconfirmed',
    'Native execution termination could not be confirmed', 503), { cause: error, nativeProcessUnsettled: true });
  if (typeof error.code === 'string' && /^native_[a-z_]{1,80}$/.test(error.code)) return Object.assign(
    createRuntimeError(error.code, error.code, Number.isSafeInteger(error.statusCode) ? error.statusCode
      : ERROR_STATUS_BY_CODE[error.code] ?? (Number.isSafeInteger(error.status) ? error.status : 503)), { cause: error });
  if (typeof error.code === 'string' && error.code) {
    if (!Number.isSafeInteger(error.statusCode)) {
      const status = Number.isSafeInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
      const statusCode = ERROR_STATUS_BY_CODE[error.code]
        ?? (isDependencyUnavailable(error) || TRANSPORT_ERROR_CODES.has(error.code) || status >= 500 ? 503 : status ?? 400);
      try { error.statusCode = statusCode; } catch {
        return Object.assign(createRuntimeError(error.code, error.message || error.code, statusCode), { cause: error });
      }
    }
    return error;
  }
  // Foreign errors (DOMException, fetch TypeError, SupabaseRequestError) may
  // have read-only fields; wrap them instead of mutating.
  const wrap = (code, message) => Object.assign(createRuntimeError(code, message), { cause: error });
  if (isDependencyUnavailable(error)) {
    return wrap('managed_dependency_unavailable', 'A managed orchestration dependency is temporarily unavailable; retry the same request.');
  }
  const invalidInput = error instanceof TypeError || error instanceof RangeError;
  return wrap(invalidInput ? 'invalid_request' : 'managed_orchestration_internal_error',
    error.message || 'Managed orchestration request failed');
};

const readCatalogAgentName = (entry) => (typeof entry?.name === 'string' ? entry.name.trim() : '');

// Mirrors the UI subagent pickers and the bundled devryan_task plugin: any
// non-primary mode that OpenCode does not mark hidden (top level or options).
const isDispatchableSubagent = (entry) => (
  typeof entry?.mode === 'string'
  && entry.mode !== 'primary'
  && entry.hidden !== true
  && entry.options?.hidden !== true
);

// OpenCode resolves a child's agent by exact name, so an unmatched name used to
// fail only at the child prompt. Exact wins; a single case-insensitive match is
// canonicalized; ambiguity or a miss is rejected before scheduler admission.
const canonicalizeCatalogAgentName = (agents, agentName) => {
  const named = agents.filter((entry) => readCatalogAgentName(entry));
  const exact = named.find((entry) => readCatalogAgentName(entry) === agentName);
  if (exact) return readCatalogAgentName(exact);
  const folded = agentName.toLowerCase();
  const matches = named.filter((entry) => readCatalogAgentName(entry).toLowerCase() === folded)
    .map(readCatalogAgentName);
  if (matches.length === 1) return matches[0];
  const available = [...new Set(named.filter(isDispatchableSubagent).map(readCatalogAgentName))].sort();
  const availableText = `Available subagents: ${available.length > 0 ? available.join(', ') : 'none'}.`;
  throw createRuntimeError(
    'managed_agent_unknown',
    matches.length > 1
      ? `managed_agent_unknown: Agent name "${agentName}" is ambiguous (matches ${matches.join(', ')}); use the exact name. No managed task was started. ${availableText}`
      : `managed_agent_unknown: Unknown agent "${agentName}"; no managed task was started. ${availableText}`,
  );
};

const projectTask = (task, envelope = null) => (
  toManagedTaskEvent(task, envelope).properties.task
);

const OWNERSHIP_WARNING = 'Managed orchestration is unavailable because another DevRyan runtime owns this data directory. Close the other runtime or configure a separate DEVRYAN_DATA_DIR.';

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
  const cursorReadOnly = options.cursorReadOnly === true && typeof options.nativeTaskDispatch === 'function';
  const supportsReadOnlyProvider = providerId => supportsManagedReadOnlyProvider(providerId, { cursorReadOnly });
  const harnessPolicies = Object.freeze(Object.fromEntries(Object.entries(resolveHarnessPolicies(options.environment ?? process.env))
    .map(([key, enabled]) => [key, typeof options.harnessPolicies?.[key] === 'boolean' ? options.harnessPolicies[key] : enabled])));
  const policyProjection = () => ({ schemaVersion: 1, resultContractVersion: 2, policies: harnessPolicies,
    overlapReadTools: harnessPolicies.readOverlap ? [...MANAGED_OVERLAP_READ_TOOLS] : [] });
  const parentReadFreshness = createParentReadFreshness();
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
    windowsLedgerOwner: options.windowsLedgerOwner,
    windowsLauncher: options.windowsLauncher,
  });
  const terminalErrors = options.terminalErrors ?? createManagedTerminalErrorRegistry({ now });
  const operatorAborts = options.operatorAborts ?? createManagedOperatorAbortRegistry({ now });
  const assistantActivity = createManagedAssistantActivityRegistry({ now });
  const openCodeClient = options.openCodeClient ?? null;
  if (openCodeClient !== null && typeof openCodeClient?.generation !== 'function') {
    throw new TypeError('openCodeClient must be an openCodeClient');
  }
  const validateAgentExecution = typeof options.validateAgentExecution === 'function'
    ? options.validateAgentExecution
    : async (input) => {
      const { signal, ...catalogScope } = input;
      const { directory, providerId, modelId, variant } = catalogScope;
      if (providerId === 'cursor-acp') {
        const onFailure = ({ reason }) => options.onModelValidationFailure?.({ rootSessionId: input.rootSessionId, taskId: input.taskId,
          directory, agent: input.agent, providerId, modelId, variant, reason });
        const validate = () => options.cursorSdkRuntime?.validateModelSelection?.({ directory, modelID: modelId, variant, onFailure,
          ...(signal ? { signal } : {}) }) ?? null;
        try {
          return await (options.withManagedCursorCatalog ? options.withManagedCursorCatalog(catalogScope, validate) : validate());
        } catch (error) {
          const reason = typeof error?.code === 'string' && /^native_[a-z_]{1,80}$/.test(error.code)
            ? error.code : 'cursor_model_catalog_unavailable';
          onFailure({ reason });
          if (reason.startsWith('native_') || error?.nativeProcessUnsettled) throw error;
          return null;
        }
      }
      const client = resolveGen2OpenCodeClient(openCodeClient);
      try {
        const catalog = await client.catalog.providers(directory ? { directory } : {}, { timeoutMs: 5_000 });
        return inspectManagedModelInCatalog(catalog, providerId, modelId, variant);
      } catch { return { status: 'unknown', reason: 'catalog_unavailable' }; }
    };
  // Admission validates the agent against the submitting directory's catalog.
  const readAgentCatalog = typeof options.readAgentCatalog === 'function'
    ? options.readAgentCatalog
    : async ({ directory }) => resolveGen2OpenCodeClient(openCodeClient).catalog.agents({ directory }, { timeoutMs: AGENT_CATALOG_TIMEOUT_MS });
  // Returns the catalog's canonical agent name, or the submitted value when
  // validation is off: DEVRYAN_TASK_AGENT_VALIDATION=0, no catalog source (an
  // external runtime or fixture), or Council's host-constant private dispatch.
  const resolveSubmittedAgent = async ({ agent, directory, deadlineClass }) => {
    if (process.env.DEVRYAN_TASK_AGENT_VALIDATION === '0' || !readAgentCatalog || deadlineClass === 'council') {
      return agent;
    }
    const requested = typeof agent === 'string' ? agent.trim() : '';
    const scope = typeof directory === 'string' ? directory.trim() : '';
    // Missing fields keep their existing admission errors.
    if (!requested || !scope) return agent;
    let agents = null;
    let failure = null;
    try {
      agents = await readAgentCatalog({ directory: scope });
    } catch (error) {
      failure = error;
    }
    if (!Array.isArray(agents)) {
      throw Object.assign(createRuntimeError(
        'managed_agent_catalog_unavailable',
        'managed_agent_catalog_unavailable: The agent catalog for this project could not be read, so the agent name cannot be validated and no managed task was started. Retry the same call.',
        503,
      ), failure ? { cause: failure } : {});
    }
    return canonicalizeCatalogAgentName(agents, requested);
  };
  const resolvePlannedAutoResumeBackup = async (params) => {
    const backup = await resolveAutoResumeBackupExecution(params);
    if (backup && validateAgentExecution && modelValidationResult(await validateAgentExecution({
      directory: params.directory, providerId: backup.providerId, modelId: backup.modelId, variant: backup.variant ?? null,
      ...(backup.providerId === 'cursor-acp' ? { rootSessionId: params.rootSessionId, agent: params.agent,
        taskId: params.taskId, autoResumeGeneration: params.autoResumeGeneration } : {}),
    })).status !== 'available') return null;
    return backup;
  };
  const executor = options.executor ?? createWebManagedOpenCodeExecutor({
    ...(options.eventReconcileIntervalMs === undefined ? {} : { eventReconcileIntervalMs: options.eventReconcileIntervalMs }),
    cursorSdkRuntime: options.cursorSdkRuntime,
    cursorReadOnly,
    registerExecutionChild: options.registerExecutionChild,
    nativeTaskDispatch: options.nativeTaskDispatch,
    ...(openCodeClient === null ? {} : { openCodeClient }),
    readTerminalError: (input) => terminalErrors.read(input),
    readOperatorAbort: (input) => scheduler.readOperatorStop(input) ?? operatorAborts.read(input),
    readRuntimeStartedAt: options.readRuntimeStartedAt,
    subscribeAssistantActivity: assistantActivity.subscribe,
    bindAssistantActivity: assistantActivity.bind,
    subscribeSessionChanges: assistantActivity.subscribeChanges,
    onFirstAssistantActivity: options.onFirstAssistantActivity,
    now,
    // Claude compatibility mode drops opencode's system prompt for Anthropic-routed
    // children, so their agent rules travel inside the first task prompt instead.
    resolveTaskPromptPreamble: options.resolveTaskPromptPreamble
      ?? createClaudeCompatibilityPreambleResolver({ now }),
    // Designer/fixer tool loops get an assistant-turn backstop (wrap-up prompt,
    // then abort) so a runaway child cannot burn the whole task timeout.
    resolveTaskTurnBudget: options.resolveTaskTurnBudget ?? resolveManagedTaskTurnBudget,
  });
  // Automatic quota recovery or a single backup after exhausted transport
  // recovery. It re-enters the acknowledge RPC exactly as a user's Try Again
  // would, plus the internal generation guard the scheduler uses to reject a
  // stale attempt; the host defers (never fails) while work admission is blocked.
  const autoResumeDeferrals = new Map();
  const attemptAutoResume = async (params) => {
    const block = getWorkAdmissionBlock();
    if (block) {
      return {
        outcome: 'deferred',
        retryAfterMs: AUTO_RESUME_HOST_DEFER_MS,
        reason: block.code || 'work_admission_blocked',
      };
    }
    try {
      const task = scheduler.getTask(params.taskId);
      const envelope = scheduler.getResultEnvelope(params.taskId);
      if (task && (envelope?.autoResume?.trigger === 'provider_transport' || envelope?.autoResume?.target?.kind === 'backup')) {
        const backup = await resolveAutoResumeBackupExecution({
          rootSessionId: task.rootSessionId, directory: task.directory, agent: task.agent,
          providerId: task.providerId, modelId: task.modelId,
        });
        if (!backup || backup.providerId !== params.providerId || backup.modelId !== params.modelId
          || (backup.variant ?? null) !== (params.variant ?? null)) {
          return { outcome: 'rejected', code: 'backup_changed', message: 'The configured backup changed or was removed' };
        }
        if (validateAgentExecution) {
          const available = modelValidationResult(await validateAgentExecution({ directory: task.directory, providerId: params.providerId, modelId: params.modelId, variant: params.variant ?? null,
            ...(params.providerId === 'cursor-acp' ? { rootSessionId: task.rootSessionId, agent: task.agent,
              taskId: task.taskId, autoResumeGeneration: params.autoResumeGeneration } : {}) }));
          if (available.status === 'unavailable') {
            return { outcome: 'rejected', code: 'backup_unavailable', message: 'The configured backup model is unavailable' };
          }
          if (available.status !== 'available') {
            if (envelope.autoResume.trigger !== 'provider_transport') {
              return { outcome: 'deferred', retryAfterMs: AUTO_RESUME_HOST_DEFER_MS, reason: 'backup_availability_unknown' };
            }
            return { outcome: 'rejected', code: 'backup_availability_unknown', message: 'The backup model catalog could not be verified' };
          }
        }
      }
      const result = await handleRpcInternal({ method: 'acknowledge', params }, { autoResume: true });
      autoResumeDeferrals.delete(params.taskId);
      return {
        outcome: 'started',
        followUpTaskId: typeof result?.followUpTask?.taskId === 'string' ? result.followUpTask.taskId : null,
      };
    } catch (rawError) {
      const error = normalizeRuntimeError(rawError);
      const code = typeof error?.code === 'string' && error.code ? error.code : 'attempt_failed';
      if (AUTO_RESUME_SETTLED_CODES.has(code)) { autoResumeDeferrals.delete(params.taskId); return { outcome: 'started', followUpTaskId: null }; }
      if (error?.statusCode === 503) {
        // An unavailable dependency backs off (30 s doubling to 5 min) instead
        // of re-asking it every 30 s for the whole lineage window.
        const count = (autoResumeDeferrals.get(params.taskId) ?? 0) + 1;
        autoResumeDeferrals.delete(params.taskId);
        autoResumeDeferrals.set(params.taskId, count);
        while (autoResumeDeferrals.size > 1_000) autoResumeDeferrals.delete(autoResumeDeferrals.keys().next().value);
        return { outcome: 'deferred', retryAfterMs: Math.min(AUTO_RESUME_HOST_DEFER_MS * 2 ** (count - 1), AUTO_RESUME_MAX_DEFER_MS), reason: code };
      }
      autoResumeDeferrals.delete(params.taskId);
      return {
        outcome: 'rejected',
        code,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const scheduler = options.scheduler ?? createManagedTaskScheduler({
    cursorReadOnly,
    onBarrierChange: options.onBarrierChange,
    onRequiredCheckReceipt: options.onRequiredCheckReceipt,
    onPersistenceObservation: options.onPersistenceObservation,
    onMutationTiming: options.onMutationTiming,
    executor,
    persistence,
    now,
    publishEvent,
    logger,
    ...(options.createTaskId ? { createTaskId: options.createTaskId } : {}),
    ...(options.createLeaseToken ? { createLeaseToken: options.createLeaseToken } : {}),
    autoResume: {
      resolveOwnerKey: resolveAutoResumeOwnerKey,
      resolveBackupExecution: resolvePlannedAutoResumeBackup,
      resolveProviderReset: resolveAutoResumeProviderReset,
      attempt: attemptAutoResume,
    },
  });

  const requiredCheckObserver = createRequiredCheckObserver({ scheduler, now });

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
    if (!block && typeof options.getNativeDispatchReady === 'function' && !options.getNativeDispatchReady()) {
      throw createRuntimeError('native_dispatch_unavailable', 'The native execution controller is not ready', 503);
    }
    if (!block) return;
    throw createRuntimeError(
      block.code || 'work_admission_blocked',
      block.error || block.message || 'Work admission is temporarily blocked',
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
            type: 'devryan:managed-orchestration-warning',
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

  // Constructor-only native dispatch/settlement proof. Queued tasks never borrow the
  // original tool's transient permit, and this method is absent from RPC.
  const verifyNativeTaskDispatch = async (input) => {
    assertAvailable();
    if (!initialized || !ownershipAcquired || shutdownPromise) {
      throw createRuntimeError('native_managed_task_lease_invalid', 'Native managed dispatch owner is unavailable', 403);
    }
    await persistence.verifyOwnership?.();
    const settling = input?.operation === 'settle';
    const task = typeof input?.taskId === 'string'
      ? await (settling ? scheduler.verifyTaskSettlement(input.taskId, input.leaseToken) : scheduler.verifyTaskDispatch(input.taskId, input.leaseToken))
      : null;
    assertAvailable();
    if (!settling) assertWorkAdmission();
    if (shutdownPromise || !ownershipAcquired || !task || task.owner !== 'devryan' || !input.leaseToken || task.leaseToken !== input.leaseToken
      || !['starting', 'running'].includes(task.status) || task.directory !== input.directory) {
      throw createRuntimeError('native_managed_task_lease_invalid', 'Native managed dispatch has no current task lease', 403);
    }
    if (input.operation === 'create') {
      if (task.status !== 'starting' || task.childSessionId || task.rootSessionId !== input.parentID
        || !task.dispatchCallId || task.dispatchCallId !== input.parentCallID) {
        throw createRuntimeError('native_managed_task_scope_invalid', 'Native child creation does not match its task', 403);
      }
    } else if (input.operation === 'prompt' || settling) {
      if (!task.childSessionId || task.childSessionId !== input.sessionID
        || ['providerId', 'modelId', 'agent', 'variant'].some(key => task[key] !== input[key])) {
        throw createRuntimeError('native_managed_task_scope_invalid', 'Native child prompt does not match its task', 403);
      }
    } else throw createRuntimeError('native_managed_task_scope_invalid', 'Native task dispatch operation is unavailable', 403);
    return task;
  };

  // A recovery catalog read is bound to the current unacknowledged attempt,
  // never to a caller-supplied root ID or the original tool's expired permit.
  const verifyNativeTaskCatalog = async (input) => {
    const check = () => {
      assertAvailable(); assertWorkAdmission();
      const task = scheduler.getTask(input?.taskId);
      const envelope = scheduler.getResultEnvelope(input?.taskId);
      if (!initialized || !ownershipAcquired || shutdownPromise || !task || task.owner !== 'devryan'
        || task.rootSessionId !== input.rootSessionId || task.directory !== input.directory || task.agent !== input.agent
        || input.providerId !== 'cursor-acp' || !Number.isSafeInteger(input.autoResumeGeneration)
        || !envelope || envelope.action !== null || !isAutoResumeActive(envelope)
        || envelope.autoResume.cancelGeneration !== input.autoResumeGeneration) {
        throw createRuntimeError('native_managed_task_catalog_invalid', 'Managed recovery catalog authority expired', 403);
      }
      return task;
    };
    const task = check();
    await persistence.verifyOwnership?.();
    const backup = await resolveAutoResumeBackupExecution({ rootSessionId: task.rootSessionId,
      directory: task.directory, agent: task.agent, providerId: task.providerId, modelId: task.modelId });
    check();
    if (!backup || backup.providerId !== input.providerId || backup.modelId !== input.modelId
      || (backup.variant ?? null) !== (input.variant ?? null)) {
      throw createRuntimeError('native_managed_task_catalog_invalid', 'Managed recovery selection changed', 403);
    }
    return task;
  };

  const projectTaskResult = async (task, resultMode, envelope = scheduler.getResultEnvelope(task.taskId), maxOutputBytes, resultContractVersion) => {
    const result = projectManagedTaskResultForMode(
      projectTask(task, envelope),
      envelope,
      resultMode,
    );
    if (resultMode === 'compact' && harnessPolicies.compactResults && envelope && result.resultReference) {
      result.resultHeader = createCompactResultHeader({ task, envelope,
        checks: await requiredCheckObserver.project(task), observedAt: now() });
    }
    const capabilities = Object.values(harnessPolicies).some(Boolean) ? { capabilities: policyProjection() } : {};
    const metadata=resultContractVersion===2&&envelope?await prepareManagedResultMetadata({...result,...capabilities,resultContractVersion:2}):null;
    if (maxOutputBytes === undefined) return { ...result, ...capabilities,...resultContractVersion===2?{resultContractVersion:2}:{} };
    return fitManagedToolOutput(pageBytes => {
      const full={...projectManagedTaskResultForMode(projectTask(task,envelope),envelope,resultMode,pageBytes),
        ...(result.resultHeader?{resultHeader:result.resultHeader}:{}),...capabilities,...resultContractVersion===2?{resultContractVersion:2}:{}};
      try{return assertManagedToolOutputSize(full,maxOutputBytes);}
      catch(error){if(error.code!=='managed_tool_output_metadata_too_large')throw error;return metadata?metadata.project(pageBytes,full.resultReference):full;}
    },maxOutputBytes,resultContractVersion===2?MANAGED_RESULT_V2_PAGE_MAX_BYTES:MANAGED_RESULT_PAGE_MAX_BYTES);
  };

  const projectEnvelopeResult = async (task, envelope, resultMode, maxOutputBytes) => {
    if (maxOutputBytes === undefined && resultMode !== 'compact') return projectManagedResultEnvelope(task, envelope, resultMode);
    const { task: _task, ...result } = await projectTaskResult(task, resultMode, envelope, maxOutputBytes);
    return result;
  };

  const projectHandoffResult = async (scope, result, resultMode) => ({
    rootSessionId: scope.rootSessionId,
    fromMode: scope.fromMode,
    toMode: scope.toMode,
    state: result.state,
    tasks: await Promise.all(result.taskIds
      .map((taskId) => scheduler.getTask(taskId))
      .filter(Boolean)
      .map((task) => projectTaskResult(task, resultMode))),
    failures: result.failures,
  });

  const resolveAdmittedAgentExecution = async (params, readOnly, signal) => {
    signal?.throwIfAborted();
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
      && !supportsReadOnlyProvider(resolved.providerId)
      && requested.providerId
      && requested.modelId
      && supportsReadOnlyProvider(requested.providerId)
    ) {
      admitted = requested;
    }
    if (validateAgentExecution) {
      const available = modelValidationResult(await validateAgentExecution({
        directory: params.directory,
        providerId: admitted.providerId,
        modelId: admitted.modelId,
        variant: admitted.variant ?? null,
        ...(signal ? { signal } : {}),
        ...(admitted.providerId === 'cursor-acp' ? { rootSessionId: params.rootSessionId,
          agent: params.agent, taskId: params.taskId, autoResumeGeneration: params.autoResumeGeneration } : {}),
      }));
      signal?.throwIfAborted();
      if (available.status !== 'available') {
        const details = { reason: available.reason, providerId: validationIdentity(admitted.providerId),
          modelId: validationIdentity(admitted.modelId), variant: validationIdentity(admitted.variant),
          agent: validationIdentity(params.agent),
          ...(available.modelName ? { modelName: available.modelName } : {}),
          ...(available.supportedVariants ? { supportedVariants: available.supportedVariants } : {}) };
        const projection = projectManagedModelValidationFailure({
          code: available.status === 'unavailable' ? 'managed_agent_model_unavailable' : 'managed_agent_model_availability_unknown', details });
        options.onModelValidationFailure?.({ ...projection.details, rootSessionId: validationIdentity(params.rootSessionId),
          directory: validationIdentity(params.directory), agent: validationIdentity(params.agent),
          taskId: validationIdentity(params.taskId), callId: validationIdentity(params.dispatchCallId ?? params.callId),
          messageId: validationIdentity(params.dispatchGroupId) });
        throw Object.assign(createRuntimeError(
          projection.code, projection.message,
          available.status === 'unavailable' ? 409 : 503,
        ), { details: projection.details });
      }
    }
    return admitted;
  };

  const preparedSubmissions = new AsyncLocalStorage();
  const nativePromptContexts = new AsyncLocalStorage();
  const resolveSubmission = async (params, context) => {
    context.signal?.throwIfAborted();
    const readOnly = resolveReadOnly(params), submittedAgent = await resolveSubmittedAgent(params);
    context.signal?.throwIfAborted();
    const agent = typeof submittedAgent === 'string' ? submittedAgent.trim() : '';
    const admittedExecution = await resolveAdmittedAgentExecution({ ...params, agent: submittedAgent }, readOnly, context.signal);
    if (readOnly && agent && !supportsManagedReadOnlyAgent(agent)) throw createRuntimeError(
      MANAGED_READ_ONLY_AGENT_UNSUPPORTED, MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE, 409);
    if (readOnly && admittedExecution.providerId && !supportsReadOnlyProvider(admittedExecution.providerId)) throw createRuntimeError(
      MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED, MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE, 409);
    context.signal?.throwIfAborted();
    return Object.freeze({ readOnly, submittedAgent, admittedExecution: Object.freeze({ ...admittedExecution }) });
  };

  // Constructor-only preparation; the durable submit still owns its original
  // cancellation, admission and scheduler fences. No wire field grants reuse.
  const withSubmissionPreparation = async (params, context = {}, action) => {
    let selection;
    const signature = JSON.stringify(params);
    try {
      if (typeof action !== 'function') throw new TypeError('Submission action is required');
      assertAvailable(); await ensureInitialized(); assertWorkAdmission();
      selection = await resolveSubmission(params, context);
      context.signal?.throwIfAborted(); assertWorkAdmission();
    } catch (error) { throw normalizeRuntimeError(error); }
    return preparedSubmissions.run({ signature, selection, used: false }, action);
  };

  const handleRpcInternal = async ({ method, params = {} }, context = {}) => {
    // Static tool advertising must not reconcile children before their controller starts.
    if (method === 'harness_capabilities') return policyProjection();
    await ensureInitialized();
    const requestedResultMode = resolveManagedResultMode(params.resultMode);
    const resultMode = params.resultContractVersion===2&&requestedResultMode!=='eager'?'compact':harnessPolicies.compactResults && params.resultContractVersion === 1 && requestedResultMode !== 'eager'
      ? 'compact' : requestedResultMode === 'compact' ? 'reference' : requestedResultMode;
    const maxOutputBytes = params.maxOutputBytes??(params.resultContractVersion===2?MANAGED_TOOL_OUTPUT_MAX_BYTES:undefined);
    if (maxOutputBytes !== undefined) assertManagedToolOutputSize({}, maxOutputBytes);
    const project = (task, envelope = scheduler.getResultEnvelope(task.taskId)) => projectTaskResult(task, resultMode, envelope, maxOutputBytes, params.resultContractVersion);
    const reserveCommittedReceipt = (identity) => {
      if (maxOutputBytes !== undefined) assertManagedToolOutputSize({ committed: true, ...identity }, maxOutputBytes);
    };
    const committedProjection = async (identity, projection) => {
      try {
        const value = await projection();
        return maxOutputBytes === undefined ? value : assertManagedToolOutputSize(value, maxOutputBytes);
      }
      catch (error) {
        if (maxOutputBytes === undefined) throw error;
        return assertManagedToolOutputSize({ committed: true, ...identity,
          projectionError: error?.code === 'managed_tool_output_metadata_too_large' ? error.code : 'managed_result_projection_unavailable' }, maxOutputBytes);
      }
    };
    switch (method) {
      case 'context_state': {
        // Read-only and scope-checked; compaction anchors use it regardless of
        // the context-projection policy, which gates only model-visible tools.
        const { rootSessionId, directory } = params;
        if (typeof rootSessionId !== 'string' || !rootSessionId || typeof directory !== 'string' || !directory) throw createRuntimeError('task_scope_mismatch', 'Context scope is required', 403);
        const tasks = scheduler.listTasks({ rootSessionId });
        for (const task of tasks) assertTaskScope(task, params);
        return { tasks: tasks.map((task) => ({ taskId: task.taskId, rootSessionId, childSessionId: task.childSessionId,
          status: task.status, failureReason: task.failureReason, readOnly: task.readOnly,
          requiredChecks: (task.requiredChecks ?? []).map(({ name }) => ({ name })),
          requiredCheckReceipts: (task.requiredCheckReceipts ?? []).map(({ name, status, callId, messageId }) => ({ name, status, callId, messageId })) })),
          envelopes: scheduler.listResultEnvelopes({ rootSessionId }).map((envelope) => ({ taskId: envelope.taskId,
            rootSessionId, envelopeId: envelope.envelopeId, action: envelope.action, autoResume: envelope.autoResume })) };
      }
      case 'child_assignment': {
        // Read-only: the delegated brief a child's compaction summary keeps.
        const childSessionId = typeof params.childSessionId === 'string' ? params.childSessionId.trim() : '';
        const directory = typeof params.directory === 'string' ? params.directory.trim() : '';
        if (!childSessionId || !directory) throw createRuntimeError('task_scope_mismatch', 'childSessionId and directory are required', 403);
        const task = scheduler.getChildAssignment?.(childSessionId, directory) ?? null;
        return { text: task ? formatManagedAssignmentContext(task, { maxBytes: params.maxBytes }) : null };
      }
      case 'required_check': {
        if (!harnessPolicies.compactResults) return { tracked: false };
        if (params.phase === 'before') return await requiredCheckObserver.before(params);
        if (params.phase === 'after') return await requiredCheckObserver.after(params);
        throw new TypeError('required check phase must be before or after');
      }
      case 'watch_result_commits': return await scheduler.waitForResultCommit({
        directory: params.directory, afterCursor: params.afterCursor, signal: context.signal,
        timeoutMs: resolveWaitTimeoutMs(params) ?? 25_000,
      });
      case 'parent_tool': {
        if (!harnessPolicies.readOverlap) return { allowed: false };
        const rootSessionId = typeof params.rootSessionId === 'string' ? params.rootSessionId.trim() : '';
        const directory = typeof params.directory === 'string' ? params.directory.trim() : '';
        if (!rootSessionId || !directory) throw createRuntimeError('task_scope_mismatch', 'rootSessionId and directory are required', 403);
        const rootTasks = scheduler.listTasks({ rootSessionId });
        if (rootTasks.some((task) => task.directory !== directory)) throw createRuntimeError('task_scope_mismatch', 'parent tool directory does not match managed work', 403);
        const barrier = await scheduler.inspectDispatchBarrier(rootSessionId);
        const clear = barrier.state === 'clear';
        const input = { rootSessionId, directory, tool: params.tool, args: params.args, callId: params.callId, barrierClear: clear };
        if (params.phase === 'after') {
          await parentReadFreshness.observeRead(input);
          return { allowed: true, provisional: !clear };
        }
        if (params.phase !== 'before') throw new TypeError('parent tool phase must be before or after');
        await parentReadFreshness.beginRead(input);
        if (!clear) return { allowed: MANAGED_OVERLAP_READ_TOOLS.includes(params.tool), provisional: true };
        if (rootTasks.some((task) => task.mode === 'orchestrator' && task.dispatchGroupId !== null)) {
          await parentReadFreshness.assertWrite(input);
        }
        return { allowed: true, provisional: false };
      }
      case 'submit': {
        context.signal?.throwIfAborted();
        assertWorkAdmission();
        const timeoutAt = resolveSubmitTimeoutAt(params, now);
        const prepared = preparedSubmissions.getStore();
        if (prepared && (prepared.used || prepared.signature !== JSON.stringify(params))) {
          throw createRuntimeError('managed_submission_preparation_changed', 'Managed submission preparation expired', 409);
        }
        if (prepared) prepared.used = true;
        const { readOnly, submittedAgent, admittedExecution } = prepared?.selection ?? await resolveSubmission(params, context);
        context.signal?.throwIfAborted();
        reserveCommittedReceipt({ taskId: MANAGED_TASK_ID_PREFIX.padEnd(256, 'x'), rootSessionId: params.rootSessionId, action: 'start' });
        const submission = {
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
          agent: submittedAgent,
          variant: admittedExecution.variant ?? null,
          label: params.label,
          prompt: params.prompt,
          ...(params.requiredChecks ? { requiredChecks: params.requiredChecks } : {}),
          allowDuplicate: params.allowDuplicate === true,
          // Only Council's private dispatch class reaches the scheduler; it
          // marks independent reviewer seats for the duplicate guard.
          ...(params.deadlineClass === 'council' ? { deadlineClass: 'council' } : {}),
          timeoutAt,
        };
        if (maxOutputBytes !== undefined) await project(createManagedTaskRecord({ ...submission,
          taskId: MANAGED_TASK_ID_PREFIX.padEnd(256, 'x'), dispatchWaveId: MANAGED_WAVE_ID_PREFIX.padEnd(256, 'x'),
          sequence: Number.MAX_SAFE_INTEGER, createdAt: now(), attempt: 1, priorTaskId: null, executionKind: 'start' }), null);
        const task = await scheduler.submit(submission, { signal: context.signal, authorize: async () => {
          context.signal?.throwIfAborted(); assertAvailable(); assertWorkAdmission();
          await persistence.verifyOwnership?.();
          await context.authorizeSubmission?.();
          context.signal?.throwIfAborted(); assertAvailable(); assertWorkAdmission();
        } });
        return committedProjection({ taskId: task.taskId, rootSessionId: task.rootSessionId, action: 'start', status: task.status }, () => project(task));
      }
      case 'wait': {
        const task = getScopedTask(params);
        const waitTimeoutMs = resolveWaitTimeoutMs(params);
        const settled = await scheduler.waitForTask(task.taskId, {
          signal: context.signal,
          ...(waitTimeoutMs === undefined ? {} : { timeoutMs: waitTimeoutMs }),
        });
        return project(settled);
      }
      case 'wait_any': {
        if (!harnessPolicies.waitAny) throw createRuntimeError('harness_policy_disabled', 'wait_any is disabled; use wait for an individual task', 409);
        if (!Array.isArray(params.taskIds) || params.taskIds.length === 0) throw new TypeError('taskIds is required');
        if(params.resultContractVersion===2&&(params.taskIds.some(id=>!isManagedTaskId(id))
          ||new Set(params.taskIds).size!==params.taskIds.length))throw createRuntimeError('invalid_request','Exact distinct task identifiers are required',400);
        const scopedTasks = [...new Set(params.taskIds)].map((taskId) => getScopedTask({ ...params, taskId }));
        const waitTimeoutMs = resolveWaitTimeoutMs(params);
        const result = await scheduler.waitForAnyTask({ rootSessionId: params.rootSessionId,
          taskIds: scopedTasks.map((task) => task.taskId), afterCursor: params.afterCursor,
          ...(params.until===undefined?{}:{until:params.until}),
          signal: context.signal, ...(waitTimeoutMs === undefined ? {} : { timeoutMs: waitTimeoutMs }) });
        const returnedIds = new Set([...result.readyTaskIds, ...result.attention.map((entry) => entry.taskId),
          ...(result.settled ? result.unacknowledgedTaskIds : [])]);
        const selected=scopedTasks.filter(task=>returnedIds.has(task.taskId)).map(task=>getScopedTask({...params,taskId:task.taskId}));
        if(params.resultContractVersion!==2)return { ...result, results:await Promise.all(selected.map(task=>project(task))),capabilities:policyProjection() };
        const projected=await Promise.all(selected.map(task=>projectTaskResult(task,resultMode,scheduler.getResultEnvelope(task.taskId),undefined,2)));
        const full=compactManagedTaskToolResult({...result,results:projected,capabilities:policyProjection(),resultContractVersion:2});
        try{return assertManagedToolOutputSize(full,maxOutputBytes);}catch(error){if(error.code!=='managed_tool_output_metadata_too_large')throw error;}
        const metadata=await Promise.all(projected.map(value=>prepareManagedResultMetadata(value)));
        for(let count=projected.length;count>=0;count--){
          try{return fitManagedToolOutput(pageBytes=>({...result,results:metadata.slice(0,count).map(section=>section.project(pageBytes)),
            notReturnedTaskIds:selected.slice(count).map(task=>task.taskId),capabilities:policyProjection(),resultContractVersion:2}),maxOutputBytes,MANAGED_RESULT_V2_PAGE_MAX_BYTES);}
          catch(error){if(error.code!=='managed_tool_output_metadata_too_large')throw error;}
        }
        throw createRuntimeError('managed_tool_output_metadata_too_large','The selected wait metadata exceeds response capacity; use a smaller exact selection',409);
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
          ...await projectEnvelopeResult(task, resultEnvelope, resultMode, maxOutputBytes),
          followUpTask: followUpTask ? await project(followUpTask) : null,
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
        const promptContext = nativePromptContexts.getStore();
        const barrier = promptContext
          ? await promptContext.readBarrier({ rootSessionId, directory: params.directory })
          : await scheduler.inspectDispatchBarrier(rootSessionId);
        return Object.values(harnessPolicies).some(Boolean) ? { ...barrier, capabilities: policyProjection() } : barrier;
      }
      case 'list_provider_recovery_continuations': {
        const sessionId = typeof params.sessionId === 'string'
          ? params.sessionId.trim()
          : '';
        return {
          resultCommitWatch: true,
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
      case 'verify_recovered_collection': {
        const task = getScopedTask(params);
        return scheduler.verifyRecoveredCollection({ taskId: task.taskId, rootSessionId: task.rootSessionId,
          directory: task.directory, claimantId: params.claimantId });
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
        return project(getScopedTask(params));
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
        reserveCommittedReceipt({ taskId: task.taskId, rootSessionId: task.rootSessionId, action: 'cancel' });
        const cancelled = await scheduler.cancelTask(task.taskId, {
          cascade: params.cascade === true,
          ...(context.userStoppedRecovery === true ? { terminationIntent: 'user_stopped' } : {}),
          ...(typeof params.reason === 'string' && params.reason.trim()
            ? { reason: params.reason.trim() }
            : {}),
        });
        return committedProjection({ taskId: task.taskId, rootSessionId: task.rootSessionId, action: 'cancel',
          ...(Array.isArray(cancelled) ? { affectedTaskCount: cancelled.length } : { status: cancelled.status }) },
        async () => Array.isArray(cancelled) ? { tasks: await Promise.all(cancelled.map(entry => project(entry))) } : project(cancelled));
      }
      case 'read_result': {
        if(params.reads!==undefined){
          if(params.resultContractVersion!==2||params.taskId!==undefined||params.resultCursor!==undefined||!Array.isArray(params.reads)||!params.reads.length
            ||params.reads.some(read=>!read||Object.keys(read).length!==2||typeof read.taskId!=='string'||typeof read.resultCursor!=='string')
            ||new Set(params.reads.map(read=>read.taskId)).size!==params.reads.length)throw createRuntimeError('invalid_request','Exact distinct result reads are required',400);
          const reply={resultContractVersion:2,results:[],failed:[],notProcessed:params.reads.map(read=>read.taskId)};
          if(maxOutputBytes!==undefined)assertManagedToolOutputSize(reply,maxOutputBytes);
          for(const read of params.reads){
            if(context.signal?.aborted)break;
            const rest=reply.notProcessed.slice(1),capacity=maxOutputBytes===undefined?undefined:maxOutputBytes-Buffer.byteLength(JSON.stringify(reply))-512;
            if(capacity!==undefined&&capacity<1024)break;
            try{
              const value=await handleRpcInternal({method:'read_result',params:{...params,reads:undefined,...read,...capacity===undefined?{}:{maxOutputBytes:capacity}}},context);
              const row={taskId:read.taskId,...value},next={...reply,results:[...reply.results,row],notProcessed:rest};
              if(maxOutputBytes!==undefined)assertManagedToolOutputSize(next,maxOutputBytes);
              reply.results.push(row);reply.notProcessed=rest;
            }catch(error){
              const failed={taskId:read.taskId,code:typeof error?.code==='string'&&/^[a-z0-9_]{1,128}$/.test(error.code)?error.code:'managed_result_read_failed'};
              if(maxOutputBytes!==undefined)assertManagedToolOutputSize({...reply,failed:[...reply.failed,failed],notProcessed:rest},maxOutputBytes);
              reply.failed.push(failed);reply.notProcessed=rest;
            }
          }
          return reply;
        }
        const task = getResultReadScopedTask(params);
        const resultEnvelope = scheduler.getResultEnvelope(task.taskId);
        if (!resultEnvelope) {
          throw createRuntimeError(
            'result_not_found',
            `managed result for task ${task.taskId} was not found`,
            404,
          );
        }
        if(params.resultContractVersion===2&&isManagedMetadataCursor(params.resultCursor)){
          const full=await projectTaskResult(task,resultMode,resultEnvelope,undefined,2),metadata=await prepareManagedResultMetadata(full);
          return maxOutputBytes===undefined?metadata.read(params.resultCursor):fitManagedToolOutput(pageBytes=>metadata.read(params.resultCursor,pageBytes),maxOutputBytes,MANAGED_RESULT_V2_PAGE_MAX_BYTES);
        }
        const projectPage = maxPageBytes => ({
          resultReference: readManagedResultReference({
            task,
            resultEnvelope,
            resultCursor: params.resultCursor,
            maxPageBytes,
          }),
        });
        return maxOutputBytes === undefined ? projectPage() : fitManagedToolOutput(projectPage, maxOutputBytes,
          params.resultContractVersion===2?MANAGED_RESULT_V2_PAGE_MAX_BYTES:MANAGED_RESULT_PAGE_MAX_BYTES);
      }
      case 'acknowledge': {
        const task = getScopedTask(params);
        const review=context.nativeResultReview;
        if(params.resultContractVersion===2&&(typeof review?.recheck!=='function'||review.taskId!==task.taskId
          ||review.envelopeId!==scheduler.getResultEnvelope(task.taskId)?.envelopeId||review.action!==params.action
          ||review.acknowledgementIdentity!==params.acknowledgementIdentity))throw createRuntimeError('managed_result_review_required','Canonical result delivery and a later authorized review Step are required',409);
        if(params.resultContractVersion===2)await review.recheck();
        if (maxOutputBytes !== undefined) await project(task);
        reserveCommittedReceipt({ taskId: task.taskId, rootSessionId: task.rootSessionId, action: params.action,
          envelopeId: scheduler.getResultEnvelope(task.taskId)?.envelopeId, followUpTaskId: MANAGED_TASK_ID_PREFIX.padEnd(256, 'x'),
          projectionError: 'managed_tool_output_metadata_too_large' });
        if (['retry', 'resume', 'retry_in_place', 'recover_in_place'].includes(params.action)) {
          assertWorkAdmission();
        }
        const timeoutAt = resolveSubmitTimeoutAt({
          timeoutAt: resolveRequestedTimeoutAt(params, now),
          agent: params.agent || task.agent,
        }, now);
        const agentOverride = ['retry', 'resume'].includes(params.action) && params.agent;
        // A retry/resume agent override schedules a new child, so it passes the
        // same catalog admission as submit.
        const acknowledgedAgent = agentOverride
          ? await resolveSubmittedAgent({ agent: params.agent, directory: task.directory })
          : params.agent;
        const agentRetryExecution = agentOverride
          ? await resolveAdmittedAgentExecution({
            ...params, agent: acknowledgedAgent, rootSessionId: task.rootSessionId, directory: task.directory,
          }, task.readOnly)
          : null;
        const result = await scheduler.acknowledgeResult(task.taskId, {
          action: params.action,
          idempotencyKey: params.idempotencyKey,
          ...(context.userStoppedRecovery === true ? { [USER_STOPPED_RECOVERY]: true } : {}),
          ...(params.resultContractVersion===2?{acknowledgementIdentity:params.acknowledgementIdentity}:{}),
          ...(params.resultContractVersion===2?{authorize:review.recheck}:{}),
          ...(agentRetryExecution?.providerId
            ? { providerId: agentRetryExecution.providerId }
            : (params.providerId ? { providerId: params.providerId } : {})),
          ...(agentRetryExecution?.modelId
            ? { modelId: agentRetryExecution.modelId }
            : (params.modelId ? { modelId: params.modelId } : {})),
          ...(acknowledgedAgent ? { agent: acknowledgedAgent } : {}),
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
        return committedProjection({ taskId: task.taskId, rootSessionId: task.rootSessionId, action: result.envelope.action,
          envelopeId: result.envelope.envelopeId, followUpTaskId: result.followUpTask?.taskId ?? null }, async () => ({
          ...await projectEnvelopeResult(task, result.envelope, resultMode, maxOutputBytes),
          followUpTask: result.followUpTask
            ? await project(result.followUpTask)
            : null,
        }));
      }
      case 'set_auto_resume': {
        const task = getScopedTask(params);
        if (typeof params.enabled !== 'boolean') {
          throw createRuntimeError('invalid_request', 'enabled must be a boolean', 400);
        }
        const result = await scheduler.setResultAutoResume(task.taskId, { enabled: params.enabled });
        return await projectEnvelopeResult(task, result.envelope, resultMode);
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

  privateHost = options.privateHost ?? createManagedOrchestrationPrivateHost({ handleRpc, authorizeRpc: options.authorizePrivateRpc });

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
      dispatchReady: Boolean(initialized && ownershipAcquired && !shutdownPromise && !getWorkAdmissionBlock()
        && (typeof options.getNativeDispatchReady === 'function' ? options.getNativeDispatchReady() : bridgeEnvironment)),
      recoveryWarning: persistence.getDiagnostics?.().recoveryWarning ?? null,
      tasks: tasks.map((task) => projectTask(task, scheduler.getResultEnvelope(task.taskId))),
      resultEnvelopes: scheduler.listResultEnvelopes({ rootSessionId }),
    };
  }

  const shutdown = () => {
    requiredCheckObserver.dispose();
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
      operatorAborts.clear();
      assistantActivity.clear();
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
    withSubmissionPreparation,
    getSnapshot,
    withNativePromptContext: async (input, action) => {
      const scope = { rootSessionId: input.rootSessionId, directory: input.directory, authorize: input.authorize };
      assertAvailable(); await ensureOwnership(); assertWorkAdmission();
      return scheduler.withNativePromptContext({ ...scope, authorize: async () => {
        await persistence.verifyOwnership?.(); assertAvailable(); assertWorkAdmission();
        await scope.authorize();
      } }, state => nativePromptContexts.run({ readBarrier: state.readBarrier }, () => action(state)));
    },
    verifyNativeTaskDispatch: input => verifyNativeTaskDispatch(input).catch(error => { throw normalizeRuntimeError(error); }),
    readManagedTitleAssignment: async ({ childSessionId, directory }) => {
      const check = async () => { assertAvailable(); assertWorkAdmission(); await persistence.verifyOwnership?.(); assertAvailable(); assertWorkAdmission();
        if (!initialized || !ownershipAcquired || shutdownPromise) throw createRuntimeError('native_managed_title_unavailable', 'Managed title owner is unavailable', 403); };
      await check();
      const task = scheduler.getChildAssignment(childSessionId, directory);
      if (!task || task.owner !== 'devryan' || !['starting', 'running', 'completed', 'failed'].includes(task.status)
        || !task.dispatchCallId || !task.dispatchGroupId) throw createRuntimeError('native_managed_title_unavailable', 'Managed title assignment is unavailable', 403);
      const parent = task.parentTaskId ? scheduler.getTask(task.parentTaskId)?.childSessionId : task.rootSessionId;
      if (!parent) throw createRuntimeError('native_managed_title_unavailable', 'Managed title parent is unavailable', 403);
      const tupleFor = task => ({ taskId: task.taskId, rootSessionId: task.rootSessionId, parentSessionId: parent,
        childSessionId, directory, dispatchCallId: task.dispatchCallId, dispatchGroupId: task.dispatchGroupId,
        attempt: task.attempt, sequence: task.sequence, agent: task.agent, providerId: task.providerId,
        modelId: task.modelId, variant: task.variant ?? 'default', readOnly: task.readOnly });
      const tuple = tupleFor(task);
      await check();
      const current = scheduler.getChildAssignment(childSessionId, directory);
      if (!current || !['starting', 'running', 'completed', 'failed'].includes(current.status)
        || JSON.stringify(tupleFor(current)) !== JSON.stringify(tuple)
        || (current.parentTaskId ? scheduler.getTask(current.parentTaskId)?.childSessionId : current.rootSessionId) !== parent)
        throw createRuntimeError('native_managed_title_unavailable', 'Managed title assignment changed', 403);
      return Object.freeze(tuple);
    },
    verifyNativeTaskCatalog: input => verifyNativeTaskCatalog(input).catch(error => { throw normalizeRuntimeError(error); }),
    cancelSessionsForRemoval: async input => {
      assertAvailable();
      await ensureOwnership();
      return scheduler.cancelSessionsForRemoval(input);
    },
    processOpenCodeEvent: (payload, directory = null) => {
      assistantActivity.observe(payload, directory);
      const observed = terminalErrors.observe(payload);
      operatorAborts.observe(payload);
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
    // A user Stop of a managed child: its executor must settle the task as
    // aborted instead of continuing or recovering it automatically.
    async recordOperatorAbort(input) {
      const task = scheduler.getChildAssignment(input.sessionId, input.directory);
      const request = operatorAborts.record({ ...input, ...(task ? { taskId: task.taskId } : {}), requestId: globalThis.crypto.randomUUID(), state: 'pending' });
      if (!request) return null;
      try { return { ...request, ...await scheduler.recordOperatorStop({ ...request, directory: input.directory }) }; }
      catch (error) { operatorAborts.withdraw(request); throw error; }
    },
    async acceptOperatorAbort(input) {
      const accepted = await scheduler.acceptOperatorStop(input);
      return operatorAborts.accept(input) || accepted;
    },
    async withdrawOperatorAbort(input) {
      const removed = await scheduler.withdrawOperatorStop(input);
      return operatorAborts.withdraw(input) || removed;
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
