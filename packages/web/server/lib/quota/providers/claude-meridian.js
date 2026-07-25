import { toNumber, toTimestamp, toUsageWindow } from '../utils/index.js';

export const CLAUDE_MERIDIAN_UNAVAILABLE_CODE = 'claude_meridian_unavailable';
export const MAX_CLAUDE_QUOTA_RESPONSE_BYTES = 64 * 1024;

const REQUEST_TIMEOUT_MS = 5000;
const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const resolveSafeClaudeQuotaUrl = (baseUrl) => {
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
    return new URL('/v1/usage/quota', parsed.origin).toString();
  } catch {
    return null;
  }
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

export const fetchMeridianClaudeQuota = async ({
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(quotaUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        code: CLAUDE_MERIDIAN_UNAVAILABLE_CODE,
        error: `Claude quota proxy returned HTTP ${response.status}.`,
      };
    }

    const declaredLength = Number.parseInt(response.headers?.get?.('content-length') ?? '0', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CLAUDE_QUOTA_RESPONSE_BYTES) {
      return {
        ok: false,
        code: CLAUDE_MERIDIAN_UNAVAILABLE_CODE,
        error: 'Claude quota proxy response exceeded the safe response limit.',
      };
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_CLAUDE_QUOTA_RESPONSE_BYTES) {
      return {
        ok: false,
        code: CLAUDE_MERIDIAN_UNAVAILABLE_CODE,
        error: 'Claude quota proxy response exceeded the safe response limit.',
      };
    }
    try {
      return transformMeridianClaudeQuota(JSON.parse(raw));
    } catch {
      return {
        ok: false,
        code: CLAUDE_MERIDIAN_UNAVAILABLE_CODE,
        error: 'Claude quota proxy returned malformed JSON.',
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: CLAUDE_MERIDIAN_UNAVAILABLE_CODE,
      error: error?.name === 'AbortError'
        ? 'Timed out while reading the Claude quota proxy.'
        : error instanceof Error
          ? error.message
          : 'Failed to read the Claude quota proxy.',
    };
  } finally {
    clearTimeout(timer);
  }
};
