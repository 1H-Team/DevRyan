import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
  resolveHealthOpenCodeGeneration,
  resolveSharedJsonBodyLimit,
} from './core-routes.js';
import { createSupabaseConnection } from '../multi-user/supabase-connection.js';
import { createTunnelAccessControl } from '../tunnels/access-control.js';

describe('core-routes', () => {
  const createApp = ({ uiAuthController = null } = {}) => {
    const app = express();
    let shutdownOpts = null;
    const dependencies = {
      express,
      process,
      gracefulShutdown: vi.fn(async (opts) => {
        shutdownOpts = opts;
      }),
      getHealthSnapshot: () => ({
        status: 'ok',
        openCodeRunning: true,
      }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      serverStartedAt: '2026-01-01T00:00:00.000Z',
      runtimeInstanceId: 'instance-test-id',
      uiAuthController,
    };

    registerServerStatusRoutes(app, dependencies);

    return { app, dependencies, getShutdownOpts: () => shutdownOpts };
  };

  it('returns health JSON from the /api/health compatibility route', async () => {
    const { app } = createApp();

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.type).toBe('application/json');
    expect(response.body).toMatchObject({
      status: 'ok',
      openCodeRunning: true,
      devryanVersion: '1.0.0',
      openchamberVersion: '1.0.0',
    });
    expect(response.headers['x-devryan-instance-id']).toBe('instance-test-id');
    expect(response.text).not.toContain('<!doctype html>');
  });

  it('adds the OpenCode runtime generation and capability block to the health snapshot', async () => {
    const { app } = createApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.openCode).toEqual({
      generation: 2,
      runtimeIdentity: null,
      capabilities: { share: false, mcpOAuth: false, sessionShell: false, lsp: false, messageEdit: false },
    });
  });

  it('turns every capability off for a gen-2 runtime', async () => {
    const app = express();
    registerServerStatusRoutes(app, {
      express,
      process,
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ openCodeRunning: true, openCodeGeneration: 2, openCodeRuntimeIdentity: 'server:2' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      serverStartedAt: '2026-01-01T00:00:00.000Z',
      runtimeInstanceId: 'instance-test-id',
      uiAuthController: null,
    });
    const response = await request(app).get('/api/health');
    expect(response.body).toMatchObject({ openCodeRunning: true, openCodeGeneration: 2 });
    expect(response.body.openCode).toEqual({
      generation: 2,
      runtimeIdentity: 'server:2',
      capabilities: { share: false, mcpOAuth: false, sessionShell: false, lsp: false, messageEdit: false },
    });
  });

  it('enables MCP OAuth only for the ready owned native facade and clears it during replacement', async () => {
    const { app, dependencies } = createApp();
    let ready = true;
    dependencies.getHealthSnapshot = () => ({ openCodeRunning: true, openCodeGeneration: 2 });
    // The route captures dependencies at registration, so construct its owned surface directly.
    const nativeApp = express();
    registerServerStatusRoutes(nativeApp, { ...dependencies,
      getNativeRuntimeOwner: () => ({ isReady: () => ready, getConfigurationSnapshot: () => ({ locations: [] }),
        withIntegrationOperation: () => {}, credentialOperation: () => {}, credentialMetadata: () => {} }) });
    expect((await request(nativeApp).get('/health')).body.openCode.capabilities).toEqual({
      share: false, mcpOAuth: true, sessionShell: false, lsp: false, messageEdit: false,
    });
    ready = false;
    expect((await request(nativeApp).get('/health')).body.openCode.capabilities.mcpOAuth).toBe(false);
    expect((await request(app).get('/health')).body.openCode.generation).toBe(2);
  });

  it('resolves the reported generation from the observed runtime, then the external declaration', () => {
    expect(resolveHealthOpenCodeGeneration({ openCodeGeneration: 2 }, { DEVRYAN_OPENCODE_GENERATION: '1' })).toBe(2);
    expect(resolveHealthOpenCodeGeneration({}, { DEVRYAN_OPENCODE_GENERATION: '2' })).toBe(2);
    expect(resolveHealthOpenCodeGeneration({}, {})).toBe(2);
    expect(resolveHealthOpenCodeGeneration({ openCodeGeneration: 1 }, { DEVRYAN_OPENCODE_GENERATION: '2' })).toBeNull();
    expect(resolveHealthOpenCodeGeneration({ openCodeGeneration: 'x' }, {})).toBeNull();
    expect(resolveHealthOpenCodeGeneration({ openCodeGeneration: 'x' }, { DEVRYAN_OPENCODE_GENERATION: 'bad' })).toBeNull();
  });

  it.each([
    ['post', '/api/system/shutdown'],
    ['get', '/api/system/info'],
    ['get', '/api/system/free-port'],
  ])('rejects unauthenticated %s %s requests before the system handler', async (method, route) => {
    const uiAuthController = {
      authorizeSystemRequest: vi.fn((_req, res) => res.status(401).json({ error: 'Authentication required' })),
    };
    const { app, dependencies } = createApp({ uiAuthController });

    const response = await request(app)[method](route);

    expect(response.status).toBe(401);
    expect(uiAuthController.authorizeSystemRequest).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('allows shutdown requests without an origin header', async () => {
    const { app, dependencies, getShutdownOpts } = createApp();

    const response = await request(app).post('/api/system/shutdown');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(dependencies.gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(getShutdownOpts()).toEqual({ exitProcess: true });
  });

  it('allows same-origin shutdown requests', async () => {
    const { app, dependencies, getShutdownOpts } = createApp();

    const response = await request(app)
      .post('/api/system/shutdown')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', 'http://127.0.0.1:3001');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(dependencies.gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(getShutdownOpts()).toEqual({ exitProcess: true });
  });

  it('rejects foreign-origin shutdown requests without shutting down', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .post('/api/system/shutdown')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', 'https://example.com');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'Invalid origin' });
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('rejects shutdown in dev mode', async () => {
    const previous = process.env.DEVRYAN_DEV_MODE;
    process.env.DEVRYAN_DEV_MODE = 'true';
    try {
      const { app, dependencies } = createApp();
      const response = await request(app)
        .post('/api/system/shutdown')
        .set('Host', '127.0.0.1:3001')
        .set('Origin', 'http://127.0.0.1:3001');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ ok: false, error: 'Shutdown is disabled in dev mode' });
      expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
    } finally {
      if (typeof previous === 'undefined') {
        delete process.env.DEVRYAN_DEV_MODE;
      } else {
        process.env.DEVRYAN_DEV_MODE = previous;
      }
    }
  });

  it('rejects dev-shutdown when allow flag is not set', async () => {
    const previousShutdown = process.env.DEVRYAN_DEV_SHUTDOWN;
    const previousAllow = process.env.DEVRYAN_ALLOW_DEV_SHUTDOWN;
    process.env.DEVRYAN_DEV_SHUTDOWN = 'true';
    delete process.env.DEVRYAN_ALLOW_DEV_SHUTDOWN;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/system/dev-shutdown')
        .set('Host', '127.0.0.1:3001')
        .set('Origin', 'http://127.0.0.1:3001')
        .send({ previewUrls: [] });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ ok: false, error: 'Dev shutdown is disabled' });
    } finally {
      if (typeof previousShutdown === 'undefined') {
        delete process.env.DEVRYAN_DEV_SHUTDOWN;
      } else {
        process.env.DEVRYAN_DEV_SHUTDOWN = previousShutdown;
      }
      if (typeof previousAllow === 'undefined') {
        delete process.env.DEVRYAN_ALLOW_DEV_SHUTDOWN;
      } else {
        process.env.DEVRYAN_ALLOW_DEV_SHUTDOWN = previousAllow;
      }
    }
  });

  it('exposes dev flags on /api/system/info', async () => {
    const previousMode = process.env.DEVRYAN_DEV_MODE;
    const previousShutdown = process.env.DEVRYAN_DEV_SHUTDOWN;
    const previousAllow = process.env.DEVRYAN_ALLOW_DEV_SHUTDOWN;
    process.env.DEVRYAN_DEV_MODE = 'true';
    process.env.DEVRYAN_DEV_SHUTDOWN = 'true';
    process.env.DEVRYAN_ALLOW_DEV_SHUTDOWN = 'true';
    try {
      const { app } = createApp();
      const response = await request(app).get('/api/system/info');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        devryanVersion: '1.0.0',
        openchamberVersion: '1.0.0',
        devMode: true,
        devShutdownAllowed: true,
      });
    } finally {
      for (const [key, value] of [
        ['DEVRYAN_DEV_MODE', previousMode],
        ['DEVRYAN_DEV_SHUTDOWN', previousShutdown],
        ['DEVRYAN_ALLOW_DEV_SHUTDOWN', previousAllow],
      ]) {
        if (typeof value === 'undefined') {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe('common request middleware', () => {
  it.each([
    ['/api/behavior/rules', '1mb'],
    ['/api/config/apply', '16kb'],
    ['/api/session/ses_1/prompt_async', '50mb'],
    // Unlisted /api paths stay raw for the OpenCode proxy; body-reading routes
    // there mount their own parser (api-json-body-coverage.test.js).
    ['/api/session', null],
    ['/api/runtime-service/desktop-host', null],
    ['/api/provider/openai/oauth', null],
    ['/api/provider/openai/oauth/callback', null],
    ['/api/provider/openai/oauth-legacy', '50mb'],
    ['/auth/session', '50mb'],
  ])('resolves the shared JSON body limit for %s', (pathname, limit) => {
    expect(resolveSharedJsonBodyLimit(pathname)).toBe(limit);
  });

  it('leaves JSON and URL-encoded SIWC bodies raw for guarded route parsing', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/provider/openai/oauth/callback', (req, res) => res.json({ parsed: req.body !== undefined }));
    for (const [contentType, body] of [['application/json', '{'], ['application/x-www-form-urlencoded', 'value=fixture']]) {
      const response = await request(app).post('/api/provider/openai/oauth/callback').set('Content-Type', contentType).send(body);
      expect(response.status).toBe(200); expect(response.body).toEqual({ parsed: false });
    }
  });

  it.each([
    '/api/diagnostics/export',
    '/api/evidence/project',
    '/api/desktop/browser-leases',
    '/api/config/apply',
    '/api/config/apply/acknowledge-external',
    '/api/admin/users',
    '/api/bug-reports',
    '/api/error-logs',
  ])(
    'parses JSON request bodies for %s',
    async (route) => {
      const app = express();
      registerCommonRequestMiddleware(app, { express });
      app.post(route, (req, res) => res.json(req.body));

      const response = await request(app)
        .post(route)
        .send({ directory: '/tmp/project', enabled: true });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ directory: '/tmp/project', enabled: true });
    },
  );

  it('caps private browser lease request bodies at 16 KiB', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/desktop/browser-leases', (req, res) => res.json(req.body));

    const response = await request(app)
      .post('/api/desktop/browser-leases')
      .send({ directory: `/${'x'.repeat(17 * 1024)}` });

    expect(response.status).toBe(413);
  });

  it('caps configuration apply request bodies at 16 KiB', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/config/apply', (req, res) => res.json(req.body));

    const response = await request(app)
      .post('/api/config/apply')
      .send({ mode: 'when-idle', padding: 'x'.repeat(17 * 1024) });

    expect(response.status).toBe(413);
  });
});

describe('managed tunnel and invitation links', () => {
  const roots = []; const disposers = [];
  afterEach(async () => {
    for (const close of disposers.splice(0).reverse()) await close();
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  // The tunnel controller application.js uses, bound to the local owner as
  // with Supabase Off, with an active tunnel on the given public hostname.
  const createActiveTunnelController = async (mode, { now } = {}) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-core-routes-tunnel-')); roots.push(root);
    const connection = await createSupabaseConnection({
      config: { dataDirectory: root, configured: false, enabled: false },
      fetchImpl: () => { throw new Error('Cloud calls forbidden in this test'); },
    });
    disposers.push(() => connection.dispose());
    await connection.bootstrapLocalOwner();
    const controller = createTunnelAccessControl(now ? { now } : undefined);
    await controller.initialize({ connection }); disposers.push(() => controller.dispose());
    await controller.setActiveTunnel({ publicUrl: 'https://tunnel.example.com', mode });
    return controller;
  };
  it('preserves authentication middleware errors while instrumenting selection requests', async () => {
    const app = express();
    registerAuthAndAccessRoutes(app, {
      tunnelAuthController: { classifyRequestScope: () => 'local' },
      uiAuthController: { multiUser: false, requireAuth: (_req, _res, next) => next(new Error('fixture-auth-failure')) },
      readSettingsFromDiskMigrated: async () => ({}), normalizeTunnelSessionTtlMs: (value) => value,
    });
    app.post('/api/devryan/session-retention/selection', (_req, res) => res.json({ selected: true }));
    app.use((error, _req, res, _next) => res.status(503).json({ error: error.message }));
    const response = await request(app).post('/api/devryan/session-retention/selection');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'fixture-auth-failure' });
  });

  it('revokes tunnel grants before acknowledging a local authentication reset', async () => {
    const app = express(); const order = [];
    registerAuthAndAccessRoutes(app, {
      tunnelAuthController: { classifyRequestScope: () => 'local', revokeTunnelArtifacts: async () => { order.push('tunnels'); } },
      uiAuthController: { multiUser: false, requireAuth: (_req, _res, next) => next(),
        handleResetAuth: (_req, res) => { order.push('reset'); res.json({ ok: true }); } },
      readSettingsFromDiskMigrated: async () => ({}), normalizeTunnelSessionTtlMs: (value) => value,
    });
    expect((await request(app).post('/api/auth/reset')).status).toBe(200);
    expect(order).toEqual(['tunnels', 'reset']);
  });
  // The product's only tunnel controller, with the routes as application.js
  // composes them. The tunnel access boundary owns the POST link exchange
  // (tunnels/access-control.test.js); these GET routes reach the controller
  // directly, as a local request does.
  const createAuthApp = async ({ multiUser = true, now, readSettingsFromDiskMigrated } = {}) => {
    const app = express();
    const tunnelAuthController = await createActiveTunnelController('managed-remote', { now });
    const handleConnect = vi.fn((_req, res) => res.status(200).type('text/plain').send('invite'));
    const uiAuthController = {
      multiUser,
      handleConnect,
      prepareFreshTunnelLogin: vi.fn(async (_req, res) => {
        res.setHeader('Set-Cookie', 'oc_app_session=; Path=/; Max-Age=0');
      }),
      requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Authentication required' })),
    };

    registerAuthAndAccessRoutes(app, {
      tunnelAuthController,
      uiAuthController,
      readSettingsFromDiskMigrated: readSettingsFromDiskMigrated ?? vi.fn(async () => ({ tunnelSessionTtlMs: 60_000 })),
      normalizeTunnelSessionTtlMs: (value) => value,
    });

    return { app, tunnelAuthController, handleConnect, prepareFreshTunnelLogin: uiAuthController.prepareFreshTunnelLogin };
  };

  it('rejects shared-password auth and API access on a managed-remote hostname', async () => {
    const app = express();
    app.use(express.json());
    const tunnelAuthController = await createActiveTunnelController('managed-remote');
    const handleSessionStatus = vi.fn((_req, res) => (
      res.status(401).json({ authenticated: false, locked: true })
    ));
    const handleSessionCreate = vi.fn((_req, res) => res.json({ authenticated: true }));
    const requireAuth = vi.fn((_req, _res, next) => next());
    const uiAuthController = {
      enabled: true,
      multiUser: false,
      handleSessionStatus,
      handleSessionCreate,
      requireAuth,
    };

    registerAuthAndAccessRoutes(app, {
      tunnelAuthController,
      uiAuthController,
      readSettingsFromDiskMigrated: vi.fn(async () => ({ tunnelSessionTtlMs: 60_000 })),
      normalizeTunnelSessionTtlMs: (value) => value,
    });
    app.get('/api/direct-login-check', (_req, res) => res.json({ ok: true }));

    const status = await request(app)
      .get('/auth/session')
      .set('Host', 'tunnel.example.com');
    const login = await request(app)
      .post('/auth/session')
      .set('Host', 'tunnel.example.com')
      .send({ password: 'test-password' });
    const api = await request(app)
      .get('/api/direct-login-check')
      .set('Host', 'tunnel.example.com');

    expect(status.status).toBe(503);
    expect(status.body).toMatchObject({
      authenticated: false,
      locked: true,
      code: 'managed_account_auth_required',
    });
    expect(login.status).toBe(503);
    expect(login.body.code).toBe('managed_account_auth_required');
    expect(api.status).toBe(503);
    expect(api.body.code).toBe('managed_account_auth_required');
    expect(handleSessionStatus).not.toHaveBeenCalled();
    expect(handleSessionCreate).not.toHaveBeenCalled();
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it('uses managed-account login directly on a managed-remote hostname', async () => {
    const app = express();
    app.use(express.json());
    const tunnelAuthController = await createActiveTunnelController('managed-remote');
    const handleSessionStatus = vi.fn((_req, res) => (
      res.status(401).json({ authenticated: false, locked: true, mode: 'multi-user' })
    ));
    const handleSessionCreate = vi.fn((_req, res) => res.json({ authenticated: true }));
    const requireAuth = vi.fn((_req, _res, next) => next());
    const uiAuthController = {
      multiUser: true,
      handleSessionStatus,
      handleSessionCreate,
      requireAuth,
    };

    registerAuthAndAccessRoutes(app, {
      tunnelAuthController,
      uiAuthController,
      readSettingsFromDiskMigrated: vi.fn(async () => ({ tunnelSessionTtlMs: 60_000 })),
      normalizeTunnelSessionTtlMs: (value) => value,
    });
    app.get('/api/direct-login-check', (_req, res) => res.json({ ok: true }));

    const status = await request(app)
      .get('/auth/session')
      .set('Host', 'tunnel.example.com');
    const login = await request(app)
      .post('/auth/session')
      .set('Host', 'tunnel.example.com')
      .set('X-DevRyan-CSRF', '1')
      .send({ email: 'developer@example.com', password: 'test-password' });
    const api = await request(app)
      .get('/api/direct-login-check')
      .set('Host', 'tunnel.example.com');

    expect(status.status).toBe(401);
    expect(status.body).toMatchObject({ authenticated: false, locked: true, mode: 'multi-user' });
    expect(login.status).toBe(200);
    expect(api.body).toEqual({ ok: true });
    expect(handleSessionStatus).toHaveBeenCalledTimes(1);
    expect(handleSessionCreate).toHaveBeenCalledTimes(1);
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  const expectRefusedLink = (response) => {
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.text).toBe('Connection link is invalid or expired.');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
  };

  it('refuses a link exchanged by GET, sets no cookie and leaves the link usable', async () => {
    const { app, tunnelAuthController, handleConnect, prepareFreshTunnelLogin } = await createAuthApp();
    const { token } = await tunnelAuthController.issueBootstrapToken();

    expectRefusedLink(await request(app).get(`/tunnel/connect?t=${encodeURIComponent(token)}`));
    expect(tunnelAuthController.getBootstrapStatus().hasBootstrapToken).toBe(true);
    expect(handleConnect).not.toHaveBeenCalled();
    expect(prepareFreshTunnelLogin).not.toHaveBeenCalled();
  });

  it('does not sign the browser out for an invalid connection link', async () => {
    const { app, prepareFreshTunnelLogin } = await createAuthApp();

    expectRefusedLink(await request(app).get('/tunnel/connect?t=invalid-token'));

    expect(prepareFreshTunnelLogin).not.toHaveBeenCalled();
  });

  it('refuses a link while no tunnel is active', async () => {
    const { app, tunnelAuthController } = await createAuthApp();
    const { token } = await tunnelAuthController.issueBootstrapToken();
    tunnelAuthController.suspendActiveTunnel();

    expectRefusedLink(await request(app).get(`/tunnel/connect?t=${encodeURIComponent(token)}`));
  });

  it('answers the exchange rate limit with 429 and Retry-After and sets no cookie', async () => {
    const { app } = await createAuthApp({ now: () => 1_800_000_000_000 });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expectRefusedLink(await request(app).get('/tunnel/connect?t=invalid-token'));
    }
    const limited = await request(app).get('/tunnel/connect?t=invalid-token');

    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(limited.text).toBe('Too many attempts. Please try again later.');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(limited.headers['set-cookie']).toBeUndefined();
  });

  it('answers 500 without exchanging when settings cannot be read', async () => {
    const { app } = await createAuthApp({
      readSettingsFromDiskMigrated: vi.fn(async () => { throw new Error('settings unavailable'); }),
    });

    const response = await request(app).get('/tunnel/connect?t=invalid-token');

    expect(response.status).toBe(500);
    expect(response.text).toBe('Failed to process connect request.');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('keeps canonical invitation links in the invitation flow', async () => {
    const { app, handleConnect } = await createAuthApp();

    const response = await request(app).get('/invite?t=invite-token');

    expect(response.status).toBe(200);
    expect(response.text).toBe('invite');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it('keeps an old tunnel link in the tunnel flow and never reinterprets it as an invitation', async () => {
    const { app, tunnelAuthController, handleConnect } = await createAuthApp();
    const { token } = await tunnelAuthController.issueBootstrapToken();

    expectRefusedLink(await request(app).get(`/connect?t=${encodeURIComponent(token)}`));
    expectRefusedLink(await request(app).get(`/connect?t=${encodeURIComponent(token)}`));
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it('keeps a used tunnel link at /connect in the tunnel flow, never the invitation flow', async () => {
    const { app, tunnelAuthController, handleConnect } = await createAuthApp();
    const { token } = await tunnelAuthController.issueBootstrapToken();
    // Use the link the way the tunnel access boundary does: a same-origin POST.
    const headers = {};
    const exchanged = await tunnelAuthController.exchangeBootstrapToken({
      req: { method: 'POST', headers: { host: 'tunnel.example.com', origin: 'https://tunnel.example.com', 'x-devryan-csrf': '1' } },
      res: { getHeader: (name) => headers[name], setHeader: (name, value) => { headers[name] = value; } },
      token,
    });
    expect(exchanged.ok).toBe(true);
    expect(tunnelAuthController.getBootstrapStatus().hasBootstrapToken).toBe(false);

    expectRefusedLink(await request(app).get(`/connect?t=${encodeURIComponent(token)}`));
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it('dispatches an old invitation link to the invitation flow', async () => {
    const { app, handleConnect } = await createAuthApp();

    const response = await request(app).get('/connect?t=legacy-invite-token');

    expect(response.status).toBe(200);
    expect(response.text).toBe('invite');
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it('answers an old link as a tunnel link outside multi-user mode', async () => {
    const { app, handleConnect } = await createAuthApp({ multiUser: false });

    expectRefusedLink(await request(app).get('/connect?t=legacy-invite-token'));
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it('keeps tunnel bootstrap required when a request forges a local forwarded host', async () => {
    const app = express();
    // Mirrors packages/web/server/index.js. With `trust proxy` enabled Express
    // reports req.hostname from the client-supplied X-Forwarded-Host header, so
    // this is the configuration the spoof would be mounted against.
    app.set('trust proxy', true);
    const tunnelAuthController = await createActiveTunnelController('quick');
    const handleSessionStatus = vi.fn((_req, res) => res.json({ authenticated: true }));

    registerAuthAndAccessRoutes(app, {
      // A single-user install: the multi-user short-circuit is absent here, and
      // so is the Supabase boundary that otherwise masks a misclassification.
      uiAuthController: { multiUser: false, handleSessionStatus },
      tunnelAuthController,
      readSettingsFromDiskMigrated: vi.fn(async () => ({ tunnelSessionTtlMs: 60_000 })),
      normalizeTunnelSessionTtlMs: (value) => value,
    });

    const response = await request(app)
      .get('/auth/session')
      .set('Host', 'tunnel.example.com')
      .set('X-Forwarded-Host', 'localhost')
      .set('X-Forwarded-For', '203.0.113.9');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ authenticated: false, tunnelLocked: true });
    expect(handleSessionStatus).not.toHaveBeenCalled();
  });
});
