import crypto from 'node:crypto';

import {
  buildSharedQuotaResult,
  exchangeOpenCodeConsoleDeviceCode,
  fetchOpenCodeZenQuotaAdapter,
  refreshOpenCodeConsoleToken,
  startOpenCodeConsoleDeviceAuthorization,
} from '@openchamber/shared-runtime';

import {
  hasLegacyOpenCodeZenCredential,
  readManagedQuotaCredential,
  writeManagedQuotaCredential,
} from '../credentials/providers.js';

export const providerId = 'opencode';
export const providerName = 'OpenCode Zen';
export const aliases = ['opencode', 'zen', 'opencode-zen'];

// Refresh slightly early so a request never races the access token's expiry.
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_PENDING_DEVICE_FLOWS = 8;
const SLOW_DOWN_INCREMENT_MS = 5_000;

const CREDENTIAL_ERRORS = {
  SIGN_IN_REQUIRED: ['SIGN_IN_REQUIRED', 'Connect OpenCode Zen usage tracking with OpenCode Console sign-in.', 400],
  RECONNECT_REQUIRED: ['RECONNECT_REQUIRED', 'OpenCode Zen usage now uses OpenCode Console sign-in. Reconnect it in Settings → Providers.', 400],
  AUTHENTICATION_FAILED: ['AUTHENTICATION_FAILED', 'OpenCode Console sign-in expired. Reconnect OpenCode Zen usage tracking.', 400],
  WORKSPACE_INACCESSIBLE: ['WORKSPACE_INACCESSIBLE', 'OpenCode Console denied access to this workspace. Reconnect and choose a workspace you can view.', 400],
  WORKSPACE_REQUIRED: ['WORKSPACE_REQUIRED', 'Choose a workspace when approving the OpenCode Console sign-in.', 400],
  FLOW_NOT_FOUND: ['FLOW_NOT_FOUND', 'This sign-in request expired. Start again.', 404],
  PARSE_ERROR: ['PARSE_ERROR', 'OpenCode Console returned an unsupported response.', 502],
  TIMEOUT: ['TIMEOUT', 'OpenCode Console request timed out. Try again.', 504],
  API_ERROR: ['API_ERROR', 'OpenCode Console is temporarily unavailable. Try again.', 502],
};

export class OpenCodeZenCredentialError extends Error {
  constructor(code) {
    const [safeCode, message, status] = CREDENTIAL_ERRORS[code] ?? CREDENTIAL_ERRORS.API_ERROR;
    super(message);
    this.code = safeCode;
    this.status = status;
  }
}

const toCredentialError = (error) => (
  error instanceof OpenCodeZenCredentialError ? error : new OpenCodeZenCredentialError(error?.code)
);

const failureResult = (code, now) => {
  const error = toCredentialError({ code });
  return buildSharedQuotaResult({
    providerId,
    providerName,
    ok: false,
    configured: true,
    error: error.message,
    errorCode: error.code,
    now,
  });
};

export const resolveOpenCodeZenCredential = ({
  readManagedCredential = readManagedQuotaCredential,
  hasLegacyCredential = hasLegacyOpenCodeZenCredential,
} = {}) => {
  const credential = readManagedCredential(providerId);
  if (credential) return { credential, source: 'managed', reconnectRequired: false };
  return { credential: null, source: null, reconnectRequired: Boolean(hasLegacyCredential()) };
};

// A retired dashboard credential stays listed so Usage can ask for a reconnect.
export const isConfigured = (options = {}) => {
  const resolved = resolveOpenCodeZenCredential(options);
  return Boolean(resolved.credential || resolved.reconnectRequired);
};

const toStoredCredential = (token, orgId, now) => ({
  orgId,
  accessToken: token.accessToken,
  refreshToken: token.refreshToken,
  accessTokenExpiresAt: now + Math.floor(token.expiresIn * 1000),
});

let refreshInFlight = null;

// Refresh tokens rotate, so concurrent refreshes of one token share a single request.
export const refreshOpenCodeZenCredential = (credential, {
  readManagedCredential = readManagedQuotaCredential,
  writeManagedCredential = writeManagedQuotaCredential,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) => {
  if (refreshInFlight?.refreshToken === credential.refreshToken) return refreshInFlight.promise;
  const promise = (async () => {
    let result;
    try {
      result = await refreshOpenCodeConsoleToken({ refreshToken: credential.refreshToken, fetchImpl });
    } catch (error) {
      throw toCredentialError(error);
    }
    if (result.status !== 'approved') throw new OpenCodeZenCredentialError('AUTHENTICATION_FAILED');
    const next = toStoredCredential(result.token, credential.orgId, now());
    // A disconnect or reconnect during the refresh wins; never resurrect a replaced credential.
    const current = readManagedCredential(providerId);
    if (current?.refreshToken !== credential.refreshToken) {
      if (current) return current;
      throw new OpenCodeZenCredentialError('SIGN_IN_REQUIRED');
    }
    writeManagedCredential(providerId, next);
    return next;
  })().finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = null;
  });
  refreshInFlight = { refreshToken: credential.refreshToken, promise };
  return promise;
};

export const fetchQuota = async ({
  readManagedCredential = readManagedQuotaCredential,
  writeManagedCredential = writeManagedQuotaCredential,
  hasLegacyCredential = hasLegacyOpenCodeZenCredential,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) => {
  const { credential, reconnectRequired } = resolveOpenCodeZenCredential({ readManagedCredential, hasLegacyCredential });
  if (!credential) {
    if (reconnectRequired) return failureResult('RECONNECT_REQUIRED', now());
    return fetchOpenCodeZenQuotaAdapter({ credential: null, fetchImpl, now });
  }

  const refreshOptions = { readManagedCredential, writeManagedCredential, fetchImpl, now };
  try {
    let active = credential;
    let refreshed = false;
    if (active.accessTokenExpiresAt - ACCESS_TOKEN_REFRESH_SKEW_MS <= now()) {
      active = await refreshOpenCodeZenCredential(active, refreshOptions);
      refreshed = true;
    }
    const result = await fetchOpenCodeZenQuotaAdapter({ credential: active, fetchImpl, now });
    // The console may revoke an access token before its advertised expiry; retry once.
    if (refreshed || result.errorCode !== 'AUTHENTICATION_FAILED') return result;
    active = await refreshOpenCodeZenCredential(active, refreshOptions);
    return fetchOpenCodeZenQuotaAdapter({ credential: active, fetchImpl, now });
  } catch (error) {
    return failureResult(toCredentialError(error).code, now());
  }
};

export const validateStoredOpenCodeZenCredential = async (options = {}) => {
  const result = await fetchQuota(options);
  if (!result.ok) {
    throw new OpenCodeZenCredentialError(result.errorCode === 'NOT_CONFIGURED' ? 'SIGN_IN_REQUIRED' : result.errorCode);
  }
};

export const createOpenCodeZenDeviceFlows = ({
  writeManagedCredential = writeManagedQuotaCredential,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  randomUUID = crypto.randomUUID,
} = {}) => {
  // Device codes stay server-side; the browser only ever sees an opaque flow ID.
  const flows = new Map();

  const prune = (current) => {
    for (const [flowId, flow] of flows) {
      if (flow.expiresAt <= current) flows.delete(flowId);
    }
    while (flows.size >= MAX_PENDING_DEVICE_FLOWS) flows.delete(flows.keys().next().value);
  };

  const start = async () => {
    let authorization;
    try {
      authorization = await startOpenCodeConsoleDeviceAuthorization({ fetchImpl });
    } catch (error) {
      throw toCredentialError(error);
    }
    const current = now();
    prune(current);
    const flowId = randomUUID();
    flows.set(flowId, {
      deviceCode: authorization.deviceCode,
      expiresAt: current + authorization.expiresIn * 1000,
      intervalMs: authorization.interval * 1000,
      nextPollAt: current + authorization.interval * 1000,
      polling: null,
    });
    return {
      flowId,
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      verificationUriComplete: authorization.verificationUriComplete,
      expiresIn: authorization.expiresIn,
      interval: authorization.interval,
    };
  };

  const exchange = async (flowId, flow) => {
    let result;
    try {
      result = await exchangeOpenCodeConsoleDeviceCode({ deviceCode: flow.deviceCode, fetchImpl });
    } catch (error) {
      flow.nextPollAt = now() + flow.intervalMs;
      throw toCredentialError(error);
    }
    if (result.status === 'pending' || result.status === 'slow_down') {
      if (result.status === 'slow_down') flow.intervalMs += SLOW_DOWN_INCREMENT_MS;
      flow.nextPollAt = now() + flow.intervalMs;
      return { status: 'pending' };
    }
    flows.delete(flowId);
    if (result.status !== 'approved') return { status: result.status === 'denied' ? 'denied' : 'expired' };

    const { token } = result;
    if (!token.orgId) throw new OpenCodeZenCredentialError('WORKSPACE_REQUIRED');
    const credential = toStoredCredential(token, token.orgId, now());
    const check = await fetchOpenCodeZenQuotaAdapter({ credential, fetchImpl, now });
    // Only a rejected token or workspace blocks the save; transient usage failures
    // surface through the normal refresh instead of discarding a one-time approval.
    if (check.errorCode === 'AUTHENTICATION_FAILED' || check.errorCode === 'WORKSPACE_INACCESSIBLE') {
      throw new OpenCodeZenCredentialError(check.errorCode);
    }
    writeManagedCredential(providerId, credential);
    return { status: 'approved' };
  };

  const poll = async (flowId) => {
    const flow = typeof flowId === 'string' ? flows.get(flowId) : undefined;
    const current = now();
    if (!flow) throw new OpenCodeZenCredentialError('FLOW_NOT_FOUND');
    if (flow.expiresAt <= current) {
      flows.delete(flowId);
      return { status: 'expired' };
    }
    if (flow.polling) return flow.polling;
    if (current < flow.nextPollAt) return { status: 'pending' };
    flow.polling = exchange(flowId, flow).finally(() => {
      flow.polling = null;
    });
    return flow.polling;
  };

  const cancel = (flowId) => {
    flows.delete(flowId);
  };

  return { start, poll, cancel };
};

export const openCodeZenDeviceFlows = createOpenCodeZenDeviceFlows();
