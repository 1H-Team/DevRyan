import { fetchKimiQuotaAdapter } from '@openchamber/shared-runtime';

import { readAuthFile } from '../../opencode/auth.js';
import { getAuthEntry, normalizeAuthEntry } from '../utils/index.js';

export const providerId = 'kimi-for-coding';
export const providerName = 'Kimi for Coding';
export const aliases = ['kimi-for-coding', 'kimi'];

export const isConfigured = (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return fetchKimiQuotaAdapter({
    credential: { apiKey: entry?.key ?? entry?.token },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};
