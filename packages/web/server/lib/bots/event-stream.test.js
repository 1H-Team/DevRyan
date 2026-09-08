import { describe, expect, it, vi } from 'vitest';

import { createBotEventStream } from './event-stream.js';

const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ID = 'a0000000-0000-4000-8000-000000000002';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';

describe('Production Bot event stream', () => {
  it('preserves unique publication order while a visibility lookup is pending', async () => {
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    const received = [];
    const stream = createBotEventStream({ canDeliver: async () => { await gate; return true; }, epoch: 'ordered' });
    await stream.open({ principal: { id: USER_ID }, send: async (event) => received.push(event) });
    const first = stream.publish({ kind: 'bot.updated', botId: BOT_ID, audienceUserIds: [USER_ID], payload: { value: 1 } });
    const second = stream.publish({ kind: 'bot.updated', botId: BOT_ID, audienceUserIds: [USER_ID], payload: { value: 2 } });
    finish();
    await Promise.all([first, second]);
    expect(received.map((event) => event.id)).toEqual(['ordered:0', 'ordered:1', 'ordered:2']);
    expect(received.slice(1).map((event) => event.payload.value)).toEqual([1, 2]);
    stream.shutdown();
  });
  it('drains snapshot-time events before newer live publications', async () => {
    let finishSnapshot, finishFirst, firstStarted;
    const snapshotGate = new Promise((resolve) => { finishSnapshot = resolve; });
    const firstGate = new Promise((resolve) => { finishFirst = resolve; });
    const sendingFirst = new Promise((resolve) => { firstStarted = resolve; });
    const received = [];
    const stream = createBotEventStream({ loadSnapshot: async () => { await snapshotGate; return {}; }, epoch: 'drain' });
    const opening = stream.open({ principal: { id: USER_ID }, send: async (event) => {
      if (event.sequence === 1) { firstStarted(); await firstGate; }
      received.push(event.sequence);
    } });
    const publish = (value) => stream.publish({ kind: 'bot.updated', botId: BOT_ID, audienceUserIds: [USER_ID], payload: { value } });
    await publish(1);
    finishSnapshot();
    await sendingFirst;
    const second = publish(2);
    await Promise.resolve();
    expect(received).toEqual([0]);
    finishFirst();
    await Promise.all([opening, second]);
    expect(received).toEqual([0, 1, 2]);
    stream.shutdown();
  });

  it('sends an authorized snapshot before monotonic live events', async () => {
    const send = vi.fn();
    const stream = createBotEventStream({
      loadSnapshot: vi.fn(async () => ({ channels: [{ id: CHANNEL_ID, sequence: 4 }] })),
      epoch: 'epoch-1',
    });
    const close = await stream.open({ principal: { id: USER_ID }, send });
    await stream.publish({
      kind: 'message.created',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      audienceUserIds: [USER_ID],
      payload: { message: { id: 'message-1', sequence: 5 } },
    });
    await stream.publish({
      kind: 'run.started',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      audienceUserIds: [USER_ID],
      payload: { run: { id: 'run-1' } },
    });

    expect(send.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ kind: 'snapshot', sequence: 0, id: 'epoch-1:0' }),
      expect.objectContaining({ kind: 'message.created', sequence: 1, id: 'epoch-1:1' }),
      expect.objectContaining({ kind: 'run.started', sequence: 2, id: 'epoch-1:2' }),
    ]);
    close();
  });

  it('never serializes Bot or channel identifiers for an unauthorized principal', async () => {
    const send = vi.fn();
    const stream = createBotEventStream({ loadSnapshot: async () => ({ channels: [] }) });
    await stream.open({ principal: { id: OTHER_ID }, send });
    await stream.publish({
      kind: 'message.created',
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      audienceUserIds: [USER_ID],
      payload: { secretChannelId: CHANNEL_ID },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain(BOT_ID);
    expect(JSON.stringify(send.mock.calls)).not.toContain(CHANNEL_ID);
  });

  it('composes independently owned principal-filtered snapshot projections', async () => {
    const send = vi.fn();
    const stream = createBotEventStream({
      loadSnapshot: async () => ({ channels: [{ id: CHANNEL_ID }] }),
      epoch: 'epoch-operations',
    });
    stream.addSnapshotSource('operations', async (principal) => ({
      pendingApprovals: principal.id === USER_ID ? [{ id: 'action-1' }] : [],
      computers: [],
    }));

    await stream.open({ principal: { id: USER_ID }, send });
    expect(send.mock.calls[0][0]).toMatchObject({
      kind: 'snapshot',
      payload: {
        channels: [{ id: CHANNEL_ID }],
        pendingApprovals: [{ id: 'action-1' }],
        computers: [],
      },
    });
    expect(() => stream.addSnapshotSource('duplicate', async () => ({ channels: [] })))
      .not.toThrow();
    await expect(stream.open({ principal: { id: USER_ID }, send: vi.fn() }))
      .rejects.toMatchObject({ code: 'bot_event_snapshot_invalid' });
  });
});
