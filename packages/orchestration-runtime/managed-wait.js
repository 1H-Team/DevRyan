import { isTerminalManagedTaskStatus, requiresManualModelRecovery } from './contract.js';
import { isAutoResumeActive } from './auto-resume-policy.js';

const CURSOR_PREFIX = 'dvr_wait_v2:';
const LEGACY_CURSOR_PREFIX = 'dvr_wait_v1:';
const selectedScope = (taskIds) => taskIds === null ? null : [...new Set(taskIds)].sort();

export const managedResultCollectionState = (task, envelope) => {
  if (!task || !isTerminalManagedTaskStatus(task.status) || !envelope) return 'pending';
  if (envelope.action !== null) return 'dispositioned';
  if (isAutoResumeActive(envelope)) return 'scheduled';
  if (requiresManualModelRecovery(task, envelope)) return 'attention';
  return 'ready';
};

// The cursor references a persisted envelope, not a process-local counter. If
// retention removes that envelope, the caller receives a fresh scoped snapshot.
export const createManagedWaitCursor = (rootSessionId, envelope, taskIds = null) => (
  `${CURSOR_PREFIX}${encodeURIComponent(JSON.stringify([
    rootSessionId, envelope?.sequence ?? 0, envelope?.envelopeId ?? null, selectedScope(taskIds),
  ]))}`
);

export const resolveManagedWaitCursor = (cursor, rootSessionId, envelopes, taskIds = null) => {
  if (cursor === undefined || cursor === null) return { sequence: 0, reset: false };
  const selection = selectedScope(taskIds);
  // The private RPC bounds request bytes. Do not bound this cursor by the new
  // selection: a valid prior cursor can describe a much larger selected set.
  const prefix = typeof cursor === 'string' && cursor.startsWith(LEGACY_CURSOR_PREFIX) ? LEGACY_CURSOR_PREFIX : CURSOR_PREFIX;
  if (typeof cursor !== 'string' || !cursor.startsWith(prefix)) {
    throw new TypeError('afterCursor must be a managed wait cursor');
  }
  let value;
  try { value = JSON.parse(decodeURIComponent(cursor.slice(prefix.length))); }
  catch { throw new TypeError('afterCursor must be a managed wait cursor'); }
  if (!Array.isArray(value) || value.length !== (prefix === LEGACY_CURSOR_PREFIX ? 3 : 4) || typeof value[0] !== 'string'
    || !Number.isSafeInteger(value[1]) || value[1] < 0
    || (value[2] !== null && typeof value[2] !== 'string')
    || (prefix === CURSOR_PREFIX && value[3] !== null
      && (!Array.isArray(value[3]) || !value[3].every(taskId => typeof taskId === 'string' && taskId.length > 0)))) {
    throw new TypeError('afterCursor must be a managed wait cursor');
  }
  if (value[0] !== rootSessionId) throw new TypeError('afterCursor belongs to another root session');
  if (prefix === LEGACY_CURSOR_PREFIX || JSON.stringify(value[3]) !== JSON.stringify(selection)) return { sequence: 0, reset: true };
  if (value[1] === 0 && value[2] === null) return { sequence: 0, reset: false };
  const retained = envelopes.find((entry) => entry.envelopeId === value[2] && entry.sequence >= value[1]);
  return retained ? { sequence: value[1], reset: false } : { sequence: 0, reset: true };
};

export const projectManagedWaitSnapshot = ({ rootSessionId, tasks, envelopes, afterCursor, allTasks = tasks }) => {
  const scopedEnvelopes = envelopes.filter((entry) => entry.rootSessionId === rootSessionId);
  const taskIds = tasks.map(task => task.taskId);
  const selected = new Set(taskIds);
  const cursor = resolveManagedWaitCursor(afterCursor, rootSessionId, scopedEnvelopes, taskIds);
  const byTask = new Map(scopedEnvelopes.map((entry) => [entry.taskId, entry]));
  const readyTaskIds = [];
  const attention = [];
  const pendingTaskIds = [];
  const unacknowledgedTaskIds = [];
  const changedTaskIds = [];
  const dispositioned = [];
  for (const task of tasks) {
    const envelope = byTask.get(task.taskId);
    const state = managedResultCollectionState(task, envelope);
    if (envelope && envelope.sequence > cursor.sequence && (state !== 'dispositioned' || envelope.followUpTaskId)) changedTaskIds.push(task.taskId);
    if (state === 'pending') pendingTaskIds.push(task.taskId);
    if (state === 'ready') {
      unacknowledgedTaskIds.push(task.taskId);
      if (envelope.sequence > cursor.sequence) readyTaskIds.push(task.taskId);
    }
    if (state === 'scheduled' || state === 'attention') attention.push({ taskId: task.taskId, state });
    if (state === 'dispositioned') dispositioned.push({ taskId: task.taskId, action: envelope.action, followUpTaskId: envelope.followUpTaskId });
  }
  const latest = scopedEnvelopes.filter(entry => selected.has(entry.taskId))
    .reduce((best, entry) => !best || entry.sequence > best.sequence ? entry : best, null);
  return {
    schemaVersion: 2,
    rootSessionId,
    cursor: createManagedWaitCursor(rootSessionId, latest, taskIds),
    cursorReset: cursor.reset,
    readyTaskIds,
    attention,
    pendingTaskIds,
    unacknowledgedTaskIds,
    changedTaskIds,
    dispositioned,
    availableTaskIds: allTasks.filter(task => task.rootSessionId === rootSessionId && !selected.has(task.taskId)
      && managedResultCollectionState(task, byTask.get(task.taskId)) === 'ready').map(task => task.taskId),
    activeWork: pendingTaskIds.length > 0,
    settled: pendingTaskIds.length === 0,
  };
};

// Private host/plugin notification using the same durable envelope stream as
// collection. It carries identities only, never another copy of task results.
export const projectManagedCommitSnapshot = ({ directory, tasks, envelopes, afterCursor }) => {
  const ids = new Set(tasks.filter((task) => task.directory === directory).map((task) => task.taskId));
  const scoped = envelopes.filter((entry) => ids.has(entry.taskId));
  const scope = `directory:${directory}`;
  const cursor = resolveManagedWaitCursor(afterCursor, scope, scoped);
  const latest = scoped.reduce((best, entry) => !best || entry.sequence > best.sequence ? entry : best, null);
  return {
    cursor: createManagedWaitCursor(scope, latest),
    cursorReset: cursor.reset,
    rootSessionIds: [...new Set(scoped.filter((entry) => entry.sequence > cursor.sequence).map((entry) => entry.rootSessionId))],
  };
};
