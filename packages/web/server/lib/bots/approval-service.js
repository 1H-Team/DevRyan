import { randomUUID } from 'node:crypto';

import { canApproveBotAction } from '@openchamber/bots-runtime';

import {
  assertExactObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const DECISIONS = new Set(['approved', 'denied']);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const MAX_WAIT_MS = 110_000;
const DECISION_POLL_MS = 1_000;

export class BotApprovalServiceError extends Error {
  constructor(message, code = 'bot_approval_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotApprovalServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotApprovalServiceError(message, code, statusCode);
};

export const publicBotActionAttempt = (row) => Object.freeze({
  id: row.id,
  runId: row.run_id,
  botId: row.bot_id,
  revisionId: row.revision_id,
  credentialId: row.credential_id || null,
  computerScopeKey: row.computer_scope_key,
  actionHash: row.action_hash,
  argsDigest: row.args_digest,
  tool: row.tool,
  action: row.action,
  target: structuredClone(row.target || {}),
  risk: row.risk,
  approvalClass: row.approval_class,
  policyEffect: row.policy_effect,
  policyRuleIds: Object.freeze([...(row.policy_rule_ids || [])]),
  decisionExpiresAt: row.decision_expires_at,
  requiresDistinctApprover: row.requires_distinct_approver === true,
  retainEvidence: row.retain_evidence === true,
  state: row.state,
  unknownOutcome: row.unknown_outcome === true,
  reconciliationDecision: row.reconciliation_decision || null,
  initiatedBy: row.initiated_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at || null,
  finishedAt: row.finished_at || null,
});

const publicApproval = (row) => Object.freeze({
  id: row.id,
  actionAttemptId: row.action_attempt_id,
  actionHash: row.action_hash,
  revisionId: row.revision_id,
  argsDigest: row.args_digest,
  approverUserId: row.approver_user_id,
  decision: row.decision,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

const normalizeDecisionRequest = (value) => {
  try {
    assertExactObject(value, {
      label: 'Bot approval decision',
      required: ['actionHash', 'revisionId', 'argsDigest', 'decision'],
    });
  } catch (error) {
    fail(error.message);
  }
  const actionHash = validateBoundedString(value.actionHash, 'actionHash', {
    maximum: 80,
    pattern: /^sha256:[0-9a-f]{64}$/,
  });
  const argsDigest = validateBoundedString(value.argsDigest, 'argsDigest', {
    maximum: 64,
    pattern: /^[0-9a-f]{64}$/,
  });
  if (!DECISIONS.has(value.decision)) fail('Approval decision is invalid');
  return Object.freeze({
    actionHash,
    revisionId: validateUuid(value.revisionId, 'revisionId'),
    argsDigest,
    decision: value.decision,
  });
};

export function createBotApprovalService({
  store,
  authorization,
  channels,
  eventStream,
  audit = async () => {},
  onRunSettled = async () => {},
  logger = console,
  now = () => new Date(),
  uuid = randomUUID,
  decisionPollMs = DECISION_POLL_MS,
} = {}) {
  if (!store?.repositories?.bot_action_attempts || !store.repositories?.bot_approvals
    || !store.repositories?.bot_runs || !store.repositories?.bot_memberships
    || typeof store.expireApprovals !== 'function'
    || !authorization || typeof authorization.requireActiveMembership !== 'function'
    || !channels || typeof channels.audienceForChannel !== 'function'
    || typeof channels.publicRun !== 'function'
    || !eventStream || typeof eventStream.publish !== 'function'
    || typeof audit !== 'function' || typeof onRunSettled !== 'function'
    || !logger || typeof logger.warn !== 'function'
    || typeof now !== 'function' || typeof uuid !== 'function'
    || !Number.isSafeInteger(decisionPollMs) || decisionPollMs < 1 || decisionPollMs > 10_000) {
    throw new TypeError('Bot approval service is misconfigured');
  }
  const waiters = new Map();

  const runExpirySideEffect = async (label, identifiers, effect) => {
    try {
      await effect();
    } catch (error) {
      logger.warn?.(`[bots] Approval expiry ${label} failed`, {
        ...identifiers,
        code: typeof error?.code === 'string' ? error.code : 'bot_expiry_side_effect_failed',
      });
    }
  };

  const loadAction = async (actionAttemptId) => {
    const action = await store.repositories.bot_action_attempts.get({
      id: validateUuid(actionAttemptId, 'actionAttemptId'),
    });
    if (!action) fail('Bot action was not found', 'bot_action_not_found', 404);
    return action;
  };

  const audienceForAction = async (action) => {
    const page = await store.repositories.bot_memberships.list({
      filters: { bot_id: action.bot_id, revoked_at: null },
      limit: 100,
    });
    const users = new Set([action.initiated_by]);
    for (const membership of page.items) {
      users.add(membership.user_id);
    }
    return [...users];
  };

  const notify = (action) => {
    const listeners = waiters.get(action.id);
    if (!listeners) return;
    waiters.delete(action.id);
    for (const listener of listeners) listener(action);
  };

  const updateRunAfterDecision = async (action, decision) => {
    const run = await store.repositories.bot_runs.get({ id: action.run_id, bot_id: action.bot_id });
    if (!run || run.state !== 'waiting_approval') return run;
    return store.repositories.bot_runs.updateIfRevision(
      { id: run.id },
      {
        state: decision === 'approved' ? 'running' : 'failed',
        ...(decision === 'denied' ? {
          interruption_kind: 'bot_action_denied',
          finished_at: now().toISOString(),
        } : {}),
      },
      run.updated_at,
    );
  };

  const mayApprove = (action, principal, membership) => canApproveBotAction({
    approvalClass: action.approval_class,
    requesterUserId: action.initiated_by,
    approverUserId: principal.id,
    approverRole: membership.role,
    requireDistinctApprover: action.requires_distinct_approver === true,
  });

  const listPendingForPrincipal = async ({ principal, limit = 100, approvableOnly }) => {
    if (!principal?.id) fail('Authentication required', 'bot_authentication_required', 401);
    const pageLimit = Number(limit);
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
      fail('Approval page limit is invalid');
    }
    const page = await store.repositories.bot_action_attempts.list({
      filters: { state: 'pending_approval' },
      limit: pageLimit,
    });
    const actions = [];
    for (const action of page.items) {
      try {
        const run = await store.repositories.bot_runs.get({
          id: action.run_id,
          bot_id: action.bot_id,
        });
        if (!run || TERMINAL_RUN_STATES.has(run.state)) {
          if (run) await cancelPendingForRun({ run });
          continue;
        }
        const { membership } = await authorization.requireActiveMembership(principal, action.bot_id);
        if ((!approvableOnly && action.initiated_by === principal.id)
          || mayApprove(action, principal, membership)) {
          actions.push(publicBotActionAttempt(action));
        }
      } catch (error) {
        if (error?.statusCode !== 403) throw error;
      }
    }
    return Object.freeze({ actions: Object.freeze(actions), nextCursor: page.nextCursor || null });
  };

  const listPending = ({ principal, limit = 100 } = {}) => listPendingForPrincipal({
    principal,
    limit,
    approvableOnly: true,
  });

  const cancelPendingForRun = async ({ run } = {}) => {
    const runId = validateUuid(run?.id, 'run.id');
    const botId = validateUuid(run?.bot_id, 'run.bot_id');
    const cancelled = [];
    let cursor = null;
    do {
      const page = await store.repositories.bot_action_attempts.list({
        filters: { run_id: runId, state: 'pending_approval' },
        cursor,
        limit: 100,
      });
      for (const candidate of page.items) {
        if (candidate.run_id !== runId || candidate.bot_id !== botId
          || candidate.state !== 'pending_approval') continue;
        let action;
        try {
          action = await store.repositories.bot_action_attempts.updateIfRevision(
            { id: candidate.id },
            { state: 'cancelled' },
            candidate.updated_at,
          );
        } catch (error) {
          if (error?.code !== 'bot_revision_conflict') throw error;
          action = await store.repositories.bot_action_attempts.get({ id: candidate.id });
          if (action?.state !== 'cancelled') continue;
        }
        cancelled.push(action);
        await store.releaseActionQuotas?.({
          actionAttemptId: action.id,
          disposition: 'released',
          now: now().toISOString(),
        }).catch((error) => logger.warn?.('[bots] Action quota release failed', {
          actionAttemptId: action.id,
          code: error?.code || 'bot_quota_release_failed',
        }));
        notify(action);
        await eventStream.publish({
          kind: 'action.cancelled',
          botId: action.bot_id,
          audienceUserIds: await audienceForAction(action),
          payload: { action: publicBotActionAttempt(action) },
        });
      }
      cursor = page.nextCursor || null;
    } while (cursor);
    return Object.freeze(cancelled.map(publicBotActionAttempt));
  };

  const expirePending = async ({ computerScopeKey = null } = {}) => {
    if (computerScopeKey !== null) {
      validateBoundedString(computerScopeKey, 'computerScopeKey', { maximum: 512 });
    }
    const result = await store.expireApprovals({
      computerScopeKey,
      now: now().toISOString(),
    });
    const actions = Array.isArray(result?.actions) ? result.actions : [];
    const runs = Array.isArray(result?.runs) ? result.runs : [];
    const scopeKeys = Array.isArray(result?.scopeKeys)
      ? result.scopeKeys.filter((scopeKey) => typeof scopeKey === 'string')
      : [];
    for (const action of actions) {
      await runExpirySideEffect('quota release', {
        actionAttemptId: action.id,
        runId: action.run_id,
      }, async () => {
        await store.releaseActionQuotas?.({
          actionAttemptId: action.id,
          disposition: 'expired',
          now: now().toISOString(),
        });
      });
      notify(action);
      const identifiers = { actionAttemptId: action.id, runId: action.run_id };
      await runExpirySideEffect('action event publication', identifiers, async () => {
        await eventStream.publish({
          kind: 'action.cancelled',
          botId: action.bot_id,
          audienceUserIds: await audienceForAction(action),
          payload: { action: publicBotActionAttempt(action) },
        });
      });
      await runExpirySideEffect('audit recording', identifiers, async () => {
        await audit({
          principal: null,
          botId: action.bot_id,
          targetType: 'bot_action_attempt',
          targetId: action.id,
          action: 'bot.action.approval_expired',
          result: 'success',
          metadata: {
            runId: action.run_id,
            actionHash: action.action_hash,
            revisionId: action.revision_id,
            requesterUserId: action.initiated_by,
            approvalClass: action.approval_class,
            expiresAt: action.decision_expires_at,
          },
        });
      });
    }

    for (const run of runs) {
      const identifiers = { runId: run.id };
      await runExpirySideEffect('run event publication', identifiers, async () => {
        await eventStream.publish({
          kind: 'run.failed',
          botId: run.bot_id,
          channelId: run.channel_id,
          audienceUserIds: await channels.audienceForChannel(run.channel_id),
          payload: {
            run: channels.publicRun(run),
            code: 'bot_approval_expired',
          },
        });
      });
      await runExpirySideEffect('run settlement', identifiers, async () => {
        await onRunSettled({ run });
      });
    }

    return Object.freeze({
      actions: Object.freeze(actions.map(publicBotActionAttempt)),
      runs: Object.freeze(runs.map((run) => channels.publicRun(run))),
      scopeKeys: Object.freeze([...new Set(scopeKeys)]),
    });
  };

  return Object.freeze({
    async decide({ principal, actionAttemptId, request } = {}) {
      if (!principal?.id) fail('Authentication required', 'bot_authentication_required', 401);
      const normalized = normalizeDecisionRequest(request);
      let action = await loadAction(actionAttemptId);
      const { membership } = await authorization.requireActiveMembership(principal, action.bot_id);
      if (normalized.actionHash !== action.action_hash
        || normalized.revisionId !== action.revision_id
        || normalized.argsDigest !== action.args_digest) {
        fail(
          'Approval does not match the exact action',
          'bot_approval_binding_mismatch',
          409,
        );
      }
      const currentTime = now().getTime();
      if (!Number.isFinite(currentTime) || Date.parse(action.decision_expires_at) <= currentTime) {
        fail('Bot approval has expired', 'bot_approval_expired', 410);
      }
      if (!mayApprove(action, principal, membership)) {
        fail(
          'This Bot action requires a different authorized approver',
          'bot_approval_separation_required',
          403,
        );
      }

      const existing = await store.repositories.bot_approvals.get({
        action_attempt_id: action.id,
        approver_user_id: principal.id,
      });
      if (existing) {
        if (existing.action_hash !== normalized.actionHash
          || existing.revision_id !== normalized.revisionId
          || existing.args_digest !== normalized.argsDigest
          || existing.decision !== normalized.decision) {
          fail('Approval decision is immutable', 'bot_approval_conflict', 409);
        }
        return Object.freeze({ action: publicBotActionAttempt(action), approval: publicApproval(existing) });
      }
      if (action.state !== 'pending_approval') {
        fail('Bot action is not awaiting approval', 'bot_approval_not_pending', 409);
      }
      const approval = await store.repositories.bot_approvals.insert({
        id: validateUuid(uuid(), 'approvalId'),
        action_attempt_id: action.id,
        action_hash: action.action_hash,
        revision_id: action.revision_id,
        args_digest: action.args_digest,
        approver_user_id: principal.id,
        decision: normalized.decision,
        expires_at: action.decision_expires_at,
        matcher_version: action.matcher_version || null,
        policy_facts_digest: action.policy_facts_digest || null,
        authoritative_actor_role: action.authoritative_actor_role || null,
        quota_binding: action.quota_binding || null,
      });
      action = await store.repositories.bot_action_attempts.updateIfRevision(
        { id: action.id },
        {
          state: normalized.decision === 'approved' ? 'approved' : 'denied',
          ...(normalized.decision === 'denied' ? { finished_at: now().toISOString() } : {}),
        },
        action.updated_at,
      );
      if (normalized.decision === 'denied') {
        await store.releaseActionQuotas?.({
          actionAttemptId: action.id,
          disposition: 'released',
          now: now().toISOString(),
        }).catch((error) => logger.warn?.('[bots] Action quota release failed', {
          actionAttemptId: action.id,
          code: error?.code || 'bot_quota_release_failed',
        }));
      }
      await updateRunAfterDecision(action, normalized.decision).catch(() => undefined);
      notify(action);
      await eventStream.publish({
        kind: `action.${normalized.decision}`,
        botId: action.bot_id,
        audienceUserIds: await audienceForAction(action),
        payload: {
          action: publicBotActionAttempt(action),
          approval: publicApproval(approval),
        },
      });
      await audit({
        principal,
        botId: action.bot_id,
        targetType: 'bot_action_attempt',
        targetId: action.id,
        action: `bot.action.${normalized.decision}`,
        result: normalized.decision === 'approved' ? 'success' : 'denied',
        metadata: {
          runId: action.run_id,
          actionHash: action.action_hash,
          revisionId: action.revision_id,
          approverUserId: principal.id,
          requesterUserId: action.initiated_by,
          approvalClass: action.approval_class,
          expiresAt: action.decision_expires_at,
        },
      });
      return Object.freeze({
        action: publicBotActionAttempt(action),
        approval: publicApproval(approval),
      });
    },

    listPending,

    cancelPendingForRun,

    expirePending,

    snapshotForPrincipal: async (principal) => ({
      pendingApprovals: (await listPendingForPrincipal({
        principal,
        limit: 100,
        approvableOnly: false,
      }).catch(() => ({ actions: [] }))).actions,
    }),

    async waitForDecision(actionAttemptId, { signal, timeoutMs = MAX_WAIT_MS } = {}) {
      const actionId = validateUuid(actionAttemptId, 'actionAttemptId');
      const current = await loadAction(actionId);
      if (current.state !== 'pending_approval') return current;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) {
        fail('Approval wait timeout is invalid');
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        let pollInFlight = false;
        const listeners = waiters.get(actionId) || new Set();
        const finish = (value, error = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(pollTimer);
          signal?.removeEventListener('abort', onAbort);
          listeners.delete(onDecision);
          if (listeners.size === 0) waiters.delete(actionId);
          if (error) reject(error);
          else resolve(value);
        };
        const onDecision = (value) => finish(value);
        const onAbort = () => finish(null, new BotApprovalServiceError(
          'Approval wait was aborted',
          'bot_approval_wait_aborted',
          499,
        ));
        const timer = setTimeout(() => finish(null, new BotApprovalServiceError(
          'Bot action approval is still required',
          'bot_approval_required',
          409,
        )), timeoutMs);
        const pollTimer = setInterval(async () => {
          if (settled || pollInFlight) return;
          pollInFlight = true;
          try {
            const latest = await loadAction(actionId);
            if (latest.state !== 'pending_approval') finish(latest);
          } catch (error) {
            finish(null, error);
          } finally {
            pollInFlight = false;
          }
        }, decisionPollMs);
        timer.unref?.();
        pollTimer.unref?.();
        listeners.add(onDecision);
        waiters.set(actionId, listeners);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },

    notifyPending: async (action) => eventStream.publish({
      kind: 'action.pending_approval',
      botId: action.bot_id,
      audienceUserIds: await audienceForAction(action),
      payload: { action: publicBotActionAttempt(action) },
    }),
  });
}
