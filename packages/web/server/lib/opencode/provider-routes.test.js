import { createNativeConsumerFixture } from './test-native-consumer-client.js';
import express from 'express';
import request from '../../test-supertest.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
  OPENCODE_DATA_DIR: `${process.cwd()}/.cache/provider-auth-fixture`,
  readAuthFile: vi.fn(() => ({})),
  writeAuthFile: vi.fn(),
  getProviderAuth: vi.fn(() => null),
  removeProviderAuth: vi.fn(() => false),
}));

const COPILOT_AUTO_MODEL = GITHUB_COPILOT_AUTO_MODEL;

describe('dedicated Claude enrollment routes',()=>{
  it('requires administrator and CSRF before any enrollment work',async()=>{
    const begin=vi.fn();const owner={begin};
    const denied=createApp({getClaudeEnrollmentOwner:()=>owner,isProviderAdministrator:()=>false,useJsonParser:false});
    expect((await request(denied.app).post('/api/provider/anthropic/enrollment').set('Content-Type','application/json').send('{')).status).toBe(403);
    const allowed=createApp({getClaudeEnrollmentOwner:()=>owner,isProviderAdministrator:()=>true,useJsonParser:false});
    expect((await request(allowed.app).post('/api/provider/anthropic/enrollment').send({})).status).toBe(403);
    expect(begin).not.toHaveBeenCalled();
  });
  it('uses original resolved directory/context and a separate explicit selection',async()=>{
    const begin=vi.fn(async context=>{expect(context.directory).toBe('/tmp/project');expect(context.request.method).toBe('POST');return{enrollmentID:'synthetic-enrollment',status:'pending',url:'https://claude.com/cai/oauth/authorize'};});
    const select=vi.fn(async()=>({status:'selected'})),complete=vi.fn(async()=>({status:'enrolled'}));
    const app=createApp({getClaudeEnrollmentOwner:()=>({begin,complete,select}),isProviderAdministrator:()=>true});
    expect((await request(app.app).post('/api/provider/anthropic/enrollment').set('x-devryan-csrf','1').send({})).status).toBe(200);
    expect(select).not.toHaveBeenCalled();
    expect((await request(app.app).post('/api/provider/anthropic/enrollment/id/complete').set('x-devryan-csrf','1').send({code:'fixture-code',state:'fixture-state'})).status).toBe(200);
    expect(select).not.toHaveBeenCalled();
    expect((await request(app.app).post('/api/provider/anthropic/enrollment/id/select').set('x-devryan-csrf','1').send({})).status).toBe(200);
    expect(select).toHaveBeenCalledOnce();
  });
  it('refuses client-provided selection authority and sanitizes owner errors',async()=>{
    const select=vi.fn();const begin=vi.fn(async()=>{throw new Error('sensitive-issuer-body');});
    const app=createApp({getClaudeEnrollmentOwner:()=>({select,begin}),isProviderAdministrator:()=>true,useJsonParser:false});
    const rejected=await request(app.app).post('/api/provider/anthropic/enrollment/id/select').set('x-devryan-csrf','1').send({service:'foreign'});
    expect(rejected.status).toBe(400);expect(select).not.toHaveBeenCalled();
    const failed=await request(app.app).post('/api/provider/anthropic/enrollment').set('x-devryan-csrf','1').send({});
    expect(failed.status).toBe(409);expect(failed.body).toEqual({code:'native_claude_enrollment_refused'});
  });
  it('keeps setup usable with typed update requirement before capability is installed',async()=>{
    const app=createApp({isProviderAdministrator:()=>true,getClaudeEnrollmentOwner:()=>null});
    const response=await request(app.app).get('/api/provider/anthropic/enrollment');
    expect(response.status).toBe(409);expect(response.body).toEqual({code:'native_claude_enrollment_update_required'});
  });
});

const createApp = (overrides = {}) => {
  const app = express();
  if (overrides.useJsonParser !== false) {
    app.use(express.json());
  }

  const dependencies = {
    openCodeClient: createNativeConsumerFixture({ readFixture: (...args) => globalThis.fetch(...args) }),

    clientReloadDelayMs: 0,
    getOpenCodeResolutionSnapshot: vi.fn(async () => ({})),
    formatSettingsResponse: vi.fn((settings) => settings),
    readSettingsFromDisk: vi.fn(async () => ({})),
    readSettingsFromDiskMigrated: vi.fn(async () => ({})),
    persistSettings: vi.fn(async (settings) => settings),
    sanitizeProjects: vi.fn((projects) => projects),
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    ensureNativeDirectory: vi.fn(async () => {}),
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
    // Never let a route test reach the real Antigravity account files.
    listAntigravityAccountsPaths: vi.fn(async () => []),
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
    resolveClaudeCodeLaunch: vi.fn(({ pathValue }) => {
      const executable = join(pathValue, 'claude');
      return existsSync(executable)
        ? { executable, pathValue, source: 'path' }
        : null;
    }),
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
    readClaudePromptMode: vi.fn(() => ({
      ok: true,
      mode: 'combined',
      compatibilityMode: false,
    })),
    setClaudePromptCompatibilityMode: vi.fn((compatibilityMode) => ({
      ok: true,
      changed: true,
      mode: compatibilityMode ? 'claude-only' : 'combined',
      compatibilityMode,
    })),
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'getNativeRuntimeOwner')) {
    const owner = {
      verifyConfiguration: vi.fn(async () => {}), recheck: vi.fn(async () => {}),
      readAuthenticationSource: vi.fn(async () => ({ exists: dependencies.cursorSdkRuntime?.getRuntimeStatus?.()?.sdkAuthConfigured === true, path: null })),
      readSources: vi.fn(() => dependencies.getProviderSources().sources),
      listRemainingConfigSources: vi.fn(() => []),
      disconnectCredentials: vi.fn(async (committed, started) => { started(); committed(); }),
      removeConfiguration: vi.fn(async () => {}),
    };
    dependencies.getNativeRuntimeOwner = () => ({ withProviderConfigurationAuthorization: async (_input, run) => run(owner) });
  }
  if (!Object.hasOwn(overrides, 'openCodeClient')) {
    dependencies.openCodeClient = createNativeConsumerFixture({ readFixture: (...args) => globalThis.fetch(...args), headers: dependencies.getOpenCodeAuthHeaders });
    dependencies.openCodeClient.sessions.archive = vi.fn(async (id, archived) => ({ id, time: { archived } }));
  }
  dependencies.cursorSessionTitleRuntime ??= { schedule: vi.fn(async () => false) };
  dependencies.standardSessionTitleRuntime ??= { schedule: vi.fn(async () => false), processOpenCodeEvent: vi.fn() };
  delete dependencies.useJsonParser;
  if (overrides.useCommonRequestMiddleware === true) {
    registerCommonRequestMiddleware(app, { express });
  }
  delete dependencies.useCommonRequestMiddleware;

  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OpenCode provider routes', () => {
  const nativeFixture = (overrides = {}) => {
    const owner = {
      verifyConfiguration: vi.fn(async () => {}), recheck: vi.fn(async () => {}),
      readSources: vi.fn(() => ({ user: { exists: false, path: null }, project: { exists: false, path: null }, custom: { exists: false, path: null } })),
      readAuthenticationSource: vi.fn(async () => ({ exists: false, path: null })),
      listRemainingConfigSources: vi.fn(() => []),
      disconnectCredentials: vi.fn(async (committed, started) => { started(); committed(); }),
      removeConfiguration: vi.fn(async committed => { committed('user'); }), ...overrides,
    };
    const run = vi.fn(async (_input, action) => action(owner));
    return { ...createApp({ openCodeClient: { generation: () => 2 }, getNativeRuntimeOwner: () => ({ withProviderConfigurationAuthorization: run }) }), owner, run };
  };
  it('combines native credentials and selected config removal through the existing apply owner', async () => {
    const f = nativeFixture(), response = await request(f.app).delete('/api/provider/openai/auth?scope=all&directory=/tmp/project');
    expect(response.status).toBe(200); expect(response.body.removedSources).toEqual({ auth: true, user: true, project: false, custom: false });
    expect(f.run).toHaveBeenCalledWith({ providerID: 'openai', scope: 'all', directory: '/tmp/project' }, expect.any(Function));
    expect(f.dependencies.markConfigChange).toHaveBeenCalledWith('provider openai disconnected (all)', { providerId: 'openai', scope: 'all', partial: false }, true);
    expect(f.dependencies.removeProviderConfig).not.toHaveBeenCalled(); expect(authModule.removeProviderAuth).not.toHaveBeenCalled();
  });
  it('validates all configuration before credential effects', async () => {
    const f = nativeFixture({ verifyConfiguration: vi.fn(async () => { throw Object.assign(new Error('invalid config'), { code: 'INVALID_JSONC', statusCode: 409 }); }) });
    const response = await request(f.app).delete('/api/provider/openai/auth?scope=all');
    expect(response.status).toBe(409); expect(response.body.partial).toBe(false); expect(f.owner.disconnectCredentials).not.toHaveBeenCalled(); expect(f.dependencies.markConfigChange).not.toHaveBeenCalled();
  });
  it('retains pending apply revision and partial outcome after a source commit failure', async () => {
    const f = nativeFixture({ removeConfiguration: vi.fn(async () => { throw Object.assign(new Error('changed config'), { code: 'native_provider_configuration_changed', statusCode: 409 }); }) });
    const response = await request(f.app).delete('/api/provider/cursor-acp/auth?scope=all');
    expect(response.status).toBe(409); expect(response.body.partial).toBe(true); expect(response.body.removedSources.auth).toBe(true); expect(response.body.applyRevision).toBe(1); expect(response.body.success).toBe(false); expect(f.dependencies.markConfigChange).toHaveBeenCalledTimes(1);
  });
  it('reports uncertain credential ACK without claiming successful removal', async () => {
    const f = nativeFixture({ disconnectCredentials: vi.fn(async (_committed, started) => { started(); throw Object.assign(new Error('lost ACK'), { code: 'native_credential_commit_uncertain', statusCode: 503 }); }) });
    const response = await request(f.app).delete('/api/provider/openai/auth?scope=all');
    expect(response.status).toBe(503); expect(response.body.partial).toBe(true); expect(response.body.removedSources.auth).toBe(false); expect(response.body.applyRevision).toBe(1); expect(f.owner.removeConfiguration).not.toHaveBeenCalled();
  });
  it('retains failure when existing apply marker rejects after actual mutation', async () => {
    const f = nativeFixture(); f.dependencies.markConfigChange.mockRejectedValue(new Error('apply store unavailable'));
    const response = await request(f.app).delete('/api/provider/openai/auth?scope=all');
    expect(response.status).toBe(500); expect(response.body.recoveryRequired).toBe(true); expect(response.body.removedSources.auth).toBe(true); expect(response.body.success).toBe(false);
  });
  it('reads native Cursor source/status through fresh exact-directory metadata', async () => {
    const f = nativeFixture({ readAuthenticationSource: vi.fn(async () => ({ exists: true, path: null })) });
    const source = await request(f.app).get('/api/provider/cursor-acp/source?directory=/tmp/project');
    expect(source.status).toBe(200); expect(source.body.sources.auth).toEqual({ exists: true, path: null });
    const status = await request(f.app).get('/api/provider/cursor-acp/runtime-status?directory=/tmp/project');
    expect(status.status).toBe(200); expect(status.body.sdkAuthConfigured).toBe(true); expect(status.body.authObservation).toBe('known');
    expect(f.run.mock.calls.every(([input]) => input.directory === '/tmp/project' && input.scope === 'read')).toBe(true);
  });

  it('archives through the gen-2 client and rejects unrelated metadata mutations', async () => {
    const archive = vi.fn(async (id, at) => ({ id, time: { archived: at } }));
    const { app } = createApp({ openCodeClient: { generation: () => 2, sessions: { archive } } });
    const response = await request(app).patch('/api/session/ses_1').send({ time: { archived: 42 } });
    expect(response.status).toBe(200);
    expect(response.body.time.archived).toBe(42);
    expect(archive).toHaveBeenCalledWith('ses_1', 42, { directory: '/tmp/project' });
    for (const body of [{ time: { archived: -1 } }, { time: { archived: 2, other: true } }, { time: { archived: 0 }, metadata: {} }]) {
      expect((await request(app).patch('/api/session/ses_1').send(body)).status).toBe(400);
    }
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('preserves gen-2 Cursor message cursors and rejects invalid page queries without replay', async () => {
    const messages = vi.fn(async () => ({ records: [{ info: { id: 'msg_a' }, parts: [] }], cursor: 'v2:opaque' }));
    const { app } = createApp({
      openCodeClient: { generation: () => 2, sessions: { messages } },
      cursorSdkRuntime: { getSessionMessages: async () => [{ info: { id: 'msg_b' }, parts: [] }] },
    });
    const response = await request(app).get('/api/session/ses_1/message?limit=2');
    expect(response.status).toBe(200);
    expect(response.body.map((record) => record.info.id)).toEqual(['msg_a', 'msg_b']);
    expect(response.headers['x-next-cursor']).toBe('v2:opaque');
    expect((await request(app).get('/api/session/ses_1/message?limit=bad')).status).toBe(400);
    messages.mockRejectedValueOnce(Object.assign(new Error('runtime changed'), { statusCode: 503, code: 'opencode_runtime_changed' }));
    expect((await request(app).get('/api/session/ses_1/message?limit=2')).status).toBe(503);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('returns display-only default thinking metadata without changing model options', async () => {
    const options = { reasoningEffort: 'high' };
    const original = { id: 'gpt-5.5', api: { id: 'gpt-5.5', npm: '@ai-sdk/openai' }, variants: { low: {}, medium: {}, high: {} }, options };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ providers: [{ id: 'openai', models: { 'gpt-5.5': original } }], default: { openai: 'gpt-5.5' } }),
    });
    const { app } = createApp({
      buildOpenCodeUrl: requestPath => 'http://opencode.test' + requestPath,
      cursorSdkRuntime: null,
    });
    const response = await request(app).get('/api/config/providers').expect(200);
    const returned = response.body.providers.find(provider => provider.id === 'openai').models['gpt-5.5'];
    expect(returned.defaultThinkingLevel).toBe('high');
    expect(returned.options).toEqual(options);
    expect(original).not.toHaveProperty('defaultThinkingLevel');
    expect(response.body.default).toEqual({ openai: 'gpt-5.5' });
  });

  let tempDir = null;

  afterEach(() => {
    __resetGitHubCopilotModelDiscoveryCache();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    authModule.removeProviderAuth.mockImplementation(() => false);
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

  it('refuses uncomposed gen-2 OpenAI disconnect without touching legacy auth or configuration', async () => {
    const { app, dependencies } = createApp({ openCodeClient: { generation: () => 2 }, getNativeRuntimeOwner: () => null });
    app.delete('/api/provider/:providerId/auth', (_req, res) => res.json({ ownedNative: true }));
    const response = await request(app).delete('/api/provider/openai/auth?scope=all');
    expect(response.status).toBe(503); expect(response.body.code).toBe('native_provider_configuration_owner_required');
    expect(authModule.removeProviderAuth).not.toHaveBeenCalled();
    expect(dependencies.removeProviderConfig).not.toHaveBeenCalled();
    expect(dependencies.markConfigChange).not.toHaveBeenCalled();
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

  it('removes the active project provider config when disconnect-all supplies a directory', async () => {
    const removeProviderConfig = vi.fn(() => true);
    const { app, dependencies } = createApp({ removeProviderConfig });

    const response = await request(app)
      .delete('/api/provider/google/auth?scope=all&directory=%2Ftmp%2Fproject')
      .expect(200);

    expect(dependencies.resolveProjectDirectory).toHaveBeenCalled();
    expect(removeProviderConfig).toHaveBeenCalledWith('google', '/tmp/project', 'project');
    expect(response.body.removedSources).toEqual({
      auth: false,
      user: true,
      project: true,
      custom: true,
    });
    expect(response.body.sources).toMatchObject({
      auth: { exists: false },
      project: { exists: false },
    });
  });

  it('removes both supported Google auth aliases when disconnecting Google', async () => {
    authModule.removeProviderAuth.mockImplementation((providerId) => (
      providerId === 'google.oauth'
    ));
    const { app } = createApp();

    const response = await request(app).delete('/api/provider/google/auth?scope=all').expect(200);

    expect(authModule.removeProviderAuth).toHaveBeenCalledWith('google');
    expect(authModule.removeProviderAuth).toHaveBeenCalledWith('google.oauth');
    expect(response.body.removed).toBe(true);
  });

  it('invalidates provider runtime state for an idempotent disconnect', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .delete('/api/provider/antigravity/auth?scope=all')
      .expect(200);

    expect(response.body.removed).toBe(false);
    expect(response.body.removedSources).toEqual({
      auth: false,
      user: false,
      project: false,
      custom: false,
    });
    expect(dependencies.markConfigChange).toHaveBeenCalledWith(
      'provider antigravity disconnected (all)',
      { providerId: 'antigravity', scope: 'all' },
      true,
    );
  });

  it('deletes Antigravity accounts stored in runtime overlay directories', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'devryan-antigravity-accounts-'));
    const accountPaths = ['overlay-a', 'overlay-b'].map((key) => {
      mkdirSync(join(tempDir, key), { recursive: true });
      const accountPath = join(tempDir, key, 'antigravity-accounts.json');
      writeFileSync(accountPath, JSON.stringify({ accounts: [{ email: 'fixture' }] }), 'utf8');
      return accountPath;
    });
    const { app } = createApp({
      listAntigravityAccountsPaths: vi.fn(async () => [join(tempDir, 'missing.json'), ...accountPaths]),
    });

    const response = await request(app)
      .delete('/api/provider/antigravity/auth?scope=all')
      .expect(200);

    expect(response.body.removedSources.auth).toBe(true);
    expect(response.body.stillProvidedBy).toEqual([]);
    expect(accountPaths.map((accountPath) => existsSync(accountPath))).toEqual([false, false]);
  });

  it('reports every config file and credential env var that still provides a disconnected provider', async () => {
    const listProviderConfigFiles = vi.fn(() => ['/tmp/home/.config/opencode/opencode.json']);
    const { app, dependencies } = createApp({
      listProviderConfigFiles,
      getProviderEnvironmentSnapshot: () => ({ GEMINI_API_KEY: 'secret-fixture-value' }),
    });

    const response = await request(app)
      .delete('/api/provider/google/auth?scope=all')
      .expect(200);

    expect(listProviderConfigFiles).toHaveBeenCalledWith('google', null);
    expect(response.body.stillProvidedBy).toEqual(expect.arrayContaining([
      { type: 'config', path: '/tmp/home/.config/opencode/opencode.json' },
      { type: 'env', name: 'GEMINI_API_KEY' },
    ]));
    expect(JSON.stringify(response.body)).not.toContain('secret-fixture-value');
    expect(response.body.message).toBe('Provider is still configured elsewhere');
    // The restart still runs so whatever was removed takes effect.
    expect(dependencies.markConfigChange).toHaveBeenCalled();
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

  it('checks native selected credentials without CLI execution or config mutation', async () => {
    const inspectClaude=vi.fn(async input=>{expect(input).toEqual({kind:'status',directory:'/tmp/project'});return {installed:true,path:null,loggedIn:true,authStatus:'authenticated'};});
    const {app,dependencies}=createApp({getNativeRuntimeOwner:()=>({inspectClaude})});
    const status=await request(app).get('/api/provider/anthropic/claude-cli').expect(200);
    expect(status.body.loggedIn).toBe(true);
    const connected=await request(app).post('/api/provider/anthropic/check-oauth?directory=%2Ftmp%2Fproject').expect(200);
    expect(connected.body).toMatchObject({success:true,configured:true,changed:false});
    expect(dependencies.resolveClaudeCodeLaunch).not.toHaveBeenCalled();expect(dependencies.buildAugmentedPath).not.toHaveBeenCalled();
    expect(dependencies.ensureAnthropicOAuthProviderConfig).not.toHaveBeenCalled();expect(dependencies.markConfigChange).not.toHaveBeenCalled();
  });

  it('missing or expired configured credentials remain unavailable and never probe ambient CLI',async()=>{
    for(const code of ['claude_credentials_missing','claude_credentials_expired','native_claude_account_ambiguous']){
      const {app,dependencies}=createApp({getNativeRuntimeOwner:()=>({inspectClaude:async()=>{throw Object.assign(new Error('private contents must not escape'),{code,status:401});}})});
      const status=await request(app).get('/api/provider/anthropic/claude-cli').expect(200);
      expect(status.body).toMatchObject({loggedIn:false,authStatus:'unavailable',errorCode:code,path:null});
      const check=await request(app).post('/api/provider/anthropic/check-oauth').expect(400);expect(check.body.code).toBe(code);
      expect(JSON.stringify(status.body)).not.toContain('private contents');expect(dependencies.resolveClaudeCodeLaunch).not.toHaveBeenCalled();
    }
    const {app,dependencies}=createApp();await request(app).get('/api/provider/anthropic/claude-cli').expect(503);expect(dependencies.resolveClaudeCodeLaunch).not.toHaveBeenCalled();
  });

  it('reads and updates the managed Claude prompt mode without exposing configuration data', async () => {
    const { app, dependencies } = createApp();

    const current = await request(app)
      .get('/api/provider/anthropic/prompt-mode')
      .expect(200);
    const updated = await request(app)
      .put('/api/provider/anthropic/prompt-mode')
      .send({ compatibilityMode: true })
      .expect(200);

    expect(current.body).toEqual({
      mode: 'combined',
      compatibilityMode: false,
      editable: true,
    });
    expect(updated.body).toEqual({
      success: true,
      changed: true,
      mode: 'claude-only',
      compatibilityMode: true,
      editable: true,
    });
    expect(dependencies.setClaudePromptCompatibilityMode).toHaveBeenCalledWith(true);
    expect(JSON.stringify(updated.body)).not.toMatch(/credential|profile|token/i);
  });

  it('validates Claude prompt-mode writes and keeps external runtimes read-only', async () => {
    const invalid = createApp();
    await request(invalid.app)
      .put('/api/provider/anthropic/prompt-mode')
      .send({ compatibilityMode: 'yes' })
      .expect(400);
    expect(invalid.dependencies.setClaudePromptCompatibilityMode).not.toHaveBeenCalled();

    const external = createApp({ isExternalOpenCode: vi.fn(() => true) });
    const current = await request(external.app)
      .get('/api/provider/anthropic/prompt-mode')
      .expect(200);
    await request(external.app)
      .put('/api/provider/anthropic/prompt-mode')
      .send({ compatibilityMode: true })
      .expect(409);

    expect(current.body).toEqual({
      mode: 'external',
      compatibilityMode: false,
      editable: false,
    });
    expect(external.dependencies.setClaudePromptCompatibilityMode).not.toHaveBeenCalled();
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
    expect(verifyConnection).toHaveBeenCalledWith({ directory: '/tmp/project' });
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
    expect(refreshVirtualProvider).toHaveBeenCalledWith({ reason: 'providers_route', directory: '/tmp/project' });
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
    expect(response.body).not.toHaveProperty('catalogIncomplete');

    fetchSpy.mockRestore();
  });

  const createCursorOnlyApp = () => createApp({
    buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
    cursorSdkRuntime: {
      getRuntimeStatus: vi.fn(),
      verifyConnection: vi.fn(),
      getVirtualProvider: vi.fn(),
      getCachedVirtualProvider: vi.fn(() => ({
        id: 'cursor-acp',
        name: 'Cursor',
        models: { auto: { id: 'auto', name: 'Auto' } },
      })),
      refreshVirtualProvider: vi.fn(() => Promise.resolve()),
      handlePromptAsync: vi.fn(),
      abortSession: vi.fn(),
      getSessionMessages: vi.fn(async () => []),
    },
  });

  it('marks the catalog incomplete while keeping Cursor when the upstream fetch fails', async () => {
    readAuthFile.mockReturnValue({});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const { app } = createCursorOnlyApp();

    const response = await request(app).get('/api/config/providers').expect(200);

    expect(response.body.catalogIncomplete).toBe(true);
    expect(response.body.providers.map((provider) => provider.id)).toEqual(['cursor-acp']);
    fetchSpy.mockRestore();
  });

  it('marks the catalog incomplete when upstream responds with an error status', async () => {
    readAuthFile.mockReturnValue({});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn(async () => ({ error: 'restarting' })),
    });
    const { app } = createCursorOnlyApp();

    const response = await request(app).get('/api/config/providers').expect(200);

    expect(response.body.catalogIncomplete).toBe(true);
    expect(response.body.providers.map((provider) => provider.id)).toEqual(['cursor-acp']);
    fetchSpy.mockRestore();
  });

  it('marks the catalog incomplete when integrations throw and upstream failed', async () => {
    readAuthFile.mockReturnValue({});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const { app } = createApp({
      buildOpenCodeUrl: vi.fn((requestPath) => `http://opencode.test${requestPath}`),
      getProviderSources: vi.fn(() => {
        throw new Error('provider source lookup failed');
      }),
      cursorSdkRuntime: null,
    });

    const response = await request(app).get('/api/config/providers').expect(200);

    expect(response.body).toEqual({ providers: [], default: {}, catalogIncomplete: true });
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
    expect(writeAuthFile).not.toHaveBeenCalled();
    expect(readAuthFile()).toMatchObject({ 'cursor-acp': { usageSessionToken: 'cursor-session-token' } });
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
    const archive = vi.fn(async () => ({ id: 'ses_1', time: { archived: 0 } }));
    const handlePromptAsync = vi.fn(async () => ({ handled: true, status: 204 }));
    const { app } = createApp({
      openCodeClient: { generation: () => 2, sessions: { archive } },
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

    expect(archive).toHaveBeenCalledWith('ses_1', 0, { directory: '/tmp/project' });
    expect(fetchSpy).not.toHaveBeenCalled();

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
      },
    });
  });

  it.each(
    ['builder', 'orchestrator'].flatMap((agent) =>
      [false, true].flatMap((planMode) => [
        ['openai', 'gpt-5.6-sol'],
        ['anthropic', 'claude-sonnet-4-5'],
        ['xai', 'grok-4.6'],
        ['opencode', 'nemotron-3.5-lightning-free'],
      ].map(([providerID, modelID]) => ({ agent, planMode, providerID, modelID }))),
    ),
  )('schedules standard-provider title generation for $agent $providerID prompts (plan=$planMode)', async ({
    agent,
    planMode,
    providerID,
    modelID,
  }) => {
    const schedule = vi.fn();
    const { app } = createApp({
      standardSessionTitleRuntime: { schedule },
    });
    app.use('/api', (_req, res) => res.status(204).end());

    const sessionID = `ses_${providerID}_${agent}_${planMode ? 'plan' : 'normal'}`;
    const visibleText = `repair ${providerID} ${agent} ${planMode ? 'plan' : 'normal'} session titles`;
    const parts = planMode
      ? [
          { type: 'text', text: 'User has requested to enter plan mode.', synthetic: true },
          { type: 'text', text: visibleText },
        ]
      : [{ type: 'text', text: visibleText }];

    await request(app)
      .post(`/api/session/${sessionID}/prompt_async?directory=%2Ftmp%2Fproject`)
      .send({
        model: { providerID, modelID },
        agent,
        variant: providerID === 'openai' ? 'medium' : undefined,
        messageID: 'msg_1',
        parts,
      })
      .expect(204);

    expect(schedule).toHaveBeenCalledWith({
      sessionID,
      directory: '/tmp/project',
      text: visibleText,
      providerID,
      modelID,
      variant: providerID === 'openai' ? 'medium' : undefined,
    });
  });

  it('applies cached Grok duplicate-tool overrides without awaiting catalog refresh', async () => {
    const refreshModel = vi.fn(() => new Promise(() => {}));
    const getPromptToolOverrides = vi.fn(() => ({ mcp__context_mode__ctx_search: false }));
    const { app } = createApp({
      xaiToolCatalogRuntime: { supportsProvider: () => true, getPromptToolOverrides, refreshModel },
    });
    app.post('/api/session/:sessionID/prompt_async', (req, res) => res.json({ tools: req.body.tools }));

    const response = await request(app)
      .post('/api/session/ses_grok/prompt_async?directory=%2Ftmp%2Fproject')
      .send({
        model: { providerID: 'xai', modelID: 'grok-4.6' },
        messageID: 'msg_1',
        tools: { unique_tool: true },
        parts: [{ type: 'text', text: 'reduce Grok startup latency' }],
      })
      .expect(200);

    expect(response.body.tools).toEqual({
      unique_tool: true,
      mcp__context_mode__ctx_search: false,
    });
    expect(getPromptToolOverrides).toHaveBeenCalledWith({
      directory: '/tmp/project',
      providerID: 'xai',
      modelID: 'grok-4.6',
    });
    expect(refreshModel).not.toHaveBeenCalled();
  });

  it('keeps a session\'s Grok tool overrides stable when the catalog refreshes mid-session', async () => {
    let overrides = { mcp__a: false };
    const getPromptToolOverrides = vi.fn(() => overrides);
    const { app } = createApp({
      xaiToolCatalogRuntime: { supportsProvider: () => true, getPromptToolOverrides, refreshModel: vi.fn() },
    });
    app.post('/api/session/:sessionID/prompt_async', (req, res) => res.json({ tools: req.body.tools }));
    const send = (sessionID) => request(app)
      .post(`/api/session/${sessionID}/prompt_async?directory=%2Ftmp%2Fproject`)
      .send({ model: { providerID: 'xai', modelID: 'grok-4.6' }, messageID: 'msg_1', parts: [{ type: 'text', text: 'hi' }] })
      .expect(200);
    expect((await send('ses_a')).body.tools).toEqual({ mcp__a: false });
    overrides = { mcp__b: false };
    // The same session keeps its first set; a new session gets the refreshed one.
    expect((await send('ses_a')).body.tools).toEqual({ mcp__a: false });
    expect((await send('ses_b')).body.tools).toEqual({ mcp__b: false });
  });

  it('warms the Grok tool catalog on a cold cache before forwarding the first prompt', async () => {
    const overrides = { mcp__context_mode__ctx_search: false };
    let warmed = false;
    const refreshModel = vi.fn(async () => {
      warmed = true;
    });
    const getPromptToolOverrides = vi.fn(() => (warmed ? overrides : null));
    const { app } = createApp({
      xaiToolCatalogRuntime: { supportsProvider: () => true, getPromptToolOverrides, refreshModel },
    });
    app.post('/api/session/:sessionID/prompt_async', (req, res) => res.json({ tools: req.body.tools }));

    const response = await request(app)
      .post('/api/session/ses_grok/prompt_async?directory=%2Ftmp%2Fproject')
      .send({
        model: { providerID: 'xai', modelID: 'grok-4.6' },
        messageID: 'msg_1',
        tools: { unique_tool: true },
        parts: [{ type: 'text', text: 'first Grok prompt in this directory' }],
      })
      .expect(200);

    expect(refreshModel).toHaveBeenCalledWith({
      directory: '/tmp/project',
      providerID: 'xai',
      modelID: 'grok-4.6',
    });
    expect(response.body.tools).toEqual({
      unique_tool: true,
      mcp__context_mode__ctx_search: false,
    });
  });

  it('forwards the prompt after the bounded wait when the cold-cache catalog refresh hangs', async () => {
    const refreshModel = vi.fn(() => new Promise(() => {}));
    const getPromptToolOverrides = vi.fn(() => null);
    const { app } = createApp({
      xaiToolCatalogRuntime: { supportsProvider: () => true, getPromptToolOverrides, refreshModel },
    });
    app.post('/api/session/:sessionID/prompt_async', (req, res) => res.json({ tools: req.body.tools }));

    const startedAt = Date.now();
    const response = await request(app)
      .post('/api/session/ses_grok/prompt_async?directory=%2Ftmp%2Fproject')
      .send({
        model: { providerID: 'xai', modelID: 'grok-4.6' },
        messageID: 'msg_1',
        tools: { unique_tool: true },
        parts: [{ type: 'text', text: 'first Grok prompt with a slow catalog' }],
      })
      .expect(200);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(response.body.tools).toEqual({ unique_tool: true });
  });

  it('schedules placeholder title recovery after a session list succeeds', async () => {
    const schedulePlaceholderRecovery = vi.fn();
    const { app } = createApp({
      standardSessionTitleRuntime: {
        schedule: vi.fn(),
        schedulePlaceholderRecovery,
      },
    });
    app.get('/api/session', (_req, res) => res.json([
      { id: 'ses_anthropic', title: '<!--plan-->' },
    ]));

    await request(app)
      .get('/api/session?directory=%2Ftmp%2Fproject')
      .expect(200);

    expect(schedulePlaceholderRecovery).toHaveBeenCalledWith({
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


describe('native project directory preparation', () => {
  it('does not publish project-open success until the exact registered directory is prepared', async () => {
    let settings = { activeProjectId: 'old', lastDirectory: '/old', projects: [] }; let release;
    const ensureNativeDirectory = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const persistSettings = vi.fn(async patch => (settings = { ...settings, ...patch }));
    const setOpenCodeWorkingDirectory = vi.fn();
    const { app } = createApp({ readSettingsFromDisk: async () => settings, persistSettings, ensureNativeDirectory, setOpenCodeWorkingDirectory });
    let finished = false;
    const pending = request(app).post('/api/opencode/directory').send({ path: '/new' }).then(response => { finished = true; return response; });
    await vi.waitFor(() => expect(ensureNativeDirectory).toHaveBeenCalledWith('/new'));
    expect(settings.projects).toContainEqual(expect.objectContaining({ path: '/new' }));
    expect(finished).toBe(false); expect(setOpenCodeWorkingDirectory).not.toHaveBeenCalled();
    release(); const response = await pending; expect(response.status).toBe(200);
    expect(setOpenCodeWorkingDirectory).toHaveBeenCalledWith('/new');
  });
  it.each([undefined, async () => { throw Object.assign(Error('protected'), { code: 'native_project_directory_protected', statusCode: 403 }); }])('restores the prior activation when native preparation refuses: %j', async ensureNativeDirectory => {
    let settings = { activeProjectId: 'old', lastDirectory: '/old', projects: [] };
    const setOpenCodeWorkingDirectory = vi.fn();
    const { app } = createApp({ readSettingsFromDisk: async () => settings, persistSettings: async patch => (settings = { ...settings, ...patch }), ensureNativeDirectory, setOpenCodeWorkingDirectory });
    const response = await request(app).post('/api/opencode/directory').send({ path: '/new' });
    expect(response.status).toBe(ensureNativeDirectory ? 403 : 503);
    expect(response.body.success).toBeUndefined();
    expect(settings).toMatchObject({ activeProjectId: 'old', lastDirectory: '/old' });
    expect(settings.projects).toContainEqual(expect.objectContaining({ path: '/new' }));
    expect(setOpenCodeWorkingDirectory).not.toHaveBeenCalled();
  });
  it('does not rewind a newer active project after a refused preparation', async () => {
    let settings = { activeProjectId: 'old', lastDirectory: '/old', projects: [] };
    const { app } = createApp({ readSettingsFromDisk: async () => settings, persistSettings: async patch => (settings = { ...settings, ...patch }),
      ensureNativeDirectory: async () => { settings = { ...settings, activeProjectId: 'newer', lastDirectory: '/newer' }; throw Object.assign(Error('conflict'), { statusCode: 409 }); } });
    expect((await request(app).post('/api/opencode/directory').send({ path: '/new' })).status).toBe(409);
    expect(settings).toMatchObject({ activeProjectId: 'newer', lastDirectory: '/newer' });
  });
});
