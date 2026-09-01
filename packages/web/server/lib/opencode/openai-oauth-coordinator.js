import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AUTH_FILE, readProviderAuthRecord } from './auth.js';

export const OPENAI_OAUTH_AUTHENTICATION = 'bot_opencode_provider_authentication';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
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
  if (typeof record?.accountId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(record.accountId)) return record.accountId;
  try {
    const claims = JSON.parse(Buffer.from(record.access.split('.')[1], 'base64url').toString('utf8'));
    const value = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
  } catch { return null; }
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
  recordDiagnostic = () => {},
  stateFile = null,
} = {}) {
  let state = { fingerprint: null, generation: null, blocked: false };
  let persistenceFailure = false;
  let unreadableState = false;
  if (stateFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!/^[a-f0-9]{64}$/.test(saved.fingerprint) || !/^[a-f0-9-]{36}$/.test(saved.generation)
        || typeof saved.blocked !== 'boolean') throw new Error('invalid OAuth state');
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
    const pending = mutationQueue.then(work);
    mutationQueue = pending.catch(() => {});
    return pending;
  };
  const persist = () => {
    if (!stateFile) return;
    const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, stateFile);
    } catch {
      persistenceFailure = true;
      throw new OpenAiOAuthError('bot_oauth_persistence_failed');
    } finally { try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original failure */ } }
  };
  const read = () => {
    if (unreadableState) throw new OpenAiOAuthError('bot_oauth_persistence_failed');
    const auth = readAuth();
    const key = fingerprint(auth);
    if (key !== state.fingerprint) {
      state = { fingerprint: key, generation: crypto.randomUUID(), blocked: false };
      persistenceFailure = false;
      persist();
    }
    return auth;
  };
  const diagnostic = (stage, outcome, statusCode = null, credentialId = null) => {
    try {
      recordDiagnostic({ type: 'lifecycle', event: 'provider.oauth.refresh', payload: {
        provider: 'openai', credentialId, generation: state.generation, stage, outcome, statusCode,
      } });
    } catch { /* diagnostics must not replace the provider failure */ }
  };
  const requireAccount = (auth, expectedAccountId) => {
    if (persistenceFailure) throw new OpenAiOAuthError('bot_oauth_persistence_failed');
    const accountId = openAiAccountId(auth);
    if (auth?.type !== 'oauth' || !accountId || (expectedAccountId && expectedAccountId !== accountId) || state.blocked) {
      throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
    }
    return accountId;
  };
  const refresh = async (auth, credentialId) => {
    const original = state.fingerprint;
    read();
    if (fingerprint(auth) !== state.fingerprint) return;
    if (!ready) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
    diagnostic('refresh', 'started', null, credentialId);
    let response;
    try {
      state.refreshing = true;
      persist();
      response = await fetchImpl('https://auth.openai.com/oauth/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: CLIENT_ID }),
      });
      // A login/disconnect that won while refresh was in flight is authoritative.
      read();
      if (state.fingerprint !== original) { await response.body?.cancel(); return; }
      if (!response.ok) {
        await response.body?.cancel();
        state.refreshing = false;
        if ([400, 401, 403].includes(response.status)) {
          state.blocked = true;
          persist();
          diagnostic('refresh', 'reauth_required', response.status, credentialId);
          throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
        }
        persist();
        throw new OpenAiOAuthError('bot_oauth_refresh_unavailable');
      }
      // Never retain or log arbitrary OAuth error bodies.
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 64 * 1024) throw new Error('oversized OAuth response');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const tokens = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof tokens.access_token !== 'string' || !tokens.access_token
        || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
        || !Number.isFinite(tokens.expires_in) || tokens.expires_in < 120 || tokens.expires_in > 86400) {
        throw new OpenAiOAuthError('bot_oauth_response_invalid');
      }
      const next = { ...auth, access: tokens.access_token, refresh: tokens.refresh_token,
        expires: now() + tokens.expires_in * 1000 };
      read();
      if (state.fingerprint !== original) return;
      const refreshedAccount = openAiAccountId({ access: tokens.access_token });
      if (refreshedAccount && refreshedAccount !== openAiAccountId(auth)) {
        state.blocked = true;
        persist();
        throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
      }
      let committed;
      try { committed = compareAndSwap(auth, next); } catch {
        persistenceFailure = true;
        state.blocked = true;
        persist();
        throw new OpenAiOAuthError('bot_oauth_persistence_failed');
      }
      read();
      if (state.fingerprint === original) {
        persistenceFailure = true;
        throw new OpenAiOAuthError('bot_oauth_persistence_failed');
      }
      diagnostic('persist', committed ? 'completed' : 'superseded', null, credentialId);
    } catch (error) {
      if (state.fingerprint === original && state.refreshing) {
        // An interrupted/malformed successful exchange may have consumed the
        // refresh token. Do not repeatedly send that generation after ambiguity.
        state.blocked = true;
        state.refreshing = false;
        persist();
      }
      diagnostic('refresh', 'failed', response?.status || null, credentialId);
      if (error instanceof OpenAiOAuthError) throw error;
      throw new OpenAiOAuthError('bot_oauth_refresh_unavailable');
    }
  };
  return Object.freeze({
    withAuthMutation,
    markReady() { ready = true; },
    markStopped() { ready = false; },
    usesOAuth() { return readAuth()?.type === 'oauth'; },
    getBinding() {
      if (!ready) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
      const auth = read();
      return { type: 'host_oauth', connectionId: 'host:openai', accountId: requireAccount(auth) };
    },
    getAuthState(expectedAccountId = null) {
      try {
        if (!ready) return 'unavailable';
        const auth = read();
        requireAccount(auth, expectedAccountId);
        return auth.access && auth.expires > now() + 60_000 ? 'ready' : 'unknown';
      } catch (error) { return error?.code === OPENAI_OAUTH_AUTHENTICATION ? 'reauth_required' : 'unavailable'; }
    },
    async access({ expectedAccountId = null, credentialId = null } = {}) {
      const safeCredentialId = typeof credentialId === 'string' && /^[a-f0-9-]{36}$/i.test(credentialId) ? credentialId : null;
      if (!ready) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!ready) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
        const auth = read();
        const accountId = requireAccount(auth, expectedAccountId);
        if (auth.access && Number.isFinite(auth.expires) && auth.expires > now() + 60_000) {
          return { accessToken: auth.access, expiresAt: auth.expires, accountId, generation: state.generation };
        }
        if (typeof auth.refresh !== 'string' || !auth.refresh) throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
        if (!inFlight) inFlight = withAuthMutation(() => refresh(auth, safeCredentialId)).finally(() => { inFlight = null; });
        await inFlight;
      }
      throw new OpenAiOAuthError('bot_oauth_refresh_unavailable');
    },
  });
}
