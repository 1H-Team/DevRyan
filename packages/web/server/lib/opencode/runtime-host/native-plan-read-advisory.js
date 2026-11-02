const TERMINAL = new Set(['completed', 'failed', 'aborted', 'interrupted']);
export const PLAN_READ_ADVISORY_THRESHOLD = 4;
const MAX_TRACKED_SESSIONS = 512;

/** Non-blocking plan-mode read budget. Counts a root session's `read`/`grep`
 * calls once an Explorer started in the current objective has settled, journals
 * each count, and from the fourth returns a typed advisory for the tool result.
 * It never refuses a read; every failure yields no advisory.
 * Kill switch, read on each use: DEVRYAN_PLAN_READ_ADVISORY=0. */
export function createNativePlanReadAdvisory({ readManagedState, readPrimaryRecord, readPlanPolicy, readObjectiveStart, recordDiagnostic,
  enabled = () => process.env.DEVRYAN_PLAN_READ_ADVISORY !== '0' }) {
  const objectives = new Map();
  return async ({ sessionID, directory, tool }) => {
    if (!enabled() || !['read', 'grep'].includes(tool) || typeof sessionID !== 'string' || typeof directory !== 'string') return undefined;
    try {
      // The in-memory scheduler read is the cheap gate: child sessions and
      // roots without a settled Explorer stop here.
      const state = await readManagedState({ sessionID, directory });
      const explorers = Array.isArray(state?.tasks)
        ? state.tasks.filter(task => task?.agent === 'explorer' && TERMINAL.has(task.status) && Number.isFinite(task.createdAt)) : [];
      if (!explorers.length) return undefined;
      const primary = await readPrimaryRecord(sessionID);
      const objectiveID = primary?.objectiveID ?? primary?.anchorID;
      if (primary?.sessionID !== sessionID || primary.directory !== directory || typeof objectiveID !== 'string' || !objectiveID) return undefined;
      const key = `${directory}\0${sessionID}`;
      let entry = objectives.get(key);
      if (entry?.objectiveID !== objectiveID) {
        entry = { objectiveID, readOnly: false, since: null, count: 0, ready: null };
        const pending = entry;
        pending.ready = Promise.all([readPlanPolicy({ sessionID, directory }), readObjectiveStart({ sessionID, directory, objectiveID })])
          .then(([policy, since]) => { pending.readOnly = policy?.readOnly === true; pending.since = Number.isFinite(since) ? since : null; })
          .catch(error => { if (objectives.get(key) === pending) objectives.delete(key); throw error; });
        objectives.delete(key); objectives.set(key, entry);
        while (objectives.size > MAX_TRACKED_SESSIONS) objectives.delete(objectives.keys().next().value);
      }
      await entry.ready;
      if (objectives.get(key) !== entry) return undefined;
      if (!entry.readOnly || entry.since === null || !explorers.some(task => task.createdAt >= entry.since)) return undefined;
      entry.count += 1;
      try {
        recordDiagnostic?.({ type: 'lifecycle', event: 'plan_mode_read_after_explorer', sessionID, payload: { tool, count: entry.count } });
      } catch { /* Observer only. */ }
      if (entry.count < PLAN_READ_ADVISORY_THRESHOLD) return undefined;
      return { code: 'plan_mode_reread_after_explorer', count: entry.count,
        message: `Plan mode: ${entry.count} reads or greps after the Explorer report. Plan from its excerpts and cited path:line evidence; read only a named target it left open.` };
    } catch {
      return undefined;
    }
  };
}
