import { describe, expect, test } from 'bun:test';

import type { BotStreamingMessage } from '@/lib/botsApi';
import { useBotLiveMessageStore } from './useBotLiveMessageStore';

const live = (revision: number, text = `revision ${revision}`): BotStreamingMessage => ({
  messageId: 'd0000000-0000-4000-8000-000000000001',
  runId: 'e0000000-0000-4000-8000-000000000001',
  channelId: 'c0000000-0000-4000-8000-000000000001',
  sequence: revision,
  createdAt: '2026-08-26T10:00:00.000Z',
  text,
  revision,
});

describe('Production Bot live message store', () => {
  test('keeps revisions monotonic and channel identity stable across text updates', () => {
    useBotLiveMessageStore.getState().reset();
    useBotLiveMessageStore.getState().upsert(live(2));
    const channelIndex = useBotLiveMessageStore.getState().messageIdByChannelId;
    useBotLiveMessageStore.getState().upsert(live(1, 'stale'));
    expect(useBotLiveMessageStore.getState().messagesById[live(2).messageId].text).toBe('revision 2');
    useBotLiveMessageStore.getState().upsert(live(3));
    expect(useBotLiveMessageStore.getState().messageIdByChannelId).toBe(channelIndex);
    expect(useBotLiveMessageStore.getState().messagesById[live(3).messageId].revision).toBe(3);
  });

  test('does not let a slower canonical checkpoint erase newer live text', () => {
    useBotLiveMessageStore.getState().reset();
    useBotLiveMessageStore.getState().upsert(live(4));
    useBotLiveMessageStore.getState().reconcileCanonical(live(4).messageId, 3, false);
    expect(useBotLiveMessageStore.getState().messagesById[live(4).messageId]).not.toBe(undefined);
    useBotLiveMessageStore.getState().reconcileCanonical(live(4).messageId, 4, false);
    expect(useBotLiveMessageStore.getState().messagesById[live(4).messageId]).toBe(undefined);
  });

  test('clears on finalization, terminal runs, channel removal, reset, and rejects oversized text', () => {
    useBotLiveMessageStore.getState().reset();
    useBotLiveMessageStore.getState().upsert(live(1, 'x'.repeat(192 * 1024 + 1)));
    expect(useBotLiveMessageStore.getState().messagesById).toEqual({});
    useBotLiveMessageStore.getState().upsert(live(1));
    useBotLiveMessageStore.getState().clearRun(live(1).runId);
    expect(useBotLiveMessageStore.getState().messagesById).toEqual({});
    useBotLiveMessageStore.getState().upsert(live(1));
    useBotLiveMessageStore.getState().clearChannel(live(1).channelId);
    expect(useBotLiveMessageStore.getState().messagesById).toEqual({});
    useBotLiveMessageStore.getState().upsert(live(1));
    useBotLiveMessageStore.getState().reconcileCanonical(live(1).messageId, null, true);
    expect(useBotLiveMessageStore.getState().messagesById).toEqual({});
  });
});
