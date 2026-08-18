import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './core-routes.js';
import { createTunnelAuth } from './tunnel-auth.js';

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
      getHealthSnapshot: () => ({ status: 'ok' }),
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
    expect(response.body).toMatchObject({ status: 'ok' });
    expect(response.headers['x-devryan-instance-id']).toBe('instance-test-id');
    expect(response.text).not.toContain('<!doctype html>');
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
    const previous = process.env.OPENCHAMBER_DEV_MODE;
    process.env.OPENCHAMBER_DEV_MODE = 'true';
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
        delete process.env.OPENCHAMBER_DEV_MODE;
      } else {
        process.env.OPENCHAMBER_DEV_MODE = previous;
      }
    }
  });

  it('rejects dev-shutdown when allow flag is not set', async () => {
    const previousShutdown = process.env.OPENCHAMBER_DEV_SHUTDOWN;
    const previousAllow = process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN;
    process.env.OPENCHAMBER_DEV_SHUTDOWN = 'true';
    delete process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN;
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
        delete process.env.OPENCHAMBER_DEV_SHUTDOWN;
      } else {
        process.env.OPENCHAMBER_DEV_SHUTDOWN = previousShutdown;
      }
      if (typeof previousAllow === 'undefined') {
        delete process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN;
      } else {
        process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN = previousAllow;
      }
    }
  });

  it('exposes dev flags on /api/system/info', async () => {
    const previousMode = process.env.OPENCHAMBER_DEV_MODE;
    const previousShutdown = process.env.OPENCHAMBER_DEV_SHUTDOWN;
    const previousAllow = process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN;
    process.env.OPENCHAMBER_DEV_MODE = 'true';
    process.env.OPENCHAMBER_DEV_SHUTDOWN = 'true';
    process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN = 'true';
    try {
      const { app } = createApp();
      const response = await request(app).get('/api/system/info');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        devMode: true,
        devShutdownAllowed: true,
      });
    } finally {
      for (const [key, value] of [
        ['OPENCHAMBER_DEV_MODE', previousMode],
        ['OPENCHAMBER_DEV_SHUTDOWN', previousShutdown],
        ['OPENCHAMBER_ALLOW_DEV_SHUTDOWN', previousAllow],
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
  const createAuthApp = ({ multiUser = true, prepareFreshTunnelLogin, getRuntimeReady } = {}) => {
    const app = express();
    const tunnelAuthController = createTunnelAuth();
    const handleConnect = vi.fn((_req, res) => res.status(200).type('text/plain').send('invite'));
    const uiAuthController = {
      multiUser,
      handleConnect,
      prepareFreshTunnelLogin: prepareFreshTunnelLogin ?? vi.fn(async (_req, res) => {
        res.setHeader('Set-Cookie', 'oc_app_session=; Path=/; Max-Age=0');
      }),
      requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Authentication required' })),
    };

    registerAuthAndAccessRoutes(app, {
      tunnelAuthController,
      uiAuthController,
      readSettingsFromDiskMigrated: vi.fn(async () => ({ tunnelSessionTtlMs: 60_000 })),
      normalizeTunnelSessionTtlMs: (value) => value,
      getRuntimeReady: getRuntimeReady ?? vi.fn(() => true),
    });

    tunnelAuthController.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example.com',
      mode: 'managed-remote',
    });

    return { app, tunnelAuthController, handleConnect, prepareFreshTunnelLogin: uiAuthController.prepareFreshTunnelLogin };
  };

  it('rejects shared-password auth and API access on a managed-remote hostname', async () => {
    const app = express();
    app.use(express.json());
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example.com',
      mode: 'managed-remote',
    });
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
      getRuntimeReady: vi.fn(() => true),
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
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example.com',
      mode: 'managed-remote',
    });
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
      getRuntimeReady: vi.fn(() => true),
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

  it('exchanges a canonical tunnel link in multi-user mode without invoking invitations', async () => {
    const { app, tunnelAuthController, handleConnect, prepareFreshTunnelLogin } = createAuthApp();
    const { token } = tunnelAuthController.issueBootstrapToken({ ttlMs: 60_000 });

    const response = await request(app).get(`/tunnel/connect?t=${encodeURIComponent(token)}`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('oc_app_session='),
      expect.stringContaining('oc_tunnel_session='),
    ]));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(handleConnect).not.toHaveBeenCalled();
    expect(prepareFreshTunnelLogin).toHaveBeenCalledTimes(1);
  });

  it('does not sign the browser out for an invalid connection link', async () => {
    const prepareFreshTunnelLogin = vi.fn();
    const { app } = createAuthApp({ prepareFreshTunnelLogin });

    await request(app).get('/tunnel/connect?t=invalid-token').expect(401);

    expect(prepareFreshTunnelLogin).not.toHaveBeenCalled();
  });

  it('returns a retryable 503 and preserves the token when fresh-login cleanup fails', async () => {
    const prepareFreshTunnelLogin = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('vault unavailable'), { code: 'fresh_login_cleanup_failed' }))
      .mockResolvedValueOnce(undefined);
    const { app, tunnelAuthController } = createAuthApp({ prepareFreshTunnelLogin });
    const { token } = tunnelAuthController.issueBootstrapToken({ ttlMs: 60_000 });

    const failed = await request(app).get(`/tunnel/connect?t=${encodeURIComponent(token)}`).expect(503);
    expect(failed.headers['retry-after']).toBe('5');
    expect(tunnelAuthController.getBootstrapStatus().hasBootstrapToken).toBe(true);

    await request(app).get(`/tunnel/connect?t=${encodeURIComponent(token)}`).expect(302);
    expect(prepareFreshTunnelLogin).toHaveBeenCalledTimes(2);
  });

  it('pauses token exchange until authoritative runtime readiness returns', async () => {
    let ready = false;
    const prepareFreshTunnelLogin = vi.fn();
    const { app, tunnelAuthController } = createAuthApp({
      prepareFreshTunnelLogin,
      getRuntimeReady: () => ready,
    });
    const { token } = tunnelAuthController.issueBootstrapToken({ ttlMs: 60_000 });

    const starting = await request(app).get(`/tunnel/connect?t=${encodeURIComponent(token)}`).expect(503);
    expect(starting.headers['retry-after']).toBe('2');
    expect(prepareFreshTunnelLogin).not.toHaveBeenCalled();
    expect(tunnelAuthController.getBootstrapStatus().hasBootstrapToken).toBe(true);

    ready = true;
    await request(app).get(`/tunnel/connect?t=${encodeURIComponent(token)}`).expect(302);
    expect(prepareFreshTunnelLogin).toHaveBeenCalledTimes(1);
  });

  it('keeps canonical invitation links in the invitation flow', async () => {
    const { app, handleConnect } = createAuthApp();

    const response = await request(app).get('/invite?t=invite-token');

    expect(response.status).toBe(200);
    expect(response.text).toBe('invite');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it('recognizes an old tunnel link and never reinterprets a consumed token as an invitation', async () => {
    const { app, tunnelAuthController, handleConnect } = createAuthApp();
    const { token } = tunnelAuthController.issueBootstrapToken({ ttlMs: 60_000 });

    const firstResponse = await request(app).get(`/connect?t=${encodeURIComponent(token)}`);
    const secondResponse = await request(app).get(`/connect?t=${encodeURIComponent(token)}`);

    expect(firstResponse.status).toBe(302);
    expect(secondResponse.status).toBe(401);
    expect(secondResponse.text).toContain('invalid or expired');
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it('dispatches an old invitation link to the invitation flow', async () => {
    const { app, handleConnect } = createAuthApp();

    const response = await request(app).get('/connect?t=legacy-invite-token');

    expect(response.status).toBe(200);
    expect(response.text).toBe('invite');
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });
});
