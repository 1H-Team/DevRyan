import { describe, expect, test } from 'bun:test';

import { resolveRecordSessionID, resolveSessionRelation } from './session-id.js';

describe('diagnostic session resolution', () => {
  test('uses the four explicit locations in precedence order', () => {
    expect(resolveRecordSessionID({ sessionID: 'top' })).toBe('top');
    expect(resolveRecordSessionID({ payload: { sessionID: 'payload' } })).toBe('payload');
    expect(resolveRecordSessionID({ payload: { properties: { sessionID: 'properties' } } })).toBe('properties');
    expect(resolveRecordSessionID({ payload: { properties: { info: { sessionID: 'info' } } } })).toBe('info');
  });

  test('uses session event info ids and resolves parent relations', () => {
    const record = {
      payload: {
        type: 'session.created',
        properties: { info: { id: 'child', parentID: 'root' } },
      },
    };
    expect(resolveRecordSessionID(record)).toBe('child');
    expect(resolveSessionRelation(record)).toEqual({ sessionID: 'child', parentID: 'root' });
    expect(resolveSessionRelation({ payload: { type: 'message.updated' } })).toBeNull();
  });
});
