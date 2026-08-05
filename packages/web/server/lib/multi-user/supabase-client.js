const isLegacyJwtKey = (value) => typeof value === 'string' && value.split('.').length === 3;

export class SupabaseRequestError extends Error {
  constructor(message, { status = 500, payload = null } = {}) {
    super(message);
    this.name = 'SupabaseRequestError';
    this.status = status;
    this.payload = payload;
  }
}
const parseResponse = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const errorMessage = (payload, fallback) => {
  if (payload && typeof payload === 'object') {
    return payload.msg || payload.message || payload.error_description || payload.error || fallback;
  }
  return typeof payload === 'string' && payload.trim() ? payload.trim() : fallback;
};

export function createSupabaseServerClient({ url, publishableKey, secretKey, fetchImpl = fetch }) {
  const request = async (pathname, {
    method = 'GET',
    body,
    headers = {},
    key = secretKey,
    prefer,
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

    const response = await fetchImpl(`${url}${pathname}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await parseResponse(response);
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
