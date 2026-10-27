// Observational delivery: an immediate try/catch plus rejection handling, so a
// sync throw or a rejection never skips later deliveries. Authority-bearing
// steps (session state, primary recovery, managed orchestration) are called
// bare and keep their failure behaviour.
const callAsync = (label, callback, payload, logger) => {
  if (typeof callback !== 'function') return;
  try {
    const result = callback(payload);
    if (result && typeof result.catch === 'function') {
      void result.catch((error) => logger.warn(`${label}:`, error?.message ?? error));
    }
  } catch (error) {
    logger.warn(`${label}:`, error?.message ?? error);
  }
};

export function createCanonicalOpenCodeEventProcessor({
  cacheSessionInfo,
  sendPush,
  processSessionState,
  processTurnTiming,
  recordJournalEvent,
  recordMultiUserActivity,
  processEvidence,
  processBrowserLease,
  processManagedOrchestration,
  processSessionTitle,
  processCommandDeadline,
  onSessionDeleted,
  logger = console,
}) {
  return (payload, directory = null) => {
    if (!payload || typeof payload !== 'object') return;

    callAsync('[SessionInfo] Failed to cache OpenCode session', cacheSessionInfo, payload, logger);
    callAsync('[Push] Failed to process OpenCode event', sendPush, payload, logger);
    processSessionState?.(payload);
    callAsync('[TurnTiming] Failed to process OpenCode event', processTurnTiming, payload, logger);
    // The journal runtime isolates its own record; its primary recovery step may throw.
    recordJournalEvent?.(payload, directory);
    callAsync('[MultiUser] Failed to project OpenCode activity', recordMultiUserActivity, payload, logger);
    callAsync('[Evidence] Failed to process OpenCode event', processEvidence, payload, logger);
    callAsync('[AgentBrowser] Failed to process session cleanup event', processBrowserLease, payload, logger);
    callAsync('[ManagedOrchestration] Failed to process OpenCode event',
      (event) => processManagedOrchestration?.(event, directory), payload, logger);
    callAsync('[SessionTitle] Failed to process OpenCode event', processSessionTitle, payload, logger);
    callAsync('[OpenCode] Failed to observe command deadline',
      (event) => processCommandDeadline?.(event, directory), payload, logger);

    if (payload.type !== 'session.deleted') return;
    const deletedSessionId = payload?.properties?.info?.id;
    if (typeof deletedSessionId === 'string' && deletedSessionId) {
      onSessionDeleted?.(deletedSessionId);
    }
  };
}

/** Events DevRyan synthesizes itself, in their own order: orchestration first,
 * then cache, session state, turn timing, journal, activity and evidence, and
 * finally the UI broadcast, which an observational failure cannot skip. */
export function createSyntheticOpenCodeEventEmitter({
  processManagedOrchestration,
  cacheSessionInfo,
  processSessionState,
  processTurnTiming,
  recordJournalEvent,
  recordMultiUserActivity,
  processEvidence,
  broadcast,
  logger = console,
}) {
  return (payload, options = {}) => {
    const directory = options.directory ?? null;
    processManagedOrchestration?.(payload, directory);
    callAsync('[SessionInfo] Failed to cache synthetic event', cacheSessionInfo, payload, logger);
    processSessionState?.(payload);
    callAsync('[TurnTiming] Failed to process synthetic event', processTurnTiming, payload, logger);
    recordJournalEvent?.(payload, directory);
    callAsync('[MultiUser] Failed to project synthetic activity', recordMultiUserActivity, payload, logger);
    callAsync('[Evidence] Failed to process synthetic event', processEvidence, payload, logger);
    broadcast?.(payload, options);
  };
}
