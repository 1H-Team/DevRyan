import http from 'node:http';

// Reasoning and computer containers join internal networks only, so they cannot
// open a socket to the host at all. They reach the authenticated private
// gateway through this relay, which is the one service already bridged to the
// host. The host origin arrives on the separately authenticated control channel
// and is never accepted from a relayed request: a compromised container can
// therefore reach the gateway the deployment pinned and nothing else on the
// host loopback.
const GATEWAY_ORIGIN_HOSTNAME = 'host.docker.internal';

// The gateway host caps a JSON body at 1 MiB and a JSON response at 4 MiB; the
// computer stages scratch files up to 64 MiB. The relay must never be the
// narrower limit, so it mirrors those maxima per route.
const JSON_REQUEST_LIMIT = 1024 * 1024;
const JSON_RESPONSE_LIMIT = 4 * 1024 * 1024;
const ARTIFACT_LIMIT = 64 * 1024 * 1024;
// The gateway holds a request for at most 130 s; the relay must outlive that so
// a slow human-facing operation fails at the gateway with its own error.
const UPSTREAM_TIMEOUT_MS = 140_000;
const CAPABILITY_PATTERN = /^Bearer [A-Za-z0-9_-]{43}$/;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const OCTET_CONTENT_TYPE_PATTERN = /^application\/octet-stream$/i;
const ARTIFACT_CONTENT_PATTERN = /^\/api\/bots\/private\/artifacts\/[A-Za-z0-9%][A-Za-z0-9._:%-]{0,255}\/content$/;
const FILENAME_PATTERN = /^[^\u0000-\u001f\u007f/\\]{1,255}$/u;
const FORWARDED_RESPONSE_HEADERS = Object.freeze([
  'cache-control',
  'content-type',
  'x-content-type-options',
  'x-devryan-filename',
]);

export class GatewayRelayError extends Error {
  constructor(message, code = 'bot_egress_gateway_request_invalid', statusCode = 400) {
    super(message);
    this.name = 'GatewayRelayError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new GatewayRelayError(message, code, statusCode);
};

// Only these routes exist on the gateway. A path the relay does not know is
// refused here rather than forwarded, so the relay never becomes a general
// HTTP client aimed at the host loopback.
const GATEWAY_RELAY_ROUTES = Object.freeze([
  Object.freeze({
    method: 'POST',
    path: '/api/bots/private/gateway',
    contentType: JSON_CONTENT_TYPE_PATTERN,
    requestLimit: JSON_REQUEST_LIMIT,
    responseLimit: JSON_RESPONSE_LIMIT,
    filename: false,
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/bots/private/oauth',
    contentType: JSON_CONTENT_TYPE_PATTERN,
    requestLimit: JSON_REQUEST_LIMIT,
    responseLimit: JSON_RESPONSE_LIMIT,
    filename: false,
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/bots/private/artifacts',
    contentType: OCTET_CONTENT_TYPE_PATTERN,
    requestLimit: ARTIFACT_LIMIT,
    responseLimit: JSON_RESPONSE_LIMIT,
    filename: true,
  }),
  Object.freeze({
    method: 'GET',
    pattern: ARTIFACT_CONTENT_PATTERN,
    contentType: null,
    requestLimit: 0,
    responseLimit: ARTIFACT_LIMIT,
    filename: false,
  }),
]);

export const isGatewayRelayPath = (url) => (
  typeof url === 'string'
  && GATEWAY_RELAY_ROUTES.some((route) => (
    route.path ? url === route.path : route.pattern.test(url)
  ))
);

const matchRoute = (method, url) => {
  const candidates = GATEWAY_RELAY_ROUTES.filter((route) => (
    route.path ? url === route.path : route.pattern.test(url)
  ));
  if (candidates.length === 0) {
    fail('Bot gateway route was not found', 'bot_egress_gateway_route_invalid', 404);
  }
  const route = candidates.find((candidate) => candidate.method === method);
  if (!route) {
    fail('Bot gateway route method is invalid', 'bot_egress_gateway_route_invalid', 405);
  }
  return route;
};

export function normalizeGatewayOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Bot gateway origin is invalid', 'bot_egress_gateway_origin_invalid', 400);
  }
  if (url.protocol !== 'http:' || url.hostname !== GATEWAY_ORIGIN_HOSTNAME || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('Bot gateway origin is invalid', 'bot_egress_gateway_origin_invalid', 400);
  }
  return url.origin;
}

export function createGatewayOriginRegistry({ initialOrigin = null } = {}) {
  let origin = initialOrigin === null || initialOrigin === undefined
    ? null
    : normalizeGatewayOrigin(initialOrigin);
  return Object.freeze({
    set(value) {
      origin = normalizeGatewayOrigin(value);
      return origin;
    },
    get() {
      return origin;
    },
  });
}

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

// The gateway rejects any request carrying browser or forwarding headers, and
// it authenticates the container's own bearer capability. The relay therefore
// builds the upstream header set from scratch instead of filtering the incoming
// one: nothing a container sends can reach the gateway except its capability,
// the declared body shape, and the staged filename.
const upstreamHeaders = (request, route, authority) => {
  const authorization = readSingleRawHeader(request, 'authorization');
  if (!CAPABILITY_PATTERN.test(authorization || '')) {
    fail('Bot gateway authentication is required', 'bot_egress_gateway_unauthorized', 401);
  }
  const headers = { host: authority, authorization };
  if (route.contentType) {
    const contentType = readSingleRawHeader(request, 'content-type');
    if (typeof contentType !== 'string' || !route.contentType.test(contentType)) {
      fail('Bot gateway content type is invalid', 'bot_egress_gateway_request_invalid', 415);
    }
    headers['content-type'] = contentType;
  }
  if (route.filename) {
    const filename = readSingleRawHeader(request, 'x-devryan-filename');
    if (typeof filename !== 'string' || !FILENAME_PATTERN.test(filename)) {
      fail('Bot gateway filename is invalid', 'bot_egress_gateway_request_invalid', 400);
    }
    headers['x-devryan-filename'] = filename;
  }
  const declared = readSingleRawHeader(request, 'content-length');
  if (typeof declared === 'string') {
    if (!/^\d{1,12}$/.test(declared) || Number(declared) > route.requestLimit) {
      fail('Bot gateway body is too large', 'bot_egress_gateway_request_invalid', 413);
    }
    headers['content-length'] = declared;
  }
  return headers;
};

const relayFailure = (error) => {
  if (error instanceof GatewayRelayError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  return {
    statusCode: 502,
    code: 'bot_egress_gateway_upstream_failed',
    message: 'Bot gateway is unreachable',
  };
};

export const sendGatewayRelayFailure = (response, error) => {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const failure = relayFailure(error);
  const body = Buffer.from(`${JSON.stringify({
    ok: false,
    error: { code: failure.code, message: failure.message },
  })}\n`, 'utf8');
  response.writeHead(failure.statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
};

const forwardedResponseHeaders = (headers) => Object.fromEntries(
  FORWARDED_RESPONSE_HEADERS
    .filter((name) => typeof headers[name] === 'string')
    .map((name) => [name, headers[name]]),
);

export const createGatewayRelayAgent = () => new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 2_000,
  maxSockets: 32,
  maxFreeSockets: 4,
});

export function relayGatewayRequest({
  request,
  response,
  originRegistry,
  agent,
  connect = http.request,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    let origin;
    let route;
    let headers;
    try {
      origin = originRegistry?.get?.() || null;
      if (!origin) {
        fail('Bot gateway address is not configured', 'bot_egress_gateway_unavailable', 503);
      }
      route = matchRoute(request.method, request.url);
      headers = upstreamHeaders(request, route, new URL(origin).host);
    } catch (error) {
      request.resume();
      finish(error);
      return;
    }
    const target = new URL(origin);
    const upstream = connect({
      protocol: 'http:',
      hostname: target.hostname,
      port: Number(target.port),
      method: request.method,
      path: request.url,
      headers,
      agent,
      timeout: UPSTREAM_TIMEOUT_MS,
    }, (upstreamResponse) => {
      let received = 0;
      upstreamResponse.on('data', (chunk) => {
        received += chunk.byteLength;
        if (received <= route.responseLimit) return;
        upstreamResponse.destroy();
        upstream.destroy();
        response.destroy();
        finish(new GatewayRelayError(
          'Bot gateway response is too large',
          'bot_egress_gateway_upstream_failed',
          502,
        ));
      });
      response.writeHead(
        upstreamResponse.statusCode || 502,
        forwardedResponseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
      upstreamResponse.once('end', () => finish());
      upstreamResponse.once('error', finish);
    });
    upstream.once('timeout', () => upstream.destroy(new GatewayRelayError(
      'Bot gateway timed out',
      'bot_egress_gateway_upstream_failed',
      504,
    )));
    upstream.once('error', finish);
    request.once('aborted', () => upstream.destroy());
    if (route.requestLimit === 0) {
      request.resume();
      upstream.end();
      return;
    }
    let sent = 0;
    request.on('data', (chunk) => {
      sent += chunk.byteLength;
      if (sent <= route.requestLimit) return;
      request.destroy();
      upstream.destroy();
      finish(new GatewayRelayError(
        'Bot gateway body is too large',
        'bot_egress_gateway_request_invalid',
        413,
      ));
    });
    request.pipe(upstream);
  });
}
