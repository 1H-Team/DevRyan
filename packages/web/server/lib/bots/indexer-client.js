import { validateUuid } from './validation.js';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_QUERY_BYTES = 16 * 1024;
const MAX_REBUILD_DOCUMENTS = 25_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class BotIndexerClientError extends Error {
  constructor(message, code = 'bot_indexer_request_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotIndexerClientError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotIndexerClientError(message, code, statusCode);
};

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const botSharedMemoryNamespace = (botId) => `bot:${validateUuid(botId, 'botId')}`;
export const botPrivateMemoryNamespace = (botId, userId) => (
  `bot:${validateUuid(botId, 'botId')}:user:${validateUuid(userId, 'userId')}`
);
export const botChannelMemoryNamespace = (channelId) => (
  `channel:${validateUuid(channelId, 'channelId')}`
);

const validateNamespace = (value) => {
  const parts = typeof value === 'string' ? value.split(':') : [];
  if (parts.length === 2 && parts[0] === 'bot') {
    validateUuid(parts[1], 'namespace.botId');
    return value;
  }
  if (parts.length === 2 && parts[0] === 'channel') {
    validateUuid(parts[1], 'namespace.channelId');
    return value;
  }
  if (parts.length === 4 && parts[0] === 'bot' && parts[2] === 'user') {
    validateUuid(parts[1], 'namespace.botId');
    validateUuid(parts[3], 'namespace.userId');
    return value;
  }
  fail('Bot index namespace is invalid');
};

const validateIdentity = ({ namespace, documentId, version } = {}) => {
  const normalizedNamespace = validateNamespace(namespace);
  if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)
    || typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    fail('Bot index document identity is invalid');
  }
  return Object.freeze({ namespace: normalizedNamespace, documentId, version });
};

const validateMetadata = (value) => {
  const metadata = value === undefined ? {} : value;
  if (!isRecord(metadata)) fail('Bot index metadata is invalid');
  let encoded;
  try {
    encoded = JSON.stringify(metadata);
  } catch {
    fail('Bot index metadata is invalid');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) {
    fail('Bot index metadata is too large', 'bot_indexer_limit_exceeded', 413);
  }
  return structuredClone(metadata);
};

const validateDocument = (value) => {
  if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()) {
    fail('Bot index document is invalid');
  }
  if (Buffer.byteLength(value.text, 'utf8') > MAX_DOCUMENT_BYTES) {
    fail('Bot index document is too large', 'bot_indexer_limit_exceeded', 413);
  }
  return Object.freeze({
    ...validateIdentity(value),
    text: value.text,
    metadata: validateMetadata(value.metadata),
  });
};

const validateSearch = ({ namespaces, query, limit = 10 } = {}) => {
  if (!Array.isArray(namespaces) || namespaces.length < 1 || namespaces.length > 32
    || new Set(namespaces).size !== namespaces.length
    || typeof query !== 'string' || !query.trim()
    || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES
    || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    fail('Bot index search is invalid');
  }
  return Object.freeze({
    namespaces: Object.freeze(namespaces.map(validateNamespace)),
    query,
    limit,
  });
};

const readBoundedJson = async (response) => {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    fail('Bot index response is too large', 'bot_indexer_response_too_large', 502);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const value = await response.json().catch(() => null);
    return value;
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail('Bot index response is too large', 'bot_indexer_response_too_large', 502);
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('Bot index returned invalid JSON', 'bot_indexer_response_invalid', 502);
  }
};

export function createBotIndexerClient({
  request = null,
  baseUrl = null,
  token = null,
  fetchImpl = fetch,
  timeoutMs = 120_000,
} = {}) {
  const delegated = typeof request === 'function';
  let endpoint = null;
  if (!delegated) {
    try {
      endpoint = new URL(baseUrl);
    } catch {
      fail('Bot index client is unavailable', 'bot_indexer_unavailable', 503);
    }
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/' || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      fail('Bot index client is unavailable', 'bot_indexer_unavailable', 503);
    }
  }
  if ((!delegated && typeof fetchImpl !== 'function')
    || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    fail('Bot index client is unavailable', 'bot_indexer_unavailable', 503);
  }

  const invoke = async (operation, body = null) => {
    if (delegated) {
      const result = await request(Object.freeze({
        operation,
        ...(body === null ? {} : { body: structuredClone(body) }),
      }));
      if (!isRecord(result)) fail('Bot index returned an invalid response', 'bot_indexer_response_invalid', 502);
      return result;
    }
    const paths = {
      status: '/v1/status',
      upsert: '/v1/upsert',
      delete: '/v1/delete',
      search: '/v1/search',
      rebuild: '/v1/rebuild',
    };
    const pathname = paths[operation];
    if (!pathname) fail('Bot index operation is invalid');
    let response;
    try {
      response = await fetchImpl(new URL(pathname, endpoint), {
        method: operation === 'status' ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === null ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      fail('Bot index is unavailable', 'bot_indexer_unavailable', 503);
    }
    const payload = await readBoundedJson(response);
    if (!response.ok || payload?.ok !== true) {
      fail(
        'Bot index request failed',
        typeof payload?.error?.code === 'string' ? payload.error.code : 'bot_indexer_request_failed',
        response.status || 502,
      );
    }
    return operation === 'status' ? payload.status : payload.result;
  };

  return Object.freeze({
    status: () => invoke('status'),
    upsert(document) {
      return invoke('upsert', { document: validateDocument(document) });
    },
    delete(identity) {
      return invoke('delete', validateIdentity(identity));
    },
    search(input) {
      return invoke('search', validateSearch(input));
    },
    rebuild(documents) {
      if (!Array.isArray(documents) || documents.length > MAX_REBUILD_DOCUMENTS) {
        fail('Bot index rebuild is invalid', 'bot_indexer_limit_exceeded', 413);
      }
      return invoke('rebuild', { documents: documents.map(validateDocument) });
    },
  });
}
