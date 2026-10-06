import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Official Sign in with ChatGPT open-source plan-usage method. */
export const CHATGPT_SIWC_METHOD_ID = 'chatgpt-siwc';
export const CHATGPT_SIWC_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const CHATGPT_SIWC_AGENT_NAME = 'DevRyan';
export const CHATGPT_SIWC_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const CHATGPT_SIWC_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_SIWC_ISSUER = 'https://auth.openai.com';
export const CHATGPT_SIWC_JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
export const CHATGPT_SIWC_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SIWC_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const CHATGPT_SIWC_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_SIWC_CALLBACK_PATH = '/auth/callback';

const LEGACY_CODEX_METHODS = new Set(['chatgpt-browser', 'chatgpt-headless']);
const jwks = createRemoteJWKSet(new URL(CHATGPT_SIWC_JWKS_URL));

export const isChatgptSiwcMethodId = (methodID) => methodID === CHATGPT_SIWC_METHOD_ID;
export const isLegacyCodexChatgptMethodId = (methodID) => LEGACY_CODEX_METHODS.has(methodID);
export const isSupportedOpenAiOAuthMethodId = (methodID) => isChatgptSiwcMethodId(methodID);

export function failSiwc(code, status = 409) {
  return Object.assign(new Error(code), { code, status, statusCode: status });
}

export function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function createOAuthNonce() {
  return base64Url(crypto.randomBytes(32));
}

export function resolveSiwcHostIdPath(dataDirectory) {
  return path.join(dataDirectory, 'runtime', 'chatgpt-siwc-host-id');
}

export function resolveSiwcRegistrationPath(dataDirectory) {
  return path.join(dataDirectory, 'runtime', 'chatgpt-siwc-registrations.json');
}

/** Stable per-install host ID. Created once; never derived from user identity. */
export function readOrCreateSiwcHostId(dataDirectory, { randomUUID = crypto.randomUUID } = {}) {
  const file = resolveSiwcHostIdPath(dataDirectory);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw failSiwc('native_chatgpt_siwc_host_id_unreadable', 503);
  }
  const value = `urn:uuid:${randomUUID()}`;
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${value}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve write failure */ }
  }
  return value;
}

export function readSiwcRegistrations(dataDirectory) {
  const file = resolveSiwcRegistrationPath(dataDirectory);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.accounts)) {
      throw failSiwc('native_chatgpt_siwc_registration_invalid', 503);
    }
    if (parsed.accounts.length > 64) throw failSiwc('native_chatgpt_siwc_registration_invalid', 503);
    const accounts = parsed.accounts.map(row => {
      if (!row || typeof row.subject !== 'string' || !row.subject || typeof row.clientId !== 'string' || !row.clientId
        || row.clientId === CHATGPT_SIWC_DYNAMIC_CLIENT_ID) throw failSiwc('native_chatgpt_siwc_registration_invalid', 503);
      return { registrationRef: typeof row.registrationRef === 'string' ? row.registrationRef : crypto.randomUUID(),
        subject: row.subject, clientId: row.clientId, credentialID: typeof row.credentialID === 'string' ? row.credentialID : null,
        ...(typeof row.stagedCredentialID === 'string' ? { stagedCredentialID: row.stagedCredentialID } : {}),
        ...(typeof row.email === 'string' ? { email: row.email } : {}),
        ...(typeof row.savedAt === 'string' ? { savedAt: row.savedAt } : {}) };
    });
    // Older enrollment caches retained ID tokens. Strip them during the first read;
    // returning hints are read solely through the scoped native credential owner.
    const migrationRequired = parsed.accounts.some((row, index) => Object.keys(row).length !== Object.keys(accounts[index]).length
      || Object.entries(accounts[index]).some(([key, value]) => row[key] !== value));
    if (migrationRequired) writeSiwcRegistrations(dataDirectory, { accounts });
    return { accounts };
  } catch (error) {
    if (error?.code === 'ENOENT') return { accounts: [] };
    if (error?.code?.startsWith?.('native_chatgpt_siwc_')) throw error;
    throw failSiwc('native_chatgpt_siwc_registration_invalid', 503);
  }
}

export function writeSiwcRegistrations(dataDirectory, value) {
  const file = resolveSiwcRegistrationPath(dataDirectory);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve write failure */ }
  }
}

export function parseScopeList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.trim().split(/\s+/).filter(Boolean);
}

export function hasSiwcPlanUsage(scopes) {
  return parseScopeList(scopes).includes(CHATGPT_SIWC_PLAN_SCOPE);
}

export function buildSiwcAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  nonce,
  codeChallenge,
  hostId,
  agentNameHint,
  idTokenHint,
  loginHint,
}) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: CHATGPT_SIWC_SCOPES,
    resource: CHATGPT_SIWC_RESOURCE,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ext_agent_host_id: hostId,
  });
  if (clientId === CHATGPT_SIWC_DYNAMIC_CLIENT_ID && agentNameHint) {
    params.set('agent_name_hint', agentNameHint);
  }
  if (typeof idTokenHint === 'string' && idTokenHint) params.set('id_token_hint', idTokenHint);
  if (typeof loginHint === 'string' && loginHint) params.set('login_hint', loginHint);
  return `${CHATGPT_SIWC_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeSiwcAuthorizationCode({
  clientId,
  code,
  codeVerifier,
  redirectUri,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(CHATGPT_SIWC_TOKEN_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
      resource: CHATGPT_SIWC_RESOURCE,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw failSiwc(response.status === 400 || response.status === 401
      ? 'native_chatgpt_siwc_code_invalid'
      : 'native_chatgpt_siwc_token_unavailable', response.status === 400 ? 400 : 503);
  }
  return readTokenResponse(response);
}

export async function refreshSiwcAccessToken({
  clientId,
  refreshToken,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(CHATGPT_SIWC_TOKEN_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: CHATGPT_SIWC_RESOURCE,
    }),
  });
  if (!response.ok) return { response, tokens: null, invalid: false };
  try {
    return { response, tokens: await readTokenResponse(response, { requireIdToken: false }), invalid: false };
  } catch (error) {
    if (error?.code === 'native_chatgpt_siwc_token_invalid') {
      return { response, tokens: null, invalid: true };
    }
    throw error;
  }
}

/** Account model catalog for SIWC plan usage (`GET /v1/models`). */
export async function listSiwcAccountModels(accessToken, { fetchImpl = fetch } = {}) {
  if (typeof accessToken !== 'string' || !accessToken) {
    throw failSiwc('native_chatgpt_siwc_access_required', 401);
  }
  const response = await fetchImpl('https://api.openai.com/v1/models', {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw failSiwc('native_chatgpt_siwc_models_unavailable', response.status >= 400 && response.status < 600 ? response.status : 503);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw failSiwc('native_chatgpt_siwc_models_invalid', 503);
  }
  const rows = Array.isArray(payload?.models) ? payload.models
    : Array.isArray(payload?.data) ? payload.data
      : null;
  if (!rows) throw failSiwc('native_chatgpt_siwc_models_invalid', 503);
  const models = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const visibility = typeof row.visibility === 'string' ? row.visibility : 'list';
    if (visibility !== 'list') continue;
    const slug = typeof row.slug === 'string' ? row.slug
      : typeof row.id === 'string' ? row.id
        : null;
    if (slug) models.push({ slug, displayName: typeof row.display_name === 'string' && row.display_name ? row.display_name : slug });
  }
  return models;
}

async function readTokenResponse(response, { requireIdToken = true } = {}) {
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw failSiwc('native_chatgpt_siwc_token_invalid', 503);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let tokens;
  try {
    tokens = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failSiwc('native_chatgpt_siwc_token_invalid', 503);
  }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token
    || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
    || !Number.isFinite(tokens.expires_in) || tokens.expires_in < 120
    || tokens.id_token !== undefined && (typeof tokens.id_token !== 'string' || !tokens.id_token)
    || requireIdToken && !tokens.id_token
    || tokens.scope !== undefined && typeof tokens.scope !== 'string') {
    throw failSiwc('native_chatgpt_siwc_token_invalid', 503);
  }
  return tokens;
}

export async function verifySiwcIdToken(idToken, { audience, nonce, jwksImpl = jwks } = {}) {
  const { payload } = await jwtVerify(idToken, jwksImpl, {
    issuer: CHATGPT_SIWC_ISSUER,
    audience,
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: 5,
  });
  if (nonce !== undefined && payload.nonce !== nonce) {
    throw failSiwc('native_chatgpt_siwc_nonce_invalid', 400);
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw failSiwc('native_chatgpt_siwc_identity_invalid', 400);
  }
  return payload;
}

export function buildSiwcCredentialValue({
  access,
  refresh,
  expires,
  clientId,
  idToken,
  scopes,
  subject,
  email,
  hostId,
}) {
  if (!isSupportedOpenAiOAuthMethodId(CHATGPT_SIWC_METHOD_ID)
    || typeof access !== 'string' || !access
    || typeof refresh !== 'string' || !refresh
    || !Number.isSafeInteger(expires)
    || typeof clientId !== 'string' || !clientId || clientId === CHATGPT_SIWC_DYNAMIC_CLIENT_ID
    || typeof idToken !== 'string' || !idToken
    || typeof subject !== 'string' || !subject
    || typeof hostId !== 'string' || !hostId) {
    throw failSiwc('native_chatgpt_siwc_credential_invalid', 400);
  }
  return {
    type: 'oauth',
    methodID: CHATGPT_SIWC_METHOD_ID,
    access,
    refresh,
    expires,
    metadata: {
      accountID: subject,
      clientId,
      idToken,
      scopes: parseScopeList(scopes),
      subject,
      ...(typeof email === 'string' && email ? { email } : {}),
      extAgentHostId: hostId,
      planUsage: hasSiwcPlanUsage(scopes),
    },
  };
}

export function siwcClientIdFromAuth(auth) {
  const value = auth?.clientId ?? auth?.metadata?.clientId;
  return typeof value === 'string' && value && value !== CHATGPT_SIWC_DYNAMIC_CLIENT_ID ? value : null;
}

export function isSiwcAuthRecord(auth) {
  return auth?.type === 'oauth'
    && isChatgptSiwcMethodId(auth.methodID)
    && Boolean(siwcClientIdFromAuth(auth))
    && hasSiwcPlanUsage(auth.scopes ?? auth.metadata?.scopes);
}


/** Discovery is public; the renewable token never leaves this private host call. */
export async function revokeSiwcSession(value, { fetchImpl = fetch } = {}) {
  const clientId = siwcClientIdFromAuth(value);
  if (value?.type !== 'oauth' || !clientId || typeof value.refresh !== 'string' || !value.refresh) return 'not_applicable';
  try {
    const discovery = await fetchImpl('https://auth.openai.com/.well-known/openid-configuration', {
      redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' },
    });
    if (!discovery.ok) { await discovery.body?.cancel(); return 'unconfirmed'; }
    const endpoint = new URL((await discovery.json()).revocation_endpoint);
    if (endpoint.origin !== CHATGPT_SIWC_ISSUER || endpoint.username || endpoint.password || endpoint.hash) return 'unconfirmed';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchImpl(endpoint.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: value.refresh, token_type_hint: 'refresh_token', client_id: clientId }) });
        await response.body?.cancel();
        if (response.status === 200) return 'confirmed';
        if (response.status < 500) return 'unconfirmed';
      } catch { /* Retry a transient network failure once within the same bounded request. */ }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch { /* Local sign-out still clears tokens and reports remote uncertainty. */ }
  return 'unconfirmed';
}
