import { getRequestPrincipal } from '../multi-user/request-context.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

const cache = new Map();

// A managed principal's scans use only its own GitHub token, so they are
// cached for that principal alone. Every other request shares the host's
// entries, which its credentials fetched.
const credentialScope = () => {
  const principal = getRequestPrincipal();
  return principal?.scope === 'managed' ? `managed:${String(principal.id || '')}` : 'host';
};

export function getCacheKey({ normalizedRepo, subpath, identityId }) {
  const safeRepo = String(normalizedRepo || '').trim();
  const safeSubpath = String(subpath || '').trim();
  const safeIdentity = String(identityId || '').trim();
  return `${safeRepo}::${safeSubpath}::${safeIdentity}::${credentialScope()}`;
}

export function getCachedScan(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCachedScan(key, value, ttlMs = DEFAULT_TTL_MS) {
  const ttl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS;
  cache.set(key, { expiresAt: Date.now() + ttl, value });
}

export function clearCache() {
  cache.clear();
}
