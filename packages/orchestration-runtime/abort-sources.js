// Which DevRyan UI path asked for a session abort. The UI sends one of these in
// ABORT_SOURCE_HEADER on every `session.abort`; the web server journals it and
// classifies operator stops from it. One list so the hosts cannot drift.
export const ABORT_SOURCE_HEADER = 'X-DevRyan-Abort-Source';

export const ABORT_SOURCES = Object.freeze([
  'stop_button',
  'double_escape',
  'steered_send',
  'session_removal',
  'revert',
  'redo',
  'abort_guard',
  'provider_retry',
  'stall_watchdog',
  'status_row',
]);

const ABORT_SOURCE_SET = new Set(ABORT_SOURCES);

/** Returns the source when it is a known value, otherwise 'unknown'. */
export const normalizeAbortSource = (value) => (
  typeof value === 'string' && ABORT_SOURCE_SET.has(value) ? value : 'unknown'
);

// OpenCode records every interrupt as reason "user", so the host keeps the
// source of the latest accepted abort per session long enough to attach it to
// the interrupt it causes. Bounded and in memory only: attribution, never policy.
export const ABORT_SOURCE_TTL_MS = 60_000;

export const createAbortSourceRegistry = ({
  now = Date.now,
  ttlMs = ABORT_SOURCE_TTL_MS,
  maximumSessions = 5_000,
} = {}) => {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive number');
  if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1) {
    throw new RangeError('maximumSessions must be a positive safe integer');
  }
  const latestBySession = new Map();
  const sessionKey = (sessionId) => (typeof sessionId === 'string' ? sessionId.trim() : '');

  // An unattributed abort clears the previous source instead of inheriting it.
  const record = ({ sessionId, source } = {}) => {
    const key = sessionKey(sessionId);
    if (!key) return null;
    latestBySession.delete(key);
    const normalized = normalizeAbortSource(source);
    if (normalized === 'unknown') return null;
    const entry = { sessionId: key, source: normalized, recordedAt: now() };
    latestBySession.set(key, entry);
    while (latestBySession.size > maximumSessions) {
      latestBySession.delete(latestBySession.keys().next().value);
    }
    return { ...entry };
  };

  // A rejected abort withdraws only its own entry.
  const withdraw = (entry) => {
    const key = sessionKey(entry?.sessionId);
    const current = latestBySession.get(key);
    if (!current || current.recordedAt !== entry.recordedAt || current.source !== entry.source) return false;
    return latestBySession.delete(key);
  };

  const read = (sessionId) => {
    const key = sessionKey(sessionId);
    const entry = latestBySession.get(key);
    if (!entry) return null;
    if (now() - entry.recordedAt > ttlMs) {
      latestBySession.delete(key);
      return null;
    }
    return entry.source;
  };

  return {
    record,
    withdraw,
    read,
    clear: (sessionId) => latestBySession.delete(sessionKey(sessionId)),
    get size() {
      return latestBySession.size;
    },
  };
};
