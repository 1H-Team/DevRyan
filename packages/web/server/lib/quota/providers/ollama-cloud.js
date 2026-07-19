import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildResult, toUsageWindow, toNumber } from '../utils/index.js';
import { readManagedQuotaCredential } from '../credentials/providers.js';

const COOKIE_PATH = join(homedir(), '.config', 'ollama-quota', 'cookie');

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
export const aliases = ['ollama-cloud', 'ollamacloud'];

const readCookieFile = ({ exists = existsSync, readFile = readFileSync } = {}) => {
  try {
    if (!exists(COOKIE_PATH)) return null;
    const content = readFile(COOKIE_PATH, 'utf-8');
    const trimmed = content.trim();
    return trimmed || null;
  } catch {
    return null;
  }
};

export const parseOllamaSettingsHtml = (html) => {
  const windows = {};
  const sessionMatch = html.match(/Session\s+usage[^0-9]*([0-9.]+)%/i);
  if (sessionMatch) {
    windows.session = toUsageWindow({
      usedPercent: toNumber(sessionMatch[1]),
      windowSeconds: null,
      resetAt: null
    });
  }
  const weeklyMatch = html.match(/Weekly\s+usage[^0-9]*([0-9.]+)%/i);
  if (weeklyMatch) {
    windows.weekly = toUsageWindow({
      usedPercent: toNumber(weeklyMatch[1]),
      windowSeconds: null,
      resetAt: null
    });
  }
  const premiumMatch = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
  if (premiumMatch) {
    const used = toNumber(premiumMatch[1]);
    const total = toNumber(premiumMatch[2]);
    const usedPercent = total && used !== null ? Math.min(100, (used / total) * 100) : null;
    windows.premium = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `${used ?? 0} / ${total ?? 0}`
    });
  }
  return windows;
};

export const resolveOllamaCloudCredential = ({
  readManagedCredential = readManagedQuotaCredential,
  readLegacyCookie = readCookieFile,
} = {}) => {
  const managed = readManagedCredential(providerId);
  if (managed) return { credential: managed, source: 'managed' };
  const cookie = readLegacyCookie();
  return cookie
    ? { credential: { cookie }, source: 'legacy' }
    : { credential: null, source: null };
};

export const isConfigured = (options = {}) => {
  return Boolean(resolveOllamaCloudCredential(options).credential);
};

export const fetchOllamaCloudUsage = async (credential, fetchImpl = globalThis.fetch) => {
  const response = await fetchImpl('https://ollama.com/settings', {
    method: 'GET',
    headers: {
      Cookie: credential.cookie,
      'User-Agent': 'DevRyan quota provider',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
  const windows = parseOllamaSettingsHtml(await response.text());
  if (Object.keys(windows).length === 0) {
    throw new Error('Ollama Cloud usage data could not be parsed');
  }
  return windows;
};

export const fetchQuota = async ({
  fetchImpl = globalThis.fetch,
  readManagedCredential = readManagedQuotaCredential,
  readLegacyCookie = readCookieFile,
} = {}) => {
  const { credential } = resolveOllamaCloudCredential({ readManagedCredential, readLegacyCookie });

  if (!credential) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const windows = await fetchOllamaCloudUsage(credential, fetchImpl);

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
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
