import express from 'express';
import request from '../../test-supertest.js';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as authModule from './auth.js';
import { getProviderAuth, readAuthFile, writeAuthFile } from './auth.js';
import { registerCommonRequestMiddleware } from './core-routes.js';
import {
  __resetGitHubCopilotModelDiscoveryCache,
  GITHUB_COPILOT_AUTO_MODEL,
} from './github-copilot-models.js';
import { registerOpenCodeRoutes } from './routes.js';

vi.mock('./auth.js', () => ({
  readAuthFile: vi.fn(() => ({})),
  writeAuthFile: vi.fn(),
  getProviderAuth: vi.fn(() => null),
  removeProviderAuth: vi.fn(() => false),
}));

const COPILOT_AUTO_MODEL = GITHUB_COPILOT_AUTO_MODEL;

const createApp = (overrides = {}) => {
  const app = express();
  if (overrides.useJsonParser !== false) {
    app.use(express.json());
  }

  const dependencies = {
    clientReloadDelayMs: 0,
    getOpenCodeResolutionSnapshot: vi.fn(async () => ({})),
    formatSettingsResponse: vi.fn((settings) => settings),
    readSettingsFromDisk: vi.fn(async () => ({})),
    readSettingsFromDiskMigrated: vi.fn(async () => ({})),
    persistSettings: vi.fn(async (settings) => settings),
    sanitizeProjects: vi.fn((projects) => projects),
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    resolveProjectDirectory: vi.fn(async () => ({ directory: '/tmp/project' })),
    getProviderSources: vi.fn(() => ({
      sources: {
        auth: { exists: false },
        user: { exists: false, path: '/tmp/user-config.json' },
        project: { exists: false, path: null },
        custom: { exists: false, path: null },
        anthropicOAuth: { exists: false, path: null },
      },
    })),
    removeProviderConfig: vi.fn(() => false),
    ensureAnthropicOAuthProviderConfig: vi.fn(() => ({
      changed: false,
      path: '/tmp/user-config.json',
      config: {},
    })),
    ensureDefaultCursorAcpProviderConfig: vi.fn(() => ({
      changed: false,
      path: '/tmp/user-config.json',
      config: {},
    })),
    markConfigChange: vi.fn(async () => ({
      requiresApply: true,
      applyRevision: 1,
      applyScopes: ['providers'],
      applyStatus: { state: 'pending', runtimeMode: 'managed' },
      requiresReload: false,
    })),
    buildAugmentedPath: vi.fn(() => process.env.PATH || ''),
    getOpenCodeWorkingDirectory: vi.fn(() => '/tmp/project'),
    setOpenCodeWorkingDirectory: vi.fn(),
    restartOpenCode: vi.fn(async () => undefined),
    waitForOpenCodeReady: vi.fn(async () => true),
    isExternalOpenCode: vi.fn(() => false),
    terminateCursorAcpProxy: vi.fn(() => ({ terminated: false, pids: [] })),
    fetchCursorAcpProxyHealth: vi.fn(async () => ({
      ok: true,
      workspaceDirectory: '/tmp/project',
    })),
    cursorSdkRuntime: {
      getRuntimeStatus: vi.fn(() => ({
        providerId: 'cursor-acp',
        bridge: { kind: 'cursor-sdk' },
        sdkAuthConfigured: false,
        usageAuthConfigured: false,
        activeRuns: 0,
        modelsSource: 'fallback',
      })),
      verifyConnection: vi.fn(async () => ({
        ok: true,
        sdkAuthConfigured: true,
        modelCount: 2,
        modelsSource: 'sdk',
      })),
      getVirtualProvider: vi.fn(async () => ({
        id: 'cursor-acp',
        name: 'Cursor',
        models: { auto: { id: 'auto', name: 'Auto' } },
      })),
      prewarmSession: vi.fn(async () => ({ ok: true, agentID: 'agent-prepared', cacheHit: false })),
      handlePromptAsync: vi.fn(async () => ({ handled: false })),
      abortSession: vi.fn(async () => false),
      getSessionMessages: vi.fn(async () => []),
    },
    standardSessionTitleRuntime: { schedule: vi.fn() },
    authLibrary: authModule,
    ...overrides,
  };
  delete dependencies.useJsonParser;
  if (overrides.useCommonRequestMiddleware === true) {
    registerCommonRequestMiddleware(app, { express });
  }
  delete dependencies.useCommonRequestMiddleware;

  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OpenCode provider routes', () => {
  let tempDir = null;

  afterEach(() => {
    __resetGitHubCopilotModelDiscoveryCache();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('loads provider sources globally when no directory is requested', async () => {
    const { app, dependencies } = createApp({
      resolveProjectDirectory: vi.fn(async () => ({ directory: '/tmp/project' })),
    });

    const response = await request(app).get('/api/provider/anthropic/source').expect(200);

    expect(response.body.providerId).toBe('anthropic');
    expect(dependencies.getProviderSources).toHaveBeenCalledWith('anthropic', null);
  });

  it('reports GitHub Copilot source auth from canonical or legacy auth aliases', async () => {
    getProviderAuth.mockImplementation((providerId) => {
      if (providerId === 'copilot') {
        return { type: 'oauth', access: 'token' };
      }
      return null;
    });

    const { app } = createApp();

    const response = await request(app)
      .get('/api/provider/github-copilot/source')
      .expect(200);

    expect(response.body.sources.auth.exists).toBe(true);
  });

  it('does not remove project provider config for global disconnect-all requests', async () => {
    const removeProviderConfig = vi.fn(() => true);
    const { app } = createApp({
      resolveProjectDirectory: vi.fn(async () => ({ directory: '/tmp/project' })),
      removeProviderConfig,
    });

    await request(app).delete('/api/provider/anthropic/auth?scope=all').expect(200);

    expect(removeProviderConfig).toHaveBeenCalledWith('anthropic', null, 'user');
    expect(removeProviderConfig).toHaveBeenCalledWith('anthropic', null, 'custom');
    expect(removeProviderConfig).not.toHaveBeenCalledWith('anthropic', '/tmp/project', 'project');
  });

  it('requires an explicit directory for project-scoped provider disconnects', async () => {
    const removeProviderConfig = vi.fn(() => true);
    const { app } = createApp({
      resolveProjectDirectory: vi.fn(async () => ({ directory: '/tmp/project' })),
      removeProviderConfig,
    });

    await request(app).delete('/api/provider/anthropic/auth?scope=project').expect(400);

    expect(removeProviderConfig).not.toHaveBeenCalled();
  });

  it('writes Claude OAuth provider config to the supplied project directory', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'openchamber-claude-route-'));
    const fakeBinDir = join(tempDir, 'bin');
    const fakeClaude = join(fakeBinDir, 'claude');
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(
      fakeClaude,
      '#!/bin/sh\n[ "$1 $2" = "auth status" ] || exit 9\necho \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\'\n',
      'utf8',
    );
    chmodSync(fakeClaude, 0o755);

    const ensureAnthropicOAuthProviderConfig = vi.fn(() => ({
      changed: false,
      path: '/tmp/user-config.json',
      config: {},
    }));
    const { app } = createApp({
      buildAugmentedPath: vi.fn(() => fakeBinDir),
      resolveProjectDirectory: vi.fn(async () => ({ directory: '/tmp/project' })),
      ensureAnthropicOAuthProviderConfig,
    });

    await request(app)
      .post('/api/provider/anthropic/check-oauth?directory=%2Ftmp%2Fproject')
      .expect(200);

    expect(ensureAnthropicOAuthProviderConfig).toHaveBeenCalledWith({ workingDirectory: '/tmp/project' });
  });

  it('returns a deterministic code when Claude CLI OAuth is unavailable', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'openchamber-claude-route-'));
    const fakeClaude = join(tempDir, 'claude');
    writeFileSync(fakeClaude, '#!/bin/sh\necho \'{"loggedIn":false}\'\nexit 1\n', 'utf8');
    chmodSync(fakeClaude, 0o755);
    const { app } = createApp({ buildAugmentedPath: vi.fn(() => tempDir) });

    const response = await request(app)
      .post('/api/provider/anthropic/check-oauth')
      .expect(400);

    expect(response.body).toEqual({
      code: 'claude_cli_unauthenticated',
      error: 'Claude Code is not signed in. Run `claude auth login` and try again.',
      reason: 'claude_not_authenticated',
    });
  });

  it('verifies the Cursor SDK connection without writing the old OpenCode bridge config', async () => {
    const ensureDefaultCursorAcpProviderConfig = vi.fn();
    const markConfigChange = vi.fn(async () => undefined);
    const verifyConnection = vi.fn(async () => ({
      ok: true,
      sdkAuthConfigured: true,
      modelCount: 2,
      modelsSource: 'sdk',
    }));
    const { app } = createApp({
      ensureDefaultCursorAcpProviderConfig,
      markConfigChange,
      clientReloadDelayMs: 25,
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection,
      },
    });

    const response = await request(app)
      .post('/api/provider/cursor-acp/configure')
      .expect(200);

    expect(ensureDefaultCursorAcpProviderConfig).not.toHaveBeenCalled();
    expect(markConfigChange).not.toHaveBeenCalled();
    expect(verifyConnection).toHaveBeenCalledWith();
    expect(response.body).toMatchObject({
      success: true,
      configured: true,
      changed: false,
      requiresReload: false,
      bridge: { kind: 'cursor-sdk' },
      sdkAuthConfigured: true,
      usageAuthConfigured: false,
      modelCount: 2,
    });
  });

  it('reports Cursor SDK and usage auth separately in runtime status', async () => {
    const getRuntimeStatus = vi.fn(() => ({
      providerId: 'cursor-acp',
      bridge: { kind: 'cursor-sdk' },
      sdkAuthConfigured: true,
      usageAuthConfigured: true,
      activeRuns: 1,
      modelsSource: 'sdk',
    }));
    const { app } = createApp({
      cursorSdkRuntime: {
        getRuntimeStatus,
        verifyConnection: vi.fn(),
      },
    });

    const response = await request(app)
      .get('/api/provider/cursor-acp/runtime-status')
      .expect(200);

    expect(getRuntimeStatus).toHaveBeenCalledWith();
    expect(response.body).toMatchObject({
      providerId: 'cursor-acp',
      bridge: { kind: 'cursor-sdk' },
      sdkAuthConfigured: true,
      usageAuthConfigured: true,
      activeRuns: 1,
      modelsSource: 'sdk',
    });
  });

  it('prewarms a Cursor SDK session through the provider route', async () => {
    const prewarmSession = vi.fn(async () => ({
      ok: true,
      agentID: 'agent-prepared',
      cacheHit: false,
    }));
    const { app } = createApp({
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        prewarmSession,
      },
    });

    const response = await request(app)
      .post('/api/provider/cursor-acp/session-prewarm')
      .send({
        sessionID: 'ses_cursor_draft',
        directory: '/tmp/project',
        modelID: 'composer-2.5',
        variant: 'fast',
        agent: 'builder',
      })
      .expect(200);

    expect(prewarmSession).toHaveBeenCalledWith({
      sessionID: 'ses_cursor_draft',
      directory: '/tmp/project',
      modelID: 'composer-2.5',
      variant: 'fast',
      agent: 'builder',
    });
    expect(response.body).toEqual({
      ok: true,
      agentID: 'agent-prepared',
      cacheHit: false,
    });
  });

  it('merges cached Cursor provider metadata without awaiting slow SDK discovery', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } },
          },
        ],
        default: { openai: 'gpt-5.5' },
      })),
    });
    const getVirtualProvider = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        id: 'cursor-acp',
        name: 'Cursor',
        models: { slow: { id: 'slow', name: 'Slow Discovery' } },
      };
    });
    const getCachedVirtualProvider = vi.fn(() => ({
      id: 'cursor-acp',
      name: 'Cursor',
      models: { cached: { id: 'cached', name: 'Cached Cursor', limit: { context: 272_000 } } },
    }));
    const refreshVirtualProvider = vi.fn(() => Promise.resolve());
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        getVirtualProvider,
        getCachedVirtualProvider,
        refreshVirtualProvider,
        handlePromptAsync: vi.fn(),
        abortSession: vi.fn(),
        getSessionMessages: vi.fn(async () => []),
      },
    });

    const response = await request(app)
      .get('/api/config/providers')
      .expect(200);

    expect(response.body.providers).toEqual([
      {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } },
      },
      {
        id: 'cursor-acp',
        name: 'Cursor',
        models: { cached: { id: 'cached', name: 'Cached Cursor', limit: { context: 272_000 } } },
      },
    ]);
    expect(getCachedVirtualProvider).toHaveBeenCalledWith();
    expect(refreshVirtualProvider).toHaveBeenCalledWith({ reason: 'providers_route' });
    expect(getVirtualProvider).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('keeps only real GPT-5.6 family rows selectable for OAuth without exposing credentials', async () => {
    readAuthFile.mockReturnValue({
      openai: { type: 'oauth', access: 'secret-access-token', refresh: 'secret-refresh-token' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        providers: [{
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5.6': { id: 'gpt-5.6', name: 'GPT-5.6' },
            'gpt-5.6-pro': { id: 'gpt-5.6-pro', name: 'GPT-5.6 Pro' },
            'gpt-5.6-sol': { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            'gpt-5.6-sol-fast': { id: 'gpt-5.6-sol-fast', name: 'GPT-5.6 Sol Fast' },
            'gpt-5.6-sol-pro': { id: 'gpt-5.6-sol-pro', name: 'GPT-5.6 Sol Pro' },
            'gpt-5.6-terra': { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
            'gpt-5.6-luna': {
              id: 'gpt-5.6-luna',
              name: 'GPT-5.6 Luna',
              variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
            },
            'gpt-5.6-luna-fast': {
              id: 'gpt-5.6-luna-fast',
              name: 'GPT-5.6 Luna Fast',
              variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
            },
            'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' },
          },
        }],
        default: { openai: 'gpt-5.6' },
      })),
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
    });

    const response = await request(app).get('/api/config/providers').expect(200);

    expect(response.body.providers[0]).toMatchObject({
      id: 'openai',
      authType: 'oauth',
      models: {
        'gpt-5.6': {
          id: 'gpt-5.6',
          available: false,
          unavailableReason: 'auth_type_unsupported',
          requiredAuthType: 'api',
        },
        'gpt-5.6-luna': {
          id: 'gpt-5.6-luna',
          variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
        },
        'gpt-5.6-luna-fast': {
          id: 'gpt-5.6-luna-fast',
          variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
        },
        'gpt-5.6-sol': {
          id: 'gpt-5.6-sol',
        },
        'gpt-5.6-sol-fast': {
          id: 'gpt-5.6-sol-fast',
        },
        'gpt-5.6-terra': {
          id: 'gpt-5.6-terra',
        },
        'gpt-5.6-pro': {
          available: false,
          unavailableReason: 'auth_type_unsupported',
          requiredAuthType: 'api',
        },
        'gpt-5.6-sol-pro': {
          available: false,
          unavailableReason: 'auth_type_unsupported',
          requiredAuthType: 'api',
        },
        'gpt-5.5': {
          id: 'gpt-5.5',
        },
      },
    });
    expect(response.body.providers[0].models['gpt-5.6-luna'].available).not.toBe(false);
    expect(response.body.providers[0].models['gpt-5.6-luna-fast'].available).not.toBe(false);
    expect(response.body.providers[0].models['gpt-5.6-sol'].available).not.toBe(false);
    expect(response.body.providers[0].models['gpt-5.6-terra'].available).not.toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('secret-access-token');
    expect(JSON.stringify(response.body)).not.toContain('secret-refresh-token');
    fetchSpy.mockRestore();
  });

  it('keeps OpenAI Luna available for API-key authentication', async () => {
    readAuthFile.mockReturnValue({ openai: { type: 'api', key: 'secret-api-key' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        providers: [{
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5.6-luna': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
          },
        }],
        default: { openai: 'gpt-5.6-luna' },
      })),
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
    });

    const response = await request(app).get('/api/config/providers').expect(200);

    expect(response.body.providers[0]).toMatchObject({
      id: 'openai',
      authType: 'api',
      models: {
        'gpt-5.6-luna': { id: 'gpt-5.6-luna' },
      },
    });
    expect(response.body.providers[0].models['gpt-5.6-luna'].available).not.toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('secret-api-key');
    fetchSpy.mockRestore();
  });

  it('leaves external OpenCode OpenAI catalogs unchanged', async () => {
    readAuthFile.mockReturnValue({ openai: { type: 'oauth', access: 'secret-access-token' } });
    const upstream = {
      providers: [{
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.6': { id: 'gpt-5.6', name: 'GPT-5.6' },
          'gpt-5.6-sol': { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
        },
      }],
      default: { openai: 'gpt-5.6' },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => upstream),
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
      isExternalOpenCode: vi.fn(() => true),
    });

    const response = await request(app).get('/api/config/providers').expect(200);

    expect(response.body.providers[0]).toEqual(upstream.providers[0]);
    expect(response.body.providers[0].authType).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('preserves upstream GitHub Copilot provider metadata without duplicating aliases or fetching account models', async () => {
    readAuthFile.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'token' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('api.githubcopilot.com/models')) {
        throw new Error('Copilot account discovery should not run when upstream has models');
      }
      return {
        ok: true,
        json: vi.fn(async () => ({
          providers: [
            {
              id: 'copilot',
              name: 'Copilot',
              models: { 'gpt-5.1-codex': { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' } },
            },
            {
              id: 'openai',
              name: 'OpenAI',
              models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } },
            },
          ],
          default: { copilot: 'gpt-5.1-codex', openai: 'gpt-5.5' },
        })),
      };
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
    });

    const response = await request(app)
      .get('/api/config/providers')
      .expect(200);

    expect(response.body.providers).toEqual([
      {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        models: {
          auto: COPILOT_AUTO_MODEL,
          'gpt-5.1-codex': { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
        },
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } },
      },
    ]);
    expect(response.body.default).toEqual({
      'github-copilot': 'gpt-5.1-codex',
      openai: 'gpt-5.5',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it('still returns the upstream provider list when provider integrations throw', async () => {
    readAuthFile.mockReturnValue({});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: vi.fn(async () => ({
        providers: [
          { id: 'openai', name: 'OpenAI', models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } } },
        ],
        default: { openai: 'gpt-5.5' },
      })),
    }));
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      getProviderSources: vi.fn(() => {
        throw new Error('provider source lookup failed');
      }),
      cursorSdkRuntime: null,
    });

    const response = await request(app)
      .get('/api/config/providers')
      .expect(200);

    expect(response.body.providers).toEqual([
      { id: 'openai', name: 'OpenAI', models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } } },
    ]);

    fetchSpy.mockRestore();
  });

  it('appends account-specific GitHub Copilot models when auth exists but upstream omits it', async () => {
    readAuthFile.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'token' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('api.githubcopilot.com/models')) {
        return {
          ok: true,
          json: vi.fn(async () => ({
            data: [
              { id: 'gpt-5.5' },
              { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
            ],
          })),
        };
      }
      return {
        ok: true,
        json: vi.fn(async () => ({
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } },
            },
          ],
          default: { openai: 'gpt-5.5' },
        })),
      };
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
    });

    const response = await request(app)
      .get('/api/config/providers')
      .expect(200);

    expect(response.body.providers).toEqual([
      {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } },
      },
      {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        models: {
          auto: COPILOT_AUTO_MODEL,
          'gpt-5.5': {
            id: 'gpt-5.5',
            name: 'GPT 5.5',
            api: {
              id: 'gpt-5.5',
              url: 'https://api.githubcopilot.com',
              npm: '@ai-sdk/github-copilot',
            },
          },
          'claude-sonnet-5': {
            id: 'claude-sonnet-5',
            name: 'Claude Sonnet 5',
            api: {
              id: 'claude-sonnet-5',
              url: 'https://api.githubcopilot.com',
              npm: '@ai-sdk/github-copilot',
            },
          },
        },
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.githubcopilot.com/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }));

    fetchSpy.mockRestore();
  });

  it('fills empty upstream GitHub Copilot models from account discovery', async () => {
    readAuthFile.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'token' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('api.githubcopilot.com/models')) {
        return {
          ok: true,
          json: vi.fn(async () => ({
            data: [
              { id: 'gpt-5.4-mini' },
              { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
            ],
          })),
        };
      }
      return {
        ok: true,
        json: vi.fn(async () => ({
          providers: [
            {
              id: 'copilot',
              name: 'Copilot',
              models: {},
            },
          ],
          default: { copilot: 'gpt-5.4-mini' },
        })),
      };
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
    });

    const response = await request(app)
      .get('/api/config/providers')
      .expect(200);

    expect(response.body.providers).toEqual([{
      id: 'github-copilot',
      name: 'GitHub Copilot',
      models: {
        auto: COPILOT_AUTO_MODEL,
        'gpt-5.4-mini': {
          id: 'gpt-5.4-mini',
          name: 'GPT 5.4 Mini',
          api: {
            id: 'gpt-5.4-mini',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
        'gpt-5.3-codex': {
          id: 'gpt-5.3-codex',
          name: 'GPT-5.3 Codex',
          api: {
            id: 'gpt-5.3-codex',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
      },
    }]);
    expect(response.body.default).toEqual({
      'github-copilot': 'gpt-5.4-mini',
    });

    fetchSpy.mockRestore();
  });

  it('falls back to the emergency GitHub Copilot model when account discovery fails', async () => {
    readAuthFile.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'token' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('api.githubcopilot.com/models')) {
        return {
          ok: false,
          status: 503,
          json: vi.fn(async () => ({})),
        };
      }
      return {
        ok: true,
        json: vi.fn(async () => ({ providers: [], default: {} })),
      };
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
    });

    const response = await request(app)
      .get('/api/config/providers')
      .expect(200);

    expect(response.body.providers).toContainEqual({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      models: {
        auto: COPILOT_AUTO_MODEL,
        'gpt-4.1': {
          id: 'gpt-4.1',
          name: 'GPT-4.1',
          api: {
            id: 'gpt-4.1',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
      },
    });

    fetchSpy.mockRestore();
  });

  it('appends account-specific GitHub Copilot models when legacy copilot auth exists but upstream omits it', async () => {
    readAuthFile.mockReturnValue({ copilot: { type: 'oauth', access: 'legacy-token' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('api.githubcopilot.com/models')) {
        return {
          ok: true,
          json: vi.fn(async () => ({ data: [{ id: 'gpt-5.2-codex' }] })),
        };
      }
      return {
        ok: true,
        json: vi.fn(async () => ({ providers: [], default: {} })),
      };
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
    });

    const response = await request(app)
      .get('/api/config/providers')
      .expect(200);

    expect(response.body.providers).toContainEqual({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      models: {
        auto: COPILOT_AUTO_MODEL,
        'gpt-5.2-codex': {
          id: 'gpt-5.2-codex',
          name: 'GPT 5.2 Codex',
          api: {
            id: 'gpt-5.2-codex',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
      },
    });
    expect(fetchSpy).toHaveBeenCalledWith('https://api.githubcopilot.com/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer legacy-token' }),
    }));

    fetchSpy.mockRestore();
  });

  it('does not append GitHub Copilot without upstream provider or local auth', async () => {
    readAuthFile.mockReturnValue({});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({ providers: [], default: {} })),
    });
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      cursorSdkRuntime: null,
    });

    const response = await request(app)
      .get('/api/config/providers')
      .expect(200);

    expect(response.body.providers).toEqual([]);

    fetchSpy.mockRestore();
  });

  it('treats Cursor workspace repair as an SDK-managed compatibility no-op', async () => {
    const restartOpenCode = vi.fn(async () => undefined);
    const setOpenCodeWorkingDirectory = vi.fn();
    const { app } = createApp({
      getOpenCodeWorkingDirectory: vi.fn(() => '/tmp/project'),
      setOpenCodeWorkingDirectory,
      restartOpenCode,
      fetchCursorAcpProxyHealth: vi.fn(async () => ({
        ok: true,
        workspaceDirectory: '/tmp/project',
      })),
    });

    const response = await request(app)
      .post('/api/provider/cursor-acp/workspace')
      .send({ directory: '/tmp/project' })
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      sdkManaged: true,
      changed: false,
      restarted: false,
      path: '/tmp/project',
    });
    expect(setOpenCodeWorkingDirectory).not.toHaveBeenCalled();
    expect(restartOpenCode).not.toHaveBeenCalled();
  });

  it('saves, reports, and clears Cursor usage auth without exposing the token', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { key: 'sdk-key' } });
    const { app } = createApp();

    const saveResponse = await request(app)
      .put('/api/provider/cursor-acp/usage-auth')
      .send({ sessionToken: 'cursor-session-token' })
      .expect(200);

    expect(writeAuthFile).toHaveBeenCalledWith({
      'cursor-acp': {
        key: 'sdk-key',
        usageSessionToken: 'cursor-session-token',
      },
    });
    expect(saveResponse.body).toMatchObject({ success: true, configured: true });
    expect(JSON.stringify(saveResponse.body)).not.toContain('cursor-session-token');

    readAuthFile.mockReturnValue({ 'cursor-acp': { key: 'sdk-key', usageSessionToken: 'cursor-session-token' } });
    const statusResponse = await request(app)
      .get('/api/provider/cursor-acp/usage-auth/status')
      .expect(200);

    expect(statusResponse.body).toEqual({ configured: true });
    expect(JSON.stringify(statusResponse.body)).not.toContain('cursor-session-token');

    const clearResponse = await request(app)
      .delete('/api/provider/cursor-acp/usage-auth')
      .expect(200);

    expect(clearResponse.body).toEqual({ success: true, configured: false });
    expect(writeAuthFile).toHaveBeenLastCalledWith({ 'cursor-acp': { key: 'sdk-key' } });
  });

  it('saves Cursor SDK auth without deleting the usage quota token', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { usageSessionToken: 'cursor-session-token' } });
    const { app } = createApp();

    const response = await request(app)
      .put('/api/auth/cursor-acp')
      .send({ type: 'api', key: 'cursor-sdk-key' })
      .expect(200);

    expect(response.body).toMatchObject({ success: true, configured: true });
    expect(JSON.stringify(response.body)).not.toContain('cursor-sdk-key');
    expect(writeAuthFile).toHaveBeenCalledWith({
      'cursor-acp': {
        usageSessionToken: 'cursor-session-token',
        type: 'api',
        key: 'cursor-sdk-key',
      },
    });
  });

  it('parses Cursor SDK auth requests through the production middleware', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { usageSessionToken: 'cursor-session-token' } });
    const { app } = createApp({
      useJsonParser: false,
      useCommonRequestMiddleware: true,
    });

    await request(app)
      .put('/api/auth/cursor-acp')
      .send({ type: 'api', key: 'cursor-sdk-key' })
      .expect(200);

    expect(writeAuthFile).toHaveBeenCalledWith({
      'cursor-acp': {
        usageSessionToken: 'cursor-session-token',
        type: 'api',
        key: 'cursor-sdk-key',
      },
    });
  });

  it('disconnects Cursor SDK auth without deleting the usage quota token', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': {
      type: 'api',
      key: 'cursor-sdk-key',
      token: 'legacy-sdk-token',
      usageSessionToken: 'cursor-session-token',
    } });
    const { app } = createApp();

    const response = await request(app)
      .delete('/api/provider/cursor-acp/auth?scope=auth')
      .expect(200);

    expect(response.body).toMatchObject({ success: true, removed: true });
    expect(writeAuthFile).toHaveBeenCalledWith({
      'cursor-acp': {
        usageSessionToken: 'cursor-session-token',
      },
    });
  });

  it('requires the server common middleware JSON parser for Cursor usage auth saves', async () => {
    const { app } = createApp({ useJsonParser: false });

    await request(app)
      .put('/api/provider/cursor-acp/usage-auth')
      .send({ sessionToken: 'cursor-session-token' })
      .expect(400);

    expect(writeAuthFile).not.toHaveBeenCalled();
  });

  it('parses Cursor usage auth JSON through the server common middleware', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { key: 'sdk-key' } });
    const { app } = createApp({ useJsonParser: false, useCommonRequestMiddleware: true });

    await request(app)
      .put('/api/provider/cursor-acp/usage-auth')
      .send({ sessionToken: 'cursor-session-token' })
      .expect(200);

    expect(writeAuthFile).toHaveBeenCalledWith({
      'cursor-acp': {
        key: 'sdk-key',
        usageSessionToken: 'cursor-session-token',
      },
    });
  });

  it('saves OpenCode Go usage auth without deleting the API key', async () => {
    readAuthFile.mockReturnValue({ 'opencode-go': { key: 'go-api-key' } });
    const { app } = createApp();

    await request(app)
      .put('/api/provider/opencode-go/usage-auth')
      .send({ workspaceId: 'wrk_abc123', authCookie: 'Fe26.2**secret-cookie' })
      .expect(200);

    expect(writeAuthFile).toHaveBeenCalledWith({
      'opencode-go': {
        key: 'go-api-key',
        usageWorkspaceId: 'wrk_abc123',
        usageAuthCookie: 'Fe26.2**secret-cookie',
      },
    });
  });

  it('reports OpenCode Go usage auth status', async () => {
    readAuthFile.mockReturnValue({
      'opencode-go': {
        usageWorkspaceId: 'wrk_abc123',
        usageAuthCookie: 'Fe26.2**secret-cookie',
      },
    });
    const { app } = createApp();

    const response = await request(app)
      .get('/api/provider/opencode-go/usage-auth/status')
      .expect(200);

    expect(response.body).toEqual({ configured: true, workspaceId: 'wrk_abc123' });
  });

  it('clears OpenCode Go usage auth without deleting the API key', async () => {
    readAuthFile.mockReturnValue({
      'opencode-go': {
        key: 'go-api-key',
        usageWorkspaceId: 'wrk_abc123',
        usageAuthCookie: 'Fe26.2**secret-cookie',
      },
    });
    const { app } = createApp();

    await request(app)
      .delete('/api/provider/opencode-go/usage-auth')
      .expect(200);

    expect(writeAuthFile).toHaveBeenCalledWith({
      'opencode-go': { key: 'go-api-key' },
    });
  });

  it('rejects invalid OpenCode Go usage auth values', async () => {
    const { app } = createApp();

    await request(app)
      .put('/api/provider/opencode-go/usage-auth')
      .send({ workspaceId: 'not-a-workspace', authCookie: 'cookie' })
      .expect(400);

    expect(writeAuthFile).not.toHaveBeenCalled();
  });

  it('sends Cursor prompts through the SDK runtime before the OpenCode proxy', async () => {
    const handlePromptAsync = vi.fn(async () => ({ handled: true, status: 204 }));
    const { app } = createApp({
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        getVirtualProvider: vi.fn(),
        handlePromptAsync,
        abortSession: vi.fn(),
        getSessionMessages: vi.fn(async () => []),
      },
    });
    const downstream = vi.fn((_req, res) => res.status(599).json({ proxied: true }));
    app.post('/api/session/:sessionID/prompt_async', downstream);

    await request(app)
      .post('/api/session/ses_1/prompt_async')
      .send({
        model: { providerID: 'cursor-acp', modelID: 'auto' },
        agent: 'orchestrator',
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
        tools: { keep_enabled: true },
      })
      .expect(204);

    expect(handlePromptAsync).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'auto' },
        agent: 'orchestrator',
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
        tools: {
          keep_enabled: true,
          task: false,
          invalid: false,
        },
      },
      directory: '/tmp/project',
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it('schedules Cursor title generation without delaying the accepted prompt response', async () => {
    const schedule = vi.fn(() => new Promise(() => {}));
    const { app } = createApp({
      cursorSessionTitleRuntime: { schedule },
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        getVirtualProvider: vi.fn(),
        handlePromptAsync: vi.fn(async () => ({ handled: true, status: 204 })),
        abortSession: vi.fn(),
        getSessionMessages: vi.fn(async () => []),
        generateTitle: vi.fn(),
      },
    });

    await request(app)
      .post('/api/session/ses_1/prompt_async')
      .send({
        model: { providerID: 'cursor-acp', modelID: 'auto' },
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
      })
      .expect(204);

    expect(schedule).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      directory: '/tmp/project',
    });
  });

  it('does not schedule Cursor title generation for a handled prompt error', async () => {
    const schedule = vi.fn();
    const { app } = createApp({
      cursorSessionTitleRuntime: { schedule },
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        getVirtualProvider: vi.fn(),
        handlePromptAsync: vi.fn(async () => ({
          handled: true,
          status: 401,
          body: { error: 'Cursor SDK API key is not configured.' },
        })),
        abortSession: vi.fn(),
        getSessionMessages: vi.fn(async () => []),
        generateTitle: vi.fn(),
      },
    });

    await request(app)
      .post('/api/session/ses_1/prompt_async')
      .send({
        model: { providerID: 'cursor-acp', modelID: 'auto' },
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
      })
      .expect(401);

    expect(schedule).not.toHaveBeenCalled();
  });

  it('unarchives the upstream OpenCode session when Cursor SDK handles a prompt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        id: 'ses_1',
        time: { archived: 0 },
      })),
    });
    const handlePromptAsync = vi.fn(async () => ({ handled: true, status: 204 }));
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      getOpenCodeAuthHeaders: vi.fn(() => ({ authorization: 'Bearer test' })),
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        getVirtualProvider: vi.fn(),
        handlePromptAsync,
        abortSession: vi.fn(),
        getSessionMessages: vi.fn(async () => []),
      },
    });

    await request(app)
      .post('/api/session/ses_1/prompt_async')
      .send({
        model: { providerID: 'cursor-acp', modelID: 'auto' },
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
      })
      .expect(204);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://opencode.test/session/ses_1?directory=%2Ftmp%2Fproject',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          authorization: 'Bearer test',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ time: { archived: 0 } }),
      }),
    );

    fetchSpy.mockRestore();
  });

  it('parses Cursor prompt JSON through the production middleware before SDK interception', async () => {
    const handlePromptAsync = vi.fn(async () => ({ handled: true, status: 204 }));
    const { app } = createApp({
      useJsonParser: false,
      useCommonRequestMiddleware: true,
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        getVirtualProvider: vi.fn(),
        handlePromptAsync,
        abortSession: vi.fn(),
        getSessionMessages: vi.fn(async () => []),
      },
    });
    const downstream = vi.fn((_req, res) => res.status(599).json({ proxied: true }));
    app.post('/api/session/:sessionID/prompt_async', downstream);

    await request(app)
      .post('/api/session/ses_1/prompt_async')
      .send({
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
      })
      .expect(204);

    expect(handlePromptAsync).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
      },
      directory: '/tmp/project',
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it('lets non-Cursor prompt sends continue to the OpenCode proxy path', async () => {
    const handlePromptAsync = vi.fn(async () => ({ handled: false }));
    const schedule = vi.fn();
    const { app } = createApp({
      cursorSessionTitleRuntime: { schedule },
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        getVirtualProvider: vi.fn(),
        handlePromptAsync,
        abortSession: vi.fn(),
        getSessionMessages: vi.fn(async () => []),
      },
    });
    app.post('/api/session/:sessionID/prompt_async', (req, res) => res.json({
      proxied: true,
      tools: req.body.tools,
    }));

    const response = await request(app)
      .post('/api/session/ses_1/prompt_async')
      .send({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
        agent: 'orchestrator',
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
        tools: { keep_enabled: true },
      })
      .expect(200);

    expect(handlePromptAsync).toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      proxied: true,
      tools: {
        keep_enabled: true,
        task: false,
        invalid: false,
      },
    });
  });

  it('schedules standard-provider title generation after the proxied prompt succeeds', async () => {
    const schedule = vi.fn();
    const { app } = createApp({
      standardSessionTitleRuntime: { schedule },
    });
    app.use('/api', (_req, res) => res.status(204).end());

    await request(app)
      .post('/api/session/ses_1/prompt_async?directory=%2Ftmp%2Fproject')
      .send({
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
      })
      .expect(204);

    expect(schedule).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      text: 'hello',
    });
  });

  it('schedules standard-provider title generation for Anthropic prompts', async () => {
    const schedule = vi.fn();
    const { app } = createApp({
      standardSessionTitleRuntime: { schedule },
    });
    app.use('/api', (_req, res) => res.status(204).end());

    await request(app)
      .post('/api/session/ses_anthropic/prompt_async?directory=%2Ftmp%2Fproject')
      .send({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
        messageID: 'msg_1',
        parts: [
          { type: 'text', text: 'User has requested to enter plan mode.', synthetic: true },
          { type: 'text', text: 'repair Anthropic session titles' },
        ],
      })
      .expect(204);

    expect(schedule).toHaveBeenCalledWith({
      sessionID: 'ses_anthropic',
      directory: '/tmp/project',
      text: 'repair Anthropic session titles',
    });
  });

  it('schedules historical marker title backfill after a session list succeeds', async () => {
    const scheduleMarkerBackfill = vi.fn();
    const { app } = createApp({
      standardSessionTitleRuntime: {
        schedule: vi.fn(),
        scheduleMarkerBackfill,
      },
    });
    app.get('/api/session', (_req, res) => res.json([
      { id: 'ses_anthropic', title: '<!--plan-->' },
    ]));

    await request(app)
      .get('/api/session?directory=%2Ftmp%2Fproject')
      .expect(200);

    expect(scheduleMarkerBackfill).toHaveBeenCalledWith({
      directory: '/tmp/project',
    });
  });

  it('does not schedule standard-provider title generation after a proxied prompt error', async () => {
    const schedule = vi.fn();
    const { app } = createApp({
      standardSessionTitleRuntime: { schedule },
    });
    app.post('/api/session/:sessionID/prompt_async', (_req, res) => res.status(401).json({ error: 'nope' }));

    await request(app)
      .post('/api/session/ses_1/prompt_async')
      .send({
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
      })
      .expect(401);

    expect(schedule).not.toHaveBeenCalled();
  });

  it('merges Cursor SDK session statuses into the session status route with Cursor taking precedence', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        ses_cursor: { type: 'busy' },
        ses_opencode: { type: 'busy' },
      })),
    });
    const getSessionStatus = vi.fn(() => ({
      ses_cursor: { type: 'idle' },
      ses_cursor_active: { type: 'busy' },
    }));
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      getOpenCodeAuthHeaders: vi.fn(() => ({ authorization: 'Bearer test' })),
      cursorSdkRuntime: {
        getRuntimeStatus: vi.fn(),
        verifyConnection: vi.fn(),
        getVirtualProvider: vi.fn(),
        handlePromptAsync: vi.fn(),
        abortSession: vi.fn(),
        getSessionMessages: vi.fn(async () => []),
        getSessionStatus,
      },
    });

    const response = await request(app)
      .get('/api/session/status?directory=%2Ftmp%2Fproject')
      .expect(200);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://opencode.test/session/status?directory=%2Ftmp%2Fproject',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer test',
          Accept: 'application/json',
        }),
      }),
    );
    expect(getSessionStatus).toHaveBeenCalledWith();
    expect(response.body).toEqual({
      ses_cursor: { type: 'idle' },
      ses_cursor_active: { type: 'busy' },
      ses_opencode: { type: 'busy' },
    });

    fetchSpy.mockRestore();
  });
});
