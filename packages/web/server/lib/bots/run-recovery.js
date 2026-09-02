import { botErrorLogFields } from './error-normalization.js';

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

  const queuedScopeKeys = async ({ minAgeMs = 0 } = {}) => {
    const cutoff = now().getTime() - minAgeMs;
    const keys = new Set();
    for (const run of await listState('queued')) {
      const createdAt = Date.parse(run.created_at || '');
      if (Number.isFinite(createdAt) && createdAt > cutoff) continue;
      if (typeof run.computer_scope_key === 'string' && run.computer_scope_key) {
        keys.add(run.computer_scope_key);
      }
    }
    return Object.freeze([...keys]);
  };

  const leaseExpired = (run) => {
    const leaseUntil = Date.parse(run?.lease_until || '');
    return !Number.isFinite(leaseUntil) || leaseUntil < now().getTime();
  };

  const recoverRuns = async (runs, result) => {
      for (const run of runs) {
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
            ...botErrorLogFields(error, 'runtime_recovery_failed'),
          });
        }
      }
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
        queuedScopeKeys: [],
      };
      const waitingPages = await Promise.all(DURABLE_WAIT_STATES.map(listState));
      result.waiting = waitingPages.reduce((count, rows) => count + rows.length, 0);
      const recoverablePages = await Promise.all(RECOVERABLE_STATES.map(listState));
      await recoverRuns(recoverablePages.flat(), result);
      // Queued runs are never resumed here; they simply need a drain so the
      // claim RPC (the lease authority) can pick them up after a restart.
      result.queuedScopeKeys = await queuedScopeKeys();
      return Object.freeze(result);
    },

    // Periodic safety net for a live process: re-drain scopes that still hold
    // queued runs older than `minQueuedAgeMs` (a lost wake, a drain that died
    // with its process, a sibling runtime that stopped) and inspect executing
    // runs whose lease expired while nobody in this process owns them.
    async sweep({ minQueuedAgeMs = 30_000, isExecuting = () => false } = {}) {
      const result = {
        inspected: 0,
        resumed: 0,
        deferred: 0,
        needsReconciliation: 0,
        interrupted: 0,
        waiting: 0,
        queuedScopeKeys: await queuedScopeKeys({ minAgeMs: minQueuedAgeMs }),
      };
      const recoverablePages = await Promise.all(RECOVERABLE_STATES.map(listState));
      const orphaned = recoverablePages.flat()
        .filter((run) => leaseExpired(run) && !isExecuting(run.id));
      await recoverRuns(orphaned, result);
      return Object.freeze(result);
    },
  });
}

export { isInterruptedWrite as isInterruptedBotWrite };
