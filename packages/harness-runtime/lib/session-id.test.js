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

describe('host managed-task journal identities', () => {
  const record = (task = {}) => ({ sessionID: null, directory: null,
    payload: { type: 'openchamber:managed-task', properties: { owner: 'devryan',
      task: { owner: 'devryan', rootSessionId: 'root', childSessionId: 'child', ...task } } } });
  test('resolves runtime-bucket task events and child relations without native session-created history', () => {
    expect(resolveRecordSessionID(record())).toBe('root');
    expect(resolveSessionRelation(record())).toEqual({ sessionID: 'child', parentID: 'root' });
    expect(resolveSessionRelation(record({ childSessionId: null }))).toBeNull();
    expect(resolveSessionRelation(record({ childSessionId: 'root' }))).toBeNull();
    expect(resolveRecordSessionID({ payload: { type: 'openchamber:managed-task-removed',
      properties: { owner: 'devryan', rootSessionId: 'root' } } })).toBe('root');
  });
  test('does not derive managed identities from unknown ownership, generic metadata or conflicting explicit sessions', () => {
    const unknown = record(); unknown.payload.properties.owner = 'unknown';
    expect(resolveRecordSessionID(unknown)).toBe(''); expect(resolveSessionRelation(unknown)).toBeNull();
    expect(resolveRecordSessionID(record({ owner: 'unknown' }))).toBe('');
    const generic = record(); generic.payload.type = 'message.updated';
    expect(resolveRecordSessionID(generic)).toBe(''); expect(resolveSessionRelation(generic)).toBeNull();
    const conflicting = { ...record(), sessionID: 'different-root' };
    expect(resolveRecordSessionID(conflicting)).toBe('different-root');
    expect(resolveSessionRelation(conflicting)).toBeNull();
    expect(resolveRecordSessionID({ payload: { type: 'openchamber:managed-task-removed',
      properties: { owner: 'unknown', rootSessionId: 'root' } } })).toBe('');
  });
});
