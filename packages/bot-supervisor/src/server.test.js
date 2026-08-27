import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import { createSupervisorHttpServer } from './server.js';

const TOKEN = 'supervisor-test-token-0123456789abcdef';
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const start = async (supervisor, options = {}) => {
  const server = createSupervisorHttpServer({ token: TOKEN, supervisor, ...options });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

const fakeSupervisor = () => ({
  ensureReasoning: async (body) => ({ verb: 'ensure reasoning', body }),
  ensureComputer: async (body) => ({ verb: 'ensure computer', body }),
  status: async (body) => ({ verb: 'status', body }),
  stop: async (body) => ({ verb: 'stop', body }),
  reset: async (body) => ({ verb: 'reset', body }),
  writeWorkspace: async (body) => ({ verb: 'write workspace', body }),
  listOwned: async () => [{ id: 'owned-1' }],
  listWorkspace: async (body) => ({ verb: 'list workspace', body }),
  listFilesystem: async (body) => ({ verb: 'list filesystem', body }),
  exportWorkspaceImage: async (body) => ({ verb: 'export workspace image', body }),
});

const command = async (baseUrl, pathname, body, token = TOKEN) => fetch(`${baseUrl}${pathname}`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
});

describe('Bot supervisor HTTP service', () => {
  test('keeps health non-sensitive and requires bearer auth for management', async () => {
    const baseUrl = await start(fakeSupervisor());
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);

    const response = await fetch(`${baseUrl}/v1/owned`);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'bot_supervisor_unauthorized', message: 'Authentication required' },
    });
  });

  test('routes only the reviewed management verbs', async () => {
    const baseUrl = await start(fakeSupervisor());
    const response = await command(baseUrl, '/v1/ensure/reasoning', {
      botId: 'bot-1',
      scopeKey: 'channel:1',
      runId: 'run-1',
      channelId: '1',
      revisionId: 'revision-1',
      runtimeToken: 'runtime-token-0123456789abcdef0123456789',
      compiledHash: 'a'.repeat(64),
      gatewayUrl: 'http://host.docker.internal:55100',
      egressToken: `drb1.${'e'.repeat(64)}.${'f'.repeat(43)}`,
      environmentSecretCount: 0,
      chatgptImageGeneration: false,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result.verb).toBe('ensure reasoning');

    const owned = await fetch(`${baseUrl}/v1/owned`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((await owned.json()).containers).toEqual([{ id: 'owned-1' }]);

    const write = await command(baseUrl, '/v1/workspace/write', {
      botId: 'bot-1',
      scopeKey: 'channel:1',
      path: 'approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    });
    expect(await write.json()).toMatchObject({
      result: {
        verb: 'write workspace',
        body: { path: 'approval-check.txt', content: 'BOT_APPROVAL_OK' },
      },
    });

    const arbitrary = await command(baseUrl, '/v1/docker/request', { method: 'DELETE' });
    expect(arbitrary.status).toBe(404);
    expect((await arbitrary.json()).error.code).toBe('bot_supervisor_command_not_found');
  });

  test('rejects query widening and non-JSON management requests', async () => {
    const baseUrl = await start(fakeSupervisor());
    const query = await command(baseUrl, '/v1/status?all=true', {});
    expect(query.status).toBe(400);

    const form = await fetch(`${baseUrl}/v1/status`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'text/plain',
      },
      body: '{}',
    });
    expect(form.status).toBe(415);
    expect((await form.json()).error.code).toBe('bot_supervisor_content_type_invalid');
  });

  test('does not expose unexpected exception details', async () => {
    const supervisor = fakeSupervisor();
    supervisor.stop = async () => {
      throw new Error('secret docker socket detail');
    };
    const baseUrl = await start(supervisor);
    const response = await command(baseUrl, '/v1/stop', {
      kind: 'computer',
      botId: 'bot-1',
      scopeKey: 'bot:bot-1',
    });
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error.code).toBe('bot_supervisor_internal_error');
    expect(JSON.stringify(payload)).not.toContain('secret docker');
  });

  test('tunnels one internal reasoning runtime through a revocable scoped capability', async () => {
    const requests = [];
    const upstream = http.createServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        directory: request.headers['x-opencode-directory'],
        url: request.url,
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write('data: first\n\n');
      setTimeout(() => response.end('data: second\n\n'), 5);
    });
    servers.push(upstream);
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

    const containerName = `devryan-bot-reasoning-${'a'.repeat(24)}`;
    const supervisor = fakeSupervisor();
    supervisor.ensureReasoning = async () => ({
      kind: 'reasoning',
      name: containerName,
      state: 'running',
      endpoint: { host: containerName, port: 4096 },
      image: `sha256:${'b'.repeat(64)}`,
      replaced: false,
    });
    supervisor.stop = async () => ({ name: containerName, state: 'stopped' });
    const target = upstream.address();
    const baseUrl = await start(supervisor, {
      resolveRuntimeProxyTarget: () => ({ host: '127.0.0.1', port: target.port }),
    });

    const ensured = await command(baseUrl, '/v1/ensure/reasoning', {
      botId: 'bot-1',
      scopeKey: 'channel:1',
      runId: 'run-1',
      channelId: '1',
      revisionId: 'revision-1',
      runtimeToken: 'runtime-token-0123456789abcdef0123456789',
      compiledHash: 'a'.repeat(64),
      gatewayUrl: 'http://host.docker.internal:55100',
      egressToken: `drb1.${'e'.repeat(64)}.${'f'.repeat(43)}`,
    });
    const payload = await ensured.json();
    const proxyToken = payload.result.endpoint.proxyToken;
    expect(proxyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const proxied = await fetch(`${baseUrl}/v1/runtime/${proxyToken}/global/event?directory=%2Fworkspace`, {
      headers: {
        authorization: 'Bearer must-not-reach-runtime',
        'x-opencode-directory': '%2Fworkspace',
      },
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.text()).toBe('data: first\n\ndata: second\n\n');
    expect(requests).toEqual([{
      authorization: undefined,
      directory: '%2Fworkspace',
      url: '/global/event?directory=%2Fworkspace',
    }]);

    expect((await fetch(`${baseUrl}/v1/runtime/${'z'.repeat(43)}/global/health`)).status)
      .toBe(404);
    const stopped = await command(baseUrl, '/v1/stop', {
      kind: 'reasoning',
      botId: 'bot-1',
      scopeKey: 'channel:1',
    });
    expect(stopped.status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/runtime/${proxyToken}/global/health`)).status)
      .toBe(404);
  });
});
