const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const terminalErrorFromPayload = (payload, observedAt) => {
  if (!isRecord(payload) || payload.type !== 'session.error') return null;
  const properties = isRecord(payload.properties) ? payload.properties : {};
  const info = isRecord(properties.info) ? properties.info : {};
  const sessionId = text(properties.sessionID)
    || text(properties.sessionId)
    || text(info.id)
    || text(info.sessionID)
    || text(info.sessionId);
  if (!sessionId) return null;
  const error = isRecord(properties.error) ? properties.error : {};
  const data = isRecord(error.data) ? error.data : {};
  return {
    sessionId,
    observedAt,
    eventId: text(payload.id) || null,
    errorName: text(error.name) || 'UnknownError',
    message: text(data.message) || text(error.message) || text(error.name) || 'Managed child session failed',
    code: text(data.code) || null,
    statusCode: Number.isFinite(data.statusCode ?? data.status) ? Number(data.statusCode ?? data.status) : null,
    retryable: typeof data.isRetryable === 'boolean' ? data.isRetryable : null,
  };
};

export const createManagedTerminalErrorRegistry = ({
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

  const record = (payload, options = {}) => {
    const observedAt = Number.isFinite(options.observedAt) ? Number(options.observedAt) : now();
    const entry = terminalErrorFromPayload(payload, observedAt);
    if (!entry) return false;
    touch(entry.sessionId, entry);
    return true;
  };

  const observe = (payload, options = {}) => {
    if (record(payload, options)) return true;
    if (!isRecord(payload) || payload.type !== 'session.deleted') return false;
    const properties = isRecord(payload.properties) ? payload.properties : {};
    const info = isRecord(properties.info) ? properties.info : {};
    const sessionId = text(info.id)
      || text(info.sessionID)
      || text(info.sessionId)
      || text(properties.sessionID)
      || text(properties.sessionId);
    return sessionId ? latestBySession.delete(sessionId) : false;
  };

  const read = ({ sessionId, after = 0 } = {}) => {
    const normalizedSessionId = text(sessionId);
    if (!normalizedSessionId) return null;
    const entry = latestBySession.get(normalizedSessionId);
    if (!entry || entry.observedAt < after) return null;
    touch(normalizedSessionId, entry);
    return { ...entry };
  };

  return {
    record,
    observe,
    read,
    remove: (sessionId) => latestBySession.delete(text(sessionId)),
    clear: () => latestBySession.clear(),
    get size() {
      return latestBySession.size;
    },
  };
};
