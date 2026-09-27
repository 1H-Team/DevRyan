import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import request from '../../test-supertest.js';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseConnection } from '../multi-user/supabase-connection.js';
import { createDisconnectedAuth } from '../multi-user/disconnected-auth.js';
import { createMultiUserRuntime } from '../multi-user/runtime.js';
import { registerAuthAndAccessRoutes } from '../opencode/core-routes.js';
import { createTunnelAccessControl, registerTunnelAccessBoundary, hasTunnelBoundaryAuthorization, TUNNEL_LINK_TTL_MS, TUNNEL_SESSION_TTL_MS } from './access-control.js';
import { attachSupabaseConnectionBoundary } from '../multi-user/connection-routes.js';
import { assertTunnelBotGrant, isBotTunnelRoute } from './bot-grants.js';
import { isDirectLocalRequest } from '../security/direct-local-request.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createBotAuthorization } from '../bots/authorization.js';
import { createBotCatalogVisibility } from '../bots/catalog-visibility.js';
import { registerRuntimeServiceRoutes } from '../runtime-service/routes.js';
import { createTerminalRuntime } from '../terminal/runtime.js';
import { createMessageStreamWsRuntime } from '../event-stream/runtime.js';
import { createPreviewProxyRuntime } from '../preview/proxy-runtime.js';
import { getRequestPrincipal } from '../multi-user/request-context.js';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';

const BOT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000003';
const remote = { Host: 'bots.example.test', Origin: 'https://bots.example.test', 'X-Forwarded-For': '192.0.2.1', 'X-Forwarded-Proto': 'https' };
const roots = []; const disposers = [];
afterEach(async () => { for (const close of disposers.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
// supertest's own listener binds the dual-stack wildcard (::) yet connects to
// 127.0.0.1. macOS can give that listener a port another local process already
// holds on 127.0.0.1 (OpenCode, Docker, a running DevRyan), which then answers
// instead of the fixture: spurious 404s, or a foreign 401/403 passing an
// assertion. An explicit loopback listener is the only possible responder.
async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  disposers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server;
}
async function fixture(mode = 'absent', ownerAccess = false) {
  const base = path.resolve('../../.cache/tunnel-access-tests'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'fixture-')); roots.push(root);
  const config = { dataDirectory: root, configured: mode !== 'absent', enabled: mode === 'on' };
  const connection = await createSupabaseConnection({ config, fetchImpl: () => { throw new Error('Cloud calls forbidden in this test'); } });
  disposers.push(() => connection.dispose());
  if (mode === 'absent') await connection.bootstrapLocalOwner();
  else await connection.rememberOwner({ id: OWNER, role: 'admin', scope: 'managed' }, { setHeader() {} });
  let now = Date.now();
  const validateBots = vi.fn(async (_owner, ids) => { if (ids.some((id) => id !== BOT)) throw new Error('No membership'); });
  const controller = createTunnelAccessControl({ now: () => now });
  await controller.initialize({ connection, validateBots }); disposers.push(() => controller.dispose());
  await controller.setActiveTunnel({ publicUrl: 'https://bots.example.test', mode: 'managed-remote' });
  const app = express(); app.set('trust proxy', true);
  const server = http.createServer(app); const forbidden = vi.fn();
  registerTunnelAccessBoundary(app, server, { controller, connection });
  attachSupabaseConnectionBoundary(app, server, connection, { allowRemoteRequest: hasTunnelBoundaryAuthorization });
  // Mirrors the ordering in bootstrap-runtime: private handlers precede /api
  // auth. No tunnel request may reach them, even with Supabase On.
  app.use('/api/desktop', (_req, res) => { forbidden(); res.sendStatus(200); });
  registerRuntimeServiceRoutes(app, { controller: {
    consumeBootstrap: async () => { throw new Error('No native proof'); }, authorizeSession: () => false,
    publicStatus: () => { forbidden(); return {}; },
  } });
  app.use((req, res, next) => {
    if (connection.enabled && !req.principal && !isDirectLocalRequest(req)) return res.sendStatus(401);
    next();
  });
  const unconfiguredRuntime = ownerAccess && mode === 'absent'
    ? await createMultiUserRuntime({ dataDirectory: root, fetchImpl: () => { throw new Error('No cloud requests'); } }) : null;
  if (unconfiguredRuntime) disposers.push(async () => { await unconfiguredRuntime.botsRuntime.shutdown(); await unconfiguredRuntime.connection.dispose(); });
  const auth = unconfiguredRuntime ? unconfiguredRuntime.wrapLegacyAuthController({ enabled: false })
    : ownerAccess ? createDisconnectedAuth(connection)
    : { ensureSessionToken: vi.fn(async () => mode === 'on' ? null : 'password-free-fixture') };
  if (ownerAccess) {
    registerAuthAndAccessRoutes(app, { uiAuthController: auth, tunnelAuthController: controller,
      readSettingsFromDiskMigrated: async () => ({}), normalizeTunnelSessionTtlMs: () => TUNNEL_SESSION_TTL_MS });
    app.all('/api/session', (req, res) => res.json({ principal: req.principal, contextualScope: getRequestPrincipal()?.scope }));
  }
  const rejectWebSocketUpgrade = (socket, status) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\n\r\n`); };
  const isRequestOriginAllowed = ownerAccess
    ? createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) }).isRequestOriginAllowed : async () => true;
  const terminal = createTerminalRuntime({ app, server, express, fs: {}, path, uiAuthController: auth,
    buildAugmentedPath: () => '', searchPathFor: () => null, isExecutable: () => false,
    isRequestOriginAllowed, rejectWebSocketUpgrade, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30000,
    TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1000, TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3 });
  disposers.push(() => terminal.shutdown());
  const events = createMessageStreamWsRuntime({ server, uiAuthController: auth, isRequestOriginAllowed, rejectWebSocketUpgrade,
    buildOpenCodeUrl: () => { throw new Error('No host event upstream allowed'); }, getOpenCodeAuthHeaders: () => ({}), wsClients: new Set() });
  disposers.push(() => events.close());
  const preview = createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware, responseInterceptor });
  preview.attach(app, { server, express, uiAuthController: auth, isRequestOriginAllowed, rejectWebSocketUpgrade, classifyRequestScope: controller.classifyRequestScope });
  disposers.push(() => preview.shutdown());
  app.get('/api/bots', (req, res) => res.json({ principal: req.principal, contextualScope: getRequestPrincipal()?.scope }));
  app.get('/api/bots/events', (req, res) => { res.type('text/event-stream'); res.write('event: ready\ndata: {}\n\n'); });
  app.use((_req, res) => { forbidden(); res.sendStatus(200); });
  await listenOnLoopback(server);
  const issue = () => controller.issueBootstrapToken({ botIds: [BOT] });
  const exchange = (token, headers = remote) => request(server).post('/tunnel/connect').set(headers).set('X-DevRyan-CSRF', '1').send({ token });
  const login = async () => {
    const link = await issue(); const response = await exchange(link.token); expect(response.status).toBe(200);
    return response.headers['set-cookie'][0].split(';')[0];
  };
  return { root, config, controller, connection, app, server, forbidden, validateBots, issue, exchange, login, now: () => now, advance: (ms) => { now += ms; } };
}

describe('managed remote owner access with Supabase Off', () => {
  it.each(['off', 'absent'])('authenticates the owner without cloud or Bot dependencies with configuration %s', async (mode) => {
    const f = await fixture(mode, true);
    const link = await f.controller.issueBootstrapToken({ access: 'owner' });
    expect(f.validateBots).not.toHaveBeenCalled();
    await expect(f.controller.issueBootstrapToken()).rejects.toMatchObject({ code: 'tunnel_bots_required' });
    const localCookie = await f.connection.issueLocalOwnerSession();
    expect((await request(f.server).get('/api/session').set(remote).set('Cookie', `${localCookie.name}=${localCookie.value}`)).status).toBe(401);
    expect((await request(f.server).get('/api/session').set(remote)).status).toBe(401);
    expect((await f.exchange(link.token, { ...remote, Origin: 'https://attacker.test' })).status).toBe(403);
    const login = await f.exchange(link.token);
    expect(login.status).toBe(200); expect(login.body.redirectUrl).toBe('/');
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly; Secure; SameSite=Strict');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    expect((await f.exchange(link.token)).status).toBe(401);
    const status = await request(f.server).get('/auth/session').set(remote).set('Cookie', cookie);
    expect(status.body).toMatchObject({ authenticated: true, mode: 'local', principal: { role: 'admin', scope: 'local-admin', policy: { terminal: true, files: true } } });
    expect(status.text).not.toContain('settingsOverrides');
    const session = await request(f.server).get('/api/session').set(remote).set('Cookie', cookie);
    expect(session.status).toBe(200); expect(session.body.contextualScope).toBe('local-admin');
    expect((await request(f.server).post('/api/session').set(remote).set('Cookie', cookie)).status).toBe(403);
    expect((await request(f.server).post('/api/session').set(remote).set('Cookie', cookie).set('X-DevRyan-CSRF', '1')).status).toBe(200);
    for (const route of ['/api/desktop/browser-cdp', '/API/DESKTOP/browser-cdp', '/api/runtime-service/handshake', '/api/openchamber/tunnel/links', '/API/OPENCHAMBER/TUNNEL/links', '/api/system/supabase-connection', '/api/bots', '/api/passkeys', '/auth/passkey/register/options']) {
      expect((await request(f.server).get(route).set(remote).set('Cookie', cookie)).status, route).toBe(403);
    }
    expect(f.forbidden).not.toHaveBeenCalled();
    const logout = await request(f.server).post('/auth/logout').set(remote).set('Cookie', cookie).set('X-DevRyan-CSRF', '1');
    expect(logout.status).toBe(200);
    expect((await request(f.server).get('/api/session').set(remote).set('Cookie', cookie)).status).toBe(401);
    expect(f.connection.authenticateLocalOwner({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost', cookie: `${localCookie.name}=${localCookie.value}` } })).not.toBeNull();
  });

  it('authorizes the real terminal WebSocket and closes it on owner grant revocation', async () => {
    const f = await fixture('off', true);
    const link = await f.controller.issueBootstrapToken({ access: 'owner' });
    const login = await f.exchange(link.token);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const session = f.controller.getTunnelSessionFromRequest({ headers: { host: remote.Host, cookie } });
    const ws = new WebSocket(`ws://127.0.0.1:${f.server.address().port}/api/terminal/ws`, { headers: { ...remote, Cookie: cookie } });
    disposers.push(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise((resolve) => ws.once('close', resolve));
    await f.controller.revokeGrant(session.grantId);
    await closed;
    expect(f.controller.getTunnelSessionFromRequest({ headers: { host: remote.Host, cookie } })).toBeNull();
  });

  it('resumes owner authorization after restart without issuing a fresh link, and enforces expiry', async () => {
    const f = await fixture('off', true);
    const link = await f.controller.issueBootstrapToken({ access: 'owner' });
    const login = await f.exchange(link.token);
    const req = { headers: { host: remote.Host, cookie: login.headers['set-cookie'][0].split(';')[0] } };
    await f.controller.dispose();
    const connection = await createSupabaseConnection({ config: f.config, fetchImpl: () => { throw new Error('No cloud requests'); } });
    disposers.push(() => connection.dispose());
    const controller = createTunnelAccessControl({ now: f.now });
    await controller.initialize({ connection }); disposers.push(() => controller.dispose());
    expect(controller.getResumeProfile()).toMatchObject({ hostname: remote.Host, mode: 'managed-remote' });
    await controller.setActiveTunnel({ publicUrl: `https://${remote.Host}`, mode: 'managed-remote' });
    expect(controller.getTunnelSessionFromRequest(req)?.access).toBe('owner');
    const expiring = await controller.issueBootstrapToken({ access: 'owner' });
    expect((await fs.readFile(path.join(f.root, 'multi-user-vault.json'), 'utf8'))).not.toContain(expiring.token);
    f.advance(TUNNEL_LINK_TTL_MS + 1);
    expect(await controller.exchangeBootstrapToken({ token: expiring.token, req: { method: 'POST', headers: {
      host: remote.Host, origin: remote.Origin, 'x-devryan-csrf': '1',
    } }, res: { setHeader: vi.fn() } })).toMatchObject({ ok: false, reason: 'expired' });
    f.advance(TUNNEL_SESSION_TTL_MS + 1);
    expect(controller.getTunnelSessionFromRequest(req)).toBeNull();
    await controller.clearActiveTunnel();
    expect(controller.getResumeProfile()).toBeNull();
    expect(controller.getTunnelSessionFromRequest(req)).toBeNull();
  });

  it('never issues owner links for managed accounts, including an On-mode outage', async () => {
    const f = await fixture('on');
    await expect(f.controller.issueBootstrapToken({ access: 'owner' })).rejects.toMatchObject({ code: 'tunnel_owner_unavailable' });
    const connection = await createSupabaseConnection({ config: f.config, fetchImpl: () => { throw new Error('Offline'); } });
    disposers.push(() => connection.dispose());
    const controller = createTunnelAccessControl();
    await controller.initialize({ connection }); disposers.push(() => controller.dispose());
    await controller.setActiveTunnel({ publicUrl: `https://${remote.Host}`, mode: 'managed-remote' });
    expect(controller.canUseOwnerLogin()).toBe(false);
    await expect(controller.issueBootstrapToken({ access: 'owner' })).rejects.toMatchObject({ code: 'tunnel_owner_unavailable' });
  });

  it('revokes owner sessions when switching from Off to managed account authentication', async () => {
    const f = await fixture('off');
    const link = await f.controller.issueBootstrapToken({ access: 'owner' });
    const login = await f.exchange(link.token);
    const req = { headers: { host: remote.Host, cookie: login.headers['set-cookie'][0].split(';')[0] } };
    const connection = await createSupabaseConnection({ config: { ...f.config, enabled: true, url: 'https://supabase.invalid' },
      fetchImpl: async (url) => new Response(JSON.stringify(url.includes('/rpc/') ? '99999999999999' : [{ id: OWNER, role: 'admin', status: 'active' }])) });
    disposers.push(() => connection.dispose());
    const controller = createTunnelAccessControl();
    await controller.initialize({ connection }); disposers.push(() => controller.dispose());
    await controller.setActiveTunnel({ publicUrl: `https://${remote.Host}`, mode: 'managed-remote' });
    expect(connection.enabled).toBe(true);
    expect(controller.canUseOwnerLogin()).toBe(false);
    expect(controller.getTunnelSessionFromRequest(req)).toBeNull();
  });
});

describe('durable Bot-only tunnel authorization', () => {
  for (const mode of ['on', 'off', 'absent']) describe(mode, () => {
    it('GET previews do not consume a link; POST is same-origin, single-use and grants no administrator role', async () => {
      const f = await fixture(mode); const link = await f.issue();
      const landing = await request(f.server).get('/tunnel/connect').set(remote);
      expect(landing.status).toBe(200); expect(landing.text).not.toContain(link.token);
      expect(landing.headers['referrer-policy']).toBe('no-referrer');
      expect(f.controller.getBootstrapStatus().hasBootstrapToken).toBe(true);
      expect((await f.exchange(link.token, { ...remote, Origin: 'https://attacker.test' })).status).toBe(403);
      expect((await request(f.server).post('/tunnel/connect').set(remote).send({ token: link.token })).status).toBe(403);
      const result = await f.exchange(link.token); expect(result.status).toBe(200);
      expect((await f.exchange(link.token)).status).toBe(401);
      const cookie = result.headers['set-cookie'][0].split(';')[0];
      const catalog = await request(f.server).get('/api/bots').set(remote).set('Cookie', cookie);
      expect(catalog.body.principal).toMatchObject({ scope: 'tunnel-bot', role: 'developer', localOwner: false, tunnelGrant: { botIds: [BOT] } });
      expect(catalog.body.contextualScope).toBe('tunnel-bot');
      expect(() => assertTunnelBotGrant(catalog.body.principal, OTHER)).toThrow();
      expect(() => assertTunnelBotGrant(catalog.body.principal, BOT, 'manage_bot')).toThrow();
      expect((await fs.readFile(path.join(f.root, 'multi-user-vault.json'), 'utf8'))).not.toContain(link.token);
    });
    it('rejects host HTTP, agent SSE and private capabilities before their handlers', async () => {
      const f = await fixture(mode); const revokedCookie = await f.login();
      await f.controller.revokeTunnelArtifacts(); const cookie = await f.login();
      for (const route of ['/api/session', '/api/global/event', '/api/terminal/create', '/api/fs', '/api/git/status',
        '/api/preview/proxy/1234567890abcdef', '/api/desktop/browser-cdp', '/api/runtime-service/handshake',
        '/api/openchamber/tunnel/status', '/api/system/supabase-connection', '/api/passkeys', `/api/bots/${BOT}/credentials`]) {
        for (const value of [cookie, revokedCookie, `oc_tunnel_session=${'A'.repeat(43)}`, '']) {
          const result = await request(f.server).get(route).set(remote).set('Cookie', value);
          expect([401, 403], `${mode}: ${route}, ${value === cookie ? 'valid' : value === revokedCookie ? 'revoked' : 'invalid'} cookie`).toContain(result.status);
        }
        for (const headers of [{ ...remote, Host: 'localhost', 'X-Forwarded-Host': 'localhost' }, { ...remote, Origin: 'https://attacker.test' }]) {
          expect([401, 403]).toContain((await request(f.server).get(route).set(headers).set('Cookie', cookie)).status);
        }
      }
      expect(f.forbidden).not.toHaveBeenCalled();
      await f.controller.revokeTunnelArtifacts();
      expect((await request(f.server).get('/api/bots').set(remote).set('Cookie', cookie)).status).toBe(401);
    });
    it('denies terminal, OpenCode stream and preview WebSocket upgrades without password authentication', async () => {
      const f = await fixture(mode); const revokedCookie = await f.login();
      await f.controller.revokeTunnelArtifacts();
      const cookie = await f.login();
      for (const pathname of ['/api/terminal/ws', '/api/global/event/ws', '/api/preview/proxy/1234567890abcdef']) {
        for (const headers of [{ ...remote, Cookie: cookie }, { ...remote, Cookie: revokedCookie }, { ...remote, Cookie: 'oc_tunnel_session=forged' }, remote,
          { ...remote, Host: 'localhost', 'X-Forwarded-Host': 'localhost', Cookie: cookie },
          { ...remote, Origin: 'https://attacker.test', Cookie: cookie }]) {
          const status = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${f.server.address().port}${pathname}`, { headers });
            ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); ws.terminate(); });
            ws.on('open', () => { ws.terminate(); reject(new Error('Unauthorized upgrade succeeded')); });
            ws.on('error', () => {});
          });
          expect([401, 403]).toContain(status);
        }
      }
    });
    it('closes an admitted Bot SSE connection immediately when its grant is revoked', async () => {
      const f = await fixture(mode); const cookie = await f.login();
      const session = f.controller.getTunnelSessionFromRequest({ headers: { host: remote.Host, cookie } });
      let closeResolve; const closed = new Promise((resolve) => { closeResolve = resolve; });
      await new Promise((resolve, reject) => {
        const stream = http.get({ hostname: '127.0.0.1', port: f.server.address().port, path: '/api/bots/events', headers: { ...remote, Cookie: cookie } }, (response) => {
          expect(response.statusCode).toBe(200);
          response.once('data', resolve); response.once('close', closeResolve);
        });
        stream.on('error', reject);
      });
      await f.controller.revokeGrant(session.grantId); await closed;
      expect((await request(f.server).get('/api/bots').set(remote).set('Cookie', cookie)).status).toBe(401);
    });
  });
  it('uses raw socket, Host, Origin and every provenance header, even without an active tunnel', async () => {
    const controller = createTunnelAccessControl();
    const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } };
    expect(controller.classifyRequestScope(local)).toBe('local');
    for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'cf-ray', 'cf-connecting-ip']) {
      expect(controller.classifyRequestScope({ ...local, hostname: 'localhost', ip: '127.0.0.1', headers: { ...local.headers, [header]: '' } })).toBe('unknown-public');
    }
    expect(controller.classifyRequestScope({ ...local, headers: { host: 'evil.test' } })).toBe('unknown-public');
    expect(controller.classifyRequestScope({ ...local, socket: { remoteAddress: '192.168.0.5' } })).toBe('unknown-public');
  });
  it('survives ordinary restart and connector recovery, but expires and revokes on Stop or hostname change', async () => {
    const f = await fixture(); const cookie = await f.login();
    const req = { headers: { host: remote.Host, origin: remote.Origin, cookie } };
    const original = f.controller.getTunnelSessionFromRequest(req);
    expect(original.expiresAt - original.createdAt).toBe(TUNNEL_SESSION_TTL_MS);
    await f.controller.dispose();
    const restartedConnection = await createSupabaseConnection({ config: f.config }); disposers.push(() => restartedConnection.dispose());
    const restarted = createTunnelAccessControl(); await restarted.initialize({ connection: restartedConnection, validateBots: f.validateBots }); disposers.push(() => restarted.dispose());
    await restarted.setActiveTunnel({ publicUrl: 'https://bots.example.test', mode: 'managed-remote' });
    expect(restarted.getTunnelSessionFromRequest(req)?.sessionId).toBe(original.sessionId);
    restarted.suspendActiveTunnel();
    await restarted.setActiveTunnel({ publicUrl: 'https://bots.example.test', mode: 'managed-remote' });
    expect(restarted.getTunnelSessionFromRequest(req)).not.toBeNull();
    const close = vi.fn(); restarted.registerConnection(restarted.principalFor(original), close);
    await restarted.setActiveTunnel({ publicUrl: 'https://changed.example.test', mode: 'managed-remote' });
    expect(close).toHaveBeenCalledOnce(); expect(restarted.getTunnelSessionFromRequest(req)).toBeNull();
    await restarted.clearActiveTunnel(); expect(restarted.listTunnelSessions()).toEqual([]);
  });
  it('requires enrollment and finite links, limits exchanges independently of forged addresses, and expires sessions', async () => {
    const f = await fixture();
    await expect(f.controller.issueBootstrapToken({ botIds: [BOT], ttlMs: null })).rejects.toMatchObject({ code: 'tunnel_link_expiry_invalid' });
    await expect(f.controller.issueBootstrapToken({ botIds: [OTHER] })).rejects.toThrow('No membership');
    const link = await f.issue(); f.advance(TUNNEL_LINK_TTL_MS + 1);
    expect((await f.exchange(link.token)).status).toBe(401);
    const cookie = await f.login(); f.advance(TUNNEL_SESSION_TTL_MS + 1);
    expect((await request(f.server).get('/api/bots').set(remote).set('Cookie', cookie)).status).toBe(401);
    for (let i = 0; i < 25; i += 1) {
      const response = await f.exchange('invalid', { ...remote, 'X-Forwarded-For': `192.0.2.${i}`, 'CF-Connecting-IP': `192.0.2.${i}` });
      if (i >= 20) expect(response.status).toBe(429);
    }
  });
  it('keeps bot grants narrower than membership, channel ACL and catalog visibility', async () => {
    const f = await fixture(); const cookie = await f.login();
    const principal = f.controller.principalFor(f.controller.getTunnelSessionFromRequest({ headers: { host: remote.Host, cookie } }));
    const channelId = '00000000-0000-4000-8000-000000000004';
    const store = {
      get: async (table, filters) => table === 'bots' ? { id: filters.id } : table === 'bot_memberships'
        ? { bot_id: filters.bot_id, user_id: principal.id, role: 'manager', revoked_at: null }
        : table === 'bot_channels' ? { id: channelId, bot_id: filters.bot_id, owner_user_id: OTHER, archived_at: null } : null,
      listUserAccountKinds: async () => new Map(),
    };
    const authorization = createBotAuthorization({ store });
    await expect(authorization.requireActiveMembership(principal, OTHER)).rejects.toMatchObject({ code: 'tunnel_bot_forbidden' });
    await expect(authorization.requireChannelRead(principal, BOT, channelId)).rejects.toMatchObject({ code: 'bot_channel_forbidden' });
    await expect(authorization.requireManager(principal, BOT)).rejects.toMatchObject({ code: 'tunnel_bot_forbidden' });
    const visibility = createBotCatalogVisibility({ store });
    const snapshot = await visibility.filterSnapshot(principal, { bots: [{ id: BOT }, { id: OTHER }], channels: [{ id: channelId, botId: OTHER }], messages: [{ id: 'hidden', channelId }] });
    expect(snapshot).toEqual({ bots: [{ id: BOT }], channels: [], messages: [] });
    const closed = vi.fn(); f.controller.registerConnection(principal, closed);
    await f.connection.logoutLocalOwner({ setHeader() {} });
    expect(closed).toHaveBeenCalledOnce();
    expect((await request(f.server).get('/api/bots').set(remote).set('Cookie', cookie)).status).toBe(401);
  });
  it.each(['fresh', 'expired', 'revoked', 'malformed'])('reaches normal managed sign-in with a %s tunnel cookie', async (cookieState) => {
    const f = await fixture('on');
    let cookie = '';
    if (cookieState === 'expired' || cookieState === 'revoked') {
      cookie = await f.login();
      if (cookieState === 'expired') f.advance(TUNNEL_SESSION_TTL_MS + 1);
      else await f.controller.revokeTunnelArtifacts();
    } else if (cookieState === 'malformed') cookie = 'oc_tunnel_session=invalid';
    const app = express();
    registerTunnelAccessBoundary(app, null, { controller: f.controller, connection: f.connection });
    const authenticateAccount = vi.fn((_req, res) => res.status(401).json({ authenticated: false, mode: 'multi-user' }));
    app.get('/auth/session', authenticateAccount);
    const response = await request(await listenOnLoopback(http.createServer(app))).get('/auth/session').set(remote).set('Cookie', cookie);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ authenticated: false, mode: 'multi-user' });
    expect(authenticateAccount).toHaveBeenCalledOnce();
    if (cookie) expect(response.headers['set-cookie'][0]).toContain('oc_tunnel_session=;');
    if (cookie) expect(response.headers['set-cookie'][0]).toContain('Max-Age=0');
  });

  it('keeps valid Bot guests restricted on a managed account hostname', async () => {
    const f = await fixture('on');
    const cookie = await f.login();
    const response = await request(f.server).get('/auth/session').set(remote).set('Cookie', cookie);
    expect(response.body).toMatchObject({ authenticated: true, scope: 'tunnel-bot' });
    expect((await request(f.server).get('/api/terminal/create').set(remote).set('Cookie', cookie)).status).toBe(403);
  });

  it('never changes remote authentication policy during a cloud outage', async () => {
    const f = await fixture('on');
    const failed = await createSupabaseConnection({ config: f.config, fetchImpl: async () => { throw new Error('Offline fixture'); } });
    disposers.push(() => failed.dispose());
    expect(failed.enabled).toBe(false);
    expect(failed.authenticationMode).toBe('managed-accounts');
    expect(failed.status()).toMatchObject({ desiredEnabled: true, state: 'connection_failed' });
    const restarted = createTunnelAccessControl();
    await restarted.initialize({ connection: failed, validateBots: f.validateBots });
    disposers.push(() => restarted.dispose());
    const app = express(); registerTunnelAccessBoundary(app, null, { connection: failed, controller: restarted });
    const downstream = vi.fn(); app.use((_req, res) => { downstream(); res.sendStatus(200); });
    const server = await listenOnLoopback(http.createServer(app));
    for (const route of ['/auth/session', '/api/bots', '/api/terminal/create']) {
      expect((await request(server).get(route).set(remote)).status).toBe(503);
    }
    expect(downstream).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(path.join(f.root, 'supabase-connection.json'), 'utf8')).enabled).toBe(true);
    const restart = vi.fn();
    failed.configureDriver({ restart, prepare: vi.fn(), getBlockers: async () => [] });
    await failed.change(false);
    expect(failed.status()).toMatchObject({ desiredEnabled: false, restartRequired: true, state: 'disconnecting' });
    await failed.applyWhenIdle(); expect(restart).toHaveBeenCalledOnce();
  });
  it('revokes active grants and connections on explicit authentication-mode and ownership changes', async () => {
    const f = await fixture('on'); const cookie = await f.login();
    const req = { headers: { host: remote.Host, cookie } };
    const close = vi.fn(); f.controller.registerConnection(f.controller.principalFor(f.controller.getTunnelSessionFromRequest(req)), close);
    await f.connection.change(false);
    expect(close).toHaveBeenCalledOnce(); expect(f.controller.getTunnelSessionFromRequest(req)).toBeNull();
    const nextCookie = await f.login();
    await f.connection.rememberOwner({ id: OTHER, role: 'admin', scope: 'managed' }, { setHeader() {} });
    expect(f.controller.getTunnelSessionFromRequest({ headers: { host: remote.Host, cookie: nextCookie } })).toBeNull();
  });
  it('fails closed on damaged authorization state and recognizes only isolated computer view routes', async () => {
    const f = await fixture();
    const key = 'bot-tunnel-authorization-v1';
    const saved = f.connection.vault.get(key); saved.profile.id = 'damaged';
    await f.connection.vault.set(key, saved);
    const restarted = createTunnelAccessControl();
    await expect(restarted.initialize({ connection: f.connection })).rejects.toMatchObject({ code: 'tunnel_auth_corrupt' });
    const view = `view_${'a'.repeat(24)}`;
    expect(isBotTunnelRoute({ method: 'GET', url: `/api/bots/${BOT}/computer/view/${view}/stream` })).toBe(true);
    expect(isBotTunnelRoute({ method: 'GET', url: `/api/bots/${BOT}/computer/view/%2e%2e/stream` })).toBe(false);
    expect(isBotTunnelRoute({ method: 'POST', url: `/api/bots/${BOT}/computer/resources/import` })).toBe(false);
  });
  it('invalidates persisted grants when local UI authentication mode changes across a restart', async () => {
    const f = await fixture(); const cookie = await f.login(); await f.controller.dispose();
    const restarted = createTunnelAccessControl();
    await restarted.initialize({ connection: f.connection, validateBots: f.validateBots, passwordProtected: true });
    disposers.push(() => restarted.dispose());
    await restarted.setActiveTunnel({ publicUrl: 'https://bots.example.test', mode: 'managed-remote' });
    expect(restarted.getTunnelSessionFromRequest({ headers: { host: remote.Host, cookie } })).toBeNull();
  });
});
