import { describe, expect, it, vi } from 'vitest';

import {
  classifyOpenCodeRunError,
  createOpenCodeReasoningAdapter,
} from './opencode-reasoning-adapter.js';
import { projectBotAssistantResponse } from './opencode-provider.js';
import { createBotRunDispatcher } from './run-dispatcher.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const MESSAGE_ID = 'e0000000-0000-4000-8000-000000000001';
const LIBRARY_VERSION_1 = 'e0000000-0000-4000-8000-000000000010';
const LIBRARY_VERSION_2 = 'e0000000-0000-4000-8000-000000000011';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const waitFor = async (assertion, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  } while (Date.now() < deadline);
  throw lastError;
};

const baseHarness = ({
  tenancy = 'team',
  runExecutor = vi.fn(async () => {}),
  resolveLibrarySnapshot = vi.fn(async ({ configuredVersionIds }) => configuredVersionIds),
  onRunSettled = vi.fn(async () => {}),
  reconcileExpiredApprovals = vi.fn(async () => ({ actions: [], runs: [], scopeKeys: [] })),
  sharedFileService = null,
  autoDispatch = false,
} = {}) => {
  const claimed = [];
  const store = {
    repositories: {
      bot_revisions: { get: vi.fn(async () => ({
        id: REVISION_ID,
        contract: { models: {}, libraryVersionIds: [LIBRARY_VERSION_1] },
      })) },
    },
    claimRun: vi.fn(async ({ computerScopeKey }) => {
      const index = claimed.findIndex((run) => run.computer_scope_key === computerScopeKey);
      return index < 0 ? null : {
        ...claimed.splice(index, 1)[0],
        state: 'starting',
        started_at: '2026-08-23T10:00:00.000Z',
      };
    }),
    settleRunTerminal: vi.fn(async (input) => ({
      id: input.runId,
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      state: input.state,
      context_snapshot: input.contextSnapshot,
      interruption_kind: input.interruptionKind,
      finished_at: input.finishedAt,
    })),
  };
  const channels = {
    preflightMessage: vi.fn(async () => ({
      bot: { id: BOT_ID, tenancy, lifecycle: 'active', active_revision_id: REVISION_ID },
      channel: { id: CHANNEL_ID, bot_id: BOT_ID, owner_user_id: USER_ID, lifecycle: 'active' },
    })),
    enqueueUserMessage: vi.fn(async (input) => {
      const run = {
        id: input.runId,
        bot_id: BOT_ID,
        channel_id: CHANNEL_ID,
        revision_id: REVISION_ID,
        computer_scope_key: input.computerScopeKey,
        state: 'queued',
      };
      claimed.push(run);
      return {
        created: true,
        run,
        message: {
          id: input.messageId,
          channelId: CHANNEL_ID,
          runId: input.runId,
          actorUserId: USER_ID,
          role: 'user',
          sequence: claimed.length,
          body: { text: input.text, attachmentIds: input.attachmentIds },
          attachmentCount: input.attachmentIds.length,
          createdAt: '2026-08-23T10:00:00.000Z',
          finalizedAt: '2026-08-23T10:00:00.000Z',
        },
      };
    }),
    publicRun: (run) => ({ ...run }),
  };
  const runtimePreflight = vi.fn(async () => ({
    modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
  }));
  const eventStream = { publish: vi.fn(async () => {}) };
  const dispatcher = createBotRunDispatcher({
    store,
    channels,
    contextAssembler: { assemble: vi.fn() },
    eventStream,
    runtimePreflight,
    resolveLibrarySnapshot,
    onRunSettled,
    reconcileExpiredApprovals,
    sharedFileService,
    executeClaimedRun: runExecutor,
    uuid: (() => {
      let index = 0;
      return () => `f0000000-0000-4000-8000-${String(++index).padStart(12, '0')}`;
    })(),
    autoDispatch,
  });
  return {
    dispatcher, store, channels, eventStream, runtimePreflight, resolveLibrarySnapshot,
    runExecutor, onRunSettled, reconcileExpiredApprovals,
  };
};

const enqueue = (dispatcher, overrides = {}) => dispatcher.enqueueMessage({
  principal: { id: USER_ID },
  channelId: CHANNEL_ID,
  message: {
    messageId: overrides.messageId || MESSAGE_ID,
    idempotencyKey: overrides.idempotencyKey || 'client-1',
    text: 'Hello Bot',
    attachmentIds: overrides.attachmentIds || [],
    ...(overrides.attachmentDeliveryMode
      ? { attachmentDeliveryMode: overrides.attachmentDeliveryMode }
      : {}),
  },
});

const routineAdmission = () => ({
  revisionId: REVISION_ID,
  routine: {
    version: 1,
    routineId: 'c1000000-0000-4000-8000-000000000001',
    occurrenceId: 'c2000000-0000-4000-8000-000000000001',
    scheduledFor: '2026-08-23T09:00:00.000Z',
    recovered: true,
    freshApprovalRequired: true,
    contract: {
      version: 1,
      rationale: 'Review the approved queue.',
      trigger: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      goal: 'Review the approved queue.',
      inputs: {},
      allowedTools: ['browser'],
      allowedAccountIds: [],
      allowedOrigins: ['https://example.com'],
      limits: { maxActions: 2, maxExternalWrites: 1 },
      approvalClass: 'requester',
      timeoutSeconds: 600,
      missedPolicy: 'run_once',
      missedRunCap: 1,
      completionCriteria: ['The queue is reviewed.'],
    },
  },
});

describe('Production Bot FIFO run dispatcher', () => {
  it('admits durably before deferred runtime/model work', async () => {
    const harness = baseHarness();
    harness.runtimePreflight.mockRejectedValueOnce(Object.assign(new Error('Docker stopped'), {
      code: 'bot_runtime_docker_unavailable',
      statusCode: 503,
    }));

    await expect(enqueue(harness.dispatcher)).resolves.toMatchObject({ created: true });
    expect(harness.channels.enqueueUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.runtimePreflight).not.toHaveBeenCalled();
  });

  it('derives one stable assistant response id for legacy clients that omit it', async () => {
    const harness = baseHarness();

    await enqueue(harness.dispatcher);
    await enqueue(harness.dispatcher);

    const responseIds = harness.channels.enqueueUserMessage.mock.calls
      .map(([input]) => input.acknowledgmentId);
    expect(responseIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(responseIds[1]).toBe(responseIds[0]);
    expect(responseIds[0]).not.toBe(MESSAGE_ID);
  });

  it('does not let canonical event delivery or run claiming delay durable acceptance', async () => {
    const publication = deferred();
    const claim = deferred();
    const harness = baseHarness({ autoDispatch: true });
    harness.eventStream.publish.mockImplementation(() => publication.promise);
    harness.store.claimRun.mockImplementation(() => claim.promise);

    const admitted = await enqueue(harness.dispatcher);

    expect(admitted).toMatchObject({ created: true, run: { state: 'queued' } });
    await waitFor(() => expect(harness.eventStream.publish).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(harness.store.claimRun).toHaveBeenCalledTimes(1));
    publication.resolve({ delivered: 1 });
    claim.resolve(null);
    await harness.dispatcher.shutdown();
  });

  it('pins the newest published Library version into the atomic run admission', async () => {
    const resolveLibrarySnapshot = vi.fn(async () => [LIBRARY_VERSION_2]);
    const harness = baseHarness({ resolveLibrarySnapshot });

    await enqueue(harness.dispatcher);

    expect(resolveLibrarySnapshot).toHaveBeenCalledWith({
      botId: BOT_ID,
      configuredVersionIds: [LIBRARY_VERSION_1],
    });
    expect(harness.channels.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      contextSnapshot: {
        version: 1,
        state: 'queued',
        libraryVersionIds: [LIBRARY_VERSION_2],
        attachmentDeliveryMode: 'auto',
      },
    }));
  });

  it('validates and snapshots compatibility attachment delivery at admission', async () => {
    const harness = baseHarness();
    await enqueue(harness.dispatcher, { attachmentDeliveryMode: 'compatibility' });
    expect(harness.channels.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      contextSnapshot: expect.objectContaining({ attachmentDeliveryMode: 'compatibility' }),
    }));

    await expect(harness.dispatcher.enqueueMessage({
      principal: { id: USER_ID },
      channelId: CHANNEL_ID,
      message: {
        messageId: 'e0000000-0000-4000-8000-000000000099',
        idempotencyKey: 'invalid-mode',
        text: 'Retry',
        attachmentIds: [],
        attachmentDeliveryMode: 'native-only',
      },
    })).rejects.toMatchObject({ code: 'bot_attachment_delivery_mode_invalid', statusCode: 400 });
  });

  it('returns admission immediately while Shared preparation gates the FIFO claim', async () => {
    const preparation = deferred();
    const sharedFileService = { prepareMessage: vi.fn(() => preparation.promise) };
    const harness = baseHarness({ autoDispatch: true, sharedFileService });
    harness.store.claimRun.mockResolvedValue(null);

    const admitted = await enqueue(harness.dispatcher, {
      attachmentIds: ['f0000000-0000-4000-8000-000000000099'],
    });

    expect(admitted.run.state).toBe('queued');
    await waitFor(() => expect(sharedFileService.prepareMessage).toHaveBeenCalledWith({
      messageId: MESSAGE_ID,
    }));
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'message.created',
      payload: expect.objectContaining({
        channelPreview: expect.objectContaining({
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          text: 'Hello Bot',
          finalizedAt: expect.any(String),
        }),
      }),
    }));
    preparation.resolve({ ready: true });
    await waitFor(() => expect(harness.store.claimRun).toHaveBeenCalledTimes(1));
  });

  it('admits a reviewed routine only against the still-active revision and snapshots its contract', async () => {
    const harness = baseHarness();
    await harness.dispatcher.enqueueMessage({
      principal: { id: USER_ID },
      channelId: CHANNEL_ID,
      message: {
        messageId: MESSAGE_ID,
        idempotencyKey: 'routine:occurrence',
        text: 'Execute reviewed routine',
        attachmentIds: [],
      },
      admission: routineAdmission(),
    });
    expect(harness.channels.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      revisionId: REVISION_ID,
      contextSnapshot: expect.objectContaining({
        routine: expect.objectContaining({
          routineId: 'c1000000-0000-4000-8000-000000000001',
          recovered: true,
          freshApprovalRequired: true,
        }),
      }),
    }));

    const changed = baseHarness();
    changed.channels.preflightMessage.mockResolvedValueOnce({
      bot: {
        id: BOT_ID,
        tenancy: 'team',
        lifecycle: 'active',
        active_revision_id: 'd0000000-0000-4000-8000-000000000099',
      },
      channel: { id: CHANNEL_ID, bot_id: BOT_ID, owner_user_id: USER_ID, lifecycle: 'active' },
    });
    await expect(changed.dispatcher.enqueueMessage({
      principal: { id: USER_ID },
      channelId: CHANNEL_ID,
      message: {
        messageId: MESSAGE_ID,
        idempotencyKey: 'routine:stale',
        text: 'Execute stale routine',
        attachmentIds: [],
      },
      admission: routineAdmission(),
    })).rejects.toMatchObject({ code: 'bot_revision_changed', statusCode: 409 });
    expect(changed.channels.enqueueUserMessage).not.toHaveBeenCalled();
  });

  it('notifies scheduler settlement after a claimed routine run reaches a terminal state', async () => {
    const runExecutor = vi.fn(async (run) => ({ ...run, state: 'completed' }));
    const harness = baseHarness({ runExecutor });
    await enqueue(harness.dispatcher);
    await harness.dispatcher.drainScope(`bot:${BOT_ID}`);
    expect(harness.onRunSettled).toHaveBeenCalledWith({
      run: expect.objectContaining({ state: 'completed' }),
    });
  });

  it('returns an idle-scope admission as queued without waiting for execution', async () => {
    const execution = deferred();
    const runExecutor = vi.fn(async () => execution.promise);
    const harness = baseHarness({ autoDispatch: true, runExecutor });

    const admitted = await enqueue(harness.dispatcher);

    expect(admitted.run.state).toBe('queued');
    await waitFor(() => expect(runExecutor).toHaveBeenCalledTimes(1));
    execution.resolve();
    await harness.dispatcher.shutdown();
  });

  it('leaves only additional work genuinely queued while the shared scope is busy', async () => {
    const firstExecution = deferred();
    let invocation = 0;
    const runExecutor = vi.fn(async (run) => {
      invocation += 1;
      if (invocation === 1) await firstExecution.promise;
      return { ...run, state: 'completed' };
    });
    const harness = baseHarness({ autoDispatch: true, runExecutor });

    const first = await enqueue(harness.dispatcher);
    await waitFor(() => expect(runExecutor).toHaveBeenCalledTimes(1));
    const second = await enqueue(harness.dispatcher, {
      messageId: 'e0000000-0000-4000-8000-000000000002',
      idempotencyKey: 'client-2',
    });

    expect(first.run.state).toBe('queued');
    expect(second.run.state).toBe('queued');
    const drain = harness.dispatcher.drainScope(`bot:${BOT_ID}`);
    firstExecution.resolve();
    await drain;
    expect(runExecutor).toHaveBeenCalledTimes(2);
    await harness.dispatcher.shutdown();
  });

  it('honors an earlier authoritative database claim before the newly admitted run', async () => {
    const earlierExecution = deferred();
    const earlier = {
      id: 'f0000000-0000-4000-8000-000000000099',
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      revision_id: REVISION_ID,
      computer_scope_key: `bot:${BOT_ID}`,
      state: 'starting',
    };
    let invocation = 0;
    const runExecutor = vi.fn(async (run) => {
      invocation += 1;
      if (invocation === 1) await earlierExecution.promise;
      return { ...run, state: 'completed' };
    });
    const harness = baseHarness({ autoDispatch: true, runExecutor });
    harness.store.claimRun.mockResolvedValueOnce(earlier);

    const admitted = await enqueue(harness.dispatcher);

    expect(admitted.run.state).toBe('queued');
    await waitFor(() => expect(runExecutor).toHaveBeenCalledTimes(1));
    expect(runExecutor.mock.calls[0][0].id).toBe(earlier.id);
    const drain = harness.dispatcher.drainScope(`bot:${BOT_ID}`);
    earlierExecution.resolve();
    await drain;
    expect(runExecutor.mock.calls[1][0].id).toBe(admitted.run.id);
    await harness.dispatcher.shutdown();
  });

  it('runs Team Bot work FIFO with no overlapping lease owner', async () => {
    const first = deferred();
    const started = [];
    const runExecutor = vi.fn(async (run) => {
      started.push(run.id);
      if (started.length === 1) await first.promise;
    });
    const harness = baseHarness({ runExecutor });
    await enqueue(harness.dispatcher);
    await enqueue(harness.dispatcher, {
      messageId: 'e0000000-0000-4000-8000-000000000002',
      idempotencyKey: 'client-2',
    });

    const drain = harness.dispatcher.drainScope(`bot:${BOT_ID}`);
    await waitFor(() => expect(runExecutor).toHaveBeenCalledTimes(1));
    expect(harness.store.claimRun).toHaveBeenCalledTimes(1);
    first.resolve();
    await drain;
    expect(started).toHaveLength(2);
    expect(harness.store.claimRun.mock.calls.map(([input]) => input.computerScopeKey))
      .toEqual([`bot:${BOT_ID}`, `bot:${BOT_ID}`, `bot:${BOT_ID}`]);
  });

  it('reconciles an expired approval before every scoped claim', async () => {
    const harness = baseHarness();
    await enqueue(harness.dispatcher);
    await harness.dispatcher.drainScope(`bot:${BOT_ID}`);

    expect(harness.reconcileExpiredApprovals).toHaveBeenCalledWith(`bot:${BOT_ID}`);
    expect(harness.reconcileExpiredApprovals.mock.invocationCallOrder[0])
      .toBeLessThan(harness.store.claimRun.mock.invocationCallOrder[0]);
  });

  it('runs different Bot scopes concurrently while retaining per-scope serialization', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const runExecutor = vi.fn(async (run) => (
      run.computer_scope_key === `bot:${BOT_ID}` ? firstGate.promise : secondGate.promise
    ));
    const harness = baseHarness({ runExecutor });
    await enqueue(harness.dispatcher);
    const otherBotId = 'b0000000-0000-4000-8000-000000000002';
    harness.channels.preflightMessage.mockResolvedValueOnce({
      bot: { id: otherBotId, tenancy: 'team', lifecycle: 'active', active_revision_id: REVISION_ID },
      channel: { id: CHANNEL_ID, bot_id: otherBotId, owner_user_id: USER_ID, lifecycle: 'active' },
    });
    await enqueue(harness.dispatcher, {
      messageId: 'e0000000-0000-4000-8000-000000000002',
      idempotencyKey: 'other-bot',
    });

    const firstDrain = harness.dispatcher.drainScope(`bot:${BOT_ID}`);
    const secondDrain = harness.dispatcher.drainScope(`bot:${otherBotId}`);
    await waitFor(() => expect(runExecutor).toHaveBeenCalledTimes(2));
    expect(runExecutor.mock.calls.map(([claimed]) => claimed.computer_scope_key))
      .toEqual(expect.arrayContaining([`bot:${BOT_ID}`, `bot:${otherBotId}`]));

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([firstDrain, secondDrain]);
  });

  it('serializes different members onto the one shared computer scope', async () => {
    const gate = deferred();
    const runExecutor = vi.fn(async () => gate.promise);
    // A legacy 'personalized' Bot record must not reopen a per-member scope.
    const harness = baseHarness({ tenancy: 'personalized', runExecutor });
    await enqueue(harness.dispatcher);
    harness.channels.preflightMessage.mockResolvedValueOnce({
      bot: { id: BOT_ID, tenancy: 'personalized', lifecycle: 'active', active_revision_id: REVISION_ID },
      channel: {
        id: 'c0000000-0000-4000-8000-000000000002',
        bot_id: BOT_ID,
        owner_user_id: 'a0000000-0000-4000-8000-000000000002',
        lifecycle: 'active',
      },
    });
    await harness.dispatcher.enqueueMessage({
      principal: { id: 'a0000000-0000-4000-8000-000000000002' },
      channelId: 'c0000000-0000-4000-8000-000000000002',
      message: {
        messageId: 'e0000000-0000-4000-8000-000000000002',
        idempotencyKey: 'client-2', text: 'Parallel', attachmentIds: [],
      },
    });

    const drain = harness.dispatcher.drainScope(`bot:${BOT_ID}`);
    await waitFor(() => expect(runExecutor).toHaveBeenCalledTimes(1));
    gate.resolve();
    await drain;
    expect(harness.store.claimRun.mock.calls.map(([input]) => input.computerScopeKey))
      .not.toContain(`bot:${BOT_ID}:user:${USER_ID}`);
  });

  const createExecutionHarness = ({
    runTimeoutMs = 1_000,
    rowOverrides = {},
    onRunCompleted = vi.fn(async () => {}),
    contextAssembler = null,
    getModelCatalog = vi.fn(async () => []),
    runtimePreflight = vi.fn(async () => ({})),
    startReasoningRun = null,
    exportGeneratedImage = vi.fn(async () => ({
      filename: 'generated.png',
      contentType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })),
    sharedFileService = null,
    streamAccessLeases = null,
    prewarmCache = null,
    checkpointIntervalMs = 10,
    recordDiagnostic = vi.fn(),
    settleRunTerminal = null,
    inspection = null,
    logger = { warn: vi.fn() },
  } = {}) => {
    let revision = 0;
    let row = {
      id: 'f0000000-0000-4000-8000-000000000010',
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      revision_id: REVISION_ID,
      state: 'starting',
      computer_scope_key: `bot:${BOT_ID}`,
      model_snapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol', contextLimit: 100 },
      context_snapshot: {},
      updated_at: '2026-08-23T10:00:00.000Z',
      started_at: '2026-08-23T10:00:00.000Z',
      finished_at: null,
      ...rowOverrides,
    };
    const updateIfRevision = vi.fn(async (_keys, changes) => {
      revision += 1;
      row = {
        ...row,
        ...structuredClone(changes),
        updated_at: `2026-08-23T10:00:${String(revision).padStart(2, '0')}.000Z`,
      };
      return row;
    });
    const store = {
      claimRun: vi.fn(async () => null),
      settleRunTerminal: settleRunTerminal || vi.fn(async (input) => {
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(row.state)) return row;
        return updateIfRevision({ id: input.runId }, {
          state: input.state,
          interruption_kind: input.interruptionKind,
          context_snapshot: input.contextSnapshot,
          lease_owner: null,
          lease_until: null,
          finished_at: input.finishedAt,
        });
      }),
      repositories: {
        bots: { get: vi.fn(async () => ({ id: BOT_ID, tenancy: 'team' })) },
        bot_channels: { get: vi.fn(async () => ({
          id: CHANNEL_ID,
          bot_id: BOT_ID,
          owner_user_id: USER_ID,
          current_checkpoint_number: 0,
        })) },
        bot_revisions: { get: vi.fn(async () => ({
          id: REVISION_ID,
          bot_id: BOT_ID,
          contract: { models: {} },
          activated_at: '2026-08-23T09:00:00.000Z',
          retired_at: null,
          updated_at: '2026-08-23T09:00:00.000Z',
        })) },
        bot_messages: { list: vi.fn(async () => ({ items: [], nextCursor: null })) },
        bot_action_attempts: { list: vi.fn(async () => ({ items: [], nextCursor: null })) },
        bot_runs: {
          get: vi.fn(async () => row),
          list: vi.fn(async () => ({ items: [], nextCursor: null })),
          updateIfRevision,
        },
      },
    };
    const assistantMessages = new Map();
    let assistantMessageIndex = 10;
    const getAssistantMessage = (phase) => assistantMessages.get(phase) || null;
    const getOrCreateAssistantMessage = (phase = 'pending') => {
      const existing = getAssistantMessage(phase);
      if (existing) return existing;
      const message = {
        id: `e0000000-0000-4000-8000-${String(assistantMessageIndex).padStart(12, '0')}`,
        channel_id: CHANNEL_ID,
        run_id: row.id,
        role: 'assistant',
        assistant_phase: phase,
        sequence: assistantMessageIndex - 8,
        finalized_at: null,
      };
      assistantMessageIndex += 1;
      assistantMessages.set(phase, message);
      return message;
    };
    const channels = {
      preflightMessage: vi.fn(async ({ principal }) => ({
        bot: { id: BOT_ID, tenancy: 'team', active_revision_id: REVISION_ID },
        channel: {
          id: CHANNEL_ID,
          bot_id: BOT_ID,
          owner_user_id: USER_ID,
          lifecycle: 'active',
        },
        revision: {
          id: REVISION_ID,
          bot_id: BOT_ID,
          contract: { models: {} },
          activated_at: '2026-08-23T09:00:00.000Z',
          retired_at: null,
          updated_at: '2026-08-23T09:00:00.000Z',
        },
        principal,
      })),
      enqueueUserMessage: vi.fn(async (input) => ({
        created: true,
        rawRun: {
          ...row,
          id: input.runId,
          state: 'queued',
          context_snapshot: input.contextSnapshot,
        },
        run: { id: input.runId, state: 'queued' },
        message: {
          id: input.messageId,
          channelId: CHANNEL_ID,
          runId: input.runId,
          actorUserId: USER_ID,
          role: 'user',
          assistantPhase: null,
          sequence: 1,
          body: { text: input.text, attachmentIds: input.attachmentIds },
          attachmentCount: input.attachmentIds.length,
          createdAt: '2026-08-23T10:00:00.000Z',
          finalizedAt: '2026-08-23T10:00:00.000Z',
        },
      })),
      loadRecentMessages: vi.fn(async () => [{
        id: MESSAGE_ID,
        runId: row.id,
        actorUserId: USER_ID,
        role: 'user',
        sequence: 1,
        body: { text: 'Execute the bounded review' },
      }]),
      getAssistantCheckpoint: vi.fn(async ({ assistantPhase }) => (
        getAssistantMessage(assistantPhase)
      )),
      getOrCreateAssistantCheckpoint: vi.fn(async ({ assistantPhase = 'pending' }) => (
        getOrCreateAssistantMessage(assistantPhase)
      )),
      updateAssistantCheckpoint: vi.fn(async (input) => {
        const phase = input.assistantPhase || input.message.assistant_phase;
        if (input.assistantPhase) {
          assistantMessages.delete(input.message.assistant_phase);
          input.message.assistant_phase = input.assistantPhase;
          assistantMessages.set(input.assistantPhase, input.message);
        }
        input.message.finalized_at = input.finalizedAt;
        return {
          id: input.message.id,
          channelId: CHANNEL_ID,
          runId: row.id,
          actorUserId: null,
          role: 'assistant',
          assistantPhase: phase,
          sequence: input.message.sequence,
          body: { text: input.text, attachmentIds: [] },
          attachmentCount: 0,
          createdAt: '2026-08-23T10:00:00.000Z',
          finalizedAt: input.finalizedAt,
        };
      }),
      audienceForChannel: vi.fn(async () => [USER_ID]),
      authorizeChannelRead: vi.fn(async () => ({})),
      authorizeChannelSend: vi.fn(async () => ({})),
      publicRun: (runRow) => ({ id: runRow.id, state: runRow.state }),
    };
    let eventHandler = null;
    let promptHook = async () => {};
    const providerRecords = new Map();
    let providerIdle = false;
    const inspectFixture = () => {
      if (inspection) return inspection;
      const record = [...providerRecords.values()].filter((item) => item.info?.role === 'assistant').at(-1);
      return {
        promptObserved: opencodeProvider.prompt.mock.calls.length > 0,
        status: providerIdle ? 'idle' : 'busy',
        assistantMessageId: record?.info?.id || null,
        assistantTerminal: providerIdle && Boolean(record),
        assistantProjection: projectBotAssistantResponse([...(record?.parts.values() || [])]),
      };
    };
    const opencodeProvider = {
      start: vi.fn(async () => undefined),
      setEventHandler: vi.fn((handler) => { eventHandler = handler; }),
      startReasoningRun: startReasoningRun || vi.fn(async () => ({
        modelSnapshot: {
          providerId: 'openai', modelId: 'gpt-5.6-sol', contextLimit: 100,
        },
      })),
      createSegment: vi.fn(async () => ({ id: 'ses_bot_1' })),
      prompt: vi.fn(async (...args) => promptHook(...args)),
      inspectSegment: vi.fn(async () => inspectFixture()),
      exportGeneratedImage,
      abort: vi.fn(async () => ({})),
      stopReasoningRun: vi.fn(async () => ({})),
    };
    const eventStream = { publish: vi.fn(async () => ({})) };
    const approvalService = { cancelPendingForRun: vi.fn(async () => []) };
    const reasoningAdapter = createOpenCodeReasoningAdapter({
      provider: opencodeProvider,
      loadModelCatalog: getModelCatalog,
      prewarmCache,
    });
    const dispatcher = createBotRunDispatcher({
      store,
      channels,
      contextAssembler: contextAssembler || {
        assemble: vi.fn(async () => ({
          continuation: { create: true, reason: 'first_run', completedUserTurns: 0 },
          contextSnapshot: {
            version: 1,
            completedUserTurns: 0,
            providerContextRatio: 0,
          },
          parts: [{ type: 'text', text: 'Scoped context' }],
        })),
      },
      reasoningAdapters: [reasoningAdapter],
      eventStream,
      runtimePreflight,
      streamAccessLeases,
      sharedFileService,
      approvalService,
      onRunCompleted,
      runTimeoutMs,
      checkpointIntervalMs,
      autoDispatch: false,
      recordDiagnostic,
      logger,
      assistantMessages,
    });
    return {
      dispatcher,
      store,
      channels,
      eventStream,
      opencodeProvider,
      approvalService,
      onRunCompleted,
      contextAssembler: contextAssembler || null,
      getModelCatalog,
      runtimePreflight,
      sharedFileService,
      streamAccessLeases,
      prewarmCache,
      recordDiagnostic,
      logger,
      getRow: () => row,
      setPromptHook: (hook) => { promptHook = hook; },
      emit: (event) => {
        const info = event.properties?.info;
        const part = event.properties?.part;
        const messageId = info?.id || part?.messageID || event.properties?.messageID;
        if (messageId) {
          const record = providerRecords.get(messageId) || { info: {}, parts: new Map() };
          if (info) record.info = info;
          if (part) record.parts.set(part.id, structuredClone(part));
          if (event.type === 'message.part.delta') {
            const previous = record.parts.get(event.properties.partID);
            if (previous && event.properties.field === 'text') previous.text += event.properties.delta;
          }
          providerRecords.set(messageId, record);
        }
        if (event.type === 'session.status') providerIdle = event.properties.status.type === 'idle';
        return eventHandler({ runId: row.id, event });
      },
    };
  };

  it('adopts an in-flight warm runtime run id for an eligible send', async () => {
    const prewarmCache = {
      prewarm: vi.fn(() => ({ state: 'warming', revisionId: REVISION_ID })),
      peekCompiled: vi.fn(() => null),
      invalidateChannel: vi.fn(),
      invalidateAll: vi.fn(),
    };
    const startReasoningRun = vi.fn(async () => ({
      modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol', contextLimit: 100 },
    }));
    const harness = createExecutionHarness({ prewarmCache, startReasoningRun });
    const lease = await harness.dispatcher.prewarmChannel({
      principal: { id: USER_ID }, channelId: CHANNEL_ID,
    });
    const accepted = await harness.dispatcher.enqueueMessage({
      principal: { id: USER_ID },
      channelId: CHANNEL_ID,
      message: {
        messageId: 'e0000000-0000-4000-8000-000000000091',
        idempotencyKey: 'warm-send',
        text: 'Use the warm runtime',
        attachmentIds: [],
        prewarmLeaseId: lease.leaseId,
      },
    });
    expect(startReasoningRun).toHaveBeenCalledTimes(1);
    expect(accepted.run.id).toBe(startReasoningRun.mock.calls[0][0].run.id);
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      mark: 'bot.turn.lease_adopted',
    }));
    await harness.dispatcher.shutdown();
  });

  it('releases an unused warm runtime and uses the cold path for attachments', async () => {
    const prewarmCache = {
      prewarm: vi.fn(() => ({ state: 'warming', revisionId: REVISION_ID })),
      peekCompiled: vi.fn(() => null),
      invalidateChannel: vi.fn(),
      invalidateAll: vi.fn(),
    };
    const harness = createExecutionHarness({ prewarmCache });
    const lease = await harness.dispatcher.prewarmChannel({
      principal: { id: USER_ID }, channelId: CHANNEL_ID,
    });
    await harness.dispatcher.enqueueMessage({
      principal: { id: USER_ID },
      channelId: CHANNEL_ID,
      message: {
        messageId: 'e0000000-0000-4000-8000-000000000092',
        idempotencyKey: 'attachment-send',
        text: 'Use this file',
        attachmentIds: ['e0000000-0000-4000-8000-000000000099'],
        prewarmLeaseId: lease.leaseId,
      },
    });
    expect(harness.opencodeProvider.stopReasoningRun).toHaveBeenCalledTimes(1);
    expect(harness.channels.enqueueUserMessage.mock.calls[0][0].runId)
      .not.toBe(harness.opencodeProvider.startReasoningRun.mock.calls[0][0].run.id);
    await harness.dispatcher.shutdown();
  });

  it('persists a DOM timeout as a stable string code before execution starts', async () => {
    const startReasoningRun = vi.fn(async () => {
      throw new DOMException('deadline', 'TimeoutError');
    });
    const harness = createExecutionHarness({ startReasoningRun });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.getRow()).toMatchObject({
      state: 'failed',
      interruption_kind: 'bot_opencode_request_timeout',
      context_snapshot: expect.objectContaining({
        failurePhase: 'startup',
        failureStage: 'startup',
      }),
    });
    expect(typeof harness.getRow().interruption_kind).toBe('string');
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.failed',
      payload: expect.objectContaining({ code: 'bot_opencode_request_timeout' }),
    }));
  });

  it('retries idempotent terminal persistence and publishes failure only from the persisted row', async () => {
    const settleRunTerminal = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
      .mockRejectedValueOnce(Object.assign(new Error('response lost'), { code: 'ETIMEDOUT' }))
      .mockImplementationOnce(async (input) => ({
        id: input.runId,
        bot_id: BOT_ID,
        channel_id: CHANNEL_ID,
        revision_id: REVISION_ID,
        state: input.state,
        context_snapshot: input.contextSnapshot,
        interruption_kind: input.interruptionKind,
        finished_at: input.finishedAt,
      }));
    const startReasoningRun = vi.fn(async () => {
      throw Object.assign(new Error('provider unavailable'), { code: 'bot_opencode_request_failed' });
    });
    const harness = createExecutionHarness({ startReasoningRun, settleRunTerminal });

    const recovery = harness.dispatcher.resumeRun(harness.getRow());
    await waitFor(() => expect(settleRunTerminal).toHaveBeenCalledTimes(1));
    expect(harness.eventStream.publish.mock.calls.some(
      ([event]) => event.kind === 'run.failed',
    )).toBe(false);
    await recovery;

    expect(settleRunTerminal).toHaveBeenCalledTimes(3);
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.failed',
      payload: expect.objectContaining({ code: 'bot_opencode_request_failed' }),
    }));
  });

  it('journals terminal persistence exhaustion without publishing an unpersisted failure', async () => {
    const settleRunTerminal = vi.fn(async () => {
      throw Object.assign(new Error('database unavailable'), { code: 'bot_database_unavailable' });
    });
    const startReasoningRun = vi.fn(async () => {
      throw Object.assign(new Error('provider unavailable'), { code: 'bot_opencode_request_failed' });
    });
    const harness = createExecutionHarness({ startReasoningRun, settleRunTerminal });

    await expect(harness.dispatcher.resumeRun(harness.getRow()))
      .rejects.toMatchObject({ code: 'bot_database_unavailable' });
    expect(settleRunTerminal).toHaveBeenCalledTimes(3);
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      mark: 'bot.turn.terminal_persistence_failed',
      payload: expect.objectContaining({
        intendedState: 'failed',
        code: 'bot_database_unavailable',
        attempts: 3,
      }),
    }));
    expect(harness.eventStream.publish.mock.calls.some(
      ([event]) => event.kind === 'run.failed',
    )).toBe(false);
  });

  it('coalesces assistant checkpoints and finalizes only on authoritative idle', async () => {
    const harness = createExecutionHarness();
    harness.setPromptHook(async () => {
      setTimeout(() => {
        void harness.emit({
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant', tokens: { input: 60 },
            },
          },
        });
        void harness.emit({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_1', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
              type: 'text', text: 'Final answer',
            },
          },
        });
        void harness.emit({
          type: 'session.status',
          properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
        });
      }, 0);
    });

    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.getRow()).toMatchObject({
      state: 'completed',
      context_snapshot: { completedUserTurns: 1, providerContextRatio: 0.6 },
    });
    expect(harness.channels.updateAssistantCheckpoint.mock.calls.length).toBeLessThanOrEqual(2);
    expect(harness.channels.updateAssistantCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'Final answer',
      finalizedAt: expect.any(String),
    }));
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'message.updated',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      payload: expect.objectContaining({
        message: expect.objectContaining({
          role: 'assistant',
          body: { text: 'Final answer', attachmentIds: [] },
        }),
        channelPreview: expect.objectContaining({
          channelId: CHANNEL_ID,
          role: 'assistant',
          text: 'Final answer',
          finalizedAt: expect.any(String),
        }),
      }),
    }));
    expect(harness.opencodeProvider.stopReasoningRun).toHaveBeenCalledTimes(1);
  });

  it('buffers all pre-tool and inter-tool prose and publishes only the final result', async () => {
    const streamAccessLeases = {
      establish: vi.fn(),
      authorize: vi.fn(async () => true),
      isAuthorized: vi.fn(() => true),
      invalidateChannel: vi.fn(),
    };
    const harness = createExecutionHarness({ checkpointIntervalMs: 500, streamAccessLeases });
    harness.eventStream.publish.mockResolvedValue({ delivered: 1 });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_ack', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'Sure — I’ll check that and get back to you.',
          },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_1', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'tool', tool: 'devryan_bot', state: { status: 'running' },
          },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_progress', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'Capturing another snapshot.',
          },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_2', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'tool', tool: 'devryan_bot', state: { status: 'completed' },
          },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_result', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'The site is healthy and the checkout completed successfully.',
          },
        },
      });
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    const finalized = harness.channels.updateAssistantCheckpoint.mock.calls
      .map(([input]) => input)
      .filter((input) => input.finalizedAt);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      text: 'The site is healthy and the checkout completed successfully.',
      assistantPhase: 'result',
    });
    expect(finalized.map((input) => input.text).join('\n')).not.toContain('Capturing another snapshot');
    const streamedText = harness.eventStream.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'message.streaming')
      .map((event) => event.payload.text);
    expect(streamedText).toEqual([]);
    expect(harness.getRow().state).toBe('completed');
  });

  it('publishes finalized generated images before reasoning teardown', async () => {
    const publishedBytes = [];
    const sharedFileService = {
      prepareMessage: vi.fn(async () => ({ ready: true })),
      publishBotFile: vi.fn(async (input) => {
        publishedBytes.push(Buffer.from(input.bytes));
        return { id: 'f0000000-0000-4000-8000-000000000099' };
      }),
    };
    const inspection = {
      promptObserved: true,
      status: 'idle',
      assistantMessageId: 'msg_assistant',
      assistantText: 'The image is ready.',
      assistantTerminal: true,
      providerContextRatio: 0.2,
      assistantProjection: {
        toolObserved: true,
        acknowledgmentText: '',
        resultText: 'The image is ready.',
        generatedImages: [{
          toolPartId: 'part_image_1',
          sourcePath: 'generated/ad.png',
        }],
      },
    };
    const harness = createExecutionHarness({ inspection, sharedFileService });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_image_1', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'tool', tool: 'devryan_bot', state: { status: 'completed' },
          },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_result', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'The image is ready.',
          },
        },
      });
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.opencodeProvider.exportGeneratedImage).toHaveBeenCalledWith({
      runId: harness.getRow().id,
      path: 'generated/ad.png',
    });
    expect(sharedFileService.publishBotFile).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      principalId: USER_ID,
      filename: 'generated.png',
      contentType: 'image/png',
      sourceKey: expect.stringMatching(/^generated:[0-9a-f]{64}$/),
    }));
    expect(publishedBytes).toEqual([Buffer.from([0x89, 0x50, 0x4e, 0x47])]);
    expect(harness.opencodeProvider.exportGeneratedImage.mock.invocationCallOrder[0])
      .toBeLessThan(harness.opencodeProvider.stopReasoningRun.mock.invocationCallOrder[0]);
    expect(harness.getRow().state).toBe('completed');
  });

  it('fails tool work that reaches idle without a separate final result', async () => {
    const harness = createExecutionHarness({ checkpointIntervalMs: 500 });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_ack', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'I’ll take care of that.',
          },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'tool', tool: 'devryan_bot', state: { status: 'completed' },
          },
        },
      });
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.getRow()).toMatchObject({
      state: 'failed',
      interruption_kind: 'bot_response_missing',
    });
  });

  it('does not fail durable completion when canonical event publication fails', async () => {
    const harness = createExecutionHarness();
    harness.eventStream.publish.mockImplementation(async (event) => {
      if (event.kind === 'message.updated') throw Object.assign(new Error('SSE unavailable'), {
        code: 'bot_event_delivery_failed',
      });
      return { delivered: 0 };
    });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'Durable answer',
          },
        },
      });
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.getRow().state).toBe('completed');
    expect(harness.logger.warn).toHaveBeenCalledWith(
      '[BotsDispatcher] checkpoint publication failed',
      expect.objectContaining({ code: 'bot_event_delivery_failed' }),
    );
  });

  it('starts context assembly and the reasoning runtime concurrently and cleans up startup failure', async () => {
    const assembly = deferred();
    const runtime = deferred();
    const contextAssembler = { assemble: vi.fn(() => assembly.promise) };
    const startReasoningRun = vi.fn(() => runtime.promise);
    const harness = createExecutionHarness({ contextAssembler, startReasoningRun });

    const execution = harness.dispatcher.resumeRun(harness.getRow());
    await waitFor(() => expect(contextAssembler.assemble).toHaveBeenCalledTimes(1));
    expect(startReasoningRun).toHaveBeenCalledTimes(1);

    runtime.resolve({
      modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol', contextLimit: 100 },
    });
    assembly.reject(Object.assign(new Error('context failed'), { code: 'bot_context_failed' }));
    await execution;

    expect(harness.opencodeProvider.stopReasoningRun).toHaveBeenCalledTimes(1);
    expect(harness.getRow()).toMatchObject({
      state: 'failed',
      interruption_kind: 'bot_context_failed',
      context_snapshot: { failurePhase: 'startup', retryable: true },
    });
  });

  it.each(['assistant', 'action', 'unavailable'])('fails closed on startup retry evidence: %s', async (evidence) => {
    const harness = createExecutionHarness({ runtimePreflight: vi.fn(async () => {
      throw Object.assign(new Error('runtime unavailable'), { code: 'bot_runtime_supervisor_unavailable' });
    }) });
    if (evidence === 'assistant') {
      harness.store.repositories.bot_messages.list.mockResolvedValue({ items: [{
        channel_id: CHANNEL_ID, assistant_phase: 'result', finalized_at: null,
        attachment_count: 0, actor_user_id: null,
      }] });
    } else if (evidence === 'action') {
      harness.store.repositories.bot_action_attempts.list.mockResolvedValue({ items: [{ state: 'cancelled' }] });
    } else {
      harness.store.repositories.bot_action_attempts.list.mockRejectedValue(new Error('database unavailable'));
    }
    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.getRow()).toMatchObject({ state: 'failed', context_snapshot: { retryable: false } });
    expect(harness.opencodeProvider.prompt).not.toHaveBeenCalled();
  });

  it('forces one model-catalog refresh when startup reports a stale unavailable model', async () => {
    const getModelCatalog = vi.fn()
      .mockResolvedValueOnce({ generation: 1 })
      .mockResolvedValueOnce({ generation: 2 });
    const startReasoningRun = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('stale catalog'), {
        code: 'bot_model_unavailable',
      }))
      .mockResolvedValueOnce({
        modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol', contextLimit: 100 },
      });
    const harness = createExecutionHarness({ getModelCatalog, startReasoningRun });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(getModelCatalog.mock.calls).toEqual([[], [{ force: true }]]);
    expect(startReasoningRun).toHaveBeenCalledTimes(2);
    expect(harness.getRow()).toMatchObject({ state: 'failed', interruption_kind: 'bot_response_missing' });
  });

  it('buffers fragmented public text until the verified canonical final answer', async () => {
    const streamAccessLeases = {
      establish: vi.fn(),
      authorize: vi.fn(async () => true),
      isAuthorized: vi.fn(() => true),
      invalidateChannel: vi.fn(),
    };
    const harness = createExecutionHarness({
      streamAccessLeases,
      checkpointIntervalMs: 500,
    });
    harness.eventStream.publish.mockResolvedValue({ delivered: 1 });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'H',
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.eventStream.publish.mock.calls.some(
        ([event]) => event.kind === 'message.streaming',
      )).toBe(false);
      await harness.emit({
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_bot_1', messageID: 'msg_assistant', partID: 'part_1',
          field: 'text', delta: 'i',
        },
      });
      await harness.emit({
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_bot_1', messageID: 'msg_assistant', partID: 'part_1',
          field: 'text', delta: '!',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    const streamed = harness.eventStream.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'message.streaming');
    expect(streamed).toEqual([]);
    const canonical = harness.eventStream.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'message.updated');
    expect(canonical.at(-1).payload).toMatchObject({ streamRevision: 3 });
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      mark: 'bot.turn.first_provider_text',
      payload: expect.objectContaining({ runId: harness.getRow().id }),
    }));

  });

  it('never streams provider-hidden text or a leading agent-work label', async () => {
    const streamAccessLeases = {
      establish: vi.fn(),
      authorize: vi.fn(async () => true),
      isAuthorized: vi.fn(() => true),
      invalidateChannel: vi.fn(),
    };
    const harness = createExecutionHarness({
      streamAccessLeases,
      checkpointIntervalMs: 500,
    });
    harness.eventStream.publish.mockResolvedValue({ delivered: 1 });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'hidden', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'Calling the pricing tool.', ignored: true,
          },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'work-label', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'reasoning', text: 'Advising user on manual browser steps',
          },
        },
      });
      expect(harness.eventStream.publish.mock.calls.some(
        ([event]) => event.kind === 'message.streaming',
      )).toBe(false);
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'answer', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'JavaScript and cookies aren’t exposed as settings I can change here.',
          },
        },
      });
      await Promise.resolve();
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    const streamed = harness.eventStream.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'message.streaming');
    expect(streamed).toEqual([]);
    const canonical = harness.eventStream.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'message.updated');
    expect(canonical.at(-1).payload.message.body.text).toBe(
      'JavaScript and cookies aren’t exposed as settings I can change here.',
    );
  });

  it('suppresses requester streaming when authorization is uncertain', async () => {
    const streamAccessLeases = {
      establish: vi.fn(),
      authorize: vi.fn(async () => false),
      isAuthorized: vi.fn(() => false),
      invalidateChannel: vi.fn(),
    };
    const harness = createExecutionHarness({ streamAccessLeases, checkpointIntervalMs: 500 });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'authorization fallback',
          },
        },
      });
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.eventStream.publish.mock.calls.some(
      ([event]) => event.kind === 'message.streaming',
    )).toBe(false);
    expect(harness.eventStream.publish.mock.calls.some(
      ([event]) => event.kind === 'message.updated',
    )).toBe(true);
    expect(streamAccessLeases.authorize).not.toHaveBeenCalled();
  });

  it('falls back to canonical checkpoints above the 192 KiB live text cap', async () => {
    const streamAccessLeases = {
      establish: vi.fn(),
      authorize: vi.fn(async () => true),
      isAuthorized: vi.fn(() => true),
      invalidateChannel: vi.fn(),
    };
    const harness = createExecutionHarness({ streamAccessLeases, checkpointIntervalMs: 500 });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
        },
      });
      await harness.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1', messageID: 'msg_assistant', sessionID: 'ses_bot_1',
            type: 'text', text: 'x'.repeat(192 * 1024 + 1),
          },
        },
      });
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.eventStream.publish.mock.calls.some(
      ([event]) => event.kind === 'message.streaming',
    )).toBe(false);
    expect(harness.eventStream.publish.mock.calls.some(
      ([event]) => event.kind === 'message.updated',
    )).toBe(true);
    expect(streamAccessLeases.authorize).not.toHaveBeenCalled();
  });

  it('requeues the same safe startup run through the atomic store contract', async () => {
    const harness = createExecutionHarness({
      rowOverrides: {
        state: 'failed',
        context_snapshot: { version: 1, failurePhase: 'startup', retryable: true },
      },
    });
    harness.store.retryRun = vi.fn(async () => ({
      ...harness.getRow(),
      state: 'queued',
      model_snapshot: { version: 1, state: 'pending' },
      context_snapshot: { version: 1, state: 'queued', retryCount: 1 },
    }));

    const retried = await harness.dispatcher.retryRun({
      principal: { id: USER_ID },
      runId: harness.getRow().id,
    });

    expect(retried).toMatchObject({ id: harness.getRow().id, state: 'queued' });
    expect(harness.channels.authorizeChannelSend).toHaveBeenCalledWith({
      principal: { id: USER_ID },
      channelId: CHANNEL_ID,
    });
    expect(harness.store.retryRun).toHaveBeenCalledWith({
      runId: harness.getRow().id,
      actorUserId: USER_ID,
      now: expect.any(String),
    });
  });

  it('forwards the queued compatibility delivery snapshot into execution', async () => {
    const harness = createExecutionHarness({
      rowOverrides: { context_snapshot: { attachmentDeliveryMode: 'compatibility' } },
    });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.opencodeProvider.startReasoningRun).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentDeliveryMode: 'compatibility' }),
    );
  });

  it('never publishes hidden user context while assistant identity is unresolved', async () => {
    const harness = createExecutionHarness();
    const hidden = '<devryan_bot_run id="2d883e53-2eae-4245-8b8c-662371d6a13e" />\n'
      + '<devryan_bot_context>{"capabilities":{"invocation":null,"mcpServers":[]},'
      + '"checkpoint":null,"library":[],"memories":[],"messages":['
      + '{"id":"2b2109c7-9c03-4988-860f-e485d9f8da07","role":"user","sequence":1,'
      + '"text":"hey bro wos poppin"},{"id":"dcf7c501-1dbe-4931-af5c-dd35af099d5d",'
      + '"role":"assistant","sequence":2,"text":"Hey bro, what’s up? What are we working on?"}],'
      + '"version":1}</devryan_bot_context>what do you know about our project?';
    harness.setPromptHook(async () => {
      setTimeout(() => {
        void harness.emit({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'user_context', messageID: 'msg_user', sessionID: 'ses_bot_1',
              type: 'text', text: hidden,
            },
          },
        });
        void harness.emit({
          type: 'message.updated',
          properties: {
            info: { id: 'msg_user', sessionID: 'ses_bot_1', role: 'user' },
          },
        });
        void harness.emit({
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_bot_1', messageID: 'msg_assistant', partID: 'answer',
            field: 'text', delta: 'Safe answer',
          },
        });
        void harness.emit({
          type: 'message.updated',
          properties: {
            info: { id: 'msg_assistant', sessionID: 'ses_bot_1', role: 'assistant' },
          },
        });
        void harness.emit({ type: 'message.part.updated', properties: { part: {
          id: 'answer', messageID: 'msg_assistant', sessionID: 'ses_bot_1', type: 'text', text: 'Safe answer',
        } } });
        void harness.emit({
          type: 'session.status',
          properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
        });
      }, 0);
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    const checkpointTexts = harness.channels.updateAssistantCheckpoint.mock.calls
      .map(([input]) => input.text);
    expect(checkpointTexts).toContain('Safe answer');
    expect(checkpointTexts.some((text) => text.includes('<devryan_bot_run'))).toBe(false);
    expect(checkpointTexts.some((text) => text.includes('<devryan_bot_context'))).toBe(false);
    const publicEvents = JSON.stringify(harness.eventStream.publish.mock.calls);
    expect(publicEvents).not.toContain('<devryan_bot_run');
    expect(publicEvents).not.toContain('<devryan_bot_context');
    expect(harness.channels.updateAssistantCheckpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Safe answer', finalizedAt: expect.any(String) }),
    );
  });

  it('publishes completion before asynchronous memory follow-up and ignores follow-up failure', async () => {
    const followUp = deferred();
    const onRunCompleted = vi.fn(async () => followUp.promise);
    const harness = createExecutionHarness({ onRunCompleted, inspection: { promptObserved: true, status: 'idle', assistantTerminal: true, assistantMessageId: 'answer', assistantProjection: { resultText: 'Done.', generatedImages: [] } } });
    harness.setPromptHook(async () => {
      setTimeout(() => {
        void harness.emit({
          type: 'session.status',
          properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
        });
      }, 0);
    });

    const work = harness.dispatcher.resumeRun(harness.getRow());
    await waitFor(() => expect(onRunCompleted).toHaveBeenCalledTimes(1));
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.completed',
    }));
    expect(harness.opencodeProvider.stopReasoningRun).not.toHaveBeenCalled();
    followUp.resolve();
    await work;
    expect(harness.opencodeProvider.stopReasoningRun).toHaveBeenCalledTimes(1);

    const failingFollowUp = vi.fn(async () => {
      throw Object.assign(new Error('index unavailable'), { code: 'bot_indexer_unavailable' });
    });
    const failingHarness = createExecutionHarness({ onRunCompleted: failingFollowUp, inspection: { promptObserved: true, status: 'idle', assistantTerminal: true, assistantMessageId: 'answer', assistantProjection: { resultText: 'Done.', generatedImages: [] } } });
    failingHarness.setPromptHook(async () => {
      setTimeout(() => {
        void failingHarness.emit({
          type: 'session.status',
          properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
        });
      }, 0);
    });
    await failingHarness.dispatcher.resumeRun(failingHarness.getRow());
    expect(failingHarness.getRow().state).toBe('completed');
  });

  it.each(['waiting_approval', 'needs_reconciliation'])(
    'does not overwrite the durable %s gateway state when OpenCode becomes idle',
    async (gatewayState) => {
      const harness = createExecutionHarness();
      harness.setPromptHook(async () => {
        Object.assign(harness.getRow(), {
          state: gatewayState,
          updated_at: '2026-08-23T10:00:30.000Z',
        });
        await harness.emit({
          type: 'session.status',
          properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } },
        });
      });

      await harness.dispatcher.resumeRun(harness.getRow());

      expect(harness.getRow().state).toBe(gatewayState);
      expect(harness.channels.updateAssistantCheckpoint).not.toHaveBeenCalledWith(
        expect.objectContaining({ finalizedAt: expect.any(String) }),
      );
      expect(harness.opencodeProvider.stopReasoningRun).toHaveBeenCalledTimes(1);
    },
  );

  it('reconciles a recovered segment result without replaying its prompt', async () => {
    const harness = createExecutionHarness({
      rowOverrides: {
        opencode_segment_id: 'f0000000-0000-4000-8000-000000000011',
        opencode_session_id: 'ses_recovered',
      },
      inspection: {
        promptObserved: true,
        status: 'idle',
        assistantMessageId: 'msg_recovered',
        assistantText: 'Recovered canonical answer',
        assistantProjection: {
          toolObserved: false,
          acknowledgmentText: '',
          resultText: 'Recovered canonical answer',
        },
        assistantTerminal: true,
        providerContextRatio: 0.6,
      },
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.opencodeProvider.inspectSegment).toHaveBeenCalledWith({
      runId: 'f0000000-0000-4000-8000-000000000010',
      sessionId: 'ses_recovered',
      signal: expect.any(AbortSignal),
    });
    expect(harness.opencodeProvider.prompt).not.toHaveBeenCalled();
    expect(harness.opencodeProvider.createSegment).not.toHaveBeenCalled();
    expect(harness.channels.updateAssistantCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'Recovered canonical answer',
      finalizedAt: expect.any(String),
    }));
    expect(harness.getRow()).toMatchObject({
      state: 'completed',
      context_snapshot: { providerContextRatio: 0.6 },
    });
  });

  it('reconstructs only the result phase from a recovered tool turn', async () => {
    const harness = createExecutionHarness({
      rowOverrides: {
        opencode_segment_id: 'f0000000-0000-4000-8000-000000000011',
        opencode_session_id: 'ses_recovered',
      },
      inspection: {
        promptObserved: true,
        status: 'idle',
        assistantMessageId: 'msg_recovered',
        assistantText: 'I’ll check that.Internal progress.The result is ready.',
        assistantProjection: {
          toolObserved: true,
          acknowledgmentText: 'I’ll check that.',
          resultText: 'The result is ready.',
        },
        assistantTerminal: true,
        providerContextRatio: 0.4,
      },
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.opencodeProvider.prompt).not.toHaveBeenCalled();
    const finalized = harness.channels.updateAssistantCheckpoint.mock.calls
      .map(([input]) => input)
      .filter((input) => input.finalizedAt);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      text: 'The result is ready.',
      assistantPhase: 'result',
    });
    expect(harness.getRow().state).toBe('completed');
  });

  it('uses the final provider record even when a late metadata update hides identical streamed text', async () => {
    const harness = createExecutionHarness({ inspection: {
      promptObserved: true, status: 'idle', assistantTerminal: true,
      assistantMessageId: 'answer', assistantProjection: { resultText: 'Verified final answer.', generatedImages: [] },
    } });
    harness.setPromptHook(async () => {
      await harness.emit({ type: 'message.updated', properties: { info: { id: 'answer', role: 'assistant', sessionID: 'ses_bot_1' } } });
      const part = { id: 'part', messageID: 'answer', sessionID: 'ses_bot_1', type: 'text', text: 'Private response planning' };
      await harness.emit({ type: 'message.part.updated', properties: { part } });
      await harness.emit({ type: 'message.part.updated', properties: { part: { ...part, ignored: true } } });
      await harness.emit({ type: 'message.part.delta', properties: { messageID: 'answer', partID: 'reasoning', field: 'text', delta: 'Secret thought', sessionID: 'ses_bot_1' } });
      await harness.emit({ type: 'message.part.updated', properties: { part: { ...part, id: 'reasoning', type: 'reasoning', text: 'Secret thought' } } });
      expect(harness.channels.updateAssistantCheckpoint).not.toHaveBeenCalled();
      await harness.emit({ type: 'session.status', properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } } });
    });
    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.channels.updateAssistantCheckpoint.mock.calls.map(([input]) => input.text)).toEqual(['Verified final answer.']);
    expect(JSON.stringify(harness.eventStream.publish.mock.calls)).not.toMatch(/Secret thought|Private response planning/);
  });

  it('reconciles a missed final SSE event without resubmitting the prompt', async () => {
    const harness = createExecutionHarness({ runTimeoutMs: 3_000, inspection: {
      promptObserved: true, status: 'idle', assistantTerminal: true,
      assistantMessageId: 'answer', assistantProjection: { resultText: 'Recovered from provider records.', generatedImages: [] },
    } });
    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.getRow().state).toBe('completed');
    expect(harness.opencodeProvider.prompt).toHaveBeenCalledTimes(1);
    expect(harness.channels.updateAssistantCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Recovered from provider records.' }));
  });

  it('bounds prompt submission itself and aborts its request signal', async () => {
    const harness = createExecutionHarness({ runTimeoutMs: 40 });
    harness.setPromptHook(() => new Promise(() => {}));
    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.getRow()).toMatchObject({ state: 'failed', interruption_kind: 'bot_run_timeout' });
    expect(harness.opencodeProvider.prompt.mock.calls[0][0].signal.aborted).toBe(true);
    expect(harness.opencodeProvider.abort).toHaveBeenCalledTimes(1);
    expect(harness.opencodeProvider.prompt).toHaveBeenCalledTimes(1);
  });

  it('times out preparation and closes a late-created runtime without submitting', async () => {
    const prepared = deferred();
    const harness = createExecutionHarness({ runTimeoutMs: 40, startReasoningRun: vi.fn(() => prepared.promise) });
    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.getRow()).toMatchObject({ state: 'failed', interruption_kind: 'bot_run_timeout' });
    prepared.resolve({ modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' } });
    await waitFor(() => expect(harness.opencodeProvider.stopReasoningRun).toHaveBeenCalledTimes(1));
    expect(harness.opencodeProvider.prompt).not.toHaveBeenCalled();
  });

  it('fails empty verified answers even when no tool was used', async () => {
    const harness = createExecutionHarness({ inspection: {
      promptObserved: true, status: 'idle', assistantTerminal: true,
      assistantMessageId: 'answer', assistantProjection: { resultText: '', generatedImages: [] },
    } });
    harness.setPromptHook(() => harness.emit({ type: 'session.status', properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } } }));
    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.getRow()).toMatchObject({ state: 'failed', interruption_kind: 'bot_response_missing' });
  });

  it('accepts a verified file-only response bound to the current result message', async () => {
    const harness = createExecutionHarness({ inspection: {
      promptObserved: true, status: 'idle', assistantTerminal: false,
      assistantMessageId: 'answer', assistantProjection: { resultText: '', generatedImages: [] },
    } });
    harness.setPromptHook(async () => {
      const pending = await harness.channels.getAssistantCheckpoint({ assistantPhase: 'pending' });
      pending.attachment_count = 1;
      await harness.emit({ type: 'session.status', properties: { sessionID: 'ses_bot_1', status: { type: 'idle' } } });
    });
    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.getRow().state).toBe('completed');
  });

  it('aborts and fails a run when its bounded execution timeout expires', async () => {
    const harness = createExecutionHarness({ runTimeoutMs: 20 });
    await harness.dispatcher.resumeRun(harness.getRow());
    expect(harness.opencodeProvider.abort).toHaveBeenCalledWith({
      runId: 'f0000000-0000-4000-8000-000000000010',
      sessionId: 'ses_bot_1',
    });
    expect(harness.getRow()).toMatchObject({ state: 'failed', interruption_kind: 'bot_run_timeout' });
  });

  it.each([
    ['ProviderAuthError', 'bot_opencode_provider_authentication', false],
    ['UnknownError', 'bot_opencode_provider_unknown', true],
    ['MessageOutputLengthError', 'bot_opencode_output_length', true],
    ['MessageAbortedError', 'bot_opencode_message_aborted', true],
    ['StructuredOutputError', 'bot_opencode_structured_output', true],
    ['ContextOverflowError', 'bot_opencode_context_overflow', true],
    ['ContentFilterError', 'bot_opencode_content_filter', false],
  ])('classifies %s without exposing provider payloads', (name, interruptionKind, retryable) => {
    expect(classifyOpenCodeRunError({
      name,
      data: { message: 'secret provider body', responseBody: 'secret', responseHeaders: { authorization: 'secret' } },
    })).toEqual({
      providerErrorType: name,
      statusCode: null,
      retryable,
      providerReference: null,
      interruptionKind,
    });
  });

  it('forbids same-run retry after a transient provider failure while retaining provider advice', async () => {
    const logger = { warn: vi.fn() };
    const harness = createExecutionHarness({ logger });
    harness.setPromptHook(async () => {
      await harness.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_bot_1',
          error: {
            name: 'APIError',
            data: {
              message: 'secret provider response',
              statusCode: 429,
              isRetryable: true,
              requestId: 'req_safe-123',
              responseBody: 'secret body',
              responseHeaders: { authorization: 'secret token' },
            },
          },
        },
      });
    });

    await harness.dispatcher.resumeRun(harness.getRow());

    expect(harness.getRow()).toMatchObject({
      state: 'failed',
      interruption_kind: 'bot_opencode_api_retryable',
      context_snapshot: { failurePhase: 'execution', retryable: false },
    });
    expect(logger.warn).toHaveBeenCalledWith('[BotsDispatcher] Bot run failed', {
      code: 'bot_opencode_api_retryable',
      runId: 'f0000000-0000-4000-8000-000000000010',
      providerErrorType: 'APIError',
      statusCode: 429,
      retryable: true,
      providerReference: 'req_safe-123',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it('cancels an active scoped run without waiting for timeout', async () => {
    const harness = createExecutionHarness({ runTimeoutMs: 5_000 });
    const work = harness.dispatcher.resumeRun(harness.getRow());
    await waitFor(() => expect(harness.opencodeProvider.prompt).toHaveBeenCalledTimes(1));
    await harness.dispatcher.cancelRun({
      principal: { id: USER_ID },
      runId: 'f0000000-0000-4000-8000-000000000010',
    });
    await work;
    expect(harness.getRow()).toMatchObject({ state: 'cancelled' });
    expect(harness.opencodeProvider.abort).toHaveBeenCalled();
    expect(harness.approvalService.cancelPendingForRun).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: 'f0000000-0000-4000-8000-000000000010' }),
    });
  });

  it('finalizes an assistant checkpoint when a gateway-paused run is cancelled', async () => {
    const harness = createExecutionHarness({ runTimeoutMs: 5_000 });
    const work = harness.dispatcher.resumeRun(harness.getRow());
    await waitFor(() => expect(harness.opencodeProvider.prompt).toHaveBeenCalledTimes(1));
    Object.assign(harness.getRow(), {
      state: 'waiting_approval',
      updated_at: '2026-08-23T10:00:30.000Z',
    });

    await harness.dispatcher.cancelRun({
      principal: { id: USER_ID },
      runId: 'f0000000-0000-4000-8000-000000000010',
    });
    await work;

    expect(harness.getRow()).toMatchObject({ state: 'cancelled' });
    expect(harness.channels.updateAssistantCheckpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ finalizedAt: expect.any(String) }),
    );
  });
});
