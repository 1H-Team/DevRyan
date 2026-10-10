import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';
import { registerQuotaRoutes } from './routes.js';

const createApp = ({ principal, external = false, configured = true } = {}) => {
  const app = express();
  if (principal) app.use((req, _res, next) => { req.principal = principal; next(); });
  const status = { available: true, configured, source: 'codex-app-server', connectionId: configured ? 'usage-connection' : null,
    account: configured ? { email: 'usage@example.test', planType: 'plus' } : null, login: null };
  const connection = { status: vi.fn(() => status), isConfigured: () => configured,
    start: vi.fn(async method => ({ ...status, login: { flowId: 'flow', status: 'pending', method } })),
    cancel: vi.fn(async () => status), disconnect: vi.fn(async () => ({ ...status, configured: false })),
    fetchQuota: vi.fn(async () => ({ providerId: 'codex', ok: true, configured: true, source: 'codex-app-server', connectionId: 'usage-connection' })),
    close: vi.fn(async () => {}),
  };
  const nativeRead = vi.fn(async () => { throw new Error('must not read model account'); });
  const host = registerQuotaRoutes(app, { codexUsageConnection: connection, isExternalOpenCode: () => external,
    isProviderAdministrator: req => !req.principal || req.principal.role === 'admin',
    getNativeRuntimeOwner: () => ({ isReady: () => true,
      getConfigurationSnapshot: () => ({ locations: [{ directory: '/fixture', configuration: {} }] }),
      credentialMetadata: async () => [], readOpenAiAccountSelection: nativeRead,
      inspectClaude: async () => { throw Object.assign(new Error('absent'), { code: 'claude_credentials_missing' }); },
    }),
    getQuotaProviders: async () => ({ listConfiguredQuotaProviders: () => [], resolveProviderId: id => id,
      fetchQuotaForProvider: vi.fn() }),
  });
  return { app, connection, nativeRead, host };
};

describe('optional usage connection routes', () => {
  it('exposes safe account status, explicit methods, cancellation and independent disconnect', async () => {
    const { app, connection } = createApp();
    const read = await request(app).get('/api/quota/codex/connection').expect(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body.account.email).toBe('usage@example.test');
    await request(app).post('/api/quota/codex/connection/start').set('x-devryan-csrf', '1').send({ method: 'device' }).expect(200);
    expect(connection.start).toHaveBeenCalledWith('device');
    await request(app).post('/api/quota/codex/connection/cancel').set('x-devryan-csrf', '1').send({ flowId: 'flow' }).expect(200);
    expect(connection.cancel).toHaveBeenCalledWith('flow');
    await request(app).delete('/api/quota/codex/connection').set('x-devryan-csrf', '1').expect(200);
    expect(connection.disconnect).toHaveBeenCalledOnce();
  });
  it('rejects mutations without CSRF and managed developers or external runtimes before any connection work', async () => {
    const { app, connection } = createApp();
    await request(app).post('/api/quota/codex/connection/start').send({}).expect(403);
    expect(connection.start).not.toHaveBeenCalled();
    for (const options of [{ principal: { scope: 'managed', role: 'developer' } }, { external: true }]) {
      const f = createApp(options);
      await request(f.app).get('/api/quota/codex/connection').expect(403);
      await request(f.app).post('/api/quota/codex/connection/start').set('x-devryan-csrf', '1').send({}).expect(403);
      expect(f.connection.status).not.toHaveBeenCalled(); expect(f.connection.start).not.toHaveBeenCalled();
    }
  });
  it('rejects forwarded requests, public hosts and foreign origins before reading or launching a connection', async () => {
    for (const headers of [{ Host: 'public.example.test' }, { Forwarded: 'for=127.0.0.1' },
      { 'X-Forwarded-For': '127.0.0.1' }, { 'CF-Connecting-IP': '127.0.0.1' }, { Origin: 'https://other.example.test' }]) {
      const f = createApp();
      await request(f.app).get('/api/quota/codex/connection').set(headers).expect(403);
      await request(f.app).post('/api/quota/codex/connection/start').set(headers).set('x-devryan-csrf', '1')
        .set('Content-Type', 'application/json').send('{').expect(403);
      expect(f.connection.status).not.toHaveBeenCalled(); expect(f.connection.start).not.toHaveBeenCalled();
    }
  });
  it('uses the explicit source before native auth and discovers the provider once', async () => {
    const { app, connection, nativeRead, host } = createApp();
    expect((await request(app).get('/api/quota/providers').expect(200)).body.providers).toEqual(['codex']);
    const quota = await request(app).get('/api/quota/codex').expect(200);
    expect(quota.body.source).toBe('codex-app-server');
    expect(connection.fetchQuota).toHaveBeenCalledOnce(); expect(nativeRead).not.toHaveBeenCalled();
    await host.close(); expect(connection.close).toHaveBeenCalledOnce();
    const f = createApp({ principal: { scope: 'managed', role: 'developer' } });
    await request(f.app).get('/api/quota/codex').expect(403);
    expect(f.connection.fetchQuota).not.toHaveBeenCalled();
  });
});
