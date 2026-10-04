import { describe, expect, it } from 'vitest';

import { parseV2EventBlock } from '../opencode/opencode-client/v2.js';
import {
  createMessageStreamGapControlPayload,
  isMessageStreamControlPayload,
  MESSAGE_STREAM_GAP_CONTROL_TYPE,
  MESSAGE_STREAM_UPSTREAM_KEEPALIVE,
  serializeMessageStreamWsEvent,
  toUpstreamV2SseEvent,
  MESSAGE_STREAM_DIRECTORY_WS_PATH,
  MESSAGE_STREAM_GLOBAL_WS_PATH,
  MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES,
  MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES,
  parseSseEventEnvelope,
  sendMessageStreamWsEvent,
  sendMessageStreamWsFrame,
} from './protocol.js';

describe('event stream protocol helpers', () => {
  it('exports stable websocket paths', () => {
    expect(MESSAGE_STREAM_GLOBAL_WS_PATH).toBe('/api/global/event/ws');
    expect(MESSAGE_STREAM_DIRECTORY_WS_PATH).toBe('/api/event/ws');
  });

  it('parses wrapped SSE payloads with event id and directory', () => {
    const envelope = parseSseEventEnvelope(
      'id: evt-1\n' +
      'event: message\n' +
      'data: {"directory":"/tmp/project","payload":{"type":"session.updated"}}\n'
    );

    expect(envelope).toEqual({
      eventId: 'evt-1',
      directory: '/tmp/project',
      payload: { type: 'session.updated' },
    });
  });

  it('derives directory from payload properties when not wrapped', () => {
    const envelope = parseSseEventEnvelope(
      'data: {"type":"openchamber:notification","properties":{"directory":"/tmp/project"}}\n'
    );

    expect(envelope).toEqual({
      eventId: null,
      directory: '/tmp/project',
      payload: {
        type: 'openchamber:notification',
        properties: { directory: '/tmp/project' },
      },
    });
  });

  it('returns null for malformed SSE blocks', () => {
    expect(parseSseEventEnvelope('event: message\n')).toBeNull();
    expect(parseSseEventEnvelope('data: {oops}\n')).toBeNull();
  });

  it('serializes generic websocket frames', () => {
    let rawPayload = null;
    const socket = {
      readyState: 1,
      send(payload) {
        rawPayload = payload;
      },
    };

    const sent = sendMessageStreamWsFrame(socket, { type: 'ready' });

    expect(sent).toBe(true);
    expect(rawPayload).toBe('{"type":"ready"}');
  });

  it('closes slow websocket clients instead of adding more buffered data', () => {
    let closeCall = null;
    let sendCalls = 0;
    const socket = {
      readyState: 1,
      bufferedAmount: MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES + 1,
      send() {
        sendCalls += 1;
      },
      close(code, reason) {
        closeCall = { code, reason };
      },
    };

    const sent = sendMessageStreamWsFrame(socket, { type: 'ready' });

    expect(sent).toBe(false);
    expect(sendCalls).toBe(0);
    expect(closeCall).toEqual({
      code: 1013,
      reason: 'Message stream client is too slow',
    });
  });

  it('emits a backpressure warning when buffer exceeds the warn threshold', () => {
    const sentPayloads = [];
    const socket = {
      readyState: 1,
      bufferedAmount: MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES + 1,
      send(payload) {
        sentPayloads.push(payload);
      },
    };

    const sent = sendMessageStreamWsFrame(socket, { type: 'test' });

    expect(sent).toBe(true);
    expect(sentPayloads).toHaveLength(2);

    const warning = JSON.parse(sentPayloads[1]);
    expect(warning.type).toBe('backpressure');
    expect(warning.bufferedBytes).toBeGreaterThan(0);
    expect(warning.maxBytes).toBe(MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES);
  });

  it('does not repeat backpressure warnings while still above threshold', () => {
    const sentPayloads = [];
    const socket = {
      readyState: 1,
      bufferedAmount: MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES + 1,
      send(payload) {
        sentPayloads.push(payload);
      },
    };

    sendMessageStreamWsFrame(socket, { type: 'test1' });
    sendMessageStreamWsFrame(socket, { type: 'test2' });

    // First call: data + warning = 2 sends.  Second call: data only = 1 send.
    expect(sentPayloads).toHaveLength(3);
    expect(JSON.parse(sentPayloads[1]).type).toBe('backpressure');
    expect(JSON.parse(sentPayloads[2])).toEqual({ type: 'test2' });
  });

  it('resets backpressure warning flag when buffer drains', () => {
    const sentPayloads = [];
    const socket = {
      readyState: 1,
      bufferedAmount: MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES + 1,
      send(payload) {
        sentPayloads.push(payload);
      },
    };

    sendMessageStreamWsFrame(socket, { type: 'first' });
    expect(socket._ocBackpressureWarned).toBe(true);

    // Buffer drains
    socket.bufferedAmount = 100;
    sendMessageStreamWsFrame(socket, { type: 'recovered' });
    expect(socket._ocBackpressureWarned).toBe(false);

    // Buffer spikes again — warning should fire again
    socket.bufferedAmount = MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES + 1;
    sendMessageStreamWsFrame(socket, { type: 'again' });
    const backpressureFrames = sentPayloads
      .map((p) => JSON.parse(p))
      .filter((p) => p.type === 'backpressure');
    expect(backpressureFrames).toHaveLength(2);
  });

  it('serializes event frames with routing metadata', () => {
    let rawPayload = null;
    const socket = {
      readyState: 1,
      send(payload) {
        rawPayload = payload;
      },
    };

    const sent = sendMessageStreamWsEvent(
      socket,
      { type: 'openchamber:heartbeat', timestamp: 1 },
      { eventId: 'evt-2', directory: '/tmp/project' }
    );

    expect(sent).toBe(true);
    expect(JSON.parse(rawPayload)).toEqual({
      type: 'event',
      payload: { type: 'openchamber:heartbeat', timestamp: 1 },
      eventId: 'evt-2',
      directory: '/tmp/project',
    });
  });

  it('adapts gen-2 data-only frames to the reader without an SSE id and comments to keepalive', () => {
    const frame = 'data: {"id":"evt_1","created":1,"type":"session.renamed","location":{"directory":"/tmp/p"},"data":{"sessionID":"ses_1","title":"T"}}';
    const adapted = toUpstreamV2SseEvent(parseV2EventBlock(frame));
    expect(adapted).toEqual({
      eventId: null,
      upstreamEventId: 'evt_1',
      directory: '/tmp/p',
      payload: { id: 'evt_1', created: 1, type: 'session.renamed', location: { directory: '/tmp/p' }, data: { sessionID: 'ses_1', title: 'T' } },
    });
    expect(toUpstreamV2SseEvent(parseV2EventBlock(': heartbeat'))).toBe(MESSAGE_STREAM_UPSTREAM_KEEPALIVE);
    expect(toUpstreamV2SseEvent(parseV2EventBlock('data: {"id":"evt_2","type":"server.connected","data":{}}'))).toMatchObject({
      upstreamEventId: 'evt_2',
      directory: null,
    });
    expect(toUpstreamV2SseEvent(parseV2EventBlock('data: not-json'))).toBeNull();
    expect(toUpstreamV2SseEvent(null)).toBeNull();
  });

  it('serializes hub gap control payloads as top-level gap frames and never trusts the type string alone', () => {
    const control = createMessageStreamGapControlPayload({ scope: 'global', reason: 'upstream_reconnect' });
    expect(control.type).toBe(MESSAGE_STREAM_GAP_CONTROL_TYPE);
    expect(isMessageStreamControlPayload(control)).toBe(true);
    expect(JSON.parse(serializeMessageStreamWsEvent(control, { eventId: 'ignored', directory: 'global' })))
      .toEqual({ type: 'gap', scope: 'global', reason: 'upstream_reconnect' });

    const forged = { type: MESSAGE_STREAM_GAP_CONTROL_TYPE, properties: { scope: 'global' } };
    expect(isMessageStreamControlPayload(forged)).toBe(false);
    expect(JSON.parse(serializeMessageStreamWsEvent(forged))).toEqual({ type: 'event', payload: forged });

    let raw = null;
    expect(sendMessageStreamWsEvent({ readyState: 1, send(value) { raw = value; } }, createMessageStreamGapControlPayload())).toBe(true);
    expect(JSON.parse(raw)).toEqual({ type: 'gap', scope: 'global' });
  });
});
