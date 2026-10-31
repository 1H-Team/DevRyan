import express from 'express';
import { resolveClaudeExecutable } from '../opencode/runtime-host/claude-agent-host.js';
import { fetchQuota as fetchClaudeAgentQuota } from './providers/claude-agent.js';

import { createNativeQuotaCredentials } from './native-credentials.js';
import { buildResult } from './utils/formatters.js';

import { importCursorManagedCredential } from './credentials/cursor-import.js';
import {
  assertManagedQuotaCredential,
  deleteManagedQuotaCredential,
  getManagedQuotaCredentialStatus,
  readManagedQuotaCredential,
  writeManagedQuotaCredential,
} from './credentials/providers.js';
import {
  MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES,
  QuotaCredentialError,
  canonicalizeManagedQuotaProviderId,
} from './credentials/store.js';
import {
  fetchOllamaCloudUsage,
  resolveOllamaCloudCredential,
} from './providers/ollama-cloud.js';
import {
  resolveCursorQuotaCredential,
  validateCursorQuotaCredential,
} from './providers/cursor-acp.js';
import {
  openCodeZenDeviceFlows,
  resolveOpenCodeZenCredential,
  validateStoredOpenCodeZenCredential,
  OpenCodeZenCredentialError,
} from './providers/opencode.js';
import { isAnthropicProviderId } from '../opencode/anthropic-provider-ids.js';

const jsonParser = express.json({ limit: MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES });
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
// Matches the proxy readiness hold: the native runtime identity is unknown until
// its first readiness probe, so early UI reads wait briefly instead of failing.
const RUNTIME_READINESS_HOLD_MS = 6_000;
const RUNTIME_READINESS_POLL_MS = 75;

// Providers whose credentials live in the native controller (no auth.json there).
const NATIVE_QUOTA_PROVIDER_NAMES = Object.freeze({ codex: 'ChatGPT', xai: 'xAI', 'opencode-go': 'OpenCode Go' });
const NATIVE_GATED_LIST_IDS = new Set(['claude-agent', ...Object.keys(NATIVE_QUOTA_PROVIDER_NAMES)]);
// The runtime is between states; discovery answers 503 so the client retries shortly.
const NATIVE_TRANSIENT_CODES = new Set(['native_runtime_not_ready', 'native_provider_owner_expired', 'native_provider_configuration_changed']);
const NATIVE_QUOTA_TRANSIENT_CODES = new Set([
  ...NATIVE_TRANSIENT_CODES, 'native_integration_acquisition_expired', 'native_integration_owner_unavailable',
  'native_integration_grant_expired', 'native_controller_unavailable',
]);
const NATIVE_QUOTA_DIAGNOSTIC_CODES = new Set([
  ...NATIVE_QUOTA_TRANSIENT_CODES, 'native_credential_invalid', 'native_credential_changed', 'native_credential_update_required',
  'native_integration_binding_invalid', 'native_integration_scope_invalid',
  'native_web_principal_required', 'native_web_principal_denied', 'native_session_access_revoked',
  'native_session_directory_mismatch', 'native_xai_reauthentication_required', 'native_xai_usage_unavailable',
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nativeQuotaFailure = (providerId, errorCode, error) => buildResult({
  providerId,
  providerName: NATIVE_QUOTA_PROVIDER_NAMES[providerId] ?? providerId,
  ok: false,
  configured: true,
  errorCode,
  error,
});

const unavailableContextUsage = (sessionID) => ({
  sessionID,
  status: 'unavailable',
  source: 'message-fallback',
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  activeInputTokens: 0,
  lastOutputTokens: 0,
  fetchedAt: Date.now(),
});

const sendCredentialError = (res, code, status) => res.status(status).json({
  code,
  error: {
    UNSUPPORTED_PROVIDER: 'Unsupported credential provider',
    INVALID_CREDENTIAL: 'Credential validation failed',
    NOT_CONFIGURED: 'Managed credential is not configured',
    IMPORT_UNAVAILABLE: 'Credential import is unavailable',
    PAYLOAD_TOO_LARGE: 'Credential payload is too large',
  }[code],
});

const parseCredentialBody = (req, res, next) => {
  const declaredLength = Number.parseInt(req.get('content-length') ?? '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
    sendCredentialError(res, 'PAYLOAD_TOO_LARGE', 413);
    return;
  }

  if (req.body !== undefined) {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
        sendCredentialError(res, 'PAYLOAD_TOO_LARGE', 413);
        return;
      }
      next();
    } catch {
      sendCredentialError(res, 'INVALID_CREDENTIAL', 400);
    }
    return;
  }

  jsonParser(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error.type === 'entity.too.large' || error.status === 413) {
      sendCredentialError(res, 'PAYLOAD_TOO_LARGE', 413);
      return;
    }
    sendCredentialError(res, 'INVALID_CREDENTIAL', 400);
  });
};

const defaultCredentialRuntime = {
  assertCredential: assertManagedQuotaCredential,
  deleteCredential: deleteManagedQuotaCredential,
  getStatus: getManagedQuotaCredentialStatus,
  importCursorCredential: importCursorManagedCredential,
  readCredential: readManagedQuotaCredential,
  writeCredential: writeManagedQuotaCredential,
  // OpenCode Zen credentials come only from device sign-in, so validation always
  // targets the stored credential (refreshing its token when needed).
  validate: async (providerId, credential) => {
    if (providerId === 'opencode') {
      await validateStoredOpenCodeZenCredential();
      return credential;
    }
    if (providerId === 'ollama-cloud') {
      await fetchOllamaCloudUsage(credential);
      return credential;
    }
    return validateCursorQuotaCredential(credential);
  },
  deviceFlows: openCodeZenDeviceFlows,
  getEffectiveSource: (providerId) => {
    if (providerId === 'opencode') return resolveOpenCodeZenCredential().source;
    if (providerId === 'ollama-cloud') return resolveOllamaCloudCredential().source;
    return resolveCursorQuotaCredential().source;
  },
};

const resolveCredentialProvider = (req, res) => {
  try {
    return canonicalizeManagedQuotaProviderId(req.params.providerId);
  } catch {
    sendCredentialError(res, 'UNSUPPORTED_PROVIDER', 404);
    return null;
  }
};

const sendOpenCodeZenError = (res, error) => {
  const safe = error instanceof OpenCodeZenCredentialError ? error : new OpenCodeZenCredentialError('API_ERROR');
  res.status(safe.status).json({ code: safe.code, error: safe.message });
};

const credentialStatus = (providerId, runtime) => ({
  ...runtime.getStatus(providerId),
  effectiveSource: runtime.getEffectiveSource(providerId) ?? null,
});

export function registerQuotaRoutes(app, {
  getQuotaProviders,
  resolveProjectDirectory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  isExternalOpenCode = () => false,
  openCodeClient = null,
  getNativeRuntimeOwner = () => null,
  devryanDataDir,
  ownsSession,
  credentialRuntime: credentialRuntimeOverrides,
  runtimeReadinessHoldMs = RUNTIME_READINESS_HOLD_MS,
  runtimeReadinessPollMs = RUNTIME_READINESS_POLL_MS,
  recordDiagnostic = () => {},
}) {
  const credentialRuntime = {
    ...defaultCredentialRuntime,
    ...credentialRuntimeOverrides,
  };
  const nativeCredentials = createNativeQuotaCredentials({ getNativeRuntimeOwner, isExternalOpenCode });
  const recordNativeQuotaFailure = (providerId, stage, error) => {
    const code = NATIVE_QUOTA_DIAGNOSTIC_CODES.has(error?.code) ? error.code : 'native_credential_unreadable';
    try {
      void Promise.resolve(recordDiagnostic({ type: 'lifecycle', event: 'native_quota_read_failed', payload: { providerId, stage, code } })).catch(() => {});
    } catch { /* Diagnostic failure must not change the usage response. */ }
    return code;
  };

  // Waits out a native runtime that has not published its first configuration snapshot.
  const awaitNativeMode = async () => {
    const deadline = Date.now() + runtimeReadinessHoldMs;
    for (;;) {
      const mode = nativeCredentials.mode();
      if (mode !== 'native-pending' || Date.now() >= deadline) return mode;
      await sleep(Math.min(runtimeReadinessPollMs, Math.max(0, deadline - Date.now())));
    }
  };

  // Native discovery. Returns null when the runtime is still not ready.
  const listNativeQuotaProviders = async ({ req, res, listConfiguredQuotaProviders, workingDirectory }) => {
    let base = [];
    try {
      base = listConfiguredQuotaProviders({
        workingDirectory,
        isExternalRuntime: false,
      }).filter((id) => !NATIVE_GATED_LIST_IDS.has(id));
    } catch (error) {
      console.error('Failed to list quota providers:', error);
    }
    let configured = new Set();
    try {
      configured = await nativeCredentials.listConfigured();
    } catch {
      // A failed credential lookup leaves those providers out; it never fails the list.
    }
    // Claude Code's own usage: listed once it has reported a window or is installed.
    const owner = getNativeRuntimeOwner();
    const claudeAgentListed = typeof owner?.readClaudeAgentUsage === 'function'
      && Boolean(owner.readClaudeAgentUsage() || resolveClaudeExecutable());
    // Registry order: Claude, codex, xai lead; opencode-go closes the list.
    return [
      ...(claudeAgentListed ? ['claude-agent'] : []),
      ...['codex', 'xai'].filter((id) => configured.has(id)),
      ...base,
      ...(configured.has('opencode-go') ? ['opencode-go'] : []),
    ];
  };

  // Injects the privately held credential into the existing fetchers. Never reads auth.json.
  const fetchNativeQuota = async ({ fetchQuotaForProvider, providerId, options }) => {
    let auth;
    try {
      try {
        auth = await nativeCredentials.readAuth(providerId);
      } catch (error) {
        if (!NATIVE_QUOTA_TRANSIENT_CODES.has(error?.code)) throw error;
        recordNativeQuotaFailure(providerId, 'selected_credential', error);
        // A configuration reacquisition can overlap a usage poll. Retry once
        // against the current owner; account changes and refusals never retry.
        await sleep(runtimeReadinessPollMs);
        auth = await nativeCredentials.readAuth(providerId);
      }
    } catch (error) {
      const code = recordNativeQuotaFailure(providerId, 'selected_credential', error);
      if (NATIVE_QUOTA_TRANSIENT_CODES.has(code)) {
        return nativeQuotaFailure(providerId, 'native_runtime_not_ready', 'The runtime is still starting. Usage will load shortly.');
      }
      if (code === 'native_credential_update_required') {
        return nativeQuotaFailure(providerId, code, 'Restart DevRyan with the latest app version to load usage.');
      }
      if (code === 'native_credential_changed') {
        return nativeQuotaFailure(providerId, code, 'The selected account changed. Refresh usage again.');
      }
      return { ...nativeQuotaFailure(providerId, 'native_credential_unreadable', 'Usage could not be read from the selected account.'),
        ...(providerId === 'codex' ? { source: null, connectionId: null, account: null } : {}) };
    }
    const readAuth = () => auth ?? {};
    if (providerId === 'opencode-go') {
      // No-op cleanup hooks keep the legacy auth-file mutation from running natively.
      return fetchQuotaForProvider(providerId, { ...options, readAuth, mutateAuth: () => {}, deleteManagedCredential: () => {} });
    }
    if (providerId === 'xai') {
      let result = await fetchQuotaForProvider(providerId, { ...options, readAuth, writeAuth: () => {} });
      if (result?.errorCode !== 'REAUTHENTICATION_REQUIRED') return result;
      try {
        auth = await nativeCredentials.refreshXai(auth);
      } catch (error) {
        const code = recordNativeQuotaFailure(providerId, 'refresh', error);
        if (code === 'native_credential_update_required') {
          return nativeQuotaFailure(providerId, code, 'Restart DevRyan with the latest app version to load usage.');
        }
        return code === 'native_xai_reauthentication_required'
          ? nativeQuotaFailure(providerId, 'REAUTHENTICATION_REQUIRED', 'Reconnect xAI to load usage.')
          : nativeQuotaFailure(providerId, 'native_xai_usage_unavailable', 'xAI usage is temporarily unavailable. Try refreshing again.');
      }
      result = await fetchQuotaForProvider(providerId, { ...options, readAuth, writeAuth: () => {} });
      return result?.errorCode === 'REAUTHENTICATION_REQUIRED'
        ? nativeQuotaFailure(providerId, 'REAUTHENTICATION_REQUIRED', 'Reconnect xAI to load usage.') : result;
    }
    if (auth?.openai?.type === 'oauth' && auth.openai.methodID !== 'chatgpt-browser') return {
      ...nativeQuotaFailure(providerId, 'siwc_usage_unavailable', 'Sign in again with Codex browser (legacy) to read ChatGPT plan usage.'),
      source: auth.openai.methodID, connectionId: auth.openai.connectionId ?? null, account: null,
    };
    const result = await fetchQuotaForProvider(providerId, { ...options, readAuth });
    const codexResult = providerId === 'codex' && result?.errorCode === 'REAUTHENTICATION_REQUIRED'
      ? nativeQuotaFailure(providerId, 'native_openai_token_renewal_pending', 'ChatGPT usage updates after your next OpenAI request.') : result;
    return providerId === 'codex' ? { ...codexResult, source: auth?.openai?.methodID ?? null,
      connectionId: auth?.openai?.connectionId ?? null, account: null } : result;
  };

  const resolveQuotaDirectory = async (req) => {
    const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requestedDirectory = headerDirectory || queryDirectory || null;

    if (!requestedDirectory) return null;
    if (typeof resolveProjectDirectory !== 'function') return requestedDirectory;

    const resolved = await resolveProjectDirectory(req);
    if (!resolved.directory) {
      const error = new Error(resolved.error || 'Invalid working directory');
      error.statusCode = 400;
      throw error;
    }
    return resolved.directory;
  };

  app.get('/api/quota/providers', async (req, res) => {
    try {
      const { listConfiguredQuotaProviders } = await getQuotaProviders();
      const workingDirectory = await resolveQuotaDirectory(req);
      if (nativeCredentials.mode() !== 'legacy') {
        const providers = await awaitNativeMode() === 'native-ready'
          ? await listNativeQuotaProviders({ req, res, listConfiguredQuotaProviders, workingDirectory })
          : null;
        if (!providers) {
          res.status(503).json({ error: 'native_runtime_not_ready', code: 'native_runtime_not_ready' });
          return;
        }
        res.json({ providers });
        return;
      }
      res.json({
        providers: listConfiguredQuotaProviders({
          workingDirectory,
          isExternalRuntime: isExternalOpenCode(),
        }),
      });
    } catch (error) {
      console.error('Failed to list quota providers:', error);
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to list quota providers' });
    }
  });

  app.get('/api/session/:sessionID/context-usage', async (req, res) => {
    const sessionID = String(req.params.sessionID || '').trim();
    if (!SESSION_ID_PATTERN.test(sessionID)) {
      res.status(400).json({ error: 'Session ID is invalid' });
      return;
    }
    try {
      if (
        req.principal?.scope === 'managed'
        && (typeof ownsSession !== 'function' || !await ownsSession(req.principal, sessionID))
      ) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      // No provider reports live context usage; the client derives it from messages.
      res.json(unavailableContextUsage(sessionID));
    } catch (error) {
      if (error?.statusCode) {
        res.status(error.statusCode).json({ error: error.message || 'Failed to resolve context usage' });
        return;
      }
      res.json(unavailableContextUsage(sessionID));
    }
  });

  app.get('/api/quota/credentials/:providerId', (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (providerId) res.json(credentialStatus(providerId, credentialRuntime));
  });

  app.put('/api/quota/credentials/:providerId', parseCredentialBody, async (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (!providerId) return;
    if (providerId === 'opencode') {
      sendOpenCodeZenError(res, new OpenCodeZenCredentialError('SIGN_IN_REQUIRED'));
      return;
    }
    try {
      const { credential } = credentialRuntime.assertCredential(providerId, req.body);
      const validatedCredential = await credentialRuntime.validate(providerId, credential);
      credentialRuntime.writeCredential(providerId, validatedCredential ?? credential);
      res.json(credentialStatus(providerId, credentialRuntime));
    } catch (error) {
      if (error instanceof OpenCodeZenCredentialError) {
        res.status(error.status).json({ code: error.code, error: error.message });
        return;
      }
      if (error instanceof QuotaCredentialError && error.code === 'UNSUPPORTED_PROVIDER') {
        sendCredentialError(res, 'UNSUPPORTED_PROVIDER', 404);
        return;
      }
      sendCredentialError(res, 'INVALID_CREDENTIAL', 400);
    }
  });

  app.post('/api/quota/credentials/:providerId/validate', parseCredentialBody, async (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (!providerId) return;
    try {
      const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
      if (providerId === 'opencode' && hasBody) {
        sendOpenCodeZenError(res, new OpenCodeZenCredentialError('SIGN_IN_REQUIRED'));
        return;
      }
      const credential = hasBody
        ? credentialRuntime.assertCredential(providerId, req.body).credential
        : credentialRuntime.readCredential(providerId);
      if (!credential) {
        sendCredentialError(res, 'NOT_CONFIGURED', 404);
        return;
      }
      await credentialRuntime.validate(providerId, credential);
      res.json({ valid: true });
    } catch (error) {
      if (error instanceof OpenCodeZenCredentialError) {
        res.status(error.status).json({ code: error.code, error: error.message });
        return;
      }
      sendCredentialError(res, 'INVALID_CREDENTIAL', 400);
    }
  });

  app.post('/api/quota/credentials/opencode/device/start', async (_req, res) => {
    try {
      res.json(await credentialRuntime.deviceFlows.start());
    } catch (error) {
      sendOpenCodeZenError(res, error);
    }
  });

  app.post('/api/quota/credentials/opencode/device/poll', parseCredentialBody, async (req, res) => {
    const flowId = typeof req.body?.flowId === 'string' ? req.body.flowId : '';
    try {
      const result = await credentialRuntime.deviceFlows.poll(flowId);
      res.json(result.status === 'approved'
        ? { status: 'approved', credential: credentialStatus('opencode', credentialRuntime) }
        : result);
    } catch (error) {
      sendOpenCodeZenError(res, error);
    }
  });

  app.post('/api/quota/credentials/opencode/device/cancel', parseCredentialBody, (req, res) => {
    if (typeof req.body?.flowId === 'string') credentialRuntime.deviceFlows.cancel(req.body.flowId);
    res.json({ status: 'cancelled' });
  });

  app.post('/api/quota/credentials/:providerId/import', parseCredentialBody, async (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (!providerId) return;
    if (providerId !== 'cursor-acp') {
      sendCredentialError(res, 'IMPORT_UNAVAILABLE', 404);
      return;
    }
    try {
      const imported = credentialRuntime.importCursorCredential();
      const validated = await credentialRuntime.validate(providerId, imported);
      credentialRuntime.writeCredential(providerId, validated ?? imported);
      res.json(credentialStatus(providerId, credentialRuntime));
    } catch {
      sendCredentialError(res, 'IMPORT_UNAVAILABLE', 400);
    }
  });

  app.delete('/api/quota/credentials/:providerId', (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (!providerId) return;
    credentialRuntime.deleteCredential(providerId);
    res.json(credentialStatus(providerId, credentialRuntime));
  });

  app.get('/api/quota/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) return res.status(400).json({ error: 'Provider ID is required' });
      // Claude, under any earlier provider alias, is Claude Code's own reported usage.
      if (providerId === 'claude-agent' || isAnthropicProviderId(providerId)) {
        const owner = nativeCredentials.mode() === 'legacy' ? null : getNativeRuntimeOwner();
        return res.json(await fetchClaudeAgentQuota({ readUsage: () => owner?.readClaudeAgentUsage?.(), available: Boolean(resolveClaudeExecutable()) }));
      }
      const { fetchQuotaForProvider, resolveProviderId } = await getQuotaProviders();
      const forceRefresh = req.query.refresh === 'true';
      const workingDirectory = await resolveQuotaDirectory(req);
      const nativeProviderId = resolveProviderId?.(providerId);
      if (Object.hasOwn(NATIVE_QUOTA_PROVIDER_NAMES, nativeProviderId ?? '') && nativeCredentials.mode() !== 'legacy') {
        if (nativeCredentials.mode() === 'native-pending') {
          return res.json(nativeQuotaFailure(nativeProviderId, 'native_runtime_not_ready', 'The runtime is still starting. Usage will load shortly.'));
        }
        return res.json(await fetchNativeQuota({
          fetchQuotaForProvider,
          providerId: nativeProviderId,
          options: { forceRefresh, workingDirectory, isExternalRuntime: false },
        }));
      }
      res.json(await fetchQuotaForProvider(providerId, {
        forceRefresh,
        workingDirectory,
        isExternalRuntime: isExternalOpenCode(),
      }));
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });
}
