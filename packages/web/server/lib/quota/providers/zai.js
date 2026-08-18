import { fetchZaiQuotaAdapter } from '@openchamber/shared-runtime';

import { readAuthFile } from '../../opencode/auth.js';
import { getAuthEntry, normalizeAuthEntry } from '../utils/index.js';

export const providerId = 'zai-coding-plan';
export const providerName = 'z.ai';
export const aliases = ['zai-coding-plan', 'zai', 'z.ai'];

export const isConfigured = (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return fetchZaiQuotaAdapter({
    credential: { apiKey: entry?.key ?? entry?.token },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};
