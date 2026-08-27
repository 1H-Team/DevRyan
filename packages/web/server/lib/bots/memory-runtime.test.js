import { describe, expect, it, vi } from 'vitest';

import { createBotMemoryRuntime } from './memory-runtime.js';

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const REVISION_ID = '55555555-5555-4555-8555-555555555555';
const USER_MESSAGE_ID = '66666666-6666-4666-8666-666666666666';
const ASSISTANT_MESSAGE_ID = '77777777-7777-4777-8777-777777777777';
const MEMORY_ID = '88888888-8888-4888-8888-888888888888';
const VERSION_ID = '99999999-9999-4999-8999-999999999999';
const TIMESTAMP = '2026-08-23T12:00:00.000Z';

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
    bot_channels: {
      get: vi.fn(async () => null),
      list: vi.fn(async () => page()),
      updateIfRevision: vi.fn(),
    },
    bot_runs: { get: vi.fn(), list: vi.fn(async () => page()) },
    bot_objects: { get: vi.fn(), list: vi.fn(async () => page()) },
  };
  const store = {
    repositories,
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
  });
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
      metadata: { code: 'bot_model_unavailable' },
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
