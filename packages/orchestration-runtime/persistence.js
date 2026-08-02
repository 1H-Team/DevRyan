import { isTerminalManagedTaskStatus } from './contract.js';

export const DEFAULT_MANAGED_TERMINAL_MAX_RECORDS = 2_000;
export const DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEFAULT_MANAGED_LEDGER_MAX_BYTES = 20 * 1024 * 1024;

// Byte length without materializing an intermediate Uint8Array — this runs on
// every task transition against a ledger that can approach the 20MB budget.
const serializedByteLength = typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function'
  ? (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')
  : (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const taskAgeTimestamp = (task) => task.finishedAt ?? task.createdAt;

const terminalOldestFirst = (left, right) => (
  taskAgeTimestamp(left) - taskAgeTimestamp(right)
  || left.sequence - right.sequence
  || left.taskId.localeCompare(right.taskId)
);

const collectProtectedTaskIds = (tasks, envelopes) => {
  const protectedIds = new Set();
  const unacknowledgedTaskIds = new Set(envelopes
    .filter((envelope) => envelope.action === null)
    .map((envelope) => envelope.taskId));
  for (const task of tasks) {
    if (!isTerminalManagedTaskStatus(task.status)) protectedIds.add(task.taskId);
    if (task.dispatchGroupId !== null && unacknowledgedTaskIds.has(task.taskId)) {
      protectedIds.add(task.taskId);
    }
    if (task.priorTaskId) {
      protectedIds.add(task.taskId);
      protectedIds.add(task.priorTaskId);
    }
    if (task.parentTaskId && !isTerminalManagedTaskStatus(task.status)) {
      protectedIds.add(task.parentTaskId);
    }
  }
  return protectedIds;
};

export const compactManagedOrchestrationState = (input, options = {}) => {
  const now = options.now ?? Date.now();
  const maxTerminalRecords = options.maxTerminalRecords ?? DEFAULT_MANAGED_TERMINAL_MAX_RECORDS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MANAGED_LEDGER_MAX_BYTES;
  // `assumeOwnedInput` skips the defensive deep copy. Compaction never mutates
  // task/envelope objects (it only filters arrays), so a caller that passes an
  // already-owned snapshot — the scheduler's persist path, which deep-copies in
  // snapshotLocked() — avoids a second full-ledger clone on every transition.
  const cloneRecord = options.assumeOwnedInput === true ? (record) => record : structuredClone;
  const tasks = Array.isArray(input?.tasks) ? input.tasks.map(cloneRecord) : [];
  const envelopes = Array.isArray(input?.resultEnvelopes)
    ? input.resultEnvelopes.map(cloneRecord)
    : [];
  const protectedIds = collectProtectedTaskIds(tasks, envelopes);
  const removable = tasks
    .filter((task) => isTerminalManagedTaskStatus(task.status) && !protectedIds.has(task.taskId))
    .sort(terminalOldestFirst);
  const removedTaskIds = [];
  const removed = new Set();

  const buildState = () => ({
    version: 1,
    tasks: tasks.filter((task) => !removed.has(task.taskId)),
    resultEnvelopes: envelopes.filter((envelope) => !removed.has(envelope.taskId)),
  });

  const removeTask = (task) => {
    if (removed.has(task.taskId)) return;
    removed.add(task.taskId);
    removedTaskIds.push(task.taskId);
  };

  if (Number.isFinite(maxAgeMs)) {
    for (const task of removable) {
      if (now - taskAgeTimestamp(task) > maxAgeMs) removeTask(task);
    }
  }

  let compacted = buildState();
  let terminalCount = compacted.tasks.filter((task) => isTerminalManagedTaskStatus(task.status)).length;
  if (Number.isFinite(maxTerminalRecords)) {
    for (const task of removable) {
      if (terminalCount <= maxTerminalRecords) break;
      if (removed.has(task.taskId)) continue;
      removeTask(task);
      terminalCount -= 1;
    }
    compacted = buildState();
  }

  let serializedBytes = serializedByteLength(compacted);
  if (Number.isFinite(maxBytes)) {
    for (const task of removable) {
      if (serializedBytes <= maxBytes) break;
      if (removed.has(task.taskId)) continue;
      removeTask(task);
      compacted = buildState();
      serializedBytes = serializedByteLength(compacted);
    }
  }

  terminalCount = compacted.tasks.filter((task) => isTerminalManagedTaskStatus(task.status)).length;
  const overLimit = (
    (Number.isFinite(maxTerminalRecords) && terminalCount > maxTerminalRecords)
    || (Number.isFinite(maxBytes) && serializedBytes > maxBytes)
  );

  return {
    state: compacted,
    removedTaskIds,
    serializedBytes,
    overLimit,
  };
};
