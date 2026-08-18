import { fetchCodexQuotaAdapter } from '@openchamber/shared-runtime';

import { readAuthFile } from '../../opencode/auth.js';
import { getAuthEntry, normalizeAuthEntry } from '../utils/index.js';

export const providerId = 'codex';
export const providerName = 'ChatGPT';
export const aliases = ['openai', 'codex', 'chatgpt'];

export const isConfigured = (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return fetchCodexQuotaAdapter({
    credential: {
      accessToken: entry?.access ?? entry?.token,
      accountId: entry?.accountId ?? entry?.account_id,
    },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};
