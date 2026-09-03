import {
  MANAGED_TASK_OWNER,
  MAX_MANAGED_TASK_FAILURE_BYTES,
  MAX_MANAGED_TASK_PREVIEW_BYTES,
  isTerminalManagedTaskStatus,
  validateManagedTaskRecord,
} from './contract.js';

const textEncoder = new TextEncoder();
const ACTIONS = new Set(['continue', 'resume', 'retry', 'recover_in_place', 'retry_in_place', 'abandon']);
const AUTO_RESUME_STATES = new Set([
  'planning',
  'scheduled',
  'attempting',
  'superseded',
  'succeeded',
  'ended',
  'cancelled',
  'exhausted',
  'acknowledged',
]);
const AUTO_RESUME_RESET_SOURCES = new Set(['opencode_status', 'meridian_quota', 'backoff']);
const AUTO_RESUME_TARGET_KINDS = new Set(['backup', 'original']);
const AUTO_RESUME_REASONS = new Set([
  'user',
  'manual_retry',
  'session_deleted',
  'cancelled',
  'attempt_cap',
  'time_cap',
  'host_failures',
  'window_rejections',
]);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const assertTimestamp = (value, field) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite timestamp`);
  }
};

const assertNullableTimestamp = (value, field) => {
  if (value === null) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite timestamp or null`);
  }
};

const assertCount = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
};

const assertEnum = (value, field, allowed) => {
  if (!allowed.has(value)) {
    throw new TypeError(`${field} must be one of ${[...allowed].join(', ')}`);
  }
};

const assertNullableEnum = (value, field, allowed) => {
  if (value === null) return;
  assertEnum(value, field, allowed);
};

/**
 * Durable auto-resume state carried on a parked provider-limit result envelope.
 * Returns a normalized copy (absent counters default to 0, absent nullable fields
 * to null) or `null` for a null/undefined input. Malformed input throws, so a
 * corrupt ledger is quarantined instead of silently dropping recovery state.
 */
export const validateManagedTaskAutoResume = (value) => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new TypeError('autoResume must be an object or null');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new TypeError('autoResume.revision must be a positive safe integer');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new TypeError('autoResume.enabled must be a boolean');
  }
  assertEnum(value.state, 'autoResume.state', AUTO_RESUME_STATES);
  assertCount(value.cancelGeneration, 'autoResume.cancelGeneration');
  assertTimestamp(value.lineageStartedAt, 'autoResume.lineageStartedAt');
  assertTimestamp(value.expiresAt, 'autoResume.expiresAt');
  const attemptCount = value.attemptCount ?? 0;
  const noSignalProbes = value.noSignalProbes ?? 0;
  const rejectionsInWindow = value.rejectionsInWindow ?? 0;
  const hostFailures = value.hostFailures ?? 0;
  assertCount(attemptCount, 'autoResume.attemptCount');
  assertCount(noSignalProbes, 'autoResume.noSignalProbes');
  assertCount(rejectionsInWindow, 'autoResume.rejectionsInWindow');
  assertCount(hostFailures, 'autoResume.hostFailures');
  const windowResetAt = value.windowResetAt ?? null;
  const nextAttemptAt = value.nextAttemptAt ?? null;
  const resetAt = value.resetAt ?? null;
  const lastAttemptAt = value.lastAttemptAt ?? null;
  assertNullableTimestamp(windowResetAt, 'autoResume.windowResetAt');
  assertNullableTimestamp(nextAttemptAt, 'autoResume.nextAttemptAt');
  assertNullableTimestamp(resetAt, 'autoResume.resetAt');
  assertNullableTimestamp(lastAttemptAt, 'autoResume.lastAttemptAt');
  const resetSource = value.resetSource ?? null;
  assertNullableEnum(resetSource, 'autoResume.resetSource', AUTO_RESUME_RESET_SOURCES);
  const reason = value.reason ?? null;
  assertNullableEnum(reason, 'autoResume.reason', AUTO_RESUME_REASONS);
  const lastAttemptTaskId = value.lastAttemptTaskId ?? null;
  assertNullableString(lastAttemptTaskId, 'autoResume.lastAttemptTaskId', { prefix: 'dvr_task_' });

  let target = null;
  if (value.target !== null && value.target !== undefined) {
    if (!isRecord(value.target)) {
      throw new TypeError('autoResume.target must be an object or null');
    }
    assertEnum(value.target.kind, 'autoResume.target.kind', AUTO_RESUME_TARGET_KINDS);
    assertString(value.target.providerId, 'autoResume.target.providerId');
    assertString(value.target.modelId, 'autoResume.target.modelId');
    const variant = value.target.variant ?? null;
    assertNullableString(variant, 'autoResume.target.variant');
    target = {
      kind: value.target.kind,
      providerId: value.target.providerId,
      modelId: value.target.modelId,
      variant,
    };
  }

  let lastError = null;
  if (value.lastError !== null && value.lastError !== undefined) {
    if (!isRecord(value.lastError)) {
      throw new TypeError('autoResume.lastError must be an object or null');
    }
    assertString(value.lastError.code, 'autoResume.lastError.code');
    assertString(value.lastError.message, 'autoResume.lastError.message', { allowEmpty: true });
    assertTimestamp(value.lastError.at, 'autoResume.lastError.at');
    lastError = {
      code: value.lastError.code,
      message: value.lastError.message,
      at: value.lastError.at,
    };
  }

  return {
    revision: value.revision,
    enabled: value.enabled,
    state: value.state,
    cancelGeneration: value.cancelGeneration,
    lineageStartedAt: value.lineageStartedAt,
    expiresAt: value.expiresAt,
    attemptCount,
    noSignalProbes,
    rejectionsInWindow,
    windowResetAt,
    nextAttemptAt,
    resetAt,
    resetSource,
    target,
    lastAttemptTaskId,
    lastAttemptAt,
    lastError,
    hostFailures,
    reason,
  };
};

const assertString = (value, field, { prefix, allowEmpty = false, maxBytes } = {}) => {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${field} is required`);
  }
  if (prefix && !value.startsWith(prefix)) {
    throw new TypeError(`${field} must start with ${prefix}`);
  }
  if (maxBytes && textEncoder.encode(value).byteLength > maxBytes) {
    throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
};

const assertNullableString = (value, field, options) => {
  if (value === null) return;
  assertString(value, field, options);
};

export const validateManagedTaskResultEnvelope = (envelope) => {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('result envelope must be an object');
  }
  if (envelope.owner !== MANAGED_TASK_OWNER) {
    throw new TypeError('result owner must be devryan');
  }
  assertString(envelope.envelopeId, 'envelopeId', { prefix: 'dvr_result_' });
  assertString(envelope.taskId, 'taskId', { prefix: 'dvr_task_' });
  assertString(envelope.rootSessionId, 'rootSessionId');
  assertNullableString(envelope.parentTaskId, 'parentTaskId', { prefix: 'dvr_task_' });
  assertNullableString(envelope.childSessionId, 'childSessionId');
  assertString(envelope.directory, 'directory');
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) {
    throw new TypeError('result sequence must be a positive safe integer');
  }
  if (!isTerminalManagedTaskStatus(envelope.status)) {
    throw new TypeError('result status must be terminal');
  }
  if (typeof envelope.partial !== 'boolean') {
    throw new TypeError('result partial must be a boolean');
  }
  assertNullableString(envelope.failureReason, 'failureReason', {
    maxBytes: MAX_MANAGED_TASK_FAILURE_BYTES,
  });
  if (!Number.isSafeInteger(envelope.attempt) || envelope.attempt < 1) {
    throw new TypeError('result attempt must be a positive integer');
  }
  assertNullableString(envelope.priorTaskId, 'priorTaskId', { prefix: 'dvr_task_' });
  if (!['start', 'retry', 'resume', 'recover_in_place', 'retry_in_place'].includes(envelope.executionKind)) {
    throw new TypeError('result executionKind is invalid');
  }
  assertString(envelope.recoverablePreview, 'recoverablePreview', {
    allowEmpty: true,
    maxBytes: MAX_MANAGED_TASK_PREVIEW_BYTES,
  });
  if (!Array.isArray(envelope.canonicalRefs)) {
    throw new TypeError('result canonicalRefs must be an array');
  }
  if (typeof envelope.resumable !== 'boolean') {
    throw new TypeError('result resumable must be a boolean');
  }
  if (!Number.isFinite(envelope.createdAt) || envelope.createdAt < 0) {
    throw new TypeError('result createdAt must be a non-negative finite timestamp');
  }
  if (envelope.acknowledgedAt !== null && (!Number.isFinite(envelope.acknowledgedAt) || envelope.acknowledgedAt < 0)) {
    throw new TypeError('result acknowledgedAt must be a non-negative finite timestamp or null');
  }
  if (envelope.action !== null && !ACTIONS.has(envelope.action)) {
    throw new TypeError('result action is invalid');
  }
  assertNullableString(envelope.followUpTaskId, 'followUpTaskId', { prefix: 'dvr_task_' });
  // Slice-2 fields. Absent keys are tolerated (pre-upgrade envelopes and hosts
  // that hydrate before the loaders default them); present keys must be valid.
  if (envelope.providerResetAt !== undefined) {
    assertNullableTimestamp(envelope.providerResetAt, 'result providerResetAt');
  }
  if (envelope.autoResume !== undefined) {
    validateManagedTaskAutoResume(envelope.autoResume);
  }
  JSON.stringify(envelope);
  return envelope;
};

export const createManagedTaskResultEnvelope = (task, options) => {
  validateManagedTaskRecord(task);
  if (!isTerminalManagedTaskStatus(task.status)) {
    throw new Error('result envelopes require a terminal task');
  }
  const sequence = options?.sequence;
  const taskSuffix = task.taskId.slice('dvr_task_'.length);
  const envelope = {
    owner: MANAGED_TASK_OWNER,
    envelopeId: `dvr_result_${taskSuffix}_${sequence}`,
    taskId: task.taskId,
    rootSessionId: task.rootSessionId,
    parentTaskId: task.parentTaskId,
    childSessionId: task.childSessionId,
    directory: task.directory,
    sequence,
    status: task.status,
    partial: task.partial,
    failureReason: task.failureReason,
    attempt: task.attempt,
    priorTaskId: task.priorTaskId,
    executionKind: task.executionKind,
    recoverablePreview: task.recoverablePreview,
    canonicalRefs: task.canonicalRefs.map((reference) => ({ ...reference })),
    resumable: Boolean(options?.resumable && task.childSessionId),
    createdAt: options?.createdAt,
    acknowledgedAt: null,
    action: null,
    followUpTaskId: null,
    providerResetAt: Number.isFinite(options?.providerResetAt) && options.providerResetAt >= 0
      ? options.providerResetAt
      : null,
    autoResume: null,
  };
  return validateManagedTaskResultEnvelope(envelope);
};

export const assertManagedTaskResultEnvelopeMatchesTask = (task, envelope) => {
  validateManagedTaskRecord(task);
  validateManagedTaskResultEnvelope(envelope);

  const fields = [
    'taskId',
    'rootSessionId',
    'parentTaskId',
    'childSessionId',
    'directory',
    'status',
    'partial',
    'failureReason',
    'attempt',
    'priorTaskId',
    'executionKind',
    'recoverablePreview',
  ];
  for (const field of fields) {
    if (!Object.is(task[field], envelope[field])) {
      throw new TypeError(`result envelope ${field} does not match task ${task.taskId}`);
    }
  }

  if (JSON.stringify(task.canonicalRefs) !== JSON.stringify(envelope.canonicalRefs)) {
    throw new TypeError(`result envelope canonicalRefs do not match task ${task.taskId}`);
  }

  return envelope;
};
