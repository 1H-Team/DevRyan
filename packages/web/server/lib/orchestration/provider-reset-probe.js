import { createKeyedSingleFlight } from '@openchamber/orchestration-runtime';

import { isAnthropicProviderId } from '../opencode/anthropic-provider-ids.js';
import {
  createClaudeProxyBaseUrlResolver,
  extractMeridianClaudeResetSignal,
  fetchMeridianClaudeQuotaPayload,
} from '../quota/providers/claude-meridian.js';

export const PROVIDER_RESET_PROBE_TTL_MS = 60_000;

/**
 * The scheduler's `autoResume.resolveProviderReset` hook for the web/Electron
 * host. Anthropic-routed children run through the local Meridian proxy, whose
 * `/v1/usage/quota` buckets say whether the account is currently limited and
 * when the limit lifts; every other provider, an external OpenCode runtime, a
 * missing proxy, or any transport failure answers null so planning falls back
 * to the OpenCode status hint and the backoff ladder.
 *
 * Signals are cached per proxy base URL for `ttlMs` and overlapping probes for
 * the same proxy share one request, so a burst of parked tasks never fans out
 * into a burst of quota reads.
 */
export const createMeridianProviderResetProbe = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  isExternalOpenCode = () => false,
  fetchImpl,
  now = Date.now,
  ttlMs = PROVIDER_RESET_PROBE_TTL_MS,
  timeoutMs,
} = {}) => {
  const baseUrls = createClaudeProxyBaseUrlResolver({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    isExternalOpenCode,
    fetchImpl,
    now,
    ttlMs,
  });
  const signals = new Map();
  const singleFlight = createKeyedSingleFlight();

  const readSignal = async (baseUrl) => {
    const cached = signals.get(baseUrl);
    if (cached && cached.expiresAt > now()) return cached.value;
    return singleFlight.run(`provider-reset:${baseUrl}`, async () => {
      const current = signals.get(baseUrl);
      if (current && current.expiresAt > now()) return current.value;
      const result = await fetchMeridianClaudeQuotaPayload({
        baseUrl,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });
      const value = result.ok ? extractMeridianClaudeResetSignal(result.payload) : null;
      // Failures are not cached: the next planning pass may find the proxy back.
      if (value && ttlMs > 0) signals.set(baseUrl, { value, expiresAt: now() + ttlMs });
      return value;
    });
  };

  const resolveProviderReset = async ({ providerId, directory } = {}) => {
    if (isExternalOpenCode()) return null;
    if (!isAnthropicProviderId(providerId)) return null;
    try {
      const baseUrl = await baseUrls.resolve(typeof directory === 'string' ? directory : '');
      if (!baseUrl) return null;
      return await readSignal(baseUrl);
    } catch {
      return null;
    }
  };

  return Object.freeze({
    resolveProviderReset,
    clear() {
      baseUrls.clear();
      signals.clear();
    },
  });
};
