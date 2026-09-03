import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  EgressPolicyError,
  assertModelDestinationAllowed,
  assertPublicDestinationAllowed,
  parseConnectAuthority,
} from './connect-policy.js';
import {
  GatewayRelayError,
  createGatewayOriginRegistry,
  createGatewayRelayAgent,
  isGatewayRelayPath,
  relayGatewayRequest,
  sendGatewayRelayFailure,
} from './gateway-relay.js';
import {
  EgressTokenError,
  createRuntimeTokenAuthorizer,
  normalizeBrowserHosts,
  normalizeModelHosts,
} from './token.js';

const DEFAULT_PORT = 43121;
const CONTROL_BODY_LIMIT = 4 * 1024;
const CONTROL_ROUTES = Object.freeze([
  '/v1/revisions/activate',
  '/v1/revisions/deactivate',
  '/v1/gateway/origin',
]);
const CONNECT_TIMEOUT_MS = 10_000;
const CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

class EgressRequestError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'EgressRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code = 'bot_egress_request_invalid', statusCode = 400) => {
  throw new EgressRequestError(message, code, statusCode);
};

const readSingleRawHeader = (request, headerName) => {
  let value;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== headerName) continue;
    count += 1;
    value = request.rawHeaders[index + 1];
  }
  return count === 1 ? value : undefined;
};

const readProxyBearerToken = (request) => {
  const header = readSingleRawHeader(request, 'proxy-authorization');
  if (typeof header !== 'string' || header.length > 8200) {
    throw new EgressTokenError();
  }
  const bearer = /^Bearer ([^\s]+)$/.exec(header);
  if (bearer) return bearer[1];
  const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header);
  if (!basic) throw new EgressTokenError();
  let decoded;
  try {
    decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  } catch {
    throw new EgressTokenError();
  }
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.slice(0, separator) !== 'devryan' || !decoded.slice(separator + 1)) {
    throw new EgressTokenError();
  }
  return decoded.slice(separator + 1);
};

const readControlBearerToken = (request) => {
  const header = readSingleRawHeader(request, 'authorization');
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header) : null;
  if (!match) fail('Egress control authentication is required', 'bot_egress_control_unauthorized', 401);
  return match[1];
};

const tokensEqual = (left, right) => {
  const leftBytes = Buffer.from(left || '', 'ascii');
  const rightBytes = Buffer.from(right || '', 'ascii');
  return leftBytes.byteLength === rightBytes.byteLength
    && crypto.timingSafeEqual(leftBytes, rightBytes);
};

const readBoundedControlJson = (request) => new Promise((resolve, reject) => {
  const declared = Number(readSingleRawHeader(request, 'content-length'));
  if (Number.isFinite(declared) && declared > CONTROL_BODY_LIMIT) {
    reject(new EgressRequestError('Egress control body is too large', 'bot_egress_control_invalid', 413));
    request.resume();
    return;
  }
  const chunks = [];
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > CONTROL_BODY_LIMIT) {
      reject(new EgressRequestError('Egress control body is too large', 'bot_egress_control_invalid', 413));
      request.destroy();
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  request.once('end', () => {
    if (bytes > CONTROL_BODY_LIMIT) return;
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      reject(new EgressRequestError('Egress control body must be JSON', 'bot_egress_control_invalid', 400));
    }
  });
  request.once('error', reject);
});

const validateGatewayOriginControlBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).join('\0') !== 'origin' || typeof body.origin !== 'string') {
    fail('Egress gateway origin request is invalid', 'bot_egress_control_invalid', 400);
  }
  return body.origin;
};

const validateRevisionControlBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join('\0') !== 'botId\0revisionId'
    || !ID_PATTERN.test(body.botId) || !ID_PATTERN.test(body.revisionId)) {
    fail('Egress revision control request is invalid', 'bot_egress_control_invalid', 400);
  }
  return Object.freeze({ botId: body.botId, revisionId: body.revisionId });
};

const sendControlJson = (response, statusCode, payload) => {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  });
  response.end(body);
};

export function createActiveRevisionRegistry({ initialRevisionIds = [] } = {}) {
  if (!Array.isArray(initialRevisionIds) || initialRevisionIds.some((value) => !ID_PATTERN.test(value))) {
    throw new TypeError('Active revision registry input is invalid');
  }
  const legacyActive = new Set(initialRevisionIds);
  const revisionByBot = new Map();
  return Object.freeze({
    activate({ botId, revisionId }) {
      const normalized = validateRevisionControlBody({ botId, revisionId });
      revisionByBot.set(normalized.botId, normalized.revisionId);
      return normalized;
    },
    deactivate({ botId, revisionId }) {
      const normalized = validateRevisionControlBody({ botId, revisionId });
      if (revisionByBot.get(normalized.botId) !== normalized.revisionId) return false;
      revisionByBot.delete(normalized.botId);
      return true;
    },
    isActive(revisionId, botId) {
      return legacyActive.has(revisionId) || revisionByBot.get(botId) === revisionId;
    },
  });
}

const validateCapability = (capability, now = Date.now()) => {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)
    || ![
      'active\0botId\0expiresAt\0hosts\0revisionId',
      'active\0botId\0expiresAt\0hosts\0purpose\0revisionId',
      'active\0botId\0expiresAt\0hosts\0networkMode\0purpose\0revisionId',
    ].includes(Object.keys(capability).sort().join('\0'))
    || capability.active !== true || typeof capability.botId !== 'string'
    || typeof capability.revisionId !== 'string'
    || !Number.isSafeInteger(capability.expiresAt) || capability.expiresAt <= now) {
    throw new EgressTokenError('Model egress revision is not active', 'bot_egress_revision_inactive');
  }
  const purpose = capability.purpose || 'model';
  if (!['model', 'agent', 'browser'].includes(purpose)) {
    throw new EgressTokenError('Egress token purpose is invalid');
  }
  const publicOnlyBrowser = purpose === 'browser' && capability.networkMode === 'public_only';
  const hosts = publicOnlyBrowser && Array.isArray(capability.hosts) && capability.hosts.length === 0
    ? Object.freeze([])
    : purpose === 'browser'
      ? normalizeBrowserHosts(capability.hosts)
      : normalizeModelHosts(capability.hosts);
  if (hosts.join('\0') !== capability.hosts.join('\0')
    || (purpose === 'browser' && !['public_only', 'allowlist'].includes(capability.networkMode))
    || (purpose === 'browser' && capability.networkMode === 'public_only' && hosts.length !== 0)
    || (purpose === 'browser' && capability.networkMode === 'allowlist' && hosts.length === 0)
    || (purpose !== 'browser' && Object.hasOwn(capability, 'networkMode'))) {
    throw new EgressTokenError('Egress capability is not normalized');
  }
  return Object.freeze({ ...capability, purpose, hosts });
};

const authorizeDestination = async ({ request, hostname, port, authorizeToken, lookup, now }) => {
  const token = readProxyBearerToken(request);
  let capability;
  try {
    capability = validateCapability(await authorizeToken(token), now());
  } catch (error) {
    if (error instanceof EgressTokenError) throw error;
    throw new EgressTokenError('Model egress authorization is unavailable', 'bot_egress_revision_unavailable');
  }
  const destination = capability.purpose === 'browser' && capability.networkMode === 'public_only'
    ? await assertPublicDestinationAllowed({ hostname, port, lookup })
    : await assertModelDestinationAllowed({
        hostname,
        port,
        allowedHosts: capability.hosts,
        lookup,
      });
  return Object.freeze({ capability, destination });
};

const connectionNamedHeaders = (headers) => {
  const raw = headers.connection;
  if (typeof raw !== 'string') return new Set();
  return new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
};

const filteredRequestHeaders = (headers, host) => {
  const connectionHeaders = connectionNamedHeaders(headers);
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionHeaders.has(lower) || value === undefined) continue;
    filtered[lower] = value;
  }
  filtered.host = host;
  return filtered;
};

const filteredResponseHeaders = (headers) => {
  const connectionHeaders = connectionNamedHeaders(headers);
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) => (
    value !== undefined && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())
      && !connectionHeaders.has(key.toLowerCase())
  )));
};

const defaultForwardHttp = ({ request, response, target, destination }) => new Promise((resolve, reject) => {
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request({
    hostname: destination.address,
    family: destination.family,
    port: destination.port,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers: filteredRequestHeaders(request.headers, target.host),
    servername: net.isIP(destination.hostname) ? undefined : destination.hostname,
    timeout: CONNECT_TIMEOUT_MS,
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode || 502,
      filteredResponseHeaders(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
    upstreamResponse.once('end', resolve);
    upstreamResponse.once('error', reject);
  });
  upstream.once('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.once('error', reject);
  request.once('aborted', () => upstream.destroy());
  request.pipe(upstream);
});

const defaultOpenTunnel = (destination) => new Promise((resolve, reject) => {
  const socket = net.connect({
    host: destination.address,
    port: destination.port,
    family: destination.family,
  });
  socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error('upstream timeout')));
  socket.once('error', reject);
  socket.once('connect', () => {
    socket.removeListener('error', reject);
    socket.setTimeout(0);
    resolve(socket);
  });
});

const parseHttpTarget = (request) => {
  if (request.method === 'CONNECT') fail('CONNECT must use the tunnel endpoint');
  let target;
  try {
    target = new URL(request.url);
  } catch {
    fail('Proxy requests require an absolute HTTP URL');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || target.hash || !target.hostname) {
    fail('Proxy target is invalid');
  }
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Proxy target port is invalid');
  return Object.freeze({ target, hostname: target.hostname, port });
};

const httpFailure = (error) => {
  if (error instanceof EgressTokenError) {
    return { statusCode: 407, code: error.code, message: 'Proxy authentication required' };
  }
  if (error instanceof EgressPolicyError || error instanceof EgressRequestError
    || error instanceof GatewayRelayError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  return { statusCode: 502, code: 'bot_egress_upstream_failed', message: 'Model upstream failed' };
};

const sendHttpFailure = (response, error) => {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const failure = httpFailure(error);
  const body = Buffer.from(`${JSON.stringify({
    ok: false,
    error: { code: failure.code, message: failure.message },
  })}\n`, 'utf8');
  response.writeHead(failure.statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    ...(failure.statusCode === 407
      ? { 'proxy-authenticate': 'Bearer realm="devryan-model-egress"' }
      : {}),
  });
  response.end(body);
};

const sendConnectFailure = (socket, error) => {
  if (socket.destroyed) return;
  const failure = httpFailure(error);
  const reason = failure.statusCode === 407
    ? 'Proxy Authentication Required'
    : failure.statusCode === 403
      ? 'Forbidden'
      : failure.statusCode === 400
        ? 'Bad Request'
        : 'Bad Gateway';
  const authenticate = failure.statusCode === 407
    ? 'Proxy-Authenticate: Bearer realm="devryan-model-egress"\r\n'
    : '';
  socket.end(`HTTP/1.1 ${failure.statusCode} ${reason}\r\n${authenticate}Connection: close\r\nContent-Length: 0\r\n\r\n`);
};

export function createModelEgressProxyServer({
  authorizeToken,
  controlToken = null,
  revisionRegistry = null,
  gatewayOriginRegistry = null,
  gatewayRelayAgent = createGatewayRelayAgent(),
  connectGateway = undefined,
  lookup,
  forwardHttp = defaultForwardHttp,
  openTunnel = defaultOpenTunnel,
  now = Date.now,
} = {}) {
  if (typeof authorizeToken !== 'function' || typeof forwardHttp !== 'function'
    || typeof openTunnel !== 'function' || typeof now !== 'function') {
    throw new TypeError('Model egress proxy dependencies are invalid');
  }
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{"ok":true}\n');
      return;
    }
    if (CONTROL_ROUTES.includes(request.url)) {
      try {
        const gatewayRoute = request.url === '/v1/gateway/origin';
        if (!CONTROL_TOKEN_PATTERN.test(controlToken || '')
          || (gatewayRoute
            ? typeof gatewayOriginRegistry?.set !== 'function'
            : (!revisionRegistry || typeof revisionRegistry.activate !== 'function'
              || typeof revisionRegistry.deactivate !== 'function'))) {
          fail('Egress revision control is unavailable', 'bot_egress_control_unavailable', 503);
        }
        if (request.method !== 'POST') {
          fail('Egress revision control method is invalid', 'bot_egress_control_invalid', 405);
        }
        if (!tokensEqual(readControlBearerToken(request), controlToken)) {
          fail('Egress control authentication is required', 'bot_egress_control_unauthorized', 401);
        }
        const contentType = readSingleRawHeader(request, 'content-type');
        if (contentType !== 'application/json') {
          fail('Egress revision control content type is invalid', 'bot_egress_control_invalid', 415);
        }
        const body = await readBoundedControlJson(request);
        if (gatewayRoute) {
          const origin = gatewayOriginRegistry.set(validateGatewayOriginControlBody(body));
          sendControlJson(response, 200, { ok: true, result: { origin } });
          return;
        }
        const input = validateRevisionControlBody(body);
        const activated = request.url.endsWith('/activate');
        const result = activated
          ? revisionRegistry.activate(input)
          : revisionRegistry.deactivate(input);
        sendControlJson(response, 200, { ok: true, result });
      } catch (error) {
        const failure = httpFailure(error);
        sendControlJson(response, failure.statusCode, {
          ok: false,
          error: { code: failure.code, message: failure.message },
        });
      }
      return;
    }
    if (isGatewayRelayPath(request.url)) {
      try {
        await relayGatewayRequest({
          request,
          response,
          originRegistry: gatewayOriginRegistry,
          agent: gatewayRelayAgent,
          ...(connectGateway ? { connect: connectGateway } : {}),
        });
      } catch (error) {
        sendGatewayRelayFailure(response, error);
      }
      return;
    }
    try {
      const { target, hostname, port } = parseHttpTarget(request);
      const { destination } = await authorizeDestination({
        request,
        hostname,
        port,
        authorizeToken,
        lookup,
        now,
      });
      await forwardHttp({ request, response, target, destination });
    } catch (error) {
      sendHttpFailure(response, error);
    }
  });

  server.on('connect', async (request, clientSocket, head) => {
    try {
      const { hostname, port } = parseConnectAuthority(request.url);
      const { destination } = await authorizeDestination({
        request,
        hostname,
        port,
        authorizeToken,
        lookup,
        now,
      });
      const upstream = await openTunnel(destination);
      if (!upstream || typeof upstream.pipe !== 'function') {
        throw new Error('Tunnel transport is invalid');
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.byteLength > 0) upstream.write(head);
      clientSocket.once('error', () => upstream.destroy());
      upstream.once('error', () => clientSocket.destroy());
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    } catch (error) {
      sendConnectFailure(clientSocket, error);
    }
  });

  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function startModelEgressProxy({
  authorizeToken,
  controlToken = null,
  revisionRegistry = null,
  gatewayOriginRegistry = null,
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  lookup,
} = {}) {
  const server = createModelEgressProxyServer({
    authorizeToken,
    controlToken,
    revisionRegistry,
    gatewayOriginRegistry,
    lookup,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return Object.freeze({
    server,
    address: server.address(),
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const activeRevisions = new Set(
    String(process.env.DEVRYAN_BOT_ACTIVE_REVISIONS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const revisionRegistry = createActiveRevisionRegistry({
    initialRevisionIds: [...activeRevisions],
  });
  const authorizeToken = createRuntimeTokenAuthorizer({
    secret: process.env.DEVRYAN_BOT_EGRESS_SIGNING_KEY,
    deploymentId: process.env.DEVRYAN_BOT_DEPLOYMENT_ID,
    isRevisionActive: async (revisionId, botId) => revisionRegistry.isActive(revisionId, botId),
  });
  // The host gateway address normally arrives on the control channel before a
  // container needs it; the optional seed only serves controlled integration
  // environments that never run the Electron control plane.
  const gatewayOriginRegistry = createGatewayOriginRegistry({
    initialOrigin: process.env.DEVRYAN_BOT_GATEWAY_ORIGIN || null,
  });
  startModelEgressProxy({
    authorizeToken,
    controlToken: process.env.DEVRYAN_BOT_EGRESS_CONTROL_TOKEN,
    revisionRegistry,
    gatewayOriginRegistry,
    port: Number(process.env.DEVRYAN_BOT_EGRESS_PORT || DEFAULT_PORT),
  }).then(({ address }) => {
    const boundPort = typeof address === 'object' && address ? address.port : DEFAULT_PORT;
    console.log(`[bot-egress] listening on port ${boundPort}`);
  }).catch((error) => {
    console.error(`[bot-egress] startup failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
  });
}
