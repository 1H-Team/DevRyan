import { createNativeConsumerFixture } from '../opencode/test-native-consumer-client.js';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import { assertManagedQuotaCredential } from './credentials/providers.js';
import { createOpenCodeZenDeviceFlows, OpenCodeZenCredentialError } from './providers/opencode.js';
import { registerQuotaRoutes } from './routes.js';

const zenCredential = {
  orgId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y',
  accessToken: 'sess_old-secret',
  refreshToken: 'rt_old-secret',
  accessTokenExpiresAt: 1_789_000_000_000,
};

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify(payload),
});

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

  it('refuses pasted OpenCode Zen credentials and points at device sign-in', async () => {
    const { app, runtime } = createApp();
    const legacy = { workspaceId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y', authCookie: 'pasted-secret' };
    for (const response of [
      await request(app).put('/api/quota/credentials/opencode').send(legacy).expect(400),
      await request(app).post('/api/quota/credentials/opencode/validate').send(legacy).expect(400),
    ]) {
      expect(response.body.code).toBe('SIGN_IN_REQUIRED');
      expect(JSON.stringify(response.body)).not.toContain('pasted-secret');
    }
    expect(runtime.validate).not.toHaveBeenCalled();
    expect(runtime.writeCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['AUTHENTICATION_FAILED', 400],
    ['WORKSPACE_INACCESSIBLE', 400],
    ['PARSE_ERROR', 502],
    ['API_ERROR', 502],
    ['TIMEOUT', 504],
  ])('preserves stored Zen validation category %s and retains the saved credential', async (code, httpStatus) => {
    const saved = { ...zenCredential };
    const { app, runtime } = createApp({
      readCredential: vi.fn(() => saved),
      validate: vi.fn(async () => { throw new OpenCodeZenCredentialError(code); }),
    });
    const response = await request(app).post('/api/quota/credentials/opencode/validate').send({}).expect(httpStatus);
    expect(response.body.code).toBe(code);
    expect(response.body.error).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toMatch(/sess_|rt_/);
    expect(runtime.writeCredential).not.toHaveBeenCalled();
    expect(runtime.readCredential('opencode')).toBe(saved);
  });

  it('runs device sign-in without exposing the device code and saves only an approved, readable workspace', async () => {
    let tokenCalls = 0;
    const written = [];
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/auth/device/code')) {
        return jsonResponse({
          device_code: 'device-secret',
          user_code: 'PPSQ-ZZSW',
          verification_uri: '/console/device',
          verification_uri_complete: '/console/device?user_code=PPSQ-ZZSW&client_id=devryan',
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith('/auth/device/token')) {
        tokenCalls += 1;
        return tokenCalls === 1
          ? jsonResponse({ _tag: 'DeviceTokenError', error: 'authorization_pending', error_description: 'x' }, 400)
          : jsonResponse({ access_token: 'sess_new', refresh_token: 'rt_new', token_type: 'Bearer', expires_in: 3600, org_id: zenCredential.orgId });
      }
      if (url.includes('/api/billing/status')) return jsonResponse({ balanceMicroCents: '100000000', availableMicroCents: '100000000' });
      if (url.includes('/api/usage/summary')) return jsonResponse({ totalCostMicroCents: '0' });
      throw new Error(`unexpected ${url}`);
    });
    let clock = 1_000_000;
    const deviceFlows = createOpenCodeZenDeviceFlows({
      fetchImpl,
      now: () => clock,
      randomUUID: () => 'flow-1',
      writeManagedCredential: (_providerId, credential) => written.push(credential),
    });
    const { app } = createApp({
      deviceFlows,
      getStatus: vi.fn(() => (written.length
        ? { configured: true, credentialKind: 'oauth', workspaceId: zenCredential.orgId, secretMasked: '••••••••' }
        : { configured: false })),
      getEffectiveSource: vi.fn(() => (written.length ? 'managed' : null)),
    });

    const started = await request(app).post('/api/quota/credentials/opencode/device/start').expect(200);
    expect(started.body).toEqual({
      flowId: 'flow-1',
      userCode: 'PPSQ-ZZSW',
      verificationUri: 'https://opencode.ai/console/device',
      verificationUriComplete: 'https://opencode.ai/console/device?user_code=PPSQ-ZZSW&client_id=devryan',
      expiresIn: 900,
      interval: 5,
    });
    expect(JSON.stringify(started.body)).not.toContain('device-secret');

    // Polling faster than the console interval never reaches the console.
    await request(app).post('/api/quota/credentials/opencode/device/poll').send({ flowId: 'flow-1' }).expect(200, { status: 'pending' });
    expect(tokenCalls).toBe(0);
    clock += 5_000;
    await request(app).post('/api/quota/credentials/opencode/device/poll').send({ flowId: 'flow-1' }).expect(200, { status: 'pending' });
    expect(tokenCalls).toBe(1);
    clock += 5_000;
    const approved = await request(app).post('/api/quota/credentials/opencode/device/poll').send({ flowId: 'flow-1' }).expect(200);
    expect(approved.body).toEqual({
      status: 'approved',
      credential: {
        configured: true,
        credentialKind: 'oauth',
        workspaceId: zenCredential.orgId,
        secretMasked: '••••••••',
        effectiveSource: 'managed',
      },
    });
    expect(written).toEqual([{
      orgId: zenCredential.orgId,
      accessToken: 'sess_new',
      refreshToken: 'rt_new',
      accessTokenExpiresAt: clock + 3_600_000,
    }]);
    expect(JSON.stringify(approved.body)).not.toMatch(/sess_new|rt_new|device-secret/);

    // A consumed flow cannot be replayed.
    const replay = await request(app).post('/api/quota/credentials/opencode/device/poll').send({ flowId: 'flow-1' }).expect(404);
    expect(replay.body.code).toBe('FLOW_NOT_FOUND');
  });

  it('cancels pending device sign-in and reports unknown flows', async () => {
    const deviceFlows = { start: vi.fn(), poll: vi.fn(async () => { throw new OpenCodeZenCredentialError('FLOW_NOT_FOUND'); }), cancel: vi.fn() };
    const { app } = createApp({ deviceFlows });
    await request(app).post('/api/quota/credentials/opencode/device/cancel').send({ flowId: 'flow-1' }).expect(200, { status: 'cancelled' });
    expect(deviceFlows.cancel).toHaveBeenCalledWith('flow-1');
    const response = await request(app).post('/api/quota/credentials/opencode/device/poll').send({ flowId: 'missing' }).expect(404);
    expect(response.body).toEqual({ code: 'FLOW_NOT_FOUND', error: 'This sign-in request expired. Start again.' });
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
      openCodeClient: createNativeConsumerFixture({
        baseUrl: 'http://127.0.0.1:4096',
        readFixture: (...args) => fetch(...args),
        headers: () => ({ Authorization: 'Basic redacted' }),
      }),
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
      .get('/api/session/session-a/context-usage?refreshSession=true&directory=%2Fworkspace')
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
      openCodeClient: createNativeConsumerFixture({
        baseUrl: 'http://127.0.0.1:4096',
        readFixture: (...args) => fetch(...args),
        headers: () => ({ Authorization: 'Basic redacted' }),
      }),
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
      openCodeClient: createNativeConsumerFixture({
        baseUrl: 'http://127.0.0.1:4096',
        readFixture: (...args) => fetch(...args),
        headers: () => ({ Authorization: 'Basic redacted' }),
      }),
      getQuotaProviders: async () => ({
        listConfiguredQuotaProviders,
        fetchQuotaForProvider: async () => ({}),
      }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:4096${requestPath}`,
      isExternalOpenCode: () => false,
    });

    const response = await request(app).get('/api/quota/providers?directory=%2Fworkspace').expect(200);
    expect(response.body).toEqual({ providers: ['claude'] });
    expect(listConfiguredQuotaProviders).toHaveBeenCalledWith({
      workingDirectory: '/workspace',
      isExternalRuntime: false,
      claudeProxyBaseUrl: 'http://127.0.0.1:55201/v1',
    });
    fetchSpy.mockRestore();
  });

  it('holds configured-provider discovery until the native runtime identity is ready, then fails closed', async () => {
    const notReady = () => Object.assign(new Error('The OpenCode runtime generation is unknown'), {
      name: 'OpenCodeClientError', code: 'opencode_generation_invalid', statusCode: 503,
    });
    const createClient = (readyAfterCalls) => {
      let calls = 0;
      return {
        generation: () => { calls += 1; if (calls <= readyAfterCalls) throw notReady(); return 2; },
        catalog: { providers: vi.fn(async () => ({ providers: [{ id: 'anthropic', options: { baseURL: 'http://127.0.0.1:55201/v1' } }] })) },
      };
    };
    const listConfiguredQuotaProviders = vi.fn(() => ['claude']);
    const register = (openCodeClient) => {
      const app = express();
      registerQuotaRoutes(app, {
        openCodeClient,
        getQuotaProviders: async () => ({ listConfiguredQuotaProviders, fetchQuotaForProvider: async () => ({}) }),
        isExternalOpenCode: () => false,
        runtimeReadinessHoldMs: 200,
        runtimeReadinessPollMs: 5,
      });
      return app;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // First ready: the identity becomes known while the request is held.
      const response = await request(register(createClient(3))).get('/api/quota/providers?directory=%2Fworkspace').expect(200);
      expect(response.body).toEqual({ providers: ['claude'] });
      expect(listConfiguredQuotaProviders).toHaveBeenCalledWith(expect.objectContaining({ claudeProxyBaseUrl: 'http://127.0.0.1:55201/v1' }));
      expect(errors).not.toHaveBeenCalled();
      // A runtime that never becomes ready still reports its failure after the bounded hold.
      const failed = await request(register(createClient(Number.POSITIVE_INFINITY))).get('/api/quota/providers?directory=%2Fworkspace').expect(503);
      expect(failed.body.error).toBe('The OpenCode runtime generation is unknown');
    } finally {
      errors.mockRestore();
    }
  });

  it('uses native profile inspection rather than proxy, PATH or quota CLI fallback',async()=>{
    const app=express();const getQuotaProviders=vi.fn(async()=>{throw new Error('must not discover ambient credentials');});const resolveClaudeCodeLaunch=vi.fn();
    const inspectClaude=vi.fn(async input=>{expect(input).toEqual({kind:'quota',directory:'/workspace'});return {providerId:'claude',ok:true,configured:true};});
    registerQuotaRoutes(app,{getQuotaProviders,getNativeRuntimeOwner:()=>({inspectClaude}),resolveClaudeCodeLaunch});
    expect((await request(app).get('/api/quota/claude?refresh=true&directory=%2Fworkspace').expect(200)).body).toEqual({providerId:'claude',ok:true,configured:true});
    expect(getQuotaProviders).not.toHaveBeenCalled();expect(resolveClaudeCodeLaunch).not.toHaveBeenCalled();
  });

  it('refuses revoked inspection authorization without leaking private credential errors',async()=>{
    const app=express();const getQuotaProviders=vi.fn();registerQuotaRoutes(app,{getQuotaProviders,getNativeRuntimeOwner:()=>({inspectClaude:async()=>{throw Object.assign(new Error('synthetic-private-token'),{code:'permission_denied',status:403});}})});
    const result=await request(app).get('/api/quota/anthropic').expect(403);expect(result.body.code).toBe('permission_denied');expect(JSON.stringify(result.body)).not.toContain('synthetic-private-token');expect(getQuotaProviders).not.toHaveBeenCalled();
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
      openCodeClient: createNativeConsumerFixture({
        baseUrl: 'http://127.0.0.1:4096',
        readFixture: (...args) => fetch(...args),
        headers: () => ({ Authorization: 'Basic redacted' }),
      }),
      getQuotaProviders: async () => ({
        listConfiguredQuotaProviders: () => [],
        fetchQuotaForProvider,
      }),
      buildOpenCodeUrl: () => 'http://remote.example/config/providers',
      isExternalOpenCode: () => true,
    });

    const response = await request(app).get('/api/quota/claude').expect(200);
    expect(response.body).toMatchObject({providerId:'claude',ok:false,errorCode:'native_claude_external_unavailable'});
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
