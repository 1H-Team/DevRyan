import { describe, expect, it, vi } from 'vitest';

import { memoryAssociatedData } from './channels.js';
import { decryptBotJson } from './encryption.js';
import { createBotMemoryRuntime } from './memory-runtime.js';

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const REVISION_ID = '55555555-5555-4555-8555-555555555555';
const USER_MESSAGE_ID = '66666666-6666-4666-8666-666666666666';
const ASSISTANT_MESSAGE_ID = '77777777-7777-4777-8777-777777777777';
const SECOND_RUN_ID = '44444444-4444-4444-9444-444444444445';
const SECOND_USER_MESSAGE_ID = '66666666-6666-4666-9666-666666666667';
const SECOND_ASSISTANT_MESSAGE_ID = '77777777-7777-4777-9777-777777777778';
const MEMORY_ID = '88888888-8888-4888-8888-888888888888';
const VERSION_ID = '99999999-9999-4999-8999-999999999999';
const TIMESTAMP = '2026-08-23T12:00:00.000Z';

const waitUntil = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for memory runtime test condition');
};

const page = (items = []) => ({ items, nextCursor: null });

const memoryRow = (overrides = {}) => ({
  id: MEMORY_ID,
  bot_id: BOT_ID,
  scope: 'shared',
  subject_user_id: null,
  logical_key: 'deployment.region',
  encrypted_content: { test: true },
  sensitivity: 'normal',
  confidence: 0.9,
  active_version_id: VERSION_ID,
  created_at: TIMESTAMP,
  updated_at: TIMESTAMP,
  tombstoned_at: null,
  test_text: 'The deployment region is eu-west-1.',
  ...overrides,
});

const versionRow = (overrides = {}) => ({
  id: VERSION_ID,
  memory_id: MEMORY_ID,
  version_number: 1,
  encrypted_content: { test: true },
  classifier_metadata: {},
  creator_kind: 'classifier',
  created_by: USER_ID,
  created_at: TIMESTAMP,
  ...overrides,
});

const createHarness = ({ extractCandidates, commitResult, loadAdditionalIndexDocuments } = {}) => {
  const memory = memoryRow();
  const repositories = {
    bot_memories: {
      get: vi.fn(async (filters) => (
        filters.id === memory.id || filters.logical_key === memory.logical_key ? memory : null
      )),
      list: vi.fn(async () => page([memory])),
      updateIfRevision: vi.fn(async (_keys, changes) => ({
        ...memory,
        ...changes,
        updated_at: '2026-08-23T12:01:00.000Z',
      })),
    },
    bot_memory_versions: {
      get: vi.fn(async () => versionRow()),
      list: vi.fn(async () => page([versionRow()])),
    },
    bot_memory_sources: {
      get: vi.fn(async () => null),
      list: vi.fn(async () => page()),
    },
    bot_audit_events: { list: vi.fn(async () => page()) },
    bot_channels: {
      get: vi.fn(async () => ({
        id: CHANNEL_ID,
        bot_id: BOT_ID,
        owner_user_id: USER_ID,
        current_checkpoint_number: 0,
        summary_envelope: null,
        archived_at: null,
        updated_at: TIMESTAMP,
      })),
      list: vi.fn(async () => page()),
      updateIfRevision: vi.fn(),
    },
    bot_runs: { get: vi.fn(), list: vi.fn(async () => page()) },
    bots: { get: vi.fn(async () => ({ id: BOT_ID })) },
    bot_revisions: { get: vi.fn(async () => ({ id: REVISION_ID, bot_id: BOT_ID, contract: {} })) },
    bot_objects: { get: vi.fn(), list: vi.fn(async () => page()) },
  };
  const jobs = new Map();
  const store = {
    repositories,
    commitChannelSummary: vi.fn(async ({ expectedCheckpointNumber }) => ({
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: USER_ID,
      current_checkpoint_number: expectedCheckpointNumber + 1,
      summary_envelope: { test: true },
      archived_at: null,
      updated_at: TIMESTAMP,
    })),
    enqueueMemoryExtractionJob: vi.fn(async ({ runId }) => {
      const existing = jobs.get(runId);
      if (existing) return existing;
      const job = {
        run_id: runId,
        bot_id: BOT_ID,
        channel_id: CHANNEL_ID,
        revision_id: REVISION_ID,
        state: 'queued',
        candidate_envelope: null,
        attempt_count: 0,
      };
      jobs.set(runId, job);
      return job;
    }),
    claimMemoryExtractionJob: vi.fn(async ({ leaseOwner }) => {
      const job = [...jobs.values()].find((candidate) => candidate.state === 'queued');
      if (!job) return null;
      Object.assign(job, {
        state: 'leased',
        lease_owner: leaseOwner,
        attempt_count: job.attempt_count + 1,
      });
      return { ...job };
    }),
    persistMemoryExtractionCandidates: vi.fn(async ({ runId, candidateEnvelope }) => {
      const job = jobs.get(runId);
      Object.assign(job, { candidate_envelope: candidateEnvelope });
      return { ...job };
    }),
    settleMemoryExtractionJob: vi.fn(async ({ runId, disposition }) => {
      const job = jobs.get(runId);
      Object.assign(job, {
        state: ['defer', 'retry'].includes(disposition) ? 'queued' : disposition,
        attempt_count: disposition === 'defer'
          ? Math.max(0, job.attempt_count - 1)
          : job.attempt_count,
        lease_owner: null,
      });
      return { ...job };
    }),
    commitMemoryVersion: vi.fn(async (input) => commitResult || ({
      memory: {
        ...memory,
        id: input.memoryId,
        bot_id: input.botId,
        scope: input.scope,
        subject_user_id: input.subjectUserId,
        logical_key: input.logicalKey,
        encrypted_content: input.encryptedContent,
        active_version_id: input.versionId,
        sensitivity: input.sensitivity,
        confidence: input.confidence,
        updated_at: '2026-08-23T12:01:00.000Z',
        test_text: 'Manager-edited deployment region.',
      },
      version: versionRow({
        id: input.versionId,
        encrypted_content: input.encryptedContent,
        creator_kind: input.creatorKind,
        created_by: input.createdBy,
      }),
      source: { id: input.sourceId },
      activated: true,
    })),
    deleteChannel: vi.fn(async () => ({
      deleted_private_memories: 1,
      retained_shared_memories: 1,
      deleted_messages: 3,
    })),
    storage: { delete: vi.fn(async () => ({})) },
  };
  const authorization = {
    requireManager: vi.fn(async () => ({})),
    requireChannelRead: vi.fn(async () => ({
      channel: { id: CHANNEL_ID, bot_id: BOT_ID, owner_user_id: USER_ID },
    })),
  };
  const channels = {
    decryptMemory: vi.fn(async (row) => ({ text: row.test_text || 'Version text.' })),
    decryptSummary: vi.fn(async () => null),
    loadRunUserMessage: vi.fn(async ({ runId }) => ({
      id: runId === SECOND_RUN_ID ? SECOND_USER_MESSAGE_ID : USER_MESSAGE_ID,
      body: { text: 'My preferred report format is concise.' },
    })),
    loadRunAssistantResult: vi.fn(async ({ runId }) => ({
      id: runId === SECOND_RUN_ID ? SECOND_ASSISTANT_MESSAGE_ID : ASSISTANT_MESSAGE_ID,
      body: { text: 'I will keep reports concise.' },
    })),
  };
  const indexer = {
    status: vi.fn(async () => ({ state: 'ready' })),
    upsert: vi.fn(async () => ({ changed: true })),
    delete: vi.fn(async () => ({ changed: true })),
    rebuild: vi.fn(async (documents) => ({ documentCount: documents.length })),
  };
  const audit = vi.fn(async () => ({}));
  const onMemoryChanged = vi.fn(async () => ({}));
  let uuidIndex = 0;
  const uuids = [
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000004',
  ];
  const runtime = createBotMemoryRuntime({
    store,
    authorization,
    channels,
    encryption: { getKey: async () => Buffer.alloc(32, 7) },
    indexer,
    extractCandidates: extractCandidates || vi.fn(async () => ({ candidates: [] })),
    loadAdditionalIndexDocuments: loadAdditionalIndexDocuments || vi.fn(async () => []),
    audit,
    onMemoryChanged,
    uuid: () => uuids[uuidIndex++ % uuids.length],
    now: () => new Date('2026-08-23T12:02:00.000Z'),
    extractionRetryDelaysMs: [1],
  });
  repositories.bot_runs.get.mockImplementation(async ({ id }) => ({
    id,
    bot_id: BOT_ID,
    channel_id: CHANNEL_ID,
    revision_id: REVISION_ID,
    state: 'completed',
  }));
  return {
    runtime,
    store,
    repositories,
    authorization,
    channels,
    indexer,
    audit,
    onMemoryChanged,
    memory,
  };
};

const completedRun = () => ({
  run: { id: RUN_ID },
  bot: { id: BOT_ID },
  channel: {
    id: CHANNEL_ID,
    bot_id: BOT_ID,
    owner_user_id: USER_ID,
    current_checkpoint_number: 0,
    summary_envelope: null,
  },
  revision: { id: REVISION_ID },
  userMessage: { id: USER_MESSAGE_ID, body: { text: 'My preferred report format is concise.' } },
  assistantMessage: { id: ASSISTANT_MESSAGE_ID, body: { text: 'I will keep reports concise.' } },
});

const threadCandidate = ({
  runId = RUN_ID,
  logicalKey = 'thread.report.format',
  messageIds = [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID],
} = {}) => ({
  statement: 'Use the concise report format in this thread.',
  logicalKey,
  scope: 'thread_only',
  subjectUserId: null,
  sensitivity: 'normal',
  confidence: 0.91,
  transcriptQuote: false,
  provenance: { channelId: CHANNEL_ID, runId, messageIds },
});

describe('Bot layered memory runtime', () => {
  it('never lets an asynchronous extraction failure change the completed run outcome', async () => {
    const harness = createHarness({
      extractCandidates: vi.fn(async () => {
        throw Object.assign(new Error('model unavailable'), { code: 'bot_model_unavailable' });
      }),
    });

    await expect(harness.runtime.enqueueCompletedRun(completedRun())).resolves.toEqual({ queued: true });
    await harness.runtime.waitForPendingExtractions();
    expect(harness.store.commitMemoryVersion).not.toHaveBeenCalled();
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bot.memory.extract',
      result: 'failure',
      metadata: expect.objectContaining({
        code: 'bot_model_unavailable',
        phase: 'classification',
        retryable: false,
        attemptCount: 1,
      }),
    }));
  });

  it('settles a malformed no-tools provider request without retrying it', async () => {
    const extractCandidates = vi.fn(async () => {
      throw Object.assign(new Error('request invalid'), { code: 'bot_opencode_request_invalid' });
    });
    const harness = createHarness({ extractCandidates });

    await harness.runtime.enqueueCompletedRun(completedRun());
    await harness.runtime.waitForPendingExtractions();

    expect(extractCandidates).toHaveBeenCalledTimes(1);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bot.memory.extract',
      result: 'failure',
      metadata: expect.objectContaining({
        code: 'bot_opencode_request_invalid',
        phase: 'classification',
        retryable: false,
        attemptCount: 1,
      }),
    }));
  });

  it('settles a synthetic revision conflict without retrying it', async () => {
    const extractCandidates = vi.fn(async () => {
      throw Object.assign(new Error('synthetic run cannot persist a model snapshot'), {
        code: 'bot_revision_conflict',
        statusCode: 409,
      });
    });
    const harness = createHarness({ extractCandidates });

    await harness.runtime.enqueueCompletedRun(completedRun());
    await harness.runtime.waitForPendingExtractions();

    expect(extractCandidates).toHaveBeenCalledTimes(1);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bot.memory.extract',
      result: 'failure',
      metadata: expect.objectContaining({
        code: 'bot_revision_conflict',
        phase: 'classification',
        retryable: false,
        attemptCount: 1,
      }),
    }));
  });

  it('defers a busy channel without consuming an attempt and succeeds after it becomes idle', async () => {
    const extractCandidates = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('scope busy'), {
        code: 'bot_runtime_scope_busy',
        details: { phase: 'admission', retryable: true },
      }))
      .mockResolvedValueOnce({ candidates: [] });
    const harness = createHarness({ extractCandidates });

    await harness.runtime.enqueueCompletedRun(completedRun());
    await waitUntil(() => harness.store.settleMemoryExtractionJob.mock.calls.some(
      ([input]) => input.disposition === 'defer',
    ));
    await harness.runtime.waitForPendingExtractions();
    if (extractCandidates.mock.calls.length < 2) await harness.runtime.start();
    await waitUntil(() => extractCandidates.mock.calls.length === 2);
    await harness.runtime.waitForPendingExtractions();

    expect(extractCandidates).toHaveBeenCalledTimes(2);
    expect(harness.store.settleMemoryExtractionJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        disposition: 'defer',
        phase: 'admission',
        errorCode: 'bot_runtime_scope_busy',
      }),
    );
    expect(harness.store.settleMemoryExtractionJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ disposition: 'succeeded' }),
    );
    expect(harness.audit).toHaveBeenCalledTimes(1);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: 'success',
      metadata: expect.objectContaining({ retryAttemptCount: 0 }),
    }));
  });

  it('serializes concurrent claim pumps so the global worker limit cannot be oversubscribed', async () => {
    const harness = createHarness();
    let releaseClaim;
    const claimGate = new Promise((resolve) => {
      releaseClaim = resolve;
    });
    let activeClaims = 0;
    let maximumActiveClaims = 0;
    harness.store.claimMemoryExtractionJob.mockImplementation(async () => {
      activeClaims += 1;
      maximumActiveClaims = Math.max(maximumActiveClaims, activeClaims);
      await claimGate;
      activeClaims -= 1;
      return null;
    });

    const first = harness.runtime.enqueueCompletedRun(completedRun());
    const second = harness.runtime.enqueueCompletedRun({
      ...completedRun(),
      run: { id: SECOND_RUN_ID },
    });
    await waitUntil(() => harness.store.claimMemoryExtractionJob.mock.calls.length === 1);
    expect(maximumActiveClaims).toBe(1);
    releaseClaim();
    await Promise.all([first, second]);
    await harness.runtime.shutdown();
  });

  it('rebases a thread summary after bounded optimistic conflicts', async () => {
    const harness = createHarness({
      extractCandidates: vi.fn(async () => ({ candidates: [threadCandidate()] })),
    });
    const channel = {
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: USER_ID,
      current_checkpoint_number: 0,
      summary_envelope: null,
      archived_at: null,
      updated_at: TIMESTAMP,
    };
    harness.repositories.bot_channels.get.mockResolvedValue(channel);
    harness.channels.decryptSummary.mockResolvedValue({ version: 1, items: [] });
    harness.store.commitChannelSummary
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'bot_summary_checkpoint_conflict' }))
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'bot_summary_checkpoint_conflict' }))
      .mockResolvedValueOnce({
        ...channel,
        current_checkpoint_number: 1,
        updated_at: '2026-08-23T12:03:00.000Z',
      });

    await harness.runtime.enqueueCompletedRun(completedRun());
    await harness.runtime.waitForPendingExtractions();

    expect(harness.store.commitChannelSummary).toHaveBeenCalledTimes(3);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bot.memory.extract',
      result: 'success',
      metadata: expect.objectContaining({
        activatedCount: 1,
        conflictCount: 0,
        retryAttemptCount: 2,
      }),
    }));
  });

  it('serializes concurrent thread-summary commits for one channel', async () => {
    const harness = createHarness({
      extractCandidates: vi.fn(async ({ runId }) => ({
        candidates: [threadCandidate({
          runId,
          logicalKey: runId === RUN_ID ? 'thread.first' : 'thread.second',
          messageIds: runId === RUN_ID
            ? [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID]
            : [SECOND_USER_MESSAGE_ID, SECOND_ASSISTANT_MESSAGE_ID],
        })],
      })),
    });
    let channel = {
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: USER_ID,
      current_checkpoint_number: 0,
      summary_envelope: null,
      archived_at: null,
      updated_at: TIMESTAMP,
    };
    const items = [];
    let activeUpdates = 0;
    let maximumActiveUpdates = 0;
    harness.repositories.bot_channels.get.mockImplementation(async () => ({ ...channel }));
    harness.channels.decryptSummary.mockImplementation(async () => ({ version: 1, items: [...items] }));
    harness.store.commitChannelSummary.mockImplementation(async ({
      expectedCheckpointNumber,
      summaryEnvelope,
    }) => {
      activeUpdates += 1;
      maximumActiveUpdates = Math.max(maximumActiveUpdates, activeUpdates);
      await Promise.resolve();
      const nextRunId = items.length === 0 ? RUN_ID : SECOND_RUN_ID;
      items.push({
        sourceRunId: nextRunId,
        logicalKey: items.length === 0 ? 'thread.first' : 'thread.second',
        text: 'summary',
      });
      channel = {
        ...channel,
        current_checkpoint_number: expectedCheckpointNumber + 1,
        summary_envelope: summaryEnvelope,
        updated_at: `2026-08-23T12:03:0${items.length}.000Z`,
      };
      activeUpdates -= 1;
      return { ...channel };
    });
    const second = {
      ...completedRun(),
      run: { id: SECOND_RUN_ID },
      userMessage: { id: SECOND_USER_MESSAGE_ID, body: { text: 'Keep this thread temporary.' } },
      assistantMessage: { id: SECOND_ASSISTANT_MESSAGE_ID, body: { text: 'I will.' } },
    };

    await Promise.all([
      harness.runtime.enqueueCompletedRun(completedRun()),
      harness.runtime.enqueueCompletedRun(second),
    ]);
    await harness.runtime.waitForPendingExtractions();

    expect(maximumActiveUpdates).toBe(1);
    expect(harness.store.commitChannelSummary).toHaveBeenCalledTimes(2);
  });

  it('retries exhausted summary conflicts durably before one terminal audit failure', async () => {
    const harness = createHarness({
      extractCandidates: vi.fn(async () => ({ candidates: [threadCandidate()] })),
    });
    harness.repositories.bot_channels.get.mockResolvedValue({
      ...completedRun().channel, updated_at: TIMESTAMP,
    });
    harness.store.commitChannelSummary.mockRejectedValue(
      Object.assign(new Error('conflict'), { code: 'bot_summary_checkpoint_conflict' }),
    );
    await expect(harness.runtime.enqueueCompletedRun(completedRun())).resolves.toEqual({ queued: true });
    await harness.runtime.waitForPendingExtractions();
    expect(harness.store.commitChannelSummary).toHaveBeenCalledTimes(6);
    expect(harness.indexer.upsert).not.toHaveBeenCalled();
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: 'failure',
      metadata: expect.objectContaining({
        code: 'bot_summary_checkpoint_conflict',
        phase: 'summary_commit',
        attemptCount: 2,
      }),
    }));
  });

  it('drains asynchronous extraction during shutdown and refuses new work', async () => {
    let finishExtraction;
    const extraction = new Promise((resolve) => { finishExtraction = resolve; });
    const harness = createHarness({ extractCandidates: vi.fn(() => extraction) });
    await harness.runtime.enqueueCompletedRun(completedRun());
    const shutdown = harness.runtime.shutdown();
    await expect(harness.runtime.enqueueCompletedRun(completedRun())).resolves.toEqual({ skipped: true });
    expect(harness.runtime.getPendingExtractionCount()).toBe(1);
    finishExtraction({ candidates: [] });
    await shutdown;
    expect(harness.runtime.getPendingExtractionCount()).toBe(0);
  });

  it('treats an existing thread candidate as idempotent and repairs its index', async () => {
    const harness = createHarness({
      extractCandidates: vi.fn(async () => ({ candidates: [threadCandidate()] })),
    });
    const channel = {
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: USER_ID,
      current_checkpoint_number: 2,
      summary_envelope: { test: true },
      archived_at: null,
      updated_at: TIMESTAMP,
    };
    harness.repositories.bot_channels.get.mockResolvedValue(channel);
    harness.channels.decryptSummary.mockResolvedValue({
      version: 1,
      items: [{ sourceRunId: RUN_ID, logicalKey: 'thread.report.format', text: 'Existing.' }],
    });

    await harness.runtime.enqueueCompletedRun(completedRun());
    await harness.runtime.waitForPendingExtractions();

    expect(harness.store.commitChannelSummary).not.toHaveBeenCalled();
    expect(harness.indexer.upsert).toHaveBeenCalledWith(expect.objectContaining({
      documentId: `summary:${CHANNEL_ID}`,
    }));
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: 'success',
      metadata: expect.objectContaining({ idempotentCount: 1, conflictCount: 0 }),
    }));
  });

  it('fails closed when an existing thread summary cannot be decrypted', async () => {
    const harness = createHarness({
      extractCandidates: vi.fn(async () => ({ candidates: [threadCandidate()] })),
    });
    harness.repositories.bot_channels.get.mockResolvedValue({
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: USER_ID,
      current_checkpoint_number: 2,
      summary_envelope: { test: true },
      archived_at: null,
      updated_at: TIMESTAMP,
    });
    harness.channels.decryptSummary.mockRejectedValue(new Error('invalid envelope'));

    await harness.runtime.enqueueCompletedRun(completedRun());
    await harness.runtime.waitForPendingExtractions();

    expect(harness.store.commitChannelSummary).not.toHaveBeenCalled();
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: 'failure',
      metadata: expect.objectContaining({
        code: 'bot_memory_summary_decrypt_failed',
        phase: 'thread_summary_decrypt',
      }),
    }));
  });

  it('keeps confidential owner facts in the one shared namespace and records immutable provenance', async () => {
    const harness = createHarness({
      extractCandidates: vi.fn(async () => ({
        candidates: [{
          statement: 'The user prefers concise reports.',
          logicalKey: 'report.format',
          scope: 'shared',
          subjectUserId: USER_ID,
          sensitivity: 'confidential',
          confidence: 0.92,
          transcriptQuote: false,
          provenance: {
            channelId: CHANNEL_ID,
            runId: RUN_ID,
            messageIds: [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID],
          },
        }],
      })),
    });
    harness.repositories.bot_memories.get.mockResolvedValue(null);

    await expect(harness.runtime.enqueueCompletedRun(completedRun())).resolves.toEqual({ queued: true });
    await harness.runtime.waitForPendingExtractions();
    expect(harness.store.commitMemoryVersion).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'shared',
      subjectUserId: null,
      sensitivity: 'confidential',
      creatorKind: 'classifier',
      runId: RUN_ID,
      messageId: USER_MESSAGE_ID,
      sourceMetadata: expect.objectContaining({
        messageIds: [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID],
        revisionId: REVISION_ID,
      }),
    }));
    expect(harness.indexer.upsert).toHaveBeenCalledWith(expect.objectContaining({
      namespace: `bot:${BOT_ID}`,
      text: 'The user prefers concise reports.',
    }));
    expect(harness.onMemoryChanged).toHaveBeenCalledWith({
      botId: BOT_ID,
      memoryIds: [expect.any(String)],
      source: 'automatic',
    });
  });

  it('recovers after candidate persistence and memory commit without repeating model work or source identity', async () => {
    const extractCandidates = vi.fn(async () => ({
      candidates: [{
        statement: 'Deploy to eu-west-1.',
        logicalKey: 'deployment.region.recovery',
        scope: 'shared',
        subjectUserId: null,
        sensitivity: 'normal',
        confidence: 0.95,
        transcriptQuote: false,
        provenance: {
          channelId: CHANNEL_ID,
          runId: RUN_ID,
          messageIds: [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID],
        },
      }],
    }));
    const harness = createHarness({ extractCandidates });
    harness.repositories.bot_memories.get.mockResolvedValue(null);
    let committed = null;
    harness.store.commitMemoryVersion.mockImplementation(async (input) => {
      committed ||= {
        memory: memoryRow({
          id: input.memoryId,
          logical_key: input.logicalKey,
          active_version_id: input.versionId,
          encrypted_content: input.encryptedContent,
        }),
        version: versionRow({ id: input.versionId, encrypted_content: input.encryptedContent }),
        source: { id: input.sourceId },
        activated: true,
      };
      if (harness.store.commitMemoryVersion.mock.calls.length === 1) return committed;
      return { ...committed, source: { ...committed.source, _replayed: true } };
    });
    harness.indexer.upsert
      .mockRejectedValueOnce(Object.assign(new Error('index unavailable'), {
        code: 'bot_indexer_unavailable',
      }))
      .mockResolvedValue({ changed: true });

    await harness.runtime.enqueueCompletedRun(completedRun());
    await harness.runtime.waitForPendingExtractions();

    expect(extractCandidates).toHaveBeenCalledTimes(1);
    expect(harness.store.persistMemoryExtractionCandidates).toHaveBeenCalledTimes(1);
    expect(harness.store.commitMemoryVersion).toHaveBeenCalledTimes(2);
    const sourceIds = harness.store.commitMemoryVersion.mock.calls.map(([input]) => input.sourceId);
    expect(new Set(sourceIds).size).toBe(1);
    expect(harness.audit).toHaveBeenCalledTimes(1);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: 'success',
      metadata: expect.objectContaining({ recovered: true, idempotentCount: 1 }),
    }));
  });

  it('refetches and re-encrypts against the authoritative memory after an identity race', async () => {
    const logicalKey = 'deployment.region.identity-race';
    const authoritative = memoryRow({ logical_key: logicalKey });
    const harness = createHarness({
      extractCandidates: vi.fn(async () => ({
        candidates: [{
          statement: 'Deploy to eu-west-1.',
          logicalKey,
          scope: 'shared',
          subjectUserId: null,
          sensitivity: 'normal',
          confidence: 0.95,
          transcriptQuote: false,
          provenance: {
            channelId: CHANNEL_ID,
            runId: RUN_ID,
            messageIds: [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID],
          },
        }],
      })),
    });
    let logicalReadCount = 0;
    harness.repositories.bot_memories.get.mockImplementation(async (filters) => {
      if (filters.logical_key !== logicalKey) return null;
      logicalReadCount += 1;
      return logicalReadCount === 1 ? null : authoritative;
    });
    harness.store.commitMemoryVersion
      .mockRejectedValueOnce(Object.assign(new Error('identity changed'), { code: '40001' }))
      .mockImplementationOnce(async (input) => ({
        memory: authoritative,
        version: versionRow({ id: input.versionId, memory_id: authoritative.id }),
        source: { id: input.sourceId },
        activated: false,
      }));

    await harness.runtime.enqueueCompletedRun(completedRun());
    await harness.runtime.waitForPendingExtractions();

    expect(harness.store.commitMemoryVersion).toHaveBeenCalledTimes(2);
    const [initial, retried] = harness.store.commitMemoryVersion.mock.calls.map(([input]) => input);
    expect(initial.memoryId).not.toBe(authoritative.id);
    expect(retried).toMatchObject({
      memoryId: authoritative.id,
      expectedUpdatedAt: null,
      sourceId: initial.sourceId,
    });
    expect(decryptBotJson({
      key: Buffer.alloc(32, 7),
      envelope: retried.encryptedContent,
      expectedKeyId: 'deployment-v1',
      associatedData: memoryAssociatedData(authoritative.id),
    })).toEqual({ version: 1, text: 'Deploy to eu-west-1.' });
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: 'success',
      metadata: expect.objectContaining({ supersededCount: 1 }),
    }));
  });

  it('treats a Manager-won automatic activation race as successful supersession', async () => {
    const managerVersion = versionRow({ creator_kind: 'manager' });
    const harness = createHarness({
      extractCandidates: vi.fn(async () => ({
        candidates: [{
          statement: 'Deploy to eu-west-1.',
          logicalKey: 'deployment.region.manager-race',
          scope: 'shared',
          subjectUserId: null,
          sensitivity: 'normal',
          confidence: 0.95,
          transcriptQuote: false,
          provenance: {
            channelId: CHANNEL_ID,
            runId: RUN_ID,
            messageIds: [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID],
          },
        }],
      })),
      commitResult: {
        memory: memoryRow({ active_version_id: managerVersion.id }),
        version: versionRow({ id: 'a0000000-0000-4000-8000-000000000099' }),
        source: { id: 'a0000000-0000-4000-8000-000000000098' },
        activated: false,
      },
    });
    harness.repositories.bot_memories.get.mockResolvedValue(null);

    await harness.runtime.enqueueCompletedRun(completedRun());
    await harness.runtime.waitForPendingExtractions();

    expect(harness.indexer.upsert).not.toHaveBeenCalled();
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: 'success',
      metadata: expect.objectContaining({ supersededCount: 1, conflictCount: 0 }),
    }));
  });

  it('preserves a stale Manager edit as an inactive immutable version and reports a conflict', async () => {
    const memory = memoryRow();
    const conflictVersion = versionRow({ id: 'a0000000-0000-4000-8000-000000000010' });
    const harness = createHarness({
      commitResult: {
        memory,
        version: conflictVersion,
        source: { id: 'a0000000-0000-4000-8000-000000000011' },
        activated: false,
      },
    });

    const error = await harness.runtime.editMemory(
      { id: USER_ID },
      BOT_ID,
      MEMORY_ID,
      {
        text: 'Manager-edited deployment region.',
        sensitivity: 'normal',
        confidence: 0.95,
        expectedUpdatedAt: TIMESTAMP,
      },
    ).catch((caught) => caught);

    expect(error).toMatchObject({
      code: 'bot_memory_version_conflict',
      statusCode: 409,
      details: { preservedVersionId: conflictVersion.id },
    });
    expect(harness.store.commitMemoryVersion).toHaveBeenCalledWith(expect.objectContaining({
      creatorKind: 'manager',
      expectedUpdatedAt: TIMESTAMP,
    }));
    expect(harness.indexer.upsert).not.toHaveBeenCalled();
  });

  it('blocks ordinary members from listing even their own private memory', async () => {
    const harness = createHarness();
    harness.authorization.requireManager.mockRejectedValueOnce(Object.assign(
      new Error('Bot Manager access is required'),
      { code: 'bot_manager_required', statusCode: 403 },
    ));

    await expect(harness.runtime.listForManager({ id: USER_ID }, BOT_ID))
      .rejects.toMatchObject({ code: 'bot_manager_required', statusCode: 403 });
    expect(harness.repositories.bot_memories.list).not.toHaveBeenCalled();
  });

  it('retains every memory when a channel is deleted and drops only its summary', async () => {
    const harness = createHarness();
    const sharedMemory = memoryRow({
      id: 'a0000000-0000-4000-8000-000000000022',
      active_version_id: 'a0000000-0000-4000-8000-000000000023',
    });
    const channel = {
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: USER_ID,
      current_checkpoint_number: 4,
      summary_envelope: { test: true },
      archived_at: null,
    };
    harness.repositories.bot_channels.get.mockResolvedValue(channel);
    harness.repositories.bot_runs.list.mockResolvedValue(page([{ state: 'completed' }]));
    harness.repositories.bot_memories.get.mockResolvedValue(sharedMemory);
    harness.repositories.bot_objects.list.mockResolvedValue(page([{
      storage_bucket: 'devryan-bot-objects',
      storage_object_name: 'objects/private.bin',
    }]));

    const result = await harness.runtime.deleteChannel(
      { id: USER_ID },
      CHANNEL_ID,
      { sharedMemorySurvives: true },
    );

    expect(result.notice).toContain('survives channel deletion');
    expect(harness.indexer.delete).not.toHaveBeenCalledWith(expect.objectContaining({
      documentId: `memory:${sharedMemory.id}`,
    }));
    expect(harness.indexer.delete).toHaveBeenCalledWith({
      namespace: `channel:${CHANNEL_ID}`,
      documentId: `summary:${CHANNEL_ID}`,
      version: 'checkpoint-4',
    });
    expect(harness.store.storage.delete).toHaveBeenCalledWith(
      'devryan-bot-objects',
      ['objects/private.bin'],
    );
    expect(harness.store.deleteChannel).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      actorId: USER_ID,
    });
  });

  it('fully rebuilds the shared and channel-summary namespaces from source records', async () => {
    const libraryDocument = {
      namespace: `bot:${BOT_ID}`,
      documentId: 'library:version:object',
      version: 'library-version',
      text: 'Published Library text.',
      metadata: { kind: 'library' },
    };
    const harness = createHarness({
      loadAdditionalIndexDocuments: vi.fn(async () => [libraryDocument]),
    });
    // Converted private memories keep their subject in the logical key and
    // rebuild into the Bot's single namespace like everything else.
    const convertedMemory = memoryRow({
      id: 'a0000000-0000-4000-8000-000000000030',
      logical_key: `private.preference:u:${USER_ID}`,
      active_version_id: 'a0000000-0000-4000-8000-000000000031',
      test_text: 'Private preference.',
    });
    harness.repositories.bot_memories.list.mockResolvedValue(page([harness.memory, convertedMemory]));
    harness.repositories.bot_channels.list.mockResolvedValue(page([{
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: USER_ID,
      current_checkpoint_number: 2,
      summary_envelope: { test: true },
      archived_at: null,
    }]));
    harness.channels.decryptSummary.mockResolvedValue({
      version: 1,
      items: [{ text: 'Thread-only checkpoint.' }],
    });

    await expect(harness.runtime.rebuildIndex({ id: USER_ID }, BOT_ID)).resolves.toMatchObject({
      documentCount: 4,
      memoryCount: 2,
      channelSummaryCount: 1,
      additionalDocumentCount: 1,
    });
    expect(harness.indexer.rebuild).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        namespace: `bot:${BOT_ID}`,
        documentId: `memory:${convertedMemory.id}`,
      }),
      expect.objectContaining({ namespace: `channel:${CHANNEL_ID}` }),
      libraryDocument,
    ]));
    // A rebuild is what clears the legacy per-user namespaces.
    expect(harness.indexer.rebuild.mock.calls[0][0]).not.toContainEqual(
      expect.objectContaining({ namespace: `bot:${BOT_ID}:user:${USER_ID}` }),
    );
  });

  it('rebuilds canonical Memory and Library documents when startup finds a fresh index', async () => {
    const libraryDocument = {
      namespace: `bot:${BOT_ID}`,
      documentId: 'library:startup-version:object',
      version: 'library-startup-version',
      text: 'Startup Library text.',
      metadata: { kind: 'library' },
    };
    const harness = createHarness({
      loadAdditionalIndexDocuments: vi.fn(async () => [libraryDocument]),
    });
    harness.indexer.status.mockResolvedValue({ state: 'rebuild_required' });

    await expect(harness.runtime.start()).resolves.toEqual({
      indexState: 'ready',
      rebuilt: true,
      documentCount: 2,
    });
    expect(harness.indexer.rebuild).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ namespace: `bot:${BOT_ID}` }),
      libraryDocument,
    ]));

    await harness.runtime.shutdown();
  });

  it('does not rebuild an index that is already ready', async () => {
    const harness = createHarness();

    await expect(harness.runtime.start()).resolves.toEqual({
      indexState: 'ready',
      rebuilt: false,
    });
    expect(harness.indexer.rebuild).not.toHaveBeenCalled();

    await harness.runtime.shutdown();
  });

  it('fails startup when index status cannot be read instead of deferring failure to prompts', async () => {
    const harness = createHarness();
    harness.indexer.status.mockRejectedValue(Object.assign(
      new Error('index offline'),
      { code: 'bot_runtime_indexer_unavailable' },
    ));

    await expect(harness.runtime.start())
      .rejects.toMatchObject({ code: 'bot_runtime_indexer_unavailable' });
    expect(harness.indexer.rebuild).not.toHaveBeenCalled();

    await harness.runtime.shutdown();
  });
});
