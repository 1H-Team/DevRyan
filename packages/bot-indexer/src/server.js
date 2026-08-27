import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { chunkBotText } from './chunker.js';
import {
  BotEmbeddingError,
  createEmbeddingService,
  encodeEmbedding,
  verifyEmbeddingCache,
} from './embeddings.js';
import { BotIndexStoreError, createIndexStore } from './index-store.js';
import { BotSearchError, createHybridSearch } from './search.js';

const DEFAULT_PORT = 43123;
const DEFAULT_DATABASE_PATH = '/var/lib/devryan-bot-index/index.sqlite';
const DEFAULT_MODEL_CACHE = '/opt/devryan/model-cache';
const DEFAULT_MODEL_MANIFEST = '/opt/devryan/model-cache-manifest.json';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class BotIndexerRequestError extends Error {
  constructor(message, code = 'bot_indexer_request_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotIndexerRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotIndexerRequestError(message, code, statusCode);
};

const sendJson = (response, statusCode, value, extraHeaders = {}) => {
  if (response.headersSent) return;
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    ...extraHeaders,
  });
  response.end(payload);
};

const singleHeader = (request, name) => {
  let value;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== name) continue;
    count += 1;
    value = request.rawHeaders[index + 1];
  }
  return count === 1 ? value : undefined;
};

export function createIndexerAuthenticator(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    fail('Indexer bearer token is invalid', 'bot_indexer_configuration_invalid', 500);
  }
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  return (authorization) => {
    const actual = typeof authorization === 'string' ? Buffer.from(authorization, 'utf8') : Buffer.alloc(0);
    const valid = actual.byteLength === expected.byteLength && crypto.timingSafeEqual(actual, expected);
    if (!valid) fail('Authentication required', 'bot_indexer_auth_required', 401);
  };
}

const readJson = async (request) => {
  const contentType = singleHeader(request, 'content-type');
  if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    fail('Content-Type must be application/json', 'bot_indexer_content_type_invalid', 415);
  }
  const contentLength = singleHeader(request, 'content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    fail('Request body is too large', 'bot_indexer_request_too_large', 413);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) fail('Request body is too large', 'bot_indexer_request_too_large', 413);
    chunks.push(chunk);
  }
  if (bytes === 0) fail('Request body is required');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('JSON object required');
    return value;
  } catch (error) {
    if (error instanceof BotIndexerRequestError) throw error;
    fail('Request body is invalid JSON');
  }
};

const routeKey = (request) => {
  let url;
  try {
    url = new URL(request.url, 'http://indexer.invalid');
  } catch {
    fail('Request target is invalid');
  }
  if (url.search || url.hash) fail('Query parameters are not supported');
  return `${request.method} ${url.pathname}`;
};

const prepareDocument = async (raw, embeddings) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.text !== 'string') {
    fail('Index document payload is invalid');
  }
  const chunks = chunkBotText(raw.text);
  if (chunks.length === 0) fail('Index document cannot be blank');
  const vectors = [];
  for (let offset = 0; offset < chunks.length; offset += 256) {
    vectors.push(...await embeddings.embed(chunks.slice(offset, offset + 256).map(({ text }) => text)));
  }
  return Object.freeze({
    namespace: raw.namespace,
    documentId: raw.documentId,
    version: raw.version,
    metadata: raw.metadata,
    chunks: Object.freeze(chunks.map((chunk, index) => Object.freeze({
      ordinal: chunk.ordinal,
      text: chunk.text,
      bytes: chunk.bytes,
      embedding: encodeEmbedding(vectors[index]),
    }))),
  });
};

export function createIndexerService({ store, embeddings } = {}) {
  if (!store || typeof store.upsert !== 'function' || typeof store.rebuild !== 'function'
    || !embeddings || typeof embeddings.embed !== 'function') {
    fail('Indexer service dependencies are invalid', 'bot_indexer_configuration_invalid', 500);
  }
  const hybrid = createHybridSearch({ store, embeddings });
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  return Object.freeze({
    status: () => Object.freeze({ ...store.status(), model: embeddings.model }),
    upsert: (document) => serialize(async () => store.upsert(await prepareDocument(document, embeddings))),
    delete: (identity) => serialize(async () => store.delete(identity)),
    search: (request) => serialize(async () => hybrid.search(request)),
    rebuild: (documents) => serialize(async () => {
      if (!Array.isArray(documents)) fail('Rebuild documents are invalid');
      const prepared = [];
      for (const document of documents) prepared.push(await prepareDocument(document, embeddings));
      return store.rebuild(prepared);
    }),
  });
}

const errorResponse = (error) => {
  if (error instanceof BotIndexerRequestError || error instanceof BotEmbeddingError
    || error instanceof BotIndexStoreError || error instanceof BotSearchError
    || (Number.isInteger(error?.statusCode) && typeof error?.code === 'string')) {
    return {
      statusCode: error.statusCode || 500,
      code: error.code,
      message: error.message,
    };
  }
  return {
    statusCode: 500,
    code: 'bot_indexer_internal_error',
    message: 'Local retrieval index request failed',
  };
};

export function createIndexerHttpServer({ token, service } = {}) {
  if (!service || typeof service.status !== 'function') {
    fail('Indexer HTTP service is invalid', 'bot_indexer_configuration_invalid', 500);
  }
  const authenticate = createIndexerAuthenticator(token);
  const server = http.createServer(async (request, response) => {
    try {
      const route = routeKey(request);
      if (route === 'GET /healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }
      authenticate(singleHeader(request, 'authorization'));
      if (route === 'GET /v1/status') {
        sendJson(response, 200, { ok: true, status: service.status() });
        return;
      }
      const operations = {
        'POST /v1/upsert': async (body) => service.upsert(body.document),
        'POST /v1/delete': async (body) => service.delete(body),
        'POST /v1/search': async (body) => service.search(body),
        'POST /v1/rebuild': async (body) => service.rebuild(body.documents),
      };
      const operation = operations[route];
      if (!operation) fail('Indexer command was not found', 'bot_indexer_command_not_found', 404);
      const body = await readJson(request);
      sendJson(response, 200, { ok: true, result: await operation(body) });
    } catch (error) {
      const failure = errorResponse(error);
      sendJson(response, failure.statusCode, {
        ok: false,
        error: { code: failure.code, message: failure.message },
      }, failure.statusCode === 401
        ? { 'www-authenticate': 'Bearer realm="devryan-bot-indexer"' }
        : {});
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function startIndexerService({
  token,
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  databasePath = DEFAULT_DATABASE_PATH,
  modelCacheDirectory = DEFAULT_MODEL_CACHE,
  modelManifestPath = DEFAULT_MODEL_MANIFEST,
  verifyModel = verifyEmbeddingCache,
  store,
  embeddings,
} = {}) {
  if (!store || !embeddings) {
    await verifyModel({ cacheDirectory: modelCacheDirectory, manifestPath: modelManifestPath });
  }
  const ownedStore = store || createIndexStore({ databasePath });
  const ownedEmbeddings = embeddings || createEmbeddingService({ cacheDirectory: modelCacheDirectory });
  const service = createIndexerService({ store: ownedStore, embeddings: ownedEmbeddings });
  const server = createIndexerHttpServer({ token, service });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    ownedStore.close();
    throw error;
  }
  let closed = false;
  return Object.freeze({
    server,
    service,
    address: server.address(),
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      ownedStore.close();
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const runtime = await startIndexerService({
    token: process.env.DEVRYAN_BOT_INDEXER_TOKEN,
    port: Number(process.env.DEVRYAN_BOT_INDEXER_PORT || DEFAULT_PORT),
    databasePath: process.env.DEVRYAN_BOT_INDEX_PATH || DEFAULT_DATABASE_PATH,
    modelCacheDirectory: process.env.DEVRYAN_BOT_MODEL_CACHE || DEFAULT_MODEL_CACHE,
    modelManifestPath: process.env.DEVRYAN_BOT_MODEL_MANIFEST || DEFAULT_MODEL_MANIFEST,
  }).catch((error) => {
    console.error(`[bot-indexer] startup failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
    return null;
  });
  if (runtime) {
    const shutdown = () => runtime.close().catch(() => undefined);
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    const address = runtime.address;
    console.log(`[bot-indexer] listening on port ${typeof address === 'object' && address ? address.port : DEFAULT_PORT}`);
  }
}
