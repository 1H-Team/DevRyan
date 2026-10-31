import { createNativeConsumerFixture } from '../opencode/test-native-consumer-client.js';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticSanitizer } from '@devryan/harness-runtime/lib/sanitizer.js';

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

// Claude usage is what Claude Code reports through the claude-agent provider. These
// fixtures pin whether the user's `claude` resolves instead of probing the host.
const claudeInstalled = (installed) => {
  if (!installed) {
    vi.stubEnv('DEVRYAN_CLAUDE_PATH', 'claude-not-installed');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-claude-quota-'));
  claudeFixtureRoots.push(root);
  const executable = path.join(root, 'claude');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  vi.stubEnv('DEVRYAN_CLAUDE_PATH', executable);
};
const claudeFixtureRoots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of claudeFixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const claudeAgentUsage = { windows: { five_hour: { utilization: 0.25, resetsAt: 1_790_000_000, status: 'allowed' } }, updatedAt: 123 };

describe('Claude quota runtime resolution', () => {
  it('answers context usage from the message fallback and enforces managed session ownership', async () => {
    const app = express();
    const ownsSession = vi.fn(async (_principal, sessionID) => sessionID === 'session-a');
    app.use((req, _res, next) => {
      req.principal = { scope: 'managed', userId: 'user-a' };
      next();
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const generation = vi.fn(() => 2);
    try {
      registerQuotaRoutes(app, {
        openCodeClient: { generation },
        getQuotaProviders: async () => ({
          listConfiguredQuotaProviders: () => [],
          fetchQuotaForProvider: async () => ({}),
        }),
        isExternalOpenCode: () => false,
        ownsSession,
      });

      const response = await request(app)
        .get('/api/session/session-a/context-usage?refreshSession=true&directory=%2Fworkspace')
        .expect(200);
      expect(response.body).toMatchObject({
        sessionID: 'session-a',
        status: 'unavailable',
        source: 'message-fallback',
        activeInputTokens: 0,
      });
      await request(app).get('/api/session/session-b/context-usage').expect(404);
      expect(ownsSession).toHaveBeenCalledTimes(2);
      // No proxy or runtime lookup backs the answer any more.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(generation).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
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

  it('lists configured providers without resolving an Anthropic proxy or waiting on the runtime identity', async () => {
    const app = express();
    const listConfiguredQuotaProviders = vi.fn(() => ['codex']);
    const generation = vi.fn(() => {
      throw Object.assign(new Error('The OpenCode runtime generation is unknown'), { code: 'opencode_generation_invalid', statusCode: 503 });
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      registerQuotaRoutes(app, {
        openCodeClient: { generation, catalog: { providers: vi.fn() } },
        getQuotaProviders: async () => ({
          listConfiguredQuotaProviders,
          fetchQuotaForProvider: async () => ({}),
        }),
        isExternalOpenCode: () => false,
      });

      const response = await request(app).get('/api/quota/providers?directory=%2Fworkspace').expect(200);
      expect(response.body).toEqual({ providers: ['codex'] });
      expect(listConfiguredQuotaProviders).toHaveBeenCalledExactlyOnceWith({
        workingDirectory: '/workspace',
        isExternalRuntime: false,
      });
      expect(generation).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(['claude', 'claude-agent', 'anthropic', 'anthropic-oauth', 'opencode-with-claude'])(
    'answers /api/quota/%s from Claude Code reported usage, never from discovery or credentials',
    async (providerId) => {
      claudeInstalled(false);
      const app = express();
      const getQuotaProviders = vi.fn(async () => { throw new Error('must not discover ambient credentials'); });
      const owner = {
        isReady: () => true,
        getConfigurationSnapshot: () => ({ locations: [{ directory: '/workspace', configuration: { providers: {} } }] }),
        readClaudeAgentUsage: vi.fn(() => claudeAgentUsage),
        readProviderSelected: vi.fn(),
        credentialMetadata: vi.fn(),
      };
      registerQuotaRoutes(app, { getQuotaProviders, getNativeRuntimeOwner: () => owner });
      const body = (await request(app).get(`/api/quota/${providerId}?refresh=true&directory=%2Fworkspace`).expect(200)).body;
      expect(body).toMatchObject({ providerId: 'claude-agent', providerName: 'Claude', ok: true, configured: true, usageUpdatedAt: 123 });
      expect(body.usage.windows['5h']).toMatchObject({ usedPercent: 25 });
      expect(owner.readClaudeAgentUsage).toHaveBeenCalledOnce();
      expect(getQuotaProviders).not.toHaveBeenCalled();
      expect(owner.readProviderSelected).not.toHaveBeenCalled();
      expect(owner.credentialMetadata).not.toHaveBeenCalled();
    },
  );

  it('reports pending usage when Claude Code is installed and missing Claude Code otherwise', async () => {
    const owner = {
      isReady: () => true,
      getConfigurationSnapshot: () => ({ locations: [{ directory: '/workspace', configuration: { providers: {} } }] }),
      readClaudeAgentUsage: vi.fn(() => undefined),
    };
    const register = () => {
      const app = express();
      registerQuotaRoutes(app, { getQuotaProviders: vi.fn(), getNativeRuntimeOwner: () => owner });
      return app;
    };
    claudeInstalled(true);
    expect((await request(register()).get('/api/quota/anthropic').expect(200)).body).toMatchObject({
      providerId: 'claude-agent', ok: false, configured: true, errorCode: 'claude_agent_usage_pending',
    });
    claudeInstalled(false);
    expect((await request(register()).get('/api/quota/claude').expect(200)).body).toMatchObject({
      providerId: 'claude-agent', ok: false, configured: false, errorCode: 'claude_agent_missing',
    });
  });

  it('never reads native Claude usage or resolves a local proxy for external OpenCode', async () => {
    claudeInstalled(false);
    const app = express();
    const fetchQuotaForProvider = vi.fn();
    const readClaudeAgentUsage = vi.fn(() => claudeAgentUsage);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
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
        getNativeRuntimeOwner: () => ({ readClaudeAgentUsage }),
        buildOpenCodeUrl: () => 'http://remote.example/config/providers',
        isExternalOpenCode: () => true,
      });

      const response = await request(app).get('/api/quota/claude').expect(200);
      expect(response.body).toMatchObject({ providerId: 'claude-agent', ok: false, configured: false, errorCode: 'claude_agent_missing' });
      expect(readClaudeAgentUsage).not.toHaveBeenCalled();
      expect(fetchQuotaForProvider).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('native quota discovery and fetch', () => {
  const directory = '/default/location';
  const readyOwner = (overrides = {}) => ({
    isReady: () => true,
    getConfigurationSnapshot: () => ({ locations: [{ directory, configuration: { providers: {} } }] }),
    credentialMetadata: vi.fn(async (scope) => [{
      id: `${scope.integrationID}-1`,
      integrationID: scope.integrationID,
      valueType: scope.integrationID === 'opencode-go' ? 'key' : 'oauth',
      active: true,
    }]),
    readProviderSelected: vi.fn(async () => undefined),
    readClaudeAgentUsage: vi.fn(() => claudeAgentUsage),
    ...overrides,
  });
  const register = ({ owner, external = false, quota = {}, ...rest } = {}) => {
    const app = express();
    const resolveProviderId = (id) => ({ openai: 'openai', grok: 'xai' }[id] ?? id);
    registerQuotaRoutes(app, {
      getQuotaProviders: async () => ({
        listConfiguredQuotaProviders: vi.fn(() => ['claude-agent', 'codex', 'cursor-acp', 'opencode', 'opencode-go']),
        fetchQuotaForProvider: vi.fn(async () => ({ providerId: 'x', ok: true, configured: true, usage: null })),
        resolveProviderId,
        ...quota,
      }),
      getNativeRuntimeOwner: () => owner ?? null,
      isExternalOpenCode: () => external,
      runtimeReadinessHoldMs: 30,
      runtimeReadinessPollMs: 5,
      ...rest,
    });
    return app;
  };
  const response = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
  });

  it('lists native providers from credential metadata and Claude from its reported usage, never touching the proxy', async () => {
    claudeInstalled(false);
    const owner = readyOwner();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const listConfiguredQuotaProviders = vi.fn(() => ['claude-agent', 'codex', 'cursor-acp', 'opencode', 'opencode-go']);
    const app = register({
      owner,
      quota: { listConfiguredQuotaProviders },
      openCodeClient: { generation: () => { throw new Error('proxy resolver must not run'); } },
    });
    const result = await request(app).get('/api/quota/providers?directory=%2Fworkspace').expect(200);
    expect(result.body).toEqual({ providers: ['claude-agent', 'codex', 'xai', 'cursor-acp', 'opencode', 'opencode-go'] });
    expect(listConfiguredQuotaProviders).toHaveBeenCalledWith({ workingDirectory: '/workspace', isExternalRuntime: false });
    expect(owner.readClaudeAgentUsage).toHaveBeenCalled();
    expect(owner.credentialMetadata.mock.calls.every(([scope]) => scope.directory === directory)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('drops legacy-gated ids that have no native credential and lists Claude once it reported usage or is installed', async () => {
    claudeInstalled(false);
    const quiet = readyOwner({ credentialMetadata: vi.fn(async () => []), readClaudeAgentUsage: vi.fn(() => undefined) });
    expect((await request(register({ owner: quiet })).get('/api/quota/providers').expect(200)).body)
      .toEqual({ providers: ['cursor-acp', 'opencode'] });
    const reported = readyOwner({ credentialMetadata: vi.fn(async () => []) });
    expect((await request(register({ owner: reported })).get('/api/quota/providers').expect(200)).body.providers)
      .toEqual(['claude-agent', 'cursor-acp', 'opencode']);
    claudeInstalled(true);
    expect((await request(register({ owner: quiet })).get('/api/quota/providers').expect(200)).body.providers)
      .toEqual(['claude-agent', 'cursor-acp', 'opencode']);
    // A runtime owner without the claude-agent host never lists Claude.
    const { readClaudeAgentUsage: _omitted, ...withoutHost } = readyOwner({ credentialMetadata: vi.fn(async () => []) });
    expect((await request(register({ owner: withoutHost })).get('/api/quota/providers').expect(200)).body.providers)
      .toEqual(['cursor-acp', 'opencode']);
  });

  it('keeps listing when one provider lookup fails', async () => {
    const owner = readyOwner({
      credentialMetadata: vi.fn(async (scope) => {
        if (scope.integrationID === 'xai') throw new Error('metadata failed');
        return [{ id: 'r', integrationID: scope.integrationID, valueType: scope.integrationID === 'opencode-go' ? 'key' : 'oauth', active: true }];
      }),
    });
    claudeInstalled(false);
    const body = (await request(register({ owner })).get('/api/quota/providers').expect(200)).body;
    // The failed lookup is unknown rather than absent, so xAI stays listed for an explicit fetch result.
    expect(body.providers).toEqual(['claude-agent', 'codex', 'xai', 'cursor-acp', 'opencode', 'opencode-go']);
  });

  it('answers 503 native_runtime_not_ready after the hold while the owner is pending', async () => {
    const pending = readyOwner({ isReady: () => false });
    const result = await request(register({ owner: pending })).get('/api/quota/providers').expect(503);
    expect(result.body).toEqual({ error: 'native_runtime_not_ready', code: 'native_runtime_not_ready' });
    expect(pending.readClaudeAgentUsage).not.toHaveBeenCalled();
  });

  it('waits for a pending owner that becomes ready within the hold', async () => {
    let calls = 0;
    const owner = readyOwner({ isReady: () => (calls += 1) > 3 });
    const body = (await request(register({ owner })).get('/api/quota/providers').expect(200)).body;
    expect(body.providers).toContain('codex');
  });

  it('keeps the legacy discovery path for external runtimes and a missing owner', async () => {
    const generation = vi.fn(() => 2);
    const list = vi.fn(() => ['codex']);
    const client = { generation, catalog: { providers: vi.fn() } };
    const owner = readyOwner();
    for (const options of [{ owner, external: true }, { owner: null }]) {
      const app = register({ ...options, openCodeClient: client, quota: { listConfiguredQuotaProviders: list } });
      expect((await request(app).get('/api/quota/providers').expect(200)).body).toEqual({ providers: ['codex'] });
    }
    expect(list).toHaveBeenCalledTimes(2);
    expect(generation).not.toHaveBeenCalled();
    expect(owner.credentialMetadata).not.toHaveBeenCalled();
    expect(owner.readClaudeAgentUsage).not.toHaveBeenCalled();
  });

  it('injects the native credential into the fetchers without legacy mutation hooks', async () => {
    const readProviderSelected = vi.fn(async (scope) => scope.integrationID === 'xai'
      ? { directory, integrationID: 'xai', credentialID: 'c', value: { type: 'oauth', methodID: 'device', access: 'xa', refresh: 'xr', expires: 5 } }
      : { directory, integrationID: 'opencode-go', credentialID: 'c', value: { type: 'key', key: 'gk' } });
    const fetchQuotaForProvider = vi.fn(async () => ({ ok: true, configured: true }));
    const app = register({ owner: readyOwner({ readProviderSelected }), quota: { fetchQuotaForProvider } });
    await request(app).get('/api/quota/grok?refresh=true').expect(200);
    const [xaiId, xaiOptions] = fetchQuotaForProvider.mock.calls[0];
    expect(xaiId).toBe('xai');
    expect(xaiOptions.readAuth()).toEqual({ xai: { type: 'oauth', access: 'xa', expires: 5 } });
    expect(xaiOptions.writeAuth({})).toBeUndefined();
    expect(xaiOptions).toMatchObject({ forceRefresh: true, isExternalRuntime: false });
    expect(xaiOptions).not.toHaveProperty('claudeProxyBaseUrl');
    await request(app).get('/api/quota/opencode-go').expect(200);
    const [, goOptions] = fetchQuotaForProvider.mock.calls[1];
    expect(goOptions.readAuth()).toEqual({ 'opencode-go': { type: 'api', key: 'gk' } });
    expect(goOptions.mutateAuth(() => { throw new Error('legacy auth file touched'); })).toBeUndefined();
    expect(goOptions.deleteManagedCredential()).toBeUndefined();
  });

  it('returns a configured unreadable result when the native read fails or the runtime is pending', async () => {
    const fetchQuotaForProvider = vi.fn();
    const failing = readyOwner({ readProviderSelected: vi.fn(async () => { throw new Error('private detail'); }) });
    const body = (await request(register({ owner: failing, quota: { fetchQuotaForProvider } })).get('/api/quota/xai').expect(200)).body;
    expect(body).toMatchObject({ providerId: 'xai', ok: false, configured: true, errorCode: 'native_credential_unreadable', error: 'Usage could not be read from the selected account.' });
    expect(JSON.stringify(body)).not.toContain('private detail');
    const pending = (await request(register({ owner: readyOwner({ isReady: () => false }), quota: { fetchQuotaForProvider } })).get('/api/quota/xai').expect(200)).body;
    expect(pending).toMatchObject({ ok: false, configured: true, errorCode: 'native_runtime_not_ready' });
    expect(fetchQuotaForProvider).not.toHaveBeenCalled();
  });

  it('retries a transient native read once against the current owner', async () => {
    const recordDiagnostic = vi.fn();
    const selected = { directory, integrationID: 'xai', credentialID: 'c', value: { type: 'oauth', access: 'fixture-access' } };
    const current = readyOwner({ readProviderSelected: vi.fn(async () => selected) });
    let owner = readyOwner({ readProviderSelected: vi.fn(async () => {
      owner = current;
      throw Object.assign(new Error('private credential payload'), { code: 'native_integration_acquisition_expired' });
    }) });
    const previous = owner;
    const fetchQuotaForProvider = vi.fn(async (_id, options) => {
      expect(options.readAuth()).toEqual({ xai: { type: 'oauth', access: 'fixture-access' } });
      return { providerId: 'xai', configured: true, ok: true };
    });
    const app = register({ getNativeRuntimeOwner: () => owner, quota: { fetchQuotaForProvider }, recordDiagnostic });
    expect((await request(app).get('/api/quota/xai').expect(200)).body.ok).toBe(true);
    expect(previous.readProviderSelected).toHaveBeenCalledTimes(1);
    expect(current.readProviderSelected).toHaveBeenCalledTimes(1);
    expect(fetchQuotaForProvider).toHaveBeenCalledTimes(1);
    expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith({ type: 'lifecycle', event: 'native_quota_read_failed',
      payload: { providerId: 'xai', stage: 'selected_credential', code: 'native_integration_acquisition_expired' } });
    const diagnostic = recordDiagnostic.mock.calls[0][0];
    expect(createDiagnosticSanitizer().sanitizeRecord(diagnostic)).toMatchObject(diagnostic);
  });

  it.each([
    ['native_integration_acquisition_expired', 'native_runtime_not_ready', 2],
    ['native_credential_update_required', 'native_credential_update_required', 1],
    ['native_credential_changed', 'native_credential_changed', 1],
    ['native_integration_binding_invalid', 'native_credential_unreadable', 1],
    ['private-token-in-code', 'native_credential_unreadable', 1],
  ])('classifies %s without leaking private errors or retrying permanent refusals', async (code, errorCode, reads) => {
    const recordDiagnostic = vi.fn(), fetchQuotaForProvider = vi.fn();
    const owner = readyOwner({ readProviderSelected: vi.fn(async () => {
      throw Object.assign(new Error('private-token-in-message'), { code, response: { access: 'private-token-in-response' } });
    }) });
    const body = (await request(register({ owner, quota: { fetchQuotaForProvider }, recordDiagnostic })).get('/api/quota/xai').expect(200)).body;
    expect(body).toMatchObject({ providerId: 'xai', ok: false, configured: true, errorCode });
    expect(owner.readProviderSelected).toHaveBeenCalledTimes(reads);
    expect(fetchQuotaForProvider).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledTimes(reads);
    expect(JSON.stringify([body, recordDiagnostic.mock.calls])).not.toContain('private-token');
    expect(body.error).not.toMatch(/reconnect|re-authenticate/i);
  });

  it.each(['sync', 'async'])('does not let a %s diagnostic sink failure replace the usage result', async (mode) => {
    const owner = readyOwner({ readProviderSelected: async () => { throw new Error('private'); } });
    const app = register({ owner, recordDiagnostic: () => {
      if (mode === 'async') return Promise.reject(new Error('sink unavailable'));
      throw new Error('sink unavailable');
    } });
    expect((await request(app).get('/api/quota/xai').expect(200)).body.errorCode).toBe('native_credential_unreadable');
  });

  it('keeps legacy fetch behavior for external runtimes', async () => {
    const fetchQuotaForProvider = vi.fn(async () => ({ ok: true, configured: true }));
    const owner = readyOwner();
    await request(register({ owner, external: true, quota: { fetchQuotaForProvider } })).get('/api/quota/xai').expect(200);
    expect(fetchQuotaForProvider.mock.calls[0][1].readAuth).toBeUndefined();
    expect(owner.readProviderSelected).not.toHaveBeenCalled();
  });

  it('renews native xAI and retries usage once without a model request', async () => {
    let access = 'expired';
    const owner = readyOwner({
      readProviderSelected: async () => ({ directory, integrationID: 'xai', credentialID: 'c', expectedFingerprint: 'a'.repeat(64), value: { type: 'oauth', methodID: 'device', access } }),
      refreshProviderSelected: vi.fn(async () => { access = 'renewed'; }),
    });
    const fetchQuotaForProvider = vi.fn(async (_id, options) => options.readAuth().xai.access === 'expired'
      ? { ok: false, configured: true, errorCode: 'REAUTHENTICATION_REQUIRED' }
      : { ok: true, configured: true, providerId: 'xai', usage: { windows: {} } });
    const body = (await request(register({ owner, quota: { fetchQuotaForProvider } })).get('/api/quota/xai').expect(200)).body;
    expect(body.ok).toBe(true); expect(fetchQuotaForProvider).toHaveBeenCalledTimes(2);
    expect(owner.refreshProviderSelected).toHaveBeenCalledTimes(1);
    expect(owner.refreshProviderSelected.mock.calls[0][0]).toMatchObject({ operation: 'provider.usage', credentialID: 'c', expectedFingerprint: 'a'.repeat(64) });
  });

  it.each(['native_xai_usage_unavailable', 'native_xai_reauthentication_required', 'repeated_401', 'valid'])('bounds xAI usage renewal for %s', async outcome => {
    const owner = readyOwner({
      readProviderSelected: async () => ({ directory, integrationID: 'xai', credentialID: 'c', expectedFingerprint: 'a'.repeat(64), value: { type: 'oauth', methodID: 'device', access: 'access' } }),
      refreshProviderSelected: vi.fn(async () => { if (outcome.startsWith('native_')) throw Object.assign(new Error('private failure'), { code: outcome }); }),
    });
    const fetchQuotaForProvider = vi.fn(async () => outcome === 'valid' ? { ok: true, configured: true } : { ok: false, configured: true, errorCode: 'REAUTHENTICATION_REQUIRED' });
    const body = (await request(register({ owner, quota: { fetchQuotaForProvider } })).get('/api/quota/xai').expect(200)).body;
    expect(owner.refreshProviderSelected).toHaveBeenCalledTimes(outcome === 'valid' ? 0 : 1);
    expect(fetchQuotaForProvider).toHaveBeenCalledTimes(outcome === 'repeated_401' ? 2 : 1);
    expect(body).toMatchObject(outcome === 'valid' ? { ok: true } : { ok: false, configured: true, errorCode: outcome === 'native_xai_usage_unavailable' ? outcome : 'REAUTHENTICATION_REQUIRED' });
    expect(JSON.stringify(body)).not.toContain('private failure');
    expect(JSON.stringify(body)).not.toContain('next xAI request');
  });

  it.each(['chatgpt-token-sharing', 'chatgpt-siwc', 'chatgpt-headless'])('reports unavailable usage for %s without a network call', async methodID => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const owner = readyOwner({credentialMetadata: async()=>[{id:'c',integrationID:'openai',valueType:'oauth',methodID,active:true}]});
    try {
      const body = (await request(register({owner,quota:await import('./providers/index.js')})).get('/api/quota/codex').expect(200)).body;
      expect(body).toMatchObject({ok:false,configured:true,source:methodID,connectionId:'c',errorCode:'siwc_usage_unavailable',account:null});
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {fetchSpy.mockRestore();}
  });

  it('reports native Codex renewal as pending without asking for a second login', async () => {
    const owner = readyOwner({ credentialMetadata: async () => [{ id: 'c', integrationID: 'openai', valueType: 'oauth', methodID: 'chatgpt-browser', active: true }],
      readOpenAiSelected: async () => ({ directory, integrationID: 'openai', credentialID: 'c', value: { type: 'oauth', methodID: 'chatgpt-browser', access: 'native-access' } }) });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 401));
    try {
      const body = (await request(register({ owner, quota: await import('./providers/index.js') })).get('/api/quota/codex').expect(200)).body;
      expect(body).toMatchObject({ ok: false, configured: true, source: 'chatgpt-browser', connectionId: 'c', errorCode: 'native_openai_token_renewal_pending' });
      expect(body.error).toContain('next OpenAI request'); expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally { fetchSpy.mockRestore(); }
  });

  it('reads Codex usage from the chat account and never exposes its credential', async () => {
    const owner = readyOwner({ credentialMetadata: async () => [{ id: 'c', integrationID: 'openai', valueType: 'oauth', methodID: 'chatgpt-browser', active: true }],
      readOpenAiSelected: async () => ({ directory, integrationID: 'openai', credentialID: 'c', value: { type: 'oauth', methodID: 'chatgpt-browser', access: 'native-secret', refresh: 'refresh-secret', metadata: { accountID: 'account' } } }) });
    const fetchQuotaForProvider = vi.fn(async (_provider, options) => {
      expect(options.readAuth().openai).toEqual({ type: 'oauth', methodID: 'chatgpt-browser', access: 'native-secret', accountId: 'account', connectionId: 'c' });
      return { ok: true, configured: true, usage: { windows: [{ id: '5h', usedPercent: 10 }, { id: 'weekly', usedPercent: 20 }] } };
    });
    const app = register({ owner, quota: { fetchQuotaForProvider } });
    const body = (await request(app).get('/api/quota/codex').expect(200)).body;
    expect(body).toMatchObject({ ok: true, source: 'chatgpt-browser', connectionId: 'c', account: null });
    expect(JSON.stringify(body)).not.toContain('secret');
    await request(app).post('/api/quota/codex/connection/start').send({}).expect(404);
  });
});
