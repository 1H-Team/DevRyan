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
    expect(result.parts[1].text).toContain('without first sending an acknowledgment or preamble');
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
});
