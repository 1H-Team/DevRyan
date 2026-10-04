// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) session activity -> DevRyan's v1 SessionStatus (B.3).
//
// Status is derived live state, the authority for activity (AGENTS.md):
//
//   session.execution.started                         -> {type:'busy'}
//   session.retry.scheduled {attempt, at, error}      -> {type:'retry', attempt,
//                                                        message: error.message, next: at}
//   session.execution.succeeded | failed | interrupted -> {type:'idle'}
//
// `next` stays absolute epoch milliseconds, which the UI's abort-retry guard
// accepts (`packages/ui/src/sync/abort-retry-guard.ts`). On a cold start or a
// stream gap `GET /api/session/active` is the source: listed sessions are busy
// (or retrying, recovered from the latest assistant's `retry` field [sm M27]),
// every other session is idle. v1 `GET /session/status` lists only non-idle
// sessions; an absent entry reads as idle. Everything here is pure.
// ---------------------------------------------------------------------------

export const IDLE_STATUS = Object.freeze({ type: 'idle' });
export const BUSY_STATUS = Object.freeze({ type: 'busy' });

const BUSY_EVENT = 'session.execution.started';
const RETRY_EVENT = 'session.retry.scheduled';
const IDLE_EVENTS = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * @typedef {{ type: 'idle' } | { type: 'busy' } | { type: 'retry', attempt: number, message: string, next: number }} V1SessionStatus
 */

/**
 * A v1 retry status from v2 retry data (`session.retry.scheduled` data or an
 * assistant's `retry` field). `null` when the data is not a usable retry.
 * LOSS(retry-action): v1 `action` has no v2 source.
 * @param {unknown} retry `{attempt, at, error}`
 * @returns {V1SessionStatus | null}
 */
export const toV1RetryStatus = (retry) => {
  if (!isRecord(retry) || !Number.isSafeInteger(retry.attempt) || !isFiniteNumber(retry.at)) return null;
  const message = isRecord(retry.error) && typeof retry.error.message === 'string' ? retry.error.message : '';
  return { type: 'retry', attempt: retry.attempt, message, next: retry.at };
};

/**
 * The status a v2 event implies, or `undefined` when the event does not change
 * status. Native `session.status`/`session.idle` are never projected (B.4).
 * @param {unknown} type the v2 event type
 * @param {unknown} [data] the v2 event data
 * @returns {V1SessionStatus | undefined}
 */
export const statusForEvent = (type, data) => {
  if (type === BUSY_EVENT) return BUSY_STATUS;
  if (type === RETRY_EVENT) return toV1RetryStatus(data) ?? BUSY_STATUS;
  if (typeof type === 'string' && IDLE_EVENTS.has(type)) return IDLE_STATUS;
  return undefined;
};

/**
 * Whether two v1 statuses are equal for UI purposes (no-op suppression).
 * @param {V1SessionStatus | undefined} left
 * @param {V1SessionStatus | undefined} right
 */
export const isSameStatus = (left, right) => {
  const leftType = left?.type ?? 'idle';
  const rightType = right?.type ?? 'idle';
  if (leftType !== rightType) return false;
  if (leftType !== 'retry') return true;
  return left.attempt === right.attempt && left.message === right.message && left.next === right.next;
};

/**
 * Retry status recovered from v2 message rows (seq order): only the latest
 * assistant counts, and only while it still carries `retry` (v2 clears it when
 * the step restarts or the session goes idle).
 * @param {readonly unknown[]} messages
 * @returns {V1SessionStatus | null}
 */
export const retryStatusFromMessages = (messages) => {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (message.type === 'idle') return null;
    if (message.type === 'assistant') return toV1RetryStatus(message.retry);
  }
  return null;
};

/**
 * Session ids listed by `GET /api/session/active` (`{data: {ses_…: {type}}}`).
 * Any listed entry counts as active; the response documents absent sessions as inactive.
 * @param {unknown} body
 * @returns {Set<string>}
 */
export const activeSessionIDs = (body) => {
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  return new Set(Object.keys(data).filter((sessionID) => isNonEmptyString(sessionID) && isRecord(data[sessionID])));
};

/**
 * v1 status map (non-idle sessions only) from `GET /api/session/active`.
 * @param {unknown} body
 * @param {{ retryBySession?: ReadonlyMap<string, V1SessionStatus | null> }} [options]
 *   retry statuses recovered with {@link retryStatusFromMessages}
 * @returns {Record<string, V1SessionStatus>}
 */
export const statusesFromActive = (body, options = {}) => {
  /** @type {Record<string, V1SessionStatus>} */
  const statuses = {};
  for (const sessionID of activeSessionIDs(body)) {
    const retry = options.retryBySession?.get(sessionID);
    statuses[sessionID] = retry && retry.type === 'retry' ? retry : BUSY_STATUS;
  }
  return statuses;
};

/**
 * @typedef {object} StatusReconciliation
 * @property {Record<string, V1SessionStatus>} statuses the new non-idle map
 * @property {{ sessionID: string, status: V1SessionStatus }[]} changes `session.status`
 *   payloads to emit: every session previously held as non-idle (with its new status) and
 *   every newly active session
 */

/**
 * Cold-start / gap reconciliation (B.3, B.7 step 4).
 * @param {object} input
 * @param {unknown} input.active the `GET /api/session/active` body
 * @param {Readonly<Record<string, V1SessionStatus>> | ReadonlyMap<string, V1SessionStatus>} [input.previous]
 *   the statuses the projector held before the gap
 * @param {ReadonlyMap<string, V1SessionStatus | null>} [input.retryBySession]
 * @returns {StatusReconciliation}
 */
export const reconcileActiveStatuses = ({ active, previous, retryBySession }) => {
  const statuses = statusesFromActive(active, { retryBySession });
  /** @type {[string, V1SessionStatus][]} */
  let previousEntries = [];
  if (previous instanceof Map) previousEntries = [...previous];
  else if (isRecord(previous)) previousEntries = Object.entries(previous);
  /** @type {{ sessionID: string, status: V1SessionStatus }[]} */
  const changes = [];
  const seen = new Set();
  for (const [sessionID, status] of previousEntries) {
    if (!isNonEmptyString(sessionID) || status?.type === 'idle' || status === undefined) continue;
    seen.add(sessionID);
    changes.push({ sessionID, status: statuses[sessionID] ?? IDLE_STATUS });
  }
  for (const [sessionID, status] of Object.entries(statuses)) {
    if (!seen.has(sessionID)) changes.push({ sessionID, status });
  }
  return { statuses, changes };
};

const normalizeDirectory = (directory) => (
  directory.length > 1 && directory.endsWith('/') ? directory.replace(/\/+$/, '') || '/' : directory
);

/**
 * The v1 `GET /session/status?directory` body: non-idle entries whose cached
 * session location matches `directory`. A session with no cached location is
 * left out (fail closed; it is listed again once its location is cached).
 * Without a directory every non-idle entry is returned.
 * @param {Readonly<Record<string, V1SessionStatus>>} statuses
 * @param {object} options
 * @param {unknown} [options.directory]
 * @param {(sessionID: string) => string | undefined} options.directoryOf
 * @returns {Record<string, V1SessionStatus>}
 */
export const filterStatusesByDirectory = (statuses, { directory, directoryOf }) => {
  /** @type {Record<string, V1SessionStatus>} */
  const filtered = {};
  const wanted = isNonEmptyString(directory) ? normalizeDirectory(directory) : undefined;
  for (const [sessionID, status] of Object.entries(isRecord(statuses) ? statuses : {})) {
    if (!isRecord(status) || status.type === 'idle') continue;
    if (wanted !== undefined) {
      const location = directoryOf(sessionID);
      if (!isNonEmptyString(location) || normalizeDirectory(location) !== wanted) continue;
    }
    filtered[sessionID] = status;
  }
  return filtered;
};
