const RECOVERABLE_STATES = Object.freeze(['starting', 'running', 'waiting_control']);
const DURABLE_WAIT_STATES = Object.freeze(['waiting_approval', 'needs_reconciliation']);
const READ_ACTION_PATTERN = /^(?:read|get|list|search|inspect|status|download|navigate_read)(?:[_.:-]|$)/i;

export class BotRunRecoveryError extends Error {
  constructor(message, code = 'bot_run_recovery_failed', statusCode = 500) {
    super(message);
    this.name = 'BotRunRecoveryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const isInterruptedWrite = (attempt) => {
  const declaredKind = attempt?.target?.operationKind || attempt?.target?.operation_kind;
  if (declaredKind === 'read') return false;
  if (declaredKind === 'write') return true;
  return !READ_ACTION_PATTERN.test(String(attempt?.action || ''));
};

export function createBotRunRecovery({
  store,
  dispatcher,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!store?.repositories?.bot_runs || !store.repositories?.bot_action_attempts
    || typeof store.settleRunTerminal !== 'function'
    || !dispatcher || typeof dispatcher.resumeRun !== 'function'
    || typeof now !== 'function') {
    throw new TypeError('Bot run recovery is misconfigured');
  }

  const listState = async (state) => {
    const rows = [];
    let cursor = null;
    do {
      const page = await store.repositories.bot_runs.list({
        filters: { state },
        limit: 100,
        cursor,
      });
      rows.push(...page.items);
      cursor = page.nextCursor || null;
    } while (cursor && rows.length < 10_000);
    return rows;
  };

  return Object.freeze({
    async recover() {
      const result = {
        inspected: 0,
        resumed: 0,
        deferred: 0,
        needsReconciliation: 0,
        interrupted: 0,
        waiting: 0,
      };
      const waitingPages = await Promise.all(DURABLE_WAIT_STATES.map(listState));
      result.waiting = waitingPages.reduce((count, rows) => count + rows.length, 0);
      const recoverablePages = await Promise.all(RECOVERABLE_STATES.map(listState));
      for (const run of recoverablePages.flat()) {
        result.inspected += 1;
        const [executing, unknown] = await Promise.all([
          store.repositories.bot_action_attempts.list({
            filters: { run_id: run.id, state: 'executing' },
            limit: 100,
          }),
          store.repositories.bot_action_attempts.list({
            filters: { run_id: run.id, state: 'unknown' },
            limit: 100,
          }),
        ]);
        const writes = [
          ...unknown.items.filter(isInterruptedWrite),
          ...executing.items.filter(isInterruptedWrite),
        ];
        if (writes.length > 0) {
          for (const attempt of writes) {
            if (attempt.state === 'unknown') continue;
            await store.repositories.bot_action_attempts.updateIfRevision(
              { id: attempt.id },
              {
                state: 'unknown',
                unknown_outcome: true,
                finished_at: now().toISOString(),
              },
              attempt.updated_at,
            );
          }
          await store.repositories.bot_runs.updateIfRevision(
            { id: run.id },
            {
              state: 'needs_reconciliation',
              interruption_kind: 'runtime_loss_after_write',
              reconciliation_state: {
                version: 1,
                actionAttemptIds: writes.map((attempt) => attempt.id),
                detectedAt: now().toISOString(),
              },
            },
            run.updated_at,
          );
          result.needsReconciliation += 1;
          continue;
        }
        try {
          const outcome = await dispatcher.resumeRun(run);
          if (outcome?.claimed === false) result.deferred += 1;
          else if (outcome?.resumed === false) result.interrupted += 1;
          else result.resumed += 1;
        } catch (error) {
          const interruptionKind = error?.code || 'runtime_recovery_failed';
          const settled = await store.settleRunTerminal({
            runId: run.id,
            state: 'interrupted',
            interruptionKind,
            contextSnapshot: {
              ...(run.context_snapshot || {}),
              state: 'interrupted',
              failurePhase: 'recovery',
              failureStage: 'startup_recovery',
              retryable: false,
            },
            finishedAt: now().toISOString(),
          });
          if (!settled?.id) {
            throw new BotRunRecoveryError(
              'Bot run terminal recovery returned no run',
              'bot_run_terminal_settlement_missing',
              503,
            );
          }
          result.interrupted += 1;
          logger?.warn?.('[BotsRecovery] run resume failed', {
            runId: run.id,
            code: error?.code || 'runtime_recovery_failed',
          });
        }
      }
      return Object.freeze(result);
    },
  });
}

export { isInterruptedWrite as isInterruptedBotWrite };
