const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

/**
 * Operator (user) abort requests per session. OpenCode reports an abort during
 * a provider retry wait only as idle, with no finish or error, so the managed
 * executor needs this to tell a Stop apart from an empty turn it would
 * otherwise continue automatically.
 */
export const createManagedOperatorAbortRegistry = ({
  now = Date.now,
  maximumSessions = 5_000,
} = {}) => {
  if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1) {
    throw new RangeError('maximumSessions must be a positive safe integer');
  }
  const latestBySession = new Map();

  const touch = (sessionId, entry) => {
    latestBySession.delete(sessionId);
    latestBySession.set(sessionId, entry);
    while (latestBySession.size > maximumSessions) {
      latestBySession.delete(latestBySession.keys().next().value);
    }
  };

  const record = ({ sessionId, requestedAt } = {}) => {
    const normalizedSessionId = text(sessionId);
    if (!normalizedSessionId) return null;
    const entry = {
      sessionId: normalizedSessionId,
      requestedAt: Number.isFinite(requestedAt) ? Number(requestedAt) : now(),
    };
    touch(normalizedSessionId, entry);
    return { ...entry };
  };

  // A rejected abort (the runtime did not stop) withdraws only its own request.
  const withdraw = ({ sessionId, requestedAt } = {}) => {
    const normalizedSessionId = text(sessionId);
    const entry = latestBySession.get(normalizedSessionId);
    if (!entry || (Number.isFinite(requestedAt) && entry.requestedAt !== requestedAt)) return false;
    return latestBySession.delete(normalizedSessionId);
  };

  const read = ({ sessionId, after = 0 } = {}) => {
    const entry = latestBySession.get(text(sessionId));
    if (!entry || entry.requestedAt < after) return null;
    return { ...entry };
  };

  const observe = (payload) => {
    if (!isRecord(payload) || payload.type !== 'session.deleted') return false;
    const properties = isRecord(payload.properties) ? payload.properties : {};
    const info = isRecord(properties.info) ? properties.info : {};
    const sessionId = text(info.id) || text(properties.sessionID) || text(properties.sessionId);
    return sessionId ? latestBySession.delete(sessionId) : false;
  };

  return {
    record,
    withdraw,
    read,
    observe,
    clear: () => latestBySession.clear(),
    get size() {
      return latestBySession.size;
    },
  };
};
