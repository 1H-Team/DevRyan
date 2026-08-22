const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
export const KIMI_QUOTA_URL = 'https://api.kimi.com/coding/v1/usages';
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
export const XAI_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
export const XAI_BILLING_HOST = 'cli-chat-proxy.grok.com';
export const XAI_CLIENT_VERSION = '0.2.103';
export const XAI_RESET_BANK_URL = 'https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets';
export const XAI_RESET_BANK_MAX_RESPONSE_BYTES = 64 * 1024;
export const XAI_OAUTH_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
export const OPENCODE_ZEN_BILLING_ORIGIN = 'https://opencode.ai';
export const OPENCODE_ZEN_MAX_RESPONSE_BYTES = 512 * 1024;

const OPENCODE_ZEN_WORKSPACE_PATTERN = /^wrk_[0-9A-HJKMNP-TV-Z]{26}$/;
const OPENCODE_ZEN_MICROCENTS_PER_DOLLAR = 100_000_000;

const asObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : null
);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const isSafeOpenCodeZenCookie = (value) => (
  typeof value === 'string'
  && value.trim().length > 0
  && value.trim().length <= 16 * 1024
  && !/[\s;\0]/.test(value.trim())
);

export const normalizeOpenCodeZenCredential = (credential) => {
  const workspaceId = asNonEmptyString(credential?.workspaceId);
  const authCookie = typeof credential?.authCookie === 'string' ? credential.authCookie.trim() : '';
  if (!workspaceId || !OPENCODE_ZEN_WORKSPACE_PATTERN.test(workspaceId) || !isSafeOpenCodeZenCookie(authCookie)) {
    return null;
  }
  return { workspaceId, authCookie };
};

export const toQuotaNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const toQuotaTimestamp = (value) => {
  const numeric = toQuotaNumber(value);
  if (numeric !== null) {
    return Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstNumber = (object, keys) => {
  if (!object) return null;
  for (const key of keys) {
    const value = toQuotaNumber(object[key]);
    if (value !== null) return value;
  }
  return null;
};

const firstTimestamp = (object, keys) => {
  if (!object) return null;
  for (const key of keys) {
    const value = toQuotaTimestamp(object[key]);
    if (value !== null) return value;
  }
  return null;
};

const firstBoolean = (object, keys) => {
  if (!object) return null;
  for (const key of keys) {
    if (typeof object[key] === 'boolean') return object[key];
  }
  return null;
};

const clampPercent = (value) => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null
);

const formatResetTime = (timestamp, now) => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  try {
    const resetDate = new Date(timestamp);
    if (!Number.isFinite(resetDate.getTime())) return null;
    const currentDate = new Date(now);
    const isToday = resetDate.toDateString() === currentDate.toDateString();
    if (isToday) {
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    }
    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
};

export const toSharedUsageWindow = ({
  usedPercent,
  windowSeconds,
  resetAt,
  valueLabel,
  description,
  now = Date.now(),
}) => {
  const normalizedPercent = clampPercent(usedPercent);
  const normalizedResetAt = toQuotaTimestamp(resetAt);
  const normalizedWindowSeconds = toQuotaNumber(windowSeconds);
  const resetAfterSeconds = normalizedResetAt === null
    ? null
    : Math.max(0, Math.floor((normalizedResetAt - now) / 1000));
  const resetFormatted = formatResetTime(normalizedResetAt, now);

  return {
    usedPercent: normalizedPercent,
    remainingPercent: normalizedPercent === null ? null : 100 - normalizedPercent,
    windowSeconds: normalizedWindowSeconds !== null && normalizedWindowSeconds > 0
      ? normalizedWindowSeconds
      : null,
    resetAfterSeconds,
    resetAt: normalizedResetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
    ...(valueLabel ? { valueLabel } : {}),
    ...(description ? { description } : {}),
  };
};

export const buildSharedQuotaResult = ({
  providerId,
  providerName,
  ok,
  configured,
  usage,
  error,
  errorCode,
  warnings,
  usageUpdatedAt,
  now = Date.now(),
}) => ({
  providerId,
  providerName,
  ok,
  configured,
  usage: usage ?? null,
  ...(error ? { error } : {}),
  ...(errorCode ? { errorCode } : {}),
  ...(Array.isArray(warnings) && warnings.length > 0 ? { warnings } : {}),
  ...(typeof usageUpdatedAt === 'number' && Number.isFinite(usageUpdatedAt)
    ? { usageUpdatedAt }
    : {}),
  fetchedAt: now,
});

const errorMessage = (error) => (error instanceof Error ? error.message : 'Request failed');

const resolveWindowLabel = (windowSeconds, fallback = 'usage') => {
  if (typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return fallback;
  }
  if (windowSeconds === 7 * DAY_SECONDS) return 'weekly';
  if (windowSeconds % DAY_SECONDS === 0) return `${windowSeconds / DAY_SECONDS}d`;
  if (windowSeconds % HOUR_SECONDS === 0) return `${windowSeconds / HOUR_SECONDS}h`;
  if (windowSeconds % 60 === 0) return `${windowSeconds / 60}m`;
  return `${windowSeconds}s`;
};

const addCollisionSafeWindow = (windows, labelCounts, label, window) => {
  const count = (labelCounts.get(label) ?? 0) + 1;
  labelCounts.set(label, count);
  windows[count === 1 ? label : `${label} #${count}`] = window;
};

const resolveZaiWindowSeconds = (limit) => {
  const explicit = firstNumber(limit, [
    'windowSeconds',
    'window_seconds',
    'durationSeconds',
    'duration_seconds',
  ]);
  if (explicit !== null) return explicit > 0 ? explicit : null;

  const duration = firstNumber(limit, ['number', 'duration']);
  if (duration === null || duration <= 0) return null;
  const unit = limit?.unit ?? limit?.timeUnit ?? limit?.time_unit;
  if (Number(unit) === 3) return duration * HOUR_SECONDS;

  const normalizedUnit = typeof unit === 'string' ? unit.toUpperCase() : '';
  if (normalizedUnit.includes('SECOND')) return duration;
  if (normalizedUnit.includes('MINUTE')) return duration * 60;
  if (normalizedUnit.includes('HOUR')) return duration * HOUR_SECONDS;
  if (normalizedUnit.includes('DAY')) return duration * DAY_SECONDS;
  if (normalizedUnit.includes('WEEK')) return duration * 7 * DAY_SECONDS;
  return null;
};

export const fetchZaiQuotaAdapter = async ({
  credential,
  fetchImpl = fetch,
  now: nowInput = Date.now,
} = {}) => {
  const providerId = 'zai-coding-plan';
  const providerName = 'z.ai';
  const now = nowInput();
  const apiKey = asNonEmptyString(credential?.apiKey);
  if (!apiKey) {
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
      errorCode: 'NOT_CONFIGURED',
      now,
    });
  }

  try {
    const response = await fetchImpl(ZAI_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return buildSharedQuotaResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
        now,
      });
    }

    const payload = asObject(await response.json());
    const data = asObject(payload?.data);
    const limits = Array.isArray(data?.limits) ? data.limits : [];
    const tokenLimits = limits
      .map((value, sourceIndex) => ({ value: asObject(value), sourceIndex }))
      .filter(({ value }) => value?.type === 'TOKENS_LIMIT');
    const warnings = [];
    const parsed = [];

    for (const { value: limit, sourceIndex } of tokenLimits) {
      const windowSeconds = resolveZaiWindowSeconds(limit);
      const usedPercent = clampPercent(firstNumber(limit, [
        'percentage',
        'usedPercent',
        'used_percent',
      ]));
      if (windowSeconds === null || usedPercent === null) {
        const missing = [
          ...(windowSeconds === null ? ['duration'] : []),
          ...(usedPercent === null ? ['percentage'] : []),
        ].join(' and ');
        warnings.push(`Token limit #${sourceIndex + 1} was skipped because its ${missing} was invalid.`);
        continue;
      }
      parsed.push({
        sourceIndex,
        windowSeconds,
        usedPercent,
        resetAt: firstTimestamp(limit, [
          'nextResetTime',
          'next_reset_time',
          'resetTime',
          'reset_time',
          'resetAt',
          'reset_at',
        ]),
      });
    }

    if (tokenLimits.length > 0 && parsed.length === 0) {
      return buildSharedQuotaResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'The z.ai quota response contained token limits, but none could be parsed.',
        errorCode: 'PARSE_ERROR',
        warnings,
        now,
      });
    }

    parsed.sort((left, right) => (
      left.windowSeconds - right.windowSeconds || left.sourceIndex - right.sourceIndex
    ));
    const windows = {};
    const labelCounts = new Map();
    for (const window of parsed) {
      const label = resolveWindowLabel(window.windowSeconds, 'tokens');
      addCollisionSafeWindow(windows, labelCounts, label, toSharedUsageWindow({
        usedPercent: window.usedPercent,
        windowSeconds: window.windowSeconds,
        resetAt: window.resetAt,
        now,
      }));
    }

    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      warnings,
      now,
    });
  } catch (error) {
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: errorMessage(error),
      now,
    });
  }
};

const resolveDurationSeconds = (durationValue, unitValue) => {
  const duration = toQuotaNumber(durationValue);
  if (duration === null || duration <= 0 || typeof unitValue !== 'string') return null;
  const unit = unitValue.toUpperCase();
  if (unit.includes('SECOND')) return duration;
  if (unit.includes('MINUTE')) return duration * 60;
  if (unit.includes('HOUR')) return duration * HOUR_SECONDS;
  if (unit.includes('DAY')) return duration * DAY_SECONDS;
  if (unit.includes('WEEK')) return duration * 7 * DAY_SECONDS;
  return null;
};

const deriveKimiUsedPercent = (detail) => {
  const explicit = firstNumber(detail, [
    'percentage',
    'usedPercent',
    'used_percent',
    'usagePercent',
    'usage_percent',
  ]);
  if (explicit !== null) return { usedPercent: clampPercent(explicit), reason: null };

  const limit = firstNumber(detail, ['limit', 'total', 'quota']);
  if (limit !== null && limit <= 0) {
    return { usedPercent: null, reason: 'the limit was not positive' };
  }
  const used = firstNumber(detail, ['used', 'usage', 'currentValue', 'current_value']);
  if (limit !== null && used !== null) {
    return { usedPercent: clampPercent((used / limit) * 100), reason: null };
  }
  const remaining = firstNumber(detail, ['remaining', 'remainingValue', 'remaining_value']);
  if (limit !== null && remaining !== null) {
    return { usedPercent: clampPercent(100 - (remaining / limit) * 100), reason: null };
  }
  return { usedPercent: null, reason: 'usage values were incomplete' };
};

const resolveKimiReset = (detail) => firstTimestamp(detail, [
  'resetTime',
  'reset_time',
  'resetAt',
  'reset_at',
  'nextResetTime',
  'next_reset_time',
]);

const resolveKimiWindowSeconds = (window) => {
  if (!window) return null;
  const explicit = firstNumber(window, ['windowSeconds', 'window_seconds', 'durationSeconds', 'duration_seconds']);
  if (explicit !== null) return explicit > 0 ? explicit : null;
  return resolveDurationSeconds(window.duration, window.timeUnit ?? window.time_unit ?? window.unit);
};

export const fetchKimiQuotaAdapter = async ({
  credential,
  fetchImpl = fetch,
  now: nowInput = Date.now,
} = {}) => {
  const providerId = 'kimi-for-coding';
  const providerName = 'Kimi for Coding';
  const now = nowInput();
  const apiKey = asNonEmptyString(credential?.apiKey);
  if (!apiKey) {
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
      errorCode: 'NOT_CONFIGURED',
      now,
    });
  }

  try {
    const response = await fetchImpl(KIMI_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return buildSharedQuotaResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
        now,
      });
    }

    const payload = asObject(await response.json()) ?? {};
    const windows = {};
    const labelCounts = new Map();
    const warnings = [];
    const weekly = asObject(payload.usage);
    if (weekly) {
      const { usedPercent, reason } = deriveKimiUsedPercent(weekly);
      const resetAt = resolveKimiReset(weekly);
      const metadata = asObject(weekly.window) ?? weekly;
      const windowSeconds = resolveKimiWindowSeconds(metadata);
      if (reason) warnings.push(`Weekly usage was incomplete: ${reason}.`);
      if (usedPercent !== null || resetAt !== null) {
        addCollisionSafeWindow(windows, labelCounts, 'weekly', toSharedUsageWindow({
          usedPercent,
          windowSeconds,
          resetAt,
          now,
        }));
      }
    }

    const limits = Array.isArray(payload.limits) ? payload.limits : [];
    for (let index = 0; index < limits.length; index += 1) {
      const limit = asObject(limits[index]);
      const detail = asObject(limit?.detail) ?? asObject(limit?.usage);
      const windowMetadata = asObject(limit?.window);
      if (!detail) {
        warnings.push(`Usage limit #${index + 1} was skipped because its detail was missing.`);
        continue;
      }

      const windowSeconds = resolveKimiWindowSeconds(windowMetadata);
      const rawLabel = resolveWindowLabel(windowSeconds, 'limit');
      const label = windowSeconds === 5 * HOUR_SECONDS ? `Rate Limit (${rawLabel})` : rawLabel;
      const { usedPercent, reason } = deriveKimiUsedPercent(detail);
      const resetAt = resolveKimiReset(detail)
        ?? resolveKimiReset(limit)
        ?? resolveKimiReset(windowMetadata);
      if (reason) warnings.push(`${label} usage was incomplete: ${reason}.`);
      if (usedPercent === null && resetAt === null) continue;
      addCollisionSafeWindow(windows, labelCounts, label, toSharedUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
        now,
      }));
    }

    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      warnings,
      now,
    });
  } catch (error) {
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: errorMessage(error),
      now,
    });
  }
};

const buildCodexHeaders = (accessToken, accountId, extra = {}) => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/json',
  ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  ...extra,
});

const normalizeResetCredit = (value, index, now) => {
  const credit = asObject(value);
  if (!credit) return null;
  const grantedAt = firstTimestamp(credit, ['granted_at', 'grantedAt']);
  const expiresAt = firstTimestamp(credit, ['expires_at', 'expiresAt']);
  return {
    id: asNonEmptyString(credit.id) ?? `reset-credit-${index}`,
    status: asNonEmptyString(credit.status) ?? 'available',
    resetType: asNonEmptyString(credit.reset_type ?? credit.resetType),
    grantedAt,
    grantedAtFormatted: formatResetTime(grantedAt, now),
    expiresAt,
    expiresAtFormatted: formatResetTime(expiresAt, now),
  };
};

const normalizeResetCreditsPayload = (payload, source, now) => {
  const data = asObject(payload);
  if (!data) return null;
  const credits = Array.isArray(data.credits)
    ? data.credits.map((value, index) => normalizeResetCredit(value, index, now)).filter(Boolean)
    : [];
  const availableCount = firstNumber(data, ['available_count', 'availableCount']);
  const totalEarnedCount = firstNumber(data, ['total_earned_count', 'totalEarnedCount']);
  if (availableCount === null && totalEarnedCount === null && credits.length === 0) return null;
  return { availableCount, totalEarnedCount, credits, source };
};

const fetchCodexResetCredits = async (fetchImpl, accessToken, accountId, now) => {
  try {
    const response = await fetchImpl(CODEX_RESET_CREDITS_URL, {
      method: 'GET',
      headers: buildCodexHeaders(accessToken, accountId, {
        'OpenAI-Beta': 'codex-1',
        originator: 'Codex Desktop',
      }),
    });
    if (!response.ok) return null;
    return normalizeResetCreditsPayload(await response.json(), 'dedicated', now);
  } catch {
    return null;
  }
};

const normalizeCodexWindow = (windowValue, fallbackLabel, now, warnings) => {
  const window = asObject(windowValue);
  if (!window) return null;
  const windowSecondsValue = firstNumber(window, ['limit_window_seconds', 'limitWindowSeconds']);
  const windowSeconds = windowSecondsValue !== null && windowSecondsValue > 0
    ? windowSecondsValue
    : null;
  const usedValue = firstNumber(window, ['used_percent', 'usedPercent']);
  if (usedValue === null) warnings.push(`${fallbackLabel} usage did not include a valid percentage.`);
  return {
    label: windowSeconds === null ? fallbackLabel : resolveWindowLabel(windowSeconds, fallbackLabel),
    usage: toSharedUsageWindow({
      usedPercent: usedValue,
      windowSeconds,
      resetAt: firstTimestamp(window, ['reset_at', 'resetAt']),
      now,
    }),
  };
};

const formatMoney = (value) => value.toFixed(2);

const buildCodexExtraUsage = (payload, now) => {
  const credits = asObject(payload?.credits);
  const spendControl = asObject(payload?.spend_control ?? payload?.spendControl);
  if (!credits && !spendControl) return null;

  const reached = firstBoolean(spendControl, ['reached']);
  const balance = firstNumber(credits, ['balance']);
  const unlimited = firstBoolean(credits, ['unlimited']);
  const available = firstBoolean(credits, ['available', 'is_available', 'isAvailable']);
  let valueLabel;
  if (reached === true) valueLabel = 'Spend limit reached';
  else if (unlimited === true) valueLabel = 'Unlimited';
  else if (available === false) valueLabel = 'Unavailable';
  else if (balance !== null) valueLabel = `$${formatMoney(balance)} available`;
  else if (available === true) valueLabel = 'Available';
  else valueLabel = 'No credit balance reported';

  const details = [];
  if (reached === true && balance !== null) details.push(`Reported balance: $${formatMoney(balance)}.`);
  if (available === false) details.push('Extra usage is not currently available.');
  return toSharedUsageWindow({
    usedPercent: null,
    windowSeconds: null,
    resetAt: null,
    valueLabel,
    description: details.join(' ') || null,
    now,
  });
};

export const fetchCodexQuotaAdapter = async ({
  credential,
  fetchImpl = fetch,
  now: nowInput = Date.now,
} = {}) => {
  const providerId = 'codex';
  const providerName = 'ChatGPT';
  const now = nowInput();
  const accessToken = asNonEmptyString(credential?.accessToken);
  const accountId = asNonEmptyString(credential?.accountId);
  if (!accessToken) {
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
      errorCode: 'NOT_CONFIGURED',
      now,
    });
  }

  try {
    const response = await fetchImpl(CODEX_USAGE_URL, {
      method: 'GET',
      headers: buildCodexHeaders(accessToken, accountId),
    });
    if (!response.ok) {
      return buildSharedQuotaResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired — please re-authenticate with OpenAI'
          : `API error: ${response.status}`,
        now,
      });
    }

    const payload = asObject(await response.json()) ?? {};
    const rateLimit = asObject(payload.rate_limit ?? payload.rateLimit);
    const warnings = [];
    const windows = {};
    const labels = new Map();
    const primary = normalizeCodexWindow(
      rateLimit?.primary_window ?? rateLimit?.primaryWindow,
      '5h',
      now,
      warnings,
    );
    const secondary = normalizeCodexWindow(
      rateLimit?.secondary_window ?? rateLimit?.secondaryWindow,
      'weekly',
      now,
      warnings,
    );
    if (primary) addCollisionSafeWindow(windows, labels, primary.label, primary.usage);
    if (secondary) addCollisionSafeWindow(windows, labels, secondary.label, secondary.usage);

    const extraUsage = buildCodexExtraUsage(payload, now);
    if (extraUsage) windows['extra-usage'] = extraUsage;

    const resetCredits = await fetchCodexResetCredits(fetchImpl, accessToken, accountId, now)
      ?? normalizeResetCreditsPayload(
        payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits,
        'usage',
        now,
      );

    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: {
        windows,
        ...(resetCredits ? { resetCredits } : {}),
      },
      warnings,
      now,
    });
  } catch (error) {
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: errorMessage(error),
      now,
    });
  }
};

const xaiHeaders = (accessToken) => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/json',
  'x-xai-token-auth': 'xai-grok-cli',
  'x-grok-client-version': XAI_CLIENT_VERSION,
  'x-grok-client-identifier': 'grok-shell',
  'User-Agent': 'xai-grok-cli',
});

const isRedirectStatus = (status) => status >= 300 && status < 400;

const assertExpectedHttpsOrigin = (response, expectedUrl, label) => {
  if (typeof response?.url !== 'string' || !response.url) return;
  let actual;
  let expected;
  try {
    actual = new URL(response.url);
    expected = new URL(expectedUrl);
  } catch {
    throw new Error(`${label} response URL was invalid.`);
  }
  if (actual.protocol !== 'https:' || actual.origin !== expected.origin) {
    throw new Error(`${label} response came from an untrusted host.`);
  }
};

const redirectError = (response, requestUrl) => {
  const location = response.headers?.get?.('location');
  if (!location) return new Error('xAI billing redirect was rejected.');
  try {
    const target = new URL(location, requestUrl);
    if (target.protocol !== 'https:' || target.hostname !== XAI_BILLING_HOST) {
      return new Error('xAI billing redirect to an untrusted host was rejected.');
    }
  } catch {
    return new Error('xAI billing redirect was rejected.');
  }
  return new Error('xAI billing redirect was rejected.');
};

const requestXaiBilling = async (fetchImpl, accessToken) => {
  const response = await fetchImpl(XAI_BILLING_URL, {
    method: 'GET',
    redirect: 'manual',
    headers: xaiHeaders(accessToken),
  });
  if (isRedirectStatus(response.status)) throw redirectError(response, XAI_BILLING_URL);
  assertExpectedHttpsOrigin(response, XAI_BILLING_URL, 'xAI billing');
  return response;
};

const readBoundedBytes = async (response, maxBytes, errorLabel) => {
  const declaredLength = toQuotaNumber(response.headers?.get?.('content-length'));
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new Error(`${errorLabel} response was too large.`);
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytesRead = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
        bytesRead += chunk.byteLength;
        if (bytesRead > maxBytes) throw new Error(`${errorLabel} response was too large.`);
        chunks.push(chunk);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed.
      }
    }
    const result = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  if (typeof response.arrayBuffer !== 'function') {
    throw new Error(`${errorLabel} response body was unavailable.`);
  }
  const result = new Uint8Array(await response.arrayBuffer());
  if (result.byteLength > maxBytes) throw new Error(`${errorLabel} response was too large.`);
  return result;
};

const readProtoVarint = (bytes, start) => {
  let value = 0;
  let multiplier = 1;
  let offset = start;
  for (let index = 0; index < 10 && offset < bytes.length; index += 1) {
    const byte = bytes[offset];
    offset += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return Number.isSafeInteger(value) ? { value, offset } : null;
    }
    multiplier *= 128;
  }
  return null;
};

const readProtoField = (bytes, start) => {
  const tag = readProtoVarint(bytes, start);
  if (!tag || tag.value === 0) return null;
  const fieldNumber = Math.floor(tag.value / 8);
  const wireType = tag.value % 8;
  if (wireType === 0) {
    const value = readProtoVarint(bytes, tag.offset);
    return value ? { fieldNumber, wireType, value: value.value, offset: value.offset } : null;
  }
  if (wireType === 2) {
    const length = readProtoVarint(bytes, tag.offset);
    if (!length || length.value < 0 || length.offset + length.value > bytes.length) return null;
    return {
      fieldNumber,
      wireType,
      value: bytes.subarray(length.offset, length.offset + length.value),
      offset: length.offset + length.value,
    };
  }
  if (wireType === 1 && tag.offset + 8 <= bytes.length) {
    return { fieldNumber, wireType, value: null, offset: tag.offset + 8 };
  }
  if (wireType === 5 && tag.offset + 4 <= bytes.length) {
    return { fieldNumber, wireType, value: null, offset: tag.offset + 4 };
  }
  return null;
};

const parseProtoTimestamp = (bytes) => {
  let seconds = null;
  let nanos = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const field = readProtoField(bytes, offset);
    if (!field || field.offset <= offset) return null;
    offset = field.offset;
    if (field.wireType !== 0) continue;
    if (field.fieldNumber === 1) seconds = field.value;
    if (field.fieldNumber === 2) nanos = field.value;
  }
  if (seconds === null) return null;
  const timestamp = seconds * 1000 + Math.floor(nanos / 1_000_000);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const parseXaiResetToken = (bytes) => {
  let tokenId = null;
  let expiresAt = null;
  let offset = 0;
  while (offset < bytes.length) {
    const field = readProtoField(bytes, offset);
    if (!field || field.offset <= offset) return null;
    offset = field.offset;
    if (field.wireType !== 2) continue;
    if (field.fieldNumber === 10 || field.fieldNumber === 1) {
      const candidate = new TextDecoder().decode(field.value).trim();
      if (candidate.length >= 4 && candidate.length <= 200) tokenId = candidate;
    } else if ([30, 20, 3, 2].includes(field.fieldNumber)) {
      const timestamp = parseProtoTimestamp(field.value);
      if (timestamp !== null && (field.fieldNumber === 30 || field.fieldNumber === 3 || expiresAt === null)) {
        expiresAt = timestamp;
      }
    }
  }
  return tokenId && expiresAt !== null ? { tokenId, expiresAt } : null;
};

const collectXaiResetTokens = (bytes, tokens, depth = 0) => {
  if (depth > 4) return false;
  let parsedAnyField = bytes.length === 0;
  let offset = 0;
  while (offset < bytes.length) {
    const field = readProtoField(bytes, offset);
    if (!field || field.offset <= offset) return false;
    parsedAnyField = true;
    offset = field.offset;
    if (field.wireType !== 2 || ![10, 1].includes(field.fieldNumber)) continue;
    const token = parseXaiResetToken(field.value);
    if (token) tokens.push(token);
    else collectXaiResetTokens(field.value, tokens, depth + 1);
  }
  return parsedAnyField;
};

const unwrapGrpcWebData = (bytes) => {
  if (bytes.length === 0) return { payload: bytes, valid: true };
  const chunks = [];
  let totalLength = 0;
  let offset = 0;
  let sawFrame = false;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) return { payload: bytes, valid: false };
    const flags = bytes[offset];
    const length = (
      bytes[offset + 1] * 0x1000000
      + bytes[offset + 2] * 0x10000
      + bytes[offset + 3] * 0x100
      + bytes[offset + 4]
    );
    offset += 5;
    if (length < 0 || offset + length > bytes.length) return { payload: bytes, valid: false };
    sawFrame = true;
    if ((flags & 0x80) === 0) {
      const chunk = bytes.subarray(offset, offset + length);
      chunks.push(chunk);
      totalLength += chunk.byteLength;
    } else {
      const trailers = new TextDecoder().decode(bytes.subarray(offset, offset + length));
      const grpcStatus = trailers.match(/(?:^|\r?\n)grpc-status:\s*(\d+)/i)?.[1];
      if (grpcStatus && grpcStatus !== '0') return { payload: new Uint8Array(), valid: false };
    }
    offset += length;
  }
  if (!sawFrame) return { payload: bytes, valid: true };
  const payload = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return { payload, valid: true };
};

const normalizeXaiResetBank = (bytes, now) => {
  const unwrapped = unwrapGrpcWebData(bytes);
  if (!unwrapped.valid) throw new Error('xAI reset bank response could not be parsed.');
  const tokens = [];
  const parsed = collectXaiResetTokens(unwrapped.payload, tokens);
  if (!parsed || (unwrapped.payload.length > 0 && tokens.length === 0)) {
    throw new Error('xAI reset bank response could not be parsed.');
  }
  const unique = new Map();
  for (const token of tokens) {
    if (token.expiresAt <= now || unique.has(token.tokenId)) continue;
    unique.set(token.tokenId, token);
  }
  const available = [...unique.values()].sort((left, right) => (
    left.expiresAt - right.expiresAt || left.tokenId.localeCompare(right.tokenId)
  ));
  if (available.length === 0) return null;
  return {
    availableCount: available.length,
    totalEarnedCount: null,
    source: 'dedicated',
    credits: available.map((token, index) => ({
      id: `xai-reset-${index + 1}-${token.expiresAt}`,
      status: 'available',
      resetType: null,
      grantedAt: null,
      grantedAtFormatted: null,
      expiresAt: token.expiresAt,
      expiresAtFormatted: formatResetTime(token.expiresAt, now),
    })),
  };
};

const fetchXaiResetBank = async (fetchImpl, accessToken, now) => {
  try {
    const response = await fetchImpl(XAI_RESET_BANK_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...xaiHeaders(accessToken),
        Accept: 'application/grpc-web+proto',
        'Content-Type': 'application/grpc-web+proto',
        'Connect-Protocol-Version': '1',
        'X-Grpc-Web': '1',
      },
      body: new Uint8Array([0, 0, 0, 0, 0]),
      signal: AbortSignal.timeout(10_000),
    });
    if (isRedirectStatus(response.status)) throw new Error('xAI reset bank redirect was rejected.');
    assertExpectedHttpsOrigin(response, XAI_RESET_BANK_URL, 'xAI reset bank');
    if (!response.ok) throw new Error(`xAI reset bank request failed: ${response.status}`);
    const bytes = await readBoundedBytes(response, XAI_RESET_BANK_MAX_RESPONSE_BYTES, 'xAI reset bank');
    return { resetCredits: normalizeXaiResetBank(bytes, now), warning: null };
  } catch {
    return {
      resetCredits: null,
      warning: 'The xAI reset bank could not be refreshed.',
    };
  }
};

const xaiPeriodLabel = (kind) => {
  if (typeof kind !== 'string') return 'usage';
  const normalized = kind.toUpperCase();
  if (normalized.includes('WEEK')) return 'weekly';
  if (normalized.includes('MONTH')) return 'monthly';
  if (normalized.includes('DAY')) return 'daily';
  return 'usage';
};

const readValNumber = (value) => {
  const object = asObject(value);
  return toQuotaNumber(object?.val ?? object?.value ?? value);
};

const normalizeXaiPayload = (payload, now) => {
  const root = asObject(payload) ?? {};
  const config = asObject(root.config) ?? root;
  const windows = {};
  const warnings = [];
  const currentPeriod = asObject(config.currentPeriod ?? config.current_period);
  const usedPercent = firstNumber(config, ['creditUsagePercent', 'credit_usage_percent']);
  const resetAt = firstTimestamp(currentPeriod, ['end', 'resetAt', 'reset_at'])
    ?? firstTimestamp(config, ['billingPeriodEnd', 'billing_period_end']);
  if (usedPercent !== null || resetAt !== null) {
    let windowSeconds = null;
    const startAt = firstTimestamp(currentPeriod, ['start', 'startAt', 'start_at']);
    if (startAt !== null && resetAt !== null && resetAt > startAt) {
      windowSeconds = Math.floor((resetAt - startAt) / 1000);
    }
    const label = xaiPeriodLabel(currentPeriod?.type ?? currentPeriod?.kind);
    windows[label] = toSharedUsageWindow({
      usedPercent,
      windowSeconds,
      resetAt,
      now,
    });
    if (usedPercent === null) warnings.push(`${label} billing did not include a usage percentage.`);
  }

  const credits = asObject(root.credits) ?? asObject(config.credits);
  const directCredits = readValNumber(root.credits ?? config.credits);
  const balance = firstNumber(credits, ['balance', 'remaining', 'available']) ?? directCredits;
  const monthlyLimit = readValNumber(root.monthlyLimit ?? root.monthly_limit);
  const usage = asObject(root.usage);
  const totalUsed = readValNumber(usage?.totalUsed ?? usage?.total_used);
  if (balance !== null) {
    windows.credits = toSharedUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `${balance.toLocaleString()} credits`,
      now,
    });
  } else if (monthlyLimit !== null || totalUsed !== null) {
    const values = [];
    if (totalUsed !== null) values.push(`${totalUsed.toLocaleString()} used`);
    if (monthlyLimit !== null) values.push(`${monthlyLimit.toLocaleString()} limit`);
    windows.credits = toSharedUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: values.join(' · '),
      now,
    });
  }

  if (Object.keys(windows).length === 0) {
    warnings.push('The xAI billing response did not include a recognized usage window or credit balance.');
  }
  return { windows, warnings };
};

const xaiReauthenticationResult = (now) => buildSharedQuotaResult({
  providerId: 'xai',
  providerName: 'xAI',
  ok: false,
  configured: true,
  error: 'Session expired — please re-authenticate with xAI',
  errorCode: 'REAUTHENTICATION_REQUIRED',
  now,
});

export const fetchXaiQuotaAdapter = async ({
  credential,
  fetchImpl = fetch,
  refreshAccessToken,
  now: nowInput = Date.now,
} = {}) => {
  const now = nowInput();
  let accessToken = asNonEmptyString(credential?.accessToken);
  const refreshToken = asNonEmptyString(credential?.refreshToken);
  if (!accessToken) {
    return buildSharedQuotaResult({
      providerId: 'xai',
      providerName: 'xAI',
      ok: false,
      configured: false,
      error: 'Not configured',
      errorCode: 'NOT_CONFIGURED',
      now,
    });
  }

  try {
    let response = await requestXaiBilling(fetchImpl, accessToken);
    if (response.status === 401) {
      if (!refreshToken || typeof refreshAccessToken !== 'function') {
        return xaiReauthenticationResult(now);
      }
      try {
        const refreshed = await refreshAccessToken({ accessToken, refreshToken });
        accessToken = asNonEmptyString(refreshed?.accessToken);
        if (!accessToken) return xaiReauthenticationResult(now);
      } catch {
        return xaiReauthenticationResult(now);
      }
      response = await requestXaiBilling(fetchImpl, accessToken);
    }

    if (response.status === 401) return xaiReauthenticationResult(now);
    if (!response.ok) {
      return buildSharedQuotaResult({
        providerId: 'xai',
        providerName: 'xAI',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
        now,
      });
    }

    const normalized = normalizeXaiPayload(await response.json(), now);
    const resetBank = await fetchXaiResetBank(fetchImpl, accessToken, now);
    return buildSharedQuotaResult({
      providerId: 'xai',
      providerName: 'xAI',
      ok: true,
      configured: true,
      usage: {
        windows: normalized.windows,
        ...(resetBank.resetCredits ? { resetCredits: resetBank.resetCredits } : {}),
      },
      warnings: [
        ...normalized.warnings,
        ...(resetBank.warning ? [resetBank.warning] : []),
      ],
      now,
    });
  } catch (error) {
    return buildSharedQuotaResult({
      providerId: 'xai',
      providerName: 'xAI',
      ok: false,
      configured: true,
      error: errorMessage(error),
      now,
    });
  }
};

export const refreshXaiOAuthToken = async ({
  refreshToken,
  fetchImpl = fetch,
  now: nowInput = Date.now,
} = {}) => {
  const normalizedRefreshToken = asNonEmptyString(refreshToken);
  if (!normalizedRefreshToken) throw new Error('xAI refresh token is unavailable.');
  const response = await fetchImpl(XAI_OAUTH_TOKEN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: normalizedRefreshToken,
      client_id: XAI_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (isRedirectStatus(response.status)) throw new Error('xAI OAuth redirect was rejected.');
  assertExpectedHttpsOrigin(response, XAI_OAUTH_TOKEN_URL, 'xAI OAuth');
  if (!response.ok) throw new Error('xAI OAuth refresh failed.');
  const payload = asObject(await response.json());
  const accessToken = asNonEmptyString(payload?.access_token ?? payload?.accessToken);
  if (!accessToken) throw new Error('xAI OAuth refresh did not return an access token.');
  const expiresIn = firstNumber(payload, ['expires_in', 'expiresIn']);
  return {
    accessToken,
    refreshToken: asNonEmptyString(payload?.refresh_token ?? payload?.refreshToken) ?? normalizedRefreshToken,
    expiresAt: expiresIn !== null && expiresIn > 0 ? nowInput() + expiresIn * 1000 : null,
  };
};

const OPENCODE_GO_WINDOWS = Object.freeze({
  rolling: { label: '5h', windowSeconds: 5 * HOUR_SECONDS },
  weekly: { label: 'weekly', windowSeconds: 7 * DAY_SECONDS },
  monthly: { label: 'monthly', windowSeconds: 30 * DAY_SECONDS },
});
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const parseOpenCodeGoReset = (value) => {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readBoundedText = async (response, maxBytes) => {
  const declaredLength = toQuotaNumber(response.headers?.get?.('content-length'));
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new Error('OpenCode Zen billing response was too large.');
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let result = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
        bytesRead += chunk.byteLength;
        if (bytesRead > maxBytes) {
          const error = new Error('OpenCode Zen billing response was too large.');
          error.code = 'RESPONSE_TOO_LARGE';
          throw error;
        }
        result += decoder.decode(chunk, { stream: true });
      }
      return result + decoder.decode();
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed.
      }
    }
  }

  if (typeof response.text !== 'function') {
    throw new Error('OpenCode Zen billing response could not be read.');
  }
  const result = await response.text();
  if (new TextEncoder().encode(result).byteLength > maxBytes) {
    const error = new Error('OpenCode Zen billing response was too large.');
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }
  return result;
};

const collectObjectSpans = (source) => {
  const stack = [];
  const spans = [];
  let quote = null;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') {
      stack.push(index);
      continue;
    }
    if (character === '}' && stack.length > 0) {
      spans.push({ start: stack.pop(), end: index + 1 });
    }
  }
  return spans;
};

const fieldPattern = (field, valuePattern) => new RegExp(
  `(?:^|[,\\{])\\s*(?:"${field}"|${field})\\s*:\\s*(${valuePattern})`,
);

const readSolidPrimitive = (source, field) => {
  const match = source.match(fieldPattern(field, 'null|true|false|!0|!1|-?\\d+(?:\\.\\d+)?'));
  if (!match) return { found: false, value: null };
  if (match[1] === 'null') return { found: true, value: null };
  if (match[1] === 'true' || match[1] === '!0') return { found: true, value: true };
  if (match[1] === 'false' || match[1] === '!1') return { found: true, value: false };
  const value = Number(match[1]);
  return { found: Number.isFinite(value), value: Number.isFinite(value) ? value : null };
};

const unescapeSolidString = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const readSolidString = (source, field) => {
  const match = source.match(fieldPattern(field, 'null|"(?:\\\\.|[^"\\\\])*"'));
  if (!match) return { found: false, value: null };
  if (match[1] === 'null') return { found: true, value: null };
  const value = unescapeSolidString(match[1]);
  return { found: typeof value === 'string', value: typeof value === 'string' ? value : null };
};

const readSolidTimestamp = (objectSource, fullSource, field) => {
  const match = objectSource.match(fieldPattern(
    field,
    'null|"(?:\\\\.|[^"\\\\])*"|new Date\\("(?:\\\\.|[^"\\\\])*"\\)|\\$R\\[\\d+\\](?:\\s*=\\s*new Date\\("(?:\\\\.|[^"\\\\])*"\\))?',
  ));
  if (!match) return { found: false, value: null };
  if (match[1] === 'null') return { found: true, value: null };
  const raw = match[1];
  if (raw.startsWith('"')) {
    const value = toQuotaTimestamp(unescapeSolidString(raw));
    return { found: value !== null, value };
  }
  if (raw.startsWith('new Date(')) {
    const value = toQuotaTimestamp(unescapeSolidString(raw.slice('new Date('.length, -1)));
    return { found: value !== null, value };
  }
  const inlineAssignment = raw.match(/new Date\(("(?:\\.|[^"\\])*")\)$/);
  if (inlineAssignment) {
    const value = toQuotaTimestamp(unescapeSolidString(inlineAssignment[1]));
    return { found: value !== null, value };
  }
  const reference = raw.match(/^\$R\[(\d+)\]$/)?.[1];
  if (!reference) return { found: false, value: null };
  const assignment = fullSource.match(new RegExp(
    `\\$R\\[${reference}\\]\\s*=\\s*new Date\\(("(?:\\\\.|[^"\\\\])*")\\)`,
  ));
  const value = assignment ? toQuotaTimestamp(unescapeSolidString(assignment[1])) : null;
  return { found: value !== null, value };
};

export const parseOpenCodeZenBillingHtml = (html, workspaceId, now = Date.now()) => {
  if (typeof html !== 'string' || !html.includes('billing.get') || !html.includes(workspaceId)) return null;

  const requiredFields = [
    'customerID',
    'paymentMethodID',
    'balance',
    'monthlyLimit',
    'monthlyUsage',
    'timeMonthlyUsageUpdated',
    'reload',
    'reloadAmount',
    'reloadAmountMin',
    'reloadTrigger',
    'reloadTriggerMin',
    'subscriptionID',
  ];
  const candidates = collectObjectSpans(html)
    .filter(({ start, end }) => end - start <= 64 * 1024)
    .filter(({ start, end }) => {
      const source = html.slice(start, end);
      return requiredFields.every((field) => fieldPattern(field, '').test(source));
    });
  const leafCandidates = candidates.filter((candidate) => !candidates.some((other) => (
    other !== candidate && other.start > candidate.start && other.end < candidate.end
  )));
  if (leafCandidates.length !== 1) return null;

  const source = html.slice(leafCandidates[0].start, leafCandidates[0].end);
  const customerID = readSolidString(source, 'customerID');
  const balance = readSolidPrimitive(source, 'balance');
  const monthlyLimit = readSolidPrimitive(source, 'monthlyLimit');
  const monthlyUsage = readSolidPrimitive(source, 'monthlyUsage');
  const reload = readSolidPrimitive(source, 'reload');
  const reloadAmount = readSolidPrimitive(source, 'reloadAmount');
  const reloadTrigger = readSolidPrimitive(source, 'reloadTrigger');
  if (
    !customerID.found || (customerID.value !== null && !customerID.value.startsWith('cus_'))
    || !balance.found || typeof balance.value !== 'number' || balance.value < 0
    || !monthlyLimit.found || (monthlyLimit.value !== null && (typeof monthlyLimit.value !== 'number' || monthlyLimit.value < 0))
    || !monthlyUsage.found || (monthlyUsage.value !== null && (typeof monthlyUsage.value !== 'number' || monthlyUsage.value < 0))
    || !reload.found || (reload.value !== null && typeof reload.value !== 'boolean')
    || !reloadAmount.found || typeof reloadAmount.value !== 'number' || reloadAmount.value < 0
    || !reloadTrigger.found || typeof reloadTrigger.value !== 'number' || reloadTrigger.value < 0
  ) {
    return null;
  }

  const parsedUsageUpdatedAt = readSolidTimestamp(source, html, 'timeMonthlyUsageUpdated');
  if (!parsedUsageUpdatedAt.found) return null;
  const usageUpdatedAt = parsedUsageUpdatedAt.value;
  const current = new Date(now);
  const updated = usageUpdatedAt === null ? null : new Date(usageUpdatedAt);
  const usageIsCurrentMonth = Boolean(
    updated
    && updated.getUTCFullYear() === current.getUTCFullYear()
    && updated.getUTCMonth() === current.getUTCMonth()
  );
  return {
    balanceMicrocents: balance.value,
    monthlyLimitDollars: typeof monthlyLimit.value === 'number' ? monthlyLimit.value : null,
    monthlyUsageMicrocents: usageIsCurrentMonth && typeof monthlyUsage.value === 'number'
      ? Math.max(0, monthlyUsage.value)
      : 0,
    usageUpdatedAt,
    reloadEnabled: reload.value === true,
    reloadAmountDollars: reloadAmount.value,
    reloadTriggerDollars: reloadTrigger.value,
  };
};

const formatOpenCodeZenMoney = (value) => {
  const formatted = Number(value).toFixed(2);
  return formatted === '-0.00' ? '0.00' : formatted;
};

export const fetchOpenCodeZenQuotaAdapter = async ({
  credential,
  fetchImpl = fetch,
  now: nowInput = Date.now,
} = {}) => {
  const providerId = 'opencode';
  const providerName = 'OpenCode Zen';
  const now = nowInput();
  const normalizedCredential = normalizeOpenCodeZenCredential(credential);
  if (!normalizedCredential) {
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
      errorCode: 'NOT_CONFIGURED',
      now,
    });
  }

  const billingUrl = `${OPENCODE_ZEN_BILLING_ORIGIN}/workspace/${normalizedCredential.workspaceId}/billing`;
  try {
    const response = await fetchImpl(billingUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'text/html',
        Cookie: `auth=${normalizedCredential.authCookie}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if ((response.status >= 300 && response.status < 400) || [401, 403, 404].includes(response.status)) {
      return buildSharedQuotaResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'OpenCode Zen dashboard authentication failed. Update the workspace session credential.',
        errorCode: 'AUTHENTICATION_FAILED',
        now,
      });
    }
    if (!response.ok) {
      return buildSharedQuotaResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `OpenCode Zen billing request failed: ${response.status}`,
        errorCode: 'API_ERROR',
        now,
      });
    }
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== OPENCODE_ZEN_BILLING_ORIGIN || finalUrl.pathname !== new URL(billingUrl).pathname) {
        return buildSharedQuotaResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'OpenCode Zen billing response came from an untrusted location.',
          errorCode: 'AUTHENTICATION_FAILED',
          now,
        });
      }
    }

    const html = await readBoundedText(response, OPENCODE_ZEN_MAX_RESPONSE_BYTES);
    const billing = parseOpenCodeZenBillingHtml(html, normalizedCredential.workspaceId, now);
    if (!billing) {
      return buildSharedQuotaResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'OpenCode Zen billing response could not be parsed.',
        errorCode: 'PARSE_ERROR',
        now,
      });
    }

    const balance = billing.balanceMicrocents / OPENCODE_ZEN_MICROCENTS_PER_DOLLAR;
    const monthlyUsage = billing.monthlyUsageMicrocents / OPENCODE_ZEN_MICROCENTS_PER_DOLLAR;
    const creditTotal = monthlyUsage + balance;
    const windows = {
      credits: toSharedUsageWindow({
        usedPercent: creditTotal > 0 ? (monthlyUsage / creditTotal) * 100 : 0,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatOpenCodeZenMoney(monthlyUsage)} used / $${formatOpenCodeZenMoney(balance)} available`,
        now,
      }),
    };
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      usageUpdatedAt: billing.usageUpdatedAt ?? undefined,
      now,
    });
  } catch (error) {
    return buildSharedQuotaResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error?.code === 'RESPONSE_TOO_LARGE'
        ? 'OpenCode Zen billing response was too large to parse.'
        : 'OpenCode Zen billing request failed.',
      errorCode: error?.code === 'RESPONSE_TOO_LARGE' ? 'PARSE_ERROR' : 'API_ERROR',
      now,
    });
  }
};

export const fetchOpenCodeGoQuotaAdapter = async ({
  credential,
  fetchImpl = fetch,
  now: nowInput = Date.now,
} = {}) => {
  const now = nowInput();
  const apiKey = asNonEmptyString(credential?.apiKey);
  if (!apiKey || /[\r\n]/.test(apiKey)) {
    return buildSharedQuotaResult({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: false,
      error: 'Not configured',
      errorCode: 'NOT_CONFIGURED',
      now,
    });
  }

  try {
    const response = await fetchImpl(OPENCODE_GO_USAGE_URL, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status >= 300 && response.status < 400) {
      return buildSharedQuotaResult({
        providerId: 'opencode-go',
        providerName: 'OpenCode Go',
        ok: false,
        configured: true,
        error: 'OpenCode Go usage redirect was rejected.',
        errorCode: 'API_ERROR',
        now,
      });
    }
    if (response.status === 401 || response.status === 403) {
      return buildSharedQuotaResult({
        providerId: 'opencode-go',
        providerName: 'OpenCode Go',
        ok: false,
        configured: true,
        error: 'OpenCode Go authentication failed.',
        errorCode: 'AUTHENTICATION_FAILED',
        now,
      });
    }
    if (!response.ok) {
      return buildSharedQuotaResult({
        providerId: 'opencode-go',
        providerName: 'OpenCode Go',
        ok: false,
        configured: true,
        error: `OpenCode Go usage API error: ${response.status}`,
        errorCode: 'API_ERROR',
        now,
      });
    }

    let payload;
    try {
      payload = asObject(await response.json());
    } catch {
      payload = null;
    }
    const usage = asObject(payload?.usage);
    const windows = {};
    const warnings = [];
    for (const [source, definition] of Object.entries(OPENCODE_GO_WINDOWS)) {
      const value = asObject(usage?.[source]);
      const percent = value?.percent;
      const resetAt = parseOpenCodeGoReset(value?.resetsAt);
      if (typeof percent !== 'number' || !Number.isFinite(percent) || resetAt === null) {
        warnings.push(`${definition.label} usage was skipped because its percentage or reset time was invalid.`);
        continue;
      }
      windows[definition.label] = toSharedUsageWindow({
        usedPercent: percent,
        windowSeconds: definition.windowSeconds,
        resetAt,
        now,
      });
    }

    if (Object.keys(windows).length === 0) {
      return buildSharedQuotaResult({
        providerId: 'opencode-go',
        providerName: 'OpenCode Go',
        ok: false,
        configured: true,
        error: 'OpenCode Go usage response could not be parsed.',
        errorCode: 'PARSE_ERROR',
        warnings,
        now,
      });
    }

    return buildSharedQuotaResult({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: true,
      configured: true,
      usage: { windows },
      warnings,
      now,
    });
  } catch {
    return buildSharedQuotaResult({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: true,
      error: 'OpenCode Go usage request failed.',
      errorCode: 'API_ERROR',
      now,
    });
  }
};

export const fetchDeepSeekQuotaAdapter = async ({
  credential,
  fetchImpl = fetch,
  now: nowInput = Date.now,
} = {}) => {
  const now = nowInput();
  const apiKey = asNonEmptyString(credential?.apiKey);
  if (!apiKey) {
    return buildSharedQuotaResult({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      ok: false,
      configured: false,
      error: 'Not configured',
      errorCode: 'NOT_CONFIGURED',
      now,
    });
  }

  try {
    const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return buildSharedQuotaResult({
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
        now,
      });
    }

    const payload = asObject(await response.json()) ?? {};
    const available = firstBoolean(payload, ['is_available', 'isAvailable']);
    const balanceInfos = Array.isArray(payload.balance_infos)
      ? payload.balance_infos
      : Array.isArray(payload.balanceInfos)
        ? payload.balanceInfos
        : [];
    const windows = {};
    const labels = new Map();
    const warnings = [];
    if (available === false) {
      warnings.push('DeepSeek reports that this account balance is currently unavailable.');
    }

    for (let index = 0; index < balanceInfos.length; index += 1) {
      const balance = asObject(balanceInfos[index]);
      const currency = asNonEmptyString(balance?.currency)?.toUpperCase();
      const total = firstNumber(balance, ['total_balance', 'totalBalance']);
      if (!currency || total === null) {
        warnings.push(`Balance row #${index + 1} was skipped because its currency or total balance was invalid.`);
        continue;
      }
      const granted = firstNumber(balance, ['granted_balance', 'grantedBalance']);
      const toppedUp = firstNumber(balance, ['topped_up_balance', 'toppedUpBalance']);
      const descriptionParts = [];
      if (granted !== null) descriptionParts.push(`Granted: ${currency} ${formatMoney(granted)}`);
      if (toppedUp !== null) descriptionParts.push(`Topped up: ${currency} ${formatMoney(toppedUp)}`);
      addCollisionSafeWindow(windows, labels, currency, toSharedUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `${currency} ${formatMoney(total)}`,
        description: descriptionParts.join(' · ') || null,
        now,
      }));
    }

    return buildSharedQuotaResult({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      ok: true,
      configured: true,
      usage: { windows },
      warnings,
      now,
    });
  } catch (error) {
    return buildSharedQuotaResult({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      ok: false,
      configured: true,
      error: errorMessage(error),
      now,
    });
  }
};
