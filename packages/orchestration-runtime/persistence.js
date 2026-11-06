import { createLineageId, isAutoResumeActive } from './auto-resume-policy.js';
import { isTerminalManagedTaskStatus } from './contract.js';
import { requiresManagedNativeInputDisposition } from './native-job-segments.js';

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

// A terminal native attempt whose receipts still prove old input disposition or
// await native acknowledgement. Ordinary retention never deletes it; once that
// retention would remove it, it is shrunk into a tombstone instead.
const retainsManagedNativeJobProof = task => isTerminalManagedTaskStatus(task.status)
  && task.executionBackend === 'native-job' && task.nativeJobSegments?.length > 0
  && (requiresManagedNativeInputDisposition(task) || task.nativeJobSegments.some(segment => segment.completion !== 'done'));

/** Fixed prompt of a retained native proof whose prompt and result bodies were released. */
export const MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT = 'Released native job proof';

/** A retained native proof without bodies. It counts toward no record or byte cap. */
export const isManagedNativeJobTombstone = task => retainsManagedNativeJobProof(task)
  && task.prompt === MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT;

// Keeps the identities native recovery, acknowledgement and verified disposal
// read: task, lease, root, directory, child, model selection, status,
// idempotency key, stop receipt, every segment and the envelope ID. Prompt,
// preview, failure text, references, checks, plan, prerequisites, transport
// recovery and dispatch grouping go, as they would with removal. The pair stays
// a valid record and envelope.
const toManagedNativeJobTombstone = (task, envelope) => {
  const {
    approvedPlanRef: _plan, taskPrerequisites: _prerequisites, requiredChecks: _checks,
    requiredCheckReceipts: _receipts, requiredCheckCorrections: _corrections, primaryStepBudget: _budget,
    dispatchObjectiveId: _objective, ...retained
  } = task;
  const released = { failureReason: null, recoverablePreview: '', canonicalRefs: [] };
  return {
    task: {
      ...retained, ...released, prompt: MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT,
      dispatchGroupId: null, dispatchCallId: null, dispatchWaveId: null, transportRecovery: null,
    },
    envelope: envelope ? { ...envelope, ...released } : null,
  };
};

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
  const proofIds = new Set();
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
    if (retainsManagedNativeJobProof(task)) proofIds.add(task.taskId);
    if (!isTerminalManagedTaskStatus(task.status)) {
      hardProtectedIds.add(task.taskId);
      // A queued or running dependent needs the producer's authoritative check.
      for (const ref of task.taskPrerequisites ?? []) if (taskById.has(ref.taskId)) hardProtectedIds.add(ref.taskId);
    }
    if (task.dispatchGroupId !== null && isUnacknowledged(task.taskId)) {
      hardProtectedIds.add(task.taskId);
    }
    // Collecting execution output does not retire its verification requirement.
    // Compaction cannot rehash current sources, so even a cached pass must stay
    // attached until normal disposition or the conversation's retention expiry.
    if (task.dispatchGroupId !== null && envelopeByTask.get(task.taskId)?.action === 'collect'
      && task.requiredChecks?.length > 0 && (activeRoots === null || activeRoots.has(task.rootSessionId))) {
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
  return { hardProtectedIds, protectedIds, proofIds, envelopeByTask, taskById };
};

const collectEagerLineageRemovals = ({ tasks, envelopeByTask, taskById, hardProtectedIds }) => {
  const lineages = new Map();
  for (const task of tasks) {
    if (!isTerminalManagedTaskStatus(task.status) || hardProtectedIds.has(task.taskId) || isManagedNativeJobTombstone(task)) continue;
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
  // task/envelope objects (it filters arrays and builds new tombstones), so a
  // caller that passes an already-owned snapshot — the scheduler's persist path,
  // which deep-copies in snapshotLocked() — avoids a second full-ledger clone on
  // every transition.
  // Array.map passes the index as a second argument, which structuredClone
  // rejects as its options.
  const cloneRecord = options.assumeOwnedInput === true ? (record) => record : (record) => structuredClone(record);
  const tasks = Array.isArray(input?.tasks) ? input.tasks.map(cloneRecord) : [];
  const envelopes = Array.isArray(input?.resultEnvelopes)
    ? input.resultEnvelopes.map(cloneRecord)
    : [];
  const { hardProtectedIds, protectedIds, proofIds, envelopeByTask, taskById } = collectProtectedTaskIds(tasks, envelopes,
    { now, maxAgeMs, expireUnacknowledged: options.expireUnacknowledged !== false });
  const removable = tasks
    .filter((task) => isTerminalManagedTaskStatus(task.status) && !protectedIds.has(task.taskId))
    .sort(terminalOldestFirst);
  const eagerRemovals = collectEagerLineageRemovals({ tasks, envelopeByTask, taskById, hardProtectedIds });
  const removedTaskIds = [];
  const removed = new Set();
  // A retained native proof is never removed here: where retention would remove
  // it, its record and envelope are replaced by their tombstone instead.
  const tombstonedTaskIds = [];
  const tombstones = new Map();
  const isTombstone = (task) => tombstones.has(task.taskId) || isManagedNativeJobTombstone(task);

  const buildState = () => ({
    version: 1,
    ...(input.objectiveChecks?.length ? { objectiveChecks: input.objectiveChecks.map(cloneRecord) } : {}),
    tasks: tasks.filter((task) => !removed.has(task.taskId)).map((task) => tombstones.get(task.taskId)?.task ?? task),
    resultEnvelopes: envelopes.filter((envelope) => !removed.has(envelope.taskId))
      .map((envelope) => tombstones.get(envelope.taskId)?.envelope ?? envelope),
  });

  // Returns the released tombstone, or null after a removal or a no-op.
  const removeTask = (task) => {
    if (removed.has(task.taskId)) return null;
    if (proofIds.has(task.taskId)) {
      if (isTombstone(task)) return null;
      const tombstone = toManagedNativeJobTombstone(task, envelopeByTask.get(task.taskId));
      tombstones.set(task.taskId, tombstone);
      tombstonedTaskIds.push(task.taskId);
      return tombstone;
    }
    removed.add(task.taskId);
    removedTaskIds.push(task.taskId);
    return null;
  };
  const countedTerminal = (state) => state.tasks.filter((task) => isTerminalManagedTaskStatus(task.status) && !isTombstone(task)).length;

  // Applied before any cap: a lineage's acknowledged history is bounded even when
  // the ledger is otherwise comfortably within its limits.
  for (const task of eagerRemovals) removeTask(task);

  if (Number.isFinite(maxAgeMs)) {
    for (const task of removable) {
      if (now - taskAgeTimestamp(task) > maxAgeMs) removeTask(task);
    }
  }

  let compacted = buildState();
  let terminalCount = countedTerminal(compacted);
  if (Number.isFinite(maxTerminalRecords)) {
    for (const task of removable) {
      if (terminalCount <= maxTerminalRecords) break;
      if (removed.has(task.taskId) || isTombstone(task)) continue;
      removeTask(task);
      terminalCount -= 1;
    }
    compacted = buildState();
  }

  // Each retained record is encoded once. Removing one record changes only its
  // bytes and the array separator; rebuilding/serializing the complete ledger
  // for every eviction made byte-pressure compaction quadratic. Tombstone bytes
  // are written but excluded from the byte cap.
  const taskBytes = new Map(compacted.tasks.map(task => [task.taskId, serializedByteLength(task)]));
  const envelopeBytes = new Map();
  for (const envelope of compacted.resultEnvelopes) {
    const previous = envelopeBytes.get(envelope.taskId) ?? { bytes: 0, count: 0 };
    envelopeBytes.set(envelope.taskId, { bytes: previous.bytes + serializedByteLength(envelope), count: previous.count + 1 });
  }
  let taskCount = compacted.tasks.length;
  let envelopeCount = compacted.resultEnvelopes.length;
  const separators = count => Math.max(0, count - 1);
  let serializedBytes = serializedByteLength({ version: 1, ...(input.objectiveChecks?.length ? { objectiveChecks: input.objectiveChecks } : {}), tasks: [], resultEnvelopes: [] })
    + [...taskBytes.values()].reduce((total, bytes) => total + bytes, 0)
    + [...envelopeBytes.values()].reduce((total, entry) => total + entry.bytes, 0)
    + separators(taskCount) + separators(envelopeCount);
  let tombstoneBytes = 0;
  for (const task of compacted.tasks) {
    if (isTombstone(task)) tombstoneBytes += taskBytes.get(task.taskId) + (envelopeBytes.get(task.taskId)?.bytes ?? 0);
  }
  if (Number.isFinite(maxBytes)) {
    for (const task of removable) {
      if (serializedBytes - tombstoneBytes <= maxBytes) break;
      if (removed.has(task.taskId) || isTombstone(task)) continue;
      const envelope = envelopeBytes.get(task.taskId) ?? { bytes: 0, count: 0 };
      const tombstone = removeTask(task);
      if (tombstone) {
        const bytes = serializedByteLength(tombstone.task) + (tombstone.envelope ? serializedByteLength(tombstone.envelope) : 0);
        serializedBytes += bytes - taskBytes.get(task.taskId) - envelope.bytes;
        tombstoneBytes += bytes;
        continue;
      }
      serializedBytes -= taskBytes.get(task.taskId) + envelope.bytes
        + separators(taskCount) - separators(taskCount - 1)
        + separators(envelopeCount) - separators(envelopeCount - envelope.count);
      taskCount -= 1;
      envelopeCount -= envelope.count;
    }
    compacted = buildState();
  }

  terminalCount = countedTerminal(compacted);
  // Every unprotected tombstone, new or already saved inline, may leave the
  // ledger for a proof store. A hard-protected one stays where readers need it.
  const envelopeTaskIds = new Set(compacted.resultEnvelopes.map(envelope => envelope.taskId));
  const proofTaskIds = compacted.tasks.filter(task => isTombstone(task) && !hardProtectedIds.has(task.taskId)
    && envelopeTaskIds.has(task.taskId)).map(task => task.taskId);
  const overLimit = (
    (Number.isFinite(maxTerminalRecords) && terminalCount > maxTerminalRecords)
    || (Number.isFinite(maxBytes) && serializedBytes - tombstoneBytes > maxBytes)
  );

  return {
    state: compacted,
    removedTaskIds,
    tombstonedTaskIds,
    proofTaskIds,
    serializedBytes,
    overLimit,
  };
};
