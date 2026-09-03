import { requiresManualModelRecovery } from './contract.js';
import { supportsManagedReadOnlyProvider } from './provider-capabilities.js';
import { isDefiniteProviderUsageLimit } from './provider-retry-policy.js';

/**
 * Pure planning policy for automatically resuming a managed task that parked on
 * a definite provider usage limit. The scheduler owns the timers, the ledger, and
 * the provider breakers; this module only decides what the next durable state is.
 */
export const AUTO_RESUME_MAX_ATTEMPTS = 8;
export const AUTO_RESUME_MAX_LINEAGE_MS = 6 * 60 * 60 * 1_000;
export const AUTO_RESUME_BACKOFF_MS = Object.freeze([
  15 * 60 * 1_000,
  30 * 60 * 1_000,
  60 * 60 * 1_000,
]);
export const AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW = 2;
export const AUTO_RESUME_MAX_HOST_FAILURES = 5;
export const AUTO_RESUME_RESET_JITTER_MS = 15_000;
export const AUTO_RESUME_MIN_DELAY_MS = 5_000;
export const AUTO_RESUME_HOST_RETRY_MS = 60_000;
export const AUTO_RESUME_ACTIVE_STATES = Object.freeze(['planning', 'scheduled', 'attempting']);
export const MANAGED_LINEAGE_ID_PREFIX = 'dvr_lineage_';

const ACTIVE_STATES = new Set(AUTO_RESUME_ACTIVE_STATES);
const TASK_ID_PREFIX = 'dvr_task_';

const futureTimestamp = (value, now) => (
  Number.isFinite(value) && value > now ? value : null
);

const nonNegativeTimestamp = (value) => (
  Number.isFinite(value) && value >= 0 ? value : null
);

/**
 * The lineage id shared by every follow-up of one root task. The root itself
 * keeps `recoveryLineageId: null`; derive its lineage with this function.
 */
export const createLineageId = (rootTaskId) => {
  if (typeof rootTaskId !== 'string' || !rootTaskId.startsWith(TASK_ID_PREFIX)) {
    throw new TypeError('rootTaskId must be a managed task id');
  }
  return `${MANAGED_LINEAGE_ID_PREFIX}${rootTaskId.slice(TASK_ID_PREFIX.length)}`;
};

export const isAutoResumeEligible = (task, envelope) => Boolean(
  envelope
  && envelope.action === null
  && isDefiniteProviderUsageLimit(task?.failureReason)
  && requiresManualModelRecovery(task, envelope),
);

export const isAutoResumeActive = (envelope) => {
  const state = envelope?.autoResume;
  return Boolean(state && state.enabled === true && ACTIVE_STATES.has(state.state));
};

/**
 * The state a freshly parked task starts from. Counters, caps, and the cancel
 * generation are inherited only when `prior` is the still-`attempting` state of
 * the task this park continues (`prior.lastAttemptTaskId === taskId`); anything
 * else — a manual retry in particular — restarts the budget.
 */
export const initialAutoResumeState = ({ now, enabled, providerResetAt, prior = null, taskId = null }) => {
  const inherit = Boolean(
    prior
    && prior.state === 'attempting'
    && (taskId === null || prior.lastAttemptTaskId === taskId),
  );
  const resetAt = futureTimestamp(providerResetAt, now)
    ?? (inherit ? futureTimestamp(prior.resetAt, now) : null);
  return {
    revision: 1,
    enabled: Boolean(enabled),
    state: 'planning',
    cancelGeneration: inherit ? prior.cancelGeneration : 0,
    lineageStartedAt: inherit ? prior.lineageStartedAt : now,
    expiresAt: inherit ? prior.expiresAt : now + AUTO_RESUME_MAX_LINEAGE_MS,
    attemptCount: inherit ? prior.attemptCount : 0,
    noSignalProbes: inherit ? prior.noSignalProbes : 0,
    rejectionsInWindow: inherit ? prior.rejectionsInWindow : 0,
    windowResetAt: inherit ? prior.windowResetAt : null,
    nextAttemptAt: null,
    resetAt,
    resetSource: resetAt === null
      ? null
      : (inherit && resetAt === prior.resetAt ? prior.resetSource ?? 'opencode_status' : 'opencode_status'),
    target: null,
    lastAttemptTaskId: inherit ? prior.lastAttemptTaskId : null,
    lastAttemptAt: inherit ? prior.lastAttemptAt : null,
    lastError: null,
    hostFailures: inherit ? prior.hostFailures : 0,
    reason: null,
  };
};

/**
 * Records one provider rejection against the lineage. A rejection lands in the
 * current window while that window has not reset yet (or while the provider keeps
 * reporting the same reset); otherwise it opens a new window. A rejection without
 * a reset hint counts as a no-signal probe for the backoff ladder.
 */
export const recordProviderRejection = (state, { now, providerResetAt }) => {
  const rawReset = nonNegativeTimestamp(providerResetAt);
  const resetAt = futureTimestamp(rawReset, now);
  const sameWindow = state.windowResetAt !== null && (
    now < state.windowResetAt
    || (rawReset !== null && Math.abs(rawReset - state.windowResetAt) <= AUTO_RESUME_RESET_JITTER_MS)
  );
  const knownReset = resetAt ?? (sameWindow ? futureTimestamp(state.resetAt, now) : null);
  return {
    ...state,
    rejectionsInWindow: sameWindow ? state.rejectionsInWindow + 1 : 1,
    windowResetAt: sameWindow ? state.windowResetAt : resetAt,
    noSignalProbes: resetAt === null ? state.noSignalProbes + 1 : state.noSignalProbes,
    resetAt: knownReset,
    resetSource: knownReset === null
      ? null
      : (resetAt !== null ? 'opencode_status' : state.resetSource ?? 'opencode_status'),
  };
};

const readBreaker = (breakerUntil, providerId, now) => {
  const value = typeof breakerUntil === 'function' ? breakerUntil(providerId) : null;
  if (value === null || value === undefined) return { until: null, source: null };
  if (typeof value === 'number') return { until: futureTimestamp(value, now), source: null };
  return {
    until: futureTimestamp(value.until, now),
    source: typeof value.source === 'string' ? value.source : null,
  };
};

/**
 * Decides the next attempt for a parked task. `origin` is the execution the
 * lineage started on (defaults to the task's own); the scheduler passes the
 * lineage root so an attempt that ran on the backup still returns to the model
 * the user chose once the original provider resets.
 */
export const planAutoResumeAttempt = ({
  now,
  task,
  state,
  backup = null,
  breakerUntil = null,
  providerReset = null,
  origin = null,
}) => {
  const originExecution = {
    providerId: origin?.providerId ?? task.providerId,
    modelId: origin?.modelId ?? task.modelId,
    variant: origin?.variant === undefined ? (task.variant ?? null) : origin.variant,
  };
  const exhausted = (reason) => ({ state: 'exhausted', reason });
  if (state.attemptCount >= AUTO_RESUME_MAX_ATTEMPTS) return exhausted('attempt_cap');
  if (now >= state.expiresAt) return exhausted('time_cap');

  const originalTarget = { kind: 'original', ...originExecution };
  const scheduleOriginal = (nextAttemptAt, resetAt, resetSource) => (
    nextAttemptAt > state.expiresAt
      ? exhausted('time_cap')
      : { state: 'scheduled', nextAttemptAt, target: originalTarget, resetAt, resetSource }
  );

  if (state.rejectionsInWindow > AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW) {
    return exhausted('window_rejections');
  }
  const windowResetAt = futureTimestamp(state.windowResetAt, now);
  if (state.rejectionsInWindow >= AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW && windowResetAt !== null) {
    return scheduleOriginal(
      windowResetAt + AUTO_RESUME_RESET_JITTER_MS,
      windowResetAt,
      'opencode_status',
    );
  }

  const originBreaker = readBreaker(breakerUntil, originExecution.providerId, now);
  const knownResets = [
    [futureTimestamp(state.resetAt, now), state.resetSource ?? 'opencode_status'],
    [
      providerReset && providerReset.limited !== false
        ? futureTimestamp(providerReset.resetAt, now)
        : null,
      'meridian_quota',
    ],
    [originBreaker.until, originBreaker.source ?? 'opencode_status'],
  ]
    .filter(([at]) => at !== null)
    .sort((left, right) => left[0] - right[0]);
  const earliestReset = knownResets[0] ?? null;

  const backupDiffers = Boolean(backup)
    && typeof backup.providerId === 'string'
    && typeof backup.modelId === 'string'
    && (backup.providerId !== originExecution.providerId || backup.modelId !== originExecution.modelId);
  if (
    backupDiffers
    && (!task.readOnly || supportsManagedReadOnlyProvider(backup.providerId))
    && readBreaker(breakerUntil, backup.providerId, now).until === null
  ) {
    return {
      state: 'scheduled',
      nextAttemptAt: now,
      target: {
        kind: 'backup',
        providerId: backup.providerId,
        modelId: backup.modelId,
        variant: backup.variant ?? null,
      },
      resetAt: earliestReset?.[0] ?? null,
      resetSource: earliestReset?.[1] ?? null,
    };
  }

  if (earliestReset) {
    const [resetAt, resetSource] = earliestReset;
    return scheduleOriginal(
      Math.max(now + AUTO_RESUME_MIN_DELAY_MS, resetAt + AUTO_RESUME_RESET_JITTER_MS),
      resetAt,
      resetSource,
    );
  }

  const ladderIndex = Math.min(
    Math.max(state.noSignalProbes, 1) - 1,
    AUTO_RESUME_BACKOFF_MS.length - 1,
  );
  const nextAttemptAt = now + AUTO_RESUME_BACKOFF_MS[ladderIndex];
  return scheduleOriginal(nextAttemptAt, nextAttemptAt, 'backoff');
};

/**
 * The `acknowledgeResult` call one attempt makes. The idempotency key folds in
 * the cancel generation and the post-increment attempt count, so a retried host
 * call collapses onto the follow-up it already created and a cancelled
 * generation can never reuse a key.
 */
export const buildAutoResumeAcknowledgeParams = ({ task, envelope }) => {
  const state = envelope?.autoResume;
  if (!state || !state.target) {
    throw new TypeError('auto-resume attempts require a scheduled target');
  }
  return {
    taskId: task.taskId,
    rootSessionId: task.rootSessionId,
    directory: task.directory,
    action: 'retry_in_place',
    idempotencyKey: `auto-resume:${task.taskId}:${state.cancelGeneration}:${state.attemptCount}`,
    providerId: state.target.providerId,
    modelId: state.target.modelId,
    variant: state.target.variant ?? null,
    autoResumeGeneration: state.cancelGeneration,
  };
};
