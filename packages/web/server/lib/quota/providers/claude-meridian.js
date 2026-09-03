import { createKeyedSingleFlight } from '@openchamber/orchestration-runtime';

import { toNumber, toTimestamp, toUsageWindow } from '../utils/index.js';

export const CLAUDE_MERIDIAN_UNAVAILABLE_CODE = 'claude_meridian_unavailable';
export const CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE = 'claude_meridian_context_unavailable';
export const MAX_CLAUDE_QUOTA_RESPONSE_BYTES = 64 * 1024;

const REQUEST_TIMEOUT_MS = 5000;
const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const resolveSafeClaudeMeridianUrl = (baseUrl, pathname) => {
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || !parsed.port
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
    return new URL(pathname, parsed.origin).toString();
  } catch {
    return null;
  }
};

export const resolveSafeClaudeQuotaUrl = (baseUrl) => (
  resolveSafeClaudeMeridianUrl(baseUrl, '/v1/usage/quota')
);

export const CLAUDE_PROXY_BASE_URL_TTL_MS = 60_000;

/**
 * Resolves the loopback Meridian (Claude) proxy base URL that managed OpenCode
 * advertises as the `anthropic` provider's `baseURL` for one working directory.
 * Answers are cached per directory for `ttlMs` (0 disables caching) and
 * overlapping lookups for the same directory share one `/config/providers`
 * request. Transport failures propagate so each caller decides how to degrade.
 */
export const createClaudeProxyBaseUrlResolver = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  isExternalOpenCode = () => false,
  fetchImpl,
  now = Date.now,
  ttlMs = CLAUDE_PROXY_BASE_URL_TTL_MS,
} = {}) => {
  const cache = new Map();
  const singleFlight = createKeyedSingleFlight();

  const lookup = async (workingDirectory) => {
    const query = workingDirectory
      ? `?directory=${encodeURIComponent(workingDirectory)}`
      : '';
    const response = await (fetchImpl ?? globalThis.fetch)(buildOpenCodeUrl(`/config/providers${query}`, ''), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    const anthropic = providers.find((provider) => provider?.id === 'anthropic');
    const baseUrl = anthropic?.options?.baseURL ?? anthropic?.baseURL;
    return typeof baseUrl === 'string' && resolveSafeClaudeQuotaUrl(baseUrl)
      ? baseUrl
      : null;
  };

  const resolve = async (workingDirectory) => {
    if (isExternalOpenCode() || typeof buildOpenCodeUrl !== 'function') return null;
    const key = typeof workingDirectory === 'string' ? workingDirectory : '';
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    return singleFlight.run(`claude-proxy-base-url:${key}`, async () => {
      const current = cache.get(key);
      if (current && current.expiresAt > now()) return current.value;
      const value = await lookup(key);
      if (ttlMs > 0) cache.set(key, { value, expiresAt: now() + ttlMs });
      return value;
    });
  };

  return Object.freeze({
    resolve,
    clear() {
      cache.clear();
    },
  });
};

const toTokenCount = (value) => {
  const parsed = toNumber(value);
  return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : null;
};

export const transformMeridianClaudeContextUsage = (payload, sessionID) => {
  const usage = payload?.context_usage;
  if (!usage || typeof usage !== 'object') {
    return {
      ok: false,
      code: CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE,
      error: 'Claude context proxy returned a malformed response.',
    };
  }

  const inputTokens = toTokenCount(usage.input_tokens);
  const outputTokens = toTokenCount(usage.output_tokens);
  const cacheReadTokens = toTokenCount(usage.cache_read_input_tokens);
  const cacheWriteTokens = toTokenCount(usage.cache_creation_input_tokens);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some((value) => value === null)) {
    return {
      ok: false,
      code: CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE,
      error: 'Claude context proxy returned invalid token counts.',
    };
  }

  return {
    ok: true,
    usage: {
      sessionID,
      status: 'available',
      source: 'meridian',
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      activeInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
      lastOutputTokens: outputTokens,
      fetchedAt: Date.now(),
    },
  };
};

const fetchBoundedJson = async ({
  url,
  fetchImpl,
  timeoutMs,
  unavailableCode,
  label,
}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: unavailableCode,
        error: `${label} returned HTTP ${response.status}.`,
      };
    }

    const declaredLength = Number.parseInt(response.headers?.get?.('content-length') ?? '0', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CLAUDE_QUOTA_RESPONSE_BYTES) {
      return {
        ok: false,
        code: unavailableCode,
        error: `${label} response exceeded the safe response limit.`,
      };
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_CLAUDE_QUOTA_RESPONSE_BYTES) {
      return {
        ok: false,
        code: unavailableCode,
        error: `${label} response exceeded the safe response limit.`,
      };
    }
    try {
      return { ok: true, payload: JSON.parse(raw) };
    } catch {
      return {
        ok: false,
        code: unavailableCode,
        error: `${label} returned malformed JSON.`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: unavailableCode,
      error: error?.name === 'AbortError'
        ? `Timed out while reading the ${label}.`
        : error instanceof Error
          ? error.message
          : `Failed to read the ${label}.`,
    };
  } finally {
    clearTimeout(timer);
  }
};

export const createMeridianClaudeContextUsageClient = ({
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) => {
  const claudeSessionIds = new Map();
  const pendingBySession = new Map();

  const resolveClaudeSessionID = async (baseUrl, sessionID, refreshSession) => {
    if (!refreshSession && claudeSessionIds.has(sessionID)) {
      return claudeSessionIds.get(sessionID);
    }
    const recoverUrl = resolveSafeClaudeMeridianUrl(
      baseUrl,
      `/v1/sessions/${encodeURIComponent(sessionID)}/recover`,
    );
    if (!recoverUrl) return null;
    const result = await fetchBoundedJson({
      url: recoverUrl,
      fetchImpl,
      timeoutMs,
      unavailableCode: CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE,
      label: 'Claude session proxy',
    });
    const claudeSessionID = result.ok && typeof result.payload?.claudeSessionId === 'string'
      ? result.payload.claudeSessionId.trim()
      : '';
    if (!claudeSessionID) return null;
    claudeSessionIds.set(sessionID, claudeSessionID);
    return claudeSessionID;
  };

  const execute = async ({ baseUrl, sessionID, refreshSession }) => {
    if (!resolveSafeClaudeQuotaUrl(baseUrl)) {
      return {
        ok: false,
        code: CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE,
        error: 'Claude context proxy URL is not a safe loopback HTTP address.',
      };
    }

    let resolvedFresh = refreshSession;
    let claudeSessionID = await resolveClaudeSessionID(baseUrl, sessionID, refreshSession);
    if (!claudeSessionID) {
      return {
        ok: false,
        code: CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE,
        error: 'Claude session mapping is unavailable.',
      };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const usageUrl = resolveSafeClaudeMeridianUrl(
        baseUrl,
        `/v1/sessions/${encodeURIComponent(claudeSessionID)}/context-usage`,
      );
      if (!usageUrl) break;
      const result = await fetchBoundedJson({
        url: usageUrl,
        fetchImpl,
        timeoutMs,
        unavailableCode: CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE,
        label: 'Claude context proxy',
      });
      if (result.ok) return transformMeridianClaudeContextUsage(result.payload, sessionID);
      if (result.status !== 404 || resolvedFresh) return result;
      claudeSessionIds.delete(sessionID);
      claudeSessionID = await resolveClaudeSessionID(baseUrl, sessionID, true);
      resolvedFresh = true;
      if (!claudeSessionID) return result;
    }

    return {
      ok: false,
      code: CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE,
      error: 'Claude context proxy is unavailable.',
    };
  };

  return {
    fetchContextUsage(options) {
      const sessionID = typeof options?.sessionID === 'string' ? options.sessionID.trim() : '';
      if (!sessionID) {
        return Promise.resolve({
          ok: false,
          code: CLAUDE_MERIDIAN_CONTEXT_UNAVAILABLE_CODE,
          error: 'Claude session ID is required.',
        });
      }
      const refreshSession = options?.refreshSession === true;
      const existing = pendingBySession.get(sessionID);
      if (existing && (!refreshSession || existing.refreshSession)) return existing.promise;
      const run = () => execute({
        baseUrl: options?.baseUrl,
        sessionID,
        refreshSession,
      });
      const promise = (existing ? existing.promise.then(run, run) : run()).finally(() => {
        if (pendingBySession.get(sessionID)?.promise === promise) pendingBySession.delete(sessionID);
      });
      pendingBySession.set(sessionID, { promise, refreshSession });
      return promise;
    },
    clearSession(sessionID) {
      claudeSessionIds.delete(sessionID);
    },
  };
};

const mapBucketLabel = (type) => {
  if (type === 'five_hour') return { label: '5h', windowSeconds: FIVE_HOUR_WINDOW_SECONDS };
  if (type === 'seven_day') return { label: '7d', windowSeconds: SEVEN_DAY_WINDOW_SECONDS };
  if (type.startsWith('seven_day_')) {
    const model = type.slice('seven_day_'.length).replace(/_/g, '-');
    return model ? { label: `7d-${model}`, windowSeconds: SEVEN_DAY_WINDOW_SECONDS } : null;
  }
  return null;
};

export const transformMeridianClaudeQuota = (payload) => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.buckets)) {
    return { ok: false, code: CLAUDE_MERIDIAN_UNAVAILABLE_CODE, error: 'Claude quota proxy returned a malformed response.' };
  }

  const windows = {};
  let latestObservedAt = toTimestamp(payload.asOf ?? payload.sources?.oauth?.fetchedAt);
  for (const bucket of payload.buckets) {
    if (!bucket || typeof bucket !== 'object' || typeof bucket.type !== 'string') continue;
    const mapping = mapBucketLabel(bucket.type);
    const utilization = toNumber(bucket.utilization);
    if (!mapping || utilization === null || utilization < 0) continue;
    const observedAt = toTimestamp(bucket.observedAt);
    if (observedAt !== null) {
      latestObservedAt = latestObservedAt === null ? observedAt : Math.max(latestObservedAt, observedAt);
    }
    windows[mapping.label] = toUsageWindow({
      usedPercent: utilization * 100,
      windowSeconds: mapping.windowSeconds,
      resetAt: toTimestamp(bucket.resetsAt),
    });
  }

  if (!windows['5h'] && !windows['7d']) {
    return { ok: false, code: CLAUDE_MERIDIAN_UNAVAILABLE_CODE, error: 'Claude quota proxy did not return subscription limits.' };
  }

  return {
    ok: true,
    usage: { windows },
    usageUpdatedAt: latestObservedAt ?? Date.now(),
  };
};

/**
 * Reads the usage-limit signal the managed-task auto-resume planner needs from
 * a raw Meridian `/v1/usage/quota` payload (the transformed quota windows drop
 * bucket `status`). A bucket is limited when Meridian marked it `rejected` or
 * its utilization reached 100%. `resetAt` is the earliest reset among limited
 * buckets, or — when nothing is limited — the earliest known reset of any
 * bucket (null when Meridian reported none). Malformed payloads yield null.
 */
export const extractMeridianClaudeResetSignal = (payload) => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.buckets)) return null;
  let limited = false;
  let limitedResetAt = null;
  let anyResetAt = null;
  for (const bucket of payload.buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const utilization = toNumber(bucket.utilization);
    const resetAt = toTimestamp(bucket.resetsAt);
    const bucketLimited = bucket.status === 'rejected' || (utilization !== null && utilization >= 1);
    if (resetAt !== null) anyResetAt = anyResetAt === null ? resetAt : Math.min(anyResetAt, resetAt);
    if (!bucketLimited) continue;
    limited = true;
    if (resetAt !== null) {
      limitedResetAt = limitedResetAt === null ? resetAt : Math.min(limitedResetAt, resetAt);
    }
  }
  return { limited, resetAt: limited ? limitedResetAt : anyResetAt };
};

/** Bounded raw `/v1/usage/quota` read: `{ ok: true, payload }` or the failure record. */
export const fetchMeridianClaudeQuotaPayload = async ({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) => {
  const quotaUrl = resolveSafeClaudeQuotaUrl(baseUrl);
  if (!quotaUrl) {
    return {
      ok: false,
      code: CLAUDE_MERIDIAN_UNAVAILABLE_CODE,
      error: 'Claude quota proxy URL is not a safe loopback HTTP address.',
    };
  }

  return fetchBoundedJson({
    url: quotaUrl,
    fetchImpl,
    timeoutMs,
    unavailableCode: CLAUDE_MERIDIAN_UNAVAILABLE_CODE,
    label: 'Claude quota proxy',
  });
};

export const fetchMeridianClaudeQuota = async (options = {}) => {
  const result = await fetchMeridianClaudeQuotaPayload(options);
  return result.ok ? transformMeridianClaudeQuota(result.payload) : result;
};
