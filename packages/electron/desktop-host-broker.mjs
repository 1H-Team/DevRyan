import crypto from 'node:crypto';
import http from 'node:http';

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class DesktopHostUnavailableError extends Error {
  constructor(message = 'The DevRyan desktop host is unavailable') {
    super(message);
    this.name = 'DesktopHostUnavailableError';
    this.code = 'desktop_host_unavailable';
  }
}

const sendJson = (response, status, body) => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'no-store',
  });
  response.end(bytes);
};

const readJson = async (request) => {
  const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw Object.assign(new Error('JSON required'), { code: 'invalid_request' });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('Request too large'), { code: 'invalid_request' });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { code: 'invalid_request' });
  }
};

const loopback = (value) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value || '');

const exactRoutes = Object.freeze({
  'GET /v1/status': 'status',
  'POST /v1/notify': 'notify',
  'POST /v1/browser/create': 'createBrowserLease',
  'POST /v1/browser/touch': 'touchBrowserLease',
  'POST /v1/browser/release': 'releaseBrowserLease',
});

export const createDesktopHostBroker = async ({
  handlers,
  token = crypto.randomBytes(32).toString('base64url'),
  leaseId = crypto.randomUUID(),
  port = 0,
} = {}) => {
  if (!TOKEN_PATTERN.test(token) || typeof handlers !== 'object' || handlers === null) {
    throw new DesktopHostUnavailableError('Desktop host broker configuration is invalid');
  }
  const server = http.createServer(async (request, response) => {
    if (!loopback(request.socket.remoteAddress)
      || request.headers.authorization !== `Bearer ${token}`
      || request.headers['x-devryan-desktop-host-version'] !== String(PROTOCOL_VERSION)
      || request.headers.upgrade
      || request.headers['transfer-encoding']
      || typeof request.url !== 'string'
      || request.url.includes('?')
      || request.url.includes('%')) {
      return sendJson(response, 401, { error: 'Desktop host request rejected', code: 'desktop_host_unauthorized' });
    }
    const handlerName = exactRoutes[`${request.method} ${request.url}`];
    const handler = handlerName ? handlers[handlerName] : null;
    if (typeof handler !== 'function') {
      return sendJson(response, 404, { error: 'Desktop host operation not found', code: 'desktop_host_operation_unknown' });
    }
    try {
      const body = request.method === 'GET' ? undefined : await readJson(request);
      const result = await handler(body);
      return sendJson(response, 200, result ?? { ok: true });
    } catch (error) {
      return sendJson(response, 503, {
        error: 'Desktop host operation failed',
        code: typeof error?.code === 'string' ? error.code : 'desktop_host_operation_failed',
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return Object.freeze({
    leaseId,
    token,
    port: address.port,
    capabilities: Object.freeze(['focus', 'notifications', 'browser_cdp']),
    close: () => new Promise((resolve) => server.close(resolve)),
  });
};

export const createDesktopHostBrokerClient = ({
  getLease,
  fetchImpl = fetch,
} = {}) => {
  if (typeof getLease !== 'function' || typeof fetchImpl !== 'function') {
    throw new DesktopHostUnavailableError('Desktop host broker client is invalid');
  }
  const request = async (method, route, body) => {
    const lease = getLease();
    if (!lease
      || !Number.isSafeInteger(lease.brokerPort)
      || lease.brokerPort < 1
      || lease.brokerPort > 65_535
      || !TOKEN_PATTERN.test(lease.brokerToken)
      || Date.parse(lease.expiresAt) <= Date.now()) {
      throw new DesktopHostUnavailableError();
    }
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${lease.brokerPort}${route}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${lease.brokerToken}`,
          'X-DevRyan-Desktop-Host-Version': String(PROTOCOL_VERSION),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DesktopHostUnavailableError();
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new DesktopHostUnavailableError();
    let payload;
    try {
      payload = bytes.byteLength > 0 ? JSON.parse(bytes.toString('utf8')) : {};
    } catch {
      throw new DesktopHostUnavailableError();
    }
    if (!response.ok) {
      throw new DesktopHostUnavailableError(
        typeof payload?.error === 'string' ? payload.error : undefined,
      );
    }
    return payload;
  };
  return Object.freeze({
    status: () => request('GET', '/v1/status'),
    notify: (payload) => request('POST', '/v1/notify', payload),
    createBrowserLease: (payload) => request('POST', '/v1/browser/create', payload),
    touchBrowserLease: (payload) => request('POST', '/v1/browser/touch', payload),
    releaseBrowserLease: (payload) => request('POST', '/v1/browser/release', payload),
  });
};
