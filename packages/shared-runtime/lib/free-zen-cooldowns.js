/**
 * Shared cooldown ledger for free Zen models.
 *
 * A model that just answered 429 (or "promotion ended", or "model not found")
 * will almost certainly answer the same way on the next request. Remembering
 * that for a while turns a guaranteed wasted attempt into an immediate advance
 * to the next model in a rotation. Because every generation feature (session
 * titles, PR descriptions, ...) rotates through the same public catalog, the
 * ledger is shared: a rate limit observed by one feature protects all of them.
 *
 * Two durations are used:
 * - long  — the model itself is unusable for a while (rate limited, rejected
 *           credentials/promotion, unknown model)
 * - short — the failure looked transient (timeout, upstream fault, empty or
 *           malformed output, transport error)
 */

export const FREE_ZEN_LONG_COOLDOWN_MS = 5 * 60 * 1_000;
export const FREE_ZEN_SHORT_COOLDOWN_MS = 30 * 1_000;

const LONG_COOLDOWN_REASONS = new Set(['rate_limited', 'unauthorized', 'model_unavailable']);

const modelIdOf = (value) => {
  const id = typeof value === 'string' ? value : value?.id;
  return typeof id === 'string' ? id.trim() : '';
};

const positiveMs = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

export function createFreeZenCooldowns({
  now = () => Date.now(),
  longMs = FREE_ZEN_LONG_COOLDOWN_MS,
  shortMs = FREE_ZEN_SHORT_COOLDOWN_MS,
} = {}) {
  const longCooldownMs = positiveMs(longMs, FREE_ZEN_LONG_COOLDOWN_MS);
  const shortCooldownMs = positiveMs(shortMs, FREE_ZEN_SHORT_COOLDOWN_MS);
  const cooldowns = new Map();

  const durationFor = (reason) => (
    LONG_COOLDOWN_REASONS.has(typeof reason === 'string' ? reason : '') ? longCooldownMs : shortCooldownMs
  );

  const isCoolingDown = (model, at = now()) => {
    const id = modelIdOf(model);
    if (!id) return false;
    const entry = cooldowns.get(id);
    if (!entry) return false;
    if (entry.until <= at) {
      cooldowns.delete(id);
      return false;
    }
    return true;
  };

  const mark = (model, reason = 'request_failed', { at = now(), cooldownMs } = {}) => {
    const id = modelIdOf(model);
    if (!id) return null;
    const until = at + positiveMs(cooldownMs, durationFor(reason));
    cooldowns.set(id, { until, reason: typeof reason === 'string' && reason ? reason : 'request_failed' });
    return until;
  };

  const reset = () => {
    cooldowns.clear();
  };

  const snapshot = (at = now()) => Array.from(cooldowns.entries())
    .filter(([, entry]) => entry.until > at)
    .map(([model, entry]) => ({ model, reason: entry.reason, until: entry.until }));

  return { isCoolingDown, mark, reset, durationFor, snapshot };
}

/**
 * Process-wide ledger shared by every free Zen consumer in the same runtime.
 */
export const sharedFreeZenCooldowns = createFreeZenCooldowns();
