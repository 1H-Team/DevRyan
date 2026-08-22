import {
  MAX_MANAGED_TASK_FAILURE_BYTES,
  MAX_MANAGED_TASK_PREVIEW_BYTES,
  createManagedTaskRecord,
  isManagedTaskAgentRetryAvailable,
  isTerminalManagedTaskStatus,
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
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE,
  supportsManagedReadOnlyAgent,
} from './provider-capabilities.js';

const ACTIVE_STATUSES = new Set(['starting', 'running']);
const TERMINAL_RESULT_STATUSES = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const AGENT_HANDOFF_MANUAL_RECOVERY_ABANDON = Symbol('agent-handoff-manual-recovery-abandon');

const requiresManualModelRecovery = (task, resultEnvelope) => Boolean(
  task.childSessionId
  && !isManagedTaskAgentRetryAvailable(task)
  && (task.status === 'failed' || task.status === 'interrupted')
  && resultEnvelope?.resumable
  && !isProviderPromptRejected(task.failureReason)
  && (
    isDefiniteProviderUsageLimit(task.failureReason)
    || (task.mode === 'orchestrator' && task.dispatchGroupId !== null && task.attempt >= 2)
  )
);

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
  let initialized = false;
  let initializePromise = null;
  let mutationTail = Promise.resolve();
  let publicationTail = Promise.resolve();
  let recovering = false;
  let compactedTaskCount = 0;
  let lastSerializedBytes = 0;
  let shutDown = false;
  let shutdownPromise = null;

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
      clearTaskTimeout(taskId);
      clearReconciliationRetry(taskId);
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

  const commitTerminalTaskLocked = async (previous, next, { resumable = false } = {}) => {
    assertManagedTaskTransition(previous, next);
    const existingEnvelope = resultEnvelopes.get(next.taskId);
    const envelope = existingEnvelope ?? createManagedTaskResultEnvelope(next, {
      sequence: nextResultSequenceLocked(),
      createdAt: next.finishedAt ?? now(),
      resumable,
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
      });
      changed = true;
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
  });

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

  async function pump() {
    if (shutDown) return;
    const admitted = [];
    await runExclusive(async () => {
      const queued = [...tasks.values()]
        .filter((task) => (
          task.status === 'queued'
          && !(
            task.dispatchGroupId !== null
            && handoffLocks.has(task.rootSessionId)
          )
        ))
        .sort(compareManagedTaskQueueOrder);
      for (const previous of queued) {
        const next = {
          ...previous,
          status: 'starting',
          leaseToken: createLeaseToken(),
          startedAt: now(),
        };
        await commitTaskUpdateLocked(previous, next);
        scheduleStartingLease(next);
        admitted.push(cloneTask(next));
      }
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
            readOnly: rawTask?.readOnly ?? false,
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
          const envelope = validateManagedTaskResultEnvelope(rawEnvelope);
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
      if (isTerminalManagedTaskStatus(task.status)) return cloneTask(task);

      if (task.status === 'queued') {
        await runExclusive(async () => {
          const previous = tasks.get(taskId);
          if (!previous || isTerminalManagedTaskStatus(previous.status)) return;
          const next = {
            ...previous,
            status: 'aborted',
            finishedAt: now(),
            failureReason: reason,
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
      if (currentEnvelope.action !== null) {
        if (currentEnvelope.action !== action) {
          throw new ManagedOrchestrationError(
            'result_already_acknowledged',
            `result is already acknowledged with ${currentEnvelope.action}`,
          );
        }
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
        const next = {
          ...previous,
          acknowledgedAt: now(),
          action,
          followUpTaskId: followUpTask?.taskId ?? null,
        };
        await commitEnvelopeUpdateLocked(previous, next);
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
    inspectAgentHandoff,
    confirmAgentHandoff,
    acknowledgeResult,
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
