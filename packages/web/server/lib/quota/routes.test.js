import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import { assertManagedQuotaCredential } from './credentials/providers.js';
import { registerQuotaRoutes } from './routes.js';

const createApp = (overrides = {}) => {
  const app = express();
  let stored = null;
  const runtime = {
    assertCredential: assertManagedQuotaCredential,
    deleteCredential: vi.fn(() => { stored = null; }),
    getStatus: vi.fn(() => stored
      ? { configured: true, credentialKind: stored.sessionToken ? 'dashboard' : 'cookie', secretMasked: '••••••••' }
      : { configured: false }),
    importCursorCredential: vi.fn(() => ({ accessToken: 'imported' })),
    readCredential: vi.fn(() => stored),
    writeCredential: vi.fn((_providerId, credential) => { stored = credential; }),
    validate: vi.fn(async (_providerId, credential) => credential),
    getEffectiveSource: vi.fn(() => stored ? 'managed' : 'legacy'),
    ...overrides,
  };
  registerQuotaRoutes(app, {
    getQuotaProviders: async () => ({
      listConfiguredQuotaProviders: () => [],
      fetchQuotaForProvider: async () => ({}),
    }),
    credentialRuntime: runtime,
  });
  return { app, runtime };
};

describe('managed quota credential routes', () => {
  it('returns safe managed status while reporting a fallback source separately', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/quota/credentials/cursor').expect(200);
    expect(response.body).toEqual({ configured: false, effectiveSource: 'legacy' });
    expect(JSON.stringify(response.body)).not.toContain('token');
  });

  it('validates before an atomic managed write and returns no secret', async () => {
    const order = [];
    const { app, runtime } = createApp({
      validate: vi.fn(async (_providerId, credential) => {
        order.push('validate');
        return credential;
      }),
      writeCredential: vi.fn((_providerId, credential) => {
        order.push('write');
        runtime.getStatus.mockReturnValue({
          configured: true,
          credentialKind: 'cookie',
          secretMasked: '••••••••',
        });
        runtime.getEffectiveSource.mockReturnValue('managed');
        expect(credential).toEqual({ cookie: 'secret-cookie' });
      }),
    });

    const response = await request(app)
      .put('/api/quota/credentials/ollama-cloud')
      .send({ cookie: 'secret-cookie' })
      .expect(200);

    expect(order).toEqual(['validate', 'write']);
    expect(response.body).toEqual({
      configured: true,
      credentialKind: 'cookie',
      secretMasked: '••••••••',
      effectiveSource: 'managed',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-cookie');
  });

  it('does not write invalid credentials and emits stable error codes', async () => {
    const { app, runtime } = createApp({
      validate: vi.fn(async () => { throw new Error('remote included a secret'); }),
    });
    const response = await request(app)
      .put('/api/quota/credentials/cursor-acp')
      .send({ sessionToken: 'secret' })
      .expect(400);
    expect(response.body).toEqual({ code: 'INVALID_CREDENTIAL', error: 'Credential validation failed' });
    expect(runtime.writeCredential).not.toHaveBeenCalled();

    await request(app)
      .get('/api/quota/credentials/not-a-provider')
      .expect(404, { code: 'UNSUPPORTED_PROVIDER', error: 'Unsupported credential provider' });
  });

  it('bounds credential bodies at the route and reports missing stored validation state', async () => {
    const { app } = createApp();
    await request(app)
      .put('/api/quota/credentials/ollama-cloud')
      .send({ cookie: 'x'.repeat(17 * 1024) })
      .expect(413, { code: 'PAYLOAD_TOO_LARGE', error: 'Credential payload is too large' });

    await request(app)
      .post('/api/quota/credentials/cursor-acp/validate')
      .send({})
      .expect(404, { code: 'NOT_CONFIGURED', error: 'Managed credential is not configured' });
  });

  it('allows import only for Cursor and validates before writing the imported copy', async () => {
    const { app, runtime } = createApp();
    await request(app)
      .post('/api/quota/credentials/ollama-cloud/import')
      .send({})
      .expect(404, { code: 'IMPORT_UNAVAILABLE', error: 'Credential import is unavailable' });

    await request(app)
      .post('/api/quota/credentials/cursor/import')
      .send({})
      .expect(200);
    expect(runtime.importCursorCredential).toHaveBeenCalledTimes(1);
    expect(runtime.validate).toHaveBeenCalledWith('cursor-acp', { accessToken: 'imported' });
    expect(runtime.writeCredential).toHaveBeenCalledWith('cursor-acp', { accessToken: 'imported' });
  });
});

describe('Claude quota runtime resolution', () => {
  it('uses the safe live Anthropic proxy for configured-provider discovery', async () => {
    const app = express();
    const listConfiguredQuotaProviders = vi.fn(() => ['claude']);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        providers: [{
          id: 'anthropic',
          options: { baseURL: 'http://127.0.0.1:55201/v1' },
        }],
      })),
    });
    registerQuotaRoutes(app, {
      getQuotaProviders: async () => ({
        listConfiguredQuotaProviders,
        fetchQuotaForProvider: async () => ({}),
      }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:4096${requestPath}`,
      isExternalOpenCode: () => false,
    });

    const response = await request(app).get('/api/quota/providers').expect(200);
    expect(response.body).toEqual({ providers: ['claude'] });
    expect(listConfiguredQuotaProviders).toHaveBeenCalledWith({
      workingDirectory: null,
      isExternalRuntime: false,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201/v1',
    });
    fetchSpy.mockRestore();
  });

  it('passes the active managed OpenCode Anthropic proxy URL to the provider', async () => {
    const app = express();
    const fetchQuotaForProvider = vi.fn(async (_providerId, options) => ({
      providerId: 'claude',
      proxyBaseUrl: options.claudeProxyBaseUrl,
      forceRefresh: options.forceRefresh,
      isExternalRuntime: options.isExternalRuntime,
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        providers: [{
          id: 'anthropic',
          options: { baseURL: 'http://127.0.0.1:55201' },
        }],
      })),
    });
    registerQuotaRoutes(app, {
      getQuotaProviders: async () => ({
        listConfiguredQuotaProviders: () => ['claude'],
        fetchQuotaForProvider,
      }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:4096${requestPath}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic redacted' }),
      isExternalOpenCode: () => false,
    });

    const response = await request(app).get('/api/quota/claude?refresh=true').expect(200);
    expect(response.body).toEqual({
      providerId: 'claude',
      proxyBaseUrl: 'http://127.0.0.1:55201',
      forceRefresh: true,
      isExternalRuntime: false,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/config/providers',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Basic redacted' }) }),
    );
    fetchSpy.mockRestore();
  });

  it('does not query or resolve a local proxy for external OpenCode', async () => {
    const app = express();
    const fetchQuotaForProvider = vi.fn(async (_providerId, options) => ({
      providerId: 'claude',
      proxyBaseUrl: options.claudeProxyBaseUrl,
      isExternalRuntime: options.isExternalRuntime,
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    registerQuotaRoutes(app, {
      getQuotaProviders: async () => ({
        listConfiguredQuotaProviders: () => [],
        fetchQuotaForProvider,
      }),
      buildOpenCodeUrl: () => 'http://remote.example/config/providers',
      isExternalOpenCode: () => true,
    });

    const response = await request(app).get('/api/quota/claude').expect(200);
    expect(response.body).toEqual({
      providerId: 'claude',
      proxyBaseUrl: null,
      isExternalRuntime: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
