import { createLineageId, isAutoResumeActive } from './auto-resume-policy.js';
import { isTerminalManagedTaskStatus } from './contract.js';

export const DEFAULT_MANAGED_TERMINAL_MAX_RECORDS = 2_000;
// Finished work older than this is dropped. Every task transition clones,
// validates and serializes the whole ledger, so its size is a per-transition
// cost: 90 days of history held 1,670 records and 20.9 MB at the write cap.
export const DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
export const DEFAULT_MANAGED_LEDGER_MAX_BYTES = 20 * 1024 * 1024;
/**
 * Eager bound on acknowledged records per recovery lineage. Auto-resume can chain
 * many in-place attempts under one lineage; once an attempt has been acknowledged
 * (it produced a follow-up or was disposed of) only the newest few are kept, even
 * while the lineage itself is still protected from the ordinary caps.
 */
export const MAX_RETAINED_LINEAGE_RECORDS = 3;

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

// Walks `priorTaskId` to the oldest ancestor still in the ledger. Follow-ups carry
// `recoveryLineageId`; the lineage root (and pre-upgrade follow-ups) do not, so
// the chain walk keeps old and new records in one group.
const lineageKeyOf = (task, taskById) => {
  if (task.recoveryLineageId) return task.recoveryLineageId;
  let current = task;
  const seen = new Set([task.taskId]);
  while (current.priorTaskId && !seen.has(current.priorTaskId)) {
    const prior = taskById.get(current.priorTaskId);
    if (!prior) break;
    seen.add(prior.taskId);
    current = prior;
  }
  return createLineageId(current.taskId);
};

// A root conversation is active while it has unfinished work, or while any of
// its tasks or results changed within `maxAgeMs`.
const collectActiveRoots = (tasks, envelopeByTask, now, maxAgeMs) => {
  const active = new Set();
  for (const task of tasks) {
    if (active.has(task.rootSessionId)) continue;
    const envelope = envelopeByTask.get(task.taskId);
    const latest = Math.max(task.createdAt ?? 0, task.startedAt ?? 0, task.finishedAt ?? 0,
      envelope?.createdAt ?? 0, envelope?.acknowledgedAt ?? 0);
    if (!isTerminalManagedTaskStatus(task.status) || now - latest <= maxAgeMs) active.add(task.rootSessionId);
  }
  return active;
};

/**
 * `hardProtectedIds` can never be removed. `protectedIds` additionally holds the
 * retained attempt lineage of every chain whose newest member still needs its
 * history (non-terminal, unacknowledged, or auto-resuming); those records are
 * shielded from the ordinary caps but remain subject to the eager lineage bound.
 *
 * An unacknowledged result is protected while its root conversation is active.
 * A result nobody collected in a conversation idle for `maxAgeMs` would
 * otherwise be kept forever. `expireUnacknowledged: false` keeps it forever.
 */
const collectProtectedTaskIds = (tasks, envelopes, { now, maxAgeMs, expireUnacknowledged }) => {
  const hardProtectedIds = new Set();
  const protectedIds = new Set();
  const envelopeByTask = new Map(envelopes.map((envelope) => [envelope.taskId, envelope]));
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const priorTaskIds = new Set(tasks.map((task) => task.priorTaskId).filter(Boolean));
  const activeRoots = expireUnacknowledged && Number.isFinite(maxAgeMs)
    ? collectActiveRoots(tasks, envelopeByTask, now, maxAgeMs) : null;
  const isUnacknowledged = (taskId) => envelopeByTask.get(taskId)?.action === null
    && (activeRoots === null || activeRoots.has(taskById.get(taskId)?.rootSessionId));
  const isParked = (task) => (
    isTerminalManagedTaskStatus(task.status)
    && (isUnacknowledged(task.taskId) || isAutoResumeActive(envelopeByTask.get(task.taskId)))
  );
  for (const task of tasks) {
    if (!isTerminalManagedTaskStatus(task.status)) hardProtectedIds.add(task.taskId);
    if (task.dispatchGroupId !== null && isUnacknowledged(task.taskId)) {
      hardProtectedIds.add(task.taskId);
    }
    if (isAutoResumeActive(envelopeByTask.get(task.taskId))) hardProtectedIds.add(task.taskId);
    if (task.parentTaskId && !isTerminalManagedTaskStatus(task.status)) {
      hardProtectedIds.add(task.parentTaskId);
    }
    if (priorTaskIds.has(task.taskId) || !task.priorTaskId) continue;
    // Newest member of a chain. Its history is retained only while it still
    // needs it; a parked task additionally keeps its immediate prior hop
    // outside the eager lineage bound.
    const live = !isTerminalManagedTaskStatus(task.status) || isParked(task);
    if (!live) continue;
    hardProtectedIds.add(task.priorTaskId);
    let current = task;
    while (current) {
      protectedIds.add(current.taskId);
      current = current.priorTaskId ? taskById.get(current.priorTaskId) ?? null : null;
    }
  }
  for (const taskId of hardProtectedIds) protectedIds.add(taskId);
  return { hardProtectedIds, protectedIds, envelopeByTask, taskById };
};

const collectEagerLineageRemovals = ({ tasks, envelopeByTask, taskById, hardProtectedIds }) => {
  const lineages = new Map();
  for (const task of tasks) {
    if (!isTerminalManagedTaskStatus(task.status) || hardProtectedIds.has(task.taskId)) continue;
    const envelope = envelopeByTask.get(task.taskId);
    if (!envelope || envelope.action === null) continue;
    const key = lineageKeyOf(task, taskById);
    const members = lineages.get(key) ?? [];
    members.push(task);
    lineages.set(key, members);
  }
  const removals = [];
  for (const members of lineages.values()) {
    if (members.length <= MAX_RETAINED_LINEAGE_RECORDS) continue;
    members.sort(terminalOldestFirst);
    removals.push(...members.slice(0, members.length - MAX_RETAINED_LINEAGE_RECORDS));
  }
  return removals;
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
  // Array.map passes the index as a second argument, which structuredClone
  // rejects as its options.
  const cloneRecord = options.assumeOwnedInput === true ? (record) => record : (record) => structuredClone(record);
  const tasks = Array.isArray(input?.tasks) ? input.tasks.map(cloneRecord) : [];
  const envelopes = Array.isArray(input?.resultEnvelopes)
    ? input.resultEnvelopes.map(cloneRecord)
    : [];
  const { hardProtectedIds, protectedIds, envelopeByTask, taskById } = collectProtectedTaskIds(tasks, envelopes,
    { now, maxAgeMs, expireUnacknowledged: options.expireUnacknowledged !== false });
  const removable = tasks
    .filter((task) => isTerminalManagedTaskStatus(task.status) && !protectedIds.has(task.taskId))
    .sort(terminalOldestFirst);
  const eagerRemovals = collectEagerLineageRemovals({ tasks, envelopeByTask, taskById, hardProtectedIds });
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

  // Applied before any cap: a lineage's acknowledged history is bounded even when
  // the ledger is otherwise comfortably within its limits.
  for (const task of eagerRemovals) removeTask(task);

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

  // Each retained record is encoded once. Removing one record changes only its
  // bytes and the array separator; rebuilding/serializing the complete ledger
  // for every eviction made byte-pressure compaction quadratic.
  const taskBytes = new Map(compacted.tasks.map(task => [task.taskId, serializedByteLength(task)]));
  const envelopeBytes = new Map();
  for (const envelope of compacted.resultEnvelopes) {
    const previous = envelopeBytes.get(envelope.taskId) ?? { bytes: 0, count: 0 };
    envelopeBytes.set(envelope.taskId, { bytes: previous.bytes + serializedByteLength(envelope), count: previous.count + 1 });
  }
  let taskCount = compacted.tasks.length;
  let envelopeCount = compacted.resultEnvelopes.length;
  const separators = count => Math.max(0, count - 1);
  let serializedBytes = serializedByteLength({ version: 1, tasks: [], resultEnvelopes: [] })
    + [...taskBytes.values()].reduce((total, bytes) => total + bytes, 0)
    + [...envelopeBytes.values()].reduce((total, entry) => total + entry.bytes, 0)
    + separators(taskCount) + separators(envelopeCount);
  if (Number.isFinite(maxBytes)) {
    for (const task of removable) {
      if (serializedBytes <= maxBytes) break;
      if (removed.has(task.taskId)) continue;
      removeTask(task);
      const envelope = envelopeBytes.get(task.taskId) ?? { bytes: 0, count: 0 };
      serializedBytes -= taskBytes.get(task.taskId) + envelope.bytes
        + separators(taskCount) - separators(taskCount - 1)
        + separators(envelopeCount) - separators(envelopeCount - envelope.count);
      taskCount -= 1;
      envelopeCount -= envelope.count;
    }
    compacted = buildState();
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
