import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  asObject,
  asNonEmptyString,
  formatMoney,
  formatResetTime
} from '../utils/index.js';

export const providerId = 'codex';
export const providerName = 'ChatGPT';
export const aliases = ['openai', 'codex', 'chatgpt'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

const buildHeaders = (accessToken, accountId, extraHeaders = {}) => ({
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  ...extraHeaders
});

const normalizeResetCredit = (value, index) => {
  const credit = asObject(value);
  if (!credit) return null;

  const grantedAt = toTimestamp(credit.granted_at ?? credit.grantedAt);
  const expiresAt = toTimestamp(credit.expires_at ?? credit.expiresAt);
  const id = asNonEmptyString(credit.id) ?? `reset-credit-${index}`;
  return {
    id,
    status: asNonEmptyString(credit.status) ?? 'available',
    resetType: asNonEmptyString(credit.reset_type ?? credit.resetType),
    grantedAt,
    grantedAtFormatted: grantedAt ? formatResetTime(grantedAt) : null,
    expiresAt,
    expiresAtFormatted: expiresAt ? formatResetTime(expiresAt) : null
  };
};

const normalizeResetCreditsPayload = (payload, source) => {
  const data = asObject(payload);
  if (!data) return null;

  const credits = Array.isArray(data.credits)
    ? data.credits.map(normalizeResetCredit).filter(Boolean)
    : [];
  const availableCount = toNumber(data.available_count ?? data.availableCount);
  const totalEarnedCount = toNumber(data.total_earned_count ?? data.totalEarnedCount);

  if (availableCount === null && totalEarnedCount === null && credits.length === 0) {
    return null;
  }

  return {
    availableCount,
    totalEarnedCount,
    credits,
    source
  };
};

const fetchDedicatedResetCredits = async (fetchImpl, accessToken, accountId) => {
  try {
    const response = await fetchImpl(CODEX_RESET_CREDITS_URL, {
      method: 'GET',
      headers: buildHeaders(accessToken, accountId, {
        'OpenAI-Beta': 'codex-1',
        originator: 'Codex Desktop'
      })
    });

    if (!response.ok) return null;
    const payload = await response.json();
    return normalizeResetCreditsPayload(payload, 'dedicated');
  } catch {
    return null;
  }
};

const getFallbackResetCredits = (payload) => {
  const usageResetCredits = asObject(payload?.rate_limit_reset_credits ?? payload?.rateLimitResetCredits);
  if (!usageResetCredits) return null;
  return normalizeResetCreditsPayload(usageResetCredits, 'usage');
};

export const fetchQuota = async (options = {}) => {
  const readAuth = options.readAuth ?? readAuthFile;
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth = readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  const accountId = entry?.accountId;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetchImpl(CODEX_USAGE_URL, {
      method: 'GET',
      headers: buildHeaders(accessToken, accountId)
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired \u2014 please re-authenticate with OpenAI'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;
    const resetCredits = await fetchDedicatedResetCredits(fetchImpl, accessToken, accountId)
      ?? getFallbackResetCredits(payload);

    const windows = {};
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds);
      const label = windowSeconds !== null && windowSeconds > 0
        ? resolveWindowLabel(windowSeconds)
        : '5h';
      windows[label] = toUsageWindow({
        usedPercent: toNumber(primary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at)
      });
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds);
      const label = windowSeconds !== null && windowSeconds > 0
        ? resolveWindowLabel(windowSeconds)
        : 'weekly';
      windows[label] = toUsageWindow({
        usedPercent: toNumber(secondary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(secondary.reset_at)
      });
    }
    if (credits && !resetCredits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const label = unlimited
        ? 'Unlimited'
        : balance !== null
          ? `$${formatMoney(balance)} remaining`
          : null;
      windows.credits = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: label
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: {
        windows,
        ...(resetCredits ? { resetCredits } : {})
      }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
