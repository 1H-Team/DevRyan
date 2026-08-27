import { describe, expect, it, vi } from 'vitest';

import { createBotApprovalService } from './approval-service.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const RUN_ID = 'c0000000-0000-4000-8000-000000000001';
const ACTION_ID = 'd0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'e0000000-0000-4000-8000-000000000001';
const REQUESTER_ID = 'a0000000-0000-4000-8000-000000000001';
const OPERATOR_ID = 'a0000000-0000-4000-8000-000000000002';
const MANAGER_ID = 'a0000000-0000-4000-8000-000000000003';
const APPROVAL_ID = 'f0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-23T12:00:00.000Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const ARGS_DIGEST = 'b'.repeat(64);

const action = (overrides = {}) => ({
  id: ACTION_ID,
  run_id: RUN_ID,
  bot_id: BOT_ID,
  revision_id: REVISION_ID,
  credential_id: null,
  computer_scope_key: `bot:${BOT_ID}`,
  action_hash: HASH,
  idempotency_key: 'action-1',
  tool: 'browser',
  action: 'click',
  target: { origin: 'https://example.com', goal: 'Open settings' },
  encrypted_args: { ciphertext: 'sealed' },
  args_digest: ARGS_DIGEST,
  risk: 'sensitive',
  approval_class: 'operator',
  policy_effect: 'prompt',
  policy_rule_ids: ['builtin.browser-submit'],
  decision_expires_at: '2026-08-23T12:15:00.000Z',
  requires_distinct_approver: true,
  retain_evidence: true,
  state: 'pending_approval',
  execution_receipt: null,
  unknown_outcome: false,
  reconciliation_decision: null,
  initiated_by: REQUESTER_ID,
  created_at: NOW,
  updated_at: NOW,
  started_at: null,
  finished_at: null,
  ...overrides,
});

const createHarness = ({
  currentAction = action(),
  roles = {},
  runState = 'waiting_approval',
  expiryResult = { actions: [], runs: [], scopeKeys: [] },
  publish = async () => ({ delivered: 1 }),
  auditEffect = async () => {},
  settlementEffect = async () => {},
} = {}) => {
  let storedAction = currentAction;
  let approval = null;
  let run = {
    id: RUN_ID,
    bot_id: BOT_ID,
    state: runState,
    updated_at: NOW,
  };
  const store = {
    expireApprovals: vi.fn(async () => expiryResult),
    repositories: {
      bot_action_attempts: {
        get: vi.fn(async () => storedAction),
        list: vi.fn(async () => ({ items: [storedAction], nextCursor: null })),
        updateIfRevision: vi.fn(async (_keys, changes) => {
          storedAction = { ...storedAction, ...changes, updated_at: '2026-08-23T12:01:00.000Z' };
          return storedAction;
        }),
      },
      bot_approvals: {
        get: vi.fn(async () => approval),
        insert: vi.fn(async (input) => {
          approval = { ...input, created_at: NOW };
          return approval;
        }),
      },
      bot_runs: {
        get: vi.fn(async () => run),
        updateIfRevision: vi.fn(async (_keys, changes) => {
          run = { ...run, ...changes, updated_at: '2026-08-23T12:01:00.000Z' };
          return run;
        }),
      },
      bot_memberships: {
        list: vi.fn(async () => ({
          items: [
            { user_id: REQUESTER_ID, role: roles[REQUESTER_ID] || 'member' },
            { user_id: OPERATOR_ID, role: roles[OPERATOR_ID] || 'operator' },
            { user_id: MANAGER_ID, role: roles[MANAGER_ID] || 'manager' },
          ],
        })),
      },
    },
  };
  const authorization = {
    requireActiveMembership: vi.fn(async (principal) => ({
      membership: { role: roles[principal.id] || (principal.id === REQUESTER_ID ? 'member' : 'operator') },
    })),
  };
  const eventStream = { publish: vi.fn(publish) };
  const audit = vi.fn(auditEffect);
  const onRunSettled = vi.fn(settlementEffect);
  const logger = { warn: vi.fn() };
  const channels = {
    audienceForChannel: vi.fn(async () => [REQUESTER_ID]),
    publicRun: vi.fn((row) => ({
      id: row.id,
      botId: row.bot_id,
      channelId: row.channel_id,
      state: row.state,
      interruptionKind: row.interruption_kind || null,
    })),
  };
  const service = createBotApprovalService({
    store,
    authorization,
    channels,
    eventStream,
    audit,
    onRunSettled,
    logger,
    now: () => new Date(NOW),
    uuid: () => APPROVAL_ID,
    decisionPollMs: 5,
  });
  return {
    service,
    store,
    eventStream,
    audit,
    onRunSettled,
    logger,
    getAction: () => storedAction,
    setAction: (next) => {
      storedAction = next;
    },
  };
};

const request = (overrides = {}) => ({
  actionHash: HASH,
  revisionId: REVISION_ID,
  argsDigest: ARGS_DIGEST,
  decision: 'approved',
  ...overrides,
});

describe('Bot durable approvals', () => {
  it('publishes and settles only approvals atomically expired by the store', async () => {
    const expiredAction = action({
      state: 'cancelled',
      decision_expires_at: '2026-08-23T11:59:00.000Z',
    });
    const expiredRun = {
      id: RUN_ID,
      bot_id: BOT_ID,
      channel_id: 'c0000000-0000-4000-8000-000000000002',
      state: 'failed',
      interruption_kind: 'bot_approval_expired',
    };
    const harness = createHarness({
      expiryResult: {
        actions: [expiredAction],
        runs: [expiredRun],
        scopeKeys: [`bot:${BOT_ID}`],
      },
    });

    await expect(harness.service.expirePending({ computerScopeKey: `bot:${BOT_ID}` }))
      .resolves.toMatchObject({
        actions: [{ id: ACTION_ID, state: 'cancelled' }],
        runs: [{ id: RUN_ID, state: 'failed', interruptionKind: 'bot_approval_expired' }],
        scopeKeys: [`bot:${BOT_ID}`],
      });
    expect(harness.store.expireApprovals).toHaveBeenCalledWith({
      computerScopeKey: `bot:${BOT_ID}`,
      now: NOW,
    });
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'action.cancelled',
    }));
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.failed',
      payload: expect.objectContaining({ code: 'bot_approval_expired' }),
    }));
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      principal: null,
      action: 'bot.action.approval_expired',
    }));
    expect(harness.onRunSettled).toHaveBeenCalledWith({ run: expiredRun });
  });

  it('is a no-op when the atomic expiry RPC finds no eligible approvals', async () => {
    const harness = createHarness();
    await expect(harness.service.expirePending()).resolves.toEqual({
      actions: [],
      runs: [],
      scopeKeys: [],
    });
    expect(harness.eventStream.publish).not.toHaveBeenCalled();
    expect(harness.audit).not.toHaveBeenCalled();
    expect(harness.onRunSettled).not.toHaveBeenCalled();
  });

  it('still releases the scope when publication, audit, or settlement side effects fail', async () => {
    const expiredAction = action({ state: 'cancelled' });
    const expiredRun = {
      id: RUN_ID,
      bot_id: BOT_ID,
      channel_id: 'c0000000-0000-4000-8000-000000000002',
      state: 'failed',
      interruption_kind: 'bot_approval_expired',
    };
    const failure = Object.assign(new Error('secondary service unavailable'), { code: 'temporary' });
    const harness = createHarness({
      expiryResult: {
        actions: [expiredAction],
        runs: [expiredRun],
        scopeKeys: [`bot:${BOT_ID}`],
      },
      publish: async () => { throw failure; },
      auditEffect: async () => { throw failure; },
      settlementEffect: async () => { throw failure; },
    });

    await expect(harness.service.expirePending()).resolves.toMatchObject({
      scopeKeys: [`bot:${BOT_ID}`],
    });
    expect(harness.logger.warn).toHaveBeenCalledTimes(4);
  });

  it('includes the bound args digest in the pending UI projection', async () => {
    const harness = createHarness();

    await expect(harness.service.listPending({
      principal: { id: OPERATOR_ID },
    })).resolves.toMatchObject({
      actions: [{ id: ACTION_ID, actionHash: HASH, argsDigest: ARGS_DIGEST }],
    });
  });

  it('shows a requester their paused action without offering self-approval', async () => {
    const harness = createHarness({ roles: { [REQUESTER_ID]: 'operator' } });

    await expect(harness.service.listPending({
      principal: { id: REQUESTER_ID },
    })).resolves.toMatchObject({ actions: [] });
    await expect(harness.service.snapshotForPrincipal({ id: REQUESTER_ID })).resolves.toMatchObject({
      pendingApprovals: [{ id: ACTION_ID, requiresDistinctApprover: true }],
    });
  });

  it('allows the requester to confirm an exact low-risk action', async () => {
    const harness = createHarness({
      currentAction: action({
        risk: 'low',
        approval_class: 'requester',
        requires_distinct_approver: false,
      }),
    });

    await expect(harness.service.decide({
      principal: { id: REQUESTER_ID },
      actionAttemptId: ACTION_ID,
      request: request(),
    })).resolves.toMatchObject({
      action: { state: 'approved' },
      approval: { approverUserId: REQUESTER_ID },
    });
  });

  it('requires another Operator for sensitive actions', async () => {
    const harness = createHarness({ roles: { [REQUESTER_ID]: 'operator' } });
    await expect(harness.service.decide({
      principal: { id: REQUESTER_ID },
      actionAttemptId: ACTION_ID,
      request: request(),
    })).rejects.toMatchObject({ code: 'bot_approval_separation_required' });

    await expect(harness.service.decide({
      principal: { id: OPERATOR_ID },
      actionAttemptId: ACTION_ID,
      request: request(),
    })).resolves.toMatchObject({
      action: { state: 'approved' },
      approval: { approverUserId: OPERATOR_ID, decision: 'approved' },
    });
  });

  it('requires a Manager for critical actions and honors explicit non-self approval', async () => {
    const critical = action({
      risk: 'critical',
      approval_class: 'manager',
      initiated_by: MANAGER_ID,
      requires_distinct_approver: true,
    });
    const self = createHarness({ currentAction: critical, roles: { [MANAGER_ID]: 'manager' } });
    await expect(self.service.decide({
      principal: { id: MANAGER_ID },
      actionAttemptId: ACTION_ID,
      request: request(),
    })).rejects.toMatchObject({ code: 'bot_approval_separation_required' });

    const other = createHarness({
      currentAction: critical,
      roles: { [MANAGER_ID]: 'manager', [OPERATOR_ID]: 'manager' },
    });
    await expect(other.service.decide({
      principal: { id: OPERATOR_ID },
      actionAttemptId: ACTION_ID,
      request: request(),
    })).resolves.toMatchObject({ action: { state: 'approved' } });
  });

  it('rejects expired decisions and any action-hash/revision/args mismatch', async () => {
    const expired = createHarness({
      currentAction: action({ decision_expires_at: '2026-08-23T11:59:59.000Z' }),
    });
    await expect(expired.service.decide({
      principal: { id: OPERATOR_ID },
      actionAttemptId: ACTION_ID,
      request: request(),
    })).rejects.toMatchObject({ code: 'bot_approval_expired' });

    for (const changed of [
      { actionHash: `sha256:${'c'.repeat(64)}` },
      { revisionId: 'e0000000-0000-4000-8000-000000000002' },
      { argsDigest: 'd'.repeat(64) },
    ]) {
      const harness = createHarness();
      await expect(harness.service.decide({
        principal: { id: OPERATOR_ID },
        actionAttemptId: ACTION_ID,
        request: request(changed),
      })).rejects.toMatchObject({ code: 'bot_approval_binding_mismatch' });
      expect(harness.store.repositories.bot_approvals.insert).not.toHaveBeenCalled();
    }
  });

  it('wakes an exact pending action after its durable decision', async () => {
    const harness = createHarness();
    const waiting = harness.service.waitForDecision(ACTION_ID, { timeoutMs: 1_000 });
    await harness.service.decide({
      principal: { id: OPERATOR_ID },
      actionAttemptId: ACTION_ID,
      request: request(),
    });

    await expect(waiting).resolves.toMatchObject({ id: ACTION_ID, state: 'approved' });
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'action.approved',
    }));
  });

  it('observes a durable decision made outside this service instance', async () => {
    const harness = createHarness();
    const waiting = harness.service.waitForDecision(ACTION_ID, { timeoutMs: 1_000 });
    await Promise.resolve();
    harness.setAction(action({ state: 'approved', updated_at: '2026-08-23T12:01:00.000Z' }));

    await expect(waiting).resolves.toMatchObject({ id: ACTION_ID, state: 'approved' });
  });

  it('terminalizes and wakes pending approvals when their run is cancelled', async () => {
    const harness = createHarness();
    const waiting = harness.service.waitForDecision(ACTION_ID, { timeoutMs: 1_000 });

    await expect(harness.service.cancelPendingForRun({
      run: { id: RUN_ID, bot_id: BOT_ID },
    })).resolves.toMatchObject([{ id: ACTION_ID, state: 'cancelled' }]);

    await expect(waiting).resolves.toMatchObject({ id: ACTION_ID, state: 'cancelled' });
    expect(harness.getAction()).toMatchObject({ state: 'cancelled', started_at: null });
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'action.cancelled',
      payload: { action: expect.objectContaining({ id: ACTION_ID, state: 'cancelled' }) },
    }));
  });

  it('repairs legacy pending approvals whose run is already terminal', async () => {
    const harness = createHarness({ runState: 'cancelled' });

    await expect(harness.service.snapshotForPrincipal({ id: REQUESTER_ID })).resolves.toEqual({
      pendingApprovals: [],
    });
    expect(harness.getAction()).toMatchObject({ state: 'cancelled' });
  });
});
