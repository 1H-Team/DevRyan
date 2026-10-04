import { createKeyedSingleFlight } from '@openchamber/orchestration-runtime';

import { isAnthropicProviderId } from '../opencode/anthropic-provider-ids.js';
import {
  createClaudeProxyBaseUrlResolver,
  extractMeridianClaudeResetSignal,
  fetchMeridianClaudeQuotaPayload,
  resolveSafeClaudeQuotaUrl,
} from '../quota/providers/claude-meridian.js';

export const PROVIDER_RESET_PROBE_TTL_MS = 60_000;

/**
 * The loopback Meridian base URL a v1 `{providers}` catalog advertises for
 * `anthropic`, or null (the same rule as `createClaudeProxyBaseUrlResolver`).
 * @param {unknown} catalog
 */
const anthropicProxyBaseUrl = (catalog) => {
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
  const anthropic = providers.find((provider) => provider?.id === 'anthropic');
  const baseUrl = anthropic?.options?.baseURL ?? anthropic?.baseURL;
  return typeof baseUrl === 'string' && resolveSafeClaudeQuotaUrl(baseUrl) ? baseUrl : null;
};

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
 *
 * On gen 2 the provider catalog comes from the injected `openCodeClient`
 * (DESIGN.md C.1), cached per directory for `ttlMs` with the same single-flight;
 * gen 1 (or no client) keeps the direct `/config/providers` lookup.
 */
export const createMeridianProviderResetProbe = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  isExternalOpenCode = () => false,
  fetchImpl,
  now = Date.now,
  ttlMs = PROVIDER_RESET_PROBE_TTL_MS,
  timeoutMs,
  openCodeClient = null,
} = {}) => {
  if (openCodeClient !== null && typeof openCodeClient?.generation !== 'function') {
    throw new TypeError('openCodeClient must be an openCodeClient');
  }
  const baseUrls = createClaudeProxyBaseUrlResolver({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    isExternalOpenCode,
    fetchImpl,
    now,
    ttlMs,
  });
  const signals = new Map();
  const gen2BaseUrls = new Map();
  const singleFlight = createKeyedSingleFlight();

  /** Gen 2: the catalog through the client; failures propagate and are not cached. */
  const resolveGen2BaseUrl = async (directory) => {
    const cached = gen2BaseUrls.get(directory);
    if (cached && cached.expiresAt > now()) return cached.value;
    return singleFlight.run(`provider-reset-base-url:v2:${directory}`, async () => {
      const current = gen2BaseUrls.get(directory);
      if (current && current.expiresAt > now()) return current.value;
      const catalog = await openCodeClient.catalog.providers(directory ? { directory } : {});
      const value = anthropicProxyBaseUrl(catalog);
      if (ttlMs > 0) gen2BaseUrls.set(directory, { value, expiresAt: now() + ttlMs });
      return value;
    });
  };

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
      const scope = typeof directory === 'string' ? directory : '';
      const baseUrl = openCodeClient !== null && openCodeClient.generation() === 2
        ? await resolveGen2BaseUrl(scope)
        : await baseUrls.resolve(scope);
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
      gen2BaseUrls.clear();
      signals.clear();
    },
  });
};
