import net from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  BrowserEgressRelayError,
  createBrowserEgressRelay,
  startBrowserEgressRelay,
} from './egress-proxy.js';

const TOKEN_A = `drb1.${'a'.repeat(64)}.${'b'.repeat(43)}`;
const TOKEN_B = `drb1.${'c'.repeat(64)}.${'d'.repeat(43)}`;
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve);
  })));
});

const mockProxyRequest = (observed) => (options, callback) => {
  const request = new PassThrough();
  request.setTimeout = () => request;
  const end = request.end.bind(request);
  request.end = (...args) => {
    observed.push({
      method: options.method,
      path: options.path,
      authorization: options.headers?.['proxy-authorization'],
    });
    const result = end(...args);
    queueMicrotask(() => {
      if (options.method === 'CONNECT') {
        request.emit('connect', { statusCode: 200 }, new PassThrough(), Buffer.alloc(0));
        return;
      }
      const response = Readable.from(['proxied']);
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/plain' };
      callback(response);
    });
    return result;
  };
  return request;
};

const requestThrough = ({ port, target, proxyAuthorization = null, cookie = null }) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const chunks = [];
  socket.once('error', reject);
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.once('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const [head, body = ''] = raw.split('\r\n\r\n', 2);
    const headers = Object.fromEntries(head.split('\r\n').slice(1).map((line) => {
      const separator = line.indexOf(':');
      return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
    }));
    resolve({ status: Number(head.split(' ')[1]), headers, body });
  });
  socket.once('connect', () => {
    socket.write([
      `GET ${target} HTTP/1.1`,
      'Host: proxy.invalid',
      ...(proxyAuthorization ? [`Proxy-Authorization: ${proxyAuthorization}`] : []),
      ...(cookie ? [`Cookie: ${cookie}`] : []),
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
  });
});

const connectThrough = ({ port, target }) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  let response = '';
  socket.setEncoding('utf8');
  socket.once('error', reject);
  socket.on('data', (chunk) => {
    response += chunk;
    if (response.includes('\r\n\r\n')) {
      socket.destroy();
      resolve(response);
    }
  });
  socket.once('connect', () => {
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
});

describe('computer-local browser egress relay', () => {
  test('injects and rotates the browser capability without exposing it to Chromium', async () => {
    const observed = [];
    const relay = await startBrowserEgressRelay({
      upstreamUrl: 'http://egress:43121',
      token: TOKEN_A,
      requestImpl: mockProxyRequest(observed),
    });
    servers.push(relay.server);
    const relayPort = relay.server.address().port;

    const firstResponse = await requestThrough({
      port: relayPort,
      target: 'https://public.example/path',
      proxyAuthorization: 'Bearer attacker-controlled',
    });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body).toContain('proxied');
    relay.rotateToken(TOKEN_B);
    await requestThrough({ port: relayPort, target: 'http://second.example/' });

    expect(observed).toEqual([
      { method: 'GET', path: 'https://public.example/path', authorization: `Bearer ${TOKEN_A}` },
      { method: 'GET', path: 'http://second.example/', authorization: `Bearer ${TOKEN_B}` },
    ]);
  });

  test('injects the current capability into CONNECT and rejects malformed targets', async () => {
    const observed = [];
    const relay = await startBrowserEgressRelay({
      upstreamUrl: 'http://egress:43121',
      token: TOKEN_A,
      requestImpl: mockProxyRequest(observed),
    });
    servers.push(relay.server);
    const relayPort = relay.server.address().port;

    expect(await connectThrough({ port: relayPort, target: 'public.example:443' }))
      .toStartWith('HTTP/1.1 200 Connection Established');
    expect(await connectThrough({ port: relayPort, target: 'bad%20target:443' }))
      .toStartWith('HTTP/1.1 400');
    expect(observed).toEqual([{
      method: 'CONNECT',
      path: 'public.example:443',
      authorization: `Bearer ${TOKEN_A}`,
    }]);
  });

  test('preserves browser Cookie and Set-Cookie headers', async () => {
    let forwardedCookie = null;
    const requestImpl = (options, callback) => {
      const request = new PassThrough();
      request.setTimeout = () => request;
      const end = request.end.bind(request);
      request.end = (...args) => {
        forwardedCookie = options.headers?.cookie;
        const result = end(...args);
        queueMicrotask(() => {
          const response = Readable.from(['cookie round trip']);
          response.statusCode = 200;
          response.headers = {
            'content-type': 'text/plain',
            'set-cookie': ['embedded_session=accepted; Secure; SameSite=None'],
          };
          callback(response);
        });
        return result;
      };
      return request;
    };
    const relay = await startBrowserEgressRelay({
      upstreamUrl: 'http://egress:43121',
      token: TOKEN_A,
      requestImpl,
    });
    servers.push(relay.server);

    const response = await requestThrough({
      port: relay.server.address().port,
      target: 'https://embedded.example/session',
      cookie: 'browser_session=retained',
    });

    expect(forwardedCookie).toBe('browser_session=retained');
    expect(response.headers['set-cookie']).toBe('embedded_session=accepted; Secure; SameSite=None');
  });

  test('reports only the normalized host when the immutable allowlist denies CONNECT', async () => {
    const diagnostics = [];
    const requestImpl = () => {
      const request = new PassThrough();
      request.setTimeout = () => request;
      const end = request.end.bind(request);
      request.end = (...args) => {
        const result = end(...args);
        queueMicrotask(() => request.emit(
          'connect',
          { statusCode: 403 },
          new PassThrough(),
          Buffer.alloc(0),
        ));
        return result;
      };
      return request;
    };
    const relay = await startBrowserEgressRelay({
      upstreamUrl: 'http://egress:43121',
      token: TOKEN_A,
      requestImpl,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    servers.push(relay.server);

    expect(await connectThrough({ port: relay.server.address().port, target: 'Needed.Example:443' }))
      .toStartWith('HTTP/1.1 403');
    expect(diagnostics).toEqual([{
      kind: 'egress_denied',
      host: 'needed.example',
      statusCode: 403,
    }]);
  });

  test('fails closed for an invalid fixed upstream or token', () => {
    expect(() => createBrowserEgressRelay({
      upstreamUrl: 'http://supervisor:43120',
      token: TOKEN_A,
    })).toThrow(BrowserEgressRelayError);
    expect(() => createBrowserEgressRelay({
      upstreamUrl: 'http://egress:43121',
      token: 'weak',
    })).toThrow(BrowserEgressRelayError);
  });

  test('records proxy authentication failures without recording capabilities or headers', async () => {
    const diagnostics = [];
    const requestImpl = () => {
      const request = new PassThrough();
      request.setTimeout = () => request;
      const end = request.end.bind(request);
      request.end = (...args) => {
        const result = end(...args);
        queueMicrotask(() => request.emit('connect', { statusCode: 407,
          headers: { authorization: TOKEN_A } }, new PassThrough(), Buffer.alloc(0)));
        return result;
      };
      return request;
    };
    const relay = await startBrowserEgressRelay({ upstreamUrl: 'http://egress:43121', token: TOKEN_A,
      requestImpl, onDiagnostic: (event) => diagnostics.push(event) });
    servers.push(relay.server);
    expect(await connectThrough({ port: relay.server.address().port, target: 'App.Example:443' }))
      .toStartWith('HTTP/1.1 407');
    expect(diagnostics).toEqual([{ kind: 'proxy_failure', host: 'app.example', statusCode: 407,
      reason: 'proxy_connection_failed' }]);
    expect(JSON.stringify(diagnostics)).not.toContain(TOKEN_A);
  });
});
