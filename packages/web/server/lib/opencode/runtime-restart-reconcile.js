const LIVE_STATUS_TYPES = new Set(['busy', 'retry']);

/**
 * After a managed OpenCode restart, sessions the server still believes are
 * busy may have died with the old process: the new one never publishes their
 * idle. Settle only those the restarted runtime authoritatively reports idle,
 * per directory; an unreadable directory is left untouched.
 */
export const createRuntimeRestartReconciler = ({
  listActiveSessions,
  resolveSessionDirectory,
  readRuntimeStatuses,
  isSessionLiveElsewhere = () => false,
  settleSession,
  recordDiagnostic = () => {},
  logger = console,
}) => {
  const reconcile = async ({ restartStartedAt = Date.now() } = {}) => {
    const summary = { candidates: 0, settled: 0, live: 0, unresolved: 0, failedDirectories: 0 };
    // Anything updated after the restart began came from the new runtime.
    const candidates = listActiveSessions().filter((session) => (
      LIVE_STATUS_TYPES.has(session.status)
      && Number.isFinite(session.lastUpdateAt)
      && session.lastUpdateAt <= restartStartedAt
      && !isSessionLiveElsewhere(session.sessionId)
    ));
    summary.candidates = candidates.length;
    if (candidates.length === 0) return summary;

    const byDirectory = new Map();
    await Promise.all(candidates.map(async ({ sessionId }) => {
      const directory = await Promise.resolve(resolveSessionDirectory(sessionId)).catch(() => null);
      if (typeof directory !== 'string' || !directory) {
        summary.unresolved += 1;
        return;
      }
      byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), sessionId]);
    }));

    await Promise.all([...byDirectory].map(async ([directory, sessionIds]) => {
      let statuses;
      try {
        statuses = await readRuntimeStatuses(directory);
      } catch (error) {
        summary.failedDirectories += 1;
        logger.warn?.(`[OpenCode] Restart reconciliation could not read session status: ${error?.message || error}`);
        return;
      }
      for (const sessionId of sessionIds) {
        if (LIVE_STATUS_TYPES.has(statuses?.[sessionId]?.type)) {
          summary.live += 1;
          continue;
        }
        try {
          settleSession({ sessionId, directory });
          summary.settled += 1;
        } catch (error) {
          logger.warn?.(`[OpenCode] Restart reconciliation could not settle a session: ${error?.message || error}`);
        }
      }
    }));

    recordDiagnostic(summary);
    return summary;
  };

  return { reconcile };
};
