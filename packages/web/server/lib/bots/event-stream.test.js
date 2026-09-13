import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BOT_EVENT_MAX_BYTES, BOT_SNAPSHOT_FORMAT, createBotSnapshotAssembler } from '@openchamber/bots-runtime/event-snapshot.js';

import { createBotEventStream } from './event-stream.js';

const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ID = 'a0000000-0000-4000-8000-000000000002';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const sseResponse = () => {
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200, writableEnded: false, destroyed: false,
    write: vi.fn(() => true), setHeader: vi.fn(), flushHeaders: vi.fn(),
    end: vi.fn(() => { response.writableEnded = true; response.emit('finish'); }),
    destroy: vi.fn(() => { response.destroyed = true; response.emit('close'); }),
  });
  return response;
};

describe('Production Bot event stream', () => {
  it('sends a large snapshot in bounded parts before snapshot-time publications', async () => {
    const gate = deferred();
    const received = [];
    const snapshot = { channels: Array.from({ length: 1_200 }, (_, id) => ({ id, title: '界'.repeat(100) })) };
    const stream = createBotEventStream({ loadSnapshot: async () => { await gate.promise; return snapshot; } });
    const opening = stream.open({ principal: { id: USER_ID }, snapshotFormat: BOT_SNAPSHOT_FORMAT,
      send: async (event) => received.push(event) });
    await stream.publish({ kind: 'bot.updated', audienceUserIds: [USER_ID], payload: { value: 1 } });
    gate.resolve();
    const close = await opening;
    expect(received.at(-1)).toMatchObject({ kind: 'bot.updated', sequence: 1 });
    const assembler = createBotSnapshotAssembler();
    let complete = null;
    for (const part of received.slice(0, -1)) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(BOT_EVENT_MAX_BYTES);
      complete = assembler.push(part);
    }
    expect(complete?.payload).toEqual(snapshot);
    close();
  });

  it.each(['aborted', 'response'])('cancels an early %s disconnect before loading any later snapshot source', async (kind) => {
    const gate = deferred();
    let lifetime;
    const laterSource = vi.fn(async () => ({ operations: [] }));
    const request = new EventEmitter();
    const response = sseResponse();
    const stream = createBotEventStream({ loadSnapshot: async (_principal, { signal }) => {
      lifetime = signal;
      await gate.promise;
      return {};
    } });
    stream.addSnapshotSource('later', laterSource);
    const opening = stream.writeSse({ principal: { id: USER_ID }, request, response });
    expect(stream.getSubscriberCount()).toBe(1);
    if (kind === 'aborted') request.emit('aborted');
    else response.emit('close');
    await opening;
    expect(lifetime.aborted).toBe(true);
    expect(stream.getSubscriberCount()).toBe(0);
    gate.resolve();
    await new Promise(setImmediate);
    expect(laterSource).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.write).not.toHaveBeenCalled();
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('keeps a completed GET subscribed and ends the response on shutdown', async () => {
    const request = new EventEmitter();
    const response = sseResponse();
    const stream = createBotEventStream();
    await stream.writeSse({ principal: { id: USER_ID }, request, response });
    request.emit('close');
    expect(stream.getSubscriberCount()).toBe(1);
    stream.shutdown();
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(stream.getSubscriberCount()).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('handles response errors between writes without an unhandled error event', async () => {
    const response = sseResponse();
    const records = [];
    const stream = createBotEventStream({ recordDiagnostic: (record) => records.push(record) });
    await stream.writeSse({ principal: { id: USER_ID }, request: new EventEmitter(), response });
    expect(() => response.emit('error', Object.assign(new Error('fixture'), { code: 'ECONNRESET' })))
      .not.toThrow();
    expect(stream.getSubscriberCount()).toBe(0);
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(records.find((record) => record.event === 'bot.events.failed').payload.code).toBe('ECONNRESET');
  });

  it('expires a stalled snapshot and releases the connection before it finishes loading', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const response = sseResponse();
    const stream = createBotEventStream({ loadSnapshot: () => gate.promise, snapshotTimeoutMs: 100 });
    try {
      const opening = stream.writeSse({ principal: { id: USER_ID }, request: new EventEmitter(), response });
      const rejected = expect(opening).rejects.toMatchObject({ code: 'bot_event_snapshot_timeout', statusCode: 503 });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(stream.getSubscriberCount()).toBe(0);
      expect(response.write).not.toHaveBeenCalled();
      gate.resolve({});
    } finally { stream.shutdown(); vi.useRealTimers(); }
  });

  it('waits for socket drain before sending queued live events', async () => {
    const written = deferred();
    const response = sseResponse();
    response.write.mockImplementationOnce(() => { written.resolve(); return false; });
    const stream = createBotEventStream();
    const opening = stream.writeSse({ principal: { id: USER_ID }, request: new EventEmitter(), response });
    await written.promise;
    await stream.publish({ kind: 'bot.updated', audienceUserIds: [USER_ID], payload: {} });
    expect(response.write).toHaveBeenCalledTimes(1);
    response.emit('drain');
    const close = await opening;
    expect(response.write).toHaveBeenCalledTimes(2);
    expect(response.write.mock.calls[1][0]).toContain('event: bot.updated');
    expect(response.listenerCount('drain')).toBe(0);
    close();
  });

  it('times out a backed-up response and removes its drain listeners', async () => {
    vi.useFakeTimers();
    const response = sseResponse();
    response.write.mockImplementation(() => false);
    const stream = createBotEventStream({ writeTimeoutMs: 100 });
    try {
      const opening = stream.writeSse({ principal: { id: USER_ID }, request: new EventEmitter(), response });
      const rejected = expect(opening).rejects.toMatchObject({ code: 'bot_event_backpressure', statusCode: 503 });
      await vi.advanceTimersByTimeAsync(101);
      await rejected;
      expect(stream.getSubscriberCount()).toBe(0);
      expect(response.destroy).toHaveBeenCalledTimes(1);
      expect(response.end).not.toHaveBeenCalled();
      expect(response.listenerCount('drain')).toBe(0);
      expect(response.listenerCount('error')).toBe(0);
    } finally { stream.shutdown(); vi.useRealTimers(); }
  });

  it('bounds visibility-pending delivery chains without disconnecting a healthy subscriber', async () => {
    const gate = deferred();
    const received = [];
    const closed = vi.fn();
    const stream = createBotEventStream({ maxPendingEvents: 2,
      canDeliver: async (principal) => { if (principal.id === USER_ID) await gate.promise; return true; } });
    await stream.open({ principal: { id: USER_ID }, send: vi.fn(), onClose: closed });
    await stream.open({ principal: { id: OTHER_ID }, send: async (event) => received.push(event.sequence) });
    const publish = () => stream.publish({ kind: 'bot.updated', audienceUserIds: [USER_ID, OTHER_ID] });
    const first = publish();
    await new Promise(setImmediate);
    const second = publish();
    await new Promise(setImmediate);
    const third = publish();
    await Promise.all([first, second, third]);
    expect(closed).toHaveBeenCalledWith('backpressure');
    expect(stream.getSubscriberCount()).toBe(1);
    expect(received).toEqual([0, 1, 2, 3]);
    gate.resolve();
    stream.shutdown();
  });

  it('also limits queued bytes, including the event envelope', async () => {
    const close = vi.fn();
    const stream = createBotEventStream({ maxPendingBytes: 200 });
    await stream.open({ principal: { id: USER_ID }, send: vi.fn(), onClose: close });
    await stream.publish({ kind: 'bot.updated', audienceUserIds: [USER_ID], payload: { value: 'x'.repeat(200) } });
    expect(close).toHaveBeenCalledWith('backpressure');
    expect(stream.getSubscriberCount()).toBe(0);
  });

  it('does not call a sender if cancellation follows a resolved visibility check', async () => {
    const send = vi.fn();
    let close;
    const stream = createBotEventStream({ canDeliver: () => {
      queueMicrotask(() => queueMicrotask(close));
      return true;
    } });
    close = await stream.open({ principal: { id: USER_ID }, send });
    await stream.publish({ kind: 'bot.updated', audienceUserIds: [USER_ID] });
    expect(stream.getSubscriberCount()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('acknowledges publication before a slow socket drains and delivers later events in order', async () => {
    const response = sseResponse();
    const stream = createBotEventStream();
    const close = await stream.writeSse({ principal: { id: USER_ID }, request: new EventEmitter(), response });
    try {
      response.write.mockImplementationOnce(() => false);
      let admitted = false;
      const first = stream.publish({ kind: 'run.started', audienceUserIds: [USER_ID] }).then(() => { admitted = true; });
      await new Promise(setImmediate);
      expect(admitted).toBe(true);
      await first;
      await stream.publish({ kind: 'run.completed', audienceUserIds: [USER_ID] });
      expect(stream.getSubscriberCount()).toBe(1);
      expect(response.write).toHaveBeenCalledTimes(2); // Snapshot and the in-flight first event.
      response.emit('drain');
      await new Promise(setImmediate);
      expect(response.write).toHaveBeenCalledTimes(3);
      expect(response.write.mock.calls[2][0]).toContain('event: run.completed');
    } finally { close(); }
  });

  it('coalesces queued full text and non-final checkpoints while preserving lifecycle order and final state', async () => {
    const gate = deferred();
    const received = [];
    const stream = createBotEventStream({ maxPendingEvents: 4, loadSnapshot: () => gate.promise });
    const opening = stream.open({ principal: { id: USER_ID }, send: async (event) => received.push(event) });
    const publish = (kind, payload) => stream.publish({ kind, botId: BOT_ID, channelId: CHANNEL_ID,
      audienceUserIds: [USER_ID], payload });
    await publish('run.started', { run: { id: 'run' } });
    for (let revision = 1; revision <= 300; revision += 1) {
      await publish('message.streaming', { messageId: 'message', revision, text: 'x'.repeat(1_000) });
      await publish('message.updated', { streamRevision: revision,
        message: { id: 'message', role: 'assistant', finalizedAt: null, body: { text: String(revision) } } });
    }
    await publish('message.updated', { message: { id: 'message', role: 'assistant', finalizedAt: '2026-09-13T00:00:00Z', body: { text: 'Final' } } });
    expect(stream.getSubscriberCount()).toBe(1);
    gate.resolve({});
    const close = await opening;
    await new Promise(setImmediate);
    expect(received.map((event) => event.sequence)).toEqual([0, 1, 600, 601, 602]);
    expect(received[2].payload.revision).toBe(300);
    expect(received.at(-1).payload.message.body.text).toBe('Final');
    close();
  });

  it('replaces only queued text and never changes a frame already being sent', async () => {
    const response = sseResponse();
    const stream = createBotEventStream({ maxPendingEvents: 2 });
    const close = await stream.writeSse({ principal: { id: USER_ID }, request: new EventEmitter(), response });
    try {
      response.write.mockImplementationOnce(() => false);
      for (const revision of [1, 2, 3]) await stream.publish({ kind: 'message.streaming',
        botId: BOT_ID, channelId: CHANNEL_ID, audienceUserIds: [USER_ID],
        payload: { messageId: 'message', revision, text: String(revision) } });
      expect(stream.getSubscriberCount()).toBe(1);
      expect(response.write).toHaveBeenCalledTimes(2);
      response.emit('drain');
      await new Promise(setImmediate);
      const events = response.write.mock.calls.slice(1).map(([frame]) => JSON.parse(frame.split('data: ')[1].trim()));
      expect(events.map((event) => event.payload.revision)).toEqual([1, 3]);
    } finally { close(); }
  });

  it('allows steady snapshot transfer beyond the loading deadline while bounding each send', async () => {
    vi.useFakeTimers();
    const sent = [];
    const stream = createBotEventStream({ snapshotTimeoutMs: 75, writeTimeoutMs: 100,
      loadSnapshot: async () => ({ text: 'x'.repeat(300_000) }) });
    try {
      const opening = stream.open({ principal: { id: USER_ID }, snapshotFormat: BOT_SNAPSHOT_FORMAT,
        send: async (event) => { await new Promise((resolve) => setTimeout(resolve, 50)); sent.push(event); } });
      const result = expect(opening).resolves.toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      expect(sent.length).toBeGreaterThan(1);
      expect(stream.getSubscriberCount()).toBe(1);
    } finally { stream.shutdown(); vi.useRealTimers(); }
  });

  it('bounds the whole snapshot transfer even when every individual send keeps progressing', async () => {
    vi.useFakeTimers();
    const stream = createBotEventStream({ loadSnapshot: async () => ({ text: 'x'.repeat(300_000) }) });
    const send = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 3_000)); });
    try {
      const opening = stream.open({ principal: { id: USER_ID }, snapshotFormat: BOT_SNAPSHOT_FORMAT, send });
      const result = expect(opening).rejects.toMatchObject({ code: 'bot_event_snapshot_transfer_timeout' });
      await vi.advanceTimersByTimeAsync(21_000);
      await result;
      expect(stream.getSubscriberCount()).toBe(0);
      expect(send).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(send).toHaveBeenCalledTimes(7);
      expect(vi.getTimerCount()).toBe(0);
    } finally { stream.shutdown(); vi.useRealTimers(); }
  });

  it('records the failing snapshot source without recording content or credentials', async () => {
    const records = [];
    const stream = createBotEventStream({
      recordDiagnostic: (entry) => records.push(entry),
      loadSnapshot: async () => ({ privateText: 'private snapshot content' }),
    });
    stream.addSnapshotSource('operations', async () => {
      throw Object.assign(new Error('private credential or database error'), { code: 'bot_fixture_unavailable', statusCode: 503 });
    });
    await expect(stream.open({ principal: { id: USER_ID }, send: vi.fn() }))
      .rejects.toMatchObject({ code: 'bot_fixture_unavailable' });
    expect(records.at(-1)).toMatchObject({
      type: 'connection', event: 'bot.events.failed',
      payload: { stage: 'snapshot.operations', code: 'bot_fixture_unavailable', statusCode: 503 },
    });
    expect(new Set(records.map((entry) => entry.payload.subscriptionId)).size).toBe(1);
    expect(records.at(-1).payload.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(records)).not.toContain('private');
    expect(JSON.stringify(records)).not.toContain(USER_ID);
    expect(stream.getSubscriberCount()).toBe(0);
  });

  it('records snapshot size before a serialization limit rejects the stream', async () => {
    const records = [];
    const snapshot = { content: 'x'.repeat(256 * 1024) };
    const stream = createBotEventStream({
      loadSnapshot: async () => snapshot,
      recordDiagnostic: (entry) => records.push(entry),
    });
    await expect(stream.open({ principal: { id: USER_ID }, send: vi.fn() }))
      .rejects.toMatchObject({ code: 'bot_event_too_large' });
    expect(records.at(-1)).toMatchObject({
      event: 'bot.events.failed',
      payload: { stage: 'snapshot.serialize', snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), statusCode: 413 },
    });
    expect(JSON.stringify(records)).not.toContain(snapshot.content);
    expect(stream.getSubscriberCount()).toBe(0);
  });

  it('records HTTP connection and one close reason and releases its heartbeat', async () => {
    vi.useFakeTimers();
    const records = [];
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200, writableEnded: false, destroyed: false,
      write: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(),
    });
    const request = new EventEmitter();
    const stream = createBotEventStream({ recordDiagnostic: (entry) => records.push(entry), heartbeatMs: 1_000 });
    try {
      const close = await stream.writeSse({ principal: { id: USER_ID }, request, response });
      expect(records.find((entry) => entry.event === 'bot.events.connected')).toMatchObject({ payload: { statusCode: 200 } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(response.write).toHaveBeenLastCalledWith(': heartbeat\n\n');
      response.emit('close');
      request.emit('close');
      close();
      expect(records.filter((entry) => entry.event === 'bot.events.closed')).toHaveLength(1);
      expect(records.at(-1).payload.reason).toBe('response_closed');
      const writes = response.write.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(response.write).toHaveBeenCalledTimes(writes);
      expect(stream.getSubscriberCount()).toBe(0);
    } finally {
      stream.shutdown();
      vi.useRealTimers();
    }
  });

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
