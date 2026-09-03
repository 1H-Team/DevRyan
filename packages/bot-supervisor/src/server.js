import crypto from 'node:crypto';
import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createSupervisorAuthenticator, SupervisorAuthError } from './auth.js';
import {
  BotDockerError,
  createBotDockerSupervisor,
  createDockerSocketClient,
} from './docker.js';
import { createBotEngineProxyClient } from './engine-proxy-client.js';

const DEFAULT_PORT = 43120;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SHARED_IMPORT_BODY_BYTES = 36 * 1024 * 1024;
const MAX_RUNTIME_PROXY_BODY_BYTES = 4 * 1024 * 1024;
const RUNTIME_PROXY_PREFIX = '/v1/runtime/';
const RUNTIME_PROXY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUNTIME_CONTAINER_PORTS = Object.freeze({
  reasoning: Object.freeze({ pattern: /^devryan-bot-reasoning-[0-9a-f]{24}$/, port: 4096 }),
  computer: Object.freeze({ pattern: /^devryan-bot-computer-[0-9a-f]{24}$/, port: 43122 }),
});
const RUNTIME_PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// The reasoning runtime has no authentication of its own, so the scoped proxy
// capability is the whole authority and no caller credential may reach it. The
// computer authenticates every call itself, so its own two credentials are the
// only extra headers that cross.
const RUNTIME_PROXY_REQUEST_HEADERS = Object.freeze({
  reasoning: new Set([
    'accept',
    'accept-encoding',
    'content-type',
    'last-event-id',
    'user-agent',
    'x-opencode-directory',
    'x-opencode-workspace',
  ]),
  computer: new Set([
    'accept',
    'accept-encoding',
    'authorization',
    'content-type',
    'last-event-id',
    'user-agent',
    'x-devryan-gateway-token',
  ]),
});
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

class SupervisorRequestError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'SupervisorRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const requestFail = (message, code = 'bot_supervisor_request_invalid', statusCode = 400) => {
  throw new SupervisorRequestError(message, code, statusCode);
};

const sendJson = (response, statusCode, body, extraHeaders = {}) => {
  if (response.headersSent) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    ...extraHeaders,
  });
  response.end(payload);
};

const readSingleHeader = (request, name) => {
  let value;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== name) continue;
    count += 1;
    value = request.rawHeaders[index + 1];
  }
  if (count !== 1) return undefined;
  return value;
};

const readJsonBody = async (request, maximumBytes = MAX_BODY_BYTES) => {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    requestFail('Content-Type must be application/json', 'bot_supervisor_content_type_invalid', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maximumBytes) {
      requestFail('Request body is too large', 'bot_supervisor_request_too_large', 413);
    }
    chunks.push(chunk);
  }
  if (size === 0) requestFail('Request body is required');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) requestFail('JSON object required');
    return value;
  } catch (error) {
    if (error instanceof SupervisorRequestError) throw error;
    requestFail('Request body is invalid JSON');
  }
};

const readRuntimeProxyBody = async (request) => {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_RUNTIME_PROXY_BODY_BYTES) {
    requestFail('Runtime request body is too large', 'bot_supervisor_runtime_request_too_large', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_RUNTIME_PROXY_BODY_BYTES) {
      requestFail('Runtime request body is too large', 'bot_supervisor_runtime_request_too_large', 413);
    }
    chunks.push(chunk);
  }
  return chunks.length === 0 ? null : Buffer.concat(chunks);
};

const runtimeProxyRoute = (request) => {
  let url;
  try {
    url = new URL(request.url, 'http://supervisor.invalid');
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(RUNTIME_PROXY_PREFIX)) return null;
  const remainder = url.pathname.slice(RUNTIME_PROXY_PREFIX.length);
  const separator = remainder.indexOf('/');
  if (separator < 1) return Object.freeze({ invalid: true });
  const proxyToken = remainder.slice(0, separator);
  if (!RUNTIME_PROXY_TOKEN_PATTERN.test(proxyToken)) return Object.freeze({ invalid: true });
  return Object.freeze({
    invalid: false,
    proxyToken,
    upstreamPath: `${remainder.slice(separator)}${url.search}`,
  });
};

const proxyRequestHeaders = (request, target) => {
  const allowed = RUNTIME_PROXY_REQUEST_HEADERS[target.kind];
  if (!allowed) requestFail('Scoped Bot runtime kind is invalid', 'bot_supervisor_internal_error', 500);
  const headers = { host: `${target.host}:${target.port}` };
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (!allowed.has(normalized) || value === undefined) continue;
    headers[normalized] = value;
  }
  return headers;
};

const proxyResponseHeaders = (headers = {}) => {
  const safe = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === 'set-cookie' || value === undefined) continue;
    safe[normalized] = value;
  }
  return safe;
};

const forwardRuntimeRequest = async ({ request, response, target, upstreamPath }) => {
  if (!RUNTIME_PROXY_METHODS.has(request.method)) {
    requestFail('Runtime request method is unsupported', 'bot_supervisor_runtime_method_invalid', 405);
  }
  const body = await readRuntimeProxyBody(request);
  await new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const upstream = http.request({
      hostname: target.host,
      port: target.port,
      method: request.method,
      path: upstreamPath,
      headers: proxyRequestHeaders(request, target),
    }, (upstreamResponse) => {
      upstream.setTimeout(0);
      response.writeHead(
        upstreamResponse.statusCode || 502,
        proxyResponseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.on('error', () => {
        response.destroy();
        settle();
      });
      upstreamResponse.on('end', settle);
      upstreamResponse.pipe(response);
    });
    // The inactivity bound guards a runtime that never answers. Once the
    // response is streaming it is dropped: a screencast of an idle page sends
    // no frames for minutes and must not be torn down for it. The client's
    // abort signal and the response close handler still end the stream.
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.on('error', () => {
      if (!response.headersSent) {
        sendJson(response, 502, {
          ok: false,
          error: {
            code: 'bot_supervisor_runtime_unavailable',
            message: 'Scoped Bot runtime is unavailable',
          },
        });
      } else {
        response.destroy();
      }
      settle();
    });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy();
    });
    upstream.end(body || undefined);
  });
};

const routeKey = (request) => {
  let url;
  try {
    url = new URL(request.url, 'http://supervisor.invalid');
  } catch {
    requestFail('Request target is invalid');
  }
  if (url.search || url.hash) requestFail('Query parameters are not supported');
  return `${request.method} ${url.pathname}`;
};

const errorResponse = (error) => {
  if (error instanceof SupervisorAuthError) {
    return {
      statusCode: 401,
      code: error.code,
      message: 'Authentication required',
      headers: { 'www-authenticate': 'Bearer realm="devryan-bot-supervisor"' },
    };
  }
  if (error instanceof BotDockerError || error instanceof SupervisorRequestError) {
    return {
      statusCode: error.statusCode || 500,
      code: error.code,
      message: error.message,
      headers: {},
    };
  }
  return {
    statusCode: 500,
    code: 'bot_supervisor_internal_error',
    message: 'Bot supervisor request failed',
    headers: {},
  };
};

export function createSupervisorHttpServer({
  token,
  supervisor,
  resolveRuntimeProxyTarget = (target) => target,
} = {}) {
  if (!supervisor || typeof supervisor.ensureReasoning !== 'function') {
    throw new TypeError('A Bot Docker supervisor is required');
  }
  if (typeof resolveRuntimeProxyTarget !== 'function') {
    throw new TypeError('A Bot runtime proxy target resolver is required');
  }
  const authenticate = createSupervisorAuthenticator({ token });
  const runtimeProxyTargets = new Map();
  const runtimeProxyTokensByContainer = new Map();

  const revokeRuntimeProxy = (containerName) => {
    const proxyToken = runtimeProxyTokensByContainer.get(containerName);
    if (!proxyToken) return;
    runtimeProxyTokensByContainer.delete(containerName);
    runtimeProxyTargets.delete(proxyToken);
  };

  // Neither runtime container publishes a host port, so both are reached only
  // through this proxy: the supervisor shares their internal networks and holds
  // the one loopback port Electron can call.
  const exposeRuntimeProxy = (result, { rotate = false } = {}) => {
    const expected = RUNTIME_CONTAINER_PORTS[result?.kind];
    if (!expected || result.state !== 'running') return result;
    const target = result.endpoint;
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || Object.keys(target).sort().join('\0') !== 'host\0port'
      || !expected.pattern.test(target.host)
      || target.host !== result.name || target.port !== expected.port) {
      requestFail('Scoped Bot runtime endpoint is invalid', 'bot_supervisor_internal_error', 500);
    }
    const existingToken = runtimeProxyTokensByContainer.get(result.name);
    const proxyToken = !rotate && existingToken
      ? existingToken
      : crypto.randomBytes(32).toString('base64url');
    if (existingToken && existingToken !== proxyToken) runtimeProxyTargets.delete(existingToken);
    runtimeProxyTokensByContainer.set(result.name, proxyToken);
    runtimeProxyTargets.set(proxyToken, Object.freeze({ ...target, kind: result.kind }));
    return Object.freeze({
      ...result,
      endpoint: Object.freeze({ proxyToken }),
    });
  };

  const server = http.createServer(async (request, response) => {
    try {
      const proxyRoute = runtimeProxyRoute(request);
      if (proxyRoute) {
        const target = proxyRoute.invalid ? null : runtimeProxyTargets.get(proxyRoute.proxyToken);
        if (!target) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: 'bot_supervisor_runtime_not_found',
              message: 'Scoped Bot runtime was not found',
            },
          });
          return;
        }
        await forwardRuntimeRequest({
          request,
          response,
          target: { ...resolveRuntimeProxyTarget(target), kind: target.kind },
          upstreamPath: proxyRoute.upstreamPath,
        });
        return;
      }
      const route = routeKey(request);
      if (route === 'GET /healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }
      authenticate(readSingleHeader(request, 'authorization'));
      if (route === 'GET /v1/owned') {
        sendJson(response, 200, { ok: true, containers: await supervisor.listOwned() });
        return;
      }
      const operations = {
        'POST /v1/ensure/reasoning': (body) => supervisor.ensureReasoning(body),
        'POST /v1/ensure/computer': (body) => supervisor.ensureComputer(body),
        'POST /v1/status': (body) => supervisor.status(body),
        'POST /v1/stop': (body) => supervisor.stop(body),
        'POST /v1/reset': (body) => supervisor.reset(body),
        'POST /v1/workspace/write': (body) => supervisor.writeWorkspace(body),
        'POST /v1/shared/import': (body) => supervisor.importSharedFile(body),
        'POST /v1/workspace/export-image': (body) => supervisor.exportWorkspaceImage(body),
        'POST /v1/workspace/list': (body) => supervisor.listWorkspace(body),
        'POST /v1/filesystem/list': (body) => supervisor.listFilesystem(body),
      };
      const operation = operations[route];
      if (!operation) requestFail('Supervisor command was not found', 'bot_supervisor_command_not_found', 404);
      const body = await readJsonBody(
        request,
        route === 'POST /v1/shared/import' ? MAX_SHARED_IMPORT_BODY_BYTES : MAX_BODY_BYTES,
      );
      let result = await operation(body);
      if (route === 'POST /v1/ensure/reasoning' || route === 'POST /v1/ensure/computer') {
        result = exposeRuntimeProxy(result, { rotate: result?.replaced === true });
      } else if (route === 'POST /v1/status') {
        result = exposeRuntimeProxy(result);
      } else if ((route === 'POST /v1/stop' || route === 'POST /v1/reset')
        && typeof result?.name === 'string') {
        revokeRuntimeProxy(result.name);
      }
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      const failure = errorResponse(error);
      sendJson(response, failure.statusCode, {
        ok: false,
        error: { code: failure.code, message: failure.message },
      }, failure.headers);
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function startSupervisorService({
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
  engineProxyUrl = null,
  engineProxyToken = null,
} = {}) {
  const supervisor = engineProxyUrl
    ? createBotEngineProxyClient({ endpoint: engineProxyUrl, token: engineProxyToken })
    : createBotDockerSupervisor({
        docker,
        deploymentId,
        images,
        reasoningNetwork,
        computerNetwork,
        egressProxyUrl,
        runtimeRoot,
      });
  const server = createSupervisorHttpServer({ token, supervisor });
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
  const port = Number(process.env.DEVRYAN_BOT_SUPERVISOR_PORT || DEFAULT_PORT);
  startSupervisorService({
    token: process.env.DEVRYAN_BOT_SUPERVISOR_TOKEN,
    deploymentId: process.env.DEVRYAN_BOT_DEPLOYMENT_ID,
    images: {
      reasoning: process.env.DEVRYAN_BOT_OPENCODE_IMAGE,
      computer: process.env.DEVRYAN_BOT_COMPUTER_IMAGE,
    },
    port,
    reasoningNetwork: process.env.DEVRYAN_BOT_REASONING_NETWORK,
    computerNetwork: process.env.DEVRYAN_BOT_COMPUTER_NETWORK,
    egressProxyUrl: process.env.DEVRYAN_MODEL_EGRESS_URL,
    runtimeRoot: process.env.DEVRYAN_BOT_HOST_RUNTIME_ROOT,
    engineProxyUrl: process.env.DEVRYAN_BOT_ENGINE_PROXY_URL,
    engineProxyToken: process.env.DEVRYAN_BOT_ENGINE_PROXY_TOKEN,
  }).then(({ address }) => {
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[bot-supervisor] listening on port ${boundPort}`);
  }).catch((error) => {
    console.error(`[bot-supervisor] startup failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
  });
}
