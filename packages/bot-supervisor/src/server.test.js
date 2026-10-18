import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import http from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import {
  createSupervisorHttpServer,
  readDeployedSupervisorConfiguration,
  startDeployedSupervisorService,
  startSupervisorService,
} from './server.js';

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

  test('tunnels the computer through the same scoped capability, with no published port', async () => {
    const requests = [];
    const upstream = http.createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true,"result":{"rotated":true}}');
    });
    servers.push(upstream);
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

    const containerName = `devryan-bot-computer-${'c'.repeat(24)}`;
    const supervisor = fakeSupervisor();
    supervisor.ensureComputer = async () => ({
      kind: 'computer',
      name: containerName,
      state: 'running',
      endpoint: { host: containerName, port: 43122 },
      image: `sha256:${'b'.repeat(64)}`,
      replaced: false,
    });
    supervisor.stop = async () => ({ name: containerName, state: 'stopped' });
    const target = upstream.address();
    const baseUrl = await start(supervisor, {
      resolveRuntimeProxyTarget: () => ({ host: '127.0.0.1', port: target.port }),
    });

    const ensured = await command(baseUrl, '/v1/ensure/computer', {
      botId: 'bot-1',
      scopeKey: 'bot:bot-1',
      runId: 'run-1',
      channelId: '1',
      revisionId: 'revision-1',
      runtimeToken: 'runtime-token-0123456789abcdef0123456789',
      scopeMode: 'team',
      egressToken: `drb1.${'e'.repeat(64)}.${'f'.repeat(43)}`,
      isolationTier: 'standard',
    });
    const payload = await ensured.json();
    // The container publishes no host port, so the scoped proxy path is the
    // only address the host is given.
    expect(Object.keys(payload.result.endpoint)).toEqual(['proxyToken']);
    const proxyToken = payload.result.endpoint.proxyToken;

    // Unlike the reasoning runtime, the computer authenticates every call
    // itself, so its bearer capability has to survive the proxy.
    const rotated = await fetch(`${baseUrl}/v1/runtime/${proxyToken}/v1/egress/rotate`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer computer-capability',
        'content-type': 'application/json',
        cookie: 'session=1',
      },
      body: '{"token":"rotated"}',
    });
    expect(rotated.status).toBe(200);
    expect(requests).toEqual([{
      url: '/v1/egress/rotate',
      authorization: 'Bearer computer-capability',
      cookie: undefined,
    }]);

    const stopped = await command(baseUrl, '/v1/stop', {
      kind: 'computer',
      botId: 'bot-1',
      scopeKey: 'bot:bot-1',
    });
    expect(stopped.status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/runtime/${proxyToken}/v1/status`)).status).toBe(404);
  });
});

describe('Bot supervisor startup', () => {
  const PROXY_TOKEN = 'a'.repeat(43);
  const deployed = (overrides = {}) => ({
    DEVRYAN_BOT_SUPERVISOR_TOKEN: TOKEN,
    DEVRYAN_BOT_ENGINE_PROXY_URL: 'http://engine-proxy:43124',
    DEVRYAN_BOT_ENGINE_PROXY_TOKEN: PROXY_TOKEN,
    ...overrides,
  });
  const freePort = async () => {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
  };

  test('missing or invalid deployed configuration fails once, before any client or listener', async () => {
    const listen = spyOn(http.Server.prototype, 'listen');
    try {
      for (const env of [
        deployed({ DEVRYAN_BOT_SUPERVISOR_TOKEN: undefined }),
        deployed({ DEVRYAN_BOT_SUPERVISOR_TOKEN: 'short' }),
        deployed({ DEVRYAN_BOT_ENGINE_PROXY_URL: undefined }),
        deployed({ DEVRYAN_BOT_ENGINE_PROXY_URL: 'http://docker.example:2375' }),
        deployed({ DEVRYAN_BOT_ENGINE_PROXY_TOKEN: undefined }),
        deployed({ DEVRYAN_BOT_SUPERVISOR_PORT: '0' }),
        deployed({ DEVRYAN_BOT_SUPERVISOR_PORT: '70000' }),
        deployed({ DEVRYAN_BOT_SUPERVISOR_PORT: 'http' }),
      ]) {
        let clients = 0;
        const failure = await startDeployedSupervisorService({ env, createEngineProxyClient: () => { clients += 1; } })
          .then(() => null, (error) => error);
        expect(failure?.code).toBe('bot_supervisor_configuration_invalid');
        expect(String(failure?.message)).not.toContain(TOKEN);
        expect(clients).toBe(0);
      }
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  });

  test('the deployed entry serves through the engine proxy and never builds a Docker client', async () => {
    const port = await freePort();
    const proxyConfigurations = [];
    const service = await startDeployedSupervisorService({
      env: deployed({ DEVRYAN_BOT_SUPERVISOR_PORT: String(port) }),
      host: '127.0.0.1',
      createEngineProxyClient: (configuration) => { proxyConfigurations.push(configuration); return fakeSupervisor(); },
    });
    try {
      expect(proxyConfigurations).toEqual([{ endpoint: 'http://engine-proxy:43124', token: PROXY_TOKEN }]);
      expect(service.address.port).toBe(port);
      const response = await command(`http://127.0.0.1:${port}`, '/v1/status', { botId: 'bot' });
      expect(response.status).toBe(200);
    } finally {
      await service.close();
    }
    expect(readDeployedSupervisorConfiguration(deployed()).port).toBe(43120);
  });

  test('the library entry serves only through the engine proxy and has no Docker path', async () => {
    const listen = spyOn(http.Server.prototype, 'listen');
    try {
      await expect(startSupervisorService({ token: 'short' })).rejects.toMatchObject({ code: 'bot_supervisor_unauthorized' });
      await expect(startSupervisorService({ token: TOKEN })).rejects.toMatchObject({ code: 'bot_supervisor_configuration_invalid' });
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
    const proxied = await startSupervisorService({ token: TOKEN, host: '127.0.0.1', port: 0,
      engineProxyUrl: 'http://127.0.0.1:43124', engineProxyToken: PROXY_TOKEN });
    await proxied.close();
  });

  test('the supervisor package carries no Docker implementation', async () => {
    const sources = await readdir(new URL('.', import.meta.url));
    expect(sources.filter((file) => /^(?:docker|names|workspace-[a-z]+|[a-z-]+-verifier)(?:\.test)?\.js$/.test(file))).toEqual([]);
    for (const file of sources.filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/docker\.sock|bot-engine-proxy\/src/);
    }
  });
});
