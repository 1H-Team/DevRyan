import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Official Sign in with ChatGPT open-source plan-usage method. */
export const CHATGPT_SIWC_METHOD_ID = 'chatgpt-siwc';
export const CHATGPT_SIWC_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const CHATGPT_SIWC_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_SIWC_ISSUER = 'https://auth.openai.com';
export const CHATGPT_SIWC_JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
export const CHATGPT_SIWC_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SIWC_PLAN_SCOPE = 'chatgpt.tokens.use.direct';

const LEGACY_CODEX_METHODS = new Set(['chatgpt-browser', 'chatgpt-headless']);
const jwks = createRemoteJWKSet(new URL(CHATGPT_SIWC_JWKS_URL));

export const isChatgptSiwcMethodId = (methodID) => methodID === CHATGPT_SIWC_METHOD_ID;
export const isLegacyCodexChatgptMethodId = (methodID) => LEGACY_CODEX_METHODS.has(methodID);

export function failSiwc(code, status = 409) {
  return Object.assign(new Error(code), { code, status, statusCode: status });
}

export function parseScopeList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.trim().split(/\s+/).filter(Boolean);
}

export function hasSiwcPlanUsage(scopes) {
  return parseScopeList(scopes).includes(CHATGPT_SIWC_PLAN_SCOPE);
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
