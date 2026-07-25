import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import { ManagedRemoteTunnelTokenValidationError } from './managed-token.js';
import { createTunnelRoutesRuntime } from './routes.js';

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());

  const dependencies = {
    crypto: {},
    URL,
    tunnelService: { resolveActiveMode: vi.fn(), resolveActiveProvider: vi.fn() },
    tunnelProviderRegistry: { get: vi.fn(), listCapabilities: vi.fn(() => []) },
    tunnelAuthController: {},
    readSettingsFromDiskMigrated: vi.fn(),
    readManagedRemoteTunnelConfigFromDisk: vi.fn(),
    normalizeTunnelProvider: vi.fn(),
    normalizeTunnelMode: vi.fn(),
    normalizeOptionalPath: vi.fn(),
    normalizeManagedRemoteTunnelHostname: vi.fn((value) => value),
    normalizeTunnelBootstrapTtlMs: vi.fn(),
    normalizeTunnelSessionTtlMs: vi.fn(),
    isSupportedTunnelMode: vi.fn(),
    upsertManagedRemoteTunnelToken: vi.fn(async () => {
      throw new ManagedRemoteTunnelTokenValidationError();
    }),
    resolveManagedRemoteTunnelToken: vi.fn(),
    TUNNEL_MODE_QUICK: 'quick',
    TUNNEL_MODE_MANAGED_LOCAL: 'managed-local',
    TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare',
    TunnelServiceError: class TunnelServiceError extends Error {},
    getActivePort: vi.fn(),
    getRuntimeManagedRemoteTunnelHostname: vi.fn(),
    setRuntimeManagedRemoteTunnelHostname: vi.fn(),
    getRuntimeManagedRemoteTunnelToken: vi.fn(),
    setRuntimeManagedRemoteTunnelToken: vi.fn(),
    getActiveTunnelController: vi.fn(),
    setActiveTunnelController: vi.fn(),
    ...overrides,
  };
  const runtime = createTunnelRoutesRuntime(dependencies);
  runtime.registerRoutes(app);
  return app;
};

describe('tunnel routes', () => {
  it('returns a safe client error when a managed remote token is invalid', async () => {
    const response = await request(createApp())
      .put('/api/openchamber/tunnel/managed-remote-token')
      .send({
        presetId: 'production',
        presetName: 'Production',
        managedRemoteTunnelHostname: 'app.example.com',
        managedRemoteTunnelToken: 'invalid-secret-input',
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: 'Paste a raw Cloudflare tunnel token or a Cloudflare-generated connector command.',
    });
    expect(JSON.stringify(response.body)).not.toContain('invalid-secret-input');
  });

  it('waits for connector shutdown before revoking tunnel authentication', async () => {
    const order = [];
    const tunnelAuthController = {
      getActiveTunnelId: vi.fn(() => 'tunnel-1'),
      revokeTunnelArtifacts: vi.fn(() => {
        order.push('revoke');
        return { revokedBootstrapCount: 2, invalidatedSessionCount: 3 };
      }),
      clearActiveTunnel: vi.fn(() => {
        order.push('clear');
      }),
    };
    const tunnelService = {
      resolveActiveMode: vi.fn(),
      resolveActiveProvider: vi.fn(),
      stop: vi.fn(async () => {
        order.push('stop-start');
        await Promise.resolve();
        order.push('stop-finished');
      }),
    };

    const response = await request(createApp({
      tunnelService,
      tunnelAuthController,
      getActiveTunnelController: vi.fn(() => ({ provider: 'cloudflare' })),
    }))
      .post('/api/openchamber/tunnel/stop')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      revokedBootstrapCount: 2,
      invalidatedSessionCount: 3,
    });
    expect(order).toEqual(['stop-start', 'stop-finished', 'revoke', 'clear']);
  });

  it('keeps tunnel authentication active when connector shutdown fails', async () => {
    const tunnelAuthController = {
      getActiveTunnelId: vi.fn(() => 'tunnel-1'),
      revokeTunnelArtifacts: vi.fn(),
      clearActiveTunnel: vi.fn(),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(createApp({
        tunnelService: {
          resolveActiveMode: vi.fn(),
          resolveActiveProvider: vi.fn(),
          stop: vi.fn(async () => {
            throw new Error('cloudflared stayed alive');
          }),
        },
        tunnelAuthController,
        getActiveTunnelController: vi.fn(() => ({ provider: 'cloudflare' })),
      }))
        .post('/api/openchamber/tunnel/stop')
        .send({});

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        ok: false,
        error: 'cloudflared stayed alive',
        code: 'tunnel_stop_failed',
      });
      expect(tunnelAuthController.revokeTunnelArtifacts).not.toHaveBeenCalled();
      expect(tunnelAuthController.clearActiveTunnel).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
