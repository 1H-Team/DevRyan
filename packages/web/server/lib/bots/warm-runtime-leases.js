import { botErrorLogFields } from './error-normalization.js';

// A runtime kept warm for ten minutes covers the pause between a reply and the
// next message far more often than two, at the cost of one idle container.
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_LEASES = 2;
const SAFE_PREPARATION_STAGES = new Set([
  'gateway',
  'config',
  'credentials',
  'environment',
  'artifacts',
  'container',
  'readiness',
  'admission',
  'unknown',
]);

const safeErrorCode = (value) => (
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(value)
    ? value
    : 'bot_warm_prepare_failed'
);

const safePreparationStage = (value) => (
  SAFE_PREPARATION_STAGES.has(value) ? value : 'unknown'
);

const publicLease = (entry) => Object.freeze({
  state: entry.state,
  leaseId: entry.id,
  revisionId: entry.revisionId,
  expiresAt: new Date(entry.expiresAt).toISOString(),
  reason: null,
  serverInitiated: entry.serverInitiated === true,
});

const adoptEntry = async (entry, messageId, note) => {
  entry.claimedMessageId = messageId;
  if (entry.timer) clearTimeout(entry.timer);
  try {
    await entry.promise;
  } catch {
    return Object.freeze({ hit: false, runId: null });
  }
  note('warm_hit', entry);
  note('lease_adopted', entry, { messageId });
  return Object.freeze({ hit: true, runId: entry.runId });
};

export function createBotWarmRuntimeLeases({
  prepare,
  stop,
  uuid,
  now = () => Date.now(),
  idleTtlMs = DEFAULT_IDLE_TTL_MS,
  maxLeases = DEFAULT_MAX_LEASES,
  record = () => {},
  logger = console,
} = {}) {
  if (typeof prepare !== 'function' || typeof stop !== 'function'
    || typeof uuid !== 'function' || typeof now !== 'function'
    || !Number.isFinite(idleTtlMs) || idleTtlMs < 1_000
    || !Number.isSafeInteger(maxLeases) || maxLeases < 1
    || typeof record !== 'function') {
    throw new TypeError('Bot warm runtime leases are misconfigured');
  }

  const leases = new Map();

  const note = (mark, entry, extra = {}) => {
    try {
      record(mark, {
        channelId: entry.channelId,
        revisionId: entry.revisionId,
        leaseId: entry.id,
        runId: entry.runId,
        ...extra,
      });
    } catch {
      // Diagnostics must never affect runtime lifecycle.
    }
  };

  const forget = (entry) => {
    if (leases.get(entry.id) !== entry) return false;
    leases.delete(entry.id);
    if (entry.timer) clearTimeout(entry.timer);
    return true;
  };

  const dispose = async (entry, reason) => {
    if (!forget(entry)) return;
    note(reason === 'expired' ? 'warm_expired' : 'warm_released', entry, { reason });
    await entry.promise?.catch(() => undefined);
    await stop(entry.runId).catch((error) => logger?.warn?.(
      '[BotsWarmLease] runtime cleanup failed',
      { ...botErrorLogFields(error, 'bot_warm_cleanup_failed'), runId: entry.runId },
    ));
  };

  const expire = (entry) => {
    if (entry.claimedMessageId || leases.get(entry.id) !== entry) return;
    void dispose(entry, 'expired');
  };

  const touch = (entry) => {
    entry.lastAccessedAt = now();
    if (!entry.claimedMessageId) {
      entry.expiresAt = entry.lastAccessedAt + idleTtlMs;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => expire(entry), idleTtlMs);
      entry.timer.unref?.();
    }
    leases.delete(entry.id);
    leases.set(entry.id, entry);
  };

  const evictOverflow = () => {
    while ([...leases.values()].filter((entry) => !entry.claimedMessageId).length > maxLeases) {
      const candidate = [...leases.values()].find((entry) => !entry.claimedMessageId);
      if (!candidate) break;
      void dispose(candidate, 'lru');
    }
  };

  return Object.freeze({
    begin(binding) {
      // A server-initiated runtime is channel-scoped: any member who starts
      // typing reuses it instead of replacing it with a principal-bound lease.
      const existing = [...leases.values()].find((entry) => (
        !entry.claimedMessageId
        && (entry.serverInitiated || entry.principalId === binding.principalId)
        && entry.channelId === binding.channelId
        && entry.revisionId === binding.revisionId
        && entry.librarySnapshotKey === binding.librarySnapshotKey
      ));
      if (existing) {
        touch(existing);
        return publicLease(existing);
      }
      const replacements = [];
      for (const entry of [...leases.values()]) {
        if (!entry.claimedMessageId && entry.channelId === binding.channelId) {
          replacements.push(dispose(entry, 'binding_changed'));
        }
      }
      const startedAt = now();
      const entry = {
        id: uuid(),
        runId: uuid(),
        principalId: binding.principalId,
        channelId: binding.channelId,
        revisionId: binding.revisionId,
        librarySnapshotKey: binding.librarySnapshotKey,
        serverInitiated: binding.serverInitiated === true,
        state: 'warming',
        claimedMessageId: null,
        lastAccessedAt: startedAt,
        expiresAt: startedAt + idleTtlMs,
        timer: null,
        promise: null,
      };
      entry.timer = setTimeout(() => expire(entry), idleTtlMs);
      entry.timer.unref?.();
      entry.promise = Promise.all(replacements).then(() => prepare({
        ...binding,
        leaseId: entry.id,
        runId: entry.runId,
      })).then(() => {
        if (leases.get(entry.id) === entry) {
          entry.state = 'ready';
          touch(entry);
          note('warm_ready', entry);
        }
        return entry;
      }).catch((error) => {
        forget(entry);
        const errorCode = safeErrorCode(error?.code);
        const stage = safePreparationStage(error?.botRuntimeStage);
        note('warm_miss', entry, { reason: 'prepare_failed', stage, errorCode });
        logger?.warn?.('[BotsWarmLease] runtime preparation failed', {
          code: errorCode,
          stage,
          channelId: entry.channelId,
        });
        throw error;
      });
      leases.set(entry.id, entry);
      note('warm_started', entry);
      void entry.promise.catch(() => undefined);
      evictOverflow();
      return publicLease(entry);
    },

    async claim({ leaseId, principalId, channelId, revisionId, librarySnapshotKey, messageId }) {
      const entry = leases.get(leaseId);
      if (!entry || entry.expiresAt <= now()
        || (!entry.serverInitiated && entry.principalId !== principalId)
        || entry.channelId !== channelId
        || entry.revisionId !== revisionId
        || entry.librarySnapshotKey !== librarySnapshotKey
        || (entry.claimedMessageId && entry.claimedMessageId !== messageId)) {
        if (entry && entry.expiresAt <= now() && !entry.claimedMessageId) {
          await dispose(entry, 'expired');
        }
        try { record('warm_miss', { channelId, revisionId, leaseId, reason: 'unavailable' }); } catch {}
        return Object.freeze({ hit: false, runId: null });
      }
      touch(entry);
      return adoptEntry(entry, messageId, note);
    },

    // A message sent without a client lease adopts a server-initiated warm
    // runtime for the same channel, revision and Library snapshot. Client
    // leases stay bound to the principal that requested them.
    async claimForChannel({ channelId, revisionId, librarySnapshotKey, messageId }) {
      const entry = [...leases.values()].reverse().find((candidate) => (
        candidate.serverInitiated
        && !candidate.claimedMessageId
        && candidate.expiresAt > now()
        && candidate.channelId === channelId
        && candidate.revisionId === revisionId
        && candidate.librarySnapshotKey === librarySnapshotKey
      ));
      if (!entry) return Object.freeze({ hit: false, runId: null });
      touch(entry);
      return adoptEntry(entry, messageId, note);
    },

    async release({ leaseId, principalId, channelId }) {
      const entry = leases.get(leaseId);
      if (!entry || entry.principalId !== principalId || entry.channelId !== channelId
        || entry.claimedMessageId) return false;
      await dispose(entry, 'client_release');
      return true;
    },

    async releaseChannel({ principalId = null, channelId, reason = 'channel_release' }) {
      await Promise.all([...leases.values()].filter((entry) => (
        !entry.claimedMessageId && entry.channelId === channelId
        && (principalId === null || entry.principalId === principalId)
      )).map((entry) => dispose(entry, reason)));
    },

    async abandonClaim(runId) {
      const entry = [...leases.values()].find((candidate) => candidate.runId === runId);
      if (entry) await dispose(entry, 'admission_failed');
    },

    settle(runId) {
      const entry = [...leases.values()].find((candidate) => candidate.runId === runId);
      if (entry) forget(entry);
    },

    async shutdown() {
      await Promise.all([...leases.values()].map((entry) => dispose(entry, 'shutdown')));
    },

    async invalidateAll() {
      await Promise.all([...leases.values()].map((entry) => dispose(entry, 'invalidated')));
    },

    get size() { return leases.size; },
  });
}
