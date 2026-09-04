import {
  MAX_MANAGED_TASK_FAILURE_BYTES,
  MAX_MANAGED_TASK_PREVIEW_BYTES,
  createManagedTaskRecord,
  isTerminalManagedTaskStatus,
  requiresManualModelRecovery,
  toManagedTaskEvent,
  toManagedTaskRemovalEvent,
  truncateManagedText,
  validateManagedTaskRecord,
} from './contract.js';
import { assertManagedTaskTransition } from './transitions.js';
import {
  assertManagedTaskResultEnvelopeMatchesTask,
  createManagedTaskResultEnvelope,
  validateManagedTaskResultEnvelope,
} from './result-envelope.js';
import {
  DEFAULT_MANAGED_LEDGER_MAX_BYTES,
  DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS,
  DEFAULT_MANAGED_TERMINAL_MAX_RECORDS,
  compactManagedOrchestrationState,
} from './persistence.js';
import {
  MANAGED_TASK_TIMEOUT_REASON_PREFIX,
  isDefiniteProviderUsageLimit,
  isProviderPromptRejected,
} from './provider-retry-policy.js';
import {
  AUTO_RESUME_HOST_RETRY_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  AUTO_RESUME_MAX_HOST_FAILURES,
  buildAutoResumeAcknowledgeParams,
  createLineageId,
  initialAutoResumeState,
  isAutoResumeActive,
  isAutoResumeEligible,
  planAutoResumeAttempt,
  recordProviderRejection,
} from './auto-resume-policy.js';
import {
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE,
  supportsManagedReadOnlyAgent,
} from './provider-capabilities.js';

const ACTIVE_STATUSES = new Set(['starting', 'running']);
const WAITING_REASON_KINDS = new Set(['capacity', 'system_pressure']);
const ADMISSION_RETRY_DEFAULT_MS = 5_000;
const ADMISSION_RETRY_MIN_MS = 1_000;
const ADMISSION_RETRY_MAX_MS = 60_000;
const TERMINAL_RESULT_STATUSES = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const AGENT_HANDOFF_MANUAL_RECOVERY_ABANDON = Symbol('agent-handoff-manual-recovery-abandon');

// A recovery attempt continues work that was sized for the source task's window, so it
// inherits that window instead of silently dropping to the caller's default. Without this a
// task dispatched with a 2h budget gets 30 minutes on every retry and can never finish.
const resolveFollowUpTimeoutAt = (sourceTask, requestedTimeoutAt, now) => {
  const requested = Number.isFinite(requestedTimeoutAt) ? requestedTimeoutAt : null;
  const sourceWindowMs = Number.isFinite(sourceTask.timeoutAt) && Number.isFinite(sourceTask.createdAt)
    ? Math.max(0, sourceTask.timeoutAt - sourceTask.createdAt)
    : null;
  if (sourceWindowMs === null) return requested;
  return Math.max(requested ?? 0, now() + sourceWindowMs);
};

const cloneTask = (task) => task ? {
  ...task,
  waitingReason: task.waitingReason ? { ...task.waitingReason } : null,
  canonicalRefs: task.canonicalRefs.map((reference) => ({ ...reference })),
} : null;

const createDefaultPersistence = () => ({
  async load() {
    return null;
  },
  async save() {
  },
});

const createRandomId = (prefix) => {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}${random.replaceAll('-', '')}`;
};

const idempotencyIndexKey = (rootSessionId, idempotencyKey) => (
  `${rootSessionId}\u0000${idempotencyKey}`
);

/**
 * Window during which an identical in-flight dispatch is collapsed onto the
 * task that is already running. Long enough to cover an orchestrator re-issuing
 * a dispatch over several turns (observed live 2026-08-21: three dispatches of
 * the same task spanning 50s), short enough that a deliberate re-run later in
 * the session is never blocked.
 */
export const DUPLICATE_DISPATCH_WINDOW_MS = 10 * 60 * 1_000;

/**
 * The `idempotencyKey` the plugin builds folds in both `context.messageID` and
 * `dispatchCallId`, so it only ever collapses a literal retry of one tool call.
 * It cannot catch the failure seen in the wild: the orchestrator believing its
 * dispatch did not take effect and re-issuing it — with slightly different
 * wording — in the NEXT assistant message. That produces a different messageID,
 * a different callID and a different prompt hash, so nothing collides and a
 * second subagent runs the same work.
 *
 * Normalizing away the structured scaffolding and formatting leaves a
 * fingerprint stable across those rewordings without being so loose that
 * genuinely different prompts collide.
 */
const dispatchFingerprint = (input) => {
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const normalized = prompt
    .toLowerCase()
    .replace(/^\s*(?:find|scope|goal|task|context|deliverable|report|return)\s*:/gm, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return null;
  return [
    input?.rootSessionId ?? '',
    input?.directory ?? '',
    input?.agent ?? '',
    normalized,
  ].join('\u0000');
};

export const compareManagedTaskQueueOrder = (left, right) => (
  left.sequence - right.sequence
  || left.createdAt - right.createdAt
  || left.taskId.localeCompare(right.taskId)
);

export class ManagedOrchestrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedOrchestrationError';
    this.code = code;
  }
}

const assertManagedReadOnlyAgentSupport = (input) => {
  if (!input.readOnly || supportsManagedReadOnlyAgent(input.agent)) return;
  throw new ManagedOrchestrationError(
    MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
    MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE,
  );
};

export const createManagedTaskScheduler = (options = {}) => {
  const executor = options.executor;
  if (!executor || typeof executor.start !== 'function') {
    throw new TypeError('executor.start is required');
  }

  const persistence = options.persistence ?? createDefaultPersistence();
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.scheduleTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.cancelTimeout ?? globalThis.clearTimeout;
  const abortTimeoutMs = options.abortTimeoutMs ?? 5_000;
  if (!Number.isFinite(abortTimeoutMs) || abortTimeoutMs < 1) {
    throw new RangeError('abortTimeoutMs must be a positive finite number');
  }
  const createTaskId = options.createTaskId ?? (() => createRandomId('dvr_task_'));
  const createLeaseToken = options.createLeaseToken ?? (() => createRandomId('dvr_lease_'));
  const createWaveId = options.createWaveId ?? (() => createRandomId('dvr_wave_'));
  const publishEvent = options.publishEvent ?? (() => undefined);
  const logger = options.logger ?? console;
  const maxTerminalRecords = options.maxTerminalRecords ?? DEFAULT_MANAGED_TERMINAL_MAX_RECORDS;
  const maxHistoryAgeMs = options.maxHistoryAgeMs ?? DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS;
  const maxPersistedBytes = options.maxPersistedBytes ?? DEFAULT_MANAGED_LEDGER_MAX_BYTES;
  const startingLeaseTimeoutMs = options.startingLeaseTimeoutMs ?? 60_000;
  if (!Number.isFinite(startingLeaseTimeoutMs) || startingLeaseTimeoutMs < 1) {
    throw new RangeError('startingLeaseTimeoutMs must be a positive finite number');
  }
  const reconciliationRetryMs = options.reconciliationRetryMs ?? 1_000;
  if (!Number.isFinite(reconciliationRetryMs) || reconciliationRetryMs < 1) {
    throw new RangeError('reconciliationRetryMs must be a positive finite number');
  }
  const providerRecoveryContinuationLeaseMs = options.providerRecoveryContinuationLeaseMs ?? 60_000;
  if (!Number.isFinite(providerRecoveryContinuationLeaseMs) || providerRecoveryContinuationLeaseMs < 1) {
    throw new RangeError('providerRecoveryContinuationLeaseMs must be a positive finite number');
  }
  // Auto-resume is inert unless the host supplies `attempt`: parked envelopes then
  // keep `autoResume: null` and nothing is ever armed.
  const autoResumeOptions = options.autoResume && typeof options.autoResume === 'object'
    ? options.autoResume
    : null;
  const autoResumeAttempt = typeof autoResumeOptions?.attempt === 'function'
    ? autoResumeOptions.attempt
    : null;
  const autoResumeStartupGraceMs = autoResumeOptions?.startupGraceMs ?? 15_000;
  const autoResumeProbeStaggerMs = autoResumeOptions?.probeStaggerMs ?? 60_000;
  const autoResumeDefaultEnabled = autoResumeOptions?.defaultEnabled ?? true;
  if (!Number.isFinite(autoResumeStartupGraceMs) || autoResumeStartupGraceMs < 0) {
    throw new RangeError('autoResume.startupGraceMs must be a non-negative finite number');
  }
  if (!Number.isFinite(autoResumeProbeStaggerMs) || autoResumeProbeStaggerMs < 0) {
    throw new RangeError('autoResume.probeStaggerMs must be a non-negative finite number');
  }
  // Launch admission is inert unless the host supplies `admitLaunch`: every
  // queued task then launches immediately, exactly as before the hook existed.
  const admitLaunch = typeof options.admitLaunch === 'function' ? options.admitLaunch : null;

  const tasks = new Map();
  const resultEnvelopes = new Map();
  const idempotencyIndex = new Map();
  const activeLaunches = new Map();
  const cancellationPromises = new Map();
  const acknowledgementPromises = new Map();
  const handoffLocks = new Map();
  const taskWaiters = new Map();
  const resultActionWaiters = new Map();
  const timeoutTimers = new Map();
  const startingLeaseTimers = new Map();
  const reconciliationRetryTimers = new Map();
  const providerRecoveryContinuationClaims = new Map();
  const autoResumeTimers = new Map();
  // breakerKey(providerId, ownerKey) → { until, source, probing: { taskId, since } | null }
  const providerBreakers = new Map();
  const autoResumeOwnerKeys = new Map();
  let initialized = false;
  let initializePromise = null;
  let mutationTail = Promise.resolve();
  let publicationTail = Promise.resolve();
  let recovering = false;
  let compactedTaskCount = 0;
  let lastSerializedBytes = 0;
  let shutDown = false;
  let shutdownPromise = null;
  let admissionRetryTimer = null;
  let admissionRetryDueAt = null;
  let admissionHeldCount = 0;

  const unrefTimer = (timer) => {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };

  const runExclusive = (operation) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.catch(() => undefined);
    return result;
  };

  const snapshotLocked = () => ({
    version: 1,
    tasks: [...tasks.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId))
      .map(cloneTask),
    resultEnvelopes: [...resultEnvelopes.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((envelope) => structuredClone(envelope)),
  });

  const publishManagedEvent = async (event) => {
    try {
      await publishEvent(event);
    } catch (error) {
      logger.warn?.('[ManagedOrchestration] Failed to publish task event', {
        taskId: event.properties.task?.taskId ?? event.properties.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const queueTaskPublication = (task) => {
    const event = toManagedTaskEvent(task, resultEnvelopes.get(task.taskId) ?? null);
    publicationTail = publicationTail.then(
      () => publishManagedEvent(event),
      () => publishManagedEvent(event),
    );
  };

  const queueTaskRemovalPublication = (task) => {
    const event = toManagedTaskRemovalEvent(task);
    publicationTail = publicationTail.then(
      () => publishManagedEvent(event),
      () => publishManagedEvent(event),
    );
  };

  const persistLocked = async () => {
    const compaction = compactManagedOrchestrationState(snapshotLocked(), {
      now: now(),
      maxTerminalRecords,
      maxAgeMs: maxHistoryAgeMs,
      maxBytes: maxPersistedBytes,
      // snapshotLocked() already deep-copies; skip the compactor's own clone.
      assumeOwnedInput: true,
    });
    if (compaction.overLimit) {
      throw new ManagedOrchestrationError(
        'ledger_capacity_exceeded',
        `managed orchestration ledger cannot fit within ${maxPersistedBytes} bytes without removing protected work`,
      );
    }
    await persistence.save(compaction.state);
    lastSerializedBytes = compaction.serializedBytes;
    for (const taskId of compaction.removedTaskIds) {
      const removedTask = tasks.get(taskId);
      if (removedTask) {
        idempotencyIndex.delete(idempotencyIndexKey(removedTask.rootSessionId, removedTask.idempotencyKey));
        queueTaskRemovalPublication(removedTask);
      }
      tasks.delete(taskId);
      resultEnvelopes.delete(taskId);
      providerRecoveryContinuationClaims.delete(taskId);
      clearTaskTimeout(taskId);
      clearReconciliationRetry(taskId);
      clearAutoResumeTimer(taskId);
      compactedTaskCount += 1;
    }
  };

  const commitNewTaskLocked = async (task) => {
    tasks.set(task.taskId, task);
    idempotencyIndex.set(idempotencyIndexKey(task.rootSessionId, task.idempotencyKey), task.taskId);
    try {
      await persistLocked();
    } catch (error) {
      tasks.delete(task.taskId);
      idempotencyIndex.delete(idempotencyIndexKey(task.rootSessionId, task.idempotencyKey));
      throw error;
    }
    queueTaskPublication(task);
  };

  const commitTaskUpdateLocked = async (previous, next) => {
    assertManagedTaskTransition(previous, next);
    tasks.set(next.taskId, next);
    try {
      await persistLocked();
    } catch (error) {
      tasks.set(previous.taskId, previous);
      throw error;
    }
    queueTaskPublication(next);
  };

  const nextResultSequenceLocked = () => {
    let sequence = 0;
    for (const envelope of resultEnvelopes.values()) {
      sequence = Math.max(sequence, envelope.sequence);
    }
    return sequence + 1;
  };

  const notifyTaskWaiters = (task) => {
    const waiters = taskWaiters.get(task.taskId);
    if (!waiters || waiters.size === 0) return;
    taskWaiters.delete(task.taskId);
    for (const waiter of waiters) waiter.resolve(cloneTask(task));
  };

  const notifyResultActionWaiters = (envelope) => {
    if (envelope.action === null) return;
    const waiters = resultActionWaiters.get(envelope.taskId);
    if (!waiters || waiters.size === 0) return;
    resultActionWaiters.delete(envelope.taskId);
    for (const waiter of waiters) waiter.resolve(structuredClone(envelope));
  };

  const clearTaskTimeout = (taskId) => {
    const timer = timeoutTimers.get(taskId);
    if (timer === undefined) return;
    timeoutTimers.delete(taskId);
    cancelTimeout(timer);
  };

  const clearStartingLease = (taskId) => {
    const timer = startingLeaseTimers.get(taskId);
    if (timer === undefined) return;
    startingLeaseTimers.delete(taskId);
    cancelTimeout(timer);
  };

  const clearReconciliationRetry = (taskId) => {
    const timer = reconciliationRetryTimers.get(taskId);
    if (timer === undefined) return;
    reconciliationRetryTimers.delete(taskId);
    cancelTimeout(timer);
  };

  const clearAutoResumeTimer = (taskId) => {
    const timer = autoResumeTimers.get(taskId);
    if (timer === undefined) return;
    autoResumeTimers.delete(taskId);
    cancelTimeout(timer);
  };

  const armAutoResumeTimer = (taskId, delayMs, step) => {
    clearAutoResumeTimer(taskId);
    if (shutDown) return;
    const timer = unrefTimer(scheduleTimeout(() => {
      autoResumeTimers.delete(taskId);
      if (shutDown) return;
      void step().catch((error) => {
        logger.warn?.('[ManagedOrchestration] Auto-resume step failed', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, Math.max(0, delayMs)));
    autoResumeTimers.set(taskId, timer);
  };

  const scheduleAutoResumePlanning = (taskId, generation, delayMs) => {
    armAutoResumeTimer(taskId, delayMs, () => planAutoResume(taskId, generation));
  };

  const scheduleAutoResumeAttempt = (taskId, generation, at) => {
    armAutoResumeTimer(taskId, at - now(), () => runAutoResumeAttempt(taskId, generation));
  };

  // Provider breakers are keyed by provider AND owner (the host's account/quota
  // identity) so one user's exhausted quota never parks another user's work.
  const ownerKeyFor = (rootSessionId) => autoResumeOwnerKeys.get(rootSessionId) ?? '';

  const resolveAutoResumeOwnerKey = async (rootSessionId) => {
    if (autoResumeOwnerKeys.has(rootSessionId)) return autoResumeOwnerKeys.get(rootSessionId);
    let ownerKey = '';
    try {
      const resolved = typeof autoResumeOptions?.resolveOwnerKey === 'function'
        ? await autoResumeOptions.resolveOwnerKey({ rootSessionId })
        : '';
      ownerKey = typeof resolved === 'string' ? resolved : '';
    } catch (error) {
      logger.warn?.('[ManagedOrchestration] Failed to resolve auto-resume owner key', {
        rootSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
    autoResumeOwnerKeys.set(rootSessionId, ownerKey);
    return ownerKey;
  };

  const resolveAutoResumeHook = async (name, input) => {
    const hook = autoResumeOptions?.[name];
    if (typeof hook !== 'function') return null;
    try {
      return await hook(input) ?? null;
    } catch (error) {
      logger.warn?.(`[ManagedOrchestration] Auto-resume ${name} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const BREAKER_KEY_SEPARATOR = String.fromCharCode(0);
  const breakerKey = (providerId, ownerKey) => `${providerId}${BREAKER_KEY_SEPARATOR}${ownerKey}`;

  const getProviderBreakerLocked = (providerId, ownerKey) => (
    providerBreakers.get(breakerKey(providerId, ownerKey)) ?? null
  );

  const pruneProviderBreakerLocked = (providerId, ownerKey) => {
    const key = breakerKey(providerId, ownerKey);
    const breaker = providerBreakers.get(key);
    if (breaker && !breaker.probing && (breaker.until === null || breaker.until <= now())) {
      providerBreakers.delete(key);
    }
  };

  const breakerUntilLocked = (providerId, ownerKey) => {
    const breaker = getProviderBreakerLocked(providerId, ownerKey);
    if (!breaker || breaker.until === null || breaker.until <= now()) return null;
    return { until: breaker.until, source: breaker.source };
  };

  // Conservative: a later reported reset extends the breaker, an earlier one never
  // shortens it. The plan may still probe at the earliest known reset; the
  // breaker then simply re-arms that probe at its own `until`.
  const markProviderLimitedLocked = (providerId, ownerKey, { until = null, source = null } = {}) => {
    const key = breakerKey(providerId, ownerKey);
    const nextUntil = Number.isFinite(until) && until > now() ? until : null;
    const existing = providerBreakers.get(key);
    if (!existing) {
      // Without a reset there is nothing to enforce; probes stagger through the
      // entry created when an attempt actually starts.
      if (nextUntil === null) return;
      providerBreakers.set(key, { until: nextUntil, source, probing: null });
      return;
    }
    if (nextUntil !== null && (existing.until === null || nextUntil > existing.until)) {
      existing.until = nextUntil;
      existing.source = source;
    }
  };

  const clearProviderBreakerLocked = (providerId, ownerKey) => {
    providerBreakers.delete(breakerKey(providerId, ownerKey));
  };

  const setProviderProbeLocked = (providerId, ownerKey, probe) => {
    const key = breakerKey(providerId, ownerKey);
    const existing = providerBreakers.get(key);
    if (existing) {
      existing.probing = probe;
      return;
    }
    providerBreakers.set(key, { until: null, source: null, probing: probe });
  };

  const clearProviderProbeLocked = (providerId, ownerKey, taskId) => {
    const breaker = getProviderBreakerLocked(providerId, ownerKey);
    if (breaker?.probing?.taskId === taskId) breaker.probing = null;
    pruneProviderBreakerLocked(providerId, ownerKey);
  };

  const commitTerminalTaskLocked = async (previous, next, { resumable = false, providerResetAt = null } = {}) => {
    assertManagedTaskTransition(previous, next);
    const existingEnvelope = resultEnvelopes.get(next.taskId);
    const envelope = existingEnvelope ?? createManagedTaskResultEnvelope(next, {
      sequence: nextResultSequenceLocked(),
      createdAt: next.finishedAt ?? now(),
      resumable,
      providerResetAt,
    });
    tasks.set(next.taskId, next);
    resultEnvelopes.set(next.taskId, envelope);
    try {
      await persistLocked();
    } catch (error) {
      tasks.set(previous.taskId, previous);
      if (!existingEnvelope) resultEnvelopes.delete(next.taskId);
      throw error;
    }
    clearTaskTimeout(next.taskId);
    clearStartingLease(next.taskId);
    clearReconciliationRetry(next.taskId);
    if (tasks.has(next.taskId)) queueTaskPublication(next);
    notifyTaskWaiters(next);
  };

  const commitEnvelopeUpdateLocked = async (previous, next) => {
    validateManagedTaskResultEnvelope(next);
    if (previous.taskId !== next.taskId || previous.envelopeId !== next.envelopeId) {
      throw new ManagedOrchestrationError('result_identity_changed', 'result envelope identity is immutable');
    }
    resultEnvelopes.set(next.taskId, next);
    try {
      await persistLocked();
    } catch (error) {
      resultEnvelopes.set(previous.taskId, previous);
      throw error;
    }
    const task = tasks.get(next.taskId);
    if (task) queueTaskPublication(task);
    notifyResultActionWaiters(next);
  };

  const getActiveModeForRootLocked = (rootSessionId) => {
    for (const task of tasks.values()) {
      if (task.rootSessionId === rootSessionId && !isTerminalManagedTaskStatus(task.status)) {
        return task.mode;
      }
    }
    return null;
  };

  const validateAgentHandoffScope = (input, { requireIdempotencyKey = false } = {}) => {
    if (!input || typeof input !== 'object') {
      throw new ManagedOrchestrationError('invalid_handoff_scope', 'handoff scope is required');
    }
    if (typeof input.rootSessionId !== 'string' || !input.rootSessionId.trim()) {
      throw new ManagedOrchestrationError('missing_root_session_id', 'rootSessionId is required');
    }
    if (input.fromMode !== 'orchestrator' || input.toMode !== 'builder') {
      throw new ManagedOrchestrationError(
        'invalid_handoff_scope',
        'only orchestrator-to-builder handoff is supported',
      );
    }
    if (
      requireIdempotencyKey
      && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim())
    ) {
      throw new ManagedOrchestrationError(
        'missing_idempotency_key',
        'handoff idempotencyKey is required',
      );
    }
  };

  const getDispatchBarrierStateLocked = (rootSessionId) => {
    const groupedTasks = [...tasks.values()]
      .filter((task) => (
        task.rootSessionId === rootSessionId
        && task.dispatchGroupId !== null
      ))
      .sort(compareManagedTaskQueueOrder);
    const lockedGroupIds = new Set();

    for (const task of groupedTasks) {
      const envelope = resultEnvelopes.get(task.taskId);
      if (!isTerminalManagedTaskStatus(task.status) || !envelope || envelope.action === null) {
        lockedGroupIds.add(task.dispatchGroupId);
      }
    }

    if (lockedGroupIds.size === 0) {
      return { state: 'clear', taskIds: [] };
    }

    const activeTaskIds = groupedTasks
      .filter((task) => (
        lockedGroupIds.has(task.dispatchGroupId)
        && !isTerminalManagedTaskStatus(task.status)
      ))
      .map((task) => task.taskId);
    if (activeTaskIds.length > 0) {
      return { state: 'active', taskIds: activeTaskIds };
    }

    return {
      state: 'awaiting_acknowledgement',
      taskIds: groupedTasks
        .filter((task) => {
          if (!lockedGroupIds.has(task.dispatchGroupId)) return false;
          const envelope = resultEnvelopes.get(task.taskId);
          return !envelope || envelope.action === null;
        })
        .map((task) => task.taskId),
    };
  };

  const latestDispatchWaveIdLocked = (rootSessionId) => {
    let latest = null;
    for (const task of tasks.values()) {
      if (task.rootSessionId !== rootSessionId || task.dispatchWaveId === null) continue;
      if (!latest || task.sequence > latest.sequence) latest = task;
    }
    return latest?.dispatchWaveId ?? null;
  };

  /**
   * Display-only label naming the parallel dispatch wave a grouped task belongs
   * to. A wave opens with the first grouped start after the root's barrier last
   * cleared; every start while that barrier is still locked (any wave task
   * non-terminal or unacknowledged) joins it. Follow-ups inherit their prior's
   * wave so lineage stays in one card. The label is read from barrier state
   * that `submit` already holds; it never admits, holds, retries, or times
   * anything.
   */
  const resolveDispatchWaveIdLocked = (input) => {
    if (typeof input.dispatchWaveId === 'string') return input.dispatchWaveId;
    if (input.priorTaskId) {
      const prior = tasks.get(input.priorTaskId);
      if (prior) return prior.dispatchWaveId;
    }
    if (input.dispatchGroupId === null || input.dispatchGroupId === undefined) return null;
    if (getDispatchBarrierStateLocked(input.rootSessionId).state === 'clear') return createWaveId();
    return latestDispatchWaveIdLocked(input.rootSessionId) ?? createWaveId();
  };

  const collectAgentHandoffTaskIdsLocked = (rootSessionId) => (
    [...tasks.values()]
      .filter((task) => {
        if (
          task.rootSessionId !== rootSessionId
          || task.mode !== 'orchestrator'
          || task.dispatchGroupId === null
        ) {
          return false;
        }
        const envelope = resultEnvelopes.get(task.taskId);
        return !isTerminalManagedTaskStatus(task.status) || !envelope || envelope.action === null;
      })
      .sort(compareManagedTaskQueueOrder)
      .map((task) => task.taskId)
  );

  const nextSequenceLocked = () => {
    let sequence = 0;
    for (const task of tasks.values()) {
      sequence = Math.max(sequence, task.sequence);
    }
    return sequence + 1;
  };

  const finishTask = async (taskId, leaseToken, result, fallbackStatus = 'failed') => {
    if (shutDown) return;
    let changed = false;
    await runExclusive(async () => {
      const previous = tasks.get(taskId);
      if (!previous || isTerminalManagedTaskStatus(previous.status)) return;
      if (previous.leaseToken !== leaseToken) return;

      let status = TERMINAL_RESULT_STATUSES.has(result?.status) ? result.status : fallbackStatus;
      let failureReason = typeof result?.failureReason === 'string' && result.failureReason.trim()
        ? truncateManagedText(result.failureReason, MAX_MANAGED_TASK_FAILURE_BYTES)
        : null;
      if (previous.status === 'starting' && status === 'completed') {
        status = 'interrupted';
        failureReason = 'Executor completed before provider acceptance was recorded';
      }

      const next = {
        ...previous,
        status,
        finishedAt: now(),
        failureReason,
        partial: Boolean(result?.partial),
        recoverablePreview: typeof result?.recoverablePreview === 'string'
          ? truncateManagedText(result.recoverablePreview, MAX_MANAGED_TASK_PREVIEW_BYTES)
          : '',
        canonicalRefs: Array.isArray(result?.canonicalRefs)
          ? result.canonicalRefs.map((reference) => ({ ...reference }))
          : [],
      };
      await commitTerminalTaskLocked(previous, next, {
        resumable: Boolean(result?.resumable),
        providerResetAt: Number.isFinite(result?.providerResetAt) ? result.providerResetAt : null,
      });
      changed = true;
      try {
        await parkAutoResumeLocked(next);
      } catch (error) {
        logger.warn?.('[ManagedOrchestration] Failed to record auto-resume state', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    if (changed && !recovering) await pump();
  };

  const createTaskControl = (taskId, leaseToken) => ({
    async setChildSessionId(childSessionId) {
      if (shutDown) return false;
      return await runExclusive(async () => {
        const previous = tasks.get(taskId);
        if (!previous || isTerminalManagedTaskStatus(previous.status)) return false;
        if (previous.leaseToken !== leaseToken) return false;
        if (previous.childSessionId && previous.childSessionId !== childSessionId) {
          throw new ManagedOrchestrationError(
            'child_session_conflict',
            `task ${taskId} already owns child session ${previous.childSessionId}`,
          );
        }
        if (previous.childSessionId === childSessionId) return true;
        const next = { ...previous, childSessionId };
        await commitTaskUpdateLocked(previous, next);
        return true;
      });
    },
    async markAccepted() {
      if (shutDown) return false;
      return await runExclusive(async () => {
        const previous = tasks.get(taskId);
        if (!previous || previous.leaseToken !== leaseToken) return false;
        if (previous.status === 'running') return true;
        if (isTerminalManagedTaskStatus(previous.status)) return false;
        if (previous.status !== 'starting') {
          throw new ManagedOrchestrationError(
            'invalid_acceptance_state',
            `task ${taskId} cannot record provider acceptance from ${previous.status}`,
          );
        }
        const next = { ...previous, status: 'running' };
        await commitTaskUpdateLocked(previous, next);
        clearStartingLease(taskId);
        return true;
      });
    },
    async recordProgress(progress = {}) {
      if (shutDown) return false;
      return await runExclusive(async () => {
        const previous = tasks.get(taskId);
        if (!previous || isTerminalManagedTaskStatus(previous.status)) return false;
        if (previous.leaseToken !== leaseToken) return false;
        const next = { ...previous };
        let changed = false;
        for (const field of ['childPromptedAt', 'firstAssistantPartAt']) {
          const value = progress?.[field];
          if (previous[field] !== null || !Number.isFinite(value) || value < 0) continue;
          next[field] = value;
          changed = true;
        }
        if (changed) await commitTaskUpdateLocked(previous, next);
        return true;
      });
    },
  });

  // The execution the auto-resume lineage started on: walk back through the
  // auto follow-ups only, so a manual retry (which restarts the budget) becomes
  // the new origin for the attempts that follow it.
  const resolveAutoResumeOriginLocked = (task) => {
    let current = task;
    const seen = new Set([task.taskId]);
    while (current.priorTaskId && !seen.has(current.priorTaskId)) {
      const prior = tasks.get(current.priorTaskId);
      const priorState = resultEnvelopes.get(current.priorTaskId)?.autoResume ?? null;
      if (!prior || !priorState || priorState.lastAttemptTaskId !== current.taskId) break;
      seen.add(prior.taskId);
      current = prior;
    }
    return { providerId: current.providerId, modelId: current.modelId, variant: current.variant };
  };

  const autoResumeAttemptKey = (taskId, state) => (
    `auto-resume:${taskId}:${state.cancelGeneration}:${state.attemptCount}`
  );

  const commitAutoResumeStateLocked = async (envelope, patch) => {
    const state = envelope.autoResume;
    const next = { ...state, ...patch, revision: state.revision + 1 };
    await commitEnvelopeUpdateLocked(envelope, { ...envelope, autoResume: next });
    return next;
  };

  const commitAutoResumeExhaustedLocked = async (envelope, reason) => {
    clearAutoResumeTimer(envelope.taskId);
    return await commitAutoResumeStateLocked(envelope, {
      state: 'exhausted',
      reason,
      nextAttemptAt: null,
      target: null,
    });
  };

  const disableAutoResumeLocked = async (task, envelope, reason) => {
    const state = envelope.autoResume;
    if (state?.target) {
      clearProviderProbeLocked(state.target.providerId, ownerKeyFor(task.rootSessionId), task.taskId);
    }
    clearAutoResumeTimer(task.taskId);
    const base = state ?? initialAutoResumeState({
      now: now(),
      enabled: false,
      providerResetAt: envelope.providerResetAt,
    });
    const next = {
      ...base,
      enabled: false,
      state: 'cancelled',
      reason,
      cancelGeneration: base.cancelGeneration + (state ? 1 : 0),
      nextAttemptAt: null,
      revision: state ? state.revision + 1 : 1,
    };
    await commitEnvelopeUpdateLocked(envelope, { ...envelope, autoResume: next });
    return next;
  };

  // Called under the lock right after a task settles. Settles the prior attempt's
  // state when this task was an automatic follow-up, keeps the provider breaker
  // honest, and parks the task itself when it is eligible.
  const parkAutoResumeLocked = async (task, { planningDelayMs = 0 } = {}) => {
    if (!autoResumeAttempt) return;
    const envelope = resultEnvelopes.get(task.taskId);
    if (!envelope || envelope.autoResume !== null) return;
    const ownerKey = ownerKeyFor(task.rootSessionId);
    const priorEnvelope = task.priorTaskId ? resultEnvelopes.get(task.priorTaskId) ?? null : null;
    const priorState = priorEnvelope?.autoResume ?? null;
    // `superseded` covers a restart between the prior's settlement and this park.
    const continuesAutoAttempt = Boolean(
      priorState
      && (priorState.state === 'attempting' || priorState.state === 'superseded')
      && (
        priorState.lastAttemptTaskId === task.taskId
        || (
          priorState.lastAttemptTaskId === null
          && task.idempotencyKey === autoResumeAttemptKey(priorEnvelope.taskId, priorState)
        )
      ),
    );
    const eligible = isAutoResumeEligible(task, envelope);
    if (continuesAutoAttempt) {
      if (task.status === 'completed' || task.firstAssistantPartAt !== null) {
        clearProviderBreakerLocked(task.providerId, ownerKey);
      } else if (isDefiniteProviderUsageLimit(task.failureReason)) {
        markProviderLimitedLocked(task.providerId, ownerKey, {
          until: envelope.providerResetAt,
          source: 'opencode_status',
        });
        clearProviderProbeLocked(task.providerId, ownerKey, task.taskId);
      } else {
        clearProviderProbeLocked(task.providerId, ownerKey, task.taskId);
      }
      clearAutoResumeTimer(priorEnvelope.taskId);
      // The prior's acknowledgement is normally recorded by the attempt itself;
      // heal it here when the follow-up settled first (restart recovery, or a
      // follow-up that finished before the acknowledgement commit ran).
      const acknowledgement = priorEnvelope.action === null
        ? { acknowledgedAt: now(), action: 'retry_in_place', followUpTaskId: task.taskId }
        : {};
      await commitEnvelopeUpdateLocked(priorEnvelope, {
        ...priorEnvelope,
        ...acknowledgement,
        autoResume: {
          ...priorState,
          state: task.status === 'completed' ? 'succeeded' : (eligible ? 'superseded' : 'ended'),
          lastAttemptTaskId: task.taskId,
          nextAttemptAt: null,
          revision: priorState.revision + 1,
        },
      });
      providerRecoveryContinuationClaims.delete(priorEnvelope.taskId);
    }
    if (!eligible) return;

    const at = now();
    const origin = resolveAutoResumeOriginLocked(task);
    // The reset hint only describes the provider that just rejected the task. When
    // that was the backup, the lineage keeps what it knew about the origin.
    const originReset = task.providerId === origin.providerId
      ? envelope.providerResetAt
      : (continuesAutoAttempt ? priorState.resetAt : null);
    const initial = initialAutoResumeState({
      now: at,
      enabled: priorState ? priorState.enabled : autoResumeDefaultEnabled,
      providerResetAt: originReset,
      prior: continuesAutoAttempt ? { ...priorState, lastAttemptTaskId: task.taskId } : null,
      taskId: task.taskId,
    });
    const state = recordProviderRejection(initial, { now: at, providerResetAt: originReset });
    await commitEnvelopeUpdateLocked(envelope, {
      ...envelope,
      autoResume: { ...state, state: 'planning', revision: 1 },
    });
    if (state.enabled) scheduleAutoResumePlanning(task.taskId, state.cancelGeneration, planningDelayMs);
  };

  const planAutoResume = async (taskId, generation) => {
    if (shutDown || !autoResumeAttempt) return;
    const task = tasks.get(taskId);
    const envelope = resultEnvelopes.get(taskId);
    if (
      !task
      || !envelope
      || !isAutoResumeActive(envelope)
      || envelope.autoResume.cancelGeneration !== generation
    ) {
      return;
    }
    // Host lookups run outside the lock; every answer is re-validated under it.
    const origin = resolveAutoResumeOriginLocked(task);
    const ownerKey = await resolveAutoResumeOwnerKey(task.rootSessionId);
    const backup = await resolveAutoResumeHook('resolveBackupExecution', {
      rootSessionId: task.rootSessionId,
      directory: task.directory,
      agent: task.agent,
      providerId: origin.providerId,
      modelId: origin.modelId,
    });
    const providerReset = await resolveAutoResumeHook('resolveProviderReset', {
      providerId: origin.providerId,
      ownerKey,
      directory: task.directory,
      rootSessionId: task.rootSessionId,
    });
    await runExclusive(async () => {
      if (shutDown) return;
      const current = tasks.get(taskId);
      const previous = resultEnvelopes.get(taskId);
      if (!current || !previous || previous.action !== null || !isAutoResumeActive(previous)) return;
      const state = previous.autoResume;
      if (
        state.cancelGeneration !== generation
        || (state.state !== 'planning' && state.state !== 'scheduled')
      ) {
        return;
      }
      const at = now();
      markProviderLimitedLocked(origin.providerId, ownerKey, {
        until: state.resetAt,
        source: state.resetSource ?? 'opencode_status',
      });
      if (providerReset && providerReset.limited !== false && Number.isFinite(providerReset.resetAt)) {
        markProviderLimitedLocked(origin.providerId, ownerKey, {
          until: providerReset.resetAt,
          source: 'meridian_quota',
        });
      }
      const plan = planAutoResumeAttempt({
        now: at,
        task: current,
        state,
        backup,
        breakerUntil: (providerId) => breakerUntilLocked(providerId, ownerKey),
        providerReset,
        origin,
      });
      if (plan.state !== 'scheduled') {
        await commitAutoResumeExhaustedLocked(previous, plan.reason);
        return;
      }
      await commitAutoResumeStateLocked(previous, {
        state: 'scheduled',
        nextAttemptAt: plan.nextAttemptAt,
        target: plan.target,
        resetAt: plan.resetAt ?? null,
        resetSource: plan.resetSource ?? null,
        reason: null,
      });
      scheduleAutoResumeAttempt(taskId, generation, plan.nextAttemptAt);
    });
  };

  const runAutoResumeAttempt = async (taskId, generation) => {
    if (shutDown || !autoResumeAttempt) return;
    let params = null;
    let ownerKey = '';
    let targetProviderId = null;
    await runExclusive(async () => {
      if (shutDown) return;
      const task = tasks.get(taskId);
      const previous = resultEnvelopes.get(taskId);
      if (!task || !previous || previous.action !== null || !isAutoResumeActive(previous)) return;
      const state = previous.autoResume;
      if (state.cancelGeneration !== generation || state.state !== 'scheduled' || !state.target) return;
      const at = now();
      ownerKey = ownerKeyFor(task.rootSessionId);
      targetProviderId = state.target.providerId;
      const rearmAt = async (nextAttemptAt) => {
        await commitAutoResumeStateLocked(previous, { nextAttemptAt });
        scheduleAutoResumeAttempt(taskId, generation, nextAttemptAt);
      };
      const breaker = getProviderBreakerLocked(targetProviderId, ownerKey);
      if (breaker && breaker.until !== null && breaker.until > at) {
        await rearmAt(breaker.until);
        return;
      }
      if (
        breaker?.probing
        && breaker.probing.taskId !== taskId
        && at - breaker.probing.since < autoResumeProbeStaggerMs
      ) {
        await rearmAt(breaker.probing.since + autoResumeProbeStaggerMs);
        return;
      }
      if (state.attemptCount >= AUTO_RESUME_MAX_ATTEMPTS) {
        await commitAutoResumeExhaustedLocked(previous, 'attempt_cap');
        return;
      }
      if (at >= state.expiresAt) {
        await commitAutoResumeExhaustedLocked(previous, 'time_cap');
        return;
      }
      await commitAutoResumeStateLocked(previous, {
        state: 'attempting',
        attemptCount: state.attemptCount + 1,
        lastAttemptAt: at,
        nextAttemptAt: null,
      });
      setProviderProbeLocked(targetProviderId, ownerKey, { taskId, since: at });
      params = buildAutoResumeAcknowledgeParams({ task, envelope: resultEnvelopes.get(taskId) });
    });
    if (!params) return;

    let outcome;
    try {
      outcome = await autoResumeAttempt(params);
    } catch (error) {
      outcome = {
        outcome: 'rejected',
        code: 'attempt_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    await runExclusive(async () => {
      if (shutDown) return;
      const previous = resultEnvelopes.get(taskId);
      const state = previous?.autoResume;
      if (!previous || !state || state.cancelGeneration !== generation) return;
      if (outcome?.outcome === 'started' && previous.action !== null) return;
      if (state.state !== 'attempting') return;
      const at = now();
      clearProviderProbeLocked(targetProviderId, ownerKey, taskId);
      if (outcome?.outcome === 'deferred') {
        const retryAfterMs = Number.isFinite(outcome.retryAfterMs)
          ? Math.max(0, outcome.retryAfterMs)
          : AUTO_RESUME_HOST_RETRY_MS;
        const nextAttemptAt = at + retryAfterMs;
        await commitAutoResumeStateLocked(previous, {
          state: 'scheduled',
          attemptCount: Math.max(0, state.attemptCount - 1),
          nextAttemptAt,
        });
        scheduleAutoResumeAttempt(taskId, generation, nextAttemptAt);
        return;
      }
      // Rejected, threw, or claimed `started` without acknowledging the result.
      const lastError = {
        code: outcome?.outcome === 'started'
          ? 'attempt_unacknowledged'
          : (typeof outcome?.code === 'string' && outcome.code ? outcome.code : 'attempt_rejected'),
        message: typeof outcome?.message === 'string'
          ? outcome.message
          : 'Auto-resume attempt was rejected by the host',
        at,
      };
      const hostFailures = state.hostFailures + 1;
      if (hostFailures >= AUTO_RESUME_MAX_HOST_FAILURES) {
        clearAutoResumeTimer(taskId);
        await commitAutoResumeStateLocked(previous, {
          state: 'exhausted',
          reason: 'host_failures',
          attemptCount: Math.max(0, state.attemptCount - 1),
          hostFailures,
          lastError,
          nextAttemptAt: null,
        });
        return;
      }
      const nextAttemptAt = at + AUTO_RESUME_HOST_RETRY_MS;
      await commitAutoResumeStateLocked(previous, {
        state: 'scheduled',
        attemptCount: Math.max(0, state.attemptCount - 1),
        hostFailures,
        lastError,
        nextAttemptAt,
      });
      scheduleAutoResumeAttempt(taskId, generation, nextAttemptAt);
    });
  };

  const launchTask = (task) => {
    if (activeLaunches.has(task.taskId)) return;
    const leaseToken = task.leaseToken;
    const control = createTaskControl(task.taskId, leaseToken);
    const launch = (async () => {
      try {
        const method = task.executionKind === 'resume'
          ? executor.resume
          : task.executionKind === 'retry_in_place' || task.executionKind === 'recover_in_place'
            ? executor.retryInPlace
            : executor.start;
        if (typeof method !== 'function') {
          const methodName = task.executionKind === 'resume'
            ? 'resume'
            : task.executionKind === 'retry_in_place' || task.executionKind === 'recover_in_place'
              ? 'retryInPlace'
              : 'start';
          throw new Error(`executor.${methodName} is required`);
        }
        const result = await method(cloneTask(task), control);
        await finishTask(task.taskId, leaseToken, result, 'failed');
      } catch (error) {
        await finishTask(task.taskId, leaseToken, {
          status: 'failed',
          failureReason: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    activeLaunches.set(task.taskId, launch);
    void launch.then(
      () => activeLaunches.delete(task.taskId),
      () => activeLaunches.delete(task.taskId),
    );
  };

  const observeRecoveredTask = (task) => {
    if (activeLaunches.has(task.taskId)) return;
    const leaseToken = task.leaseToken;
    const control = createTaskControl(task.taskId, leaseToken);
    const observation = (async () => {
      try {
        if (typeof executor.observe !== 'function') {
          throw new Error('executor.observe is required to recover a live child session');
        }
        const result = await executor.observe(cloneTask(task), control);
        await finishTask(task.taskId, leaseToken, result, 'interrupted');
      } catch (error) {
        await finishTask(task.taskId, leaseToken, {
          status: 'interrupted',
          failureReason: error instanceof Error ? error.message : String(error),
        }, 'interrupted');
      }
    })();
    activeLaunches.set(task.taskId, observation);
    void observation.then(
      () => activeLaunches.delete(task.taskId),
      () => activeLaunches.delete(task.taskId),
    );
  };

  const readRecovery = async (task) => {
    try {
      return await executor.readRecoverableResult(cloneTask(task)) ?? {};
    } catch (error) {
      logger.warn?.('[ManagedOrchestration] Failed to read recoverable task result', {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  };

  const recoverTask = async (task) => {
    let reconciliation;
    try {
      reconciliation = await executor.reconcile(cloneTask(task));
    } catch (error) {
      reconciliation = {
        state: 'unavailable',
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }

    if (reconciliation?.state === 'terminal') {
      const result = reconciliation.result ?? { status: 'interrupted' };
      if (task.status === 'starting' && result.status === 'completed') {
        await createTaskControl(task.taskId, task.leaseToken).markAccepted();
      }
      await finishTask(task.taskId, task.leaseToken, result, 'interrupted');
      return;
    }

    if (reconciliation?.state === 'relaunch') {
      const current = tasks.get(task.taskId);
      if (current && !isTerminalManagedTaskStatus(current.status)) {
        launchTask(cloneTask(current));
      }
      return;
    }

    if (reconciliation?.state === 'live') {
      if (task.status === 'starting') {
        await createTaskControl(task.taskId, task.leaseToken).markAccepted();
      }
      const current = tasks.get(task.taskId);
      if (current && !isTerminalManagedTaskStatus(current.status)) {
        observeRecoveredTask(cloneTask(current));
      }
      return;
    }

    if (reconciliation?.state === 'transient') {
      const current = tasks.get(task.taskId);
      if (
        current
        && !isTerminalManagedTaskStatus(current.status)
        && current.leaseToken === task.leaseToken
      ) {
        scheduleReconciliationRetry(current);
      }
      return;
    }

    const recovery = reconciliation?.recovery ?? await readRecovery(task);
    const recoverablePreview = typeof recovery?.recoverablePreview === 'string'
      ? recovery.recoverablePreview
      : '';
    const canonicalRefs = Array.isArray(recovery?.canonicalRefs)
      ? recovery.canonicalRefs.map((reference) => ({ ...reference }))
      : [];
    await finishTask(task.taskId, task.leaseToken, {
      status: 'interrupted',
      failureReason: reconciliation?.failureReason
        || 'Child session ownership could not be recovered after restart',
      partial: typeof recovery?.partial === 'boolean'
        ? recovery.partial
        : Boolean(recoverablePreview || canonicalRefs.length > 0),
      recoverablePreview,
      canonicalRefs,
      resumable: Boolean(recovery?.resumable),
    }, 'interrupted');
  };

  const scheduleReconciliationRetry = (task) => {
    if (shutDown || !ACTIVE_STATUSES.has(task.status)) return;
    if (reconciliationRetryTimers.has(task.taskId)) return;
    const leaseToken = task.leaseToken;
    const timer = unrefTimer(scheduleTimeout(() => {
      reconciliationRetryTimers.delete(task.taskId);
      if (shutDown) return;
      const current = tasks.get(task.taskId);
      if (
        !current
        || !ACTIVE_STATUSES.has(current.status)
        || current.leaseToken !== leaseToken
      ) {
        return;
      }
      void recoverTask(cloneTask(current)).catch((error) => {
        logger.warn?.('[ManagedOrchestration] Failed to retry task reconciliation', {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, reconciliationRetryMs));
    reconciliationRetryTimers.set(task.taskId, timer);
  };

  const clearAdmissionRetry = () => {
    if (admissionRetryTimer === null) return;
    const timer = admissionRetryTimer;
    admissionRetryTimer = null;
    admissionRetryDueAt = null;
    cancelTimeout(timer);
  };

  // One retry timer serves the whole queue; the earliest pending due time wins.
  const scheduleAdmissionRetry = (delayMs) => {
    if (shutDown) return;
    const dueAt = now() + delayMs;
    if (admissionRetryTimer !== null && admissionRetryDueAt !== null && admissionRetryDueAt <= dueAt) {
      return;
    }
    clearAdmissionRetry();
    admissionRetryDueAt = dueAt;
    admissionRetryTimer = unrefTimer(scheduleTimeout(() => {
      admissionRetryTimer = null;
      admissionRetryDueAt = null;
      if (shutDown) return;
      void pump().catch((error) => {
        logger.warn?.('[ManagedOrchestration] Launch admission retry failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs));
  };

  const normalizeAdmissionRetryMs = (value) => {
    if (!Number.isFinite(value)) return ADMISSION_RETRY_DEFAULT_MS;
    return Math.min(ADMISSION_RETRY_MAX_MS, Math.max(ADMISSION_RETRY_MIN_MS, Math.trunc(value)));
  };

  // Fail open: a throwing or malformed host decision launches the task.
  const resolveLaunchAdmission = async (task, activeCount, queuedCount) => {
    if (!admitLaunch) return { admit: true };
    let decision;
    try {
      decision = await admitLaunch({ task: cloneTask(task), activeCount, queuedCount, now: now() });
    } catch (error) {
      logger.warn?.('[ManagedOrchestration] Launch admission hook failed; admitting', {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { admit: true };
    }
    if (!decision || typeof decision !== 'object' || decision.admit !== false) return { admit: true };
    if (!WAITING_REASON_KINDS.has(decision.reason)) {
      logger.warn?.('[ManagedOrchestration] Launch admission hook returned an unknown reason; admitting', {
        taskId: task.taskId,
        reason: decision.reason,
      });
      return { admit: true };
    }
    const limit = decision.reason === 'capacity'
      && Number.isSafeInteger(decision.limit)
      && decision.limit >= 1
      ? decision.limit
      : null;
    return {
      admit: false,
      reason: decision.reason,
      limit,
      retryInMs: normalizeAdmissionRetryMs(decision.retryInMs),
    };
  };

  // Persists the hold on the head task only when kind, limit, or activeCount
  // changed; `since` survives while the kind is unchanged.
  const recordWaitingReasonLocked = async (previous, decision, activeCount) => {
    const existing = previous.waitingReason;
    if (
      existing
      && existing.kind === decision.reason
      && existing.limit === decision.limit
      && existing.activeCount === activeCount
    ) {
      return;
    }
    const next = {
      ...previous,
      waitingReason: {
        kind: decision.reason,
        activeCount,
        limit: decision.limit,
        since: existing && existing.kind === decision.reason ? existing.since : now(),
      },
    };
    await commitTaskUpdateLocked(previous, next);
  };

  async function pump() {
    if (shutDown) return;
    const admitted = [];
    await runExclusive(async () => {
      if (shutDown) return;
      const queued = [...tasks.values()]
        .filter((task) => (
          task.status === 'queued'
          && !(
            task.dispatchGroupId !== null
            && handoffLocks.has(task.rootSessionId)
          )
        ))
        .sort(compareManagedTaskQueueOrder);
      let activeCount = 0;
      let queuedCount = 0;
      for (const task of tasks.values()) {
        if (ACTIVE_STATUSES.has(task.status)) activeCount += 1;
        else if (task.status === 'queued') queuedCount += 1;
      }
      let held = 0;
      for (const [index, previous] of queued.entries()) {
        const decision = await resolveLaunchAdmission(previous, activeCount, queuedCount);
        if (!decision.admit) {
          // FIFO: a held head blocks everything behind it, so nothing jumps the queue.
          held = queued.length - index;
          await recordWaitingReasonLocked(previous, decision, activeCount);
          scheduleAdmissionRetry(decision.retryInMs);
          break;
        }
        const next = {
          ...previous,
          status: 'starting',
          leaseToken: createLeaseToken(),
          startedAt: now(),
          waitingReason: null,
        };
        await commitTaskUpdateLocked(previous, next);
        scheduleStartingLease(next);
        admitted.push(cloneTask(next));
        activeCount += 1;
        queuedCount -= 1;
      }
      admissionHeldCount = held;
      if (held === 0) clearAdmissionRetry();
    });
    for (const task of admitted) launchTask(task);
  }

  const handleTaskTimeout = async (taskId, timeoutAt) => {
    const task = tasks.get(taskId);
    if (!task || isTerminalManagedTaskStatus(task.status) || task.timeoutAt !== timeoutAt) return;
    const reason = `${MANAGED_TASK_TIMEOUT_REASON_PREFIX}${timeoutAt}`;
    await cancelSingleTask(taskId, {
      reason,
      terminalStatus: task.status === 'queued' ? 'aborted' : 'failed',
      resumableOnUnconfirmedAbort: task.status !== 'queued',
    });
  };

  const handleStartingLease = async (taskId, leaseToken) => {
    if (shutDown) return;
    const task = tasks.get(taskId);
    if (!task || task.status !== 'starting' || task.leaseToken !== leaseToken) return;
    // The original start promise may still be pending. Reconciliation becomes
    // the authoritative observer; a late original completion is ignored by
    // terminal immutability and the lease/status checks.
    activeLaunches.delete(taskId);
    await recoverTask(cloneTask(task));
  };

  const scheduleStartingLease = (task) => {
    clearStartingLease(task.taskId);
    if (task.status !== 'starting' || !task.leaseToken || shutDown) return;
    const dueAt = (task.startedAt ?? now()) + startingLeaseTimeoutMs;
    const timer = unrefTimer(scheduleTimeout(() => {
      startingLeaseTimers.delete(task.taskId);
      void handleStartingLease(task.taskId, task.leaseToken).catch((error) => {
        logger.warn?.('[ManagedOrchestration] Failed to reconcile starting lease', {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, Math.max(0, dueAt - now())));
    startingLeaseTimers.set(task.taskId, timer);
  };

  const scheduleTaskDeadline = (task) => {
    clearTaskTimeout(task.taskId);
    if (task.timeoutAt === null || isTerminalManagedTaskStatus(task.status)) return;
    const delay = Math.max(0, task.timeoutAt - now());
    const timer = unrefTimer(scheduleTimeout(() => {
      timeoutTimers.delete(task.taskId);
      void handleTaskTimeout(task.taskId, task.timeoutAt).catch((error) => {
        logger.warn?.('[ManagedOrchestration] Failed to settle task timeout', {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay));
    timeoutTimers.set(task.taskId, timer);
  };

  // Restart re-arm. Timers are process state, so every persisted active auto-resume
  // is re-derived here: breakers from known resets, `planning` and near-due
  // `scheduled` states re-planned after the startup grace (never fired blindly),
  // far `scheduled` states re-armed as-is, and `attempting` states reconciled
  // against the follow-up their idempotency key may already have created.
  const rearmAutoResumeLocked = async () => {
    if (shutDown || !autoResumeAttempt) return;
    const at = now();
    const ordered = [...resultEnvelopes.values()].sort((left, right) => left.sequence - right.sequence);
    for (const envelope of ordered) {
      const task = tasks.get(envelope.taskId);
      if (!task || !isAutoResumeActive(envelope)) continue;
      const state = envelope.autoResume;
      const ownerKey = ownerKeyFor(task.rootSessionId);
      const origin = resolveAutoResumeOriginLocked(task);
      if (state.resetAt !== null && state.resetAt > at) {
        markProviderLimitedLocked(origin.providerId, ownerKey, {
          until: state.resetAt,
          source: state.resetSource ?? 'opencode_status',
        });
      }
      const generation = state.cancelGeneration;
      if (state.state === 'attempting') {
        let followUp = null;
        if (envelope.action !== null) {
          followUp = envelope.followUpTaskId ? tasks.get(envelope.followUpTaskId) ?? null : null;
        } else {
          const followUpTaskId = idempotencyIndex.get(idempotencyIndexKey(
            task.rootSessionId,
            autoResumeAttemptKey(task.taskId, state),
          ));
          followUp = followUpTaskId ? tasks.get(followUpTaskId) ?? null : null;
          if (followUp) {
            // The attempt did submit before the restart; heal the acknowledgement.
            await commitEnvelopeUpdateLocked(envelope, {
              ...envelope,
              acknowledgedAt: at,
              action: 'retry_in_place',
              followUpTaskId: followUp.taskId,
              autoResume: {
                ...state,
                lastAttemptTaskId: followUp.taskId,
                nextAttemptAt: null,
                revision: state.revision + 1,
              },
            });
          } else {
            await commitAutoResumeStateLocked(envelope, {
              state: 'planning',
              attemptCount: Math.max(0, state.attemptCount - 1),
              nextAttemptAt: null,
            });
            scheduleAutoResumePlanning(task.taskId, generation, autoResumeStartupGraceMs);
            continue;
          }
        }
        if (followUp && isTerminalManagedTaskStatus(followUp.status)) {
          // Settled while we were down: settle the prior and park the follow-up.
          await parkAutoResumeLocked(followUp, { planningDelayMs: autoResumeStartupGraceMs });
        } else if (followUp) {
          setProviderProbeLocked(followUp.providerId, ownerKey, {
            taskId: task.taskId,
            since: state.lastAttemptAt ?? at,
          });
        }
        continue;
      }
      if (
        state.state === 'planning'
        || state.nextAttemptAt === null
        || state.nextAttemptAt <= at + autoResumeStartupGraceMs
      ) {
        scheduleAutoResumePlanning(task.taskId, generation, autoResumeStartupGraceMs);
        continue;
      }
      scheduleAutoResumeAttempt(task.taskId, generation, state.nextAttemptAt);
    }
    // Follow-ups whose prior was settled but which never got parked themselves.
    for (const envelope of ordered) {
      if (!resultEnvelopes.has(envelope.taskId)) continue;
      const current = resultEnvelopes.get(envelope.taskId);
      if (current.autoResume !== null || current.action !== null) continue;
      const task = tasks.get(current.taskId);
      if (!task?.priorTaskId || !isTerminalManagedTaskStatus(task.status)) continue;
      const priorState = resultEnvelopes.get(task.priorTaskId)?.autoResume ?? null;
      if (
        !priorState
        || priorState.lastAttemptTaskId !== task.taskId
        || (priorState.state !== 'attempting' && priorState.state !== 'superseded')
      ) {
        continue;
      }
      await parkAutoResumeLocked(task, { planningDelayMs: autoResumeStartupGraceMs });
    }
  };

  const initialize = () => {
    if (shutDown) {
      return Promise.reject(new ManagedOrchestrationError(
        'scheduler_shut_down',
        'managed orchestration scheduler is shut down',
      ));
    }
    if (initialized) return Promise.resolve();
    if (initializePromise) return initializePromise;
    initializePromise = runExclusive(async () => {
      if (initialized) return;
      const loaded = await persistence.load();
      if (loaded !== null && loaded !== undefined) {
        if (!loaded || loaded.version !== 1 || !Array.isArray(loaded.tasks)) {
          throw new ManagedOrchestrationError('invalid_ledger', 'managed orchestration ledger is invalid');
        }
        for (const rawTask of loaded.tasks) {
          const task = validateManagedTaskRecord({
            ...rawTask,
            dispatchGroupId: rawTask?.dispatchGroupId ?? null,
            dispatchCallId: rawTask?.dispatchCallId ?? null,
            dispatchWaveId: rawTask?.dispatchWaveId ?? null,
            readOnly: rawTask?.readOnly ?? false,
            recoveryLineageId: rawTask?.recoveryLineageId ?? null,
            childPromptedAt: rawTask?.childPromptedAt ?? null,
            firstAssistantPartAt: rawTask?.firstAssistantPartAt ?? null,
            waitingReason: rawTask?.waitingReason ?? null,
          });
          if (tasks.has(task.taskId)) {
            throw new ManagedOrchestrationError('duplicate_task', `duplicate task ${task.taskId} in ledger`);
          }
          const indexKey = idempotencyIndexKey(task.rootSessionId, task.idempotencyKey);
          if (idempotencyIndex.has(indexKey)) {
            throw new ManagedOrchestrationError(
              'duplicate_idempotency_key',
              `duplicate idempotency key for root ${task.rootSessionId}`,
            );
          }
          tasks.set(task.taskId, cloneTask(task));
          idempotencyIndex.set(indexKey, task.taskId);
        }
        const loadedEnvelopes = loaded.resultEnvelopes ?? [];
        if (!Array.isArray(loadedEnvelopes)) {
          throw new ManagedOrchestrationError('invalid_ledger', 'managed result envelopes are invalid');
        }
        for (const rawEnvelope of loadedEnvelopes) {
          const envelope = validateManagedTaskResultEnvelope({
            ...rawEnvelope,
            providerResetAt: rawEnvelope?.providerResetAt ?? null,
            autoResume: rawEnvelope?.autoResume ?? null,
          });
          const task = tasks.get(envelope.taskId);
          if (!task || resultEnvelopes.has(envelope.taskId)) {
            throw new ManagedOrchestrationError(
              'invalid_result_envelope',
              `result envelope ${envelope.envelopeId} has no unique task`,
            );
          }
          assertManagedTaskResultEnvelopeMatchesTask(task, envelope);
          resultEnvelopes.set(envelope.taskId, structuredClone(envelope));
        }
      }
      initialized = true;
    }).then(async () => {
      const missingEnvelopeTasks = [...tasks.values()]
        .filter((task) => isTerminalManagedTaskStatus(task.status) && !resultEnvelopes.has(task.taskId));
      await runExclusive(async () => {
        if (missingEnvelopeTasks.length > 0) {
          for (const task of missingEnvelopeTasks) {
            resultEnvelopes.set(task.taskId, createManagedTaskResultEnvelope(task, {
              sequence: nextResultSequenceLocked(),
              createdAt: task.finishedAt ?? task.createdAt,
              resumable: false,
            }));
          }
        }
        await persistLocked();
      });

      recovering = true;
      try {
        const active = [...tasks.values()]
          .filter((task) => ACTIVE_STATUSES.has(task.status))
          .sort(compareManagedTaskQueueOrder);
        for (const task of active) await recoverTask(cloneTask(task));
      } finally {
        recovering = false;
      }
      if (autoResumeAttempt) {
        const rootSessionIds = new Set();
        for (const envelope of resultEnvelopes.values()) {
          if (isAutoResumeActive(envelope)) rootSessionIds.add(envelope.rootSessionId);
        }
        for (const rootSessionId of rootSessionIds) await resolveAutoResumeOwnerKey(rootSessionId);
        await runExclusive(async () => {
          await rearmAutoResumeLocked();
        });
      }
      for (const task of tasks.values()) {
        scheduleTaskDeadline(task);
        scheduleStartingLease(task);
      }
      await pump();
    }).finally(() => {
      initializePromise = null;
    });
    return initializePromise;
  };

  const ensureInitialized = async () => {
    if (shutDown) {
      throw new ManagedOrchestrationError(
        'scheduler_shut_down',
        'managed orchestration scheduler is shut down',
      );
    }
    if (!initialized) await initialize();
    if (shutDown) {
      throw new ManagedOrchestrationError(
        'scheduler_shut_down',
        'managed orchestration scheduler is shut down',
      );
    }
  };

  const submit = async (input) => {
    await ensureInitialized();
    const task = await runExclusive(async () => {
      const indexKey = idempotencyIndexKey(input.rootSessionId, input.idempotencyKey);
      const existingTaskId = idempotencyIndex.get(indexKey);
      if (existingTaskId) return cloneTask(tasks.get(existingTaskId));

      // Content-scoped duplicate guard. Only collapses onto a task that is
      // STILL RUNNING — a finished task never blocks a fresh dispatch, so
      // re-running the same work later is unaffected. `allowDuplicate` is the
      // deliberate escape hatch for parallel fan-out of one agent.
      if (input.allowDuplicate !== true && !input.parentTaskId) {
        const fingerprint = dispatchFingerprint(input);
        if (fingerprint) {
          // Must use the injected clock, not Date.now(): the scheduler is
          // constructed with a `now` option and task.createdAt comes from it.
          const at = now();
          for (const candidate of tasks.values()) {
            if (candidate.rootSessionId !== input.rootSessionId) continue;
            if (!ACTIVE_STATUSES.has(candidate.status)) continue;
            if (at - candidate.createdAt > DUPLICATE_DISPATCH_WINDOW_MS) continue;
            if (dispatchFingerprint(candidate) !== fingerprint) continue;
            return cloneTask(candidate);
          }
        }
      }

      assertManagedReadOnlyAgentSupport(input);

      if (input.dispatchGroupId !== null && input.dispatchGroupId !== undefined) {
        const handoff = handoffLocks.get(input.rootSessionId);
        if (handoff) {
          throw new ManagedOrchestrationError(
            'handoff_in_progress',
            `root ${input.rootSessionId} orchestrator-to-builder handoff is in progress`,
          );
        }
      }

      const activeMode = getActiveModeForRootLocked(input.rootSessionId);
      if (activeMode && activeMode !== input.mode) {
        throw new ManagedOrchestrationError(
          'mode_lease_conflict',
          `root ${input.rootSessionId} is leased to ${activeMode} mode`,
        );
      }

      if (input.parentTaskId) {
        const parent = tasks.get(input.parentTaskId);
        if (!parent) {
          throw new ManagedOrchestrationError('parent_not_found', `parent task ${input.parentTaskId} was not found`);
        }
        if (
          parent.rootSessionId !== input.rootSessionId
          || parent.directory !== input.directory
          || parent.mode !== input.mode
        ) {
          throw new ManagedOrchestrationError(
            'parent_scope_mismatch',
            `parent task ${input.parentTaskId} does not belong to the requested root graph`,
          );
        }
      }

      const taskId = createTaskId();
      if (tasks.has(taskId)) {
        throw new ManagedOrchestrationError('task_id_collision', `task ID ${taskId} already exists`);
      }
      const next = createManagedTaskRecord({
        taskId,
        idempotencyKey: input.idempotencyKey,
        rootSessionId: input.rootSessionId,
        dispatchGroupId: input.dispatchGroupId ?? null,
        dispatchCallId: input.dispatchCallId ?? null,
        dispatchWaveId: resolveDispatchWaveIdLocked(input),
        parentTaskId: input.parentTaskId ?? null,
        childSessionId: input.childSessionId ?? null,
        directory: input.directory,
        sequence: nextSequenceLocked(),
        mode: input.mode,
        readOnly: input.readOnly ?? false,
        providerId: input.providerId,
        modelId: input.modelId,
        agent: input.agent,
        variant: input.variant ?? null,
        label: input.label,
        prompt: input.prompt,
        attempt: input.attempt ?? 1,
        priorTaskId: input.priorTaskId ?? null,
        executionKind: input.executionKind ?? 'start',
        createdAt: now(),
        timeoutAt: input.timeoutAt ?? null,
        recoveryLineageId: input.recoveryLineageId ?? null,
      });
      await commitNewTaskLocked(next);
      return cloneTask(next);
    });
    scheduleTaskDeadline(tasks.get(task.taskId));
    await pump();
    return cloneTask(tasks.get(task.taskId));
  };

  const releaseModeLease = async (rootSessionId, mode) => {
    await ensureInitialized();
    return await runExclusive(async () => {
      const activeMode = getActiveModeForRootLocked(rootSessionId);
      if (!activeMode) return true;
      if (activeMode !== mode) {
        throw new ManagedOrchestrationError(
          'mode_lease_conflict',
          `root ${rootSessionId} is leased to ${activeMode} mode`,
        );
      }
      throw new ManagedOrchestrationError(
        'mode_lease_active',
        'cannot release mode lease while managed tasks are active',
      );
    });
  };

  const raceAbortWithTimeout = async (abortPromise, onTimeout) => {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = unrefTimer(scheduleTimeout(() => {
        resolve({ timedOut: true });
        onTimeout?.();
      }, abortTimeoutMs));
    });
    try {
      return await Promise.race([
        Promise.resolve(abortPromise).then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) cancelTimeout(timer);
    }
  };

  const cancelSingleTask = async (taskId, {
    reason = 'Cancelled by parent orchestrator',
    terminalStatus = 'aborted',
    resumableOnUnconfirmedAbort = false,
  } = {}) => {
    const existingCancellation = cancellationPromises.get(taskId);
    if (existingCancellation) return await existingCancellation;

    const cancellation = (async () => {
      await ensureInitialized();
      let task = tasks.get(taskId);
      if (!task) {
        throw new ManagedOrchestrationError('task_not_found', `managed task ${taskId} was not found`);
      }
      if (isTerminalManagedTaskStatus(task.status)) {
        // A parked result still waiting to resume itself: stopping it switches the
        // automatic resume off instead of re-settling an immutable terminal task.
        await runExclusive(async () => {
          const current = tasks.get(taskId);
          const envelope = resultEnvelopes.get(taskId);
          if (!current || !envelope || !isAutoResumeActive(envelope)) return;
          await disableAutoResumeLocked(current, envelope, 'cancelled');
        });
        return cloneTask(tasks.get(taskId) ?? task);
      }

      if (task.status === 'queued') {
        await runExclusive(async () => {
          const previous = tasks.get(taskId);
          if (!previous || isTerminalManagedTaskStatus(previous.status)) return;
          const next = {
            ...previous,
            status: 'aborted',
            finishedAt: now(),
            failureReason: reason,
            waitingReason: null,
          };
          await commitTerminalTaskLocked(previous, next);
        });
        return cloneTask(tasks.get(taskId));
      }

      let abortResult = null;
      let abortFailure = null;
      const abortController = new AbortController();
      try {
        const outcome = await raceAbortWithTimeout(
          executor.abort(cloneTask(task), { signal: abortController.signal }),
          () => abortController.abort(new Error(
            `Managed task abort exceeded ${abortTimeoutMs}ms`,
          )),
        );
        if (outcome.timedOut) {
          abortFailure = `Provider abort did not settle within ${abortTimeoutMs}ms`;
        } else if (outcome.error) {
          abortFailure = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        } else {
          abortResult = outcome.value;
        }
      } catch (error) {
        abortFailure = error instanceof Error ? error.message : String(error);
      }

      const recovery = await readRecovery(task);
      const recoverablePreview = typeof recovery.recoverablePreview === 'string'
        ? recovery.recoverablePreview
        : '';
      const canonicalRefs = Array.isArray(recovery.canonicalRefs)
        ? recovery.canonicalRefs.map((reference) => ({ ...reference }))
        : [];
      const abortConfirmed = !abortFailure && abortResult?.aborted !== false;
      if (!abortConfirmed) {
        logger.warn?.('[ManagedOrchestration] Provider abort cleanup was not confirmed', {
          taskId,
          primaryReason: reason,
          cleanupFailure: abortFailure || abortResult?.failureReason || 'Provider did not confirm abort',
        });
      }
      await finishTask(taskId, task.leaseToken, {
        status: abortConfirmed ? terminalStatus : 'interrupted',
        failureReason: reason,
        partial: typeof recovery.partial === 'boolean'
          ? recovery.partial
          : Boolean(recoverablePreview || canonicalRefs.length > 0),
        recoverablePreview,
        canonicalRefs,
        resumable: Boolean(
          recovery.resumable
          || (
            resumableOnUnconfirmedAbort
            && !abortConfirmed
            && task.childSessionId
          )
        ),
      });
      return cloneTask(tasks.get(taskId));
    })();

    cancellationPromises.set(taskId, cancellation);
    try {
      return await cancellation;
    } finally {
      cancellationPromises.delete(taskId);
    }
  };

  const cancelTaskForAgentHandoff = async (taskId) => {
    const existingCancellation = cancellationPromises.get(taskId);
    if (existingCancellation) {
      const cancelled = await existingCancellation;
      if (cancelled.status === 'interrupted') {
        throw new ManagedOrchestrationError(
          'handoff_abort_unconfirmed',
          `managed task ${taskId} abort could not be confirmed`,
        );
      }
      return cancelled;
    }

    const cancellation = (async () => {
      const task = tasks.get(taskId);
      if (!task) {
        throw new ManagedOrchestrationError('task_not_found', `managed task ${taskId} was not found`);
      }
      const interruptedLaunchStillActive = task.status === 'interrupted'
        && activeLaunches.has(taskId);
      if (isTerminalManagedTaskStatus(task.status) && !interruptedLaunchStillActive) {
        return cloneTask(task);
      }
      if (task.status === 'queued') {
        await runExclusive(async () => {
          const previous = tasks.get(taskId);
          if (!previous || isTerminalManagedTaskStatus(previous.status)) return;
          const next = {
            ...previous,
            status: 'aborted',
            finishedAt: now(),
            failureReason: 'Stopped during orchestrator-to-builder handoff',
            waitingReason: null,
          };
          await commitTerminalTaskLocked(previous, next);
        });
        return cloneTask(tasks.get(taskId));
      }

      const outcome = await raceAbortWithTimeout(executor.abort(cloneTask(task)));
      const abortConfirmed = !outcome.timedOut && !outcome.error && outcome.value?.aborted !== false;
      if (!abortConfirmed) {
        throw new ManagedOrchestrationError(
          'handoff_abort_unconfirmed',
          `managed task ${taskId} abort could not be confirmed`,
        );
      }

      const recovery = await readRecovery(task);
      const recoverablePreview = typeof recovery.recoverablePreview === 'string'
        ? recovery.recoverablePreview
        : '';
      const canonicalRefs = Array.isArray(recovery.canonicalRefs)
        ? recovery.canonicalRefs.map((reference) => ({ ...reference }))
        : [];
      if (!isTerminalManagedTaskStatus(task.status)) {
        await finishTask(taskId, task.leaseToken, {
          status: 'aborted',
          failureReason: outcome.value?.failureReason || 'Stopped during orchestrator-to-builder handoff',
          partial: typeof recovery.partial === 'boolean'
            ? recovery.partial
            : Boolean(recoverablePreview || canonicalRefs.length > 0),
          recoverablePreview,
          canonicalRefs,
          resumable: Boolean(recovery.resumable),
        });
      }
      return cloneTask(tasks.get(taskId));
    })();
    cancellationPromises.set(taskId, cancellation);
    try {
      return await cancellation;
    } finally {
      if (cancellationPromises.get(taskId) === cancellation) {
        cancellationPromises.delete(taskId);
      }
    }
  };

  const collectDescendants = (taskId) => {
    const depthByTask = new Map([[taskId, 0]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks.values()) {
        if (!task.parentTaskId || depthByTask.has(task.taskId)) continue;
        const parentDepth = depthByTask.get(task.parentTaskId);
        if (parentDepth === undefined) continue;
        depthByTask.set(task.taskId, parentDepth + 1);
        changed = true;
      }
    }
    return [...depthByTask.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([id]) => id);
  };

  const cancelTask = async (taskId, cancelOptions = {}) => {
    await ensureInitialized();
    if (!cancelOptions.cascade) {
      return await cancelSingleTask(taskId, cancelOptions);
    }
    if (!tasks.has(taskId)) {
      throw new ManagedOrchestrationError('task_not_found', `managed task ${taskId} was not found`);
    }
    const cancelled = [];
    for (const descendantTaskId of collectDescendants(taskId)) {
      const task = await cancelSingleTask(descendantTaskId, cancelOptions);
      cancelled.push(task);
    }
    return cancelled;
  };

  const waitForTask = async (taskId, { signal, timeoutMs } = {}) => {
    const hasTimeout = timeoutMs !== undefined;
    if (hasTimeout && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }
    await ensureInitialized();
    if (shutDown) {
      throw new ManagedOrchestrationError(
        'scheduler_shut_down',
        'managed orchestration scheduler is shut down',
      );
    }
    const task = tasks.get(taskId);
    if (!task) {
      throw new ManagedOrchestrationError('task_not_found', `managed task ${taskId} was not found`);
    }
    if (isTerminalManagedTaskStatus(task.status)) return cloneTask(task);
    if (signal?.aborted) throw signal.reason ?? new Error('Task wait aborted');
    return await new Promise((resolve, reject) => {
      const waiters = taskWaiters.get(taskId) ?? new Set();
      let settled = false;
      let waitTimer;
      let waitTimerScheduled = false;
      const clearWaitTimer = () => {
        if (!waitTimerScheduled) return;
        waitTimerScheduled = false;
        cancelTimeout(waitTimer);
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        clearWaitTimer();
        callback(value);
      };
      const removeWaiter = () => {
        waiters.delete(waiter);
        if (waiters.size === 0) taskWaiters.delete(taskId);
      };
      const waiter = {
        resolve(value) {
          settle(resolve, value);
        },
        reject(error) {
          settle(reject, error);
        },
      };
      const onAbort = () => {
        removeWaiter();
        waiter.reject(signal.reason ?? new Error('Task wait aborted'));
      };
      const onWaitTimeout = () => {
        removeWaiter();
        const latest = tasks.get(taskId);
        if (!latest) {
          waiter.reject(new ManagedOrchestrationError(
            'task_not_found',
            `managed task ${taskId} was not found`,
          ));
          return;
        }
        waiter.resolve(cloneTask(latest));
      };
      /*
       * Register synchronously after the terminal check. JavaScript cannot run
       * a terminal callback between this check and Set insertion.
       */
      waiters.add(waiter);
      taskWaiters.set(taskId, waiters);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (hasTimeout) {
        waitTimer = unrefTimer(scheduleTimeout(onWaitTimeout, timeoutMs));
        waitTimerScheduled = true;
        if (settled) clearWaitTimer();
      }
    });
  };

  const waitForResultAction = async (taskId, { signal } = {}) => {
    await ensureInitialized();
    if (shutDown) {
      throw new ManagedOrchestrationError(
        'scheduler_shut_down',
        'managed orchestration scheduler is shut down',
      );
    }
    if (!tasks.has(taskId)) {
      throw new ManagedOrchestrationError('task_not_found', `managed task ${taskId} was not found`);
    }
    const envelope = resultEnvelopes.get(taskId);
    if (!envelope) {
      throw new ManagedOrchestrationError(
        'result_not_found',
        `managed task result ${taskId} was not found`,
      );
    }
    if (envelope.action !== null) return structuredClone(envelope);
    if (signal?.aborted) throw signal.reason ?? new Error('Result action wait aborted');
    return await new Promise((resolve, reject) => {
      const waiters = resultActionWaiters.get(taskId) ?? new Set();
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      const removeWaiter = () => {
        waiters.delete(waiter);
        if (waiters.size === 0) resultActionWaiters.delete(taskId);
      };
      const waiter = {
        resolve(value) {
          settle(resolve, value);
        },
        reject(error) {
          settle(reject, error);
        },
      };
      const onAbort = () => {
        removeWaiter();
        waiter.reject(signal.reason ?? new Error('Result action wait aborted'));
      };
      /*
       * Register synchronously after the action check. JavaScript cannot commit
       * an acknowledgement between this check and Set insertion.
       */
      waiters.add(waiter);
      resultActionWaiters.set(taskId, waiters);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const waitForDispatchBarrier = async (rootSessionId, { signal } = {}) => {
    await ensureInitialized();
    if (typeof rootSessionId !== 'string' || !rootSessionId.trim()) {
      throw new ManagedOrchestrationError('missing_root_session_id', 'rootSessionId is required');
    }

    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('Dispatch barrier wait aborted');
      const state = getDispatchBarrierStateLocked(rootSessionId);
      if (state.state === 'clear' || state.state === 'awaiting_acknowledgement') {
        return state;
      }
      if (state.taskIds.length > 0) {
        await Promise.all(state.taskIds.map((taskId) => waitForTask(taskId, { signal })));
        continue;
      }
    }
  };

  const inspectDispatchBarrier = async (rootSessionId) => {
    await ensureInitialized();
    if (typeof rootSessionId !== 'string' || !rootSessionId.trim()) {
      throw new ManagedOrchestrationError('missing_root_session_id', 'rootSessionId is required');
    }
    return await runExclusive(async () => getDispatchBarrierStateLocked(rootSessionId));
  };

  // Any terminal managed result whose parent never collected it leaves that
  // parent wedged, not just the provider-recovery lineage this started as. A
  // child that finished while the parent's tool wait was detached, and a child
  // that hit its hard deadline, both end with an unacknowledged envelope and an
  // idle root that will never move again on its own. Report collectable results
  // so the packaged plugin can wake the root once.
  //
  // Results requiring user-selected recovery stay off this list. They must never
  // be collected or retried by the agent — that would bypass the user's Model
  // Recovery choice — and they must not inject a synthetic parent notice either.
  // The attached wait already returns `manualRecoveryRequired`, and the Model
  // Recovery card is the user-action surface. Callers additionally require the
  // root to be idle and marker-gate each collect wake, so an attached wait still
  // wins and cannot double-fire.
  const listReadyProviderRecoveryContinuations = ({ sessionId } = {}) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return [...tasks.values()]
      .filter((task) => {
        if (
          task.mode !== 'orchestrator'
          || task.dispatchGroupId === null
          || !isTerminalManagedTaskStatus(task.status)
        ) {
          return false;
        }
        if (
          normalizedSessionId
          && task.rootSessionId !== normalizedSessionId
          && task.childSessionId !== normalizedSessionId
        ) {
          return false;
        }

        const resultEnvelope = resultEnvelopes.get(task.taskId);
        // An envelope that already carries an action was disposed of, or was
        // superseded by a follow-up attempt that is tracked in its own right.
        if (!resultEnvelope || resultEnvelope.action !== null) return false;
        return !requiresManualModelRecovery(task, resultEnvelope);
      })
      .sort(compareManagedTaskQueueOrder)
      .map((task) => ({
        sourceTaskId: task.priorTaskId,
        taskId: task.taskId,
        rootSessionId: task.rootSessionId,
        childSessionId: task.childSessionId,
        directory: task.directory,
        kind: 'collect',
      }));
  };

  const validateProviderRecoveryContinuationClaimInput = (input) => {
    const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
    const rootSessionId = typeof input?.rootSessionId === 'string' ? input.rootSessionId.trim() : '';
    const directory = typeof input?.directory === 'string' ? input.directory.trim() : '';
    const claimantId = typeof input?.claimantId === 'string' ? input.claimantId.trim() : '';
    if (!taskId || !rootSessionId || !directory || !claimantId) {
      throw new ManagedOrchestrationError(
        'invalid_recovery_continuation_claim',
        'taskId, rootSessionId, directory, and claimantId are required',
      );
    }
    return { taskId, rootSessionId, directory, claimantId };
  };

  const claimProviderRecoveryContinuation = async (input) => {
    await ensureInitialized();
    const scope = validateProviderRecoveryContinuationClaimInput(input);
    return await runExclusive(async () => {
      const task = tasks.get(scope.taskId);
      if (!task) {
        throw new ManagedOrchestrationError(
          'task_not_found',
          `managed task ${scope.taskId} was not found`,
        );
      }
      if (task.rootSessionId !== scope.rootSessionId || task.directory !== scope.directory) {
        throw new ManagedOrchestrationError(
          'task_scope_mismatch',
          'managed task recovery continuation scope does not match',
        );
      }

      const envelope = resultEnvelopes.get(task.taskId);
      const ready = task.mode === 'orchestrator'
        && task.dispatchGroupId !== null
        && isTerminalManagedTaskStatus(task.status)
        && envelope?.action === null
        && !requiresManualModelRecovery(task, envelope);
      if (!ready) return { claimed: false, expiresAt: null };

      const claimedAt = now();
      const existing = providerRecoveryContinuationClaims.get(task.taskId);
      if (existing && existing.expiresAt > claimedAt) {
        return { claimed: false, expiresAt: existing.expiresAt };
      }

      const expiresAt = claimedAt + providerRecoveryContinuationLeaseMs;
      providerRecoveryContinuationClaims.set(task.taskId, {
        claimantId: scope.claimantId,
        expiresAt,
      });
      return { claimed: true, expiresAt };
    });
  };

  const releaseProviderRecoveryContinuation = async (input) => {
    await ensureInitialized();
    const scope = validateProviderRecoveryContinuationClaimInput(input);
    return await runExclusive(async () => {
      const existing = providerRecoveryContinuationClaims.get(scope.taskId);
      if (!existing || existing.claimantId !== scope.claimantId) {
        return { released: false };
      }
      providerRecoveryContinuationClaims.delete(scope.taskId);
      return { released: true };
    });
  };

  const inspectAgentHandoff = async (input) => {
    await ensureInitialized();
    validateAgentHandoffScope(input);
    return await runExclusive(async () => {
      const taskIds = collectAgentHandoffTaskIdsLocked(input.rootSessionId);
      return {
        state: taskIds.length === 0 ? 'clear' : 'confirmation_required',
        taskIds,
        failures: [],
      };
    });
  };

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (shutDown) return;
      shutDown = true;
      for (const taskId of [...timeoutTimers.keys()]) clearTaskTimeout(taskId);
      for (const taskId of [...startingLeaseTimers.keys()]) clearStartingLease(taskId);
      for (const taskId of [...reconciliationRetryTimers.keys()]) clearReconciliationRetry(taskId);
      for (const taskId of [...autoResumeTimers.keys()]) clearAutoResumeTimer(taskId);
      clearAdmissionRetry();
      const shutdownError = new ManagedOrchestrationError(
        'scheduler_shut_down',
        'managed orchestration scheduler is shut down',
      );
      for (const waiters of taskWaiters.values()) {
        for (const waiter of waiters) waiter.reject(shutdownError);
      }
      taskWaiters.clear();
      for (const waiters of resultActionWaiters.values()) {
        for (const waiter of waiters) waiter.reject(shutdownError);
      }
      resultActionWaiters.clear();
      activeLaunches.clear();
      cancellationPromises.clear();
      acknowledgementPromises.clear();
      handoffLocks.clear();
      providerRecoveryContinuationClaims.clear();
      let persistenceError = null;
      try {
        await runExclusive(async () => {
          if (initialized) await persistLocked();
        });
        await publicationTail;
      } catch (error) {
        persistenceError = error;
      }

      let executorError = null;
      try {
        if (typeof executor.shutdown === 'function') {
          await executor.shutdown();
        }
      } catch (error) {
        executorError = error;
      }

      if (persistenceError && executorError) {
        throw new AggregateError(
          [persistenceError, executorError],
          'managed orchestration persistence and executor shutdown failed',
        );
      }
      if (persistenceError) throw persistenceError;
      if (executorError) throw executorError;
    })();
    return shutdownPromise;
  };

  const acknowledgeResult = async (taskId, actionOptions = {}) => {
    await ensureInitialized();
    const action = actionOptions.action;
    if (!['continue', 'resume', 'retry', 'recover_in_place', 'retry_in_place', 'abandon'].includes(action)) {
      throw new ManagedOrchestrationError('invalid_result_action', 'result action is invalid');
    }
    if (typeof actionOptions.idempotencyKey !== 'string' || !actionOptions.idempotencyKey.trim()) {
      throw new ManagedOrchestrationError('missing_idempotency_key', 'result action idempotencyKey is required');
    }
    // Internal: set by the host's auto-resume `attempt`. A stale generation (the
    // user toggled auto-resume off, or retried by hand) must never create work.
    const autoResumeGeneration = Number.isSafeInteger(actionOptions.autoResumeGeneration)
      ? actionOptions.autoResumeGeneration
      : null;

    const pending = acknowledgementPromises.get(taskId);
    if (pending) {
      if (pending.action !== action) {
        throw new ManagedOrchestrationError(
          'result_already_acknowledging',
          `result is already being acknowledged with ${pending.action}`,
        );
      }
      return await pending.promise;
    }

    const promise = (async () => {
      const currentEnvelope = resultEnvelopes.get(taskId);
      const sourceTask = tasks.get(taskId);
      if (!currentEnvelope || !sourceTask) {
        throw new ManagedOrchestrationError('result_not_found', `managed task result ${taskId} was not found`);
      }
      if (
        autoResumeGeneration !== null
        && (
          !isAutoResumeActive(currentEnvelope)
          || currentEnvelope.autoResume.cancelGeneration !== autoResumeGeneration
        )
      ) {
        throw new ManagedOrchestrationError(
          'auto_resume_stale',
          'automatic resume attempt no longer matches the parked result',
        );
      }
      if (currentEnvelope.action !== null) {
        if (currentEnvelope.action !== action) {
          throw new ManagedOrchestrationError(
            'result_already_acknowledged',
            `result is already acknowledged with ${currentEnvelope.action}`,
          );
        }
        providerRecoveryContinuationClaims.delete(taskId);
        return {
          envelope: structuredClone(currentEnvelope),
          followUpTask: currentEnvelope.followUpTaskId
            ? cloneTask(tasks.get(currentEnvelope.followUpTaskId))
            : null,
        };
      }

      if (
        requiresManualModelRecovery(sourceTask, currentEnvelope)
        && action !== 'retry_in_place'
        && !(
          action === 'abandon'
          && actionOptions[AGENT_HANDOFF_MANUAL_RECOVERY_ABANDON] === true
        )
      ) {
        throw new ManagedOrchestrationError(
          'manual_model_recovery_required',
          'managed task recovery requires a user-selected model and thinking level',
        );
      }

      const providerPromptRejected = isProviderPromptRejected(sourceTask.failureReason);
      if (
        providerPromptRejected
        && (action === 'resume' || action === 'recover_in_place' || action === 'retry_in_place')
      ) {
        throw new ManagedOrchestrationError(
          'provider_prompt_rejection_requires_fresh_retry',
          'provider prompt rejection recovery requires a fresh child task with a reframed prompt',
        );
      }
      if (providerPromptRejected && action === 'retry') {
        const retryPrompt = typeof actionOptions.prompt === 'string'
          ? actionOptions.prompt.trim()
          : '';
        if (!retryPrompt || retryPrompt === sourceTask.prompt.trim()) {
          throw new ManagedOrchestrationError(
            'provider_prompt_rejection_requires_reframed_prompt',
            'provider prompt rejection retry requires a non-empty prompt that differs from the rejected prompt',
          );
        }
      }

      if (action === 'retry_in_place' && (
        !sourceTask.childSessionId
        || !actionOptions.providerId?.trim()
        || !actionOptions.modelId?.trim()
        || !Object.prototype.hasOwnProperty.call(actionOptions, 'variant')
      )) {
        throw new ManagedOrchestrationError(
          'missing_recovery_model',
          'manual in-place recovery requires an explicit provider, model, and thinking selection',
        );
      }

      if (
        (action === 'retry' || action === 'resume')
        && sourceTask.mode === 'orchestrator'
        && sourceTask.dispatchGroupId !== null
        && sourceTask.attempt >= 2
      ) {
        throw new ManagedOrchestrationError(
          'managed_retry_limit_reached',
          'grouped Orchestrator tasks allow only one agent retry or resume',
        );
      }

      if ((action === 'resume' || action === 'retry_in_place') && !currentEnvelope.resumable) {
        throw new ManagedOrchestrationError('result_not_resumable', 'result cannot be resumed');
      }

      if (action === 'recover_in_place') {
        throw new ManagedOrchestrationError(
          'manual_model_recovery_required',
          'automatic in-place recovery is disabled; choose a model and retry in place',
        );
      }

      let followUpTask = null;
      if (action === 'retry' || action === 'resume' || action === 'retry_in_place') {
        followUpTask = await submit({
          idempotencyKey: actionOptions.idempotencyKey,
          rootSessionId: sourceTask.rootSessionId,
          dispatchGroupId: sourceTask.dispatchGroupId,
          dispatchCallId: sourceTask.dispatchCallId,
          dispatchWaveId: sourceTask.dispatchWaveId,
          parentTaskId: sourceTask.parentTaskId,
          childSessionId: action === 'resume' || action === 'retry_in_place'
            ? sourceTask.childSessionId
            : null,
          directory: sourceTask.directory,
          mode: sourceTask.mode,
          readOnly: sourceTask.readOnly,
          providerId: actionOptions.providerId ?? sourceTask.providerId,
          modelId: actionOptions.modelId ?? sourceTask.modelId,
          agent: actionOptions.agent ?? sourceTask.agent,
          variant: actionOptions.variant === undefined ? sourceTask.variant : actionOptions.variant,
          label: actionOptions.label ?? sourceTask.label,
          prompt: actionOptions.prompt ?? sourceTask.prompt,
          attempt: sourceTask.attempt + 1,
          priorTaskId: sourceTask.taskId,
          executionKind: action,
          timeoutAt: resolveFollowUpTimeoutAt(sourceTask, actionOptions.timeoutAt, now),
          recoveryLineageId: sourceTask.recoveryLineageId ?? createLineageId(sourceTask.taskId),
        });
      }

      await runExclusive(async () => {
        const previous = resultEnvelopes.get(taskId);
        if (!previous) {
          throw new ManagedOrchestrationError('result_not_found', `managed task result ${taskId} was not found`);
        }
        if (previous.action !== null && previous.action !== action) {
          throw new ManagedOrchestrationError(
            'result_already_acknowledged',
            `result is already acknowledged with ${previous.action}`,
          );
        }
        if (previous.action === action) return;
        let autoResume = previous.autoResume;
        if (autoResume) {
          if (autoResumeGeneration !== null && autoResume.cancelGeneration === autoResumeGeneration) {
            // Automatic attempt: the follow-up is the probe; its settlement moves
            // this state on (superseded / succeeded / ended).
            autoResume = {
              ...autoResume,
              lastAttemptTaskId: followUpTask?.taskId ?? autoResume.lastAttemptTaskId,
              nextAttemptAt: null,
              revision: autoResume.revision + 1,
            };
          } else {
            // A human disposed of the result: any pending automatic attempt is void.
            if (autoResume.target) {
              clearProviderProbeLocked(autoResume.target.providerId, ownerKeyFor(sourceTask.rootSessionId), taskId);
            }
            autoResume = {
              ...autoResume,
              state: 'acknowledged',
              reason: 'manual_retry',
              cancelGeneration: autoResume.cancelGeneration + 1,
              nextAttemptAt: null,
              revision: autoResume.revision + 1,
            };
          }
          clearAutoResumeTimer(taskId);
        }
        const next = {
          ...previous,
          acknowledgedAt: now(),
          action,
          followUpTaskId: followUpTask?.taskId ?? null,
          autoResume,
        };
        await commitEnvelopeUpdateLocked(previous, next);
        providerRecoveryContinuationClaims.delete(taskId);
      });

      return {
        envelope: structuredClone(resultEnvelopes.get(taskId)),
        followUpTask: followUpTask ? cloneTask(tasks.get(followUpTask.taskId)) : null,
      };
    })();
    acknowledgementPromises.set(taskId, { action, promise });
    try {
      return await promise;
    } finally {
      acknowledgementPromises.delete(taskId);
    }
  };

  const setResultAutoResume = async (taskId, { enabled } = {}) => {
    await ensureInitialized();
    if (typeof enabled !== 'boolean') {
      throw new ManagedOrchestrationError('invalid_auto_resume_request', 'enabled must be a boolean');
    }
    return await runExclusive(async () => {
      const task = tasks.get(taskId);
      const previous = resultEnvelopes.get(taskId);
      if (!task || !previous) {
        throw new ManagedOrchestrationError('result_not_found', `managed task result ${taskId} was not found`);
      }
      if (previous.action !== null) {
        throw new ManagedOrchestrationError(
          'result_already_acknowledged',
          `result is already acknowledged with ${previous.action}`,
        );
      }
      if (!autoResumeAttempt || !isAutoResumeEligible(task, previous)) {
        throw new ManagedOrchestrationError(
          'auto_resume_not_applicable',
          'automatic resume only applies to a parked provider usage limit',
        );
      }
      const state = previous.autoResume;
      const active = isAutoResumeActive(previous);
      const unchanged = enabled ? active : (state !== null && !active && state.enabled === false);
      if (unchanged) return { envelope: structuredClone(previous) };

      if (!enabled) {
        await disableAutoResumeLocked(task, previous, 'user');
        return { envelope: structuredClone(resultEnvelopes.get(taskId)) };
      }

      const at = now();
      const base = state ?? recordProviderRejection(
        initialAutoResumeState({ now: at, enabled: true, providerResetAt: previous.providerResetAt }),
        { now: at, providerResetAt: previous.providerResetAt },
      );
      const cancelGeneration = state ? state.cancelGeneration + 1 : base.cancelGeneration;
      clearAutoResumeTimer(taskId);
      if (state?.target) {
        clearProviderProbeLocked(state.target.providerId, ownerKeyFor(task.rootSessionId), taskId);
      }
      // Caps are retained across a re-enable: the lineage budget is not a toggle.
      const next = {
        ...base,
        enabled: true,
        cancelGeneration,
        nextAttemptAt: null,
        target: null,
        ...(base.expiresAt <= at
          ? { state: 'exhausted', reason: 'time_cap' }
          : { state: 'planning', reason: null }),
        revision: state ? state.revision + 1 : 1,
      };
      await commitEnvelopeUpdateLocked(previous, { ...previous, autoResume: next });
      if (next.state === 'planning') scheduleAutoResumePlanning(taskId, cancelGeneration, 0);
      return { envelope: structuredClone(resultEnvelopes.get(taskId)) };
    });
  };

  const cancelAutoResumeForSession = async (sessionId, reason) => {
    await ensureInitialized();
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ManagedOrchestrationError('missing_session_id', 'sessionId is required');
    }
    if (reason !== 'session_deleted' && reason !== 'cancelled') {
      throw new ManagedOrchestrationError(
        'invalid_auto_resume_reason',
        'reason must be session_deleted or cancelled',
      );
    }
    return await runExclusive(async () => {
      const cancelledTaskIds = [];
      for (const task of [...tasks.values()].sort(compareManagedTaskQueueOrder)) {
        if (task.rootSessionId !== sessionId && task.childSessionId !== sessionId) continue;
        const envelope = resultEnvelopes.get(task.taskId);
        if (!envelope || !isAutoResumeActive(envelope)) continue;
        await disableAutoResumeLocked(task, envelope, reason);
        cancelledTaskIds.push(task.taskId);
      }
      return { cancelledTaskIds };
    });
  };

  const confirmAgentHandoff = async (input) => {
    await ensureInitialized();
    validateAgentHandoffScope(input, { requireIdempotencyKey: true });

    const existing = handoffLocks.get(input.rootSessionId);
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey) {
        throw new ManagedOrchestrationError(
          'handoff_conflict',
          `another handoff is already in progress for root ${input.rootSessionId}`,
        );
      }
      return await existing.promise;
    }

    const lock = {
      idempotencyKey: input.idempotencyKey,
      promise: null,
    };
    handoffLocks.set(input.rootSessionId, lock);
    const promise = (async () => {
      const taskIds = await runExclusive(async () => (
        collectAgentHandoffTaskIdsLocked(input.rootSessionId)
      ));
      const failures = [];

      for (const taskId of taskIds) {
        try {
          const currentTask = tasks.get(taskId);
          if (currentTask && (
            !isTerminalManagedTaskStatus(currentTask.status)
            || (currentTask.status === 'interrupted' && activeLaunches.has(taskId))
          )) {
            await cancelTaskForAgentHandoff(taskId);
          }
          const envelope = resultEnvelopes.get(taskId);
          if (envelope && envelope.action === null) {
            await acknowledgeResult(taskId, {
              action: 'abandon',
              idempotencyKey: `handoff:${input.idempotencyKey}:${taskId}`,
              [AGENT_HANDOFF_MANUAL_RECOVERY_ABANDON]: true,
            });
          }
        } catch {
          failures.push({
            taskId,
            code: 'cleanup_failed',
            message: 'Managed task cleanup failed',
          });
        }
      }

      const verification = await runExclusive(async () => (
        collectAgentHandoffTaskIdsLocked(input.rootSessionId)
      ));
      const affectedTaskIds = [...new Set([...taskIds, ...verification])]
        .map((taskId) => tasks.get(taskId))
        .filter(Boolean)
        .sort(compareManagedTaskQueueOrder)
        .map((task) => task.taskId);
      return {
        state: failures.length === 0 && verification.length === 0 ? 'clear' : 'blocked',
        taskIds: affectedTaskIds,
        failures,
      };
    })();
    lock.promise = promise;

    try {
      return await promise;
    } finally {
      if (handoffLocks.get(input.rootSessionId) === lock) {
        handoffLocks.delete(input.rootSessionId);
        void pump().catch((error) => {
          logger.error?.('[ManagedOrchestration] Failed to resume queued work after agent handoff', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  };

  const flush = async () => {
    for (let round = 0; round < 3; round += 1) {
      await Promise.resolve();
      await runExclusive(async () => undefined);
      await publicationTail;
    }
  };

  return {
    initialize,
    submit,
    cancelTask,
    waitForTask,
    waitForResultAction,
    waitForDispatchBarrier,
    inspectDispatchBarrier,
    listReadyProviderRecoveryContinuations,
    claimProviderRecoveryContinuation,
    releaseProviderRecoveryContinuation,
    inspectAgentHandoff,
    confirmAgentHandoff,
    acknowledgeResult,
    setResultAutoResume,
    cancelAutoResumeForSession,
    shutdown,
    releaseModeLease,
    flush,
    getTask(taskId) {
      return cloneTask(tasks.get(taskId));
    },
    listTasks({ rootSessionId } = {}) {
      return [...tasks.values()]
        .filter((task) => !rootSessionId || task.rootSessionId === rootSessionId)
        .sort(compareManagedTaskQueueOrder)
        .map(cloneTask);
    },
    getSnapshot() {
      return snapshotLocked();
    },
    getDiagnostics() {
      return {
        taskCount: tasks.size,
        activeLaunchCount: activeLaunches.size,
        pendingCancellationCount: cancellationPromises.size,
        pendingAcknowledgementCount: acknowledgementPromises.size,
        activeHandoffCount: handoffLocks.size,
        pendingWaiterCount: [...taskWaiters.values(), ...resultActionWaiters.values()]
          .reduce((sum, waiters) => sum + waiters.size, 0),
        pendingTimeoutCount: timeoutTimers.size,
        pendingLeaseCount: startingLeaseTimers.size,
        pendingReconciliationRetryCount: reconciliationRetryTimers.size,
        activeProviderRecoveryContinuationClaimCount: providerRecoveryContinuationClaims.size,
        pendingAutoResumeCount: [...resultEnvelopes.values()].filter(isAutoResumeActive).length,
        providerBreakerCount: providerBreakers.size,
        admissionHeldCount,
        admissionRetryPending: admissionRetryTimer !== null,
        compactedTaskCount,
        serializedBytes: lastSerializedBytes,
        shutDown,
      };
    },
    getResultEnvelope(taskId) {
      const envelope = resultEnvelopes.get(taskId);
      return envelope ? structuredClone(envelope) : null;
    },
    listResultEnvelopes({ rootSessionId } = {}) {
      return [...resultEnvelopes.values()]
        .filter((envelope) => !rootSessionId || envelope.rootSessionId === rootSessionId)
        .sort((left, right) => left.sequence - right.sequence)
        .map((envelope) => structuredClone(envelope));
    },
  };
};
