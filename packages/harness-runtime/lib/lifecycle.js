const FINAL_TOOL_STATUSES = new Set([
  'completed',
  'complete',
  'done',
  'error',
  'failed',
  'aborted',
  'timeout',
  'timedout',
  'cancelled',
  'canceled',
]);

const asObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

const normalizeStatus = (value) => asString(value).toLowerCase().replace(/[\s_-]+/g, '');

const eventPayload = (candidate) => {
  const outer = asObject(candidate);
  const nested = asObject(outer.payload);
  return asString(nested.type) ? nested : outer;
};

const eventDirectory = (candidate, properties) => (
  asString(asObject(candidate).directory)
  || asString(properties.directory)
  || asString(asObject(properties.info).directory)
  || null
);

const sessionIdFrom = (properties, info = {}) => (
  asString(properties.sessionID)
  || asString(properties.sessionId)
  || asString(info.sessionID)
  || asString(info.sessionId)
  || asString(info.id)
);

export const createLifecycleTracker = (options = {}) => {
  const now = typeof options.clock === 'function' ? options.clock : Date.now;
  const maxRetainedTurns = Math.max(0, options.maxRetainedTurns ?? 2_000);
  const maxCompletedTools = Math.max(0, options.maxCompletedTools ?? 10_000);
  const listeners = new Set();
  if (typeof options.onTurnEvent === 'function') listeners.add(options.onTurnEvent);

  const turnsBySession = new Map();
  const turnsByUserMessage = new Map();
  const turnsByAssistantMessage = new Map();
  const completedTools = new Set();
  const settledTurns = [];

  const emit = (event) => {
    const frozen = Object.freeze({ ...event });
    for (const listener of listeners) {
      try {
        listener(frozen);
      } catch {
        // Lifecycle processing is a synchronous hot-path observer. A consumer
        // failure must not affect event delivery or prompt admission.
      }
    }
  };

  const userKey = (sessionID, messageID) => `${sessionID}\u0000${messageID}`;

  const activeTurn = (sessionID) => {
    const turns = turnsBySession.get(sessionID);
    if (!turns) return null;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (!turns[index].settledAt) return turns[index];
    }
    return null;
  };

  const startTurn = ({ sessionID, userMessageID, directory, source = 'event' }) => {
    if (!sessionID) return null;
    const normalizedMessageID = userMessageID || `pending_${now()}`;
    const key = userKey(sessionID, normalizedMessageID);
    const existing = turnsByUserMessage.get(key);
    if (existing) {
      if (directory && !existing.directory) existing.directory = directory;
      return existing;
    }

    const startedAt = now();
    const turn = {
      turnID: normalizedMessageID,
      sessionID,
      userMessageID: userMessageID || null,
      assistantMessageID: null,
      directory: directory || null,
      startedAt,
      settledAt: null,
      outcome: null,
    };
    const turns = turnsBySession.get(sessionID) ?? [];
    turns.push(turn);
    turnsBySession.set(sessionID, turns);
    turnsByUserMessage.set(key, turn);
    emit({
      type: 'turn_started',
      ...turn,
      source,
      at: startedAt,
    });
    return turn;
  };

  const assignUserMessage = (turn, messageID) => {
    if (!turn || !messageID || turn.userMessageID === messageID) return turn;
    if (turn.userMessageID) return turn;
    turnsByUserMessage.delete(userKey(turn.sessionID, turn.turnID));
    turn.userMessageID = messageID;
    turn.turnID = messageID;
    turnsByUserMessage.set(userKey(turn.sessionID, messageID), turn);
    return turn;
  };

  const pruneTurn = (turn) => {
    const turns = turnsBySession.get(turn.sessionID);
    if (turns) {
      const index = turns.indexOf(turn);
      if (index >= 0) turns.splice(index, 1);
      if (turns.length === 0) turnsBySession.delete(turn.sessionID);
    }
    turnsByUserMessage.delete(userKey(turn.sessionID, turn.userMessageID || turn.turnID));
    if (turn.assistantMessageID) turnsByAssistantMessage.delete(turn.assistantMessageID);
  };

  const settleTurn = (turn, outcome, reason = null) => {
    if (!turn || turn.settledAt) return;
    const settledAt = now();
    turn.settledAt = settledAt;
    turn.outcome = outcome;
    emit({
      type: outcome === 'failed' ? 'turn_failed' : outcome === 'aborted' ? 'turn_aborted' : 'turn_completed',
      ...turn,
      reason,
      at: settledAt,
    });
    settledTurns.push(turn);
    while (settledTurns.length > maxRetainedTurns) {
      pruneTurn(settledTurns.shift());
    }
  };

  const recordPromptAccepted = (input = {}) => {
    const sessionID = asString(input.sessionID ?? input.sessionId);
    const messageID = asString(input.messageID ?? input.messageId);
    if (!sessionID) return null;
    const current = activeTurn(sessionID);
    if (current && !current.userMessageID && messageID) {
      return assignUserMessage(current, messageID);
    }
    return startTurn({
      sessionID,
      userMessageID: messageID,
      directory: asString(input.directory) || null,
      source: 'prompt',
    });
  };

  const processMessageUpdated = (properties, directory) => {
    const info = asObject(properties.info ?? properties.message);
    const sessionID = sessionIdFrom(properties, info);
    const messageID = asString(info.id ?? properties.messageID ?? properties.messageId);
    const role = asString(info.role).toLowerCase();
    if (!sessionID || !messageID) return;

    if (role === 'user') {
      const existing = turnsByUserMessage.get(userKey(sessionID, messageID));
      if (existing) return;
      const pending = activeTurn(sessionID);
      if (pending && !pending.userMessageID) {
        assignUserMessage(pending, messageID);
        return;
      }
      startTurn({ sessionID, userMessageID: messageID, directory, source: 'event' });
      return;
    }

    if (role !== 'assistant') return;
    const parentID = asString(info.parentID ?? info.parentId);
    let turn = parentID ? turnsByUserMessage.get(userKey(sessionID, parentID)) : null;
    turn ??= activeTurn(sessionID);
    if (!turn) {
      turn = startTurn({
        sessionID,
        userMessageID: parentID,
        directory,
        source: 'assistant_recovery',
      });
    }
    if (!turn || turn.assistantMessageID === messageID) return;
    turn.assistantMessageID = messageID;
    turnsByAssistantMessage.set(messageID, turn);
    emit({
      type: 'assistant_message_started',
      ...turn,
      at: now(),
    });
  };

  const processPartUpdated = (properties, directory) => {
    const part = asObject(properties.part);
    const messageID = asString(part.messageID ?? part.messageId ?? properties.messageID);
    const sessionID = sessionIdFrom(properties, part);
    const state = asObject(part.state);
    const status = normalizeStatus(state.status ?? state.type);
    if (!FINAL_TOOL_STATUSES.has(status)) return;
    const tool = asString(part.tool ?? part.name);
    const callID = asString(part.callID ?? part.callId ?? part.id);
    const completionKey = `${sessionID}\u0000${messageID}\u0000${callID}`;
    if (!callID || completedTools.has(completionKey)) return;
    completedTools.add(completionKey);
    while (completedTools.size > maxCompletedTools) {
      completedTools.delete(completedTools.values().next().value);
    }
    const turn = turnsByAssistantMessage.get(messageID) ?? activeTurn(sessionID);
    emit({
      type: 'tool_completed',
      turnID: turn?.turnID ?? null,
      sessionID: sessionID || turn?.sessionID || null,
      userMessageID: turn?.userMessageID ?? null,
      assistantMessageID: messageID || turn?.assistantMessageID || null,
      directory: directory || turn?.directory || null,
      tool: tool || null,
      callID,
      status,
      at: now(),
    });
  };

  const processSessionStatus = (properties, directory) => {
    const info = asObject(properties.info);
    const statusObject = asObject(properties.status);
    const sessionID = sessionIdFrom(properties, info);
    const status = normalizeStatus(statusObject.type ?? info.type ?? properties.type);
    if (!sessionID || !status) return;
    if (status === 'idle') {
      const turn = activeTurn(sessionID);
      settleTurn(turn, 'completed');
      emit({
        type: 'session_idle',
        turnID: turn?.turnID ?? null,
        sessionID,
        userMessageID: turn?.userMessageID ?? null,
        assistantMessageID: turn?.assistantMessageID ?? null,
        directory: directory || turn?.directory || null,
        at: now(),
      });
    } else if (status === 'aborted' || status === 'error' || status === 'failed') {
      settleTurn(activeTurn(sessionID), 'aborted', status);
    }
  };

  const processEvent = (candidate) => {
    const payload = eventPayload(candidate);
    const type = asString(payload.type);
    if (!type) return;
    const properties = asObject(payload.properties);
    const directory = eventDirectory(candidate, properties);

    if (type === 'message.updated') {
      processMessageUpdated(properties, directory);
    } else if (type === 'message.part.updated') {
      processPartUpdated(properties, directory);
    } else if (type === 'session.status') {
      processSessionStatus(properties, directory);
    } else if (type === 'session.idle') {
      processSessionStatus({ ...properties, status: { type: 'idle' } }, directory);
    } else if (
      type === 'session.error'
      || type === 'session.aborted'
      || type === 'session.deleted'
    ) {
      const info = asObject(properties.info);
      const sessionID = sessionIdFrom(properties, info);
      const cancelled = /^(AbortError|MessageAbortedError)$/.test(asString(asObject(properties.error).name));
      settleTurn(activeTurn(sessionID), type === 'session.error' && !cancelled ? 'failed' : 'aborted', type);
    }
  };

  return {
    processEvent,
    recordPromptAccepted,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getActiveTurn(sessionID) {
      const turn = activeTurn(asString(sessionID));
      return turn ? { ...turn } : null;
    },
  };
};

export { FINAL_TOOL_STATUSES };
