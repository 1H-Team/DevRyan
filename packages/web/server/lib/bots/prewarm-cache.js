import { validateUuid } from './validation.js';
import { botErrorLogFields } from './error-normalization.js';

const DEFAULT_MAX_ENTRIES = 4;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_CATALOG_TTL_MS = 30 * 1_000;

const publicState = (entry) => Object.freeze({
  state: entry.state,
  revisionId: entry.revisionId,
  expiresAt: new Date(entry.expiresAt).toISOString(),
});

export function createBotPrewarmCache({
  compileRevision,
  loadModelCatalog,
  checkHealth,
  now = () => Date.now(),
  maxEntries = DEFAULT_MAX_ENTRIES,
  idleTtlMs = DEFAULT_IDLE_TTL_MS,
  catalogTtlMs = DEFAULT_CATALOG_TTL_MS,
  logger = console,
} = {}) {
  if (typeof compileRevision !== 'function'
    || typeof loadModelCatalog !== 'function'
    || typeof checkHealth !== 'function'
    || typeof now !== 'function'
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1
    || !Number.isFinite(idleTtlMs) || idleTtlMs < 1_000
    || !Number.isFinite(catalogTtlMs) || catalogTtlMs < 1_000) {
    throw new TypeError('Bot prewarm cache is misconfigured');
  }

  const entries = new Map();
  let catalogValue = null;
  let catalogExpiresAt = 0;
  let catalogPromise = null;

  const keyFor = (channelId, revisionId) => (
    `${validateUuid(channelId, 'channelId')}:${validateUuid(revisionId, 'revisionId')}`
  );

  const touch = (key, entry) => {
    entry.lastAccessedAt = now();
    entry.expiresAt = entry.lastAccessedAt + idleTtlMs;
    entries.delete(key);
    entries.set(key, entry);
  };

  const prune = () => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };

  const getModelCatalog = async ({ force = false } = {}) => {
    const current = now();
    if (catalogPromise) return catalogPromise;
    if (!force && catalogValue !== null && catalogExpiresAt > current) return catalogValue;
    if (force) {
      catalogValue = null;
      catalogExpiresAt = 0;
    }
    let pending;
    try {
      pending = Promise.resolve(loadModelCatalog());
    } catch (error) {
      pending = Promise.reject(error);
    }
    catalogPromise = pending;
    try {
      const catalog = await pending;
      if (catalogPromise === pending) {
        catalogValue = catalog;
        catalogExpiresAt = now() + catalogTtlMs;
      }
      return catalog;
    } finally {
      if (catalogPromise === pending) catalogPromise = null;
    }
  };

  const begin = ({ channelId, revisionId, contract }) => {
    prune();
    const key = keyFor(channelId, revisionId);
    const existing = entries.get(key);
    if (existing) {
      touch(key, existing);
      return existing;
    }
    const startedAt = now();
    const entry = {
      channelId,
      revisionId,
      state: 'warming',
      compiled: null,
      health: null,
      lastAccessedAt: startedAt,
      expiresAt: startedAt + idleTtlMs,
      promise: null,
    };
    entry.promise = Promise.all([
      compileRevision({ channelId, revisionId, contract }),
      getModelCatalog(),
      checkHealth(),
    ]).then(([compiled, , health]) => {
      if (entries.get(key) !== entry) return entry;
      entry.compiled = compiled;
      entry.health = Object.freeze({
        available: health?.available === true,
        state: typeof health?.state === 'string' ? health.state : null,
        code: typeof health?.code === 'string' ? health.code : null,
      });
      entry.state = 'ready';
      touch(key, entry);
      return entry;
    }).catch((error) => {
      if (entries.get(key) === entry) entries.delete(key);
      logger?.warn?.('[BotsPrewarm] channel prewarm failed', {
        ...botErrorLogFields(error, 'bot_prewarm_failed'),
        channelId,
        revisionId,
      });
      throw error;
    });
    entries.set(key, entry);
    prune();
    return entry;
  };

  return Object.freeze({
    prewarm(input) {
      const entry = begin(input);
      void entry.promise.catch(() => undefined);
      return publicState(entry);
    },
    getModelCatalog,
    peekCompiled(channelId, revisionId) {
      prune();
      const key = keyFor(channelId, revisionId);
      const entry = entries.get(key);
      if (!entry || entry.state !== 'ready' || !entry.compiled) return null;
      touch(key, entry);
      return entry.compiled;
    },
    invalidateChannel(channelId) {
      const normalized = validateUuid(channelId, 'channelId');
      for (const [key, entry] of entries) {
        if (entry.channelId === normalized) entries.delete(key);
      }
    },
    invalidateRevision(revisionId) {
      const normalized = validateUuid(revisionId, 'revisionId');
      for (const [key, entry] of entries) {
        if (entry.revisionId === normalized) entries.delete(key);
      }
    },
    invalidateAll() {
      entries.clear();
      catalogValue = null;
      catalogExpiresAt = 0;
      catalogPromise = null;
    },
    get size() {
      prune();
      return entries.size;
    },
  });
}
