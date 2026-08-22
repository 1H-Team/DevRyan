import { fetchOpenCodeGoQuotaAdapter } from '@openchamber/shared-runtime';

import { mutateAuthFile, readAuthFile } from '../../opencode/auth.js';
import { deleteLegacyOpenCodeGoQuotaCredential } from '../credentials/store.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';
export const aliases = ['opencode-go', 'opencodego', 'go'];

const safeCredentialValue = (value) => {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return '';
  return value.trim();
};

export const resolveOpenCodeGoCredentials = ({ readAuth = readAuthFile } = {}) => {
  const auth = readAuth();
  const entry = aliases
    .map((alias) => auth?.[alias])
    .find((value) => value && typeof value === 'object' && !Array.isArray(value));
  const apiKey = safeCredentialValue(entry?.key)
    || safeCredentialValue(entry?.token)
    || safeCredentialValue(entry?.access);
  return {
    apiConfigured: Boolean(apiKey),
    apiKey,
    source: apiKey ? 'auth' : null,
  };
};

export const isConfigured = (options = {}) => resolveOpenCodeGoCredentials(options).apiConfigured;

const cleanLegacyCredentials = ({
  deleteManagedCredential = deleteLegacyOpenCodeGoQuotaCredential,
  mutateAuth = mutateAuthFile,
} = {}) => {
  let failed = false;
  try {
    deleteManagedCredential();
  } catch {
    failed = true;
  }
  try {
    mutateAuth((auth) => {
      const entry = auth?.[providerId];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      if (!Object.hasOwn(entry, 'usageWorkspaceId') && !Object.hasOwn(entry, 'usageAuthCookie')) return false;
      delete entry.usageWorkspaceId;
      delete entry.usageAuthCookie;
      return auth;
    });
  } catch {
    failed = true;
  }
  return failed ? ['OpenCode Go usage refreshed, but legacy credential cleanup failed.'] : [];
};

export const fetchQuota = async ({
  readAuth = readAuthFile,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  deleteManagedCredential,
  mutateAuth,
} = {}) => {
  const credentials = resolveOpenCodeGoCredentials({ readAuth });
  const result = await fetchOpenCodeGoQuotaAdapter({
    credential: { apiKey: credentials.apiKey },
    fetchImpl,
    now,
  });
  if (!result.ok) return result;

  const cleanupWarnings = cleanLegacyCredentials({ deleteManagedCredential, mutateAuth });
  return cleanupWarnings.length > 0
    ? { ...result, warnings: [...(result.warnings ?? []), ...cleanupWarnings] }
    : result;
};
