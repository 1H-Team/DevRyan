import { describe, expect, it } from 'vitest';

import { createBoundedEventQueue } from './bounded-event-queue.js';
import { eventEntryBytes, eventPayloadBytes, serializeEventPayload } from './payload-serialization.js';
import { sendMessageStreamWsEvent, serializeMessageStreamWsEvent } from './protocol.js';
import { serializeMessageStreamSseEvent } from './runtime.js';

const payloads = [
  { type: 'message.part.updated', properties: { part: { id: 'p', text: 'héllo "quoted"   🚀', n: [1, null, true] } } },
  { type: 'openchamber:heartbeat', timestamp: 1 },
  {},
  [],
  'text',
  0,
  null,
  undefined,
];
const options = [{}, { eventId: 'evt-1' }, { directory: '/repo' }, { eventId: 'evt-1', directory: '/repo' }, { eventId: '', directory: '' }];

// The frames the handlers produced before serialization was shared.
const legacyWsFrame = (payload, { eventId, directory } = {}) => JSON.stringify({
  type: 'event',
  payload,
  ...(typeof eventId === 'string' && eventId.length > 0 ? { eventId } : {}),
  ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
});
const legacySseFrame = ({ payload, directory, eventId }) => {
  const lines = [];
  if (typeof eventId === 'string' && eventId.length > 0) lines.push(`id: ${eventId}`);
  lines.push(`data: ${JSON.stringify({
    ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
    payload,
  })}`);
  return `${lines.join('\n')}\n\n`;
};

describe('shared event payload serialization', () => {
  it('produces byte-identical websocket and SSE frames', () => {
    for (const payload of payloads) {
      for (const option of options) {
        expect(serializeMessageStreamWsEvent(payload, option)).toBe(legacyWsFrame(payload, option));
        expect(serializeMessageStreamSseEvent({ payload, ...option })).toBe(legacySseFrame({ payload, ...option }));
      }
      expect(serializeEventPayload(payload)).toBe(JSON.stringify(payload));
      const json = JSON.stringify(payload);
      expect(eventPayloadBytes(payload)).toBe(json === undefined ? 0 : Buffer.byteLength(json, 'utf8'));
    }
  });

  it('serializes a payload once for queue accounting and every client frame', async () => {
    let reads = 0;
    const payload = { type: 'message.part.updated', get properties() { reads += 1; return { text: 'x'.repeat(1_000) }; } };
    const entry = { payload, directory: '/repo', eventId: 'evt-1' };
    const sockets = Array.from({ length: 3 }, () => ({ readyState: 1, bufferedAmount: 0, sent: [], send(frame) { this.sent.push(frame); } }));

    for (const socket of sockets) {
      const queue = createBoundedEventQueue({
        getBufferedBytes: () => socket.bufferedAmount,
        deliver: async ({ payload: next, directory, eventId }) => sendMessageStreamWsEvent(socket, next, { directory, eventId }),
      });
      expect(await queue.enqueue(entry)).toBe(true);
    }
    serializeMessageStreamSseEvent(entry);

    expect(reads).toBe(1);
    expect(new Set(sockets.map((socket) => socket.sent[0])).size).toBe(1);
    expect(eventEntryBytes(entry)).toBeGreaterThan(1_000);
  });
});
