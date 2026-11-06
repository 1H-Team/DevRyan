import { describe, expect, test } from 'bun:test';
import {
  decodeDisplaySession,
  decodeDisplaySessionList,
  decodeSessionEventInfo,
  readSessionLifecycle,
} from './display-session';

const raw = (extra: Record<string, unknown> = {}, time: Record<string, unknown> = {}) => ({
  id: 'ses_1',
  title: 'Session',
  time: { created: 1, updated: 2, ...time },
  ...extra,
});

describe('decodeDisplaySession', () => {
  test('returns the same reference for valid lifecycle and fork facts', () => {
    const value = raw(
      { outcome: 'failed', fork: { sessionID: 'ses_0', boundary: { type: 'before', messageID: 'msg_1' } } },
      { busy: 10, idle: 20, viewed: 0 },
    );
    const decoded = decodeDisplaySession(value);

    expect(decoded).toBe(value);
    expect(decoded ? readSessionLifecycle(decoded) : null).toEqual({
      busy: 10,
      idle: 20,
      viewed: 0,
      outcome: 'failed',
      fork: { sessionID: 'ses_0', boundary: { type: 'before', messageID: 'msg_1' } },
    });
  });

  test('returns plain sessions unchanged', () => {
    const value = raw();
    expect(decodeDisplaySession(value)).toBe(value);
  });

  test('drops invalid lifecycle values and keeps the rest of the record', () => {
    const decoded = decodeDisplaySession(raw(
      { outcome: 'done', fork: { sessionID: 'ses_0', boundary: { type: 'after', messageID: 'msg_1' } } },
      { busy: Number.NaN, idle: -1, viewed: '5' },
    ));

    expect(decoded).toEqual({ id: 'ses_1', title: 'Session', time: { created: 1, updated: 2 } });
    expect(decoded ? Object.hasOwn(decoded, 'outcome') : true).toBe(false);
    expect(decoded ? Object.hasOwn(decoded.time, 'busy') : true).toBe(false);
  });

  test('drops a fork without a source session or boundary message', () => {
    expect(decodeDisplaySession(raw({ fork: { sessionID: '', boundary: { type: 'through', messageID: 'm' } } }))?.fork)
      .toBeUndefined();
    expect(decodeDisplaySession(raw({ fork: { sessionID: 's', boundary: { type: 'through', messageID: '' } } }))?.fork)
      .toBeUndefined();
    expect(decodeDisplaySession(raw({ fork: { sessionID: 's' } }))?.fork).toBeUndefined();
  });

  test('rejects values without a session identity', () => {
    expect(decodeDisplaySession(null)).toBeNull();
    expect(decodeDisplaySession({ id: '', time: {} })).toBeNull();
    expect(decodeDisplaySession({ id: 'ses_1' })).toBeNull();
    expect(decodeDisplaySession([raw()])).toBeNull();
  });

  test('decodes event info and REST lists', () => {
    const value = raw({}, { idle: 5 });
    expect(decodeSessionEventInfo({ sessionID: 'ses_1', info: value })).toBe(value);
    expect(decodeSessionEventInfo({ info: 'nope' })).toBeNull();
    expect(decodeSessionEventInfo(undefined)).toBeNull();
    expect(decodeDisplaySessionList([value, null, { id: 'x' }])).toEqual([value]);
    expect(decodeDisplaySessionList(undefined)).toEqual([]);
  });
});
