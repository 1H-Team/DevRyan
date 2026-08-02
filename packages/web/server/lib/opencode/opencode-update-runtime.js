const DEFAULT_RELEASE_URL = 'https://api.github.com/repos/anomalyco/opencode/releases/latest';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

const SEMVER_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const normalizeOpenCodeVersion = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(SEMVER_PATTERN);
  if (!match) return null;

  const [, major, minor, patch, prerelease] = match;
  return `${Number(major)}.${Number(minor)}.${Number(patch)}${prerelease ? `-${prerelease}` : ''}`;
};

const parseVersion = (value) => {
  const normalized = normalizeOpenCodeVersion(value);
  if (!normalized) return null;

  const [core, prerelease] = normalized.split('-', 2);
  return {
    normalized,
    core: core.split('.').map((part) => Number.parseInt(part, 10)),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
};
const comparePrereleaseIdentifier = (left, right) => {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.localeCompare(right);
};

export const compareOpenCodeVersions = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;

  for (let index = 0; index < 3; index += 1) {
    const diff = a.core[index] - b.core[index];
    if (diff !== 0) return diff;
  }

  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const diff = comparePrereleaseIdentifier(leftPart, rightPart);
    if (diff !== 0) return diff;
  }

  return 0;
};

export const buildOpenCodeUpdateInfo = ({
  currentVersion,
  latestVersion,
  supportedVersion,
}) => {
  const current = normalizeOpenCodeVersion(currentVersion);
  const latest = normalizeOpenCodeVersion(latestVersion);
  const supported = normalizeOpenCodeVersion(supportedVersion);

  if (!latest) {
    throw new Error('Unable to determine the latest OpenCode version');
  }
  if (!supported) {
    throw new Error('Unable to determine the DevRyan-supported OpenCode version');
  }

  const latestComparison = current ? compareOpenCodeVersions(latest, current) : null;
  const supportComparison = current ? compareOpenCodeVersions(current, supported) : null;
  const supportStatus =
    supportComparison === null
      ? 'unknown'
      : supportComparison === 0
        ? 'supported'
        : supportComparison < 0
          ? 'older'
          : 'newer';

  return {
    currentVersion: current,
    latestVersion: latest,
    supportedVersion: supported,
    updateAvailable: latestComparison === null ? null : latestComparison > 0,
    supportStatus,
  };
};

export const createOpenCodeUpdateRuntime = ({
  fetchImpl = globalThis.fetch,
  releaseUrl = DEFAULT_RELEASE_URL,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  createTimeoutSignal = (durationMs) => AbortSignal.timeout(durationMs),
} = {}) => {
  let cachedLatestVersion = null;
  let cachedAt = 0;
  let pendingLatestVersion = null;

  const fetchLatestVersion = async () => {
    if (cachedLatestVersion && now() - cachedAt < cacheTtlMs) {
      return cachedLatestVersion;
    }
    if (pendingLatestVersion) {
      return pendingLatestVersion;
    }

    pendingLatestVersion = (async () => {
      let response;
      try {
        response = await fetchImpl(releaseUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'DevRyan-OpenCode-Update-Check',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: createTimeoutSignal(timeoutMs),
        });
      } catch {
        throw new Error('Unable to check the latest OpenCode version');
      }

      if (!response?.ok) {
        throw new Error(`OpenCode release check failed with ${response?.status || 'an unknown status'}`);
      }

      const release = await response.json().catch(() => null);
      const latestVersion = normalizeOpenCodeVersion(release?.tag_name);
      if (!latestVersion) {
        throw new Error('Unable to determine the latest OpenCode version');
      }

      cachedLatestVersion = latestVersion;
      cachedAt = now();
      return latestVersion;
    })();

    try {
      return await pendingLatestVersion;
    } finally {
      pendingLatestVersion = null;
    }
  };

  const checkForUpdates = async ({ currentVersion, supportedVersion }) => {
    const latestVersion = await fetchLatestVersion();
    return buildOpenCodeUpdateInfo({
      currentVersion,
      latestVersion,
      supportedVersion,
    });
  };

  return {
    checkForUpdates,
    fetchLatestVersion,
  };
};
