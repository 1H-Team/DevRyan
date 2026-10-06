import { createHash } from 'node:crypto';
import { isSiwcAuthRecord, listSiwcAccountModels } from './chatgpt-siwc.js';

function accountKey(auth) {
  const direct = auth?.accountId
    ?? (typeof auth?.metadata?.accountID === 'string' ? auth.metadata.accountID : null)
    ?? (typeof auth?.metadata?.subject === 'string' ? auth.metadata.subject : null)
    ?? (typeof auth?.subject === 'string' ? auth.subject : null);
  return typeof direct === 'string' && direct ? direct : 'siwc';
}

const cache = new Map();
const TTL_MS = 60_000;

/**
 * Ordered SIWC account models for catalog annotation.
 * Cached briefly per account + access fingerprint; failures return null, which callers must present as unavailable.
 */
export async function resolveSiwcAccountModels(authEntry, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!isSiwcAuthRecord(authEntry) || typeof authEntry.access !== 'string' || !authEntry.access) {
    return null;
  }
  const key = `${authEntry.clientId ?? authEntry.metadata?.clientId}:${accountKey(authEntry)}:${createHash('sha256').update(authEntry.access).digest('hex').slice(0, 16)}`;
  const hit = cache.get(key);
  const at = now();
  if (hit && hit.expiresAt > at) return hit.models;

  try {
    const models = await listSiwcAccountModels(authEntry.access, { fetchImpl });
    cache.set(key, { models, expiresAt: at + TTL_MS });
    // Drop stale entries for other accounts/tokens.
    for (const [cachedKey, value] of cache) {
      if (value.expiresAt <= at) cache.delete(cachedKey);
    }
    return models;
  } catch {
    return null;
  }
}

export function clearSiwcAccountModelCache() {
  cache.clear();
}
