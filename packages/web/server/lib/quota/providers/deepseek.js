import { fetchDeepSeekQuotaAdapter } from '@openchamber/shared-runtime';

import { readAuthFile } from '../../opencode/auth.js';
import { getAuthEntry, normalizeAuthEntry } from '../utils/index.js';

export const providerId = 'deepseek';
export const providerName = 'DeepSeek';
export const aliases = ['deepseek'];

export const isConfigured = (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return fetchDeepSeekQuotaAdapter({
    credential: { apiKey: entry?.key ?? entry?.token },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};
