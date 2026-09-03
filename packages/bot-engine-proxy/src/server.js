import crypto from 'node:crypto';
import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  BotDockerError,
  createBotDockerSupervisor,
  createDockerSocketClient,
} from '../../bot-supervisor/src/docker.js';

const DEFAULT_PORT = 43124;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SMALL_BODY_LIMIT = 64 * 1024;
const SHARED_BODY_LIMIT = 36 * 1024 * 1024;
const ROUTES = Object.freeze({
  'POST /v1/ensure/reasoning': 'ensureReasoning',
  'POST /v1/ensure/computer': 'ensureComputer',
  'POST /v1/status': 'status',
  'POST /v1/stop': 'stop',
  'POST /v1/reset': 'reset',
  'POST /v1/workspace/write': 'writeWorkspace',
  'POST /v1/shared/import': 'importSharedFile',
  'POST /v1/workspace/export-image': 'exportWorkspaceImage',
  'POST /v1/workspace/list': 'listWorkspace',
  'POST /v1/filesystem/list': 'listFilesystem',
});

class EngineProxyRequestError extends Error {
  constructor(message, code = 'bot_engine_proxy_request_invalid', statusCode = 400) {
    super(message);
    this.name = 'EngineProxyRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new EngineProxyRequestError(message, code, statusCode);
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

const equalToken = (left, right) => {
  const leftBytes = Buffer.from(left || '', 'ascii');
  const rightBytes = Buffer.from(right || '', 'ascii');
  return leftBytes.byteLength === rightBytes.byteLength
    && crypto.timingSafeEqual(leftBytes, rightBytes);
};

const authenticate = (request, token) => {
  const authorization = singleHeader(request, 'authorization');
  const match = typeof authorization === 'string'
    ? /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization)
    : null;
  if (!match || !equalToken(match[1], token)) {
    fail('Engine proxy authentication is required', 'bot_engine_proxy_unauthorized', 401);
  }
  if (singleHeader(request, 'x-devryan-engine-proxy-version') !== '1') {
    fail('Engine proxy protocol version is unsupported', 'bot_engine_proxy_version_invalid', 409);
  }
};

const routeKey = (request) => {
  if (typeof request.url !== 'string' || request.url.length > 128
    || /[%\\\u0000-\u001f\u007f]/u.test(request.url)) {
    fail('Engine proxy request target is invalid');
  }
  let url;
  try {
    url = new URL(request.url, 'http://engine-proxy.invalid');
  } catch {
    fail('Engine proxy request target is invalid');
  }
  if (url.search || url.hash || url.pathname !== request.url) {
    fail('Engine proxy query parameters are not supported');
  }
  return `${request.method} ${url.pathname}`;
};

const readJson = async (request, maximumBytes) => {
  if (request.headers.upgrade || /\bupgrade\b/iu.test(request.headers.connection || '')
    || request.headers['transfer-encoding']) {
    fail('Engine proxy transport is unsupported', 'bot_engine_proxy_transport_invalid', 400);
  }
  const contentType = singleHeader(request, 'content-type');
  const contentLength = singleHeader(request, 'content-length');
  if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
    || !/^\d+$/u.test(contentLength || '')) {
    fail('Engine proxy requires bounded JSON', 'bot_engine_proxy_content_invalid', 415);
  }
  const declared = Number(contentLength);
  if (!Number.isSafeInteger(declared) || declared < 2 || declared > maximumBytes) {
    fail('Engine proxy request is too large', 'bot_engine_proxy_request_too_large', 413);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > maximumBytes || total > declared) {
      fail('Engine proxy request is too large', 'bot_engine_proxy_request_too_large', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  if (total !== declared) fail('Engine proxy body length is invalid');
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('Engine proxy body is invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Engine proxy JSON object is required');
  }
  return value;
};

const sendJson = (response, statusCode, payload, headers = {}) => {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    ...headers,
  });
  response.end(body);
};

const failureFor = (error) => {
  if (error instanceof BotDockerError || error instanceof EngineProxyRequestError) {
    return {
      statusCode: error.statusCode || 500,
      code: error.code,
      message: error.message,
    };
  }
  return {
    statusCode: 500,
    code: 'bot_engine_proxy_internal_error',
    message: 'Bot engine proxy request failed',
  };
};

export function createEngineProxyHttpServer({ token, supervisor } = {}) {
  if (!TOKEN_PATTERN.test(token || '') || !supervisor
    || typeof supervisor.ensureReasoning !== 'function'
    || typeof supervisor.listOwned !== 'function') {
    throw new TypeError('Bot engine proxy service is misconfigured');
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }
      authenticate(request, token);
      const route = routeKey(request);
      if (route === 'GET /v1/owned') {
        if (request.headers['content-length'] || request.headers['transfer-encoding']) {
          fail('Engine proxy GET body is unsupported');
        }
        sendJson(response, 200, { ok: true, containers: await supervisor.listOwned() });
        return;
      }
      const operation = ROUTES[route];
      if (!operation) fail('Engine proxy operation was not found', 'bot_engine_proxy_not_found', 404);
      const body = await readJson(
        request,
        route === 'POST /v1/shared/import' ? SHARED_BODY_LIMIT : SMALL_BODY_LIMIT,
      );
      const result = await supervisor[operation](body);
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      const failure = failureFor(error);
      sendJson(response, failure.statusCode, {
        ok: false,
        error: { code: failure.code, message: failure.message },
      }, failure.statusCode === 401
        ? { 'www-authenticate': 'Bearer realm="devryan-bot-engine-proxy"' }
        : {});
    }
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.maxHeadersCount = 48;
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function startEngineProxyService({
  token,
  deploymentId,
  images,
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  docker = createDockerSocketClient(),
  reasoningNetwork,
  computerNetwork,
  egressProxyUrl,
  runtimeRoot,
} = {}) {
  const supervisor = createBotDockerSupervisor({
    docker,
    deploymentId,
    images,
    reasoningNetwork,
    computerNetwork,
    egressProxyUrl,
    runtimeRoot,
  });
  await docker.ping();
  const server = createEngineProxyHttpServer({ token, supervisor });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return Object.freeze({
    server,
    supervisor,
    address: server.address(),
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startEngineProxyService({
    token: process.env.DEVRYAN_BOT_ENGINE_PROXY_TOKEN,
    deploymentId: process.env.DEVRYAN_BOT_DEPLOYMENT_ID,
    images: {
      reasoning: process.env.DEVRYAN_BOT_OPENCODE_IMAGE,
      computer: process.env.DEVRYAN_BOT_COMPUTER_IMAGE,
    },
    port: Number(process.env.DEVRYAN_BOT_ENGINE_PROXY_PORT || DEFAULT_PORT),
    reasoningNetwork: process.env.DEVRYAN_BOT_REASONING_NETWORK,
    computerNetwork: process.env.DEVRYAN_BOT_COMPUTER_NETWORK,
    egressProxyUrl: process.env.DEVRYAN_MODEL_EGRESS_URL,
    runtimeRoot: process.env.DEVRYAN_BOT_HOST_RUNTIME_ROOT,
  }).then(({ address }) => {
    const boundPort = typeof address === 'object' && address ? address.port : DEFAULT_PORT;
    console.log(`[bot-engine-proxy] listening on port ${boundPort}`);
  }).catch((error) => {
    console.error(`[bot-engine-proxy] startup failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
  });
}
