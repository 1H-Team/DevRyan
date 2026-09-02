import { describe, expect, test } from 'bun:test';

import type {
  BotActionAttempt,
  BotComputerStatus,
  BotComputerViewSession,
  BotRun,
  BotsApi,
} from '@/lib/botsApi';
import { createBotOperationsStore } from './useBotOperationsStore';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'f0000000-0000-4000-8000-000000000001';
const CHANNEL_A = 'c0000000-0000-4000-8000-000000000001';
const CHANNEL_B = 'c0000000-0000-4000-8000-000000000002';
const RUN_A = 'e0000000-0000-4000-8000-000000000001';
const RUN_B = 'e0000000-0000-4000-8000-000000000002';
const ACTION_ID = '90000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-23T10:00:00.000Z';

const run = (
  id: string,
  channelId: string,
  overrides: Partial<BotRun> = {},
): BotRun => ({
  id,
  botId: BOT_ID,
  channelId,
  revisionId: REVISION_ID,
  modelSnapshot: null,
  computerScopeKey: `bot:${BOT_ID}`,
  queueSequence: id === RUN_A ? 1 : 2,
  state: 'running',
  retryable: false,
  interruptionKind: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  finishedAt: null,
  ...overrides,
});

const action = (overrides: Partial<BotActionAttempt> = {}): BotActionAttempt => ({
  id: ACTION_ID,
  runId: RUN_A,
  botId: BOT_ID,
  revisionId: REVISION_ID,
  credentialId: null,
  computerScopeKey: `bot:${BOT_ID}`,
  actionHash: `sha256:${'1'.repeat(64)}`,
  argsDigest: '2'.repeat(64),
  tool: 'browser',
  action: 'submit',
  target: { origin: 'https://example.com' },
  risk: 'sensitive',
  approvalClass: 'operator',
  policyEffect: 'prompt',
  policyRuleIds: ['submit-review'],
  decisionExpiresAt: '2026-08-23T10:05:00.000Z',
  requiresDistinctApprover: true,
  retainEvidence: false,
  state: 'pending_approval',
  unknownOutcome: false,
  reconciliationDecision: null,
  initiatedBy: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const computer = (): BotComputerStatus => ({
  botId: BOT_ID,
  browser: {
    running: true,
    healthy: true,
    lifecycleState: 'running',
    generation: 1,
    mode: 'headed_virtual',
    engineVersion: 'Chromium/151.0',
    displayReady: true,
    webCapabilities: {
      managedPolicy: 'enforced',
      javascript: 'enabled',
      firstPartyCookies: 'enabled',
      thirdPartyCookies: 'enabled',
    },
    lastNavigationDiagnostic: null,
  },
  control: null,
  screencast: { subscribers: 0, lastFrameAt: null, retainedFrames: 0 },
  framesRecorded: false,
  arbitraryWebsiteExactlyOnce: false,
});

const computerView = (): BotComputerViewSession => ({
  id: 'view_opaque',
  botId: BOT_ID,
  channelId: CHANNEL_A,
  streamUrl: `/api/bots/${BOT_ID}/computer/view/view_opaque/stream`,
  startedAt: NOW,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

describe('Production Bot operations store', () => {
  test('an expired-lease status poll cannot erase a newer control lease', async () => {
    let resolveStatus!: (status: BotComputerStatus) => void;
    const response = new Promise<BotComputerStatus>((resolve) => { resolveStatus = resolve; });
    const api = { getComputerStatus: () => response } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    store.getState().resetPrincipal(USER_ID);
    const oldControl = { leaseId: 'expired', actorId: USER_ID, actorType: 'user', takenAt: 1, expiresAt: 2 };
    store.getState().upsertComputer({ ...computer(), control: oldControl });
    const pending = store.getState().refreshComputer(BOT_ID, oldControl.leaseId);
    const nextControl = { ...oldControl, leaseId: 'current', expiresAt: Date.now() + 60_000 };
    store.getState().updateComputerControl(BOT_ID, nextControl);
    resolveStatus({ ...computer(), control: null });
    await pending;
    expect(store.getState().computersByBotId[BOT_ID]?.control).toBe(nextControl);
  });

  test('a stopped pending viewer cannot return after a newer run starts', async () => {
    const first = deferred<Awaited<ReturnType<BotsApi['startComputerView']>>>();
    const second = deferred<Awaited<ReturnType<BotsApi['startComputerView']>>>();
    const stopped: string[] = [];
    let starts = 0;
    const api = { startComputerView: () => ++starts === 1 ? first.promise : second.promise,
      stopComputerView: async (_id: string, viewId: string) => { stopped.push(viewId); return { stopped: true }; } } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    const old = store.getState().startComputerView(BOT_ID, CHANNEL_A, RUN_A);
    await store.getState().stopComputerView(BOT_ID);
    const current = store.getState().startComputerView(BOT_ID, CHANNEL_B, RUN_B);
    first.resolve({ view: { ...computerView(), runId: RUN_A } });
    await old;
    expect(store.getState().computerViewsByBotId[BOT_ID]).toBeUndefined();
    expect(store.getState().computerViewPendingByBotId[BOT_ID]).toBe(true);
    second.resolve({ view: { ...computerView(), id: 'view_new', channelId: CHANNEL_B, runId: RUN_B } });
    await current;
    expect(store.getState().computerViewsByBotId[BOT_ID].id).toBe('view_new');
    expect(stopped).toEqual(['view_opaque']);
  });
  test('keeps recent governed actions in Activity while deriving approvals from state', () => {
    const store = createBotOperationsStore();
    const completed = action({
      state: 'completed',
      action: 'navigate',
      policyEffect: 'allow',
      approvalClass: 'requester',
      requiresDistinctApprover: false,
      finishedAt: NOW,
    });
    const pending = action({ id: '90000000-0000-4000-8000-000000000002' });
    store.getState().replaceSnapshot({
      runs: [run(RUN_A, CHANNEL_A)],
      recentActions: [completed, pending],
      pendingApprovals: [pending],
      computers: [],
    });

    expect(Object.values(store.getState().actionsById)).toHaveLength(2);
    expect(store.getState().actionsById[ACTION_ID]?.state).toBe('completed');
    expect(store.getState().pendingApprovalIds).toEqual([pending.id]);
  });

  test('preserves no-op records and unrelated channel run selectors', () => {
    const store = createBotOperationsStore();
    store.getState().replaceSnapshot({
      runs: [run(RUN_A, CHANNEL_A), run(RUN_B, CHANNEL_B)],
      pendingApprovals: [],
      computers: [],
    });
    const firstRuns = store.getState().runsById;
    const channelAIds = store.getState().runIdsByChannelId[CHANNEL_A];
    const runA = store.getState().runsById[RUN_A];

    store.getState().replaceSnapshot({
      runs: [run(RUN_A, CHANNEL_A), run(RUN_B, CHANNEL_B)],
      pendingApprovals: [],
      computers: [],
    });
    expect(store.getState().runsById).toBe(firstRuns);

    store.getState().upsertRun(run(RUN_B, CHANNEL_B, { state: 'completed', finishedAt: NOW }));
    expect(store.getState().runIdsByChannelId[CHANNEL_A]).toBe(channelAIds);
    expect(store.getState().runsById[RUN_A]).toBe(runA);
  });

  test('does not let an older cancel response regress a terminal SSE run', async () => {
    const response = deferred<Awaited<ReturnType<BotsApi['cancelRun']>>>();
    const staleWaiting = run(RUN_A, CHANNEL_A, {
      state: 'waiting_approval',
      updatedAt: '2026-08-23T10:01:00.000Z',
    });
    const cancelled = run(RUN_A, CHANNEL_A, {
      state: 'cancelled',
      updatedAt: '2026-08-23T10:02:00.000Z',
      finishedAt: '2026-08-23T10:02:00.000Z',
    });
    const api = { cancelRun: () => response.promise } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    store.getState().upsertRun(staleWaiting);

    const cancelling = store.getState().cancelRun(RUN_A);
    store.getState().upsertRun(cancelled);
    response.resolve({ run: staleWaiting });
    await cancelling;

    expect(store.getState().runsById[RUN_A]).toBe(cancelled);
  });

  test('accepts a strictly newer safe-retry lifecycle after a terminal startup failure', () => {
    const store = createBotOperationsStore();
    const failed = run(RUN_A, CHANNEL_A, {
      state: 'failed',
      retryable: true,
      interruptionKind: 'bot_model_unavailable',
      updatedAt: '2026-08-23T10:01:00.000Z',
      finishedAt: '2026-08-23T10:01:00.000Z',
    });
    const queued = run(RUN_A, CHANNEL_A, {
      state: 'queued',
      updatedAt: '2026-08-23T10:02:00.000Z',
      startedAt: null,
      finishedAt: null,
    });
    const completed = run(RUN_A, CHANNEL_A, {
      state: 'completed',
      updatedAt: '2026-08-23T10:03:00.000Z',
      finishedAt: '2026-08-23T10:03:00.000Z',
    });

    store.getState().upsertRun(failed);
    store.getState().upsertRun(queued);
    expect(store.getState().runsById[RUN_A]).toBe(queued);
    store.getState().upsertRun(completed);
    expect(store.getState().runsById[RUN_A]).toBe(completed);
  });

  test('moves an approved action out of pending state through the API projection', async () => {
    const approved = action({ state: 'approved', updatedAt: '2026-08-23T10:01:00.000Z' });
    const response = deferred<Awaited<ReturnType<BotsApi['decideAction']>>>();
    const api = {
      decideAction: () => response.promise,
    } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    store.getState().upsertAction(action());

    const decision = store.getState().decideAction(ACTION_ID, {
      actionHash: approved.actionHash,
      revisionId: REVISION_ID,
      argsDigest: approved.argsDigest,
      decision: 'approved',
    });
    expect(store.getState().decisionPendingByActionId[ACTION_ID]).toBe(true);
    response.resolve({
      action: approved,
      approval: {
        id: '91000000-0000-4000-8000-000000000001',
        actionAttemptId: ACTION_ID,
        actionHash: approved.actionHash,
        revisionId: REVISION_ID,
        argsDigest: approved.argsDigest,
        approverUserId: 'a0000000-0000-4000-8000-000000000002',
        decision: 'approved',
        expiresAt: approved.decisionExpiresAt,
        createdAt: NOW,
      },
    });
    const result = await decision;

    expect(result.state).toBe('approved');
    expect(store.getState().pendingApprovalIds).toEqual([]);
    expect(store.getState().decisionPendingByActionId[ACTION_ID]).toBe(undefined);
  });

  test('stores only low-frequency computer metadata and never screencast frames', () => {
    const store = createBotOperationsStore();
    store.getState().upsertComputer(computer());

    expect(store.getState().computersByBotId[BOT_ID]).toEqual(computer());
    expect(Object.hasOwn(store.getState(), 'frames')).toBe(false);
    expect(store.getState().computersByBotId[BOT_ID].screencast.retainedFrames).toBe(0);
    expect(store.getState().computersByBotId[BOT_ID].framesRecorded).toBe(false);
  });

  test('updates diagnostic polling state only when its browser revision or health changes', async () => {
    let response = computer();
    const api = { getComputerStatus: async () => response } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    store.getState().upsertComputer(computer());
    const initialMap = store.getState().computersByBotId;

    response = {
      ...computer(),
      screencast: { subscribers: 1, lastFrameAt: 1234, retainedFrames: 0 },
    };
    await store.getState().refreshComputerDiagnostic(BOT_ID);
    expect(store.getState().computersByBotId).toBe(initialMap);

    response = {
      ...response,
      browser: {
        ...response.browser,
        lastNavigationDiagnostic: {
          revision: 2,
          observedAt: 1234,
          origin: 'https://airtable.com',
          statusCode: 200,
          redirectCount: 1,
          repetitionCount: 3,
          kind: 'site_rejection',
          reason: 'navigation_loop',
          blockedHost: null,
        },
      },
    };
    await store.getState().refreshComputerDiagnostic(BOT_ID);
    expect(store.getState().computersByBotId).not.toBe(initialMap);
    expect(store.getState().computersByBotId[BOT_ID].browser.lastNavigationDiagnostic?.revision).toBe(2);

    const diagnosticMap = store.getState().computersByBotId;
    response = {
      ...response,
      browser: { ...response.browser, lastNavigationDiagnostic: null },
    };
    await store.getState().refreshComputerDiagnostic(BOT_ID);
    expect(store.getState().computersByBotId).not.toBe(diagnosticMap);
    expect(store.getState().computersByBotId[BOT_ID].browser.lastNavigationDiagnostic).toBeNull();
  });

  test('coalesces automatic computer viewer startup and stops it by Bot', async () => {
    const start = deferred<Awaited<ReturnType<BotsApi['startComputerView']>>>();
    const calls: string[] = [];
    const api = {
      startComputerView: () => { calls.push('start'); return start.promise; },
      stopComputerView: async (botId: string, viewId: string) => {
        calls.push(`stop:${botId}:${viewId}`);
        return { stopped: true };
      },
    } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });

    expect(calls).toEqual([]);
    const starting = store.getState().startComputerView(BOT_ID, CHANNEL_A);
    const duplicateStart = store.getState().startComputerView(BOT_ID, CHANNEL_A);
    expect(store.getState().computerViewPendingByBotId[BOT_ID]).toBe(true);
    expect(calls).toEqual(['start']);
    start.resolve({ view: computerView() });
    expect(await starting).toEqual(computerView());
    expect(await duplicateStart).toEqual(computerView());
    expect(store.getState().computerViewsByBotId[BOT_ID]).toEqual(computerView());
    expect(store.getState().computerViewPendingByBotId[BOT_ID]).toBe(undefined);

    expect(await store.getState().stopComputerView(BOT_ID)).toBe(true);
    expect(store.getState().computerViewsByBotId[BOT_ID]).toBe(undefined);
    expect(calls).toEqual(['start', `stop:${BOT_ID}:view_opaque`]);
  });

  test('releases an attached viewer when the authenticated principal resets', async () => {
    const stopped: string[] = [];
    const api = {
      startComputerView: async () => ({ view: computerView() }),
      stopComputerView: async (_botId: string, viewId: string) => {
        stopped.push(viewId);
        return { stopped: true };
      },
    } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    store.getState().resetPrincipal(USER_ID);
    await store.getState().startComputerView(BOT_ID, CHANNEL_A);

    store.getState().resetPrincipal('a0000000-0000-4000-8000-000000000002');
    await Promise.resolve();

    expect(stopped).toEqual(['view_opaque']);
    expect(store.getState().computerViewsByBotId).toEqual({});
  });

  test('does not repopulate approvals from an old principal request', async () => {
    const response = deferred<Awaited<ReturnType<BotsApi['decideAction']>>>();
    const api = { decideAction: () => response.promise } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    store.getState().resetPrincipal(USER_ID);
    store.getState().upsertAction(action());
    const decision = store.getState().decideAction(ACTION_ID, {
      actionHash: action().actionHash,
      revisionId: REVISION_ID,
      argsDigest: action().argsDigest,
      decision: 'approved',
    });

    store.getState().resetPrincipal('a0000000-0000-4000-8000-000000000002');
    response.resolve({
      action: action({ state: 'approved' }),
      approval: {
        id: '91000000-0000-4000-8000-000000000002',
        actionAttemptId: ACTION_ID,
        actionHash: action().actionHash,
        revisionId: REVISION_ID,
        argsDigest: action().argsDigest,
        approverUserId: USER_ID,
        decision: 'approved',
        expiresAt: action().decisionExpiresAt,
        createdAt: NOW,
      },
    });
    await decision;

    expect(store.getState().actionsById).toEqual({});
    expect(store.getState().decisionPendingByActionId).toEqual({});
  });
});
