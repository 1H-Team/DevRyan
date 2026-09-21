import { fetchOpenCodeZenQuotaAdapter } from '@openchamber/shared-runtime';

import { readManagedQuotaCredential } from '../credentials/providers.js';

export const providerId = 'opencode';
export const providerName = 'OpenCode Zen';
export const aliases = ['opencode', 'zen', 'opencode-zen'];

const VALIDATION_ERRORS = {
  NOT_CONFIGURED: ['INVALID_CREDENTIAL', 'Enter a valid Zen workspace ID and auth cookie value.', 400],
  AUTHENTICATION_FAILED: ['AUTHENTICATION_FAILED', 'Zen session expired or workspace is inaccessible. Update the workspace ID and auth cookie.', 400],
  PARSE_ERROR: ['PARSE_ERROR', 'Zen returned an unsupported billing response. Your cookie may still be valid.', 502],
  TIMEOUT: ['TIMEOUT', 'Zen billing request timed out. Try again.', 504],
  API_ERROR: ['API_ERROR', 'Zen billing is temporarily unavailable. Try again.', 502],
};

export class OpenCodeZenCredentialError extends Error {
  constructor(code) {
    const [safeCode, message, status] = VALIDATION_ERRORS[code] ?? VALIDATION_ERRORS.API_ERROR;
    super(message);
    this.code = safeCode;
    this.status = status;
  }
}

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
  if (!result.ok) throw new OpenCodeZenCredentialError(result.errorCode);
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
