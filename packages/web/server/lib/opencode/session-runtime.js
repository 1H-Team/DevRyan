import { randomUUID } from 'node:crypto';

export const SESSION_PRESENTATION_MAX_SESSIONS = 10000;
export const SESSION_PRESENTATION_MAX_OWNERS = 4096;

const SESSION_COOLDOWN_DURATION_MS = 2000;
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const extractSessionStatusUpdate = (payload) => {
  if (!payload || payload.type !== 'session.status') {
    return null;
  }

  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const status = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  // Canonical OpenCode schema uses properties.status.type. Keep legacy info.type fallback for compatibility.
  const type = typeof status.type === 'string'
    ? status.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');

  if (!sessionId || !type) {
    return null;
  }

  return {
    sessionId,
    type,
    eventId: typeof payload.id === 'string' ? payload.id : '',
    attempt: typeof status.attempt === 'number'
      ? status.attempt
      : (typeof info.attempt === 'number' ? info.attempt : undefined),
    message: typeof status.message === 'string'
      ? status.message
      : (typeof info.message === 'string' ? info.message : undefined),
    next: typeof status.next === 'number'
      ? status.next
      : (typeof info.next === 'number' ? info.next : undefined),
  };
};

const deriveSessionActivityTransitions = (payload) => {
  const update = extractSessionStatusUpdate(payload);
  if (!update) {
    return [];
  }

  if (update.type === 'busy' || update.type === 'retry') {
    return [{ sessionId: update.sessionId, phase: 'busy' }];
  }
  if (update.type === 'idle') {
    return [{ sessionId: update.sessionId, phase: 'cooldown' }];
  }
  return [];
};

export const createSessionRuntime = ({ writeSseEvent, getNotificationClients, broadcastEvent }) => {
  const presentationEpoch = randomUUID();
  let presentationRevision = 0;
  const presentations = new Map();
  // A global producer watermark fences delayed captured callbacks across sessions.
  // null permanently retires an owner for this server epoch; capacity fails closed.
  const presentationOwners = new Map();
  const validPresentationID = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,256}$/.test(value);
  const presentationFields = sessionID => {
    const current = presentations.get(sessionID);
    return current ? { presentationEpoch, presentationRevision: current.revision, presentation: current.value } : {};
  };
  const broadcastPresentation = sessionID => {
    const activity = sessionActivityPhases.get(sessionID);
    if (activity && typeof broadcastEvent === 'function') {
      try { broadcastEvent({ type: 'openchamber:session-activity',
        properties: { sessionId: sessionID, sessionID, phase: activity.phase, ...presentationFields(sessionID) } }); }
      catch { /* Optional display observers cannot veto status or durable work. */ }
    }
  };
  const clearPresentation = sessionID => {
    const current = presentations.get(sessionID);
    if (!current?.value) return false;
    presentations.set(sessionID, { ...current, value: null, revision: ++presentationRevision, blockedGeneration: current.value.generation, updatedAt: Date.now() });
    broadcastPresentation(sessionID); return true;
  };
  // A Stop response may arrive after another objective starts. Capture only
  // the existing display identity, never an authority or a future generation.
  const captureSessionPresentationClear = sessionID => {
    const captured = presentations.get(sessionID), value = captured?.value;
    if (!value) return () => false;
    return () => {
      const current = presentations.get(sessionID);
      if (current?.ownerID !== captured.ownerID || !current.value
        || ['provider', 'generation', 'objectiveID', 'assistantID', 'stepID', 'attemptID'].some(key => current.value[key] !== value[key])) return false;
      return clearPresentation(sessionID);
    };
  };
  // Constructor-only observation input. These fields never set session status,
  // renew execution authority, or report completion of the owning objective.
  const updateSessionPresentation = input => {
    if (!input || !['native', 'cursor'].includes(input.provider) || !['finalizing', 'cleared'].includes(input.phase)
      || !['ownerID', 'sessionID', 'generation', 'objectiveID', 'assistantID'].every(key => validPresentationID(input[key]))
      || !Number.isSafeInteger(input.sequence) || input.sequence < 0 || !Number.isSafeInteger(input.progress) || input.progress < 0
      || (input.provider === 'native' ? !validPresentationID(input.stepID) || !validPresentationID(input.attemptID)
        : [input.stepID, input.attemptID].some(value => value !== null && !validPresentationID(value)))
      || presentationOwners.has(input.ownerID) && presentationOwners.get(input.ownerID) === null) return false;
    const current = presentations.get(input.sessionID);
    if (input.phase === 'cleared' && !current) return false;
    if (input.phase === 'finalizing' && sessionActivityPhases.get(input.sessionID)?.phase !== 'busy') return false;
    if (!presentationOwners.has(input.ownerID) && presentationOwners.size >= SESSION_PRESENTATION_MAX_OWNERS
      || !current && presentations.size >= SESSION_PRESENTATION_MAX_SESSIONS) return false;
    if (input.sequence <= (presentationOwners.get(input.ownerID) ?? -1)) return false;
    presentationOwners.set(input.ownerID, input.sequence);
    if (input.phase === 'cleared') {
      if (current?.ownerID !== input.ownerID || current.generation !== input.generation) return false;
      // The ordered producer's terminal acknowledgment makes older captured
      // callbacks unreachable through its global sequence watermark.
      current.closed = true; current.updatedAt = Date.now();
      return clearPresentation(input.sessionID);
    }
    if (sessionActivityPhases.get(input.sessionID)?.phase !== 'busy' || current?.blockedGeneration === input.generation) return false;
    const value = { provider: input.provider, phase: 'finalizing', generation: input.generation, objectiveID: input.objectiveID,
      assistantID: input.assistantID, stepID: input.stepID, attemptID: input.attemptID, progress: input.progress };
    if (current?.value?.generation === input.generation) {
      if (current.ownerID !== input.ownerID || ['provider', 'objectiveID', 'assistantID', 'stepID', 'attemptID'].some(key => current.value[key] !== value[key])
        || input.progress <= current.value.progress) return false;
    }
    presentations.set(input.sessionID, { ownerID: input.ownerID, generation: input.generation, value: Object.freeze(value), revision: ++presentationRevision, closed: false, updatedAt: Date.now() });
    broadcastPresentation(input.sessionID); return true;
  };
  const clearSessionPresentationOwner = ownerID => {
    if (!validPresentationID(ownerID)) return;
    if (presentationOwners.has(ownerID) || presentationOwners.size < SESSION_PRESENTATION_MAX_OWNERS) presentationOwners.set(ownerID, null);
    for (const [sessionID, current] of presentations) if (current.ownerID === ownerID) { clearPresentation(sessionID); presentations.get(sessionID).closed = true; }
  };
  const sessionActivityPhases = new Map();
  const sessionActivityCooldowns = new Map();
  const sessionStates = new Map();
  const sessionAttentionStates = new Map();

  const getOrCreateAttentionState = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') return null;

    let state = sessionAttentionStates.get(sessionId);
    if (!state) {
      state = {
        needsAttention: false,
        lastUserMessageAt: null,
        lastStatusChangeAt: Date.now(),
        viewedByClients: new Set(),
        status: 'idle',
      };
      sessionAttentionStates.set(sessionId, state);
    }
    return state;
  };

  const setSessionActivityPhase = (sessionId, phase) => {
    if (!sessionId || typeof sessionId !== 'string') return false;

    const current = sessionActivityPhases.get(sessionId);
    if (current?.phase === phase) return false;
    if (phase === 'cooldown' && current?.phase !== 'busy') {
      return false;
    }

    const existingTimer = sessionActivityCooldowns.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      sessionActivityCooldowns.delete(sessionId);
    }

    sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

    if (phase === 'cooldown') {
      const timer = setTimeout(() => {
        const now = sessionActivityPhases.get(sessionId);
        if (now?.phase === 'cooldown') {
          setSessionActivityPhase(sessionId, 'idle');
          return;
        }
        sessionActivityCooldowns.delete(sessionId);
      }, SESSION_COOLDOWN_DURATION_MS);
      sessionActivityCooldowns.set(sessionId, timer);
    }

    if (typeof broadcastEvent === 'function') {
      broadcastEvent({
        type: 'openchamber:session-activity',
        properties: {
          sessionId,
          sessionID: sessionId,
          phase,
          ...presentationFields(sessionId),
        },
      });
    }

    return true;
  };

  const updateSessionAttentionStatus = (sessionId, status) => {
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;

    const prevStatus = state.status;
    state.status = status;
    state.lastStatusChangeAt = Date.now();

    if ((prevStatus === 'busy' || prevStatus === 'retry') && status === 'idle') {
      if (state.lastUserMessageAt && state.viewedByClients.size === 0) {
        state.needsAttention = true;
      }
    }
  };

  const updateSessionState = (sessionId, status, eventId, metadata = {}) => {
    if (!sessionId || typeof sessionId !== 'string') return;

    if (status !== 'busy') clearPresentation(sessionId);
    const now = Date.now();
    const existing = sessionStates.get(sessionId);
    const existingAttentionState = sessionAttentionStates.get(sessionId);
    if (existing && existing.lastUpdateAt > now - 5000 && status === existing.status) {
      return;
    }

    sessionStates.set(sessionId, {
      status,
      lastUpdateAt: now,
      lastEventId: eventId || `server-${now}`,
      metadata: { ...existing?.metadata, ...metadata },
    });

    updateSessionAttentionStatus(sessionId, status);
    const attentionState = sessionAttentionStates.get(sessionId);
    const attentionChanged = !!attentionState && existingAttentionState?.needsAttention !== attentionState.needsAttention;
    const clients = getNotificationClients();
    if (!existing || existing.status !== status || attentionChanged) {
      const state = sessionStates.get(sessionId);
      const syntheticPayload = {
        type: 'openchamber:session-status',
        properties: {
          sessionId,
          sessionID: sessionId,
          status: state.status,
          timestamp: state.lastUpdateAt,
          metadata: state.metadata,
          needsAttention: attentionState?.needsAttention ?? false,
        },
      };

      if (typeof broadcastEvent === 'function') {
        broadcastEvent(syntheticPayload);
      } else if (clients.size > 0) {
        for (const res of clients) {
          try {
            writeSseEvent(res, syntheticPayload);
          } catch {
          }
        }
      }
    }

    const phase = status === 'busy' || status === 'retry' ? 'busy' : 'idle';
    if (phase !== 'idle' || sessionActivityPhases.get(sessionId)?.phase !== 'cooldown') {
      setSessionActivityPhase(sessionId, phase);
    }
  };

  const getSessionStateSnapshot = () => {
    const result = {};
    const now = Date.now();
    for (const [sessionId, data] of sessionStates) {
      if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) continue;
      result[sessionId] = {
        status: data.status,
        lastUpdateAt: data.lastUpdateAt,
        metadata: data.metadata,
      };
    }
    return result;
  };

  const getSessionState = (sessionId) => {
    if (!sessionId) return null;
    return sessionStates.get(sessionId) || null;
  };

  const markSessionViewed = (sessionId, clientId) => {
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;

    const wasNeedsAttention = state.needsAttention;
    state.viewedByClients.add(clientId);

    if (wasNeedsAttention) {
      state.needsAttention = false;

      const syntheticPayload = {
        type: 'openchamber:session-status',
        properties: {
          sessionId,
          sessionID: sessionId,
          status: state.status,
          timestamp: Date.now(),
          metadata: {},
          needsAttention: false,
        },
      };

      if (typeof broadcastEvent === 'function') {
        broadcastEvent(syntheticPayload);
      } else {
        const clients = getNotificationClients();
        for (const res of clients) {
          try {
            writeSseEvent(res, syntheticPayload);
          } catch {
          }
        }
      }
    }
  };

  const markSessionUnviewed = (sessionId, clientId) => {
    const state = sessionAttentionStates.get(sessionId);
    if (!state) return;
    state.viewedByClients.delete(clientId);
  };

  const markUserMessageSent = (sessionId) => {
    clearPresentation(sessionId);
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;
    state.lastUserMessageAt = Date.now();
  };

  const getSessionAttentionSnapshot = () => {
    const result = {};
    const now = Date.now();
    for (const [sessionId, state] of sessionAttentionStates) {
      if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) continue;
      result[sessionId] = {
        needsAttention: state.needsAttention,
        lastUserMessageAt: state.lastUserMessageAt,
        lastStatusChangeAt: state.lastStatusChangeAt,
        status: state.status,
        isViewed: state.viewedByClients.size > 0,
      };
    }
    return result;
  };

  const getSessionAttentionState = (sessionId) => {
    if (!sessionId) return null;
    const state = sessionAttentionStates.get(sessionId);
    if (!state) return null;
    return {
      needsAttention: state.needsAttention,
      lastUserMessageAt: state.lastUserMessageAt,
      lastStatusChangeAt: state.lastStatusChangeAt,
      status: state.status,
      isViewed: state.viewedByClients.size > 0,
    };
  };

  const getSessionActivitySnapshot = () => {
    const result = {};
    for (const [sessionId, data] of sessionActivityPhases) {
      result[sessionId] = { type: data.phase, ...presentationFields(sessionId) };
    }
    return result;
  };

  const resetAllSessionActivityToIdle = () => {
    for (const sessionID of presentations.keys()) clearPresentation(sessionID);
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    sessionActivityCooldowns.clear();
    const now = Date.now();
    for (const [sessionId] of sessionActivityPhases) {
      sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: now });
    }
  };

  const clearSessionActivity = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') return false;
    const cooldown = sessionActivityCooldowns.get(sessionId);
    if (cooldown) {
      clearTimeout(cooldown);
      sessionActivityCooldowns.delete(sessionId);
    }
    clearPresentation(sessionId);
    const removed = sessionActivityPhases.delete(sessionId);
    sessionStates.delete(sessionId);
    sessionAttentionStates.delete(sessionId);
    return removed;
  };

  // Sessions last reported busy or retrying, for restart reconciliation.
  const listActiveSessions = () => {
    const result = [];
    for (const [sessionId, data] of sessionStates) {
      if (data.status === 'busy' || data.status === 'retry') {
        result.push({ sessionId, status: data.status, lastUpdateAt: data.lastUpdateAt });
      }
    }
    return result;
  };

  const cleanupOldSessionStates = () => {
    const now = Date.now();
    for (const [sessionID, current] of presentations) {
      if (!current.value && current.closed && now - current.updatedAt > SESSION_STATE_MAX_AGE_MS) presentations.delete(sessionID);
    }
    for (const [sessionId, data] of sessionStates) {
      if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) {
        sessionStates.delete(sessionId);
      }
    }
    for (const [sessionId, state] of sessionAttentionStates) {
      if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) {
        sessionAttentionStates.delete(sessionId);
      }
    }
  };

  const cleanupInterval = setInterval(cleanupOldSessionStates, SESSION_STATE_CLEANUP_INTERVAL_MS);

  const processOpenCodeSsePayload = (payload) => {
    const sessionID = payload?.properties?.sessionID ?? payload?.properties?.info?.sessionID;
    if (['session.error', 'session.deleted', 'session.execution.interrupted'].includes(payload?.type)) clearPresentation(sessionID);
    if (payload?.type === 'message.updated' && payload.properties?.info?.role === 'user'
      && payload.properties.info.id !== presentations.get(sessionID)?.value?.objectiveID) clearPresentation(sessionID);
    const transitions = deriveSessionActivityTransitions(payload);
    for (const activity of transitions) {
      setSessionActivityPhase(activity.sessionId, activity.phase);
    }

    if (payload && payload.type === 'session.status') {
      const update = extractSessionStatusUpdate(payload);
      if (update) {
        updateSessionState(update.sessionId, update.type, update.eventId || `sse-${Date.now()}`, {
          attempt: update.attempt,
          message: update.message,
          next: update.next,
        });
      }
    }
  };

  const dispose = () => {
    clearInterval(cleanupInterval);
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    sessionActivityCooldowns.clear();
  };

  return {
    processOpenCodeSsePayload,
    updateSessionPresentation,
    clearSessionPresentation: clearPresentation,
    captureSessionPresentationClear,
    clearSessionPresentationOwner,
    getSessionActivitySnapshot,
    getSessionStateSnapshot,
    getSessionAttentionSnapshot,
    getSessionState,
    getSessionAttentionState,
    markSessionViewed,
    markSessionUnviewed,
    markUserMessageSent,
    resetAllSessionActivityToIdle,
    listActiveSessions,
    clearSessionActivity,
    dispose,
  };
};
