import { validateTaskPrerequisites } from './task-prerequisites.js';
import {
  MANAGED_TASK_OWNER,
  MAX_MANAGED_TASK_FAILURE_BYTES,
  MAX_MANAGED_TASK_LABEL_BYTES,
  MAX_MANAGED_TASK_PREVIEW_BYTES,
  MANAGED_TASK_WAITING_REASON_KINDS,
  isTerminalManagedTaskStatus,
  truncateManagedText,
  validateManagedTaskRecord,
} from './contract.js';
import {
  AUTO_RESUME_REASONS,
  AUTO_RESUME_RESET_SOURCES,
  AUTO_RESUME_STATES,
  MANAGED_TASK_FAILURE_KINDS,
  MANAGED_TASK_STATUSES,
  MANAGED_WAVE_ID_PREFIX,
  MANAGED_TASK_ID_PREFIX,
  findManagedResultPayloadMismatch,
} from './codec-primitives.js';
import { classifyManagedTaskFailure } from './provider-retry-policy.js';
import {
  assertManagedTaskResultEnvelopeMatchesTask,
  validateManagedTaskAutoResume,
  validateManagedTaskResultEnvelope,
} from './result-envelope.js';
import { validateManagedTransportRecovery } from './transport-recovery.js';
import { decodeRequiredCheckVerification, validateRequiredChecks, validateRequiredCheckReceipts } from './required-checks.js';
import { validateCheckCorrectionHistory } from './check-correction.js';

export * from './codec-primitives.js';

// Owner of the persisted ledger shape and the host-to-UI wire shapes.
//
// Persisted records: fields added after the first ledger release are absent
// from older files. Decoding spreads the stored record and then sets each
// default, so present fields keep their stored position and absent ones are
// appended in table order. Saved bytes depend on that order; the golden
// fixtures pin it.
const TASK_LEGACY_DEFAULTS = Object.freeze([
  ['dispatchGroupId', null],
  ['dispatchCallId', null],
  ['dispatchWaveId', null],
  ['readOnly', false],
  ['recoveryLineageId', null],
  ['childPromptedAt', null],
  ['firstAssistantPartAt', null],
  ['waitingReason', null],
]);
const ENVELOPE_LEGACY_DEFAULTS = Object.freeze([
  ['providerResetAt', null],
  ['autoResume', null],
]);

const withLegacyDefaults = (value, defaults) => {
  const record = { ...value };
  for (const [field, fallback] of defaults) record[field] = value?.[field] ?? fallback;
  return record;
};

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A stored task with its legacy defaults, validated. Throws TypeError/RangeError. */
export const decodeManagedTaskRecord = value => validateManagedTaskRecord(withLegacyDefaults(value, TASK_LEGACY_DEFAULTS));

/** A stored result envelope with its legacy defaults, validated. Throws TypeError/RangeError. */
export const decodeResultEnvelope = value => validateManagedTaskResultEnvelope(withLegacyDefaults(value, ENVELOPE_LEGACY_DEFAULTS));

const LEDGER_ERROR_MESSAGES = Object.freeze({
  invalid_ledger_version: () => 'managed orchestration ledger version is invalid',
  invalid_ledger_collections: () => 'managed orchestration ledger collections are invalid',
  invalid_result_envelopes: () => 'managed orchestration ledger collections are invalid',
  duplicate_task: ({ taskId }) => `duplicate managed task ${taskId}`,
  duplicate_idempotency_key: ({ rootSessionId }) => `duplicate managed idempotency key for root ${rootSessionId}`,
  duplicate_result_envelope: ({ taskId }) => `duplicate managed result envelope for task ${taskId}`,
  orphan_result_envelope: ({ taskId }) => `managed result envelope has no task ${taskId}`,
});
const defaultLedgerError = (code, detail) => Object.assign(new TypeError(LEDGER_ERROR_MESSAGES[code](detail)), { code });

/**
 * Decodes a whole ledger: version, legacy defaults, uniqueness of task ids,
 * idempotency keys and envelopes, and each envelope's match with its task.
 *
 * `requireResultEnvelopes` (default true) rejects a ledger without the
 * envelope collection before any task is read; false treats it as empty and
 * checks its type only after the tasks. Structural failures go through
 * `createError(code, detail)` so each caller keeps its own error class; record
 * validation failures are thrown as the validators raise them.
 */
export const decodeLedgerSnapshot = (value, { requireResultEnvelopes = true, createError = defaultLedgerError } = {}) => {
  if (!isRecord(value) || value.version !== 1) throw createError('invalid_ledger_version', {});
  if (!Array.isArray(value.tasks) || (requireResultEnvelopes && !Array.isArray(value.resultEnvelopes))) {
    throw createError('invalid_ledger_collections', {});
  }
  if (value.objectiveChecks !== undefined) {
    if (!Array.isArray(value.objectiveChecks)) throw new TypeError('Invalid objective checks');
    const identities = new Set();
    for (const record of value.objectiveChecks) {
      if (!isRecord(record) || Object.keys(record).some(key => !['rootSessionId','directory','objectiveId','requiredChecks','requiredCheckReceipts','requiredCheckCorrections','updatedAt'].includes(key))
        || [record.rootSessionId, record.directory, record.objectiveId].some(part => typeof part !== 'string' || !part || part.length > 4096)
        || record.updatedAt !== undefined && (!Number.isFinite(record.updatedAt) || record.updatedAt < 0)) throw new TypeError('Invalid objective check scope');
      const key = JSON.stringify([record.rootSessionId, record.directory, record.objectiveId]);
      if (identities.has(key)) throw new TypeError('Duplicate objective check scope');
      identities.add(key);
      validateRequiredChecks(record.requiredChecks);
      validateRequiredCheckReceipts(record.requiredCheckReceipts, record.requiredChecks);
      validateCheckCorrectionHistory(record.requiredCheckCorrections);
    }
  }
  const tasksById = new Map();
  const tasks = [];
  const idempotencyKeys = new Set();
  for (const candidate of value.tasks) {
    const task = decodeManagedTaskRecord(candidate);
    if (tasksById.has(task.taskId)) throw createError('duplicate_task', { taskId: task.taskId });
    const key = `${task.rootSessionId}\u0000${task.idempotencyKey}`;
    if (idempotencyKeys.has(key)) throw createError('duplicate_idempotency_key', { rootSessionId: task.rootSessionId });
    tasksById.set(task.taskId, task);
    tasks.push(task);
    idempotencyKeys.add(key);
  }
  const candidates = value.resultEnvelopes ?? [];
  if (!Array.isArray(candidates)) throw createError('invalid_result_envelopes', {});
  const envelopeTaskIds = new Set();
  const resultEnvelopes = [];
  for (const candidate of candidates) {
    const envelope = decodeResultEnvelope(candidate);
    const detail = { taskId: envelope.taskId, envelopeId: envelope.envelopeId };
    if (envelopeTaskIds.has(envelope.taskId)) throw createError('duplicate_result_envelope', detail);
    const task = tasksById.get(envelope.taskId);
    if (!task) throw createError('orphan_result_envelope', detail);
    assertManagedTaskResultEnvelopeMatchesTask(task, envelope);
    envelopeTaskIds.add(envelope.taskId);
    resultEnvelopes.push(envelope);
  }
  return { ...value, tasks, resultEnvelopes };
};

/** The persisted ledger bytes (as text): a fully decoded snapshot, one line. */
export const encodeLedgerSnapshot = snapshot => `${JSON.stringify(decodeLedgerSnapshot(snapshot))}\n`;

// Wire decoders for host payloads (task events, snapshots). They never throw
// for a bad record: a record that cannot be shown decodes to null. `strict`
// also rejects an invalid or unknown autoResume or waitingReason; `lenient`
// degrades either one to null, so a newer host's state never hides a result.
const DECODE_MODES = new Set(['strict', 'lenient']);
const readMode = options => {
  const mode = options?.mode ?? 'strict';
  if (!DECODE_MODES.has(mode)) throw new TypeError('decode mode must be strict or lenient');
  return mode;
};

const STATUS_SET = new Set(MANAGED_TASK_STATUSES);
const FAILURE_KIND_SET = new Set(MANAGED_TASK_FAILURE_KINDS);
const AUTO_RESUME_STATE_SET = new Set(AUTO_RESUME_STATES);
const AUTO_RESUME_REASON_SET = new Set(AUTO_RESUME_REASONS);
const AUTO_RESUME_RESET_SOURCE_SET = new Set(AUTO_RESUME_RESET_SOURCES);
const WAITING_REASON_KIND_SET = new Set(MANAGED_TASK_WAITING_REASON_KINDS);
const EXECUTION_KINDS = new Set(['start', 'retry', 'resume', 'recover_in_place', 'retry_in_place']);
const WIRE_TEXT_BYTES = 1_024;
const WIRE_MAX_REFS = 512;

const isNonEmptyString = value => typeof value === 'string' && Boolean(value.trim());
const isNullableString = value => value === null || typeof value === 'string';
const isOptionalNullableString = value => value === undefined || isNullableString(value);
const isTimestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isNullableTimestamp = value => value === null || isTimestamp(value);
const isOptionalNullableTimestamp = value => value === undefined || isNullableTimestamp(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isCanonicalReference = value => isRecord(value) && isNonEmptyString(value.type) && isNonEmptyString(value.id);
const bounded = value => truncateManagedText(value, WIRE_TEXT_BYTES);
const boundedNullable = value => value === null ? null : bounded(value);
const projectRefs = refs => refs.slice(0, WIRE_MAX_REFS).map(reference => ({ type: bounded(reference.type), id: bounded(reference.id) }));

/** A queued task's hold reason, or null when absent or malformed. */
export const decodeManagedTaskWaitingReason = (value) => {
  if (!isRecord(value) || !WAITING_REASON_KIND_SET.has(value.kind) || !isCount(value.activeCount)
    || (value.limit !== null && !isCount(value.limit)) || !isTimestamp(value.since)) return null;
  return { kind: value.kind, activeCount: value.activeCount, limit: value.limit, since: value.since };
};

const decodeAutoResumeTarget = (value) => {
  if (value === null) return null;
  if (!isRecord(value) || (value.kind !== 'backup' && value.kind !== 'original') || !isNonEmptyString(value.providerId)
    || !isNonEmptyString(value.modelId) || !isNullableString(value.variant)) return undefined;
  return { kind: value.kind, providerId: bounded(value.providerId), modelId: bounded(value.modelId), variant: boundedNullable(value.variant) };
};

const decodeAutoResumeError = (value) => {
  if (value === null) return null;
  if (!isRecord(value) || !isNonEmptyString(value.code) || typeof value.message !== 'string' || !isTimestamp(value.at)) return undefined;
  return { code: bounded(value.code), message: truncateManagedText(value.message, MAX_MANAGED_TASK_FAILURE_BYTES), at: value.at };
};

/**
 * A result envelope's auto-resume block as the host sent it, or null when it
 * is not a complete, well-typed block. An unknown `reason` reads as null.
 */
export const decodeManagedTaskAutoResume = (value) => {
  if (!isRecord(value)) return null;
  const target = decodeAutoResumeTarget(value.target);
  const lastError = decodeAutoResumeError(value.lastError);
  if (target === undefined || lastError === undefined) return null;
  const valid = isCount(value.revision)
    && (value.trigger === undefined || value.trigger === 'provider_usage_limit' || value.trigger === 'provider_transport')
    && typeof value.enabled === 'boolean'
    && AUTO_RESUME_STATE_SET.has(value.state)
    && isCount(value.cancelGeneration)
    && isTimestamp(value.lineageStartedAt)
    && isTimestamp(value.expiresAt)
    && isCount(value.attemptCount)
    && isCount(value.noSignalProbes)
    && isCount(value.rejectionsInWindow)
    && isNullableTimestamp(value.windowResetAt)
    && isNullableTimestamp(value.nextAttemptAt)
    && isNullableTimestamp(value.resetAt)
    && (value.resetSource === null || AUTO_RESUME_RESET_SOURCE_SET.has(value.resetSource))
    && isNullableString(value.recoveryCycleTaskId ?? null)
    && isNullableString(value.backupAttemptTaskId ?? null)
    && isNullableString(value.lastAttemptTaskId)
    && isNullableTimestamp(value.lastAttemptAt)
    && isCount(value.hostFailures)
    && isNullableString(value.reason);
  if (!valid) return null;
  return {
    revision: value.revision,
    ...(value.trigger === undefined ? {} : { trigger: value.trigger }),
    enabled: value.enabled,
    state: value.state,
    cancelGeneration: value.cancelGeneration,
    lineageStartedAt: value.lineageStartedAt,
    expiresAt: value.expiresAt,
    attemptCount: value.attemptCount,
    noSignalProbes: value.noSignalProbes,
    rejectionsInWindow: value.rejectionsInWindow,
    windowResetAt: value.windowResetAt,
    nextAttemptAt: value.nextAttemptAt,
    resetAt: value.resetAt,
    resetSource: value.resetSource,
    target,
    recoveryCycleTaskId: typeof value.recoveryCycleTaskId === 'string' ? bounded(value.recoveryCycleTaskId) : null,
    backupAttemptTaskId: typeof value.backupAttemptTaskId === 'string' ? bounded(value.backupAttemptTaskId) : null,
    lastAttemptTaskId: boundedNullable(value.lastAttemptTaskId),
    lastAttemptAt: value.lastAttemptAt,
    lastError,
    hostFailures: value.hostFailures,
    reason: AUTO_RESUME_REASON_SET.has(value.reason) ? value.reason : null,
  };
};

const isWireTaskRecord = value => value.owner === MANAGED_TASK_OWNER
  && typeof value.taskId === 'string' && value.taskId.startsWith(MANAGED_TASK_ID_PREFIX)
  && isNonEmptyString(value.rootSessionId)
  && isOptionalNullableString(value.dispatchCallId)
  && (value.dispatchGrouped === undefined || typeof value.dispatchGrouped === 'boolean')
  && isOptionalNullableString(value.dispatchWaveId)
  && isNullableString(value.parentTaskId)
  && isNullableString(value.childSessionId)
  && isNonEmptyString(value.directory)
  && Number.isSafeInteger(value.sequence) && value.sequence > 0
  && (value.mode === 'builder' || value.mode === 'orchestrator')
  && isNonEmptyString(value.providerId)
  && isNonEmptyString(value.modelId)
  && isNonEmptyString(value.agent)
  && isNullableString(value.variant)
  && typeof value.label === 'string'
  && STATUS_SET.has(value.status)
  && Number.isSafeInteger(value.attempt) && value.attempt > 0
  && isNullableString(value.priorTaskId)
  && EXECUTION_KINDS.has(value.executionKind)
  && isTimestamp(value.createdAt)
  && isNullableTimestamp(value.startedAt)
  && isNullableTimestamp(value.finishedAt)
  && isNullableTimestamp(value.timeoutAt)
  && isNullableString(value.failureReason)
  && (value.failureKind === undefined || value.failureKind === null || FAILURE_KIND_SET.has(value.failureKind))
  && typeof value.partial === 'boolean'
  && typeof value.recoverablePreview === 'string'
  && Array.isArray(value.canonicalRefs) && value.canonicalRefs.every(isCanonicalReference)
  && typeof value.agentRetryAvailable === 'boolean'
  && (value.terminationIntent === undefined || value.terminationIntent === null || value.terminationIntent === 'user_stopped')
  && (value.stoppedRecoveryAvailable === undefined || typeof value.stoppedRecoveryAvailable === 'boolean')
  && (value.userStoppedRecoveryAvailable === undefined || typeof value.userStoppedRecoveryAvailable === 'boolean')
  && (value.manualRecoveryRequired === undefined || typeof value.manualRecoveryRequired === 'boolean')
  // Automatic-recovery fields; absent on older hosts.
  && isOptionalNullableString(value.recoveryLineageId)
  && isOptionalNullableTimestamp(value.childPromptedAt)
  && isOptionalNullableTimestamp(value.firstAssistantPartAt);

/**
 * A task record from a task event or snapshot, bounded for display, or null.
 * Strict mode also rejects a waitingReason that is malformed or set on a task
 * that is not queued; lenient mode reads it as null.
 */
export const decodeTaskEventRecord = (value, options) => {
  const mode = readMode(options);
  if (!isRecord(value) || !isWireTaskRecord(value)) return null;
  const verification = value.verification === undefined ? undefined : decodeRequiredCheckVerification(value.verification);
  if (value.verification !== undefined && !verification) return null;
  try { validateRequiredChecks(value.requiredChecks); validateTaskPrerequisites(value.taskPrerequisites); } catch { return null; }
  let transportRecovery;
  try { transportRecovery = validateManagedTransportRecovery(value.transportRecovery); } catch { return null; }
  const waitingReason = value.status === 'queued' ? decodeManagedTaskWaitingReason(value.waitingReason) : null;
  if (mode === 'strict' && value.waitingReason !== undefined && value.waitingReason !== null && waitingReason === null) return null;
  return {
    owner: MANAGED_TASK_OWNER,
    ...(verification ? { verification } : {}),
    ...(value.requiredChecks?.length ? { requiredChecks: structuredClone(value.requiredChecks) } : {}),
    ...(value.taskPrerequisites?.length ? { taskPrerequisites: structuredClone(value.taskPrerequisites) } : {}),
    taskId: value.taskId,
    rootSessionId: value.rootSessionId,
    dispatchCallId: value.dispatchCallId === null || value.dispatchCallId === undefined ? null : bounded(value.dispatchCallId),
    dispatchGrouped: value.dispatchGrouped === true,
    // Display-only wave label; only a well-formed id is kept, so the chat
    // never groups cards by an arbitrary string.
    dispatchWaveId: typeof value.dispatchWaveId === 'string' && value.dispatchWaveId.startsWith(MANAGED_WAVE_ID_PREFIX)
      ? bounded(value.dispatchWaveId) : null,
    parentTaskId: value.parentTaskId,
    childSessionId: value.childSessionId,
    directory: value.directory,
    sequence: value.sequence,
    mode: value.mode,
    providerId: bounded(value.providerId),
    modelId: bounded(value.modelId),
    agent: bounded(value.agent),
    variant: boundedNullable(value.variant),
    label: truncateManagedText(value.label, MAX_MANAGED_TASK_LABEL_BYTES),
    status: value.status,
    attempt: value.attempt,
    priorTaskId: value.priorTaskId,
    executionKind: value.executionKind,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    timeoutAt: value.timeoutAt,
    failureReason: value.failureReason === null ? null : truncateManagedText(value.failureReason, MAX_MANAGED_TASK_FAILURE_BYTES),
    failureKind: FAILURE_KIND_SET.has(value.failureKind) ? value.failureKind : classifyManagedTaskFailure(value.failureReason),
    partial: value.partial,
    recoverablePreview: truncateManagedText(value.recoverablePreview, MAX_MANAGED_TASK_PREVIEW_BYTES),
    canonicalRefs: projectRefs(value.canonicalRefs),
    agentRetryAvailable: value.agentRetryAvailable,
    ...(value.terminationIntent === undefined ? {} : { terminationIntent: value.terminationIntent }),
    ...(value.stoppedRecoveryAvailable === undefined ? {} : { stoppedRecoveryAvailable: value.stoppedRecoveryAvailable }),
    ...(value.userStoppedRecoveryAvailable === undefined ? {} : { userStoppedRecoveryAvailable: value.userStoppedRecoveryAvailable }),
    ...(value.manualRecoveryRequired === undefined ? {} : { manualRecoveryRequired: value.manualRecoveryRequired }),
    recoveryLineageId: typeof value.recoveryLineageId === 'string' ? bounded(value.recoveryLineageId) : null,
    childPromptedAt: isTimestamp(value.childPromptedAt) ? value.childPromptedAt : null,
    firstAssistantPartAt: isTimestamp(value.firstAssistantPartAt) ? value.firstAssistantPartAt : null,
    transportRecovery,
    waitingReason,
  };
};

/**
 * A result envelope from a task event, snapshot or action response, bounded
 * for display, or null. Strict mode applies the persisted validator to the
 * whole envelope, autoResume included; lenient mode validates the envelope
 * without its autoResume block, keeps an unknown `reason` as null and degrades
 * any other bad block to null.
 */
export const decodeResultEnvelopePayload = (value, options) => {
  const mode = readMode(options);
  if (!isRecord(value)) return null;
  const { autoResume: rawAutoResume, ...withoutAutoResume } = value;
  let envelope;
  try { envelope = validateManagedTaskResultEnvelope(mode === 'strict' ? value : withoutAutoResume); } catch { return null; }
  if (!envelope.canonicalRefs.every(isCanonicalReference)) return null;
  // A block the persisted validator accepts is read in its normalized form
  // (absent counters as 0); strict mode already rejected every other block.
  let normalizedAutoResume = null;
  try { normalizedAutoResume = validateManagedTaskAutoResume(rawAutoResume); } catch { /* Lenient: read as sent. */ }
  const autoResume = decodeManagedTaskAutoResume(normalizedAutoResume ?? rawAutoResume);
  return {
    owner: MANAGED_TASK_OWNER,
    envelopeId: envelope.envelopeId,
    taskId: envelope.taskId,
    rootSessionId: envelope.rootSessionId,
    parentTaskId: envelope.parentTaskId,
    childSessionId: envelope.childSessionId,
    directory: envelope.directory,
    sequence: envelope.sequence,
    status: envelope.status,
    partial: envelope.partial,
    failureReason: envelope.failureReason === null ? null : truncateManagedText(envelope.failureReason, MAX_MANAGED_TASK_FAILURE_BYTES),
    attempt: envelope.attempt,
    priorTaskId: envelope.priorTaskId,
    executionKind: envelope.executionKind,
    recoverablePreview: truncateManagedText(envelope.recoverablePreview, MAX_MANAGED_TASK_PREVIEW_BYTES),
    canonicalRefs: projectRefs(envelope.canonicalRefs),
    resumable: envelope.resumable,
    createdAt: envelope.createdAt,
    acknowledgedAt: envelope.acknowledgedAt,
    action: envelope.action,
    followUpTaskId: envelope.followUpTaskId,
    providerResetAt: isTimestamp(value.providerResetAt) ? value.providerResetAt : null,
    autoResume,
  };
};

/** Whether a decoded envelope carries the same result payload as its decoded task. */
export const decodedEnvelopeMatchesTask = (task, envelope) => findManagedResultPayloadMismatch(task, envelope) === null;

/**
 * The properties of an `devryan:managed-task` event as `{task,
 * resultEnvelope}`, or null when the event cannot be shown. An envelope that
 * is present must decode and match its task.
 */
export const decodeTaskEventPayload = (properties, options) => {
  const mode = readMode(options);
  if (!isRecord(properties) || properties.owner !== MANAGED_TASK_OWNER) return null;
  const task = decodeTaskEventRecord(properties.task, { mode });
  if (!task || properties.directory !== task.directory) return null;
  if (properties.resultEnvelope === undefined) return { task, resultEnvelope: null };
  const resultEnvelope = decodeResultEnvelopePayload(properties.resultEnvelope, { mode });
  return resultEnvelope && decodedEnvelopeMatchesTask(task, resultEnvelope) ? { task, resultEnvelope } : null;
};

const invalidSnapshot = () => new TypeError('Managed orchestration returned an invalid snapshot');

/**
 * The HTTP snapshot. Unlike the per-record decoders it throws TypeError: one
 * undecodable task, duplicate, unmatched envelope or terminal task without an
 * envelope makes the whole snapshot unusable.
 */
export const decodeSnapshotPayload = (value, options) => {
  const mode = readMode(options);
  if (!isRecord(value) || typeof value.available !== 'boolean' || typeof value.bridgeReady !== 'boolean'
    || (value.dispatchReady !== undefined && typeof value.dispatchReady !== 'boolean')
    || !isNullableString(value.recoveryWarning) || !Array.isArray(value.tasks) || !Array.isArray(value.resultEnvelopes)) {
    throw invalidSnapshot();
  }
  const tasks = [];
  const tasksById = new Map();
  for (const candidate of value.tasks) {
    const task = decodeTaskEventRecord(candidate, { mode });
    if (!task || tasksById.has(task.taskId)) throw invalidSnapshot();
    tasks.push(task);
    tasksById.set(task.taskId, task);
  }
  const resultEnvelopes = [];
  const envelopeTaskIds = new Set();
  for (const candidate of value.resultEnvelopes) {
    const envelope = decodeResultEnvelopePayload(candidate, { mode });
    const task = envelope ? tasksById.get(envelope.taskId) : null;
    if (!envelope || !task || envelopeTaskIds.has(envelope.taskId) || !decodedEnvelopeMatchesTask(task, envelope)) throw invalidSnapshot();
    resultEnvelopes.push(envelope);
    envelopeTaskIds.add(envelope.taskId);
  }
  if (tasks.some(task => isTerminalManagedTaskStatus(task.status) && !envelopeTaskIds.has(task.taskId))) throw invalidSnapshot();
  return {
    available: value.available,
    bridgeReady: value.bridgeReady,
    dispatchReady: value.dispatchReady === undefined ? value.bridgeReady : value.dispatchReady === true,
    recoveryWarning: value.recoveryWarning === null ? null : truncateManagedText(value.recoveryWarning, MAX_MANAGED_TASK_FAILURE_BYTES),
    tasks,
    resultEnvelopes,
  };
};
