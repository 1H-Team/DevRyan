import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerStartupRuntime } from './server-startup-runtime.js';

describe('server startup runtime', () => {
  let server;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    server = null;
    vi.restoreAllMocks();
  });

  it('awaits cold OpenCode bootstrap before launching the startup tunnel', async () => {
    const order = [];
    let runtimeReady = false;
    server = http.createServer((_req, res) => res.end('ok'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const runtime = createServerStartupRuntime({
      process: { env: {}, on: vi.fn(), send: vi.fn() },
      crypto: { randomUUID: vi.fn(() => 'tunnel-id') },
      server,
      normalizeTunnelBootstrapTtlMs: (value) => value,
      readSettingsFromDiskMigrated: vi.fn(async () => ({ tunnelBootstrapTtlMs: 60_000 })),
      tunnelAuthController: {
        setActiveTunnel: vi.fn(),
        issueBootstrapToken: vi.fn(() => ({ token: 'bootstrap-token' })),
      },
      bootstrapOpenCodeAtStartup: async () => {
        order.push('bootstrap-start');
        await Promise.resolve();
        runtimeReady = true;
        order.push('bootstrap-ready');
      },
      getRuntimeReady: () => runtimeReady,
      startTunnelWithNormalizedRequest: vi.fn(async () => {
        order.push('tunnel-start');
        return {
          publicUrl: 'https://app.example.com',
          mode: 'managed-remote',
        };
      }),
      gracefulShutdown: vi.fn(),
      getSignalsAttached: vi.fn(() => false),
      setSignalsAttached: vi.fn(),
      syncToHmrState: vi.fn(),
      TUNNEL_MODE_QUICK: 'quick',
      TUNNEL_MODE_MANAGED_LOCAL: 'managed-local',
      TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    });

    await runtime.startListeningAndMaybeTunnel({
      port: 0,
      bindHost: '127.0.0.1',
      startupTunnelRequest: {
        provider: 'cloudflare',
        mode: 'managed-remote',
        intent: 'managed',
        hostname: 'app.example.com',
        token: 'connector-token',
        originPort: 3000,
      },
    });

    expect(order).toEqual(['bootstrap-start', 'bootstrap-ready', 'tunnel-start']);
  });
});
