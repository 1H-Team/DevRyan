const isLegacyJwtKey = (value) => typeof value === 'string' && value.split('.').length === 3;

const DEFAULT_STORAGE_TIMEOUT_MS = 30_000;
const MAX_STORAGE_TIMEOUT_MS = 60_000;
const DEFAULT_STORAGE_RESPONSE_LIMIT = 64 * 1024;
const MAX_STORAGE_OBJECT_BYTES = 25 * 1024 * 1024;
const STORAGE_BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

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

const storagePath = (bucket, objectName = '') => {
  if (typeof bucket !== 'string' || !STORAGE_BUCKET_PATTERN.test(bucket)) {
    throw new SupabaseRequestError('Supabase Storage bucket is invalid', { status: 400 });
  }
  if (!objectName) return encodeURIComponent(bucket);
  if (typeof objectName !== 'string' || objectName.length > 512 || objectName.includes('\0')) {
    throw new SupabaseRequestError('Supabase Storage object name is invalid', { status: 400 });
  }
  const segments = objectName.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new SupabaseRequestError('Supabase Storage object name is invalid', { status: 400 });
  }
  return `${encodeURIComponent(bucket)}/${segments.map(encodeURIComponent).join('/')}`;
};

const readBoundedBody = async (response, maximumBytes) => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new SupabaseRequestError('Supabase response limit is invalid', { status: 500 });
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new SupabaseRequestError('Supabase Storage response is too large', { status: 502 });
  }

  if (!response.body?.getReader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maximumBytes) {
      throw new SupabaseRequestError('Supabase Storage response is too large', { status: 502 });
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('response limit exceeded').catch(() => undefined);
        throw new SupabaseRequestError('Supabase Storage response is too large', { status: 502 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

const parseBoundedJson = (body) => {
  if (body.byteLength === 0) return null;
  const text = body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const validateStorageTimeout = (timeoutMs) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STORAGE_TIMEOUT_MS) {
    throw new SupabaseRequestError('Supabase Storage timeout is invalid', { status: 400 });
  }
  return timeoutMs;
};

const validateStorageObjectLimit = (maximumBytes) => {
  if (!Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > MAX_STORAGE_OBJECT_BYTES) {
    throw new SupabaseRequestError('Supabase Storage size limit is invalid', { status: 400 });
  }
  return maximumBytes;
};

export function createSupabaseServerClient({ url, publishableKey, secretKey, fetchImpl = fetch }) {
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

    const response = await fetchImpl(`${url}${pathname}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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

  const storageRequest = async (pathname, {
    method = 'GET',
    body,
    contentType,
    timeoutMs = DEFAULT_STORAGE_TIMEOUT_MS,
    maximumResponseBytes = DEFAULT_STORAGE_RESPONSE_LIMIT,
  } = {}) => {
    const headers = {
      Accept: 'application/json',
      apikey: secretKey,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    };
    if (isLegacyJwtKey(secretKey)) headers.Authorization = `Bearer ${secretKey}`;
    const response = await fetchImpl(`${url}${pathname}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(validateStorageTimeout(timeoutMs)),
    });
    const responseBody = await readBoundedBody(response, maximumResponseBytes);
    if (!response.ok) {
      const payload = parseBoundedJson(responseBody);
      throw new SupabaseRequestError(
        errorMessage(payload, `Supabase Storage request failed (${response.status})`),
        { status: response.status, payload },
      );
    }
    return responseBody;
  };

  return {
    rest,
    rpc,
    async storageUpload(bucket, objectName, bytes, {
      contentType = 'application/octet-stream',
      timeoutMs = DEFAULT_STORAGE_TIMEOUT_MS,
      maximumBytes = MAX_STORAGE_OBJECT_BYTES,
    } = {}) {
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
      const boundedMaximum = validateStorageObjectLimit(maximumBytes);
      if (body.byteLength > boundedMaximum) {
        throw new SupabaseRequestError('Supabase Storage upload is too large', { status: 413 });
      }
      const responseBody = await storageRequest(
        `/storage/v1/object/${storagePath(bucket, objectName)}`,
        {
          method: 'POST',
          body,
          contentType,
          timeoutMs,
        },
      );
      return parseBoundedJson(responseBody);
    },
    async storageDownload(bucket, objectName, {
      timeoutMs = DEFAULT_STORAGE_TIMEOUT_MS,
      maximumBytes = MAX_STORAGE_OBJECT_BYTES,
    } = {}) {
      return storageRequest(`/storage/v1/object/${storagePath(bucket, objectName)}`, {
        timeoutMs,
        maximumResponseBytes: validateStorageObjectLimit(maximumBytes),
      });
    },
    async storageDelete(bucket, objectNames, {
      timeoutMs = DEFAULT_STORAGE_TIMEOUT_MS,
    } = {}) {
      if (!Array.isArray(objectNames) || objectNames.length < 1 || objectNames.length > 100) {
        throw new SupabaseRequestError('Supabase Storage delete list is invalid', { status: 400 });
      }
      const prefixes = objectNames.map((objectName) => {
        storagePath(bucket, objectName);
        return objectName;
      });
      const responseBody = await storageRequest(`/storage/v1/object/${storagePath(bucket)}`, {
        method: 'DELETE',
        body: JSON.stringify({ prefixes }),
        contentType: 'application/json',
        timeoutMs,
      });
      return parseBoundedJson(responseBody);
    },
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
