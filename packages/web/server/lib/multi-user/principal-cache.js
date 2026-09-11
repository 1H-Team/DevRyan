// Invalidating access also fences refreshes that were already in flight.
export function createPrincipalCache({ ttlMs, now = Date.now, onAvoided = () => {} }) {
  const values = new Map();
  const pending = new Map();
  let generation = 0;
  return Object.freeze({
    clear() { generation += 1; values.clear(); pending.clear(); },
    delete(key) { generation += 1; values.delete(key); pending.clear(); },
    async resolve(key, scope, load) {
      const cached = values.get(key);
      if (cached && cached.until > now() && (!cached.principal.offlineGrace || scope === 'local')) {
        onAvoided();
        return cached.principal;
      }
      const scopedKey = `${scope}:${key}`;
      if (pending.has(scopedKey)) {
        onAvoided();
        return pending.get(scopedKey);
      }
      const version = generation;
      const promise = Promise.resolve().then(load).then((principal) => {
        if (!principal) return null;
        if (version !== generation) {
          throw Object.assign(new Error('Access changed during session validation; retry the request'), {
            statusCode: 503, code: 'identity_changed', retryable: true,
          });
        }
        values.set(key, { principal, until: now() + ttlMs });
        // Bound expired sessions without touching the current access generation.
        if (values.size > 2_000) values.delete(values.keys().next().value);
        return principal;
      }).finally(() => {
        if (pending.get(scopedKey) === promise) pending.delete(scopedKey);
      });
      pending.set(scopedKey, promise);
      return promise;
    },
  });
}
