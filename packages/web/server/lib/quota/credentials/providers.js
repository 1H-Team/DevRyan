import { isOpenCodeConsoleOrgId, isOpenCodeConsoleToken } from '@openchamber/shared-runtime';

import {
  QuotaCredentialError,
  canonicalizeManagedQuotaProviderId,
  deleteQuotaCredential,
  readQuotaCredential,
  writeQuotaCredential,
} from './store.js';

const MAX_VALUE_BYTES = 16 * 1024;
const SECRET_MASK = '••••••••';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (record, allowed) => {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
};

const cleanValue = (value) => {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) return '';
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_VALUE_BYTES) return '';
  return trimmed;
};

const normalizeOllamaCloudCredential = (value) => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['cookie'])) return null;
  const cookie = cleanValue(value.cookie);
  return cookie ? { cookie } : null;
};

// OpenCode Console device sign-in tokens; only the server ever writes this shape.
const normalizeOpenCodeZenCredential = (value) => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['orgId', 'accessToken', 'refreshToken', 'accessTokenExpiresAt'])) {
    return null;
  }
  const orgId = cleanValue(value.orgId);
  const accessToken = cleanValue(value.accessToken);
  const refreshToken = cleanValue(value.refreshToken);
  const { accessTokenExpiresAt } = value;
  if (
    !isOpenCodeConsoleOrgId(orgId)
    || !isOpenCodeConsoleToken(accessToken)
    || !isOpenCodeConsoleToken(refreshToken)
    || !Number.isSafeInteger(accessTokenExpiresAt)
    || accessTokenExpiresAt <= 0
  ) {
    return null;
  }
  return { orgId, accessToken, refreshToken, accessTokenExpiresAt };
};

// The retired dashboard form ({ workspaceId, authCookie }) can no longer authenticate.
// It is detected only so Settings can ask for a reconnect; it is never sent anywhere.
const detectLegacyOpenCodeZenCredential = (value) => (
  isRecord(value) && hasOnlyKeys(value, ['workspaceId', 'authCookie']) && typeof value.workspaceId === 'string'
    ? { legacy: true }
    : null
);

export const hasLegacyOpenCodeZenCredential = (options = {}) => Boolean(
  readQuotaCredential('opencode', detectLegacyOpenCodeZenCredential, options),
);

const normalizeCursorCredential = (value) => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionToken', 'accessToken', 'refreshToken'])) return null;
  const sessionToken = cleanValue(value.sessionToken);
  const accessToken = cleanValue(value.accessToken);
  const refreshToken = cleanValue(value.refreshToken);
  const hasDashboardCredential = Boolean(sessionToken);
  const hasOAuthCredential = Boolean(accessToken || refreshToken);
  if (hasDashboardCredential === hasOAuthCredential) return null;
  return hasDashboardCredential
    ? { sessionToken }
    : {
        ...(accessToken ? { accessToken } : {}),
        ...(refreshToken ? { refreshToken } : {}),
      };
};

export const managedQuotaCredentialNormalizers = Object.freeze({
  opencode: normalizeOpenCodeZenCredential,
  'ollama-cloud': normalizeOllamaCloudCredential,
  'cursor-acp': normalizeCursorCredential,
});

export const normalizeManagedQuotaCredential = (providerId, value) => {
  const canonical = canonicalizeManagedQuotaProviderId(providerId);
  return managedQuotaCredentialNormalizers[canonical](value);
};

export const assertManagedQuotaCredential = (providerId, value) => {
  const canonical = canonicalizeManagedQuotaProviderId(providerId);
  const credential = managedQuotaCredentialNormalizers[canonical](value);
  if (!credential) {
    throw new QuotaCredentialError('INVALID_CREDENTIAL', 'Invalid credential');
  }
  return { canonical, credential };
};

export const readManagedQuotaCredential = (providerId, options = {}) => {
  const canonical = canonicalizeManagedQuotaProviderId(providerId);
  return readQuotaCredential(
    canonical,
    managedQuotaCredentialNormalizers[canonical],
    options,
  );
};

export const writeManagedQuotaCredential = (providerId, value, options = {}) => {
  const { canonical, credential } = assertManagedQuotaCredential(providerId, value);
  writeQuotaCredential(canonical, credential, options);
  return getManagedQuotaCredentialStatus(canonical, options);
};

export const deleteManagedQuotaCredential = (providerId, options = {}) => {
  deleteQuotaCredential(canonicalizeManagedQuotaProviderId(providerId), options);
};

export const getManagedQuotaCredentialStatus = (providerId, options = {}) => {
  const canonical = canonicalizeManagedQuotaProviderId(providerId);
  const credential = readManagedQuotaCredential(canonical, options);
  if (!credential) {
    return canonical === 'opencode' && hasLegacyOpenCodeZenCredential(options)
      ? { configured: false, reconnectRequired: true }
      : { configured: false };
  }

  if (canonical === 'cursor-acp') {
    const credentialKind = credential.sessionToken ? 'dashboard' : 'oauth';
    return {
      configured: true,
      credentialKind,
      ...(credentialKind === 'oauth'
        ? { hasRefreshToken: Boolean(credential.refreshToken) }
        : {}),
      secretMasked: SECRET_MASK,
    };
  }
  if (canonical === 'opencode') {
    return {
      configured: true,
      credentialKind: 'oauth',
      workspaceId: credential.orgId,
      secretMasked: SECRET_MASK,
    };
  }
  return {
    configured: true,
    credentialKind: 'cookie',
    secretMasked: SECRET_MASK,
  };
};
