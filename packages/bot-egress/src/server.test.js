import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { createActiveRevisionRegistry, createModelEgressProxyServer } from './server.js';
import { EgressTokenError } from './token.js';

const TOKEN = 'runtime-token-0123456789abcdef0123456789';
const CONTROL_TOKEN = 'c'.repeat(43);
const NOW = 1_800_000_000_000;
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const capability = () => ({
  active: true,
  botId: 'bot-01',
  revisionId: 'revision-01',
  hosts: ['api.openai.com:443'],
  expiresAt: NOW + 60_000,
});

const start = async (overrides = {}) => {
  const server = createModelEgressProxyServer({
    authorizeToken: async (token) => {
      if (token !== TOKEN) throw new EgressTokenError();
      return capability();
    },
    lookup: async () => [{ address: '104.18.6.192', family: 4 }],
    now: () => NOW,
    forwardHttp: async ({ request, response, destination }) => {
      expect(request.headers['proxy-authorization']).toBe(`Bearer ${TOKEN}`);
      expect(destination.address).toBe('104.18.6.192');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"proxied":true}');
    },
    openTunnel: async () => new PassThrough(),
    ...overrides,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
};

const proxyRequest = ({ port, target, token = TOKEN, basic = false }) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const chunks = [];
  socket.once('error', reject);
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.once('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const [head, body = ''] = raw.split('\r\n\r\n', 2);
    const lines = head.split('\r\n');
    const statusCode = Number(lines[0].split(' ')[1]);
    const headers = Object.fromEntries(lines.slice(1).map((line) => {
      const separator = line.indexOf(':');
      return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
    }));
    resolve({ statusCode, headers, body });
  });
  socket.once('connect', () => {
    const credential = basic
      ? `Basic ${Buffer.from(`devryan:${token}`).toString('base64')}`
      : `Bearer ${token}`;
    const authorization = token ? `Proxy-Authorization: ${credential}\r\n` : '';
    socket.write(
      `POST ${target} HTTP/1.1\r\nHost: proxy.invalid\r\n${authorization}Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
  });
});

const connectRequest = ({ port, target, token = TOKEN }) => new Promise((resolve, reject) => {
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
    const authorization = token ? `Proxy-Authorization: Bearer ${token}\r\n` : '';
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization}\r\n`);
  });
});

describe('authenticated model egress proxy', () => {
  test('forwards an allowlisted HTTP proxy request after active-revision authorization', async () => {
    const { port } = await start();
    const response = await proxyRequest({ port, target: 'https://api.openai.com/v1/responses' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"proxied":true}');
  });

  test('requires proxy bearer authentication for both HTTP and CONNECT', async () => {
    const { port } = await start();
    const httpResponse = await proxyRequest({
      port,
      target: 'https://api.openai.com/v1/responses',
      token: null,
    });
    expect(httpResponse.statusCode).toBe(407);
    expect(httpResponse.headers['proxy-authenticate']).toContain('Bearer');

    const connectResponse = await connectRequest({
      port,
      target: 'api.openai.com:443',
      token: null,
    });
    expect(connectResponse).toStartWith('HTTP/1.1 407');
  });

  test('accepts the scoped token through standard proxy URL Basic credentials', async () => {
    const { port } = await start({
      forwardHttp: async ({ response }) => {
        response.writeHead(200);
        response.end('ok');
      },
    });
    const response = await proxyRequest({
      port,
      target: 'https://api.openai.com/v1/responses',
      basic: true,
    });
    expect(response.statusCode).toBe(200);
  });

  test('updates active revisions only through the separately authenticated control route', async () => {
    const revisionRegistry = createActiveRevisionRegistry();
    const { port } = await start({ controlToken: CONTROL_TOKEN, revisionRegistry });
    const body = { botId: 'bot-01', revisionId: 'revision-01' };
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/revisions/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(unauthorized.status).toBe(401);
    expect(revisionRegistry.isActive('revision-01', 'bot-01')).toBe(false);

    const activated = await fetch(`http://127.0.0.1:${port}/v1/revisions/activate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CONTROL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(activated.status).toBe(200);
    expect(revisionRegistry.isActive('revision-01', 'bot-01')).toBe(true);
  });

  test('denies arbitrary HTTP and sibling CONNECT destinations without forwarding', async () => {
    let forwards = 0;
    const { port } = await start({
      forwardHttp: async () => { forwards += 1; },
    });
    const arbitrary = await proxyRequest({ port, target: 'https://example.com/' });
    expect(arbitrary.statusCode).toBe(403);
    expect(forwards).toBe(0);

    const sibling = await connectRequest({ port, target: 'supervisor:43120' });
    expect(sibling).toStartWith('HTTP/1.1 403');
  });

  test('opens an authenticated CONNECT tunnel only to an allowed public address', async () => {
    let opened = null;
    const { port } = await start({
      openTunnel: async (destination) => {
        opened = destination;
        return new PassThrough();
      },
    });
    const response = await connectRequest({ port, target: 'api.openai.com:443' });
    expect(response).toStartWith('HTTP/1.1 200 Connection Established');
    expect(opened).toMatchObject({
      authority: 'api.openai.com:443',
      address: '104.18.6.192',
    });
  });

  test('fails closed when revision authorization is inactive or unavailable', async () => {
    const { port } = await start({
      authorizeToken: async () => ({ ...capability(), active: false }),
    });
    const response = await proxyRequest({ port, target: 'https://api.openai.com/v1/responses' });
    expect(response.statusCode).toBe(407);
    expect(JSON.parse(response.body).error.code).toBe('bot_egress_revision_inactive');
  });

  test('allows browser public-only traffic while denying private and rebinding answers', async () => {
    let forwards = 0;
    const { port } = await start({
      authorizeToken: async () => ({
        active: true,
        botId: 'bot-01',
        revisionId: 'revision-01',
        purpose: 'browser',
        networkMode: 'public_only',
        hosts: [],
        expiresAt: NOW + 60_000,
      }),
      lookup: async (hostname) => hostname === 'rebind.example'
        ? [
            { address: '104.18.6.192', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ]
        : hostname === 'private.example'
          ? [{ address: '10.0.0.7', family: 4 }]
          : [{ address: '104.18.6.192', family: 4 }],
      forwardHttp: async ({ response }) => {
        forwards += 1;
        response.writeHead(200);
        response.end('ok');
      },
    });
    expect((await proxyRequest({ port, target: 'https://public.example/' })).statusCode).toBe(200);
    expect((await proxyRequest({ port, target: 'https://private.example/' })).statusCode).toBe(403);
    expect((await proxyRequest({ port, target: 'https://rebind.example/' })).statusCode).toBe(403);
    expect(forwards).toBe(1);
  });

  test('keeps browser allowlists exact by host and port', async () => {
    const { port } = await start({
      authorizeToken: async () => ({
        active: true,
        botId: 'bot-01',
        revisionId: 'revision-01',
        purpose: 'browser',
        networkMode: 'allowlist',
        hosts: ['allowed.example:443'],
        expiresAt: NOW + 60_000,
      }),
      forwardHttp: async ({ response }) => {
        response.writeHead(200);
        response.end('ok');
      },
    });
    expect((await proxyRequest({ port, target: 'https://allowed.example/' })).statusCode).toBe(200);
    expect((await proxyRequest({ port, target: 'https://allowed.example:8443/' })).statusCode).toBe(403);
    expect((await proxyRequest({ port, target: 'https://other.example/' })).statusCode).toBe(403);
  });
});
