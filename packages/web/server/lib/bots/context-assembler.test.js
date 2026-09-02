import { describe, expect, it, vi } from 'vitest';

import {
  BOT_COMPUTER_CONNECTOR_INSTRUCTION,
  BOT_CONVERSATIONAL_RESPONSE_INSTRUCTION,
  createBotContextAssembler,
  decideBotSegment,
} from './context-assembler.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000001';

describe('Production Bot context assembly', () => {
  it('starts a new agent execution at every required continuation boundary', () => {
    expect(decideBotSegment({ revisionId: REVISION_ID, previousRun: null }))
      .toMatchObject({ create: true, reason: 'first_run' });
    expect(decideBotSegment({
      revisionId: REVISION_ID,
      previousRun: {
        state: 'completed',
        revision_id: 'e0000000-0000-4000-8000-000000000001',
      },
    })).toMatchObject({ create: true, reason: 'revision_changed' });
    expect(decideBotSegment({
      revisionId: REVISION_ID,
      previousRun: {
        state: 'completed',
        revision_id: REVISION_ID,
        opencode_segment_id: 'segment-1',
        opencode_session_id: 'session-1',
        context_snapshot: { providerContextRatio: 0.6, completedUserTurns: 2 },
      },
    })).toMatchObject({ create: true, reason: 'context_threshold' });
    expect(decideBotSegment({
      revisionId: REVISION_ID,
      previousRun: {
        state: 'completed',
        revision_id: REVISION_ID,
        opencode_segment_id: 'segment-1',
        opencode_session_id: 'session-1',
        context_snapshot: { providerContextRatio: 0.2, completedUserTurns: 40 },
      },
    })).toMatchObject({ create: true, reason: 'turn_limit' });
    expect(decideBotSegment({
      revisionId: REVISION_ID,
      previousRun: {
        state: 'completed',
        revision_id: REVISION_ID,
        opencode_segment_id: 'segment-1',
        opencode_session_id: 'session-1',
        context_snapshot: { providerContextRatio: 0.2, completedUserTurns: 12 },
      },
    })).toEqual({
      create: false,
      reason: 'continue',
      adapter: 'opencode',
      execution: {
        version: 1,
        adapter: 'opencode',
        threadId: 'session-1',
        segmentId: 'segment-1',
        checkpointVersion: 1,
      },
      completedUserTurns: 12,
    });
    expect(decideBotSegment({
      revisionId: REVISION_ID,
      previousRun: {
        state: 'failed',
        revision_id: REVISION_ID,
        opencode_segment_id: 'poisoned-segment',
        opencode_session_id: 'poisoned-session',
      },
    })).toEqual({ create: true, reason: 'previous_run_failed', completedUserTurns: 0 });
  });

  it('rotates the follow-up after an attachment failure instead of reusing the older completed session', () => {
    const completed = {
      state: 'completed',
      revision_id: REVISION_ID,
      opencode_segment_id: 'completed-segment',
      opencode_session_id: 'completed-session',
      context_snapshot: { providerContextRatio: 0.1, completedUserTurns: 2 },
    };
    expect(decideBotSegment({ revisionId: REVISION_ID, previousRun: completed }))
      .toMatchObject({
        create: false,
        adapter: 'opencode',
        execution: { threadId: 'completed-session' },
      });

    const failedAttachmentRun = {
      ...completed,
      state: 'failed',
      opencode_segment_id: 'failed-segment',
      opencode_session_id: 'failed-session',
      interruption_kind: 'bot_opencode_api_retryable',
    };
    expect(decideBotSegment({ revisionId: REVISION_ID, previousRun: failedAttachmentRun }))
      .toEqual({ create: true, reason: 'previous_run_failed', completedUserTurns: 0 });
  });

  it('combines the checkpoint, bounded messages, the shared memory, and authorized Library chunks', async () => {
    const previousRun = {
      id: 'e0000000-0000-4000-8000-000000000001',
      state: 'completed',
      revision_id: REVISION_ID,
      opencode_segment_id: 'segment-1',
      opencode_session_id: 'session-1',
      context_snapshot: { providerContextRatio: 0.2, completedUserTurns: 3 },
    };
    const store = {
      getPreviousChannelRun: vi.fn(async () => previousRun),
      repositories: {
        bot_runs: {},
        bot_memories: { list: vi.fn(async () => ({
          items: [
            {
              id: 'memory-1',
              logical_key: 'deployment.cadence',
              encrypted_content: { opaque: true },
              tombstoned_at: null,
            },
            {
              id: 'memory-2',
              logical_key: 'owner.preference',
              encrypted_content: { opaque: true },
              tombstoned_at: null,
            },
          ],
        })) },
      },
    };
    const channels = {
      loadRecentMessages: vi.fn(async () => [
        { id: 'message-1', role: 'assistant', sequence: 7, body: { text: 'Earlier answer' } },
        {
          id: 'message-ack',
          role: 'assistant',
          assistantPhase: 'acknowledgment',
          sequence: 6,
          body: { text: 'I’ll inspect the deployment checks first.' },
        },
      ]),
      decryptMemory: vi.fn(async (memory) => ({ text: `${memory.logical_key} memory` })),
    };
    const retrieval = {
      search: vi.fn(async () => [{
        sourceId: 'source-1',
        libraryVersionId: 'f0000000-0000-4000-8000-000000000002',
        text: 'Reviewed Library fact',
      }]),
    };
    const capabilities = {
      runtimeCatalog: vi.fn(async () => ({
        mcpServers: [],
        invocation: null,
      })),
    };
    const assembler = createBotContextAssembler({ store, channels, retrieval, capabilities });

    const result = await assembler.assemble({
      run: {
        id: 'f0000000-0000-4000-8000-000000000001',
        channel_id: CHANNEL_ID,
        queue_sequence: 8,
        context_snapshot: {
          libraryVersionIds: ['f0000000-0000-4000-8000-000000000002'],
        },
      },
      bot: { id: BOT_ID },
      channel: {
        id: CHANNEL_ID,
        owner_user_id: OWNER_ID,
        current_checkpoint_number: 2,
        summary: { text: 'Bounded checkpoint' },
      },
      revision: {
        id: REVISION_ID,
        contract: {
          libraryVersionIds: ['f0000000-0000-4000-8000-000000000004'],
        },
      },
      queryText: 'What changed?',
      currentMessageId: 'f0000000-0000-4000-8000-000000000003',
      currentMessageSequence: 8,
    });

    expect(result.continuation).toMatchObject({
      create: false,
      adapter: 'opencode',
      execution: { threadId: 'session-1' },
    });
    expect(result.parts).toHaveLength(4);
    expect(result.parts[0].text).toContain('Bounded checkpoint');
    expect(result.parts[0].text).toContain('Earlier answer');
    expect(result.parts[0].text).not.toContain('inspect the deployment checks');
    expect(result.parts[0].text).toContain('deployment.cadence memory');
    expect(result.parts[0].text).toContain('owner.preference memory');
    expect(result.parts[0].text).toContain('Reviewed Library fact');
    expect(result.parts[0].text).not.toContain('connector:mcp');
    expect(result.parts[0].text).not.toContain('read-item');
    expect(result.parts[1]).toEqual({
      type: 'text',
      synthetic: true,
      text: BOT_CONVERSATIONAL_RESPONSE_INSTRUCTION,
    });
    expect(result.parts[1].text).toContain('natural conversation');
    expect(result.parts[1].text).toContain('Do not use progress or status headings');
    expect(result.parts[1].text).toContain("configured personality");
    expect(result.parts[1].text).toContain('exactly one short line in your own voice');
    expect(result.parts[1].text).toContain('interface shows that you are working');
    expect(result.parts[1].text).toContain('devryan_ask');
    expect(result.parts[0].text).toContain('"turn":');
    expect(result.parts[0].text).toContain('"timeZone":');
    expect(result.contextSnapshot).not.toHaveProperty('turn');
    expect(result.parts[1].text).toContain('needs no tool, reply directly');
    expect(result.parts[1].text).toContain('Do not narrate progress between tools');
    expect(result.parts[1].text).toContain('send one useful, natural response');
    expect(result.parts[1].text).toContain('explain it honestly');
    expect(result.parts[2]).toEqual({
      type: 'text',
      synthetic: true,
      text: BOT_COMPUTER_CONNECTOR_INSTRUCTION,
    });
    expect(result.parts[2].text).toContain('persistent browser connector');
    expect(result.parts[2].text).toContain('operation "computer.command"');
    expect(result.parts[2].text).toContain('Do not claim that a browser connector is missing');
    expect(result.parts[3]).toEqual({ type: 'text', text: 'What changed?' });
    expect(result.contextSnapshot).not.toHaveProperty('responseStyle');
    expect(result.contextSnapshot).toMatchObject({
      version: 1,
      revisionId: REVISION_ID,
      checkpointNumber: 2,
      libraryVersionIds: ['f0000000-0000-4000-8000-000000000002'],
      completedUserTurns: 3,
    });
    expect(channels.loadRecentMessages).toHaveBeenCalledWith(expect.objectContaining({
      throughSequence: 8,
    }));
    expect(retrieval.search).toHaveBeenCalledWith(expect.objectContaining({
      libraryVersionIds: ['f0000000-0000-4000-8000-000000000002'],
    }));
    expect(capabilities.runtimeCatalog).toHaveBeenCalledWith({ revisionId: REVISION_ID });
    expect(store.getPreviousChannelRun).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      beforeQueueSequence: 8,
    });
  });
  it('reuses decryption only for the exact live memory version and never restores tombstoned rows', async () => {
    let memory = { id: 'memory-a', bot_id: BOT_ID, active_version_id: 'version-1', updated_at: '2026-08-31T00:00:00Z', logical_key: 'preference', encrypted_content: {} };
    const channels = { loadRecentMessages: vi.fn(async () => []), decryptMemory: vi.fn(async (row) => ({ text: row.active_version_id })) };
    const store = { getPreviousChannelRun: vi.fn(async () => null), repositories: { bot_runs: {}, bot_memories: { list: vi.fn(async () => ({ items: memory ? [memory] : [] })) } } };
    const assembler = createBotContextAssembler({ store, channels });
    const input = { run: { channel_id: CHANNEL_ID }, bot: { id: BOT_ID }, channel: { id: CHANNEL_ID, summary: null }, revision: { id: REVISION_ID, contract: {} }, queryText: 'Hello' };
    await assembler.assemble(input);
    await assembler.assemble(input);
    expect(channels.decryptMemory).toHaveBeenCalledTimes(1);
    memory = { ...memory, active_version_id: 'version-2', updated_at: '2026-08-31T00:01:00Z' };
    expect((await assembler.assemble(input)).parts[0].text).toContain('version-2');
    expect(channels.decryptMemory).toHaveBeenCalledTimes(2);
    memory = null;
    expect((await assembler.assemble(input)).parts[0].text).not.toContain('version-2');
  });

  const memoryRow = (id, logicalKey, extra = {}) => ({
    id, bot_id: BOT_ID, logical_key: logicalKey, active_version_id: `${id}-v1`,
    updated_at: '2026-09-01T00:00:00Z', encrypted_content: {}, tombstoned_at: null, ...extra,
  });
  const retrievalHarness = ({ rows, hits, older = {} }) => {
    const store = {
      getPreviousChannelRun: vi.fn(async () => null),
      repositories: {
        bot_runs: {},
        bot_memories: {
          list: vi.fn(async () => ({ items: rows, nextCursor: null })),
          get: vi.fn(async ({ id }) => older[id] || null),
        },
      },
    };
    const channels = {
      loadRecentMessages: vi.fn(async () => [
        { id: 'u1', role: 'user', sequence: 1, body: { text: 'Oldest question' } },
        { id: 'a1', role: 'assistant', sequence: 2, body: { text: 'Earlier answer' } },
        { id: 'u2', role: 'user', sequence: 3, body: { text: 'Which plan did we pick?' } },
        { id: 'a2', role: 'assistant', sequence: 4, body: { text: 'The annual one' } },
        { id: 'u3', role: 'user', sequence: 5, body: { text: 'And the price?' } },
      ]),
      decryptMemory: vi.fn(async (row) => ({ text: `${row.logical_key} memory` })),
    };
    const memoryRetrieval = { search: vi.fn(hits) };
    const input = {
      run: { channel_id: CHANNEL_ID }, bot: { id: BOT_ID },
      channel: { id: CHANNEL_ID, summary: null }, revision: { id: REVISION_ID, contract: {} },
      queryText: 'What changed?',
    };
    return { store, channels, memoryRetrieval, input };
  };

  it('pins durable people-facts, then fills one budget by relevance and recency', async () => {
    const rows = [
      memoryRow('m1', 'project.deploy_day'),
      memoryRow('m2', 'user.name'),
      memoryRow('m3', 'topic.pricing'),
      memoryRow('m4', 'preference.tone'),
      memoryRow('m5', 'project.stack'),
    ];
    const { store, channels, memoryRetrieval, input } = retrievalHarness({
      rows,
      hits: async () => [
        { memoryId: 'm5', score: 0.9 },
        { memoryId: 'm2', score: 0.8 },
        { memoryId: 'm-old', score: 0.5 },
        { memoryId: 'm-gone', score: 0.4 },
        { memoryId: 'm-tombstoned', score: 0.3 },
      ],
      older: {
        'm-old': memoryRow('m-old', 'project.launch'),
        'm-tombstoned': memoryRow('m-tombstoned', 'project.retired', { tombstoned_at: '2026-08-01T00:00:00Z' }),
      },
    });
    const assembler = createBotContextAssembler({
      store, channels, memoryRetrieval, memoryRetrievalLimit: 3,
    });
    const result = await assembler.assemble(input);
    expect(memoryRetrieval.search).toHaveBeenCalledWith({
      botId: BOT_ID,
      query: 'What changed?\nWhich plan did we pick?\nAnd the price?',
      limit: 11,
    });
    expect(store.repositories.bot_memories.list).toHaveBeenCalledWith({
      filters: { bot_id: BOT_ID, tombstoned_at: null },
      limit: 100,
    });
    expect(store.repositories.bot_memories.get).toHaveBeenCalledWith({ id: 'm-old', bot_id: BOT_ID });
    expect(result.contextSnapshot.memoryIds).toEqual(['m2', 'm4', 'm5', 'm-old', 'm1']);
    expect(result.contextSnapshot.memoryRetrieval).toEqual({
      mode: 'relevance', pinned: 2, relevant: 2, recent: 1, candidates: 5,
    });
    expect(result.parts[0].text).toContain('user.name memory');
    expect(result.parts[0].text).toContain('project.launch memory');
    expect(result.parts[0].text).not.toContain('topic.pricing memory');
    expect(result.parts[0].text).not.toContain('project.retired');
    const snapshotJson = JSON.stringify(result.contextSnapshot);
    expect(snapshotJson).not.toContain('user.name memory');
    expect(snapshotJson).not.toContain('project.launch memory');
  });

  it('falls back to the newest facts when relevance retrieval is unavailable or empty', async () => {
    const rows = [memoryRow('m1', 'project.deploy_day'), memoryRow('m2', 'user.name')];
    const failing = retrievalHarness({ rows, hits: async () => { throw new Error('index down'); } });
    let result = await createBotContextAssembler({
      store: failing.store, channels: failing.channels, memoryRetrieval: failing.memoryRetrieval,
    }).assemble(failing.input);
    expect(result.contextSnapshot.memoryIds).toEqual(['m1', 'm2']);
    expect(result.contextSnapshot.memoryRetrieval).toEqual({
      mode: 'recent', pinned: 0, relevant: 0, recent: 2, candidates: 2,
    });

    const unavailable = retrievalHarness({ rows, hits: async () => null });
    result = await createBotContextAssembler({
      store: unavailable.store, channels: unavailable.channels, memoryRetrieval: unavailable.memoryRetrieval,
    }).assemble(unavailable.input);
    expect(result.contextSnapshot.memoryRetrieval.mode).toBe('recent');

    const blank = retrievalHarness({ rows, hits: async () => [] });
    blank.channels.loadRecentMessages.mockResolvedValue([]);
    result = await createBotContextAssembler({
      store: blank.store, channels: blank.channels, memoryRetrieval: blank.memoryRetrieval,
    }).assemble({ ...blank.input, queryText: '   ' });
    expect(blank.memoryRetrieval.search).not.toHaveBeenCalled();
    expect(result.contextSnapshot.memoryRetrieval.mode).toBe('recent');

    const noIndex = retrievalHarness({ rows, hits: async () => [] });
    result = await createBotContextAssembler({ store: noIndex.store, channels: noIndex.channels })
      .assemble(noIndex.input);
    expect(noIndex.store.repositories.bot_memories.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(result.contextSnapshot.memoryRetrieval.mode).toBe('recent');
  });

  it('bounds the memory block by bytes while keeping pinned facts first', async () => {
    const rows = [memoryRow('m1', 'project.notes'), memoryRow('m2', 'user.name'), memoryRow('m3', 'project.more')];
    const { store, channels, memoryRetrieval, input } = retrievalHarness({
      rows, hits: async () => [{ memoryId: 'm1' }, { memoryId: 'm3' }],
    });
    channels.decryptMemory.mockImplementation(async (row) => ({
      text: row.logical_key === 'user.name' ? 'Zoubair' : 'x'.repeat(60 * 1024),
    }));
    const result = await createBotContextAssembler({ store, channels, memoryRetrieval }).assemble(input);
    expect(result.contextSnapshot.memoryIds).toEqual(['m2', 'm1']);
    expect(result.contextSnapshot.memoryRetrieval).toEqual({
      mode: 'relevance', pinned: 1, relevant: 1, recent: 0, candidates: 3,
    });
  });

  it('rejects a memory retrieval boundary without a search function', () => {
    expect(() => createBotContextAssembler({
      store: { getPreviousChannelRun: async () => null, repositories: { bot_runs: {}, bot_memories: {} } },
      channels: { loadRecentMessages: async () => [], decryptMemory: async () => ({ text: '' }) },
      memoryRetrieval: {},
    })).toThrow('misconfigured');
  });
});
