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

const normalizeOpenCodeZenCredential = (value) => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['workspaceId', 'authCookie'])) return null;
  const workspaceId = cleanValue(value.workspaceId);
  const authCookie = cleanValue(value.authCookie);
  if (!/^wrk_[0-9A-HJKMNP-TV-Z]{26}$/.test(workspaceId) || /[\s;]/.test(authCookie)) return null;
  return { workspaceId, authCookie };
};

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
  if (!credential) return { configured: false };

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
      credentialKind: 'dashboard',
      secretMasked: SECRET_MASK,
    };
  }
  return {
    configured: true,
    credentialKind: 'cookie',
    secretMasked: SECRET_MASK,
  };
};
