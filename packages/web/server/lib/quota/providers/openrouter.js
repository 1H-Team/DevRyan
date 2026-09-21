import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  formatMoney
} from '../utils/index.js';

export const providerId = 'openrouter';
export const providerName = 'OpenRouter';
export const aliases = ['openrouter'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const parseOpenRouterKey = (key) => {
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const limit = finite(key?.limit), usage = finite(key?.usage), remaining = finite(key?.limit_remaining);
  const unlimited = key?.limit === null;
  const labels = [];
  if (unlimited) labels.push('No key spending limit');
  else if (remaining !== null) labels.push(`$${formatMoney(Math.max(0, remaining))} key budget left`);
  else if (limit !== null) labels.push(`$${formatMoney(limit)} key limit`);
  if (usage !== null) labels.push(`$${formatMoney(usage)} spent`);
  if (!labels.length) throw new Error('OpenRouter key usage data is unavailable');
  return { credits: toUsageWindow({
    usedPercent: limit !== null && limit > 0 && remaining !== null ? Math.max(0, Math.min(100, (limit - remaining) / limit * 100))
      : limit === 0 && remaining === 0 ? 100 : null,
    windowSeconds: null, resetAt: null, valueLabel: labels.join(' · '),
  }) };
};

export const fetchQuota = async ({ fetchImpl = globalThis.fetch, readAuth = readAuthFile } = {}) => {
  const auth = readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetchImpl('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const windows = parseOpenRouterKey(payload?.data);

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
