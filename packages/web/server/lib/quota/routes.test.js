import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('accepts the OpenCode Zen dashboard shape and never returns workspace or cookie values', async () => {
    const { app, runtime } = createApp({
      getStatus: vi.fn(() => ({
        configured: true,
        credentialKind: 'dashboard',
        secretMasked: '••••••••',
      })),
      getEffectiveSource: vi.fn(() => 'managed'),
    });
    const credential = {
      workspaceId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y',
      authCookie: 'signed-cookie',
    };
    const response = await request(app)
      .put('/api/quota/credentials/opencode')
      .send(credential)
      .expect(200);
    expect(runtime.validate).toHaveBeenCalledWith('opencode', credential);
    expect(runtime.writeCredential).toHaveBeenCalledWith('opencode', credential);
    expect(response.body).toEqual({
      configured: true,
      credentialKind: 'dashboard',
      secretMasked: '••••••••',
      effectiveSource: 'managed',
    });
    expect(JSON.stringify(response.body)).not.toContain('wrk_');
    expect(JSON.stringify(response.body)).not.toContain('signed-cookie');
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
  it('returns normalized provider context and enforces managed session ownership', async () => {
    const app = express();
    const ownsSession = vi.fn(async (_principal, sessionID) => sessionID === 'session-a');
    const fetchContextUsage = vi.fn(async () => ({
      ok: true,
      usage: {
        sessionID: 'session-a',
        status: 'available',
        source: 'meridian',
        inputTokens: 2,
        cacheReadTokens: 125220,
        cacheWriteTokens: 1818,
        activeInputTokens: 127040,
        lastOutputTokens: 1464,
        fetchedAt: 123,
      },
    }));
    app.use((req, _res, next) => {
      req.principal = { scope: 'managed', userId: 'user-a' };
      next();
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        providers: [{ id: 'anthropic', options: { baseURL: 'http://127.0.0.1:3456' } }],
      })),
    });
    registerQuotaRoutes(app, {
      getQuotaProviders: async () => ({
        listConfiguredQuotaProviders: () => [],
        fetchQuotaForProvider: async () => ({}),
      }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:4096${requestPath}`,
      isExternalOpenCode: () => false,
      ownsSession,
      claudeContextUsageClient: { fetchContextUsage },
    });

    const response = await request(app)
      .get('/api/session/session-a/context-usage?refreshSession=true')
      .expect(200);
    expect(response.body.activeInputTokens).toBe(127040);
    expect(fetchContextUsage).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'session-a',
      refreshSession: true,
    }));
    await request(app).get('/api/session/session-b/context-usage').expect(404);
    fetchSpy.mockRestore();
  });

  it('degrades context usage to the message fallback for external runtimes', async () => {
    const app = express();
    registerQuotaRoutes(app, {
      getQuotaProviders: async () => ({
        listConfiguredQuotaProviders: () => [],
        fetchQuotaForProvider: async () => ({}),
      }),
      isExternalOpenCode: () => true,
    });

    const response = await request(app).get('/api/session/session-a/context-usage').expect(200);
    expect(response.body).toMatchObject({
      sessionID: 'session-a',
      status: 'unavailable',
      source: 'message-fallback',
      activeInputTokens: 0,
    });
  });

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
    const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-quota-path-'));
    const claudeExecutable = path.join(binDirectory, 'claude');
    fs.writeFileSync(claudeExecutable, '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(claudeExecutable, 0o755);
    const resolveClaudeCodeLaunch = vi.fn(({ pathValue }) => ({
      executable: path.join(pathValue, 'claude'),
      pathValue,
      source: 'path',
    }));
    const fetchQuotaForProvider = vi.fn(async (_providerId, options) => ({
      providerId: 'claude',
      proxyBaseUrl: options.claudeProxyBaseUrl,
      forceRefresh: options.forceRefresh,
      isExternalRuntime: options.isExternalRuntime,
      claudeExecutable: options.claudeCodeLaunch?.executable,
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
      buildAugmentedPath: () => binDirectory,
      resolveClaudeCodeLaunch,
    });

    const response = await request(app).get('/api/quota/claude?refresh=true').expect(200);
    expect(response.body).toEqual({
      providerId: 'claude',
      proxyBaseUrl: 'http://127.0.0.1:55201',
      forceRefresh: true,
      isExternalRuntime: false,
      claudeExecutable,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/config/providers',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Basic redacted' }) }),
    );
    expect(resolveClaudeCodeLaunch).toHaveBeenCalledWith({ pathValue: binDirectory });
    fetchSpy.mockRestore();
    fs.rmSync(binDirectory, { recursive: true, force: true });
  });

  it('does not query or resolve a local proxy for external OpenCode', async () => {
    const app = express();
    const fetchQuotaForProvider = vi.fn(async (_providerId, options) => ({
      providerId: 'claude',
      proxyBaseUrl: options.claudeProxyBaseUrl,
      isExternalRuntime: options.isExternalRuntime,
      claudeCodeLaunch: options.claudeCodeLaunch,
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
      claudeCodeLaunch: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
