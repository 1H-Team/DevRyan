import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AUTH_FILE, readProviderAuthRecord } from './auth.js';
import {
  isLegacyCodexChatgptMethodId,
  isSiwcAuthRecord,
  refreshSiwcAccessToken,
  siwcClientIdFromAuth,
  verifySiwcIdToken,
  parseScopeList,
  hasSiwcPlanUsage,
} from './chatgpt-siwc.js';

export const OPENAI_OAUTH_AUTHENTICATION = 'bot_opencode_provider_authentication';
const orderedJson = (value) => {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, orderedJson(value[key])]));
};
const fingerprint = (record) => crypto.createHash('sha256').update(JSON.stringify(orderedJson(record ?? null))).digest('hex');

export class OpenAiOAuthError extends Error {
  constructor(code, statusCode = 503) {
    super(code === OPENAI_OAUTH_AUTHENTICATION
      ? 'Reconnect the selected host OpenAI account, then reconnect it in Bot Settings.'
      : 'The managed OpenAI authentication service is unavailable.');
    this.name = 'OpenAiOAuthError';
    this.code = code;
    this.statusCode = statusCode;
    this.diagnostics = { providerErrorType: code === OPENAI_OAUTH_AUTHENTICATION ? 'ProviderAuthError' : 'UnknownError',
      statusCode, retryable: false, providerReference: null };
  }
}

export function openAiAccountId(record) {
  const direct = record?.accountId
    ?? (typeof record?.metadata?.accountID === 'string' ? record.metadata.accountID : null)
    ?? (typeof record?.metadata?.subject === 'string' ? record.metadata.subject : null);
  if (record?.methodID === 'chatgpt-siwc' && typeof direct === 'string' && direct && Buffer.byteLength(direct) <= 512 && !/[\x00-\x1f\x7f]/.test(direct)) return direct;
  if (typeof direct === 'string' && /^[A-Za-z0-9_.:@-]{1,256}$/.test(direct)) return direct;
  try {
    const claims = JSON.parse(Buffer.from(record.access.split('.')[1], 'base64url').toString('utf8'));
    const value = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
  } catch { return null; }
}

export function requireSiwcAuth(auth) {
  if (auth?.type !== 'oauth') return false;
  if (isLegacyCodexChatgptMethodId(auth.methodID) || !isSiwcAuthRecord(auth)) return false;
  return Boolean(openAiAccountId(auth));
}

// Synchronous compare/read/merge/rename contains no await boundary. All managed
// refresh writers use this owner; externally owned OpenCode is never opted in.
export function compareAndSwapOpenAiAuth(expected, next, { authFile = AUTH_FILE } = {}) {
  const all = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  if (fingerprint(all.openai) !== fingerprint(expected)) return false;
  const temporary = `${authFile}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ ...all, openai: next }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, authFile);
    return true;
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function createOpenAiOAuthCoordinator({
  readAuth = () => readProviderAuthRecord('openai'),
  compareAndSwap = compareAndSwapOpenAiAuth,
  fetchImpl = fetch,
  now = Date.now,
  jwksImpl,
  recordDiagnostic = () => {},
  stateFile = null,
  asyncStorage = /** @type {import('./runtime-host/native-openai-auth.js').NativeOpenAiAsyncStorage | null} */ (null),
  withMutationQueue = /** @type {import('./runtime-host/native-openai-auth.js').NativeOpenAiMutationQueue | null} */ (null),
} = {}) {
  let state = { fingerprint: null, generation: null, blocked: false };
  let persistenceFailure = false;
  let unreadableState = false;
  const blockedRefreshFingerprints = new Set();
  let blockedRefreshOverflow = false;
  if (stateFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!/^[a-f0-9]{64}$/.test(saved.fingerprint) || !/^[a-f0-9-]{36}$/.test(saved.generation)
        || typeof saved.blocked !== 'boolean') throw new Error('invalid OAuth state');
      if (saved.blockedRefreshFingerprints !== undefined) {
        if (!Array.isArray(saved.blockedRefreshFingerprints) || saved.blockedRefreshFingerprints.length > 128
          || saved.blockedRefreshFingerprints.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))) throw new Error('invalid OAuth state');
        for (const key of saved.blockedRefreshFingerprints) blockedRefreshFingerprints.add(key);
      }
      if (saved.refreshFingerprint !== undefined) {
        if (typeof saved.refreshFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(saved.refreshFingerprint)) throw new Error('invalid OAuth state');
        if (saved.refreshing === true) blockedRefreshFingerprints.add(saved.refreshFingerprint);
      }
      if (saved.blockedRefreshOverflow === true) unreadableState = true;
      // A crash during rotation may have consumed the token without saving it.
      state = { fingerprint: saved.fingerprint, generation: saved.generation,
        blocked: saved.blocked || saved.refreshing === true, refreshing: false };
    } catch (error) {
      if (error.code !== 'ENOENT') unreadableState = true;
    }
  }
  let ready = false;
  let inFlight = null;
  let mutationQueue = Promise.resolve();
  const withAuthMutation = (work) => {
    if (withMutationQueue) return withMutationQueue(work);
    const pending = mutationQueue.then(work);
    mutationQueue = pending.catch(() => {});
    return pending;
  };
  const persist = () => {
    if (!stateFile) return;
    const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ ...state,
        ...(blockedRefreshFingerprints.size ? { blockedRefreshFingerprints: [...blockedRefreshFingerprints] } : {}),
        ...(blockedRefreshOverflow ? { blockedRefreshOverflow: true } : {}),
      }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, stateFile);
    } catch {
      persistenceFailure = true;
      throw new OpenAiOAuthError('bot_oauth_persistence_failed');
    } finally { try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original failure */ } }
  };
  // A native-agent instance never falls back to the legacy auth file when its
  // controller stops. Legacy/bot instances retain their default storage.
  const activeStorage = () => asyncStorage;
  const tokenFingerprint = auth => typeof auth?.refresh === 'string' && auth.refresh ? fingerprint(auth.refresh) : null;
  const blockRefresh = auth => {
    const key = tokenFingerprint(auth);
    if (!key) return;
    if (!blockedRefreshFingerprints.has(key) && blockedRefreshFingerprints.size >= 128) {
      blockedRefreshOverflow = true; unreadableState = true;
    } else blockedRefreshFingerprints.add(key);
    if (fingerprint(auth) === state.fingerprint) state.blocked = true;
    persist();
  };
  const acceptRead = (auth, native = false) => {
    const key = fingerprint(auth), refreshKey = tokenFingerprint(auth);
    // Older crash state had only the whole-record fingerprint. Conservatively
    // retain its ambiguity on first native adoption; a proved new token clears
    // the current block, while its old token hash remains unusable across aliases.
    if (native && state.blocked && !blockedRefreshFingerprints.size && refreshKey) blockRefresh(auth);
    const blocked = native && refreshKey && blockedRefreshFingerprints.has(refreshKey);
    if (key !== state.fingerprint) {
      state = { fingerprint: key, generation: crypto.randomUUID(), blocked: Boolean(blocked) };
      persistenceFailure = false;
      persist();
    } else if (blocked && !state.blocked) { state.blocked = true; persist(); }
    return auth;
  };
  const read = () => {
    if (unreadableState) throw new OpenAiOAuthError('bot_oauth_persistence_failed');
    if (asyncStorage) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
    const auth = readAuth();
    if (auth && typeof auth.then === 'function') throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
    return acceptRead(auth);
  };
  const readAsync = async storage => {
    if (unreadableState) throw new OpenAiOAuthError('bot_oauth_persistence_failed');
    if (storage?.isActive && !storage.isActive()) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
    const auth = storage ? await storage.readAuth() : readAuth();
    if (auth && typeof auth.then === 'function' || storage !== activeStorage()
      || (storage?.isActive && !storage.isActive())) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
    return acceptRead(auth, Boolean(storage));
  };
  const current = storage => {
    if (!ready || storage !== activeStorage() || (storage?.isActive && !storage.isActive())) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
  };
  const diagnostic = (stage, outcome, statusCode = null, credentialId = null, reason = null) => {
    try {
      recordDiagnostic({ type: 'lifecycle', event: 'provider.oauth.refresh', payload: {
        provider: 'openai', credentialId, generation: state.generation, stage, outcome, statusCode,
        ...(reason ? { reason } : {}),
      } });
    } catch { /* diagnostics must not replace the provider failure */ }
  };
  const requireAccount = (auth, expectedAccountId, expectedRegistrationKey) => {
    if (persistenceFailure) throw new OpenAiOAuthError('bot_oauth_persistence_failed');
    const accountId = openAiAccountId(auth);
    if (!requireSiwcAuth(auth) || !accountId || (expectedAccountId && expectedAccountId !== accountId)
      || expectedRegistrationKey && expectedRegistrationKey !== fingerprint([siwcClientIdFromAuth(auth), auth.metadata?.subject ?? accountId]) || state.blocked) {
      throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
    }
    return accountId;
  };
  const refresh = async (auth, credentialId, storage) => {
    const original = state.fingerprint;
    await readAsync(storage);
    if (fingerprint(auth) !== state.fingerprint) return;
    current(storage);
    diagnostic('refresh', 'started', null, credentialId);
    const clientId = siwcClientIdFromAuth(auth);
    if (!clientId) {
      state.blocked = true;
      if (storage) blockRefresh(auth);
      persist();
      diagnostic('refresh', 'reauth_required', 401, credentialId, 'legacy_codex_oauth');
      throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
    }
    let response;
    try {
      state.refreshing = true;
      if (storage) state.refreshFingerprint = tokenFingerprint(auth);
      persist();
      const exchanged = await refreshSiwcAccessToken({
        clientId,
        refreshToken: auth.refresh,
        fetchImpl,
      });
      response = exchanged.response;
      // A login/disconnect that won while refresh was in flight is authoritative.
      await readAsync(storage);
      if (state.fingerprint !== original) {
        if (storage && response.ok) blockRefresh(auth);
        if (!exchanged.tokens) await response.body?.cancel().catch(() => {});
        return;
      }
      current(storage);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        state.refreshing = false;
        if ([400, 401, 403].includes(response.status)) {
          state.blocked = true;
          if (storage) blockRefresh(auth);
          persist();
          diagnostic('refresh', 'reauth_required', response.status, credentialId);
          throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
        }
        persist();
        throw new OpenAiOAuthError('bot_oauth_refresh_unavailable');
      }
      const tokens = exchanged.tokens;
      if (!tokens) {
        state.refreshing = false;
        state.blocked = true;
        if (storage) blockRefresh(auth);
        persist();
        throw new OpenAiOAuthError(exchanged.invalid ? 'bot_oauth_response_invalid' : 'bot_oauth_response_invalid');
      }
      const expires = now() + tokens.expires_in * 1000;
      if (!Number.isSafeInteger(expires)) throw new OpenAiOAuthError('bot_oauth_response_invalid');
      if (tokens.id_token) {
        const identity = await verifySiwcIdToken(tokens.id_token, { audience: clientId, ...(jwksImpl ? { jwksImpl } : {}) });
        if (identity.sub !== auth.metadata?.subject) throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
      }
      const grantedScopes = tokens.scope === undefined ? parseScopeList(auth.scopes ?? auth.metadata?.scopes) : parseScopeList(tokens.scope);
      const next = {
        ...auth,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires,
        clientId,
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
        scopes: grantedScopes,
      };
      if (auth.metadata && typeof auth.metadata === 'object') {
        next.metadata = {
          ...auth.metadata,
          clientId,
          ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
          scopes: grantedScopes,
          planUsage: hasSiwcPlanUsage(grantedScopes),
        };
      }
      await readAsync(storage);
      if (state.fingerprint !== original) { if (storage) blockRefresh(auth); return; }
      current(storage);
      // Bind against the new access token claims only — never reuse the prior accountId field.
      const refreshedAccount = openAiAccountId({ access: tokens.access_token });
      if (refreshedAccount && refreshedAccount !== openAiAccountId(auth)) {
        state.blocked = true;
        if (storage) blockRefresh(auth);
        persist();
        throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
      }
      let committed;
      try { committed = await (storage ? storage.compareAndSwap(auth, next) : compareAndSwap(auth, next)); } catch {
        persistenceFailure = true;
        state.blocked = true;
        if (storage) blockRefresh(auth);
        persist();
        throw new OpenAiOAuthError('bot_oauth_persistence_failed');
      }
      await readAsync(storage);
      current(storage);
      if (state.fingerprint === original) {
        persistenceFailure = true;
        throw new OpenAiOAuthError('bot_oauth_persistence_failed');
      }
      diagnostic('persist', committed ? 'completed' : 'superseded', null, credentialId);
    } catch (error) {
      if (storage && (!response || response.ok)) blockRefresh(auth);
      if (state.fingerprint === original && state.refreshing) {
        // An interrupted/malformed successful exchange may have consumed the
        // refresh token. Do not repeatedly send that generation after ambiguity.
        state.blocked = true;
        state.refreshing = false;
        persist();
      }
      const reason = error instanceof OpenAiOAuthError && [OPENAI_OAUTH_AUTHENTICATION,
        'bot_oauth_response_invalid', 'bot_oauth_persistence_failed', 'bot_oauth_refresh_unavailable'].includes(error.code)
        ? error.code : 'bot_oauth_refresh_unavailable';
      diagnostic('refresh', 'failed', response?.status || null, credentialId, reason);
      if (error instanceof OpenAiOAuthError) throw error;
      throw new OpenAiOAuthError('bot_oauth_refresh_unavailable');
    }
  };
  const bindingFor = auth => ({ type: 'host_oauth', connectionId: 'host:openai', accountId: requireAccount(auth),
    registrationKey: fingerprint([siwcClientIdFromAuth(auth), auth.metadata?.subject ?? openAiAccountId(auth)]),
    methodID: auth.methodID, scopes: parseScopeList(auth.scopes ?? auth.metadata?.scopes), clientId: siwcClientIdFromAuth(auth),
    subject: auth.metadata?.subject ?? openAiAccountId(auth) });
  return Object.freeze({
    withAuthMutation,
    markReady() { ready = true; },
    markStopped() { ready = false; },
    usesOAuth() { return asyncStorage ? false : readAuth()?.type === 'oauth'; },
    getBinding() {
      if (!ready) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
      const auth = read();
      return bindingFor(auth);
    },
    getAuthState(expectedAccountId = null) {
      try {
        if (!ready) return 'unavailable';
        const auth = read();
        requireAccount(auth, expectedAccountId);
        return auth.access && auth.expires > now() + 60_000 ? 'ready' : 'unknown';
      } catch (error) { return error?.code === OPENAI_OAUTH_AUTHENTICATION ? 'reauth_required' : 'unavailable'; }
    },
    async usesOAuthAsync() { return (await readAsync(activeStorage()))?.type === 'oauth'; },
    async getBindingAsync() {
      if (!ready) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
      const storage = activeStorage(), auth = await readAsync(storage); current(storage);
      return bindingFor(auth);
    },
    async getAuthStateAsync(expectedAccountId = null) {
      try {
        if (!ready) return 'unavailable';
        const storage = activeStorage(), auth = await readAsync(storage); current(storage);
        requireAccount(auth, expectedAccountId);
        return auth.access && auth.expires > now() + 60_000 ? 'ready' : 'unknown';
      } catch (error) { return error?.code === OPENAI_OAUTH_AUTHENTICATION ? 'reauth_required' : 'unavailable'; }
    },
    async access({ expectedAccountId = null, expectedRegistrationKey = null, credentialId = null } = {}) {
      const safeCredentialId = typeof credentialId === 'string' && /^[a-f0-9-]{36}$/i.test(credentialId) ? credentialId : null;
      const storage = activeStorage();
      current(storage);
      for (let attempt = 0; attempt < 2; attempt++) {
        current(storage);
        const auth = await readAsync(storage); current(storage);
        const accountId = requireAccount(auth, expectedAccountId, expectedRegistrationKey);
        if (auth.access && Number.isFinite(auth.expires) && auth.expires > now() + 60_000) {
          return { accessToken: auth.access, expiresAt: auth.expires, accountId, generation: state.generation };
        }
        if (typeof auth.refresh !== 'string' || !auth.refresh) throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
        if (!inFlight) inFlight = withAuthMutation(() => refresh(auth, safeCredentialId, storage)).finally(() => { inFlight = null; });
        await inFlight;
      }
      throw new OpenAiOAuthError('bot_oauth_refresh_unavailable');
    },
  });
}
