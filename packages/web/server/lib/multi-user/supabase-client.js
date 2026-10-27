import { createSupabaseTraffic, supabaseTrafficOperation } from './supabase-traffic.js';

const isLegacyJwtKey = (value) => typeof value === 'string' && value.split('.').length === 3;

const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const responseDecoder = new TextDecoder();

export class SupabaseRequestError extends Error {
  constructor(message, { status = 500, payload = null } = {}) {
    super(message);
    this.name = 'SupabaseRequestError';
    this.status = status;
    this.payload = payload;
  }
}
const parseResponse = async (response, onBody = () => {}) => {
  const body = await readBoundedBody(response, MAX_JSON_RESPONSE_BYTES, {
    label: 'Supabase', onBody,
  });
  return parseBoundedJson(body);
};

const errorMessage = (payload, fallback) => {
  if (payload && typeof payload === 'object') {
    return payload.msg || payload.message || payload.error_description || payload.error || fallback;
  }
  return typeof payload === 'string' && payload.trim() ? payload.trim() : fallback;
};

const readBoundedBody = async (response, maximumBytes, {
  label = 'Supabase', onBody = () => {},
} = {}) => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new SupabaseRequestError('Supabase response limit is invalid', { status: 500 });
  }
  let total = 0;
  let reader = null;
  const tooLarge = () => {
    const error = new SupabaseRequestError(`${label} response is too large`, { status: 502 });
    error.code = 'supabase_response_too_large';
    return error;
  };
  try {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      await response.body?.cancel('response limit exceeded').catch(() => undefined);
      throw tooLarge();
    }
    if (!response.body) return Buffer.alloc(0);
    reader = response.body.getReader();
    const chunks = [];
    // Fetch exposes decoded chunks: this also bounds compressed and chunked
    // responses whose Content-Length does not describe the JSON being parsed.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('response limit exceeded').catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader?.releaseLock();
    onBody(total);
  }
};

const parseBoundedJson = (body) => {
  if (body.byteLength === 0) return null;
  const text = responseDecoder.decode(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export function createSupabaseServerClient({
  url, publishableKey, secretKey, fetchImpl = fetch,
  isConnectionEnabled = () => true,
  traffic = createSupabaseTraffic(),
}) {
  const beginRequest = (pathname, method) => {
    const operation = supabaseTrafficOperation(pathname, method);
    if (!isConnectionEnabled()) {
      traffic.blocked(operation);
      const error = new SupabaseRequestError('Supabase is disconnected on this host', { status: 503 });
      error.code = 'supabase_disconnected';
      throw error;
    }
    traffic.requested(operation);
    return operation;
  };
  const request = async (pathname, {
    method = 'GET',
    body,
    headers = {},
    key = secretKey,
    prefer,
    timeoutMs = 15_000,
  } = {}) => {
    const requestHeaders = {
      Accept: 'application/json',
      apikey: key,
      ...headers,
    };
    // Supabase's 2025+ sb_secret/sb_publishable keys are not JWTs and must not
    // be placed in Authorization. Legacy anon/service_role JWT keys still need it.
    if (isLegacyJwtKey(key) && !requestHeaders.Authorization) {
      requestHeaders.Authorization = `Bearer ${key}`;
    }
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (prefer) requestHeaders.Prefer = prefer;

    const operation = beginRequest(pathname, method);
    const response = await fetchImpl(`${url}${pathname}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      traffic.received(operation, 0, 0);
      throw error;
    });
    const payload = await parseResponse(response, (bytes) => traffic.received(operation, bytes, response.status));
    if (!response.ok) {
      throw new SupabaseRequestError(errorMessage(payload, `Supabase request failed (${response.status})`), {
        status: response.status,
        payload,
      });
    }
    return payload;
  };

  const rest = async (table, {
    method = 'GET',
    query = {},
    body,
    select,
    single = false,
    maybeSingle = false,
    prefer,
    timeoutMs,
  } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    if (select) params.set('select', select);
    const preferences = [prefer, single || maybeSingle ? 'return=representation' : null]
      .filter(Boolean)
      .join(',');
    const payload = await request(`/rest/v1/${encodeURIComponent(table)}${params.size ? `?${params}` : ''}`, {
      method,
      body,
      prefer: preferences || undefined,
      timeoutMs,
    });
    if (single || maybeSingle) {
      const row = Array.isArray(payload) ? payload[0] : payload;
      if (!row && single && !maybeSingle) {
        throw new SupabaseRequestError(`Expected one ${table} row`, { status: 404 });
      }
      return row || null;
    }
    return payload;
  };

  const rpc = async (functionName, args = {}) => request(
    `/rest/v1/rpc/${encodeURIComponent(functionName)}`,
    { method: 'POST', body: args },
  );

  return {
    traffic,
    rest,
    rpc,
    async signInWithPassword({ email, password }) {
      return request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        key: publishableKey,
        body: { email, password },
      });
    },
    async refreshSession(refreshToken) {
      return request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        key: publishableKey,
        body: { refresh_token: refreshToken },
      });
    },
    // Mints a session for reserved agent-test accounts without any password:
    // an admin-generated magic link is verified server-side for its tokens.
    async mintAgentTestSession(email) {
      const link = await request('/auth/v1/admin/generate_link', {
        method: 'POST',
        body: { type: 'magiclink', email },
      });
      const tokenHash = link?.properties?.hashed_token || link?.hashed_token;
      if (!tokenHash) {
        throw new SupabaseRequestError('Failed to generate agent-test login link', { status: 500 });
      }
      return request('/auth/v1/verify', {
        method: 'POST',
        key: publishableKey,
        body: { type: 'magiclink', token_hash: tokenHash },
      });
    },
    async createAuthUser({ email, password, metadata = {} }) {
      return request('/auth/v1/admin/users', {
        method: 'POST',
        body: {
          email,
          password,
          email_confirm: true,
          user_metadata: metadata,
        },
      });
    },
    async updateAuthUser(userId, changes) {
      return request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: changes,
      });
    },
    async deleteAuthUser(userId) {
      return request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    },
  };
}
