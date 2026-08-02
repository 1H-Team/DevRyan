export const DEFAULT_GITHUB_RATE_LIMIT_COOLDOWN_MS = 60_000;

const getHeader = (error, name) => {
  const headers = error?.response?.headers ?? error?.headers;
  if (!headers) {
    return null;
  }
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName && value != null) {
      return String(value);
    }
  }
  return null;
};

const getErrorMessage = (error) => {
  const messages = [
    error?.message,
    error?.response?.data?.message,
    error?.response?.data?.documentation_url,
  ];
  return messages
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
};

export const classifyGitHubApiError = (error) => {
  const status = Number(error?.status ?? error?.response?.status);
  const retryAfter = getHeader(error, 'retry-after');
  const remaining = getHeader(error, 'x-ratelimit-remaining');
  const message = getErrorMessage(error);
  const isRateLimit = status === 429 || (status === 403 && (
    remaining === '0'
    || retryAfter !== null
    || message.includes('rate limit')
    || message.includes('abuse detection')
  ));

  if (isRateLimit) {
    return 'rate_limit';
  }
  if (status === 401) {
    return 'authentication';
  }
  if (status === 403) {
    return 'forbidden';
  }
  return 'other';
};

const parseRetryAt = (error, now, fallbackMs) => {
  const resetSeconds = Number(getHeader(error, 'x-ratelimit-reset'));
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return Math.max(now + 1_000, Math.floor(resetSeconds * 1_000));
  }

  const retryAfter = getHeader(error, 'retry-after');
  const retryAfterSeconds = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return now + Math.max(1_000, Math.floor(retryAfterSeconds * 1_000));
  }
  if (retryAfter) {
    const retryAfterDate = Date.parse(retryAfter);
    if (Number.isFinite(retryAfterDate) && retryAfterDate > now) {
      return retryAfterDate;
    }
  }

  return now + fallbackMs;
};

export const createGitHubRateLimitTracker = ({
  now = () => Date.now(),
  fallbackCooldownMs = DEFAULT_GITHUB_RATE_LIMIT_COOLDOWN_MS,
} = {}) => {
  let retryAt = 0;

  const getCooldown = () => {
    const currentTime = now();
    if (retryAt <= currentTime) {
      retryAt = 0;
      return null;
    }
    return {
      retryAt,
      retryAfterMs: retryAt - currentTime,
    };
  };

  return {
    getCooldown,
    recordFailure(error) {
      if (classifyGitHubApiError(error) !== 'rate_limit') {
        return null;
      }
      const currentTime = now();
      retryAt = Math.max(retryAt, parseRetryAt(error, currentTime, fallbackCooldownMs));
      return getCooldown();
    },
    reset() {
      retryAt = 0;
    },
  };
};

export const githubRateLimitTracker = createGitHubRateLimitTracker();
