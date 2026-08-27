import { validateUuid } from './validation.js';

const DEFAULT_TTL_MS = 15_000;

export function createBotStreamAccessLeases({
  revalidate,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (typeof revalidate !== 'function' || typeof now !== 'function'
    || !Number.isFinite(ttlMs) || ttlMs < 1_000) {
    throw new TypeError('Bot stream access leases are misconfigured');
  }
  const leases = new Map();
  const keyFor = (channelId, userId) => `${channelId}:${userId}`;

  return Object.freeze({
    establish({ principal, channelId, botId } = {}) {
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const userId = validateUuid(principal?.id, 'principal.id');
      const normalizedBotId = validateUuid(botId, 'botId');
      const key = keyFor(normalizedChannelId, userId);
      const replaced = leases.get(key);
      if (replaced) replaced.invalidated = true;
      leases.set(key, {
        channelId: normalizedChannelId,
        botId: normalizedBotId,
        principal: Object.freeze({
          id: userId,
          role: principal?.role || null,
          scope: principal?.scope || null,
        }),
        expiresAt: now() + ttlMs,
        revalidation: null,
        invalidated: false,
      });
    },

    async authorize({ channelId, userId } = {}) {
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const normalizedUserId = validateUuid(userId, 'userId');
      const key = keyFor(normalizedChannelId, normalizedUserId);
      const lease = leases.get(key);
      if (!lease || lease.invalidated) return false;
      if (lease.expiresAt > now()) return true;
      lease.revalidation ||= Promise.resolve().then(async () => {
        try {
          if (lease.invalidated || leases.get(key) !== lease) return false;
          const decision = await revalidate({
            principal: lease.principal,
            channelId: lease.channelId,
          });
          if (lease.invalidated || leases.get(key) !== lease
            || decision?.bot?.id !== lease.botId || decision?.channel?.id !== lease.channelId) {
            if (leases.get(key) === lease) leases.delete(key);
            return false;
          }
          lease.expiresAt = now() + ttlMs;
          return true;
        } catch {
          if (leases.get(key) === lease) leases.delete(key);
          return false;
        } finally {
          lease.revalidation = null;
        }
      });
      return lease.revalidation;
    },

    isAuthorized({ channelId, userId } = {}) {
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const normalizedUserId = validateUuid(userId, 'userId');
      const lease = leases.get(keyFor(normalizedChannelId, normalizedUserId));
      return Boolean(lease && !lease.invalidated && lease.expiresAt > now());
    },

    invalidateChannel(channelId) {
      const normalized = validateUuid(channelId, 'channelId');
      for (const [key, lease] of leases) {
        if (lease.channelId === normalized) {
          lease.invalidated = true;
          leases.delete(key);
        }
      }
    },

    invalidateUser(userId) {
      const normalized = validateUuid(userId, 'userId');
      for (const [key, lease] of leases) {
        if (lease.principal.id === normalized) {
          lease.invalidated = true;
          leases.delete(key);
        }
      }
    },

    invalidateAll() {
      for (const lease of leases.values()) lease.invalidated = true;
      leases.clear();
    },
  });
}
