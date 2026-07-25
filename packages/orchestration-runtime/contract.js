import {
  PROVIDER_USAGE_LIMIT_FAILURE_KIND,
  classifyProviderRetryFailure,
} from './provider-retry-policy.js';

export const MANAGED_TASK_OWNER = 'devryan';

export const MANAGED_TASK_STATUSES = Object.freeze([
  'queued',
  'starting',
  'running',
  'completed',
  'failed',
  'aborted',
  'interrupted',
]);

export const MAX_MANAGED_TASK_LABEL_BYTES = 512;
export const MAX_MANAGED_TASK_PROMPT_BYTES = 256 * 1024;
export const MAX_MANAGED_TASK_PREVIEW_BYTES = 64 * 1024;
export const MAX_MANAGED_TASK_FAILURE_BYTES = 16 * 1024;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const STATUS_SET = new Set(MANAGED_TASK_STATUSES);
const MODE_SET = new Set(['builder', 'orchestrator']);
const EXECUTION_KIND_SET = new Set(['start', 'retry', 'resume', 'recover_in_place', 'retry_in_place']);
const MANAGED_TASK_INITIALISMS = Object.freeze({
  api: 'API',
  cli: 'CLI',
  css: 'CSS',
  html: 'HTML',
  http: 'HTTP',
  json: 'JSON',
  mcp: 'MCP',
  pdf: 'PDF',
  pr: 'PR',
  sdk: 'SDK',
  sse: 'SSE',
  ui: 'UI',
  url: 'URL',
  ux: 'UX',
});
const MANAGED_TASK_LOWERCASE_INTERNAL_WORDS = Object.freeze([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'via', 'vs',
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const utf8ByteLength = (value) => textEncoder.encode(value).byteLength;

export const formatManagedTaskDisplayName = (label) => {
  if (typeof label !== 'string') return '';
  const normalized = label.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const words = normalized.split(' ').filter((word, index, allWords) => (
    index === 0 || word.toLocaleLowerCase() !== allWords[index - 1]?.toLocaleLowerCase()
  ));
  return words.map((word, index) => {
    const lowercase = word.toLowerCase();
    const initialism = Object.hasOwn(MANAGED_TASK_INITIALISMS, lowercase)
      ? MANAGED_TASK_INITIALISMS[lowercase]
      : undefined;
    if (initialism) return initialism;
    if (
      index > 0
      && index < words.length - 1
      && MANAGED_TASK_LOWERCASE_INTERNAL_WORDS.includes(lowercase)
      && word === lowercase
    ) {
      return lowercase;
    }
    return word === lowercase
      ? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
      : word;
  }).join(' ');
};

export const truncateManagedText = (value, maxBytes) => {
  if (typeof value !== 'string') return '';
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let decoded = textDecoder.decode(encoded.slice(0, maxBytes));
  while (decoded && (!value.startsWith(decoded) || utf8ByteLength(decoded) > maxBytes)) {
    decoded = Array.from(decoded).slice(0, -1).join('');
  }
  return decoded;
};

const assertString = (value, field, { prefix, allowEmpty = false, maxBytes } = {}) => {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${field} is required`);
  }
  if (prefix && !value.startsWith(prefix)) {
    throw new TypeError(`${field} must start with ${prefix}`);
  }
  if (maxBytes && utf8ByteLength(value) > maxBytes) {
    throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
};

const assertNullableString = (value, field, options = {}) => {
  if (value === null) return;
  assertString(value, field, options);
};

const assertNullableTimestamp = (value, field) => {
  if (value === null) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite timestamp or null`);
  }
};

const assertJsonCompatible = (value, path = 'record') => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonCompatible(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        throw new TypeError(`${path}.${key} must be JSON-compatible`);
      }
      assertJsonCompatible(entry, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} must be JSON-compatible`);
};

export const isTerminalManagedTaskStatus = (status) => TERMINAL_STATUSES.has(status);

export const validateManagedTaskRecord = (task) => {
  if (!isRecord(task)) {
    throw new TypeError('task must be an object');
  }
  if (task.owner !== MANAGED_TASK_OWNER) {
    throw new TypeError('owner must be devryan');
  }
  assertString(task.taskId, 'taskId', { prefix: 'dvr_task_' });
  assertString(task.idempotencyKey, 'idempotencyKey', { maxBytes: 1024 });
  assertString(task.rootSessionId, 'rootSessionId');
  assertNullableString(task.dispatchGroupId, 'dispatchGroupId', { maxBytes: 1024 });
  assertNullableString(task.parentTaskId, 'parentTaskId', { prefix: 'dvr_task_' });
  assertNullableString(task.childSessionId, 'childSessionId');
  assertString(task.directory, 'directory');
  if (!Number.isSafeInteger(task.sequence) || task.sequence < 1) {
    throw new TypeError('sequence must be a positive safe integer');
  }
  if (!MODE_SET.has(task.mode)) {
    throw new TypeError('mode must be builder or orchestrator');
  }
  assertString(task.providerId, 'providerId');
  assertString(task.modelId, 'modelId');
  assertString(task.agent, 'agent');
  assertNullableString(task.variant, 'variant');
  assertString(task.label, 'label', { maxBytes: MAX_MANAGED_TASK_LABEL_BYTES });
  assertString(task.prompt, 'prompt', { maxBytes: MAX_MANAGED_TASK_PROMPT_BYTES });
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 1) {
    throw new TypeError('attempt must be a positive integer');
  }
  assertNullableString(task.priorTaskId, 'priorTaskId', { prefix: 'dvr_task_' });
  if (!EXECUTION_KIND_SET.has(task.executionKind)) {
    throw new TypeError('executionKind must be start, retry, resume, recover_in_place, or retry_in_place');
  }
  if (!STATUS_SET.has(task.status)) {
    throw new TypeError(`status must be one of ${MANAGED_TASK_STATUSES.join(', ')}`);
  }
  assertNullableString(task.leaseToken, 'leaseToken', { prefix: 'dvr_lease_' });
  assertNullableString(task.failureReason, 'failureReason', {
    maxBytes: MAX_MANAGED_TASK_FAILURE_BYTES,
  });
  if (typeof task.partial !== 'boolean') {
    throw new TypeError('partial must be a boolean');
  }
  assertString(task.recoverablePreview, 'recoverablePreview', {
    allowEmpty: true,
    maxBytes: MAX_MANAGED_TASK_PREVIEW_BYTES,
  });
  if (!Array.isArray(task.canonicalRefs)) {
    throw new TypeError('canonicalRefs must be an array');
  }
  if (!Number.isFinite(task.createdAt) || task.createdAt < 0) {
    throw new TypeError('createdAt must be a non-negative finite timestamp');
  }
  assertNullableTimestamp(task.startedAt, 'startedAt');
  assertNullableTimestamp(task.finishedAt, 'finishedAt');
  assertNullableTimestamp(task.timeoutAt, 'timeoutAt');
  assertJsonCompatible(task, 'task');
  return task;
};

export const createManagedTaskRecord = (input) => {
  if (!isRecord(input)) {
    throw new TypeError('task input must be an object');
  }
  const task = {
    ...input,
    owner: MANAGED_TASK_OWNER,
    status: 'queued',
    dispatchGroupId: input.dispatchGroupId ?? null,
    childSessionId: input.childSessionId ?? null,
    leaseToken: null,
    startedAt: null,
    finishedAt: null,
    failureReason: null,
    partial: false,
    recoverablePreview: '',
    canonicalRefs: [],
  };
  return validateManagedTaskRecord(task);
};

const projectTaskForEvent = (task) => {
  const failureKind = classifyProviderRetryFailure(task.failureReason);
  return {
    owner: task.owner,
    taskId: task.taskId,
    rootSessionId: task.rootSessionId,
    parentTaskId: task.parentTaskId,
    childSessionId: task.childSessionId,
    directory: task.directory,
    sequence: task.sequence,
    mode: task.mode,
    providerId: task.providerId,
    modelId: task.modelId,
    agent: task.agent,
    variant: task.variant,
    label: task.label,
    status: task.status,
    attempt: task.attempt,
    priorTaskId: task.priorTaskId,
    executionKind: task.executionKind,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    timeoutAt: task.timeoutAt,
    failureReason: task.failureReason,
    failureKind,
    partial: task.partial,
    recoverablePreview: task.recoverablePreview,
    canonicalRefs: task.canonicalRefs,
    agentRetryAvailable: (
      task.mode === 'orchestrator'
      && task.dispatchGroupId !== null
      && task.attempt < 2
      && failureKind !== PROVIDER_USAGE_LIMIT_FAILURE_KIND
    ),
  };
};

export const toManagedTaskEvent = (task, resultEnvelope = null) => {
  validateManagedTaskRecord(task);
  if (resultEnvelope !== null) {
    if (
      !isRecord(resultEnvelope)
      || resultEnvelope.owner !== MANAGED_TASK_OWNER
      || resultEnvelope.taskId !== task.taskId
    ) {
      throw new TypeError('resultEnvelope must belong to the managed task');
    }
    assertJsonCompatible(resultEnvelope, 'resultEnvelope');
  }
  return {
    type: 'openchamber:managed-task',
    properties: {
      owner: MANAGED_TASK_OWNER,
      directory: task.directory,
      task: projectTaskForEvent(task),
      ...(resultEnvelope ? { resultEnvelope: structuredClone(resultEnvelope) } : {}),
    },
  };
};

export const toManagedTaskRemovalEvent = (task) => {
  validateManagedTaskRecord(task);
  return {
    type: 'openchamber:managed-task-removed',
    properties: {
      owner: MANAGED_TASK_OWNER,
      taskId: task.taskId,
      rootSessionId: task.rootSessionId,
      directory: task.directory,
      sequence: task.sequence,
    },
  };
};
