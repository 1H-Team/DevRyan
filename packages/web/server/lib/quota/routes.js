import {inspectClaudeRequest,isClaudeAccountAbsent,isClaudeInspectionUnavailable,unavailableClaudeInspection,sendClaudeInspectionError} from '../opencode/runtime-host/native-claude-inspection.js';
import express from 'express';

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
import {
  createClaudeProxyBaseUrlResolver,
  createMeridianClaudeContextUsageClient,
} from './providers/claude-meridian.js';
import { isAnthropicProviderId } from '../opencode/anthropic-provider-ids.js';
import { CHATGPT_SIWC_METHOD_ID } from '../opencode/chatgpt-siwc.js';
import { OPENCODE_GENERATION_INVALID } from '../opencode/opencode-generation.js';
import { resolveClaudeCodeLaunch as resolveClaudeCodeLaunchDefault } from '../opencode/claude-cli-runtime.js';
import { createCodexUsageConnection } from './codex-usage-connection.js';
import { codexUsageError } from './codex-usage-rpc.js';
import { isDirectLocalRequest } from '../security/direct-local-request.js';

const jsonParser = express.json({ limit: MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES });
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
// Matches the proxy readiness hold: the native runtime identity is unknown until
// its first readiness probe, so early UI reads wait briefly instead of failing.
const RUNTIME_READINESS_HOLD_MS = 6_000;
const RUNTIME_READINESS_POLL_MS = 75;

// Providers whose credentials live in the native controller (no auth.json there).
const NATIVE_QUOTA_PROVIDER_NAMES = Object.freeze({ codex: 'ChatGPT', xai: 'xAI', 'opencode-go': 'OpenCode Go' });
const NATIVE_GATED_LIST_IDS = new Set(['claude', ...Object.keys(NATIVE_QUOTA_PROVIDER_NAMES)]);
// The runtime is between states; discovery answers 503 so the client retries shortly.
const NATIVE_TRANSIENT_CODES = new Set(['native_runtime_not_ready', 'native_provider_owner_expired', 'native_provider_configuration_changed']);
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
  buildAugmentedPath,
  openchamberDataDir,
  codexUsageConnection: codexUsageConnectionOverride,
  isProviderAdministrator = (req) => req.principal?.scope === 'local-admin' || req.principal?.role === 'admin',
  resolveClaudeCodeLaunch = resolveClaudeCodeLaunchDefault,
  ownsSession,
  claudeContextUsageClient: claudeContextUsageClientOverride,
  credentialRuntime: credentialRuntimeOverrides,
  runtimeReadinessHoldMs = RUNTIME_READINESS_HOLD_MS,
  runtimeReadinessPollMs = RUNTIME_READINESS_POLL_MS,
}) {
  const credentialRuntime = {
    ...defaultCredentialRuntime,
    ...credentialRuntimeOverrides,
  };
  const claudeContextUsageClient = claudeContextUsageClientOverride
    || createMeridianClaudeContextUsageClient();
  const nativeCredentials = createNativeQuotaCredentials({ getNativeRuntimeOwner, isExternalOpenCode });
  const codexUsageConnection = codexUsageConnectionOverride ?? createCodexUsageConnection({
    dataDirectory: openchamberDataDir,
    pathValue: () => typeof buildAugmentedPath === 'function' ? buildAugmentedPath() : process.env.PATH ?? '',
  });

  // This private host profile is usable only from the local administrator UI.
  // Host authentication middleware runs first; explicit CSRF also protects single-user mode.
  const localUsageAccess = (req, res, next) => {
    if (!isDirectLocalRequest(req) || !isProviderAdministrator(req) || isExternalOpenCode()) {
      res.status(403).json({ error: 'This usage connection is available to a local administrator only.', code: 'forbidden' }); return;
    }
    if (req.method !== 'GET' && req.get('x-devryan-csrf') !== '1') {
      res.status(403).json({ error: 'Missing CSRF request header', code: 'forbidden' }); return;
    }
    next();
  };
  const sendConnection = async (res, operation) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await operation()); }
    catch (error) {
      const safe = codexUsageError(error?.code);
      res.status(error?.code === 'CODEX_INVALID_REQUEST' ? 400 : 200).json({
        ...codexUsageConnection.status(), errorCode: safe.code, error: safe.message,
      });
    }
  };
  app.get('/api/quota/codex/connection', localUsageAccess, (_req, res) => sendConnection(res, () => codexUsageConnection.status()));
  app.post('/api/quota/codex/connection/start', localUsageAccess, parseCredentialBody, (req, res) =>
    sendConnection(res, () => codexUsageConnection.start(req.body?.method ?? 'device')));
  app.post('/api/quota/codex/connection/cancel', localUsageAccess, parseCredentialBody, (req, res) =>
    sendConnection(res, () => codexUsageConnection.cancel(typeof req.body?.flowId === 'string' ? req.body.flowId : '')));
  app.delete('/api/quota/codex/connection', localUsageAccess, (_req, res) => sendConnection(res, () => codexUsageConnection.disconnect()));
  const withUsageConnection = (providers) => codexUsageConnection.isConfigured() && !isExternalOpenCode()
    ? [...new Set([...providers, 'codex'])] : providers;

  // Waits out a native runtime that has not published its first configuration snapshot.
  const awaitNativeMode = async () => {
    const deadline = Date.now() + runtimeReadinessHoldMs;
    for (;;) {
      const mode = nativeCredentials.mode();
      if (mode !== 'native-pending' || Date.now() >= deadline) return mode;
      await sleep(Math.min(runtimeReadinessPollMs, Math.max(0, deadline - Date.now())));
    }
  };

  // Claude accounts are global: an unreviewed project directory reads the default location.
  const inspectClaudeUsage = async ({ req, res, kind, directory }) => {
    try {
      return await inspectClaudeRequest({ req, res, kind, directory, getNativeRuntimeOwner, isExternalOpenCode });
    } catch (error) {
      if (!directory || error?.code !== 'native_provider_configuration_location_unreviewed') throw error;
      return inspectClaudeRequest({ req, res, kind, directory: null, getNativeRuntimeOwner, isExternalOpenCode });
    }
  };

  // Native discovery. Returns null when the runtime is still not ready.
  const listNativeQuotaProviders = async ({ req, res, listConfiguredQuotaProviders, workingDirectory }) => {
    let base = [];
    try {
      base = listConfiguredQuotaProviders({
        workingDirectory,
        isExternalRuntime: false,
        claudeProxyBaseUrl: null,
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
    let claudeListed = false;
    try {
      await inspectClaudeUsage({ req, res, kind: 'status', directory: workingDirectory });
      claudeListed = true;
    } catch (error) {
      if (NATIVE_TRANSIENT_CODES.has(error?.code)) return null;
      // An account that exists but cannot be read stays listed so its reason is shown;
      // an authorization refusal or an absent account is not listed.
      claudeListed = isClaudeInspectionUnavailable(error?.code) && !isClaudeAccountAbsent(error?.code);
    }
    // Registry order: claude, codex, xai lead; opencode-go closes the list.
    return [
      ...(claudeListed ? ['claude'] : []),
      ...['codex', 'xai'].filter((id) => configured.has(id)),
      ...base,
      ...(configured.has('opencode-go') ? ['opencode-go'] : []),
    ];
  };

  // Injects the privately held credential into the existing fetchers. Never reads auth.json.
  const fetchNativeQuota = async ({ fetchQuotaForProvider, providerId, options }) => {
    let auth;
    try {
      auth = await nativeCredentials.readAuth(providerId);
    } catch (error) {
      if (error?.code === 'native_runtime_not_ready') {
        return nativeQuotaFailure(providerId, 'native_runtime_not_ready', 'The runtime is still starting. Usage will load shortly.');
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
      const result = await fetchQuotaForProvider(providerId, { ...options, readAuth, writeAuth: () => {} });
      return result?.errorCode === 'REAUTHENTICATION_REQUIRED'
        ? nativeQuotaFailure(providerId, 'native_xai_token_renewal_pending', 'xAI usage updates after your next xAI request.')
        : result;
    }
    let usageRefusalCode = null;
    const baseFetch = options.fetchImpl ?? fetch;
    const fetchImpl = async (...args) => {
      const [url, init] = args;
      const response = await baseFetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
      if (auth?.openai?.methodID === CHATGPT_SIWC_METHOD_ID && response?.status === 401 && typeof response.clone === 'function') {
        try {
          const clone = response.clone();
          const reader = clone.body?.getReader?.();
          if (reader) {
            const chunks = []; let length = 0;
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.length;
                if (length > 4096) break;
                chunks.push(chunk.value);
              }
            } finally { void reader.cancel().catch(() => {}); }
            if (length <= 4096) {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (body?.code === 'no_matching_rule' || body?.detail?.code === 'no_matching_rule' || body?.error?.code === 'no_matching_rule') usageRefusalCode = 'no_matching_rule';
            }
          }
        } catch { /* Unknown auth failures retain the provider's original diagnosis. */ }
      }
      return response;
    };
    const result = await fetchQuotaForProvider(providerId, { ...options, readAuth, fetchImpl });
    const scoped = auth?.openai?.methodID === CHATGPT_SIWC_METHOD_ID
      ? { source: 'chatgpt-siwc', connectionId: auth?.openai?.connectionId ?? null, account: auth?.openai?.account ?? null }
      : {};
    return { ...(!result?.ok && result?.configured && usageRefusalCode === 'no_matching_rule'
      ? nativeQuotaFailure(providerId, 'siwc_usage_unavailable', 'This Sign in with ChatGPT connection cannot read usage. Connect a separate usage account.')
      : result), ...scoped };
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

  // Shared with the managed-orchestration provider reset probe. A zero TTL keeps
  // this route uncached exactly as before; overlapping requests share one lookup.
  const claudeProxyBaseUrls = createClaudeProxyBaseUrlResolver({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    isExternalOpenCode,
    openCodeClient,
    ttlMs: 0,
  });
  // Only an unknown runtime identity is retried, within a bounded hold; any
  // other failure, or one that outlasts the hold, still reaches the caller.
  const resolveClaudeProxyBaseUrl = async (workingDirectory) => {
    const deadline = Date.now() + runtimeReadinessHoldMs;
    for (;;) {
      try {
        return await claudeProxyBaseUrls.resolve(workingDirectory);
      } catch (error) {
        if (error?.code !== OPENCODE_GENERATION_INVALID || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(runtimeReadinessPollMs, Math.max(0, deadline - Date.now()))));
      }
    }
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
        res.json({ providers: withUsageConnection(providers) });
        return;
      }
      const claudeProxyBaseUrl = await resolveClaudeProxyBaseUrl(workingDirectory);
      res.json({
        providers: withUsageConnection(listConfiguredQuotaProviders({
          workingDirectory,
          isExternalRuntime: isExternalOpenCode(),
          claudeProxyBaseUrl,
        })),
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
      const workingDirectory = await resolveQuotaDirectory(req);
      const baseUrl = await resolveClaudeProxyBaseUrl(workingDirectory);
      if (!baseUrl) {
        res.json(unavailableContextUsage(sessionID));
        return;
      }
      const result = await claudeContextUsageClient.fetchContextUsage({
        baseUrl,
        sessionID,
        refreshSession: req.query.refreshSession === 'true',
      });
      res.json(result.ok ? result.usage : unavailableContextUsage(sessionID));
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
      if(isAnthropicProviderId(providerId)){
        try{
          const directory=await resolveQuotaDirectory(req);
          return res.json(await inspectClaudeUsage({req,res,kind:'quota',directory}));
        }catch(error){
          if(isClaudeInspectionUnavailable(error?.code))return res.json(unavailableClaudeInspection('quota',error.code));
          return sendClaudeInspectionError(res,error);
        }
      }
      const { fetchQuotaForProvider, resolveProviderId } = await getQuotaProviders();
      const forceRefresh = req.query.refresh === 'true';
      const workingDirectory = await resolveQuotaDirectory(req);
      const nativeProviderId = resolveProviderId?.(providerId);
      if (nativeProviderId === 'codex' && codexUsageConnection.isConfigured() && !isExternalOpenCode()) {
        let allowed = false;
        localUsageAccess(req, res, () => { allowed = true; });
        if (!allowed) return;
        // Source precedence is explicit: disconnecting this account restores the model account source.
        return res.json(await codexUsageConnection.fetchQuota());
      }
      if (Object.hasOwn(NATIVE_QUOTA_PROVIDER_NAMES, nativeProviderId ?? '') && nativeCredentials.mode() !== 'legacy') {
        if (nativeCredentials.mode() === 'native-pending') {
          return res.json(nativeQuotaFailure(nativeProviderId, 'native_runtime_not_ready', 'The runtime is still starting. Usage will load shortly.'));
        }
        return res.json(await fetchNativeQuota({
          fetchQuotaForProvider,
          providerId: nativeProviderId,
          options: { forceRefresh, workingDirectory, isExternalRuntime: false, claudeProxyBaseUrl: null },
        }));
      }
      const claudeProxyBaseUrl = isAnthropicProviderId(providerId)
        ? await resolveClaudeProxyBaseUrl(workingDirectory)
        : null;
      const externalRuntime = isExternalOpenCode();
      const claudeCodeLaunch = isAnthropicProviderId(providerId) && !externalRuntime
        ? resolveClaudeCodeLaunch({
            pathValue: typeof buildAugmentedPath === 'function'
              ? buildAugmentedPath()
              : process.env.PATH || '',
          })
        : null;
      res.json(await fetchQuotaForProvider(providerId, {
        forceRefresh,
        workingDirectory,
        isExternalRuntime: externalRuntime,
        claudeProxyBaseUrl,
        ...(isAnthropicProviderId(providerId) ? { claudeCodeLaunch } : {}),
      }));
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });
  return { close: () => codexUsageConnection.close() };
}
