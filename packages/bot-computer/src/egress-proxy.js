import http from 'node:http';
import net from 'node:net';

const TOKEN_PATTERN = /^drb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const HOP_HEADERS = new Set([
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

export class BrowserEgressRelayError extends Error {
  constructor(message, code = 'DEVRYAN_BROWSER_EGRESS_CONFIG_INVALID') {
    super(message);
    this.name = 'BrowserEgressRelayError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BrowserEgressRelayError(message, code);
};

const normalizeUpstream = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Browser egress relay URL is invalid');
  }
  if (url.protocol !== 'http:' || url.hostname !== 'egress' || url.port !== '43121'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('Browser egress relay URL is invalid');
  }
  return Object.freeze({ hostname: url.hostname, port: Number(url.port) });
};

const requestHeaders = (headers, token) => {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (HOP_HEADERS.has(normalized) || value === undefined) continue;
    result[normalized] = value;
  }
  result['proxy-authorization'] = `Bearer ${token}`;
  result.connection = 'close';
  return result;
};

const responseHeaders = (headers) => Object.fromEntries(Object.entries(headers).filter(
  ([name, value]) => value !== undefined && !HOP_HEADERS.has(name.toLowerCase()),
));

const sendFailure = (response, statusCode = 502) => {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': '0',
    connection: 'close',
  });
  response.end();
};

const sendConnectFailure = (socket, statusCode = 502) => {
  if (socket.destroyed) return;
  const reason = statusCode === 407 ? 'Proxy Authentication Required' : 'Bad Gateway';
  socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

const validConnectAuthority = (value) => {
  if (typeof value !== 'string' || value.length < 3 || value.length > 512
    || /[\u0000-\u0020\u007f%/?#\\]/u.test(value)) return false;
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/u.exec(value);
  if (!match) return false;
  const port = Number(match[3]);
  const hostname = match[1] || match[2];
  return port >= 1 && port <= 65_535
    && hostname.length <= 253
    && !hostname.includes('..')
    && (match[1]
      ? net.isIP(hostname) === 6
      : hostname.split('.').every((label) => (
          label.length >= 1 && label.length <= 63
          && !label.startsWith('-') && !label.endsWith('-')
        )));
};

export function createBrowserEgressRelay({
  upstreamUrl,
  token,
  requestImpl = http.request,
} = {}) {
  const upstream = normalizeUpstream(upstreamUrl);
  if (!TOKEN_PATTERN.test(token || '') || typeof requestImpl !== 'function') {
    fail('Browser egress relay token is invalid');
  }
  let activeToken = token;

  const server = http.createServer((request, response) => {
    let target;
    try {
      target = new URL(request.url);
    } catch {
      sendFailure(response, 400);
      return;
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
      || target.hash || !target.hostname || request.method === 'CONNECT') {
      sendFailure(response, 400);
      return;
    }
    const forwarded = requestImpl({
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: target.href,
      headers: requestHeaders(request.headers, activeToken),
    }, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode || 502,
        responseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.once('error', () => response.destroy());
      upstreamResponse.pipe(response);
    });
    forwarded.setTimeout(30_000, () => forwarded.destroy());
    forwarded.once('error', () => sendFailure(response));
    request.once('aborted', () => forwarded.destroy());
    request.pipe(forwarded);
  });

  server.on('connect', (request, clientSocket, head) => {
    if (!validConnectAuthority(request.url)) {
      sendConnectFailure(clientSocket, 400);
      return;
    }
    const tunnel = requestImpl({
      hostname: upstream.hostname,
      port: upstream.port,
      method: 'CONNECT',
      path: request.url,
      headers: {
        host: request.url,
        'proxy-authorization': `Bearer ${activeToken}`,
        connection: 'close',
      },
    });
    tunnel.setTimeout(30_000, () => tunnel.destroy());
    tunnel.once('connect', (upstreamResponse, upstreamSocket, upstreamHead) => {
      if (upstreamResponse.statusCode !== 200) {
        upstreamSocket.destroy();
        sendConnectFailure(clientSocket, upstreamResponse.statusCode || 502);
        return;
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.byteLength > 0) upstreamSocket.write(head);
      if (upstreamHead.byteLength > 0) clientSocket.write(upstreamHead);
      clientSocket.once('error', () => upstreamSocket.destroy());
      upstreamSocket.once('error', () => clientSocket.destroy());
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    tunnel.once('error', () => sendConnectFailure(clientSocket));
    tunnel.end();
  });

  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;

  return Object.freeze({
    server,
    rotateToken(nextToken) {
      if (!TOKEN_PATTERN.test(nextToken || '')) fail('Browser egress relay token is invalid');
      activeToken = nextToken;
    },
  });
}

export async function startBrowserEgressRelay(options = {}) {
  const relay = createBrowserEgressRelay(options);
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.server.listen(0, '127.0.0.1', resolve);
  });
  const address = relay.server.address();
  if (!address || typeof address === 'string' || !net.isIP(address.address)) {
    relay.server.close();
    fail('Browser egress relay failed to bind', 'DEVRYAN_BROWSER_EGRESS_UNAVAILABLE');
  }
  return Object.freeze({
    ...relay,
    proxyUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => relay.server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  });
}
