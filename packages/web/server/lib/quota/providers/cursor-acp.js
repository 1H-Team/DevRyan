import { readAuthFile } from '../../opencode/auth.js';
import fs from 'node:fs';
import { readManagedQuotaCredential, writeManagedQuotaCredential } from '../credentials/providers.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
} from '../utils/index.js';

export const providerId = 'cursor-acp';
export const providerName = 'Cursor';
export const aliases = ['cursor-acp'];

const CURRENT_PERIOD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage';
const DASHBOARD_URL = 'https://cursor.com/dashboard?tab=spending';
const CURSOR_OAUTH_BASE_URL = 'https://api2.cursor.sh';
const CURSOR_OAUTH_USAGE_URL = `${CURSOR_OAUTH_BASE_URL}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const CURSOR_OAUTH_REFRESH_URL = `${CURSOR_OAUTH_BASE_URL}/oauth/token`;
const CURSOR_OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const CURSOR_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const getCursorUsageSessionToken = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const token = typeof entry?.usageSessionToken === 'string' ? entry.usageSessionToken.trim() : '';
  return token || null;
};

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const defaultReadTokenFile = (filePath) => {
  if (!filePath) return '';
  try {
    return trimString(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return '';
  }
};

export const resolveCursorQuotaCredential = ({
  env = process.env,
  readTokenFile = defaultReadTokenFile,
  readManagedCredential = readManagedQuotaCredential,
  readAuth = readAuthFile,
} = {}) => {
  const environmentAccessToken = trimString(env.CURSOR_TOKEN) || trimString(env.CURSOR_ACCESS_TOKEN);
  const environmentRefreshToken = trimString(env.CURSOR_REFRESH_TOKEN);
  if (environmentAccessToken || environmentRefreshToken) {
    return {
      kind: 'oauth',
      source: 'environment',
      credential: {
        ...(environmentAccessToken ? { accessToken: environmentAccessToken } : {}),
        ...(environmentRefreshToken ? { refreshToken: environmentRefreshToken } : {}),
      },
    };
  }

  const fileAccessToken = readTokenFile(trimString(env.CURSOR_TOKEN_FILE));
  const fileRefreshToken = readTokenFile(trimString(env.CURSOR_REFRESH_TOKEN_FILE));
  if (fileAccessToken || fileRefreshToken) {
    return {
      kind: 'oauth',
      source: 'token-file',
      credential: {
        ...(fileAccessToken ? { accessToken: fileAccessToken } : {}),
        ...(fileRefreshToken ? { refreshToken: fileRefreshToken } : {}),
      },
    };
  }

  const managed = readManagedCredential(providerId);
  if (managed?.sessionToken) {
    return { kind: 'dashboard', source: 'managed', credential: managed };
  }
  if (managed?.accessToken || managed?.refreshToken) {
    return { kind: 'oauth', source: 'managed', credential: managed };
  }

  const sessionToken = getCursorUsageSessionToken(readAuth());
  return sessionToken
    ? { kind: 'dashboard', source: 'legacy', credential: { sessionToken } }
    : { kind: null, source: null, credential: null };
};

export const getCursorUsageSessionTokenCandidates = (sessionToken) => {
  const token = typeof sessionToken === 'string' ? sessionToken.trim() : '';
  if (!token) return [];

  const candidates = [token];
  const addCandidate = (candidate) => {
    const normalized = typeof candidate === 'string' ? candidate.trim() : '';
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  if (token.includes('::')) {
    addCandidate(token.replaceAll('::', '%3A%3A'));
  }

  if (/%[0-9a-f]{2}/i.test(token)) {
    try {
      addCandidate(decodeURIComponent(token));
    } catch {
      // Keep the raw token when it is not valid URI-encoded text.
    }
  }

  return candidates;
};

export const isConfigured = (options = {}) => {
  return Boolean(resolveCursorQuotaCredential(options).credential);
};

const resolveBillingWindowSeconds = (startAt, endAt) => {
  if (typeof startAt !== 'number' || typeof endAt !== 'number' || endAt <= startAt) {
    return null;
  }
  return Math.round((endAt - startAt) / 1000);
};

const buildCursorUsage = (payload) => {
  const plan = payload?.individualUsage?.plan ?? payload?.planUsage;
  if (!plan || typeof plan !== 'object') {
    throw new Error('Cursor usage response did not include plan usage buckets.');
  }

  const autoPercent = toNumber(plan.autoPercentUsed);
  const apiPercent = toNumber(plan.apiPercentUsed);
  if (autoPercent === null || apiPercent === null) {
    throw new Error('Cursor usage response did not include plan usage buckets.');
  }

  const billingCycleStart = toTimestamp(payload?.billingCycleStart);
  const billingCycleEnd = toTimestamp(payload?.billingCycleEnd);
  const windowSeconds = resolveBillingWindowSeconds(billingCycleStart, billingCycleEnd);

  const windows = {};
  windows['auto-composer'] = toUsageWindow({
    usedPercent: autoPercent,
    windowSeconds,
    resetAt: billingCycleEnd,
  });
  windows.api = toUsageWindow({
    usedPercent: apiPercent,
    windowSeconds,
    resetAt: billingCycleEnd,
  });

  return {
    windows,
  };
};

const buildCursorUsageRequests = (sessionToken) => [
  {
    url: CURRENT_PERIOD_USAGE_URL,
    init: {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        Pragma: 'no-cache',
        Origin: 'https://cursor.com',
        Referer: DASHBOARD_URL,
        Cookie: `WorkosCursorSessionToken=${sessionToken}`,
      },
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    },
  },
];

const fetchCursorDashboardPayload = async (sessionToken, fetchImpl) => {
  let response = null;
  for (const tokenCandidate of getCursorUsageSessionTokenCandidates(sessionToken)) {
    for (const request of buildCursorUsageRequests(tokenCandidate)) {
      response = await fetchImpl(request.url, request.init);
      if (response.ok) break;
      if (response.status >= 300 && response.status < 400) break;
    }
    if (response?.ok || (response && response.status >= 300 && response.status < 400)) break;
  }

  if (!response?.ok) {
    throw new Error(response?.status === 401 || response?.status === 403 || (response && response.status >= 300 && response.status < 400)
      ? 'Cursor session expired. Update the Cursor usage session token.'
      : `Cursor usage API error: ${response?.status ?? 'unknown'}`);
  }
  const payload = await response.json();
  buildCursorUsage(payload);
  return payload;
};

const readJwtExpiry = (token) => {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed?.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
};

const cursorAccessTokenNeedsRefresh = (accessToken) => {
  if (!accessToken) return true;
  const expiresAt = readJwtExpiry(accessToken);
  return expiresAt !== null && expiresAt - Date.now() <= CURSOR_REFRESH_BUFFER_MS;
};

const refreshCursorAccessToken = async (refreshToken, fetchImpl) => {
  const response = await fetchImpl(CURSOR_OAUTH_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CURSOR_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || response.status >= 300 && response.status < 400) {
    throw new Error('Cursor OAuth session expired. Update or import the Cursor credential.');
  }
  const accessToken = trimString(payload?.access_token);
  if (!accessToken) throw new Error('Cursor refresh response did not include an access token.');
  return accessToken;
};

const resolveCursorOAuthAccessToken = async (credential, fetchImpl) => {
  const currentAccessToken = trimString(credential?.accessToken);
  if (!cursorAccessTokenNeedsRefresh(currentAccessToken)) {
    return { accessToken: currentAccessToken, credential, refreshed: false };
  }
  const refreshToken = trimString(credential?.refreshToken);
  if (!refreshToken) throw new Error('Cursor access token is required.');
  const accessToken = await refreshCursorAccessToken(refreshToken, fetchImpl);
  return {
    accessToken,
    credential: { accessToken, refreshToken },
    refreshed: true,
  };
};

const fetchCursorOAuthPayload = async (accessToken, fetchImpl) => {
  const response = await fetchImpl(CURSOR_OAUTH_USAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || response.status >= 300 && response.status < 400) {
    throw new Error(response.status === 401 || response.status === 403
      ? 'Cursor OAuth session expired. Update or import the Cursor credential.'
      : `Cursor usage API error: ${response.status}`);
  }
  const payload = await response.json();
  buildCursorUsage(payload);
  return payload;
};

export const validateCursorQuotaCredential = async (credential, fetchImpl = globalThis.fetch) => {
  if (credential?.sessionToken) {
    await fetchCursorDashboardPayload(credential.sessionToken, fetchImpl);
    return credential;
  }
  const resolved = await resolveCursorOAuthAccessToken(credential, fetchImpl);
  await fetchCursorOAuthPayload(resolved.accessToken, fetchImpl);
  return resolved.credential;
};

export const fetchCursorAcpQuota = async ({
  readAuth = readAuthFile,
  readManagedCredential = readManagedQuotaCredential,
  writeManagedCredential = writeManagedQuotaCredential,
  readTokenFile = defaultReadTokenFile,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const resolved = resolveCursorQuotaCredential({ readAuth, readManagedCredential, readTokenFile, env });
  if (!resolved.credential) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Cursor usage tracking is not configured.',
    });
  }

  try {
    let payload;
    if (resolved.kind === 'dashboard') {
      payload = await fetchCursorDashboardPayload(resolved.credential.sessionToken, fetchImpl);
    } else {
      const oauth = await resolveCursorOAuthAccessToken(resolved.credential, fetchImpl);
      payload = await fetchCursorOAuthPayload(oauth.accessToken, fetchImpl);
      if (oauth.refreshed && resolved.source === 'managed') {
        writeManagedCredential(providerId, oauth.credential);
      }
    }
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: buildCursorUsage(payload),
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

export const fetchQuota = fetchCursorAcpQuota;
