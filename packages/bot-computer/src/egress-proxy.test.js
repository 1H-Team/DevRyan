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

const requestThrough = ({ port, target, proxyAuthorization = null }) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const chunks = [];
  socket.once('error', reject);
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.once('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const [head, body = ''] = raw.split('\r\n\r\n', 2);
    resolve({ status: Number(head.split(' ')[1]), body });
  });
  socket.once('connect', () => {
    socket.write([
      `GET ${target} HTTP/1.1`,
      'Host: proxy.invalid',
      ...(proxyAuthorization ? [`Proxy-Authorization: ${proxyAuthorization}`] : []),
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
});
