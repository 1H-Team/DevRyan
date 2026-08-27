import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';
import { afterEach, describe, it } from 'vitest';

import { registerRuntimeServiceRoutes } from './routes.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const startFixture = async () => {
  const sessions = new Set();
  const leases = [];
  let bootstrap = 'a'.repeat(43);
  let status = {
    instanceId: '123e4567-e89b-42d3-a456-426614174000',
    port: 0,
    protocolVersion: 2,
    health: 'healthy',
    ownerGeneration: 1,
    desktopHost: { state: 'unavailable', leaseId: null, expiresAt: null, capabilities: [] },
    updatedAt: '2026-08-27T10:00:00.000Z',
  };
  const controller = {
    consumeBootstrap: async (candidate) => {
      if (candidate !== bootstrap) throw new Error('rejected');
      bootstrap = null;
      sessions.add('s'.repeat(43));
      return { token: 's'.repeat(43), expiresAt: '2026-08-27T22:00:00.000Z' };
    },
    authorizeSession: (candidate) => sessions.has(candidate),
    publicStatus: () => status,
    update: async (patch) => {
      status = { ...status, ...patch };
      return status;
    },
  };
  const app = express();
  app.use(express.json({ limit: '4kb' }));
  const server = http.createServer(app);
  registerRuntimeServiceRoutes(app, {
    controller,
    server,
    now: () => new Date('2026-08-27T10:00:00.000Z'),
    onDesktopHostLease: async (lease) => leases.push(lease),
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/private', (_req, res) => res.json({ ok: true }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    bootstrap: 'a'.repeat(43),
    leases,
  };
};

describe('runtime-service HTTP handshake', () => {
  it('mints a strict HttpOnly cookie once and gates the renderer surface', async () => {
    const fixture = await startFixture();
    const unauthenticated = await fetch(`${fixture.baseUrl}/private`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await fetch(`${fixture.baseUrl}/health`)).status, 200);

    const bootstrap = await fetch(`${fixture.baseUrl}/auth/runtime-service-bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
      body: JSON.stringify({ token: fixture.bootstrap }),
    });
    assert.equal(bootstrap.status, 204);
    const cookie = bootstrap.headers.get('set-cookie');
    assert.match(cookie, /^devryan_runtime_service=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const authenticated = await fetch(`${fixture.baseUrl}/api/runtime-service/handshake`, {
      headers: { Cookie: cookie.split(';')[0] },
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).protocolVersion, 2);

    const replay = await fetch(`${fixture.baseUrl}/auth/runtime-service-bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
      body: JSON.stringify({ token: fixture.bootstrap }),
    });
    assert.equal(replay.status, 401);
  });

  it('requires CSRF and accepts only a bounded desktop-host broker lease', async () => {
    const fixture = await startFixture();
    const bootstrap = await fetch(`${fixture.baseUrl}/auth/runtime-service-bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
      body: JSON.stringify({ token: fixture.bootstrap }),
    });
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const body = {
      leaseId: '123e4567-e89b-42d3-a456-426614174001',
      brokerPort: 44001,
      brokerToken: 'b'.repeat(43),
      capabilities: ['browser_cdp', 'focus'],
    };

    const missingCsrf = await fetch(`${fixture.baseUrl}/api/runtime-service/desktop-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
    assert.equal(missingCsrf.status, 403);

    const accepted = await fetch(`${fixture.baseUrl}/api/runtime-service/desktop-host`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DevRyan-CSRF': '1',
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
    assert.equal(accepted.status, 200);
    assert.equal(fixture.leases.length, 1);
    assert.equal(fixture.leases[0].brokerToken, 'b'.repeat(43));
    const response = await accepted.json();
    assert.equal(response.desktopHost.state, 'connected');
    assert.equal(JSON.stringify(response).includes('brokerToken'), false);
  });
});
