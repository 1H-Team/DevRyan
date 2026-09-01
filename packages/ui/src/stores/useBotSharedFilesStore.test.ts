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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('Shared inventory async authority', () => {
  test('keeps files added and updated by events while an older listing was in flight', async () => {
    const page = deferred<{ sharedFiles: BotSharedFile[]; nextCursor: null }>();
    const api = { listSharedFiles: () => page.promise };
    const store = createBotSharedFilesStore();
    const older = sharedFile('old', CHANNEL_A);
    store.getState().upsertFile(older);
    const request = store.getState().loadChannel(BOT_ID, CHANNEL_A, api);
    expect(store.getState().loadChannel(BOT_ID, CHANNEL_A, api)).toBe(request);
    const added = sharedFile('new', CHANNEL_A);
    const updated = { ...older, copyState: 'ready' as const, updatedAt: '2026-08-25T11:00:00.000Z' };
    store.getState().upsertFile(added);
    store.getState().upsertFile(updated);
    page.resolve({ sharedFiles: [older], nextCursor: null });
    await request;
    expect(store.getState().filesById.old).toBe(updated);
    expect(store.getState().filesById.new).toBe(added);
  });

  test('discards an old listing across A→B→A principal resets', async () => {
    const page = deferred<{ sharedFiles: BotSharedFile[]; nextCursor: null }>();
    const store = createBotSharedFilesStore();
    store.getState().resetPrincipal(USER_ID);
    const request = store.getState().loadChannel(BOT_ID, CHANNEL_A, { listSharedFiles: () => page.promise });
    store.getState().resetPrincipal('other');
    store.getState().resetPrincipal(USER_ID);
    page.resolve({ sharedFiles: [sharedFile('old-account', CHANNEL_A)], nextCursor: null });
    await request;
    expect(store.getState().filesById).toEqual({});
  });

  test('discards a late first listing after access revocation even when no files had loaded', async () => {
    const page = deferred<{ sharedFiles: BotSharedFile[]; nextCursor: null }>();
    const store = createBotSharedFilesStore();
    store.getState().replaceSnapshot([channel(CHANNEL_A)]);
    const request = store.getState().loadChannel(BOT_ID, CHANNEL_A, { listSharedFiles: () => page.promise });
    store.getState().replaceSnapshot([]);
    store.getState().replaceSnapshot([channel(CHANNEL_A)]);
    page.resolve({ sharedFiles: [sharedFile('revoked', CHANNEL_A)], nextCursor: null });
    await request;
    expect(store.getState().filesById).toEqual({});
  });

  test('retains unrelated message-file index identity on a copy status update', () => {
    const store = createBotSharedFilesStore();
    const first = sharedFile('first', CHANNEL_A, { messageId: 'message-first' });
    const second = sharedFile('second', CHANNEL_A, { messageId: 'message-second' });
    store.getState().upsertFile(first);
    store.getState().upsertFile(second);
    const before = store.getState().fileIdsByMessageId['message-first'];
    store.getState().upsertFile({ ...second, copyState: 'ready', updatedAt: '2026-08-25T12:00:00.000Z' });
    expect(store.getState().fileIdsByMessageId['message-first']).toBe(before);
  });
});

test('Shared action scope cannot become current again after account or channel revocation', () => {
  const store = createBotSharedFilesStore();
  store.getState().resetPrincipal(USER_ID);
  store.getState().replaceSnapshot([channel(CHANNEL_A)]);
  const beforeAccountSwitch = store.getState().captureScope(CHANNEL_A);
  store.getState().resetPrincipal('other');
  store.getState().resetPrincipal(USER_ID);
  store.getState().replaceSnapshot([channel(CHANNEL_A)]);
  expect(beforeAccountSwitch()).toBe(false);
  const beforeRevocation = store.getState().captureScope(CHANNEL_A);
  store.getState().replaceSnapshot([]);
  store.getState().replaceSnapshot([channel(CHANNEL_A)]);
  expect(beforeRevocation()).toBe(false);
});
