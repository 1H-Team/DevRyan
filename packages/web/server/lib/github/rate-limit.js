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

export const DEFAULT_GITHUB_PERMISSION_REFUSAL_TTL_MS = 300_000;
export const DEFAULT_GITHUB_PERMISSION_REFUSAL_MAX_ENTRIES = 1_000;
// Every client is built with Octokit's default base URL. The origin is part of
// the key so a future GitHub Enterprise host cannot share refusals.
export const GITHUB_API_ORIGIN = 'https://api.github.com';

// Only GitHub's own permission refusal is stable enough to remember. Rate
// limits, 401s, 404s, 5xx, transport failures and DevRyan's internal
// BRANCH_NOT_ASSIGNED 403s (which carry `statusCode`, not `status`) are not.
export const isStableGitHubPermissionRefusal = (error) => (
  error?.status === 403
  && error?.code !== 'BRANCH_NOT_ASSIGNED'
  && classifyGitHubApiError(error) === 'forbidden'
);

const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Remembers `getCollaboratorPermissionLevel` refusals per exact stored
 * credential. The key is the API origin, account id, server-only credential
 * revision and the lowercased owner and repo, so a replaced credential never
 * inherits a refusal and a late response from an old credential can only write
 * under that old revision. Entries without a revision are never cached.
 */
export const createGitHubPermissionRefusalCache = ({
  now = () => Date.now(),
  ttlMs = DEFAULT_GITHUB_PERMISSION_REFUSAL_TTL_MS,
  maxEntries = DEFAULT_GITHUB_PERMISSION_REFUSAL_MAX_ENTRIES,
} = {}) => {
  const expiresAtByKey = new Map();

  const keyFor = ({ apiOrigin = GITHUB_API_ORIGIN, accountId, credentialRevision, owner, repo } = {}) => {
    if (![apiOrigin, accountId, credentialRevision, owner, repo].every(nonEmptyString)) {
      return null;
    }
    return JSON.stringify([
      apiOrigin,
      accountId,
      credentialRevision,
      owner.trim().toLowerCase(),
      repo.trim().toLowerCase(),
    ]);
  };

  return {
    has(identity) {
      const key = keyFor(identity);
      if (key === null) return false;
      const expiresAt = expiresAtByKey.get(key);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now()) {
        expiresAtByKey.delete(key);
        return false;
      }
      return true;
    },
    record(identity, error) {
      if (!isStableGitHubPermissionRefusal(error)) return false;
      const key = keyFor(identity);
      if (key === null || maxEntries <= 0) return false;
      expiresAtByKey.delete(key);
      while (expiresAtByKey.size >= maxEntries) {
        const oldest = expiresAtByKey.keys().next().value;
        expiresAtByKey.delete(oldest);
      }
      expiresAtByKey.set(key, now() + ttlMs);
      return true;
    },
    size() {
      return expiresAtByKey.size;
    },
    clear() {
      expiresAtByKey.clear();
    },
  };
};
