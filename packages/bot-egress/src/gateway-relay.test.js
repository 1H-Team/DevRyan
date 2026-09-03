import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import {
  createGatewayOriginRegistry,
  isGatewayRelayPath,
  normalizeGatewayOrigin,
} from './gateway-relay.js';
import { createModelEgressProxyServer } from './server.js';
import { EgressTokenError } from './token.js';

const CONTROL_TOKEN = 'c'.repeat(43);
const CAPABILITY = 'g'.repeat(43);
const closers = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return server.address().port;
};

// Stands in for the private gateway on the host loopback. It records exactly
// what reached it so the relay's header handling can be asserted.
const startGateway = async (handler) => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (handler) {
      handler(request, response);
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': 'leaked=1',
    });
    response.end('{"ok":true}');
  });
  const port = await listen(server);
  return { received, port, origin: `http://host.docker.internal:${port}` };
};

const startRelay = async ({ origin = null } = {}) => {
  const originRegistry = createGatewayOriginRegistry({ initialOrigin: origin });
  const server = createModelEgressProxyServer({
    authorizeToken: async () => { throw new EgressTokenError(); },
    controlToken: CONTROL_TOKEN,
    gatewayOriginRegistry: originRegistry,
    lookup: async () => [{ address: '104.18.6.192', family: 4 }],
    // `host.docker.internal` is not resolvable in the test process; the relay
    // dials the address the control channel published, so redirect it to
    // loopback without touching the header the gateway checks.
    connectGateway: (options, callback) => http.request(
      { ...options, hostname: '127.0.0.1' },
      callback,
    ),
  });
  const port = await listen(server);
  return { port, originRegistry };
};

const call = async (port, path, { method = 'POST', headers = {}, body = '{}' } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      'content-type': 'application/json',
      ...headers,
    },
    ...(method === 'GET' ? {} : { body }),
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
};

describe('private gateway relay', () => {
  test('accepts only the host loopback gateway origin', () => {
    expect(normalizeGatewayOrigin('http://host.docker.internal:45999'))
      .toBe('http://host.docker.internal:45999');
    for (const rejected of [
      'http://host.docker.internal',
      'https://host.docker.internal:45999',
      'http://127.0.0.1:45999',
      'http://evil.example:80',
      'http://host.docker.internal:45999/path',
      'http://user:pass@host.docker.internal:45999',
      'not a url',
    ]) {
      expect(() => normalizeGatewayOrigin(rejected)).toThrow();
    }
  });

  test('recognises only the gateway routes as relayed paths', () => {
    expect(isGatewayRelayPath('/api/bots/private/gateway')).toBe(true);
    expect(isGatewayRelayPath('/api/bots/private/oauth')).toBe(true);
    expect(isGatewayRelayPath('/api/bots/private/artifacts')).toBe(true);
    expect(isGatewayRelayPath('/api/bots/private/artifacts/art-1/content')).toBe(true);
    expect(isGatewayRelayPath('/api/bots/private/gateway/../../admin')).toBe(false);
    expect(isGatewayRelayPath('/healthz')).toBe(false);
    expect(isGatewayRelayPath('http://api.openai.com/v1/responses')).toBe(false);
  });

  test('forwards a capability call and hands the gateway the Host it checks', async () => {
    const gateway = await startGateway();
    const { port } = await startRelay({ origin: gateway.origin });

    const result = await call(port, '/api/bots/private/gateway', {
      headers: {
        // A compromised container cannot smuggle browser or forwarding headers
        // past the relay: the gateway rejects requests that carry them.
        cookie: 'session=1',
        'x-forwarded-for': '10.0.0.1',
        origin: 'https://evil.example',
      },
      body: '{"operation":"memory.search"}',
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
    expect(gateway.received).toHaveLength(1);
    expect(gateway.received[0].headers.host).toBe(`host.docker.internal:${gateway.port}`);
    expect(gateway.received[0].headers.authorization).toBe(`Bearer ${CAPABILITY}`);
    expect(gateway.received[0].headers).not.toHaveProperty('cookie');
    expect(gateway.received[0].headers).not.toHaveProperty('x-forwarded-for');
    expect(gateway.received[0].headers).not.toHaveProperty('origin');
    expect(gateway.received[0].body).toBe('{"operation":"memory.search"}');
    // Only a reviewed response header set reaches the container.
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  test('fails closed until the control channel publishes an address', async () => {
    const { port, originRegistry } = await startRelay();

    const unavailable = await call(port, '/api/bots/private/gateway');
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailable.body).error.code).toBe('bot_egress_gateway_unavailable');

    const gateway = await startGateway();
    originRegistry.set(gateway.origin);
    expect((await call(port, '/api/bots/private/gateway')).status).toBe(200);
  });

  test('rejects a call without a capability, a wrong method, or an unknown route', async () => {
    const gateway = await startGateway();
    const { port } = await startRelay({ origin: gateway.origin });

    const anonymous = await call(port, '/api/bots/private/gateway', {
      headers: { authorization: '' },
    });
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body).error.code).toBe('bot_egress_gateway_unauthorized');

    const wrongMethod = await call(port, '/api/bots/private/gateway', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);

    const wrongType = await call(port, '/api/bots/private/gateway', {
      headers: { 'content-type': 'text/plain' },
    });
    expect(wrongType.status).toBe(415);

    const unknown = await fetch(`http://127.0.0.1:${port}/api/bots/private/admin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CAPABILITY}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unknown.status).toBe(400);
    expect(gateway.received).toHaveLength(0);
  });

  test('bounds a declared and an undeclared relayed body', async () => {
    const gateway = await startGateway();
    const { port } = await startRelay({ origin: gateway.origin });

    const declared = await call(port, '/api/bots/private/gateway', {
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(declared.status).toBe(413);
    expect(gateway.received).toHaveLength(0);

    // A chunked body declares no length, so the relay counts it as it streams
    // and tears the connection down; what matters is that the gateway is never
    // handed more than the bound, whatever the client sees.
    const chunked = await fetch(`http://127.0.0.1:${port}/api/bots/private/gateway`, {
      method: 'POST',
      duplex: 'half',
      headers: { authorization: `Bearer ${CAPABILITY}`, 'content-type': 'application/json' },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(256 * 1024));
        },
      }),
    }).catch(() => ({ status: 0 }));
    expect(chunked.status < 200 || chunked.status >= 300).toBe(true);
    expect(gateway.received.every(({ body }) => body.length <= 1024 * 1024)).toBe(true);
  });

  test('bounds a relayed response', async () => {
    const gateway = await startGateway((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(Buffer.alloc(5 * 1024 * 1024, 0x78));
    });
    const { port } = await startRelay({ origin: gateway.origin });

    const oversized = await call(port, '/api/bots/private/gateway')
      .catch((error) => ({ status: 0, error }));
    expect(oversized.body === undefined || oversized.body.length <= 4 * 1024 * 1024).toBe(true);
  });

  test('publishes the gateway address only to the separately authenticated control channel', async () => {
    const gateway = await startGateway();
    const { port, originRegistry } = await startRelay();

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/v1/gateway/origin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: gateway.origin }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(originRegistry.get()).toBeNull();

    // A container's own capability is not control authority.
    const capabilityAuthenticated = await fetch(`http://127.0.0.1:${port}/v1/gateway/origin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CAPABILITY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: gateway.origin }),
    });
    expect(capabilityAuthenticated.status).toBe(401);
    expect(originRegistry.get()).toBeNull();

    const rejected = await fetch(`http://127.0.0.1:${port}/v1/gateway/origin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'http://evil.example:80' }),
    });
    expect(rejected.status).toBe(400);
    expect(originRegistry.get()).toBeNull();

    const accepted = await fetch(`http://127.0.0.1:${port}/v1/gateway/origin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: gateway.origin }),
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(await accepted.text()).result).toEqual({ origin: gateway.origin });
    expect(originRegistry.get()).toBe(gateway.origin);
  });

  test('does not let a proxy request reach the gateway address', async () => {
    const gateway = await startGateway();
    const { port } = await startRelay({ origin: gateway.origin });

    const proxied = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        host: 'proxy.invalid',
        'proxy-authorization': `Bearer ${CAPABILITY}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(proxied.status).toBe(400);
    expect(gateway.received).toHaveLength(0);
  });
});
