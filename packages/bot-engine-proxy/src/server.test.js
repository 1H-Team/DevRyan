import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import { BotDockerError } from '../../bot-supervisor/src/docker.js';
import { createBotEngineProxyClient } from '../../bot-supervisor/src/engine-proxy-client.js';
import { createEngineProxyHttpServer } from './server.js';

const TOKEN = 'e'.repeat(43);
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const createSupervisor = () => {
  const calls = [];
  const supervisor = {};
  for (const operation of [
    'ensureReasoning', 'ensureComputer', 'status', 'stop', 'reset',
    'writeWorkspace', 'importSharedFile', 'exportWorkspaceImage',
    'listWorkspace', 'listFilesystem',
  ]) {
    supervisor[operation] = async (input) => {
      calls.push({ operation, input });
      return { operation, input };
    };
  }
  supervisor.listOwned = async () => {
    calls.push({ operation: 'listOwned' });
    return [{ name: 'owned' }];
  };
  return { supervisor, calls };
};

const start = async (supervisor) => {
  const server = createEngineProxyHttpServer({ token: TOKEN, supervisor });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};

const invoke = (port, pathname, { method = 'POST', token = TOKEN, body = { fixed: true } } = {}) => fetch(
  `http://127.0.0.1:${port}${pathname}`,
  {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-devryan-engine-proxy-version': '1',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  },
);

const rawRequest = (port, bytes) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  let response = '';
  socket.setEncoding('utf8');
  socket.once('error', reject);
  socket.on('data', (chunk) => { response += chunk; });
  socket.once('end', () => resolve(response));
  socket.once('connect', () => socket.write(bytes));
});

describe('socket-owning Bot engine proxy', () => {
  test('exposes exactly the eleven fixed supervisor operations', async () => {
    const fixture = createSupervisor();
    const port = await start(fixture.supervisor);
    const routes = [
      ['/v1/ensure/reasoning', 'ensureReasoning'],
      ['/v1/ensure/computer', 'ensureComputer'],
      ['/v1/status', 'status'],
      ['/v1/stop', 'stop'],
      ['/v1/reset', 'reset'],
      ['/v1/workspace/write', 'writeWorkspace'],
      ['/v1/shared/import', 'importSharedFile'],
      ['/v1/workspace/export-image', 'exportWorkspaceImage'],
      ['/v1/workspace/list', 'listWorkspace'],
      ['/v1/filesystem/list', 'listFilesystem'],
    ];
    for (const [pathname, operation] of routes) {
      const response = await invoke(port, pathname, { body: { operation } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        result: { operation, input: { operation } },
      });
    }
    const owned = await invoke(port, '/v1/owned', { method: 'GET' });
    expect(owned.status).toBe(200);
    expect(await owned.json()).toEqual({ ok: true, containers: [{ name: 'owned' }] });
    expect(fixture.calls.map(({ operation }) => operation)).toEqual([
      ...routes.map(([, operation]) => operation),
      'listOwned',
    ]);
  });

  test('rejects auth/version ambiguity, encoded paths, queries, and upgrades', async () => {
    const fixture = createSupervisor();
    const port = await start(fixture.supervisor);
    expect((await invoke(port, '/v1/status', { token: 'x'.repeat(43) })).status).toBe(401);
    expect((await invoke(port, '/v1/status?all=true')).status).toBe(400);
    expect((await invoke(port, '/v1/%73tatus')).status).toBe(400);

    const duplicate = await rawRequest(port, [
      'POST /v1/status HTTP/1.1',
      'Host: engine-proxy',
      `Authorization: Bearer ${TOKEN}`,
      `Authorization: Bearer ${TOKEN}`,
      'X-DevRyan-Engine-Proxy-Version: 1',
      'Content-Type: application/json',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}',
    ].join('\r\n'));
    expect(duplicate).toStartWith('HTTP/1.1 401');

    const upgrade = await rawRequest(port, [
      'GET /v1/owned HTTP/1.1',
      'Host: engine-proxy',
      `Authorization: Bearer ${TOKEN}`,
      'X-DevRyan-Engine-Proxy-Version: 1',
      'Connection: Upgrade',
      'Upgrade: websocket',
      '',
      '',
    ].join('\r\n'));
    expect(upgrade).toBe('');
    expect(fixture.calls).toEqual([]);
  });

  test('preserves stable policy errors and sanitizes unexpected failures', async () => {
    const fixture = createSupervisor();
    fixture.supervisor.status = async () => {
      throw new BotDockerError('Refusing foreign container', 'bot_supervisor_ownership_refused', {
        statusCode: 409,
      });
    };
    const port = await start(fixture.supervisor);
    const refused = await invoke(port, '/v1/status');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'bot_supervisor_ownership_refused' },
    });
    fixture.supervisor.status = async () => { throw new Error('secret socket detail'); };
    const failed = await invoke(port, '/v1/status');
    expect(failed.status).toBe(500);
    const payload = await failed.json();
    expect(payload.error.code).toBe('bot_engine_proxy_internal_error');
    expect(JSON.stringify(payload)).not.toContain('secret socket detail');
  });

  test('round-trips only fixed client methods over the internal protocol', async () => {
    const fixture = createSupervisor();
    const port = await start(fixture.supervisor);
    const client = createBotEngineProxyClient({
      endpoint: `http://127.0.0.1:${port}`,
      token: TOKEN,
    });
    await expect(client.ensureComputer({ botId: 'bot-01' })).resolves.toEqual({
      operation: 'ensureComputer',
      input: { botId: 'bot-01' },
    });
    await expect(client.listOwned()).resolves.toEqual([{ name: 'owned' }]);
    expect(Object.keys(client).sort()).toEqual([
      'ensureComputer', 'ensureReasoning', 'exportWorkspaceImage', 'importSharedFile',
      'listFilesystem', 'listOwned', 'listWorkspace', 'reset', 'status', 'stop',
      'writeWorkspace',
    ]);
  });

  test('is the only Compose service with a Docker socket mount', async () => {
    const compose = await fs.readFile(path.resolve(import.meta.dir, '../../../docker/bots/compose.yml'), 'utf8');
    expect(compose.match(/\/var\/run\/docker\.sock/g)).toHaveLength(2);
    const supervisorBlock = compose.slice(
      compose.indexOf('  supervisor:'),
      compose.indexOf('  engine-proxy:'),
    );
    const engineBlock = compose.slice(
      compose.indexOf('  engine-proxy:'),
      compose.indexOf('  egress:'),
    );
    expect(supervisorBlock).not.toContain('docker.sock');
    expect(engineBlock).toContain('/var/run/docker.sock:/var/run/docker.sock:rw');
  });
});
