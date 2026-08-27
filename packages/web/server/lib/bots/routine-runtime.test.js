import { describe, expect, it, vi } from 'vitest';

import {
  createBotRoutineRuntime,
  guardBotRoutineAction,
  nextBotRoutineOccurrence,
  recoverBotRoutineOccurrences,
  validateBotRoutineContract,
} from './routine-runtime.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const ROUTINE_ID = 'c0000000-0000-4000-8000-000000000001';
const ROUTINE_2_ID = 'c0000000-0000-4000-8000-000000000002';
const REVISION_A = 'd0000000-0000-4000-8000-000000000001';
const REVISION_B = 'd0000000-0000-4000-8000-000000000002';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'e0000000-0000-4000-8000-000000000001';
const OCCURRENCE_ID = 'f0000000-0000-4000-8000-000000000001';
const RUN_ID = 'f1000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-23T10:00:00.000Z');

const contract = (overrides = {}) => ({
  version: 1,
  rationale: 'This text explains why the routine exists.',
  trigger: { kind: 'daily', time: '09:00' },
  timezone: 'UTC',
  goal: 'Review the approved queue.',
  inputs: { queue: 'priority' },
  allowedTools: ['browser'],
  allowedAccountIds: [],
  allowedOrigins: ['https://example.com'],
  limits: { maxActions: 5, maxExternalWrites: 0 },
  approvalClass: 'none',
  timeoutSeconds: 600,
  missedPolicy: 'run_once',
  missedRunCap: 1,
  completionCriteria: ['The approved queue has been summarized.'],
  ...overrides,
});

const routineRow = (overrides = {}) => ({
  id: ROUTINE_ID,
  bot_id: BOT_ID,
  name: 'Morning queue review',
  schedule_contract: contract(),
  timezone: 'UTC',
  missed_policy: 'run_once',
  missed_run_cap: 1,
  status: 'active',
  revision_behavior: 'current_active',
  next_occurrence_at: '2026-08-23T09:00:00.000Z',
  last_occurrence_at: null,
  created_by: USER_ID,
  managed_by: USER_ID,
  created_at: '2026-08-20T10:00:00.000Z',
  updated_at: '2026-08-20T10:00:00.000Z',
  retired_at: null,
  ...overrides,
});

const matches = (row, filters = {}) => Object.entries(filters)
  .every(([key, value]) => row[key] === value);

const createHarness = ({
  routines = [routineRow()],
  botLifecycle = 'active',
  activeRevisionId = REVISION_A,
  managerAllowed = true,
  enqueueError = null,
  runtimeOwner = 'devryan-web:100:one',
  occurrenceRows = [],
  messageRows = [],
  runRows = [],
  onClaim = null,
} = {}) => {
  let revisionClock = 0;
  let occurrenceCounter = 0;
  const rows = {
    bot_routines: routines.map((row) => structuredClone(row)),
    bot_routine_occurrences: occurrenceRows.map((row) => structuredClone(row)),
    bots: [{
      id: BOT_ID,
      lifecycle: botLifecycle,
      tenancy: 'team',
      active_revision_id: activeRevisionId,
    }],
    bot_revisions: [
      { id: REVISION_A, bot_id: BOT_ID, contract: {}, activated_at: NOW.toISOString(), retired_at: null },
      { id: REVISION_B, bot_id: BOT_ID, contract: {}, activated_at: NOW.toISOString(), retired_at: null },
    ],
    bot_messages: messageRows.map((row) => structuredClone(row)),
    bot_runs: runRows.map((row) => structuredClone(row)),
  };

  const stamp = () => {
    revisionClock += 1;
    return `2026-08-23T10:00:${String(revisionClock).padStart(2, '0')}.000Z`;
  };
  const repository = (name) => ({
    async get(filters) {
      return structuredClone(rows[name].find((row) => matches(row, filters)) || null);
    },
    async list({ filters = {}, limit = 100 } = {}) {
      const items = rows[name].filter((row) => matches(row, filters)).slice(0, limit);
      return { items: structuredClone(items), nextCursor: null };
    },
    async insert(input) {
      const row = {
        ...structuredClone(input),
        created_at: input.created_at || stamp(),
        updated_at: input.updated_at || stamp(),
      };
      rows[name].push(row);
      return structuredClone(row);
    },
    async updateIfRevision(filters, changes, expectedUpdatedAt) {
      const index = rows[name].findIndex((row) => matches(row, filters));
      if (index < 0) throw Object.assign(new Error('not found'), { code: 'bot_not_found' });
      if (rows[name][index].updated_at !== expectedUpdatedAt) {
        throw Object.assign(new Error('conflict'), { code: 'bot_revision_conflict' });
      }
      rows[name][index] = {
        ...rows[name][index],
        ...structuredClone(changes),
        updated_at: stamp(),
      };
      return structuredClone(rows[name][index]);
    },
  });
  const store = {
    repositories: Object.fromEntries(Object.keys(rows).map((name) => [name, repository(name)])),
    async claimRoutineOccurrence({ routineId, scheduledFor, occurrenceId }) {
      const existing = rows.bot_routine_occurrences.find((row) => (
        row.routine_id === routineId && row.scheduled_for === scheduledFor
      ));
      if (existing) return structuredClone(existing);
      occurrenceCounter += 1;
      const row = {
        id: occurrenceId,
        routine_id: routineId,
        scheduled_for: scheduledFor,
        run_id: null,
        recovery_disposition: 'scheduled',
        state: 'claimed',
        claimed_by: 'routine-scheduler',
        claimed_at: NOW.toISOString(),
        created_at: `2026-08-23T10:00:${String(occurrenceCounter).padStart(2, '0')}.000Z`,
        updated_at: `2026-08-23T10:00:${String(occurrenceCounter).padStart(2, '0')}.000Z`,
      };
      rows.bot_routine_occurrences.push(row);
      await onClaim?.({ rows, row });
      return structuredClone(row);
    },
  };
  const authorization = {
    requireManager: vi.fn(async () => {
      if (!managerAllowed) throw Object.assign(new Error('membership revoked'), {
        code: 'bot_membership_required', statusCode: 403,
      });
      return { membership: { role: 'manager' } };
    }),
  };
  const channels = {
    getOrCreateOwnerChannel: vi.fn(async () => ({
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: USER_ID,
    })),
  };
  const enqueueRoutineMessage = vi.fn(async (input) => {
    if (enqueueError) throw enqueueError;
    const run = {
      id: RUN_ID.replace(/1$/, String(rows.bot_runs.length + 1)),
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      revision_id: input.admission.revisionId,
      state: 'queued',
      context_snapshot: { routine: structuredClone(input.admission.routine) },
      created_at: stamp(),
      updated_at: stamp(),
    };
    rows.bot_runs.push(run);
    rows.bot_messages.push({
      id: input.message.messageId,
      run_id: run.id,
      channel_id: CHANNEL_ID,
      role: 'user',
      actor_user_id: USER_ID,
    });
    return { run: structuredClone(run), message: { id: input.message.messageId } };
  });
  const timers = [];
  const runtime = createBotRoutineRuntime({
    store,
    authorization,
    channels,
    drafter: { draft: vi.fn(async () => ({ contract: contract(), requiresManagerReview: true })) },
    enqueueRoutineMessage,
    audit: vi.fn(async () => {}),
    uuid: () => occurrenceCounter === 0
      ? OCCURRENCE_ID
      : `f0000000-0000-4000-8000-${String(occurrenceCounter + 1).padStart(12, '0')}`,
    now: () => new Date(NOW),
    runtimeOwner,
    isRuntimeOwnerAlive: vi.fn(async () => false),
    setTimer: vi.fn((callback, delay) => {
      const timer = { callback, delay, unref: vi.fn() };
      timers.push(timer);
      return timer;
    }),
    clearTimer: vi.fn(),
    retryMs: 1_000,
    claimStaleMs: 1_000,
    logger: { warn: vi.fn() },
  });
  return { runtime, rows, store, authorization, channels, enqueueRoutineMessage, timers };
};

describe('Production Bot routine contract and time calculation', () => {
  it('keeps natural language non-executable and rejects unknown structured authority', () => {
    const normalized = validateBotRoutineContract(contract());
    expect(normalized).toMatchObject({
      rationale: 'This text explains why the routine exists.',
      allowedTools: ['browser'],
      limits: { maxActions: 5, maxExternalWrites: 0 },
    });
    expect(() => validateBotRoutineContract({ ...contract(), unrestricted: true }))
      .toThrow('contains an unsupported field');
    expect(() => validateBotRoutineContract(contract({
      limits: { maxActions: 2, maxExternalWrites: 1 },
      approvalClass: 'none',
    }))).toThrow('Write-capable routines require an approval class');
  });

  it('uses IANA timezone/DST semantics for spring-forward and fall-back days', () => {
    const spring = contract({
      trigger: { kind: 'daily', time: '02:30' },
      timezone: 'America/New_York',
    });
    expect(new Date(nextBotRoutineOccurrence(
      spring,
      Date.parse('2026-03-07T08:00:00.000Z'),
    )).toISOString()).toBe('2026-03-08T07:30:00.000Z');

    const fall = contract({
      trigger: { kind: 'daily', time: '01:30' },
      timezone: 'America/New_York',
    });
    expect(new Date(nextBotRoutineOccurrence(
      fall,
      Date.parse('2026-11-01T00:00:00.000Z'),
    )).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('applies all missed policies, caps replay at three, and flags recovered writes', () => {
    const firstDue = Date.parse('2026-08-20T09:00:00.000Z');
    const now = NOW.getTime();
    expect(recoverBotRoutineOccurrences(contract({ missedPolicy: 'skip' }), firstDue, now))
      .toMatchObject({ disposition: 'skip', occurrences: [] });
    expect(recoverBotRoutineOccurrences(contract({ missedPolicy: 'run_once' }), firstDue, now))
      .toMatchObject({ disposition: 'run_once', occurrences: [Date.parse('2026-08-23T09:00:00.000Z')] });
    expect(recoverBotRoutineOccurrences(contract({
      missedPolicy: 'replay_capped', missedRunCap: 3,
    }), firstDue, now).occurrences).toEqual([
      Date.parse('2026-08-21T09:00:00.000Z'),
      Date.parse('2026-08-22T09:00:00.000Z'),
      Date.parse('2026-08-23T09:00:00.000Z'),
    ]);
    expect(recoverBotRoutineOccurrences(contract({
      limits: { maxActions: 2, maxExternalWrites: 1 },
      approvalClass: 'requester',
      missedPolicy: 'run_once',
    }), firstDue, now).freshApprovalRequired).toBe(true);
  });
});

describe('Production Bot routine scheduler', () => {
  it('claims an occurrence before admission and pins the active revision at claim time', async () => {
    const harness = createHarness({
      onClaim: ({ rows }) => { rows.bots[0].active_revision_id = REVISION_B; },
    });

    await harness.runtime.start();

    expect(harness.enqueueRoutineMessage).toHaveBeenCalledTimes(1);
    expect(harness.enqueueRoutineMessage).toHaveBeenCalledWith(expect.objectContaining({
      admission: expect.objectContaining({
        revisionId: REVISION_B,
        routine: expect.objectContaining({ occurrenceId: OCCURRENCE_ID, recovered: true }),
      }),
    }));
    expect(harness.rows.bot_routine_occurrences[0]).toMatchObject({
      id: OCCURRENCE_ID,
      state: 'dispatched',
      run_id: RUN_ID,
    });
    expect(harness.rows.bot_runs[0].revision_id).toBe(REVISION_B);
    expect(harness.rows.bot_routines[0].next_occurrence_at).toBe('2026-08-24T09:00:00.000Z');
  });

  it('allows only one of two app processes to dispatch the same atomic claim', async () => {
    let release;
    const admitted = new Promise((resolve) => { release = resolve; });
    const harness = createHarness();
    harness.enqueueRoutineMessage.mockImplementationOnce(async (input) => {
      await admitted;
      const run = {
        id: RUN_ID, bot_id: BOT_ID, channel_id: CHANNEL_ID,
        revision_id: input.admission.revisionId, state: 'queued',
        created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      };
      harness.rows.bot_runs.push(run);
      harness.rows.bot_messages.push({
        id: input.message.messageId, run_id: run.id, channel_id: CHANNEL_ID, role: 'user',
      });
      return { run };
    });
    const contender = createBotRoutineRuntime({
      store: harness.store,
      authorization: harness.authorization,
      channels: harness.channels,
      drafter: { draft: vi.fn() },
      enqueueRoutineMessage: harness.enqueueRoutineMessage,
      uuid: () => 'f0000000-0000-4000-8000-000000000099',
      now: () => new Date(NOW),
      runtimeOwner: 'devryan-web:200:two',
      isRuntimeOwnerAlive: async () => true,
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
      retryMs: 1_000,
      claimStaleMs: 1_000,
      logger: { warn() {} },
    });

    const first = harness.runtime.start();
    await vi.waitFor(() => expect(harness.rows.bot_routine_occurrences).toHaveLength(1));
    await contender.start();
    release();
    await first;

    expect(harness.enqueueRoutineMessage).toHaveBeenCalledTimes(1);
    expect(harness.rows.bot_routine_occurrences).toHaveLength(1);
    await Promise.all([harness.runtime.shutdown(), contender.shutdown()]);
  });

  it('resumes a durable claim after restart without replaying an admitted message', async () => {
    const harness = createHarness({
      occurrenceRows: [{
        id: OCCURRENCE_ID,
        routine_id: ROUTINE_ID,
        scheduled_for: '2026-08-23T09:00:00.000Z',
        run_id: null,
        recovery_disposition: 'run_once',
        state: 'claimed',
        claimed_by: 'devryan-web:999:dead',
        claimed_at: '2026-08-23T09:00:00.000Z',
        created_at: '2026-08-23T09:00:00.000Z',
        updated_at: '2026-08-23T09:00:00.000Z',
      }],
      messageRows: [{ id: OCCURRENCE_ID, run_id: RUN_ID, channel_id: CHANNEL_ID, role: 'user' }],
      runRows: [{
        id: RUN_ID, bot_id: BOT_ID, channel_id: CHANNEL_ID,
        revision_id: REVISION_A, state: 'needs_reconciliation',
        created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      }],
    });

    await harness.runtime.start();

    expect(harness.enqueueRoutineMessage).not.toHaveBeenCalled();
    expect(harness.rows.bot_routine_occurrences[0]).toMatchObject({
      state: 'dispatched', run_id: RUN_ID,
    });
    await harness.runtime.onRunSettled({ run: { id: RUN_ID, state: 'needs_reconciliation' } });
    expect(harness.rows.bot_routine_occurrences[0].state).toBe('dispatched');
  });

  it('adopts the RPC placeholder claim after a concurrent insert race', async () => {
    const harness = createHarness({
      occurrenceRows: [{
        id: OCCURRENCE_ID,
        routine_id: ROUTINE_ID,
        scheduled_for: '2026-08-23T09:00:00.000Z',
        run_id: null,
        recovery_disposition: 'scheduled',
        state: 'claimed',
        claimed_by: 'routine-scheduler',
        claimed_at: NOW.toISOString(),
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      }],
    });
    await harness.runtime.start();
    expect(harness.enqueueRoutineMessage).toHaveBeenCalledTimes(1);
    expect(harness.rows.bot_routine_occurrences[0]).toMatchObject({
      claimed_by: 'devryan-web:100:one',
      state: 'dispatched',
    });
  });

  it.each([
    ['paused Bot', { botLifecycle: 'paused' }],
    ['revoked Manager membership', { managerAllowed: false }],
    ['offline runtime', {
      enqueueError: Object.assign(new Error('Docker unavailable'), {
        code: 'bot_runtime_docker_unavailable', statusCode: 503,
      }),
    }],
  ])('preserves due state when dispatch is blocked by %s', async (_label, options) => {
    const harness = createHarness(options);
    await harness.runtime.start();
    expect(harness.rows.bot_routines[0].next_occurrence_at)
      .toBe('2026-08-23T09:00:00.000Z');
    expect(harness.rows.bot_routine_occurrences[0]?.state).not.toBe('dispatched');
  });

  it('does not claim paused or retired routines and preserves their due time', async () => {
    const paused = routineRow({ status: 'paused' });
    const retired = routineRow({
      id: ROUTINE_2_ID,
      status: 'retired',
      retired_at: '2026-08-23T08:00:00.000Z',
    });
    const harness = createHarness({ routines: [paused, retired] });
    await harness.runtime.start();
    expect(harness.rows.bot_routine_occurrences).toEqual([]);
    expect(harness.rows.bot_routines.map((row) => row.next_occurrence_at))
      .toEqual(['2026-08-23T09:00:00.000Z', '2026-08-23T09:00:00.000Z']);
  });

  it('resumes a paused routine from its preserved due occurrence', async () => {
    const harness = createHarness({ routines: [routineRow({ status: 'paused' })] });
    const resumed = await harness.runtime.transition(
      { id: USER_ID },
      BOT_ID,
      ROUTINE_ID,
      {
        target: 'active',
        reviewed: true,
        expectedUpdatedAt: harness.rows.bot_routines[0].updated_at,
      },
    );
    expect(resumed.routine.nextOccurrenceAt).toBe('2026-08-23T09:00:00.000Z');
    await harness.runtime.start();
    expect(harness.enqueueRoutineMessage).toHaveBeenCalledTimes(1);
  });

  it('dispatches globally due routines in due-time and stable ID order', async () => {
    const harness = createHarness({
      routines: [
        routineRow({ id: ROUTINE_2_ID, next_occurrence_at: '2026-08-23T09:00:00.000Z' }),
        routineRow({ id: ROUTINE_ID, next_occurrence_at: '2026-08-23T08:00:00.000Z' }),
      ],
    });
    await harness.runtime.start();
    expect(harness.enqueueRoutineMessage.mock.calls.map(([input]) => input.admission.routine.routineId))
      .toEqual([ROUTINE_ID, ROUTINE_2_ID]);
  });

  it('requires explicit Manager review for activation and checkpoints without background work', async () => {
    const harness = createHarness({ routines: [routineRow({ status: 'draft', next_occurrence_at: null })] });
    await expect(harness.runtime.transition(
      { id: USER_ID },
      BOT_ID,
      ROUTINE_ID,
      { target: 'active', expectedUpdatedAt: harness.rows.bot_routines[0].updated_at },
    )).rejects.toMatchObject({ code: 'bot_routine_review_required' });
    const result = await harness.runtime.transition(
      { id: USER_ID },
      BOT_ID,
      ROUTINE_ID,
      {
        target: 'active',
        reviewed: true,
        expectedUpdatedAt: harness.rows.bot_routines[0].updated_at,
      },
    );
    expect(result.routine.status).toBe('active');
    expect(await harness.runtime.checkpoint()).toEqual({ status: 'complete' });
    expect((await harness.runtime.getStatus()).schedulerStatus).toBe('idle');
  });
});

describe('Production Bot routine action guard', () => {
  const snapshot = (contractOverrides = {}, snapshotOverrides = {}) => ({
    version: 1,
    routineId: ROUTINE_ID,
    occurrenceId: OCCURRENCE_ID,
    scheduledFor: '2026-08-23T09:00:00.000Z',
    recovered: true,
    freshApprovalRequired: true,
    contract: contract({
      limits: { maxActions: 2, maxExternalWrites: 1 },
      approvalClass: 'requester',
      ...contractOverrides,
    }),
    ...snapshotOverrides,
  });

  it('denies unreviewed tools/origins and action-limit overruns', () => {
    const base = { effect: 'allow', operationKind: 'read', ruleIds: [] };
    expect(guardBotRoutineAction({
      snapshot: snapshot(), request: { tool: 'connector:mail', action: 'list', target: {} }, classification: base,
    }).effect).toBe('deny');
    expect(guardBotRoutineAction({
      snapshot: snapshot(),
      request: { tool: 'browser', action: 'navigate', target: { origin: 'https://elsewhere.example' } },
      classification: base,
    }).effect).toBe('deny');
    expect(guardBotRoutineAction({
      snapshot: snapshot(),
      request: { tool: 'browser', action: 'snapshot', target: { origin: 'https://example.com' } },
      classification: base,
      priorActions: [{ tool: 'browser', action: 'snapshot', target: {} }, { tool: 'browser', action: 'snapshot', target: {} }],
    }).ruleIds).toContain(`routine:${ROUTINE_ID}:action_limit`);
  });

  it('requires fresh approval for recovered writes without softening a base denial', () => {
    const request = {
      tool: 'browser', action: 'click', target: { origin: 'https://example.com', operationKind: 'write' },
    };
    const prompted = guardBotRoutineAction({
      snapshot: snapshot(),
      request,
      classification: {
        effect: 'allow', operationKind: 'write', approvalClass: 'none', risk: 'low',
        requireDistinctApprover: false, ruleIds: [],
      },
    });
    expect(prompted).toMatchObject({ effect: 'prompt', approvalClass: 'requester' });

    const denied = guardBotRoutineAction({
      snapshot: snapshot(),
      request,
      classification: {
        effect: 'deny', operationKind: 'write', approvalClass: 'none', risk: 'critical',
        requireDistinctApprover: false, ruleIds: ['revision:deny'],
      },
    });
    expect(denied).toMatchObject({ effect: 'deny', ruleIds: ['revision:deny'] });
  });
});
