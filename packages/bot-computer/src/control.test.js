import { describe, expect, test } from 'bun:test';
import { createControlLeaseManager } from './control.js';

const user = (actorId) => ({ actorId, actorType: 'user' });

describe('actor-attributed computer control lease', () => {
  test('keeps agents fenced until held input cleanup completes', async () => {
    let finishRelease;
    const cleanup = new Promise((resolve) => { finishRelease = resolve; });
    const control = createControlLeaseManager({ releaseInput: () => cleanup });
    const lease = control.take(user('user-01'));
    let resumed = false;
    const waiting = control.waitForAgent().then(() => { resumed = true; });
    const returned = control.returnControl({ ...user('user-01'), leaseId: lease.leaseId });
    try {
      await Promise.resolve();
      expect(resumed).toBe(false);
      expect(() => control.assertAgentAvailable()).toThrow();
      expect(() => control.assertOwner({ ...user('user-01'), leaseId: lease.leaseId })).toThrow();
    } finally { finishRelease(); await returned; await waiting; }
    expect(control.assertAgentAvailable()).toBe(true);
  });

  test('natural expiry releases held input before lifting the agent fence', async () => {
    let timestamp = 1_000;
    let finishRelease;
    let releases = 0;
    const cleanup = new Promise((resolve) => { finishRelease = resolve; });
    const control = createControlLeaseManager({ ttlMs: 1_000, now: () => timestamp,
      releaseInput: () => { releases += 1; return cleanup; } });
    control.take(user('user-01'));
    timestamp = 2_001;
    expect(() => control.assertAgentAvailable()).toThrow();
    expect(releases).toBe(1);
    control.snapshot();
    expect(releases).toBe(1);
    const waiting = control.waitForAgent();
    finishRelease();
    await waiting;
    expect(control.snapshot()).toBeNull();
  });

  test('cleanup failure remains explicit and fenced until the owner retries successfully', async () => {
    let failRelease = true;
    const control = createControlLeaseManager({ releaseInput: async () => {
      if (failRelease) throw new Error('CDP unavailable');
    } });
    const lease = control.take(user('user-01'));
    const owner = { ...user('user-01'), leaseId: lease.leaseId };
    const waiting = control.waitForAgent().catch((error) => error);
    await expect(control.returnControl(owner)).rejects.toMatchObject({ code: 'DEVRYAN_BOT_CONTROL_RELEASE_FAILED' });
    expect(await waiting).toMatchObject({ code: 'DEVRYAN_BOT_CONTROL_RELEASE_FAILED' });
    expect(() => control.assertAgentAvailable()).toThrow(expect.objectContaining({ code: 'DEVRYAN_BOT_CONTROL_RELEASE_FAILED' }));
    expect(() => control.take(user('user-02'))).toThrow();
    failRelease = false;
    await control.returnControl(owner);
    expect(control.assertAgentAvailable()).toBe(true);
  });

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

  test('exposes an immediate pre-execution fence and clears it on natural expiry', () => {
    let timestamp = 1_000;
    const control = createControlLeaseManager({
      ttlMs: 5_000,
      now: () => timestamp,
      randomBytes: () => Buffer.alloc(18, 5),
    });
    control.take(user('user-01'));
    expect(() => control.assertAgentAvailable()).toThrow(expect.objectContaining({
      code: 'DEVRYAN_BOT_CONTROL_HELD',
    }));
    timestamp = 6_001;
    expect(control.assertAgentAvailable()).toBe(true);
  });
});
