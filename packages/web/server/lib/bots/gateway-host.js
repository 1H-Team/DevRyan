import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { assertBotJsonValue } from '@openchamber/bots-runtime';

import { validateUuid } from './validation.js';
import { botErrorLogFields } from './error-normalization.js';

export const BOT_PRIVATE_GATEWAY_PATH = '/api/bots/private/gateway';
export const BOT_PRIVATE_OAUTH_PATH = '/api/bots/private/oauth';
export const BOT_GATEWAY_OPERATIONS = Object.freeze([
  'action.request',
  'artifact.get',
  'artifact.put',
  'computer.command',
  'conversation.ask',
  'library.search',
  'memory.search',
  'workspace.write',
]);

const DEFAULT_BODY_LIMIT = 64 * 1024;
const DEFAULT_RESPONSE_LIMIT = 256 * 1024;
const DEFAULT_CAPABILITY_TTL_MS = 15 * 60 * 1000;
const MAX_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_PATTERN = /^(?:channel|bot):[0-9a-f-]{36}(?::user:[0-9a-f-]{36})?$/i;
const FORBIDDEN_REQUEST_HEADERS = Object.freeze([
  'cookie',
  'forwarded',
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

export class BotGatewayHostError extends Error {
  constructor(message, code = 'bot_gateway_request_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotGatewayHostError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotGatewayHostError(message, code, statusCode);
};

const tokenDigest = (token) => crypto.createHash('sha256').update(token, 'ascii').digest('hex');

const readSingleRawHeader = (request, target) => {
  let value;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== target) continue;
    count += 1;
    value = request.rawHeaders[index + 1];
  }
  return count === 1 ? value : undefined;
};

const readBearerToken = (request) => {
  const header = readSingleRawHeader(request, 'authorization');
  const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/.exec(header) : null;
  if (!match || !TOKEN_PATTERN.test(match[1])) {
    fail('Bot gateway authentication is required', 'bot_gateway_unauthorized', 401);
  }
  return match[1];
};

const isLoopbackAddress = (value) => {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
};

const assertDockerOrigin = (request, port) => {
  if (!isLoopbackAddress(request.socket?.remoteAddress)
    || !isLoopbackAddress(request.socket?.localAddress)) {
    fail('Bot gateway origin is not allowed', 'bot_gateway_origin_denied', 403);
  }
  const host = readSingleRawHeader(request, 'host');
  if (host !== `host.docker.internal:${port}`) {
    fail('Bot gateway Docker host is invalid', 'bot_gateway_origin_denied', 403);
  }
  if (FORBIDDEN_REQUEST_HEADERS.some((header) => request.headers[header] !== undefined)) {
    fail('Browser and forwarded requests are denied', 'bot_gateway_origin_denied', 403);
  }
};

const readBoundedJson = (request, limit) => new Promise((resolve, reject) => {
  const declared = Number(readSingleRawHeader(request, 'content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    reject(new BotGatewayHostError('Bot gateway body is too large', 'bot_gateway_body_too_large', 413));
    request.resume();
    return;
  }
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.byteLength;
    if (size > limit) {
      reject(new BotGatewayHostError('Bot gateway body is too large', 'bot_gateway_body_too_large', 413));
      request.destroy();
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  request.once('end', () => {
    if (size > limit) return;
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      reject(new BotGatewayHostError('Bot gateway body must be JSON'));
    }
  });
  request.once('error', reject);
});

const validateRequestBody = (body, claims) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join('\0') !== [
      'channelId',
      'operation',
      'payload',
      'revisionId',
      'runId',
    ].sort().join('\0')) {
    fail('Bot gateway body shape is invalid');
  }
  if (body.runId !== claims.runId || body.channelId !== claims.channelId
    || body.revisionId !== claims.revisionId) {
    fail('Bot gateway capability claims do not match', 'bot_gateway_scope_denied', 403);
  }
  if (!claims.operations.includes(body.operation)) {
    fail('Bot gateway operation is not allowed', 'bot_gateway_operation_denied', 403);
  }
  try {
    assertBotJsonValue(body.payload, 'Bot gateway payload');
  } catch {
    fail('Bot gateway payload is invalid');
  }
  return Object.freeze({ operation: body.operation, payload: body.payload });
};

const normalizeCapability = (input, now) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join('\0') !== [
      'botId',
      'channelId',
      'expiresAt',
      'kind',
      'operations',
      'revisionId',
      'runId',
      'scopeKey',
    ].sort().join('\0')) {
    fail('Bot gateway capability is invalid', 'bot_gateway_capability_invalid', 400);
  }
  const issuedAt = now();
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= issuedAt || input.expiresAt - issuedAt > MAX_CAPABILITY_TTL_MS
    || !['reasoning', 'computer'].includes(input.kind)
    || typeof input.scopeKey !== 'string' || !SCOPE_PATTERN.test(input.scopeKey)
    || !Array.isArray(input.operations) || input.operations.length < 1
    || input.operations.length > BOT_GATEWAY_OPERATIONS.length) {
    fail('Bot gateway capability is invalid', 'bot_gateway_capability_invalid', 400);
  }
  const operations = [...input.operations];
  if (new Set(operations).size !== operations.length
    || operations.some((operation) => !BOT_GATEWAY_OPERATIONS.includes(operation))) {
    fail('Bot gateway capability is invalid', 'bot_gateway_capability_invalid', 400);
  }
  return Object.freeze({
    botId: validateUuid(input.botId, 'botId'),
    runId: validateUuid(input.runId, 'runId'),
    channelId: validateUuid(input.channelId, 'channelId'),
    revisionId: validateUuid(input.revisionId, 'revisionId'),
    scopeKey: input.scopeKey,
    kind: input.kind,
    operations: Object.freeze(operations),
    issuedAt,
    expiresAt: input.expiresAt,
  });
};

const sendJson = (response, statusCode, payload, responseLimit) => {
  let body;
  try {
    assertBotJsonValue(payload, 'Bot gateway response');
    body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    statusCode = 500;
    body = Buffer.from('{"ok":false,"error":{"code":"bot_gateway_response_invalid","message":"Bot gateway response is invalid"}}\n');
  }
  if (body.byteLength > responseLimit) {
    statusCode = 502;
    body = Buffer.from('{"ok":false,"error":{"code":"bot_gateway_response_too_large","message":"Bot gateway response is too large"}}\n');
  }
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
};

const failurePayload = (error) => {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const code = typeof error?.code === 'string' ? error.code : 'bot_gateway_internal_error';
  return {
    statusCode,
    code,
    payload: {
      ok: false,
      error: {
        code: `DEVRYAN_BOT_${code.replace(/^bot_(?:gateway_)?/, '').replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`,
        message: statusCode >= 500 ? 'Bot gateway is temporarily unavailable' : error.message,
      },
    },
  };
};

export function createBotGatewayHost({
  handleOperation,
  handleOAuth = null,
  host = '127.0.0.1',
  port = 0,
  bodyLimit = DEFAULT_BODY_LIMIT,
  responseLimit = DEFAULT_RESPONSE_LIMIT,
  capabilityTtlMs = DEFAULT_CAPABILITY_TTL_MS,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  logger = console,
  shutdownTimeoutMs = 5_000,
  onBound = null,
} = {}) {
  if (typeof handleOperation !== 'function' || host !== '127.0.0.1'
    || (onBound !== null && typeof onBound !== 'function')
    || !Number.isInteger(port) || port < 0 || port > 65535
    || !Number.isInteger(bodyLimit) || bodyLimit < 1 || bodyLimit > 1024 * 1024
    || !Number.isInteger(responseLimit) || responseLimit < 1 || responseLimit > 4 * 1024 * 1024
    || !Number.isInteger(capabilityTtlMs) || capabilityTtlMs < 1
    || capabilityTtlMs > MAX_CAPABILITY_TTL_MS || typeof now !== 'function'
    || typeof randomBytes !== 'function' || !Number.isInteger(shutdownTimeoutMs)
    || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 60_000) {
    fail('Bot gateway host is misconfigured', 'bot_gateway_configuration_invalid', 500);
  }
  const capabilities = new Map();
  const digestsByRun = new Map();
  const sockets = new Set();
  let boundPort = null;
  let startPromise = null;
  let shutdownPromise = null;

  const server = http.createServer(async (request, response) => {
    let operation = 'unknown';
    try {
      if (request.method !== 'POST' || ![BOT_PRIVATE_GATEWAY_PATH, BOT_PRIVATE_OAUTH_PATH].includes(request.url)) {
        fail('Bot gateway route was not found', 'bot_gateway_not_found', 404);
      }
      assertDockerOrigin(request, boundPort);
      const contentType = readSingleRawHeader(request, 'content-type');
      if (typeof contentType !== 'string'
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
        fail('Bot gateway content type is invalid', 'bot_gateway_content_type_invalid', 415);
      }
      const token = readBearerToken(request);
      const digest = tokenDigest(token);
      const claims = capabilities.get(digest);
      if (!claims || claims.expiresAt <= now()) {
        capabilities.delete(digest);
        fail('Bot gateway authentication is required', 'bot_gateway_unauthorized', 401);
      }
      const body = await readBoundedJson(request, bodyLimit);
      if (request.url === BOT_PRIVATE_OAUTH_PATH) {
        if (!handleOAuth || claims.kind !== 'reasoning' || body?.protocol !== 1
          || !['ready', 'access'].includes(body?.operation)
          || Object.keys(body).sort().join(',') !== 'operation,protocol') {
          fail('Bot OAuth request is invalid', 'bot_oauth_access_denied', 403);
        }
        operation = body.operation;
        try {
          const result = await handleOAuth(claims, body.operation);
          if (capabilities.get(digest) !== claims || claims.expiresAt <= now()) {
            fail('Bot OAuth capability expired', 'bot_oauth_access_denied', 403);
          }
          sendJson(response, 200, result, 32 * 1024);
        } catch (error) {
          sendJson(response, error.statusCode || 503, { code: error.code || 'bot_oauth_coordinator_unavailable' }, 1024);
        }
        return;
      }
      const validatedOperation = validateRequestBody(body, claims);
      operation = validatedOperation.operation;
      const controller = new AbortController();
      request.once('aborted', () => controller.abort());
      const result = await handleOperation({
        claims,
        operation: validatedOperation.operation,
        payload: validatedOperation.payload,
        signal: controller.signal,
      });
      sendJson(response, 200, { ok: true, result }, responseLimit);
    } catch (error) {
      if (response.destroyed) return;
      const failure = failurePayload(error);
      logger?.warn?.('[BotsGateway] request rejected', {
        ...botErrorLogFields(error, 'bot_gateway_internal_error'),
        statusCode: failure.statusCode,
        operation,
      });
      sendJson(response, failure.statusCode, failure.payload, responseLimit);
    }
  });
  server.maxHeadersCount = 32;
  server.headersTimeout = 10_000;
  server.requestTimeout = 130_000;
  server.keepAliveTimeout = 5_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const revokeDigest = (digest) => {
    const claims = capabilities.get(digest);
    if (!claims) return false;
    capabilities.delete(digest);
    const runDigests = digestsByRun.get(claims.runId);
    runDigests?.delete(digest);
    if (runDigests?.size === 0) digestsByRun.delete(claims.runId);
    return true;
  };

  return Object.freeze({
    async start() {
      if (boundPort !== null) return;
      if (shutdownPromise) fail('Bot gateway host has shut down', 'bot_gateway_shutdown', 503);
      if (!startPromise) {
        // Persistent computer containers keep the gateway address they were
        // created with, so a deployment asks for the port it used last time
        // and only falls back to a fresh random port when that one is taken.
        const listen = (candidate) => new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            const address = server.address();
            if (!address || typeof address === 'string' || !isLoopbackAddress(address.address)) {
              reject(new BotGatewayHostError(
                'Bot gateway did not bind to loopback',
                'bot_gateway_bind_invalid',
                500,
              ));
              return;
            }
            boundPort = address.port;
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(candidate, host);
        });
        startPromise = listen(port)
          .catch((error) => {
            if (port === 0 || error?.code !== 'EADDRINUSE') throw error;
            logger.warn?.('[bots] gateway port in use; binding a fresh loopback port', { port });
            return listen(0);
          })
          .then(async () => {
            if (onBound) await onBound(boundPort);
          })
          .finally(() => {
            startPromise = null;
          });
      }
      await startPromise;
    },

    issueCapability(input) {
      if (boundPort === null || shutdownPromise) {
        fail('Bot gateway is not accepting capabilities', 'bot_gateway_unavailable', 503);
      }
      const claims = normalizeCapability({
        ...input,
        expiresAt: input?.expiresAt ?? now() + capabilityTtlMs,
      }, now);
      const tokenBytes = Buffer.from(randomBytes(32));
      if (tokenBytes.byteLength !== 32) {
        tokenBytes.fill(0);
        fail('Bot gateway token generator failed', 'bot_gateway_configuration_invalid', 500);
      }
      const token = tokenBytes.toString('base64url');
      tokenBytes.fill(0);
      const digest = tokenDigest(token);
      capabilities.set(digest, claims);
      const runDigests = digestsByRun.get(claims.runId) || new Set();
      runDigests.add(digest);
      digestsByRun.set(claims.runId, runDigests);
      return Object.freeze({
        token,
        expiresAt: claims.expiresAt,
        dockerGatewayUrl: `http://host.docker.internal:${boundPort}`,
      });
    },

    revokeCapability(token) {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
      return revokeDigest(tokenDigest(token));
    },

    revokeRun(runId) {
      const normalizedRunId = validateUuid(runId, 'runId');
      const digests = [...(digestsByRun.get(normalizedRunId) || [])];
      for (const digest of digests) revokeDigest(digest);
      return digests.length;
    },

    getAddress() {
      return boundPort === null ? null : Object.freeze({
        host: '127.0.0.1',
        port: boundPort,
        dockerGatewayUrl: `http://host.docker.internal:${boundPort}`,
      });
    },

    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      capabilities.clear();
      digestsByRun.clear();
      if (boundPort === null) return;
      shutdownPromise = (async () => {
        let timeout;
        try {
          await Promise.race([
            new Promise((resolve) => server.close(resolve)),
            new Promise((resolve) => {
              timeout = setTimeout(resolve, shutdownTimeoutMs);
              timeout.unref?.();
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
          server.closeIdleConnections?.();
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          boundPort = null;
        }
      })();
      return shutdownPromise;
    },
  });
}
