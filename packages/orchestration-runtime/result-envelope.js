import {
  MANAGED_TASK_OWNER,
  MAX_MANAGED_TASK_FAILURE_BYTES,
  MAX_MANAGED_TASK_PREVIEW_BYTES,
  isTerminalManagedTaskStatus,
  validateManagedTaskRecord,
} from './contract.js';

const textEncoder = new TextEncoder();
const ACTIONS = new Set(['continue', 'resume', 'retry', 'recover_in_place', 'retry_in_place', 'abandon']);

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
