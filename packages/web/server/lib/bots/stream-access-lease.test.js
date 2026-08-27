import { describe, expect, it, vi } from 'vitest';

import { createBotStreamAccessLeases } from './stream-access-lease.js';

const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe('Production Bot requester stream access lease', () => {
  it('uses authoritative admission briefly, then revalidates and fails closed', async () => {
    let clock = 0;
    const revalidate = vi.fn(async () => ({
      bot: { id: BOT_ID },
      channel: { id: CHANNEL_ID },
    }));
    const leases = createBotStreamAccessLeases({ revalidate, now: () => clock, ttlMs: 1_000 });
    leases.establish({
      principal: { id: USER_ID, role: 'developer', scope: 'managed' },
      channelId: CHANNEL_ID,
      botId: BOT_ID,
    });
    expect(leases.isAuthorized({ channelId: CHANNEL_ID, userId: USER_ID })).toBe(true);
    await expect(leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID })).resolves.toBe(true);
    expect(revalidate).not.toHaveBeenCalled();
    clock = 1_001;
    await expect(leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID })).resolves.toBe(true);
    expect(revalidate).toHaveBeenCalledTimes(1);

    clock = 2_002;
    revalidate.mockRejectedValueOnce(new Error('uncertain'));
    await expect(leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID })).resolves.toBe(false);
    await expect(leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID })).resolves.toBe(false);
  });

  it('invalidates channel, user, and principal-reset access synchronously', async () => {
    const leases = createBotStreamAccessLeases({ revalidate: vi.fn() });
    const establish = () => leases.establish({
      principal: { id: USER_ID }, channelId: CHANNEL_ID, botId: BOT_ID,
    });
    establish();
    leases.invalidateChannel(CHANNEL_ID);
    expect(leases.isAuthorized({ channelId: CHANNEL_ID, userId: USER_ID })).toBe(false);
    await expect(leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID })).resolves.toBe(false);
    establish();
    leases.invalidateUser(USER_ID);
    await expect(leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID })).resolves.toBe(false);
    establish();
    leases.invalidateAll();
    await expect(leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID })).resolves.toBe(false);
  });

  it('cannot resurrect a lease invalidated during periodic revalidation', async () => {
    let clock = 0;
    const decision = deferred();
    const leases = createBotStreamAccessLeases({
      revalidate: () => decision.promise,
      now: () => clock,
      ttlMs: 1_000,
    });
    leases.establish({
      principal: { id: USER_ID }, channelId: CHANNEL_ID, botId: BOT_ID,
    });
    clock = 1_001;
    const authorization = leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID });
    await Promise.resolve();
    leases.invalidateChannel(CHANNEL_ID);
    decision.resolve({ bot: { id: BOT_ID }, channel: { id: CHANNEL_ID } });

    await expect(authorization).resolves.toBe(false);
    await expect(leases.authorize({ channelId: CHANNEL_ID, userId: USER_ID })).resolves.toBe(false);
  });
});
