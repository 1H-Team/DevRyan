import { describe, expect, test } from 'bun:test';

import { createBotEventReconciler } from '@/apps/BotsEventOwner';
import type {
  BotCapabilities,
  BotChannel,
  BotComputerStatus,
  BotMembershipSummary,
  BotMessage,
  BotRevisionSummary,
  BotRun,
  BotSharedFile,
  BotsApi,
  BotSnapshot,
  BotSummary,
} from '@/lib/botsApi';
import { createBotChannelStore } from './useBotChannelStore';
import { createBotOperationsStore } from './useBotOperationsStore';
import { createBotSharedFilesStore } from './useBotSharedFilesStore';
import { createBotsStore } from './useBotsStore';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'f0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const RUN_ID = 'e0000000-0000-4000-8000-000000000001';
const MESSAGE_ID = 'd0000000-0000-4000-8000-000000000001';
const SHARED_FILE_ID = '90000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-23T10:00:00.000Z';

const bot = (overrides: Partial<BotSummary> = {}): BotSummary => ({
  id: BOT_ID,
  name: 'Release helper',
  title: 'Release helper',
  summary: 'Coordinates release work.',
  avatarUrl: null,
  avatarFallback: '🤖',
  lifecycle: 'active',
  tenancy: 'team',
  activeRevisionId: REVISION_ID,
  createdAt: NOW,
  updatedAt: NOW,
  retiredAt: null,
  ...overrides,
});

const revision = (): BotRevisionSummary => ({
  id: REVISION_ID,
  botId: BOT_ID,
  revisionNumber: 1,
  compiledHash: 'sha256:revision',
  createdAt: NOW,
  activatedAt: NOW,
  retiredAt: null,
});

const membership = (overrides: Partial<BotMembershipSummary> = {}): BotMembershipSummary => ({
  botId: BOT_ID,
  userId: USER_ID,
  role: 'operator',
  activatedAt: NOW,
  revokedAt: null,
  updatedAt: NOW,
  ...overrides,
});

const channel = (): BotChannel => ({
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
});

const run = (): BotRun => ({
  id: RUN_ID,
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  revisionId: REVISION_ID,
  modelSnapshot: null,
  computerScopeKey: `bot:${BOT_ID}`,
  queueSequence: 1,
  state: 'running',
  retryable: false,
  interruptionKind: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  finishedAt: null,
});

const message = (text: string): BotMessage => ({
  id: MESSAGE_ID,
  channelId: CHANNEL_ID,
  runId: RUN_ID,
  actorUserId: null,
  role: 'assistant',
  assistantPhase: 'result',
  sequence: 1,
  body: { text, attachmentIds: [] },
  attachmentCount: 0,
  createdAt: NOW,
  finalizedAt: null,
});

const sharedFile = (overrides: Partial<BotSharedFile> = {}): BotSharedFile => ({
  id: SHARED_FILE_ID,
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  messageId: MESSAGE_ID,
  objectId: '80000000-0000-4000-8000-000000000001',
  senderUserId: USER_ID,
  direction: 'user',
  filename: 'brief.txt',
  contentType: 'text/plain',
  sha256: null,
  size: null,
  computerPath: `/workspace/Shared/${CHANNEL_ID}/${MESSAGE_ID}/brief.txt`,
  copyState: 'pending',
  errorCode: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const computerStatus = (): BotComputerStatus => ({
  botId: BOT_ID,
  browser: { running: true },
  control: null,
  screencast: { subscribers: 0, lastFrameAt: null, retainedFrames: 0 },
  framesRecorded: false,
  arbitraryWebsiteExactlyOnce: false,
});

const snapshot = (): BotSnapshot => ({
  bots: [bot()],
  revisions: [revision()],
  memberships: [membership()],
  channels: [channel()],
  runs: [run()],
  pendingApprovals: [],
  computers: [],
});

describe('Production Bots catalog store', () => {
  test('preserves catalog and entity references for a no-op snapshot', () => {
    const store = createBotsStore();
    store.getState().replaceSnapshot(snapshot());
    const first = store.getState();

    store.getState().replaceSnapshot(snapshot());
    const second = store.getState();

    expect(second.botsById).toBe(first.botsById);
    expect(second.botsById[BOT_ID]).toBe(first.botsById[BOT_ID]);
    expect(second.botIds).toBe(first.botIds);
    expect(second.revisionsById).toBe(first.revisionsById);
    expect(second.membershipsByBotId).toBe(first.membershipsByBotId);
  });

  test('updates Bot presentation fields without replacing unrelated catalog rows', () => {
    const secondBot = bot({
      id: 'b0000000-0000-4000-8000-000000000002',
      name: 'Stable helper',
    });
    const store = createBotsStore();
    store.getState().replaceSnapshot({
      ...snapshot(),
      bots: [bot(), secondBot],
    });
    const stableReference = store.getState().botsById[secondBot.id];

    store.getState().upsertBot(bot({
      title: 'Release coordinator',
      summary: 'Coordinates verified releases.',
      avatarUrl: '/api/bots/avatar/release',
      avatarFallback: 'RC',
    }));

    expect({
      title: store.getState().botsById[BOT_ID]?.title,
      summary: store.getState().botsById[BOT_ID]?.summary,
      avatarUrl: store.getState().botsById[BOT_ID]?.avatarUrl,
      avatarFallback: store.getState().botsById[BOT_ID]?.avatarFallback,
    }).toEqual({
      title: 'Release coordinator',
      summary: 'Coordinates verified releases.',
      avatarUrl: '/api/bots/avatar/release',
      avatarFallback: 'RC',
    });
    expect(store.getState().botsById[secondBot.id]).toBe(stableReference);
  });

  test('drops stale capability responses after a principal reset', async () => {
    let resolveCapabilities!: (value: BotCapabilities) => void;
    const response = new Promise<BotCapabilities>((resolve) => {
      resolveCapabilities = resolve;
    });
    const api = {
      getCapabilities: () => response,
    } as BotsApi;
    const store = createBotsStore({ api });
    store.getState().resetPrincipal(USER_ID);
    const request = store.getState().loadCapabilities();
    store.getState().resetPrincipal('a0000000-0000-4000-8000-000000000002');
    resolveCapabilities({
      available: true,
      state: 'healthy',
      code: null,
      owner: 'electron',
      canManageRuntime: true,
      canCreateBot: true,
    });

    await request;
    expect(store.getState().capabilities).toBeNull();
    expect(store.getState().principalId).toBe('a0000000-0000-4000-8000-000000000002');
  });
});

describe('Production Bots event reconciliation', () => {
  test('normalizes version-skewed Bot presentation fields and propagates profile updates', () => {
    const stores = {
      bots: createBotsStore(),
      channels: createBotChannelStore(),
      operations: createBotOperationsStore(),
      shared: createBotSharedFilesStore(),
    };
    const reconciler = createBotEventReconciler({ stores });
    const current = bot();
    const legacyBot = {
      id: current.id,
      name: current.name,
      lifecycle: current.lifecycle,
      tenancy: current.tenancy,
      activeRevisionId: current.activeRevisionId,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      retiredAt: current.retiredAt,
    };

    expect(reconciler.ingest({
      id: 'epoch-profile:0', sequence: 0, kind: 'snapshot',
      payload: { ...snapshot(), bots: [legacyBot] },
    })).toEqual({ accepted: true, reason: 'snapshot' });
    const normalized = stores.bots.getState().botsById[BOT_ID];
    expect({
      title: normalized?.title,
      summary: normalized?.summary,
      avatarUrl: normalized?.avatarUrl,
      avatarFallback: normalized?.avatarFallback,
    }).toEqual({
      title: current.name,
      summary: '',
      avatarUrl: null,
      avatarFallback: null,
    });

    expect(reconciler.ingest({
      id: 'epoch-profile:1', sequence: 1, kind: 'bot.updated', botId: BOT_ID,
      payload: { bot: bot({
        title: 'Release coordinator',
        summary: 'Coordinates verified releases.',
        avatarUrl: '/api/bots/avatar/release',
        avatarFallback: 'RC',
      }) },
    })).toEqual({ accepted: true, reason: 'event' });
    const updated = stores.bots.getState().botsById[BOT_ID];
    expect({
      title: updated?.title,
      summary: updated?.summary,
      avatarUrl: updated?.avatarUrl,
      avatarFallback: updated?.avatarFallback,
    }).toEqual({
      title: 'Release coordinator',
      summary: 'Coordinates verified releases.',
      avatarUrl: '/api/bots/avatar/release',
      avatarFallback: 'RC',
    });

    expect(reconciler.ingest({
      id: 'epoch-profile:2', sequence: 2, kind: 'bot.updated', botId: BOT_ID,
      payload: { bot: { ...legacyBot, updatedAt: '2026-08-23T10:01:00.000Z' } },
    })).toEqual({ accepted: true, reason: 'event' });
    const afterSkewedUpdate = stores.bots.getState().botsById[BOT_ID];
    expect({
      title: afterSkewedUpdate?.title,
      summary: afterSkewedUpdate?.summary,
      avatarUrl: afterSkewedUpdate?.avatarUrl,
      avatarFallback: afterSkewedUpdate?.avatarFallback,
    }).toEqual({
      title: 'Release coordinator',
      summary: 'Coordinates verified releases.',
      avatarUrl: '/api/bots/avatar/release',
      avatarFallback: 'RC',
    });
  });

  test('accepts reconnect snapshots, drops replayed events, and applies newer checkpoints', () => {
    const stores = {
      bots: createBotsStore(),
      channels: createBotChannelStore(),
      operations: createBotOperationsStore(),
      shared: createBotSharedFilesStore(),
    };
    const reconciler = createBotEventReconciler({ stores });
    const base = snapshot();

    expect(reconciler.ingest({
      id: 'epoch-one:0', sequence: 0, kind: 'snapshot', payload: base,
    })).toEqual({ accepted: true, reason: 'snapshot' });
    expect(reconciler.ingest({
      id: 'epoch-one:4',
      sequence: 4,
      kind: 'message.updated',
      channelId: CHANNEL_ID,
      payload: {
        message: message('First checkpoint'),
        channelPreview: {
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          role: 'assistant',
          sequence: 1,
          text: 'First finalized preview',
          attachmentCount: 0,
          createdAt: NOW,
          finalizedAt: NOW,
        },
      },
    })).toEqual({ accepted: true, reason: 'event' });
    expect(stores.channels.getState().previewsByChannelId[CHANNEL_ID]?.text)
      .toBe('First finalized preview');

    reconciler.ingest({ id: 'epoch-one:0', sequence: 0, kind: 'snapshot', payload: base });
    expect(reconciler.ingest({
      id: 'epoch-one:4',
      sequence: 4,
      kind: 'message.updated',
      payload: { message: message('Stale replay') },
    })).toEqual({ accepted: false, reason: 'stale' });
    expect(stores.channels.getState().messagesById[MESSAGE_ID].body.text)
      .toBe('First checkpoint');

    reconciler.ingest({
      id: 'epoch-one:5',
      sequence: 5,
      kind: 'message.updated',
      payload: {
        message: message('Latest checkpoint'),
        channelPreview: {
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          role: 'assistant',
          sequence: 1,
          text: 'Latest finalized preview',
          attachmentCount: 0,
          createdAt: NOW,
          finalizedAt: NOW,
        },
      },
    });
    expect(stores.channels.getState().messagesById[MESSAGE_ID].body.text)
      .toBe('Latest checkpoint');
    expect(stores.channels.getState().previewsByChannelId[CHANNEL_ID]?.text)
      .toBe('Latest finalized preview');
  });

  test('removes transcript and operations immediately on ACL revocation', () => {
    const stores = {
      bots: createBotsStore(),
      channels: createBotChannelStore(),
      operations: createBotOperationsStore(),
      shared: createBotSharedFilesStore(),
    };
    const reconciler = createBotEventReconciler({ stores });
    reconciler.ingest({ id: 'epoch-one:0', sequence: 0, kind: 'snapshot', payload: snapshot() });
    reconciler.ingest({
      id: 'epoch-one:1',
      sequence: 1,
      kind: 'message.created',
      channelId: CHANNEL_ID,
      payload: { message: message('Private') },
    });

    reconciler.ingest({
      id: 'epoch-one:2',
      sequence: 2,
      kind: 'membership.revoked',
      botId: BOT_ID,
      payload: { membership: membership({ revokedAt: NOW }) },
    });

    expect(stores.bots.getState().botsById[BOT_ID]).toBe(undefined);
    expect(stores.channels.getState().channelsById[CHANNEL_ID]).toBe(undefined);
    expect(stores.channels.getState().messagesById[MESSAGE_ID]).toBe(undefined);
    expect(stores.operations.getState().runsById[RUN_ID]).toBe(undefined);
  });

  test('reconciles authorized Shared status events and removes them with channel access', () => {
    const stores = {
      bots: createBotsStore(),
      channels: createBotChannelStore(),
      operations: createBotOperationsStore(),
      shared: createBotSharedFilesStore(),
    };
    const reconciler = createBotEventReconciler({ stores });
    reconciler.ingest({ id: 'epoch-shared:0', sequence: 0, kind: 'snapshot', payload: snapshot() });

    expect(reconciler.ingest({
      id: 'epoch-shared:1',
      sequence: 1,
      kind: 'shared_file.updated',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      payload: { sharedFile: sharedFile() },
    })).toEqual({ accepted: true, reason: 'event' });
    expect(stores.shared.getState().filesById[SHARED_FILE_ID]?.copyState).toBe('pending');

    reconciler.ingest({
      id: 'epoch-shared:2',
      sequence: 2,
      kind: 'shared_file.updated',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      payload: {
        sharedFile: sharedFile({
          copyState: 'ready',
          sha256: 'a'.repeat(64),
          size: 12,
          updatedAt: '2026-08-23T10:01:00.000Z',
        }),
      },
    });
    expect(stores.shared.getState().filesById[SHARED_FILE_ID]?.copyState).toBe('ready');

    reconciler.ingest({
      id: 'epoch-shared:3',
      sequence: 3,
      kind: 'channel.revoked',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      payload: { channel: channel() },
    });
    expect(stores.shared.getState().filesById[SHARED_FILE_ID]).toBe(undefined);
  });

  test('reconciles computer control by Bot identity and clears it on deactivation', () => {
    const stores = {
      bots: createBotsStore(),
      channels: createBotChannelStore(),
      operations: createBotOperationsStore(),
      shared: createBotSharedFilesStore(),
    };
    const reconciler = createBotEventReconciler({ stores });
    reconciler.ingest({ id: 'epoch-computer:0', sequence: 0, kind: 'snapshot', payload: snapshot() });
    stores.operations.getState().upsertComputer(computerStatus());

    expect(reconciler.ingest({
      id: 'epoch-computer:1',
      sequence: 1,
      kind: 'computer.control.take',
      botId: BOT_ID,
      payload: {
        botId: BOT_ID,
        control: {
          leaseId: 'lease-1',
          actorId: USER_ID,
          actorType: 'user',
          takenAt: 1,
          expiresAt: 31_000,
        },
      },
    })).toEqual({ accepted: true, reason: 'event' });
    expect(stores.operations.getState().computersByBotId[BOT_ID]?.control?.leaseId)
      .toBe('lease-1');

    reconciler.ingest({
      id: 'epoch-computer:2',
      sequence: 2,
      kind: 'bot.paused',
      botId: BOT_ID,
      payload: { bot: bot({ lifecycle: 'paused' }) },
    });
    expect(stores.operations.getState().computersByBotId[BOT_ID]).toBe(undefined);
  });

  test('clears every principal-scoped projection on logout or account change', () => {
    const botsStore = createBotsStore();
    const channelStore = createBotChannelStore();
    const operationsStore = createBotOperationsStore();
    const sharedFilesStore = createBotSharedFilesStore();
    botsStore.getState().resetPrincipal(USER_ID);
    channelStore.getState().resetPrincipal(USER_ID);
    operationsStore.getState().resetPrincipal(USER_ID);
    sharedFilesStore.getState().resetPrincipal(USER_ID);
    botsStore.getState().replaceSnapshot(snapshot());
    channelStore.getState().replaceSnapshot(snapshot());
    operationsStore.getState().replaceSnapshot(snapshot());
    sharedFilesStore.getState().upsertFile(sharedFile());
    channelStore.getState().setDraft(CHANNEL_ID, { text: 'Secret draft', attachmentIds: [] });

    botsStore.getState().resetPrincipal(null);
    channelStore.getState().resetPrincipal(null);
    operationsStore.getState().resetPrincipal(null);
    sharedFilesStore.getState().resetPrincipal(null);

    expect(botsStore.getState().botsById).toEqual({});
    expect(channelStore.getState().channelsById).toEqual({});
    expect(channelStore.getState().messagesById).toEqual({});
    expect(channelStore.getState().draftsByChannelId).toEqual({});
    expect(operationsStore.getState().runsById).toEqual({});
    expect(operationsStore.getState().actionsById).toEqual({});
    expect(sharedFilesStore.getState().filesById).toEqual({});
  });
});
