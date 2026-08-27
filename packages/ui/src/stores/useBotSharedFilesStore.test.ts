import { describe, expect, test } from 'bun:test';

import type { BotChannel, BotSharedFile } from '@/lib/botsApi';
import { createBotSharedFilesStore } from './useBotSharedFilesStore';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_A = 'c0000000-0000-4000-8000-000000000001';
const CHANNEL_B = 'c0000000-0000-4000-8000-000000000002';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-25T10:00:00.000Z';

const channel = (id: string): BotChannel => ({
  id,
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

const sharedFile = (
  id: string,
  channelId: string,
  overrides: Partial<BotSharedFile> = {},
): BotSharedFile => ({
  id,
  botId: BOT_ID,
  channelId,
  messageId: 'd0000000-0000-4000-8000-000000000001',
  objectId: 'e0000000-0000-4000-8000-000000000001',
  senderUserId: USER_ID,
  direction: 'user',
  filename: `${id}.txt`,
  contentType: 'text/plain',
  sha256: null,
  size: null,
  computerPath: `/workspace/Shared/${channelId}/d0000000-0000-4000-8000-000000000001/${id}.txt`,
  copyState: 'pending',
  errorCode: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('Production Bot Shared files store', () => {
  test('preserves row and channel-order references for an equal replacement', () => {
    const store = createBotSharedFilesStore();
    const file = sharedFile('f0000000-0000-4000-8000-000000000001', CHANNEL_A);
    store.getState().replaceChannel(CHANNEL_A, [file]);
    const row = store.getState().filesById[file.id];
    const ids = store.getState().fileIdsByChannelId[CHANNEL_A];

    store.getState().replaceChannel(CHANNEL_A, [{ ...file }]);

    expect(store.getState().filesById[file.id]).toBe(row);
    expect(store.getState().fileIdsByChannelId[CHANNEL_A]).toBe(ids);
  });

  test('updates one live copy status without replacing stable ordering', () => {
    const store = createBotSharedFilesStore();
    const file = sharedFile('f0000000-0000-4000-8000-000000000001', CHANNEL_A);
    store.getState().upsertFile(file);
    const ids = store.getState().fileIdsByChannelId[CHANNEL_A];

    store.getState().upsertFile({
      ...file,
      copyState: 'ready',
      sha256: 'a'.repeat(64),
      size: 12,
      updatedAt: '2026-08-25T10:01:00.000Z',
    });

    expect(store.getState().filesById[file.id]).not.toBe(file);
    expect(store.getState().filesById[file.id]?.copyState).toBe('ready');
    expect(store.getState().fileIdsByChannelId[CHANNEL_A]).toBe(ids);
    expect(store.getState().fileIdsByMessageId[file.messageId]).toEqual([file.id]);
  });

  test('prunes files as soon as a channel leaves the authorized snapshot', () => {
    const store = createBotSharedFilesStore();
    const first = sharedFile('f0000000-0000-4000-8000-000000000001', CHANNEL_A);
    const second = sharedFile('f0000000-0000-4000-8000-000000000002', CHANNEL_B);
    store.getState().replaceChannel(CHANNEL_A, [first]);
    store.getState().replaceChannel(CHANNEL_B, [second]);

    store.getState().replaceSnapshot([channel(CHANNEL_A)]);

    expect(store.getState().filesById[first.id]).toBe(first);
    expect(store.getState().filesById[second.id]).toBe(undefined);
    expect(store.getState().fileIdsByChannelId[CHANNEL_B]).toBe(undefined);
    expect(store.getState().fileIdsByMessageId[second.messageId]).toEqual([first.id]);
  });

  test('clears every Shared projection on principal change', () => {
    const store = createBotSharedFilesStore();
    const file = sharedFile('f0000000-0000-4000-8000-000000000001', CHANNEL_A);
    store.getState().resetPrincipal(USER_ID);
    store.getState().upsertFile(file);

    store.getState().resetPrincipal('a0000000-0000-4000-8000-000000000002');

    expect(store.getState().principalId).toBe('a0000000-0000-4000-8000-000000000002');
    expect(store.getState().filesById).toEqual({});
    expect(store.getState().fileIdsByChannelId).toEqual({});
    expect(store.getState().fileIdsByMessageId).toEqual({});
  });
});
