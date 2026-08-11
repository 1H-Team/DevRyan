import { describe, expect, it, vi } from 'vitest';
import express from 'express';

import request from '../../test-supertest.js';
import { createBrowserCdpDiscoveryRuntime } from '../browser-cdp/discovery-runtime.js';
import { createBrowserLeaseRuntime } from '../browser-cdp/lease-runtime.js';
import { createBootstrapRuntime } from './bootstrap-runtime.js';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
} from './core-routes.js';
import { createTunnelAuth } from './tunnel-auth.js';

const PRIVATE_TOKEN = 'private-browser-token';
const LEASE_SCOPE = {
  opencodeSessionID: 'ses_child',
  messageID: 'msg_turn',
  directory: '/workspace',
  agent: 'builder',
};

const createTestApp = ({ desktopCallbacks = true } = {}) => {
  const app = express();
  const requireAuth = vi.fn((_req, res) => (
    res.status(401).json({ error: 'Authentication required' })
  ));
  const multiUserRuntime = {
    enabled: true,
    authController: {
      enabled: false,
      multiUser: true,
      requireAuth,
    },
  };
  const getDiscoveryToken = () => (desktopCallbacks ? PRIVATE_TOKEN : '');
  const browserLeaseRuntime = createBrowserLeaseRuntime({
    getDiscoveryToken,
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic internal' }),
    fetchImpl: vi.fn(async (url) => {
      const sessionID = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      const session = sessionID === 'ses_child'
        ? { id: 'ses_child', parentID: 'ses_root' }
        : { id: 'ses_root' };
      return {
        ok: true,
        status: 200,
        json: async () => session,
      };
    }),
    createLeaseID: () => 'dvr_lease_test',
    createFence: () => 'dvr_lease_fence_test',
    createBrowserLease: desktopCallbacks
      ? vi.fn(async () => ({
          wsUrl: 'ws://127.0.0.1:54321/devtools/page/private-capability',
        }))
      : null,
  });
  const browserCdpDiscoveryRuntime = createBrowserCdpDiscoveryRuntime({
    getBridgeStatus: desktopCallbacks
      ? () => ({
          state: 'ready',
          wsUrl: 'ws://127.0.0.1:54321/devtools/page/private-capability',
        })
      : null,
    getDiscoveryToken,
  });
  const bootstrapRuntime = createBootstrapRuntime({
    createUiAuth: () => ({ enabled: false }),
    registerServerStatusRoutes: () => {},
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes: () => {},
    registerNotificationRoutes: () => {},
    registerOpenChamberRoutes: () => {},
    express,
  });

  bootstrapRuntime.setupBaseRoutes(app, {
    tunnelAuthController: createTunnelAuth(),
    readSettingsFromDiskMigrated: vi.fn(async () => ({})),
    normalizeTunnelSessionTtlMs: (value) => value,
    sessionRuntime: {
      getSessionActivitySnapshot: vi.fn(),
      getSessionStateSnapshot: vi.fn(),
      getSessionAttentionSnapshot: vi.fn(),
      getSessionState: vi.fn(),
      getSessionAttentionState: vi.fn(),
      markSessionViewed: vi.fn(),
      markSessionUnviewed: vi.fn(),
      markUserMessageSent: vi.fn(),
    },
    multiUserRuntime,
    registerPrivateCapabilityRoutes: (privateApp) => {
      browserCdpDiscoveryRuntime.attach(privateApp);
      browserLeaseRuntime.attach(privateApp);
    },
  });
  app.get('/api/regular', (_req, res) => res.json({ ok: true }));

  return { app, requireAuth };
};

describe('base route bootstrap', () => {
  it('registers private browser capability routes before multi-user API authentication', async () => {
    const { app, requireAuth } = createTestApp();

    const discovery = await request(app)
      .get('/api/desktop/browser-cdp')
      .set('Authorization', `Bearer ${PRIVATE_TOKEN}`);
    const acquired = await request(app)
      .post('/api/desktop/browser-leases')
      .set('Authorization', `Bearer ${PRIVATE_TOKEN}`)
      .send(LEASE_SCOPE);
    const missingBearer = await request(app)
      .post('/api/desktop/browser-leases')
      .send(LEASE_SCOPE);
    const wrongBearer = await request(app)
      .post('/api/desktop/browser-leases')
      .set('Authorization', 'Bearer wrong-token')
      .send(LEASE_SCOPE);

    expect(discovery.status).toBe(200);
    expect(discovery.body).toMatchObject({ state: 'ready' });
    expect(acquired.status).toBe(200);
    expect(acquired.body).toMatchObject({
      leaseId: 'dvr_lease_test',
      created: true,
    });
    expect(missingBearer.status).toBe(401);
    expect(missingBearer.body).toEqual({
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    expect(wrongBearer.status).toBe(401);
    expect(wrongBearer.body).toEqual({
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    expect(requireAuth).not.toHaveBeenCalled();

    const regular = await request(app).get('/api/regular');
    expect(regular.status).toBe(401);
    expect(regular.body).toEqual({ error: 'Authentication required' });
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  it('keeps private browser routes unavailable without Electron callbacks', async () => {
    const { app, requireAuth } = createTestApp({ desktopCallbacks: false });

    const discovery = await request(app)
      .get('/api/desktop/browser-cdp')
      .set('Authorization', `Bearer ${PRIVATE_TOKEN}`);
    const lease = await request(app)
      .post('/api/desktop/browser-leases')
      .set('Authorization', `Bearer ${PRIVATE_TOKEN}`)
      .send(LEASE_SCOPE);

    expect(discovery.status).toBe(404);
    expect(lease.status).toBe(404);
    expect(requireAuth).not.toHaveBeenCalled();
  });
});
