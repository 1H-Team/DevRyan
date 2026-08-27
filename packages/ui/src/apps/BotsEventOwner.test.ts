import { describe, expect, test } from 'bun:test';

import type { BotsApi } from '@/lib/botsApi';
import { createBotChannelStore } from '@/stores/useBotChannelStore';
import { createBotLiveMessageStore } from '@/stores/useBotLiveMessageStore';
import { createBotOperationsStore } from '@/stores/useBotOperationsStore';
import { createBotSharedFilesStore } from '@/stores/useBotSharedFilesStore';
import { createBotsStore } from '@/stores/useBotsStore';
import { createBotEventReconciler } from './BotsEventOwner';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';
const MESSAGE_ID = 'e0000000-0000-4000-8000-000000000001';
const RUN_ID = 'f0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-26T12:00:00.000Z';

const snapshot = {
  bots: [{
    id: BOT_ID,
    name: 'Release Steward',
    title: 'Release lead',
    summary: '',
    avatarUrl: null,
    avatarFallback: 'RS',
    lifecycle: 'active',
    tenancy: 'team',
    activeRevisionId: REVISION_ID,
    createdAt: NOW,
    updatedAt: NOW,
    retiredAt: null,
  }],
  revisions: [{
    id: REVISION_ID,
    botId: BOT_ID,
    revisionNumber: 1,
    compiledHash: 'a'.repeat(64),
    createdAt: NOW,
    activatedAt: NOW,
    retiredAt: null,
  }],
  memberships: [{
    botId: BOT_ID,
    userId: USER_ID,
    role: 'member',
    activatedAt: NOW,
    revokedAt: null,
    updatedAt: NOW,
  }],
  channels: [{
    id: CHANNEL_ID,
    botId: BOT_ID,
    ownerUserId: USER_ID,
    accessRole: 'owner',
    canSend: true,
    lifecycle: 'active',
    currentCheckpointNumber: 0,
    lastMessageSequence: 0,
    lastMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  }],
  channelPreviews: [],
  runs: [],
  recentActions: [],
  pendingApprovals: [],
  computers: [],
};

const run = (state: string) => ({
  id: RUN_ID,
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  revisionId: REVISION_ID,
  modelSnapshot: { version: 1, state: 'pending' },
  computerScopeKey: `bot:${BOT_ID}`,
  queueSequence: 1,
  state,
  retryable: false,
  interruptionKind: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  finishedAt: null,
});

describe('Production Bot requester streaming reconciliation', () => {
  test('keeps newer live text over slow checkpoints, then clears it on final canonical state', () => {
    const stores = {
      bots: createBotsStore({ api: {} as BotsApi }),
      channels: createBotChannelStore({ api: {} as BotsApi }),
      operations: createBotOperationsStore({ api: {} as BotsApi }),
      shared: createBotSharedFilesStore(),
      live: createBotLiveMessageStore(),
    };
    const reconciler = createBotEventReconciler({ stores });
    expect(reconciler.ingest({
      id: 'epoch:0', sequence: 0, kind: 'snapshot', payload: snapshot,
    })).toEqual({ accepted: true, reason: 'snapshot' });

    expect(reconciler.ingest({
      id: 'epoch:1',
      sequence: 1,
      kind: 'message.streaming',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      payload: {
        messageId: MESSAGE_ID,
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        sequence: 2,
        createdAt: NOW,
        text: 'Newest requester text',
        revision: 4,
      },
    })).toEqual({ accepted: true, reason: 'event' });

    reconciler.ingest({
      id: 'epoch:2',
      sequence: 2,
      kind: 'message.updated',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      payload: {
        message: {
          id: MESSAGE_ID,
          channelId: CHANNEL_ID,
          runId: RUN_ID,
          actorUserId: null,
          role: 'assistant',
          sequence: 2,
          body: { text: 'Older checkpoint', attachmentIds: [] },
          attachmentCount: 0,
          createdAt: NOW,
          finalizedAt: null,
        },
        streamRevision: 3,
      },
    });
    expect(stores.channels.getState().messagesById[MESSAGE_ID]?.body.text).toBe('Older checkpoint');
    expect(stores.live.getState().messagesById[MESSAGE_ID]?.text).toBe('Newest requester text');

    reconciler.ingest({
      id: 'epoch:3',
      sequence: 3,
      kind: 'message.updated',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      payload: {
        message: {
          id: MESSAGE_ID,
          channelId: CHANNEL_ID,
          runId: RUN_ID,
          actorUserId: null,
          role: 'assistant',
          sequence: 2,
          body: { text: 'Final requester text', attachmentIds: [] },
          attachmentCount: 0,
          createdAt: NOW,
          finalizedAt: NOW,
        },
        streamRevision: 5,
      },
    });
    expect(stores.live.getState().messagesById[MESSAGE_ID]).toBe(undefined);
    expect(stores.channels.getState().messagesById[MESSAGE_ID]?.body.text).toBe('Final requester text');
  });

  test('clears transient text on terminal runs and reconnect snapshots', () => {
    const stores = {
      bots: createBotsStore({ api: {} as BotsApi }),
      channels: createBotChannelStore({ api: {} as BotsApi }),
      operations: createBotOperationsStore({ api: {} as BotsApi }),
      shared: createBotSharedFilesStore(),
      live: createBotLiveMessageStore(),
    };
    const reconciler = createBotEventReconciler({ stores });
    reconciler.ingest({ id: 'epoch:0', sequence: 0, kind: 'snapshot', payload: snapshot });
    const stream = (id: string, sequence: number) => ({
      id: `epoch:${sequence}`,
      sequence,
      kind: 'message.streaming',
      payload: {
        messageId: id,
        runId: RUN_ID,
        channelId: CHANNEL_ID,
        sequence: 2,
        createdAt: NOW,
        text: 'Transient',
        revision: sequence,
      },
    });
    reconciler.ingest(stream(MESSAGE_ID, 1));
    reconciler.ingest({
      id: 'epoch:2', sequence: 2, kind: 'run.failed', payload: { run: run('failed') },
    });
    expect(stores.live.getState().messagesById).toEqual({});

    reconciler.ingest(stream(MESSAGE_ID, 3));
    expect(stores.live.getState().messagesById[MESSAGE_ID]).not.toBe(undefined);
    reconciler.ingest({ id: 'epoch:0', sequence: 0, kind: 'snapshot', payload: snapshot });
    expect(stores.live.getState().messagesById).toEqual({});
  });
});
