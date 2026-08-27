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
  processContextModeRecovery,
  processCommandDeadline,
  onSessionDeleted,
  logger = console,
}) {
  return (payload) => {
    if (!payload || typeof payload !== 'object') return;

    cacheSessionInfo?.(payload);
    callAsync('[Push] Failed to process OpenCode event', sendPush, payload, logger);
    processSessionState?.(payload);
    processTurnTiming?.(payload);
    recordJournalEvent?.(payload);
    callAsync('[MultiUser] Failed to project OpenCode activity', recordMultiUserActivity, payload, logger);
    callAsync('[Evidence] Failed to process OpenCode event', processEvidence, payload, logger);
    callAsync('[AgentBrowser] Failed to process session cleanup event', processBrowserLease, payload, logger);
    callAsync('[ManagedOrchestration] Failed to process OpenCode event', processManagedOrchestration, payload, logger);
    callAsync('[SessionTitle] Failed to process OpenCode event', processSessionTitle, payload, logger);
    callAsync('[OpenCode] Failed to observe context-mode recovery', processContextModeRecovery, payload, logger);
    callAsync('[OpenCode] Failed to observe command deadline', processCommandDeadline, payload, logger);

    if (payload.type !== 'session.deleted') return;
    const deletedSessionId = payload?.properties?.info?.id;
    if (typeof deletedSessionId === 'string' && deletedSessionId) {
      onSessionDeleted?.(deletedSessionId);
    }
  };
}
