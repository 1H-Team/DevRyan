import { describe, expect, it } from 'vitest';
import { applyEventDialect, resolveEventDialect } from './event-dialect.js';
import { serializeEventPayload } from './payload-serialization.js';
import { serializeMessageStreamWsEvent } from './protocol.js';
import { serializeMessageStreamSseEvent } from './runtime.js';

describe('event-name dialect', () => {
  it('opts in only by the query value or header, case-insensitively', () => {
    expect(resolveEventDialect({ query: { events: 'devryan' } })).toBe('devryan');
    expect(resolveEventDialect({ url: '/api/global/event/ws?clientID=x&events=DevRyan' })).toBe('devryan');
    expect(resolveEventDialect({ headers: { 'x-devryan-events': 'devryan' } })).toBe('devryan');
    expect(resolveEventDialect({ url: '/api/global/event/ws?events=other' })).toBeNull();
    expect(resolveEventDialect({ query: {}, headers: {} })).toBeNull();
    expect(resolveEventDialect(undefined)).toBeNull();
  });

  it('renames only a leading openchamber: type and keeps the shared serialization', () => {
    const payload = { type: 'openchamber:managed-task', properties: { note: 'openchamber:kept' } };
    expect(serializeEventPayload(payload)).toBe(JSON.stringify(payload));
    expect(serializeEventPayload(payload, 'devryan')).toBe(JSON.stringify({ ...payload, type: 'devryan:managed-task' }));
    const canonical = { ...payload, type: 'devryan:managed-task' };
    expect(serializeEventPayload(canonical)).toBe(JSON.stringify(payload));
    expect(serializeEventPayload(canonical, 'devryan')).toBe(JSON.stringify(canonical));
    expect(applyEventDialect('{"type":"session.status"}', 'devryan')).toBe('{"type":"session.status"}');
    expect(applyEventDialect('{"properties":{},"type":"openchamber:x"}', 'devryan')).toBe('{"properties":{},"type":"openchamber:x"}');
  });

  it('frames WebSocket and SSE events per connection', () => {
    const payload = { type: 'openchamber:heartbeat', timestamp: 1 };
    expect(JSON.parse(serializeMessageStreamWsEvent(payload, { directory: 'global' })).payload.type).toBe('openchamber:heartbeat');
    expect(JSON.parse(serializeMessageStreamWsEvent(payload, { directory: 'global', dialect: 'devryan' })).payload.type).toBe('devryan:heartbeat');
    const sse = serializeMessageStreamSseEvent({ payload, directory: 'global', eventId: '7' }, 'devryan');
    expect(JSON.parse(sse.split('\n').find(line => line.startsWith('data: ')).slice(6)).payload.type).toBe('devryan:heartbeat');
    expect(serializeMessageStreamSseEvent({ payload, directory: 'global' })).toContain('"type":"openchamber:heartbeat"');
    expect(serializeMessageStreamSseEvent({ payload: { ...payload, type: 'devryan:heartbeat' }, directory: 'global' }))
      .toContain('"type":"openchamber:heartbeat"');
  });
});
