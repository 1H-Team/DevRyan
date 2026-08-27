import { describe, expect, it, vi } from 'vitest';

import { createBotActionGateway } from './action-gateway.js';
import { BotBrowserServiceError } from './browser-service.js';
import { createBotPolicyEngine } from './policy-engine.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const RUN_ID = 'd0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'e0000000-0000-4000-8000-000000000001';
const ACTION_ID = 'f0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-23T12:00:00.000Z';
const KEY = Buffer.alloc(32, 0x51);

const claims = () => ({
  botId: BOT_ID,
  runId: RUN_ID,
  channelId: CHANNEL_ID,
  revisionId: REVISION_ID,
  scopeKey: `channel:${CHANNEL_ID}`,
  kind: 'reasoning',
});

const computerPayload = (overrides = {}) => ({
  idempotencyKey: 'browser-action-1',
  command: 'snapshot',
  args: {},
  target: {},
  limits: {},
  ...overrides,
});

const routineSnapshot = (overrides = {}) => ({
  routine: {
    version: 1,
    routineId: 'c1000000-0000-4000-8000-000000000001',
    occurrenceId: 'c2000000-0000-4000-8000-000000000001',
    scheduledFor: '2026-08-23T11:00:00.000Z',
    recovered: true,
    freshApprovalRequired: true,
    contract: {
      version: 1,
      rationale: 'Review the approved site.',
      trigger: { kind: 'daily', time: '11:00' },
      timezone: 'UTC',
      goal: 'Inspect the approved page.',
      inputs: {},
      allowedTools: ['browser'],
      allowedAccountIds: [],
      allowedOrigins: ['https://example.com'],
      limits: { maxActions: 2, maxExternalWrites: 1 },
      approvalClass: 'requester',
      timeoutSeconds: 600,
      missedPolicy: 'run_once',
      missedRunCap: 1,
      completionCriteria: ['The page is inspected.'],
      ...overrides,
    },
  },
});

const createHarness = ({
  connectorRegistry: connectorOverride,
  runContextSnapshot = null,
  onRunSettled = vi.fn(async () => {}),
  policy = { defaultEffect: 'allow', defaultRisk: 'low', rules: [] },
  quotaServices = {},
} = {}) => {
  let nextActionId = 1;
  let currentRun = {
    id: RUN_ID,
    bot_id: BOT_ID,
    channel_id: CHANNEL_ID,
    revision_id: REVISION_ID,
    computer_scope_key: `bot:${BOT_ID}`,
    state: 'running',
    context_snapshot: runContextSnapshot,
    updated_at: NOW,
    finished_at: null,
  };
  const actions = [];
  const actionRepository = {
    get: vi.fn(async (filters) => actions.find((row) => (
      Object.entries(filters).every(([key, value]) => row[key] === value)
    )) || null),
    list: vi.fn(async ({ filters = {}, limit = 100 } = {}) => ({
      items: actions.filter((row) => Object.entries(filters)
        .every(([key, value]) => row[key] === value)).slice(0, limit),
      nextCursor: null,
    })),
    insert: vi.fn(async (input) => {
      if (actions.some((row) => row.run_id === input.run_id
        && row.idempotency_key === input.idempotency_key)) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      const row = { ...structuredClone(input), created_at: NOW, updated_at: NOW };
      actions.push(row);
      return row;
    }),
    updateIfRevision: vi.fn(async (filters, changes, expected) => {
      const row = actions.find((candidate) => (
        Object.entries(filters).every(([key, value]) => candidate[key] === value)
      ));
      if (!row || row.updated_at !== expected) {
        throw Object.assign(new Error('conflict'), { code: 'bot_revision_conflict' });
      }
      Object.assign(row, structuredClone(changes), {
        updated_at: new Date(Date.parse(row.updated_at) + 1_000).toISOString(),
      });
      return structuredClone(row);
    }),
  };
  const store = {
    repositories: {
      bot_action_attempts: actionRepository,
      bot_runs: {
        get: vi.fn(async (filters) => (
          Object.entries(filters).every(([key, value]) => currentRun[key] === value)
            ? structuredClone(currentRun)
            : null
        )),
        updateIfRevision: vi.fn(async (_filters, changes, expected) => {
          if (currentRun.updated_at !== expected) {
            throw Object.assign(new Error('conflict'), { code: 'bot_revision_conflict' });
          }
          currentRun = {
            ...currentRun,
            ...structuredClone(changes),
            updated_at: new Date(Date.parse(currentRun.updated_at) + 1_000).toISOString(),
          };
          return structuredClone(currentRun);
        }),
      },
      bots: { get: vi.fn(async () => ({ id: BOT_ID, tenancy: 'team' })) },
      bot_channels: {
        get: vi.fn(async () => ({ id: CHANNEL_ID, bot_id: BOT_ID, owner_user_id: USER_ID })),
      },
      bot_revisions: {
        get: vi.fn(async () => ({
          id: REVISION_ID,
          bot_id: BOT_ID,
          contract: { actionPolicy: policy, browserPolicy: {} },
        })),
      },
      bot_messages: {
        get: vi.fn(async () => ({ run_id: RUN_ID, role: 'user', actor_user_id: USER_ID })),
      },
      bot_credentials: { get: vi.fn(async () => null) },
    },
    ...quotaServices,
  };
  const browserService = {
    executeAction: vi.fn(async ({ command }) => ({
      result: command === 'snapshot' ? { nodes: [{ ref: 'button-1' }] } : { clicked: true },
      operationKind: command === 'snapshot' ? 'read' : 'write',
      nativeExactlyOnce: false,
      writeGuarantee: command === 'snapshot' ? 'safe_to_retry' : 'unknown_on_transport_loss',
    })),
  };
  const connectorRegistry = connectorOverride || {
    validate: vi.fn(async () => {
      throw Object.assign(new Error('unregistered'), {
        code: 'bot_connector_unregistered',
        statusCode: 403,
      });
    }),
    authorize: vi.fn(),
    execute: vi.fn(),
  };
  const approvalService = {
    notifyPending: vi.fn(async () => {}),
    waitForDecision: vi.fn(async () => {
      throw Object.assign(new Error('approval still required'), {
        code: 'bot_approval_required',
        statusCode: 409,
      });
    }),
  };
  const evidenceService = { capture: vi.fn(async () => null) };
  const eventStream = { publish: vi.fn(async () => ({ delivered: 1 })) };
  const channels = { audienceForChannel: vi.fn(async () => [USER_ID]) };
  const authorization = {
    requireOperator: vi.fn(async () => ({ membership: { role: 'operator' } })),
    requireActiveMembership: vi.fn(async () => ({ membership: { role: 'operator' } })),
  };
  const audit = vi.fn(async () => {});
  const gateway = createBotActionGateway({
    store,
    channels,
    authorization,
    policyEngine: createBotPolicyEngine({ now: () => Date.parse(NOW) }),
    approvalService,
    browserService,
    connectorRegistry,
    evidenceService,
    eventStream,
    encryption: { getKey: async () => Buffer.from(KEY) },
    audit,
    onRunSettled,
    now: () => new Date(NOW),
    uuid: () => `f0000000-0000-4000-8000-${String(nextActionId++).padStart(12, '0')}`,
  });
  return {
    gateway,
    store,
    actions,
    browserService,
    connectorRegistry,
    approvalService,
    evidenceService,
    eventStream,
    audit,
    onRunSettled,
    getRun: () => currentRun,
    setRun: (changes) => { currentRun = { ...currentRun, ...changes }; },
  };
};

describe('Bot fail-closed action gateway', () => {
  it('persists one encrypted action and deduplicates repeated execution', async () => {
    const harness = createHarness();
    const first = await harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload(),
    });
    const second = await harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload(),
    });

    expect(first.result).toEqual({ nodes: [{ ref: 'button-1' }] });
    expect(second.result).toEqual(first.result);
    expect(harness.browserService.executeAction).toHaveBeenCalledTimes(1);
    expect(harness.actions).toHaveLength(1);
    expect(harness.actions[0]).toMatchObject({
      action_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      policy_effect: 'allow',
      state: 'succeeded',
      unknown_outcome: false,
    });
    expect(JSON.stringify(harness.actions[0].encrypted_args)).not.toContain('button-1');
    expect(JSON.stringify(harness.actions[0].execution_receipt)).not.toContain('nodes');
  });

  it('invalidates an idempotent retry when args or target change', async () => {
    const harness = createHarness();
    await harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload(),
    });

    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload({ args: { unexpected: true } }),
    })).rejects.toMatchObject({ code: 'bot_action_idempotency_conflict' });
    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload({ target: { origin: 'https://example.com' } }),
    })).rejects.toMatchObject({ code: 'bot_action_idempotency_conflict' });
    expect(harness.browserService.executeAction).toHaveBeenCalledTimes(1);
  });

  it('recovers concurrent quota initialization without bypassing or inventing approval', async () => {
    let releaseReservations;
    const reservationGate = new Promise((resolve) => {
      releaseReservations = resolve;
    });
    const durableReservationIds = new Set();
    const durableConsumptionIds = new Set();
    const reserveActionQuotas = vi.fn(async ({ actionAttemptId, bindings }) => {
      await reservationGate;
      for (const binding of bindings) {
        durableReservationIds.add(`${actionAttemptId}:${binding.reservationId}`);
      }
    });
    const consumeActionQuotas = vi.fn(async ({ actionAttemptId }) => {
      durableConsumptionIds.add(actionAttemptId);
    });
    const harness = createHarness({
      policy: {
        matcherVersion: 2,
        defaultEffect: 'deny',
        defaultRisk: 'critical',
        rules: [{
          id: 'snapshot-rate',
          effect: 'allow',
          risk: 'low',
          match: { tool: 'browser', actions: ['snapshot'] },
          quota: { scope: 'actor', limit: 1, windowSeconds: 60 },
        }],
      },
      quotaServices: {
        reserveActionQuotas,
        consumeActionQuotas,
        releaseActionQuotas: vi.fn(async () => {}),
      },
    });

    const invoke = () => harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload(),
    });
    const first = invoke();
    for (let attempt = 0; attempt < 20 && reserveActionQuotas.mock.calls.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const second = invoke();
    for (let attempt = 0; attempt < 20 && reserveActionQuotas.mock.calls.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(harness.actions).toHaveLength(1);
    expect(harness.actions[0].state).toBe('proposed');
    expect(harness.approvalService.waitForDecision).not.toHaveBeenCalled();
    expect(harness.browserService.executeAction).not.toHaveBeenCalled();
    releaseReservations();

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: 'bot_action_in_progress' });
      }
    }
    expect(reserveActionQuotas).toHaveBeenCalledTimes(2);
    expect(reserveActionQuotas.mock.calls[0][0].bindings)
      .toEqual(reserveActionQuotas.mock.calls[1][0].bindings);
    expect(durableReservationIds.size).toBe(1);
    expect(durableConsumptionIds).toEqual(new Set([ACTION_ID]));
    expect(harness.approvalService.waitForDecision).not.toHaveBeenCalled();
    expect(harness.browserService.executeAction).toHaveBeenCalledTimes(1);
    expect(harness.actions[0].state).toBe('succeeded');
  });

  it('durably pauses a browser mutation for exact approval before execution', async () => {
    const harness = createHarness({
      policy: { defaultEffect: 'prompt', defaultRisk: 'low', rules: [] },
    });
    const payload = computerPayload({
      command: 'click',
      args: { ref: 'button-1' },
      target: {
        origin: 'https://example.com',
        goal: 'Open reviewed settings',
        ref: 'button-1',
      },
    });

    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload,
    })).rejects.toMatchObject({ code: 'bot_approval_required' });
    expect(harness.actions[0]).toMatchObject({
      policy_effect: 'prompt',
      approval_class: 'requester',
      state: 'pending_approval',
    });
    expect(harness.getRun().state).toBe('waiting_approval');
    expect(harness.browserService.executeAction).not.toHaveBeenCalled();
    expect(harness.approvalService.notifyPending).toHaveBeenCalledTimes(1);
  });

  it('keeps a workspace write paused and resumes the exact call after approval', async () => {
    const connectorRegistry = {
      validate: vi.fn(async (connectorId, input) => {
        expect(connectorId).toBe('workspace');
        return {
          target: input.target,
          args: input.args,
          operationKind: 'write',
        };
      }),
      authorize: vi.fn(async () => ({ authorized: true })),
      execute: vi.fn(async () => ({
        result: { written: true, path: 'approval-check.txt', bytes: 15, sha256: 'a'.repeat(64) },
        connectorReceipt: {
          nativeExactlyOnce: false,
          writeGuarantee: 'idempotent_content_replace',
        },
      })),
    };
    const harness = createHarness({ connectorRegistry });
    harness.store.repositories.bot_revisions.get.mockResolvedValue({
      id: REVISION_ID,
      bot_id: BOT_ID,
      contract: {
        actionPolicy: { defaultEffect: 'prompt', defaultRisk: 'sensitive', rules: [] },
        browserPolicy: {},
      },
    });
    let approve;
    harness.approvalService.waitForDecision.mockImplementation(() => new Promise((resolve) => {
      approve = resolve;
    }));
    const pending = harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'workspace.write',
      payload: {
        idempotencyKey: 'call_workspace_1',
        path: 'approval-check.txt',
        content: 'BOT_APPROVAL_OK',
      },
    });

    for (let attempt = 0; attempt < 10 && harness.actions[0]?.state !== 'pending_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(harness.actions[0]?.state).toBe('pending_approval');
    expect(connectorRegistry.execute).not.toHaveBeenCalled();
    const approved = {
      ...harness.actions[0],
      state: 'approved',
      updated_at: new Date(Date.parse(harness.actions[0].updated_at) + 1_000).toISOString(),
    };
    Object.assign(harness.actions[0], approved);
    approve(structuredClone(approved));

    await expect(pending).resolves.toMatchObject({
      action: { state: 'succeeded', tool: 'connector:workspace', action: 'write' },
      result: { written: true, path: 'approval-check.txt' },
      receipt: { writeGuarantee: 'idempotent_content_replace' },
    });
    expect(connectorRegistry.execute).toHaveBeenCalledWith('workspace', expect.objectContaining({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      target: { path: 'approval-check.txt', operationKind: 'write' },
      args: { content: 'BOT_APPROVAL_OK' },
    }));
  });

  it('routes explicit artifact publication through policy and the Shared connector', async () => {
    const connectorRegistry = {
      validate: vi.fn(async (connectorId, input) => {
        expect(connectorId).toBe('shared');
        return { target: input.target, args: input.args, operationKind: 'write' };
      }),
      authorize: vi.fn(async () => ({ authorized: true })),
      execute: vi.fn(async () => ({
        result: { sharedFile: { id: 'shared-1', filename: 'result.txt', copyState: 'ready' } },
        connectorReceipt: { nativeExactlyOnce: false, writeGuarantee: 'durable_shared_mapping' },
      })),
    };
    const harness = createHarness({ connectorRegistry });
    const result = await harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'artifact.put',
      payload: {
        idempotencyKey: 'call_shared_1',
        filename: 'result.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('exact result').toString('base64'),
      },
    });

    expect(result).toMatchObject({
      action: { tool: 'connector:shared', action: 'publish', state: 'succeeded' },
      result: { sharedFile: { filename: 'result.txt', copyState: 'ready' } },
      receipt: { writeGuarantee: 'durable_shared_mapping' },
    });
    expect(connectorRegistry.execute).toHaveBeenCalledWith('shared', expect.objectContaining({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      principalId: USER_ID,
      args: { contentBase64: Buffer.from('exact result').toString('base64') },
    }));
  });

  it('marks transport loss after an approved browser mutation unknown and never replays it', async () => {
    const harness = createHarness({
      policy: { defaultEffect: 'prompt', defaultRisk: 'low', rules: [] },
    });
    const payload = computerPayload({
      command: 'click',
      args: { ref: 'button-1' },
      target: {
        origin: 'https://example.com',
        goal: 'Open reviewed settings',
        ref: 'button-1',
      },
    });
    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(), operation: 'computer.command', payload,
    })).rejects.toMatchObject({ code: 'bot_approval_required' });
    harness.actions[0].state = 'approved';
    harness.actions[0].updated_at = '2026-08-23T12:01:00.000Z';
    harness.setRun({ state: 'running' });
    harness.browserService.executeAction.mockRejectedValueOnce(new BotBrowserServiceError(
      'connection lost',
      'bot_action_needs_reconciliation',
      409,
      { transportUncertain: true },
    ));

    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(), operation: 'computer.command', payload,
    })).rejects.toMatchObject({ code: 'bot_action_needs_reconciliation' });
    expect(harness.actions[0]).toMatchObject({ state: 'unknown', unknown_outcome: true });
    expect(harness.actions[0].execution_receipt).toMatchObject({
      operationKind: 'write',
      nativeExactlyOnce: false,
      writeGuarantee: 'unknown_on_transport_loss',
    });
    expect(harness.getRun().state).toBe('needs_reconciliation');
    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(), operation: 'computer.command', payload,
    })).rejects.toMatchObject({ code: 'bot_action_needs_reconciliation' });
    expect(harness.browserService.executeAction).toHaveBeenCalledTimes(1);
  });

  it('routes uncertain connector writes through the shared reconciliation flow', async () => {
    const connectorRegistry = {
      validate: vi.fn(async (_id, input) => ({
        args: input.args,
        target: { bindingId: '10000000-0000-4000-8000-000000000001' },
        operationKind: 'write',
        credentialId: null,
      })),
      authorize: vi.fn(async () => ({ authorized: true })),
      execute: vi.fn(async () => {
        throw Object.assign(new Error('MCP socket closed after a possible write'), {
          code: 'bot_mcp_transport_failed',
          transportUncertain: true,
        });
      }),
    };
    const harness = createHarness({ connectorRegistry });
    harness.store.repositories.bot_revisions.get.mockResolvedValue({
      id: REVISION_ID,
      bot_id: BOT_ID,
      contract: {
        actionPolicy: {
          rules: [{
            id: 'generated.mcp.fixture',
            effect: 'prompt',
            risk: 'sensitive',
            match: { tool: 'connector:mcp', actions: ['change'] },
            retainEvidence: false,
            ttlSeconds: 900,
          }],
        },
        browserPolicy: {},
      },
    });
    const payload = {
      idempotencyKey: 'mcp-write-1',
      tool: 'connector:mcp',
      action: 'change',
      target: { bindingId: '10000000-0000-4000-8000-000000000001' },
      args: { id: 'record-1' },
      limits: {},
    };
    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(), operation: 'action.request', payload,
    })).rejects.toMatchObject({ code: 'bot_approval_required' });
    harness.actions[0].state = 'approved';
    harness.actions[0].updated_at = '2026-08-23T12:01:00.000Z';
    harness.setRun({ state: 'running' });

    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(), operation: 'action.request', payload,
    })).rejects.toMatchObject({ code: 'bot_action_needs_reconciliation' });
    expect(harness.actions[0]).toMatchObject({ state: 'unknown', unknown_outcome: true });
    expect(harness.getRun()).toMatchObject({
      state: 'needs_reconciliation',
      interruption_kind: 'connector_write_unknown',
    });
    expect(connectorRegistry.execute).toHaveBeenCalledTimes(1);
  });

  it('lets an Operator reconcile complete/retry-new/abandon without automatic replay', async () => {
      const harness = createHarness({
        policy: { defaultEffect: 'prompt', defaultRisk: 'low', rules: [] },
      });
    const payload = computerPayload({
      command: 'click',
      args: { ref: 'button-1' },
      target: {
        origin: 'https://example.com',
        goal: 'Open reviewed settings',
        ref: 'button-1',
      },
    });
    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(), operation: 'computer.command', payload,
    })).rejects.toMatchObject({ code: 'bot_approval_required' });
    harness.actions[0].state = 'unknown';
    harness.actions[0].unknown_outcome = true;
    harness.actions[0].updated_at = '2026-08-23T12:01:00.000Z';
    harness.setRun({ state: 'needs_reconciliation' });

    const result = await harness.gateway.reconcile({
      principal: { id: USER_ID },
      actionAttemptId: ACTION_ID,
      request: {
        actionHash: harness.actions[0].action_hash,
        revisionId: REVISION_ID,
        argsDigest: harness.actions[0].args_digest,
        decision: 'retry_new',
      },
    });

    expect(result).toMatchObject({
      action: { state: 'reconciled', reconciliationDecision: 'retry_new' },
      retryIdempotencyKey: expect.stringMatching(/^retry:/),
      replayed: false,
    });
    expect(harness.browserService.executeAction).not.toHaveBeenCalled();
    expect(harness.getRun().state).toBe('completed');
    expect(harness.onRunSettled).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: RUN_ID, state: 'completed' }),
    });
  });

  it('enforces the claimed routine tool, origin, and action limits in the core gateway', async () => {
    const harness = createHarness({ runContextSnapshot: routineSnapshot() });
    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload({ target: { origin: 'https://example.com' } }),
    })).resolves.toMatchObject({ result: { nodes: [{ ref: 'button-1' }] } });

    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload({
        idempotencyKey: 'browser-action-2',
        target: { origin: 'https://not-reviewed.example' },
      }),
    })).rejects.toMatchObject({ code: 'bot_action_denied' });
    expect(harness.actions[1]).toMatchObject({ state: 'denied' });
    expect(harness.actions[1].policy_rule_ids)
      .toContain('routine:c1000000-0000-4000-8000-000000000001:origin');

    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload({
        idempotencyKey: 'browser-action-3',
        target: { origin: 'https://example.com' },
      }),
    })).rejects.toMatchObject({ code: 'bot_action_denied' });
    expect(harness.actions[2].policy_rule_ids)
      .toContain('routine:c1000000-0000-4000-8000-000000000001:action_limit');
  });

  it('requires a fresh approval for recovered routine writes', async () => {
    const harness = createHarness({ runContextSnapshot: routineSnapshot() });
    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'computer.command',
      payload: computerPayload({
        command: 'click',
        args: { ref: 'button-1' },
        target: {
          origin: 'https://example.com',
          goal: 'Open the reviewed settings page',
          ref: 'button-1',
        },
      }),
    })).rejects.toMatchObject({ code: 'bot_approval_required' });
    expect(harness.actions[0]).toMatchObject({
      state: 'pending_approval',
      approval_class: 'requester',
      policy_effect: 'prompt',
    });
    expect(harness.actions[0].policy_rule_ids)
      .toContain('routine:c1000000-0000-4000-8000-000000000001:approval');
  });

  it('rejects an unregistered connector before any durable action write', async () => {
    const harness = createHarness();
    await expect(harness.gateway.handleGatewayOperation({
      claims: claims(),
      operation: 'action.request',
      payload: {
        idempotencyKey: 'connector-action-1',
        tool: 'connector:gmail',
        action: 'send',
        target: { account: 'support' },
        args: { subject: 'private' },
        limits: {},
      },
    })).rejects.toMatchObject({ code: 'bot_connector_unregistered' });
    expect(harness.actions).toHaveLength(0);
  });
});
