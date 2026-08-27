import { describe, expect, it, vi } from 'vitest';

import { decryptBotJson, encryptBotJson } from './encryption.js';
import { createBotChannels, messageAssociatedData } from './channels.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const MESSAGE_ID = 'd0000000-0000-4000-8000-000000000001';
const EMPTY_MESSAGE_ID = 'd0000000-0000-4000-8000-000000000002';
const RUN_ID = 'e0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'f0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const ATTACHMENT_ID = '90000000-0000-4000-8000-000000000001';
const KEY = Buffer.alloc(32, 7);
const NOW = '2026-08-23T10:00:00.000Z';

const channel = () => ({
  id: CHANNEL_ID,
  bot_id: BOT_ID,
  owner_user_id: USER_ID,
  lifecycle: 'active',
  current_checkpoint_number: 0,
  next_message_sequence: 1,
  summary_envelope: null,
  last_message_at: null,
  created_at: NOW,
  updated_at: NOW,
  archived_at: null,
});

const bot = (overrides = {}) => ({
  id: BOT_ID,
  lifecycle: 'active',
  tenancy: 'team',
  active_revision_id: REVISION_ID,
  ...overrides,
});

const createHarness = ({ existingChannel = channel() } = {}) => {
  const repository = {
    get: vi.fn(async () => existingChannel),
    insert: vi.fn(async (input) => ({ ...channel(), ...input })),
  };
  const messageRepository = {
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    insert: vi.fn(async (input) => ({ ...input, created_at: NOW })),
  };
  const store = {
    get: vi.fn(async (table) => (table === 'bot_channels' ? existingChannel : null)),
    allocateMessageSequence: vi.fn(async () => 2),
    updateMessageCheckpoint: vi.fn(async (input) => input),
    enqueueMessageRun: vi.fn(async (input) => ({
      created: true,
      message: {
        id: input.messageId,
        channel_id: input.channelId,
        run_id: input.runId,
        actor_user_id: input.actorUserId,
        role: 'user',
        sequence: 1,
        body_envelope: input.bodyEnvelope,
        attachment_count: input.attachmentCount,
        created_at: NOW,
        finalized_at: NOW,
      },
      run: {
        id: input.runId,
        bot_id: input.botId,
        channel_id: input.channelId,
        revision_id: input.revisionId,
        state: 'queued',
        computer_scope_key: input.computerScopeKey,
      },
    })),
    repositories: {
      bot_channels: repository,
      bot_messages: messageRepository,
      bot_objects: {
        get: vi.fn(async ({ id }) => id === ATTACHMENT_ID ? {
          id,
          bot_id: BOT_ID,
          channel_id: CHANNEL_ID,
          visibility: 'private',
          deleted_at: null,
        } : null),
      },
    },
  };
  const authorization = {
    requireActiveMembership: vi.fn(async () => ({ bot: bot(), membership: { role: 'member' } })),
    requireChannelRead: vi.fn(async () => ({ bot: bot(), channel: existingChannel })),
    requireChannelSend: vi.fn(async () => ({ bot: bot(), channel: existingChannel })),
  };
  const channels = createBotChannels({
    store,
    authorization,
    encryption: { getKey: vi.fn(async () => Buffer.from(KEY)) },
    uuid: () => CHANNEL_ID,
    now: () => new Date(NOW),
  });
  return { channels, store, repository, messageRepository, authorization };
};

describe('Production Bot continuous channels', () => {
  it('returns the same active owner channel without creating a duplicate', async () => {
    const harness = createHarness();
    const result = await harness.channels.getOrCreateOwnerChannel({
      principal: { id: USER_ID },
      botId: BOT_ID,
    });

    expect(result).toMatchObject({ id: CHANNEL_ID, botId: BOT_ID, ownerUserId: USER_ID });
    expect(harness.repository.insert).not.toHaveBeenCalled();
  });

  it('recovers an insert race by reading the winner of the active-owner constraint', async () => {
    const harness = createHarness({ existingChannel: null });
    harness.repository.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(channel());
    harness.repository.insert.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

    await expect(harness.channels.getOrCreateOwnerChannel({
      principal: { id: USER_ID },
      botId: BOT_ID,
    })).resolves.toMatchObject({ id: CHANNEL_ID });
    expect(harness.repository.insert).toHaveBeenCalledTimes(1);
  });

  it('uses the channel ACL decision for reads and sends', async () => {
    const harness = createHarness();
    await harness.channels.listMessages({ principal: { id: USER_ID }, channelId: CHANNEL_ID });
    await harness.channels.preflightMessage({ principal: { id: USER_ID }, channelId: CHANNEL_ID });

    expect(harness.authorization.requireChannelRead).toHaveBeenCalledWith(
      { id: USER_ID }, BOT_ID, CHANNEL_ID, null,
    );
    expect(harness.authorization.requireChannelSend).toHaveBeenCalledWith(
      { id: USER_ID }, BOT_ID, CHANNEL_ID,
    );
  });

  it('sanitizes previously persisted assistant narration when loading history', async () => {
    const harness = createHarness();
    const envelope = encryptBotJson({
      key: KEY,
      keyId: 'deployment-v1',
      value: {
        version: 1,
        text: '**Crafting warm pricing prompt**Hey! The pricing page is ready.',
        attachmentIds: [],
      },
      associatedData: messageAssociatedData(CHANNEL_ID, MESSAGE_ID),
    });
    harness.messageRepository.list.mockResolvedValueOnce({
      items: [{
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
        run_id: RUN_ID,
        actor_user_id: null,
        role: 'assistant',
        assistant_phase: 'result',
        sequence: 2,
        body_envelope: envelope,
        attachment_count: 0,
        created_at: NOW,
        finalized_at: NOW,
      }],
      nextCursor: null,
    });

    const page = await harness.channels.listMessages({
      principal: { id: USER_ID },
      channelId: CHANNEL_ID,
    });

    expect(page.messages[0].body.text).toBe('Hey! The pricing page is ready.');
  });

  it('encrypts the client-stable message and delegates one atomic message/run write', async () => {
    const harness = createHarness();
    const result = await harness.channels.enqueueUserMessage({
      principal: { id: USER_ID },
      preflight: { bot: bot(), channel: channel() },
      messageId: MESSAGE_ID,
      runId: RUN_ID,
      revisionId: REVISION_ID,
      idempotencyKey: 'client-message-1',
      text: 'Keep this private',
      attachmentIds: [],
      computerScopeKey: `bot:${BOT_ID}`,
      modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      contextSnapshot: { version: 1, state: 'queued' },
    });

    expect(result.created).toBe(true);
    expect(harness.store.enqueueMessageRun).toHaveBeenCalledTimes(1);
    const input = harness.store.enqueueMessageRun.mock.calls[0][0];
    expect(JSON.stringify(input.bodyEnvelope)).not.toContain('Keep this private');
    expect(decryptBotJson({
      key: KEY,
      envelope: input.bodyEnvelope,
      expectedKeyId: 'deployment-v1',
      associatedData: messageAssociatedData(CHANNEL_ID, MESSAGE_ID),
    })).toEqual({ version: 1, text: 'Keep this private', attachmentIds: [] });
  });

  it('returns persisted plaintext on an idempotent retry instead of echoing changed caller text', async () => {
    const harness = createHarness();
    const persistedEnvelope = encryptBotJson({
      key: KEY,
      keyId: 'deployment-v1',
      value: { version: 1, text: 'Original request', attachmentIds: [] },
      associatedData: messageAssociatedData(CHANNEL_ID, MESSAGE_ID),
    });
    harness.store.enqueueMessageRun.mockResolvedValueOnce({
      created: false,
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
        run_id: RUN_ID,
        actor_user_id: USER_ID,
        role: 'user',
        sequence: 1,
        body_envelope: persistedEnvelope,
        attachment_count: 0,
        created_at: NOW,
        finalized_at: NOW,
      },
      run: {
        id: RUN_ID,
        bot_id: BOT_ID,
        channel_id: CHANNEL_ID,
        revision_id: REVISION_ID,
        state: 'queued',
        computer_scope_key: `bot:${BOT_ID}`,
      },
    });

    const retried = await harness.channels.enqueueUserMessage({
      principal: { id: USER_ID },
      preflight: { bot: bot(), channel: channel() },
      messageId: MESSAGE_ID,
      runId: RUN_ID,
      revisionId: REVISION_ID,
      idempotencyKey: 'client-message-1',
      text: 'Changed retry payload',
      attachmentIds: [],
      computerScopeKey: `bot:${BOT_ID}`,
      modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      contextSnapshot: { version: 1, state: 'queued' },
    });

    expect(retried.created).toBe(false);
    expect(retried.message.body.text).toBe('Original request');
  });

  it('accepts an attachment-only message and still rejects an entirely empty message', async () => {
    const harness = createHarness();
    await expect(harness.channels.enqueueUserMessage({
      principal: { id: USER_ID },
      preflight: { bot: bot(), channel: channel() },
      messageId: MESSAGE_ID,
      runId: RUN_ID,
      revisionId: REVISION_ID,
      idempotencyKey: 'attachment-only',
      text: '',
      attachmentIds: [ATTACHMENT_ID],
      computerScopeKey: `bot:${BOT_ID}`,
      modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      contextSnapshot: { version: 1, state: 'queued' },
    })).resolves.toMatchObject({ created: true });

    await expect(harness.channels.enqueueUserMessage({
      principal: { id: USER_ID },
      preflight: { bot: bot(), channel: channel() },
      messageId: MESSAGE_ID,
      runId: RUN_ID,
      revisionId: REVISION_ID,
      idempotencyKey: 'empty',
      text: '   ',
      attachmentIds: [],
      computerScopeKey: `bot:${BOT_ID}`,
      modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      contextSnapshot: { version: 1, state: 'queued' },
    })).rejects.toMatchObject({ code: 'bot_message_invalid' });
  });

  it('requires expired retry attachments to be reattached before admission', async () => {
    const harness = createHarness();
    harness.store.repositories.bot_objects.get.mockResolvedValueOnce({
      id: ATTACHMENT_ID,
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      visibility: 'private',
      deleted_at: null,
      expires_at: '2026-08-23T09:59:59.000Z',
    });

    await expect(harness.channels.enqueueUserMessage({
      principal: { id: USER_ID },
      preflight: { bot: bot(), channel: channel() },
      messageId: MESSAGE_ID,
      runId: RUN_ID,
      revisionId: REVISION_ID,
      idempotencyKey: 'expired-retry',
      text: 'Retry this attachment',
      attachmentIds: [ATTACHMENT_ID],
      computerScopeKey: `bot:${BOT_ID}`,
      modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      contextSnapshot: { version: 1, state: 'queued', attachmentDeliveryMode: 'compatibility' },
    })).rejects.toMatchObject({ code: 'bot_object_expired', statusCode: 410 });
    expect(harness.store.enqueueMessageRun).not.toHaveBeenCalled();
  });

  it('fails lifecycle preflight before encryption or persistence', async () => {
    const harness = createHarness();
    harness.authorization.requireChannelSend.mockResolvedValueOnce({
      bot: bot({ lifecycle: 'paused' }),
      channel: channel(),
    });

    await expect(harness.channels.preflightMessage({
      principal: { id: USER_ID },
      channelId: CHANNEL_ID,
    })).rejects.toMatchObject({ code: 'bot_paused', statusCode: 409 });
    expect(harness.store.enqueueMessageRun).not.toHaveBeenCalled();
  });

  it('reuses the one assistant checkpoint already persisted for a recovered run', async () => {
    const harness = createHarness();
    const assistant = {
      id: MESSAGE_ID,
      channel_id: CHANNEL_ID,
      run_id: RUN_ID,
      actor_user_id: null,
      role: 'assistant',
      assistant_phase: 'pending',
      sequence: 2,
      body_envelope: { ciphertext: 'sealed' },
      attachment_count: 0,
      created_at: NOW,
      finalized_at: null,
    };
    harness.messageRepository.get.mockResolvedValueOnce(assistant);

    await expect(harness.channels.getOrCreateAssistantCheckpoint({
      run: { id: RUN_ID, channel_id: CHANNEL_ID },
      messageId: MESSAGE_ID,
      assistantPhase: 'pending',
    })).resolves.toBe(assistant);

    expect(harness.store.allocateMessageSequence).not.toHaveBeenCalled();
    expect(harness.messageRepository.insert).not.toHaveBeenCalled();
  });

  it('creates distinct pending and result checkpoints for one run', async () => {
    const harness = createHarness();
    await harness.channels.getOrCreateAssistantCheckpoint({
      run: { id: RUN_ID, channel_id: CHANNEL_ID },
      messageId: MESSAGE_ID,
      assistantPhase: 'pending',
    });
    await harness.channels.getOrCreateAssistantCheckpoint({
      run: { id: RUN_ID, channel_id: CHANNEL_ID },
      messageId: EMPTY_MESSAGE_ID,
      assistantPhase: 'result',
    });

    expect(harness.messageRepository.insert.mock.calls.map(([message]) => (
      message.assistant_phase
    ))).toEqual(['pending', 'result']);
  });

  it('projects an authorized catalog and run snapshot without contracts or OpenCode segment IDs', async () => {
    const previewText = `Latest answer\n\n   ${'x'.repeat(700)}`;
    const normalizedPreviewText = previewText.replace(/\s+/gu, ' ').trim().slice(0, 512);
    const membershipRow = {
      bot_id: BOT_ID,
      user_id: USER_ID,
      role: 'operator',
      activated_at: NOW,
      revoked_at: null,
      updated_at: NOW,
    };
    const botRow = {
      id: BOT_ID,
      name: 'Release helper',
      title: 'Release Operations',
      summary: 'Coordinates reviewed releases.',
      avatar_object_id: null,
      avatar_fallback: 'RO',
      lifecycle: 'active',
      tenancy: 'team',
      active_revision_id: REVISION_ID,
      created_at: NOW,
      updated_at: NOW,
      retired_at: null,
    };
    const revisionRow = {
      id: REVISION_ID,
      bot_id: BOT_ID,
      revision_number: 1,
      contract: { advancedPrompt: 'server-only' },
      compiled_hash: 'sha256:revision',
      created_at: NOW,
      activated_at: NOW,
      retired_at: null,
    };
    const runRow = {
      id: RUN_ID,
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      revision_id: REVISION_ID,
      model_snapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      computer_scope_key: `bot:${BOT_ID}`,
      queue_sequence: 1,
      state: 'running',
      opencode_segment_id: 'f0000000-0000-4000-8000-000000000099',
      opencode_session_id: 'ses_private_runtime',
      created_at: NOW,
      updated_at: NOW,
      started_at: NOW,
      finished_at: null,
    };
    const store = {
      get: vi.fn(async () => null),
      repositories: {
        bot_channels: {
          get: vi.fn(async () => channel()),
          list: vi.fn(async () => ({ items: [channel()], nextCursor: null })),
        },
        bot_messages: {
          get: vi.fn(async () => null),
          list: vi.fn(async () => ({
            items: [{
              id: EMPTY_MESSAGE_ID,
              channel_id: CHANNEL_ID,
              run_id: RUN_ID,
              actor_user_id: null,
              role: 'assistant',
              sequence: 3,
              body_envelope: encryptBotJson({
                key: KEY,
                keyId: 'deployment-v1',
                value: { version: 1, text: '   ', attachmentIds: [] },
                associatedData: messageAssociatedData(CHANNEL_ID, EMPTY_MESSAGE_ID),
              }),
              attachment_count: 0,
              created_at: '2026-08-23T10:00:01.000Z',
              finalized_at: '2026-08-23T10:00:01.000Z',
            }, {
              id: MESSAGE_ID,
              channel_id: CHANNEL_ID,
              run_id: RUN_ID,
              actor_user_id: null,
              role: 'assistant',
              sequence: 2,
              body_envelope: encryptBotJson({
                key: KEY,
                keyId: 'deployment-v1',
                value: { version: 1, text: previewText, attachmentIds: [] },
                associatedData: messageAssociatedData(CHANNEL_ID, MESSAGE_ID),
              }),
              attachment_count: 0,
              created_at: NOW,
              finalized_at: NOW,
            }],
            nextCursor: null,
          })),
        },
        bot_channel_acl: {
          list: vi.fn(async () => ({ items: [], nextCursor: null })),
        },
        bot_memberships: {
          list: vi.fn(async () => ({ items: [membershipRow], nextCursor: null })),
        },
        bots: { get: vi.fn(async () => botRow) },
        bot_revisions: {
          list: vi.fn(async () => ({ items: [revisionRow], nextCursor: null })),
        },
        bot_runs: {
          list: vi.fn(async () => ({ items: [runRow], nextCursor: null })),
        },
      },
    };
    const authorization = {
      requireActiveMembership: vi.fn(async () => ({ bot: botRow, membership: membershipRow })),
      requireChannelRead: vi.fn(async () => ({ bot: botRow, channel: channel() })),
      requireChannelSend: vi.fn(async () => ({ bot: botRow, channel: channel() })),
    };
    const channels = createBotChannels({
      store,
      authorization,
      encryption: { getKey: vi.fn(async () => Buffer.from(KEY)) },
      now: () => new Date(NOW),
    });

    const snapshot = await channels.snapshotForPrincipal({ id: USER_ID });

    expect(snapshot).toMatchObject({
      bots: [{
        id: BOT_ID,
        name: 'Release helper',
        title: 'Release Operations',
        summary: 'Coordinates reviewed releases.',
        avatarFallback: 'RO',
        activeRevisionId: REVISION_ID,
      }],
      revisions: [{ id: REVISION_ID, botId: BOT_ID, revisionNumber: 1 }],
      memberships: [{ botId: BOT_ID, userId: USER_ID, role: 'operator' }],
      channels: [{ id: CHANNEL_ID, botId: BOT_ID }],
      channelPreviews: [{
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        role: 'assistant',
        text: normalizedPreviewText,
      }],
      runs: [{ id: RUN_ID, channelId: CHANNEL_ID, state: 'running' }],
    });
    expect(snapshot.revisions[0]).not.toHaveProperty('contract');
    expect(snapshot.runs[0]).not.toHaveProperty('opencodeSegmentId');
    expect(snapshot.runs[0]).not.toHaveProperty('opencodeSessionId');

    botRow.active_revision_id = null;
    store.repositories.bot_channels.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    const setupOnlySnapshot = await channels.snapshotForPrincipal({ id: USER_ID });
    expect(setupOnlySnapshot).toMatchObject({
      bots: [], revisions: [], memberships: [], channels: [], runs: [],
    });
  });
});
