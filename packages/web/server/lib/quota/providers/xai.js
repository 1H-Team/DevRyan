import {
  fetchXaiQuotaAdapter,
  refreshXaiOAuthToken,
} from '@openchamber/shared-runtime';

import { readAuthFile, writeAuthFile } from '../../opencode/auth.js';
import { normalizeAuthEntry } from '../utils/index.js';

export const providerId = 'xai';
export const providerName = 'xAI';
export const aliases = ['xai', 'grok', 'xai-oauth'];

const resolveAuthEntry = (auth) => {
  const authKey = aliases.find((alias) => auth[alias]) ?? null;
  return {
    authKey,
    entry: normalizeAuthEntry(authKey ? auth[authKey] : null),
  };
};

export const isConfigured = (options = {}) => {
  const auth = (options.readAuth ?? readAuthFile)();
  const { entry } = resolveAuthEntry(auth);
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async (options = {}) => {
  const readAuth = options.readAuth ?? readAuthFile;
  const persistAuth = options.writeAuth ?? writeAuthFile;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const auth = readAuth();
  const { authKey, entry } = resolveAuthEntry(auth);
  const accessToken = entry?.access ?? entry?.token;
  const refreshToken = entry?.refresh ?? entry?.refresh_token;

  const refreshAccessToken = options.refreshAccessToken ?? (refreshToken && authKey
    ? async () => {
      const refreshed = await refreshXaiOAuthToken({ refreshToken, fetchImpl, now });
      const currentEntry = normalizeAuthEntry(auth[authKey]);
      if (!currentEntry || typeof auth[authKey] !== 'object') {
        throw new Error('xAI OAuth credentials cannot be updated.');
      }
      auth[authKey] = {
        ...currentEntry,
        access: refreshed.accessToken,
        refresh: refreshed.refreshToken,
        ...(refreshed.expiresAt !== null ? { expires: refreshed.expiresAt } : {}),
      };
      persistAuth(auth);
      return refreshed;
    }
    : undefined);

  return fetchXaiQuotaAdapter({
    credential: { accessToken, refreshToken },
    fetchImpl,
    refreshAccessToken,
    now,
  });
};
