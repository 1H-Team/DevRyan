import { fetchOpenCodeZenQuotaAdapter } from '@openchamber/shared-runtime';

import { readManagedQuotaCredential } from '../credentials/providers.js';

export const providerId = 'opencode';
export const providerName = 'OpenCode Zen';
export const aliases = ['opencode', 'zen', 'opencode-zen'];

export const resolveOpenCodeZenCredential = ({
  readManagedCredential = readManagedQuotaCredential,
} = {}) => {
  const credential = readManagedCredential(providerId);
  return {
    credential,
    source: credential ? 'managed' : null,
  };
};

export const isConfigured = (options = {}) => Boolean(resolveOpenCodeZenCredential(options).credential);

export const validateOpenCodeZenCredential = async (credential, options = {}) => {
  const result = await fetchOpenCodeZenQuotaAdapter({
    credential,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    now: options.now ?? Date.now,
  });
  if (!result.ok) throw new Error('OpenCode Zen dashboard credential could not be validated.');
  return credential;
};

export const fetchQuota = async ({
  readManagedCredential = readManagedQuotaCredential,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) => {
  const { credential } = resolveOpenCodeZenCredential({ readManagedCredential });
  return fetchOpenCodeZenQuotaAdapter({ credential, fetchImpl, now });
};
