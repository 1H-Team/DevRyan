import { describe, expect, test } from 'bun:test';
import { createControlLeaseManager } from './control.js';

const user = (actorId) => ({ actorId, actorType: 'user' });

describe('actor-attributed computer control lease', () => {
  test('refuses concurrent human control and attributes take, heartbeat, and return', () => {
    let timestamp = 1_000;
    const events = [];
    const control = createControlLeaseManager({
      ttlMs: 5_000,
      now: () => timestamp,
      randomBytes: () => Buffer.alloc(18, 3),
      onEvent: (event) => events.push(event),
    });
    const lease = control.take(user('user-01'));
    expect(() => control.take(user('user-02'))).toThrow(expect.objectContaining({
      code: 'DEVRYAN_BOT_CONTROL_CONFLICT',
    }));
    timestamp += 500;
    control.heartbeat({ ...user('user-01'), leaseId: lease.leaseId });
    timestamp += 500;
    control.returnControl({ ...user('user-01'), leaseId: lease.leaseId });
    expect(events.map(({ type, actorId }) => [type, actorId])).toEqual([
      ['taken', 'user-01'],
      ['heartbeat', 'user-01'],
      ['returned', 'user-01'],
    ]);
  });

  test('pauses an agent command until the person returns control', async () => {
    const control = createControlLeaseManager({
      ttlMs: 5_000,
      randomBytes: () => Buffer.alloc(18, 4),
    });
    const lease = control.take(user('user-01'));
    let resumed = false;
    const waiting = control.waitForAgent().then(() => { resumed = true; });
    await Promise.resolve();
    expect(resumed).toBe(false);
    control.returnControl({ ...user('user-01'), leaseId: lease.leaseId });
    await waiting;
    expect(resumed).toBe(true);
  });
});
