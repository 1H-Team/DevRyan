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
    normalizeManagedRemoteOriginPort: vi.fn((value) => (
      Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 3000
    )),
    isValidManagedRemoteOriginPort: vi.fn((value) => Number.isInteger(value) && value >= 1024 && value <= 65535),
    normalizeTunnelBootstrapTtlMs: vi.fn(),
    normalizeTunnelSessionTtlMs: vi.fn(),
    isSupportedTunnelMode: vi.fn(),
    upsertManagedRemoteTunnelToken: vi.fn(async () => {
      throw new ManagedRemoteTunnelTokenValidationError();
    }),
    resolveManagedRemoteTunnelToken: vi.fn(),
    resolveManagedRemoteTunnelPreset: vi.fn(async () => null),
    TUNNEL_MODE_QUICK: 'quick',
    TUNNEL_MODE_MANAGED_LOCAL: 'managed-local',
    TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare',
    TunnelServiceError: class TunnelServiceError extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    },
    getActivePort: vi.fn(),
    getRuntimeManagedRemoteTunnelHostname: vi.fn(),
    setRuntimeManagedRemoteTunnelHostname: vi.fn(),
    getRuntimeManagedRemoteTunnelToken: vi.fn(),
    setRuntimeManagedRemoteTunnelToken: vi.fn(),
    getActiveTunnelController: vi.fn(),
    setActiveTunnelController: vi.fn(),
    getRuntimeReady: vi.fn(() => true),
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

  it.each([
    ['managed_remote_origin_port_in_use', 409],
    ['managed_remote_public_unreachable', 502],
  ])('does not issue a bootstrap token when startup fails with %s', async (code, expectedStatus) => {
    const startupError = new Error('Managed tunnel startup failed safely');
    startupError.code = code;
    startupError.details = {
      cloudflareOriginUrl: 'http://127.0.0.1:3000',
      activeOriginUrl: 'http://127.0.0.1:57123',
    };
    const tunnelAuthController = {
      getActiveTunnelId: vi.fn(() => null),
      getActiveTunnelMode: vi.fn(() => null),
      clearActiveTunnel: vi.fn(),
      issueBootstrapToken: vi.fn(),
    };
    const tunnelService = {
      resolveActiveMode: vi.fn(() => null),
      resolveActiveProvider: vi.fn(() => null),
      getPublicUrl: vi.fn(() => null),
      start: vi.fn(async () => { throw startupError; }),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(createApp({
        crypto: { randomUUID: vi.fn(() => 'id') },
        tunnelService,
        tunnelAuthController,
        tunnelProviderRegistry: { get: vi.fn(() => ({})), listCapabilities: vi.fn(() => []) },
        readSettingsFromDiskMigrated: vi.fn(async () => ({})),
        readManagedRemoteTunnelConfigFromDisk: vi.fn(async () => ({ version: 2, tunnels: [] })),
        normalizeTunnelProvider: vi.fn(() => 'cloudflare'),
        normalizeTunnelMode: vi.fn((value) => value || 'quick'),
        normalizeTunnelBootstrapTtlMs: vi.fn((value) => value ?? 1800000),
        normalizeTunnelSessionTtlMs: vi.fn((value) => value ?? 28800000),
        isSupportedTunnelMode: vi.fn(() => true),
        upsertManagedRemoteTunnelToken: vi.fn(async () => {}),
        resolveManagedRemoteTunnelToken: vi.fn(async () => ''),
        getRuntimeManagedRemoteTunnelHostname: vi.fn(() => ''),
        getRuntimeManagedRemoteTunnelToken: vi.fn(() => ''),
        getActiveTunnelController: vi.fn(() => null),
        getManagedAccountLoginAvailable: vi.fn(() => true),
      }))
        .post('/api/openchamber/tunnel/start')
        .send({
          provider: 'cloudflare',
          mode: 'managed-remote',
          hostname: 'app.example.com',
          token: `eyJ${'x'.repeat(80)}`,
          originPort: 3000,
        });

      expect(response.status).toBe(expectedStatus);
      expect(response.body).toMatchObject({ ok: false, code });
      expect(response.body.details).toEqual({
        cloudflareOriginUrl: 'http://127.0.0.1:3000',
        activeOriginUrl: 'http://127.0.0.1:57123',
      });
      expect(tunnelAuthController.issueBootstrapToken).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('refreshes connector health before returning a degraded managed tunnel status', async () => {
    const refreshHealth = vi.fn(async () => ({ connectorState: 'degraded' }));
    const tunnelService = {
      refreshHealth,
      resolveActiveMode: vi.fn(() => 'managed-remote'),
      resolveActiveProvider: vi.fn(() => 'cloudflare'),
      getPublicUrl: vi.fn(() => 'https://app.example.com'),
      getProviderMetadata: vi.fn(() => ({
        connectorState: 'degraded',
        publicReachabilityVerified: false,
        publicReachabilityReason: 'cloudflare_error',
        lastPublicStatus: 530,
        originPort: 3000,
      })),
    };
    const tunnelAuthController = {
      listTunnelSessions: vi.fn(() => []),
      getActiveTunnelId: vi.fn(() => 'tunnel-1'),
      getActiveTunnelHost: vi.fn(() => 'app.example.com'),
      getActiveTunnelMode: vi.fn(() => 'managed-remote'),
      getBootstrapStatus: vi.fn(() => ({ hasBootstrapToken: false, bootstrapExpiresAt: null })),
      setActiveTunnel: vi.fn(),
    };

    const response = await request(createApp({
      tunnelService,
      tunnelAuthController,
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        tunnelMode: 'managed-remote',
        tunnelProvider: 'cloudflare',
        managedRemoteTunnelHostname: 'app.example.com',
      })),
      readManagedRemoteTunnelConfigFromDisk: vi.fn(async () => ({ version: 2, tunnels: [] })),
      normalizeTunnelMode: vi.fn(() => 'managed-remote'),
      normalizeTunnelProvider: vi.fn(() => 'cloudflare'),
      normalizeTunnelBootstrapTtlMs: vi.fn((value) => value ?? 1_800_000),
      normalizeTunnelSessionTtlMs: vi.fn((value) => value ?? 28_800_000),
      getActivePort: vi.fn(() => 57123),
      getRuntimeManagedRemoteTunnelToken: vi.fn(() => ''),
    })).get('/api/openchamber/tunnel/status');

    expect(response.status).toBe(200);
    expect(refreshHealth).toHaveBeenCalledWith({ maxAgeMs: 5000 });
    expect(response.body).toMatchObject({
      active: true,
      runtimeReady: true,
      connectReady: false,
      url: 'https://app.example.com',
      providerMetadata: {
        connectorState: 'degraded',
        publicReachabilityVerified: false,
        publicReachabilityReason: 'cloudflare_error',
        lastPublicStatus: 530,
      },
    });
  });

  it('keeps a legacy managed connector visible but not connect-ready without managed accounts', async () => {
    const tunnelService = {
      refreshHealth: vi.fn(async () => ({ connectorState: 'healthy' })),
      resolveActiveMode: vi.fn(() => 'managed-remote'),
      resolveActiveProvider: vi.fn(() => 'cloudflare'),
      getPublicUrl: vi.fn(() => 'https://app.example.com'),
      getProviderMetadata: vi.fn(() => ({
        connectorState: 'healthy',
        publicReachabilityVerified: true,
        originPort: 3000,
      })),
    };
    const tunnelAuthController = {
      listTunnelSessions: vi.fn(() => []),
      getActiveTunnelId: vi.fn(() => 'tunnel-1'),
      getActiveTunnelHost: vi.fn(() => 'app.example.com'),
      getActiveTunnelMode: vi.fn(() => 'managed-remote'),
      setActiveTunnel: vi.fn(),
    };
    const storedPreset = {
      id: 'production',
      name: 'Production',
      hostname: 'app.example.com',
      originPort: 3000,
      token: 'stored-secret-token',
    };

    const response = await request(createApp({
      tunnelService,
      tunnelAuthController,
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        tunnelMode: 'managed-remote',
        tunnelProvider: 'cloudflare',
        managedRemoteTunnelSelectedPresetId: 'production',
      })),
      readManagedRemoteTunnelConfigFromDisk: vi.fn(async () => ({ version: 2, tunnels: [storedPreset] })),
      normalizeTunnelMode: vi.fn(() => 'managed-remote'),
      normalizeTunnelProvider: vi.fn(() => 'cloudflare'),
      normalizeTunnelBootstrapTtlMs: vi.fn((value) => value ?? 1_800_000),
      normalizeTunnelSessionTtlMs: vi.fn((value) => value ?? 28_800_000),
      getActivePort: vi.fn(() => 57123),
      getRuntimeManagedRemoteTunnelToken: vi.fn(() => ''),
      getManagedAccountLoginAvailable: vi.fn(() => false),
    })).get('/api/openchamber/tunnel/status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      active: true,
      connectReady: false,
      policy: 'account-login',
      managedRemoteTunnelTokenPresetIds: ['production'],
      managedRemoteTunnelPresets: [{
        id: 'production',
        name: 'Production',
        hostname: 'app.example.com',
        originPort: 3000,
      }],
    });
    expect(response.text).not.toContain('stored-secret-token');
  });

  it('starts managed remote with direct account login and no bootstrap link', async () => {
    const tunnelService = {
      resolveActiveMode: vi.fn(() => null),
      resolveActiveProvider: vi.fn(() => null),
      getPublicUrl: vi.fn(() => null),
      start: vi.fn(async () => ({
        publicUrl: 'https://app.example.com',
        activeMode: 'managed-remote',
        provider: 'cloudflare',
        controllerReused: false,
        providerMetadata: { originPort: 3000 },
      })),
    };
    const tunnelAuthController = {
      getActiveTunnelId: vi.fn(() => null),
      getActiveTunnelMode: vi.fn(() => null),
      setActiveTunnel: vi.fn(),
      issueBootstrapToken: vi.fn(() => ({ token: 'bootstrap-token', expiresAt: 12345 })),
      listTunnelSessions: vi.fn(() => []),
    };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const response = await request(createApp({
        crypto: { randomUUID: vi.fn(() => 'tunnel-id') },
        tunnelService,
        tunnelAuthController,
        tunnelProviderRegistry: { get: vi.fn(() => ({})), listCapabilities: vi.fn(() => []) },
        readSettingsFromDiskMigrated: vi.fn(async () => ({})),
        readManagedRemoteTunnelConfigFromDisk: vi.fn(async () => ({ version: 2, tunnels: [] })),
        normalizeTunnelProvider: vi.fn(() => 'cloudflare'),
        normalizeTunnelMode: vi.fn((value) => value || 'quick'),
        normalizeTunnelBootstrapTtlMs: vi.fn((value) => value ?? 1_800_000),
        normalizeTunnelSessionTtlMs: vi.fn((value) => value ?? 28_800_000),
        isSupportedTunnelMode: vi.fn(() => true),
        upsertManagedRemoteTunnelToken: vi.fn(async () => {}),
        resolveManagedRemoteTunnelToken: vi.fn(async () => ''),
        getRuntimeManagedRemoteTunnelHostname: vi.fn(() => ''),
        getRuntimeManagedRemoteTunnelToken: vi.fn(() => ''),
        getActivePort: vi.fn(() => 57123),
        getManagedAccountLoginAvailable: vi.fn(() => true),
      }))
        .post('/api/openchamber/tunnel/start')
        .send({
          provider: 'cloudflare',
          mode: 'managed-remote',
          hostname: 'app.example.com',
          token: `eyJ${'x'.repeat(80)}`,
          originPort: 3000,
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        runtimeReady: true,
        connectReady: true,
        connectUrl: null,
        bootstrapExpiresAt: null,
        policy: 'account-login',
      });
      expect(tunnelAuthController.issueBootstrapToken).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('rejects managed remote before connector launch when managed accounts are not configured', async () => {
    const tunnelService = {
      resolveActiveMode: vi.fn(() => null),
      resolveActiveProvider: vi.fn(() => null),
      getPublicUrl: vi.fn(() => null),
      start: vi.fn(),
    };
    const tunnelAuthController = {
      getActiveTunnelId: vi.fn(() => null),
      getActiveTunnelMode: vi.fn(() => null),
      clearActiveTunnel: vi.fn(),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(createApp({
        tunnelService,
        tunnelAuthController,
        tunnelProviderRegistry: { get: vi.fn(() => ({})), listCapabilities: vi.fn(() => []) },
        readSettingsFromDiskMigrated: vi.fn(async () => ({})),
        readManagedRemoteTunnelConfigFromDisk: vi.fn(async () => ({ version: 2, tunnels: [] })),
        normalizeTunnelProvider: vi.fn(() => 'cloudflare'),
        normalizeTunnelMode: vi.fn(() => 'managed-remote'),
        isSupportedTunnelMode: vi.fn(() => true),
        getRuntimeManagedRemoteTunnelHostname: vi.fn(() => ''),
        getRuntimeManagedRemoteTunnelToken: vi.fn(() => ''),
      }))
        .post('/api/openchamber/tunnel/start')
        .send({
          provider: 'cloudflare',
          mode: 'managed-remote',
          hostname: 'app.example.com',
          token: `eyJ${'x'.repeat(80)}`,
          originPort: 3000,
        });

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'managed_account_auth_required',
      });
      expect(tunnelService.start).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(['quick', 'managed-local'])('keeps %s startup on one-time tunnel authentication', async (mode) => {
    const tunnelService = {
      resolveActiveMode: vi.fn(() => null),
      resolveActiveProvider: vi.fn(() => null),
      getPublicUrl: vi.fn(() => null),
      start: vi.fn(async () => ({
        publicUrl: 'https://ephemeral.example.com',
        activeMode: mode,
        provider: 'cloudflare',
        controllerReused: false,
        providerMetadata: {},
      })),
    };
    const tunnelAuthController = {
      getActiveTunnelId: vi.fn(() => null),
      getActiveTunnelMode: vi.fn(() => null),
      setActiveTunnel: vi.fn(),
      issueBootstrapToken: vi.fn(() => ({ token: 'bootstrap-token', expiresAt: 12345 })),
      listTunnelSessions: vi.fn(() => []),
    };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const response = await request(createApp({
        crypto: { randomUUID: vi.fn(() => 'tunnel-id') },
        tunnelService,
        tunnelAuthController,
        tunnelProviderRegistry: { get: vi.fn(() => ({})), listCapabilities: vi.fn(() => []) },
        readSettingsFromDiskMigrated: vi.fn(async () => ({})),
        readManagedRemoteTunnelConfigFromDisk: vi.fn(async () => ({ version: 2, tunnels: [] })),
        normalizeTunnelProvider: vi.fn(() => 'cloudflare'),
        normalizeTunnelMode: vi.fn((value) => value || 'quick'),
        normalizeTunnelBootstrapTtlMs: vi.fn((value) => value ?? 1_800_000),
        normalizeTunnelSessionTtlMs: vi.fn((value) => value ?? 28_800_000),
        isSupportedTunnelMode: vi.fn(() => true),
        resolveManagedRemoteTunnelToken: vi.fn(async () => ''),
        getRuntimeManagedRemoteTunnelHostname: vi.fn(() => ''),
        getRuntimeManagedRemoteTunnelToken: vi.fn(() => ''),
        getActivePort: vi.fn(() => 57123),
      }))
        .post('/api/openchamber/tunnel/start')
        .send({ provider: 'cloudflare', mode });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        connectUrl: 'https://ephemeral.example.com/tunnel/connect?t=bootstrap-token',
        bootstrapExpiresAt: 12345,
        policy: 'tunnel-gated',
      });
      expect(tunnelAuthController.issueBootstrapToken).toHaveBeenCalledTimes(1);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('returns runtime_not_ready without launching a connector or consuming configuration', async () => {
    const tunnelService = {
      resolveActiveMode: vi.fn(() => null),
      resolveActiveProvider: vi.fn(() => null),
      getPublicUrl: vi.fn(() => null),
      start: vi.fn(),
    };
    const upsertManagedRemoteTunnelToken = vi.fn();
    const response = await request(createApp({
      tunnelService,
      getRuntimeReady: vi.fn(() => false),
      tunnelProviderRegistry: { get: vi.fn(() => ({})), listCapabilities: vi.fn(() => []) },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      readManagedRemoteTunnelConfigFromDisk: vi.fn(async () => ({ version: 2, tunnels: [] })),
      normalizeTunnelProvider: vi.fn(() => 'cloudflare'),
      normalizeTunnelMode: vi.fn((value) => value || 'managed-remote'),
      normalizeTunnelBootstrapTtlMs: vi.fn((value) => value ?? 1_800_000),
      normalizeTunnelSessionTtlMs: vi.fn((value) => value ?? 28_800_000),
      isSupportedTunnelMode: vi.fn(() => true),
      upsertManagedRemoteTunnelToken,
      resolveManagedRemoteTunnelToken: vi.fn(async () => ''),
      getRuntimeManagedRemoteTunnelHostname: vi.fn(() => ''),
      getRuntimeManagedRemoteTunnelToken: vi.fn(() => ''),
    }))
      .post('/api/openchamber/tunnel/start')
      .send({
        provider: 'cloudflare',
        mode: 'managed-remote',
        hostname: 'app.example.com',
        token: `eyJ${'x'.repeat(80)}`,
        originPort: 3000,
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ok: false, code: 'runtime_not_ready' });
    expect(tunnelService.start).not.toHaveBeenCalled();
    expect(upsertManagedRemoteTunnelToken).not.toHaveBeenCalled();
  });
});
