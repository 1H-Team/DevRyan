const safeSessionId = (value) => (
  typeof value === 'string' && value.trim() ? value.trim() : ''
);

const sessionIdFromPayload = (payload) => {
  const properties = payload?.properties;
  const candidates = [
    properties?.sessionID,
    properties?.sessionId,
    properties?.info?.id,
    properties?.info?.sessionID,
    properties?.info?.sessionId,
    properties?.part?.sessionID,
    properties?.part?.sessionId,
    properties?.task?.rootSessionId,
  ];
  return candidates.map(safeSessionId).find(Boolean) || '';
};

const sessionStatus = (payload) => {
  if (payload?.type !== 'session.status') return '';
  const value = payload.properties?.status?.type
    ?? payload.properties?.info?.type
    ?? payload.properties?.type;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
};

const isCompletedTool = (payload) => {
  if (payload?.type !== 'message.part.updated') return false;
  const part = payload.properties?.part;
  if (part?.type !== 'tool') return false;
  const status = typeof part.state?.status === 'string' ? part.state.status.trim().toLowerCase() : '';
  return status === 'completed';
};

export const createDiagnosticRecoveryTracker = ({ maximumSessions = 5_000 } = {}) => {
  const pendingBySession = new Map();

  const touch = (sessionId, state) => {
    pendingBySession.delete(sessionId);
    pendingBySession.set(sessionId, state);
    while (pendingBySession.size > maximumSessions) {
      pendingBySession.delete(pendingBySession.keys().next().value);
    }
  };

  const trackFailure = ({ sessionId, eventId } = {}) => {
    const safeSession = safeSessionId(sessionId);
    const safeEvent = typeof eventId === 'string' && eventId.trim() ? eventId.trim() : '';
    if (!safeSession || !safeEvent) return false;
    const current = pendingBySession.get(safeSession) || { progressed: false, eventIds: new Set() };
    current.eventIds.add(safeEvent);
    touch(safeSession, current);
    return true;
  };

  const settle = (sessionId, outcome) => {
    const current = pendingBySession.get(sessionId);
    if (!current) return [];
    pendingBySession.delete(sessionId);
    if (outcome === 'recovered' && current.progressed !== true) return [];
    return [...current.eventIds].map((eventId) => ({ sessionId, eventId, outcome }));
  };

  const observe = (payload) => {
    const sessionId = sessionIdFromPayload(payload);
    if (!sessionId) return [];
    const current = pendingBySession.get(sessionId);
    if (isCompletedTool(payload) && current) {
      current.progressed = true;
      touch(sessionId, current);
      return [];
    }
    if (payload?.type === 'session.error') return settle(sessionId, 'unresolved');
    if (payload?.type === 'session.deleted') {
      pendingBySession.delete(sessionId);
      return [];
    }
    const status = sessionStatus(payload);
    if (status === 'idle') return settle(sessionId, 'recovered');
    if (status === 'error' || status === 'failed' || status === 'aborted') {
      return settle(sessionId, 'unresolved');
    }
    return [];
  };

  const markUnresolved = (sessionId) => settle(safeSessionId(sessionId), 'unresolved');

  return {
    trackFailure,
    observe,
    markUnresolved,
    getPendingCount: () => [...pendingBySession.values()]
      .reduce((total, state) => total + state.eventIds.size, 0),
  };
};
