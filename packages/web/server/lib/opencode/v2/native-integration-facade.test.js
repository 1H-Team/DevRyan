import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import http from 'node:http';
import express from 'express';
import request from '../../../test-supertest.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeV2FacadeRouter } from './facade-routes.js';
import { toProviderAccountList } from './native-integration-facade.js';
import { createNativeIntegrationAuthorization } from '../runtime-host/native-integration-authorization.js';
import { credentialMutationFingerprint as hash } from '../runtime-host/native-credential-mutation-owner.js';
import { reviewedMcpConfiguration } from '../runtime-host/reviewed-mcp-configuration.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const denied = code => Object.assign(new Error(code), { code, statusCode: 403 });
const SECRET_FIELD = /^(?:key|apiKey|token|accessToken|refreshToken|access|refresh|secret|value|expectedFingerprint|fingerprint|methodID|metadata)$/i;
const expectNoSecretFields = (value, path = '$') => {
  if (Array.isArray(value)) { value.forEach((item, index) => expectNoSecretFields(item, `${path}[${index}]`)); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [field, item] of Object.entries(value)) {
    expect(SECRET_FIELD.test(field), `${path}.${field}`).toBe(false);
    expectNoSecretFields(item, `${path}.${field}`);
  }
};
async function setup() {
  const context = new AsyncLocalStorage();
  const original = { active: true, directories: new Set(['/owned']) }, replacement = { active: true, directories: new Set(['/owned']) };
  let epoch = 1, ready = true, revokeBeforeMutation = false, starts = 0;
  const nativeCalls = [], nativeLocations = [], mutations = [], attempts = new Map(), oauthBodies = [];
  let releaseStart, startEntered;
  const startBarrier = new Promise(resolve => { startEntered = resolve; });
  let startPause, loseStartAcknowledgement = false, allowStart = true;
  const snapshot = { locations: ['/owned', '/foreign'].map(directory => ({ directory, configuration: { providers: { openai: {} } },
    compatibility: { mcp: { remote: { type: 'remote', url: 'http://127.0.0.1:9/mcp', oauth: {}, enabled: true },
      disabled: { type: 'remote', url: 'http://127.0.0.1:9/disabled', enabled: false } } } })) };
  const digest = reviewedMcpConfiguration(snapshot, ['/owned']).get('/owned').get('remote').configurationDigest;
  const records = new Map([
    ['credential_openai', { id: 'credential_openai', integrationID: 'openai', label: 'Account', value: { type: 'oauth', methodID: 'chatgpt-token-sharing', access: 'synthetic-access', refresh: 'synthetic-refresh' } }],
    ['credential_mcp', { id: 'credential_mcp', integrationID: 'mcp_remote', label: 'Remote', value: { type: 'oauth', methodID: 'mcp_method', access: 'synthetic-mcp-access' } }],
  ]);
  // Catalog providers as OpenCode registers them: keys (with env names), plugin OAuth, form-bound
  // methods, a web-search tool and the retired Anthropic provider.
  const catalog = {
    deepseek: [{ type: 'key' }, { type: 'env', names: ['DEEPSEEK_API_KEY'] }],
    'github-copilot': [{ id: 'device', type: 'oauth', label: 'GitHub Copilot', form: [
      { type: 'string', key: 'deploymentType', title: 'Deployment', required: true, options: [{ label: 'GitHub.com', value: 'github.com' }, { label: 'Enterprise', value: 'enterprise' }] },
      { type: 'string', key: 'enterpriseUrl', required: true, when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }] }] }],
    snowflake: [{ type: 'key', form: [{ type: 'integer', key: 'port' }] }],
    azure: [{ type: 'key', label: 'API key', form: [{ type: 'string', key: 'resourceName', required: true }] }],
    tinyfish: [{ type: 'key' }], anthropic: [{ type: 'key' }],
  };
  const names = { openai: 'OpenAI', 'cursor-acp': 'Cursor', mcp_remote: 'remote', deepseek: 'DeepSeek', 'github-copilot': 'GitHub Copilot' };
  const info = id => ({ id, name: names[id] ?? id, metadata: id === 'mcp_remote' ? { source: 'mcp' } : {},
    methods: id === 'openai' ? [{ id: 'key', type: 'key', label: 'API key' }, { id: 'chatgpt-browser', type: 'oauth', label: 'Codex browser (legacy)' }]
      : catalog[id] ? catalog[id]
      : id === 'opencode' ? [{ id: 'key', type: 'key', label: 'API key' }, { id: 'console', type: 'oauth', label: 'OpenCode Console' }]
      : ['cursor-acp', 'opencode-go'].includes(id) ? [{ id: 'key', type: 'key', label: 'API key' }]
      : id === 'xai' ? [{ id: 'device', type: 'oauth', label: 'SuperGrok Subscription' }, { type: 'key', label: 'Manually enter API Key' }] : [{ id: 'mcp_method', type: 'oauth', label: 'Remote OAuth' }],
    connections: [...records.values()].filter(row => row.integrationID === id).map(row => ({ type: 'credential', id: row.id, label: row.label, method: row.value.type })) });
  const grants = createNativeIntegrationAuthorization({ controllerIdentity: () => ready ? 'owned_controller' : null,
    verifyBinding: async binding => { if (!['/owned', '/foreign'].includes(binding.directory) || binding.configurationDigest !== (binding.kind === 'mcp' ? digest : hash({}))) throw denied('fixture_binding_mismatch'); },
    captureWebAuthorization: async spec => {
      const caller = context.getStore();
      if (!caller?.directories.has(spec.directory)) throw denied('fixture_location_denied');
      if (spec.operation.endsWith('.oauth.start') && !allowStart) throw denied('fixture_start_denied');
      return () => { if (!caller.active) throw denied('original_caller_revoked'); };
    }, authorizeConfiguredConnection: async () => { throw denied('unexpected_connection_grant'); } });
  cleanup.push(() => grants.close());
  const binding = (kind, methodID, directory = '/owned', integrationID) => ({ kind, directory, controllerInstanceID: 'owned_controller', acquisitionID: directory === '/owned' ? 'owned_acquisition' : 'foreign_acquisition',
    configurationDigest: kind === 'mcp' ? digest : hash({}), integrationID: kind === 'mcp' ? 'mcp_remote' : kind === 'cursor' ? 'cursor-acp' : kind === 'provider' ? integrationID ?? 'xai' : 'openai',
    ...(kind === 'mcp' ? { server: 'remote' } : {}), ...(methodID ? { methodID } : {}) });
  const native = express(); native.use(express.json());
  native.use(async (req, res) => {
    nativeCalls.push({ method: req.method, path: req.path });
    try {
      const directory = decodeURIComponent(req.headers['x-opencode-directory'] ?? '');
      nativeLocations.push({ path: req.path, directory });
      if (!['/owned', '/foreign'].includes(directory)) throw denied('fixture_native_location_required');
      if (req.headers.authorization !== 'Bearer owned-native-http') throw denied('fixture_native_auth');
      if (req.method === 'GET' && req.path === '/api/mcp') return res.json([{ name: 'remote', integrationID: 'mcp_remote' }]);
      if (req.method === 'GET' && req.path === '/api/integration') return res.json(['openai', 'cursor-acp', 'xai', 'opencode', 'opencode-go', 'mcp_remote', ...Object.keys(catalog)].map(info));
      if (req.method === 'GET' && req.path === '/api/websearch/provider') return res.json([{ id: 'tinyfish', name: 'TinyFish' }]);
      if (req.method === 'GET' && req.path.includes('/connect/oauth/')) {
        const attempt = attempts.get(req.path.split('/').at(-1));
        await grants.reauthorize({ authorizationID: attempt.grant.authorizationID, binding: attempt.bound });
        return res.json({ status: attempt.status ?? 'pending' });
      }
      if (req.method === 'GET' && req.path.startsWith('/api/integration/')) return res.json(info(req.path.split('/')[3]));
      if (req.path.startsWith('/api/experimental/mcp/')) {
        await grants.authorizeControl({ binding: binding('mcp', 'mcp_method', directory), operation: `mcp.${req.path.split('/').at(-1)}`,
          requestAuthorization: req.headers['x-devryan-native-integration-grant'] });
        return res.json(true);
      }
      if (req.path.endsWith('/connect/oauth')) {
        const integrationID = req.path.split('/')[3]; oauthBodies.push(req.body);
        const kind = integrationID === 'openai' ? 'openai' : integrationID === 'mcp_remote' ? 'mcp' : 'provider', bound = binding(kind, req.body.methodID, directory, integrationID);
        const grant = await grants.capture({ binding: bound, operation: 'oauth', requestAuthorization: req.headers['x-devryan-native-integration-grant'] });
        if (startPause) { startEntered(); await startPause; }
        const attemptID = `attempt_${++starts}`; attempts.set(attemptID, { grant, bound });
        if (loseStartAcknowledgement) return res.status(503).json({ code: 'fixture_start_ack_lost', message: 'fixture_start_ack_lost' });
        return res.json({ attemptID, mode: kind === 'openai' ? 'auto' : 'code', url: 'http://127.0.0.1:9/owned-issuer', expiresAt: Date.now() + 60_000 });
      }
      if (req.method === 'DELETE' && req.path.includes('/connect/oauth/')) {
        const attempt = attempts.get(req.path.split('/').at(-1));
        await grants.reauthorize({ authorizationID: attempt.grant.authorizationID, binding: attempt.bound });
        attempts.delete(req.path.split('/').at(-1)); return res.json(true);
      }
      if (req.path.endsWith('/complete')) {
        const attempt = attempts.get(req.path.split('/').at(-2));
        await grants.reauthorize({ authorizationID: attempt.grant.authorizationID, binding: attempt.bound });
        attempts.delete(req.path.split('/').at(-2)); return res.json(true);
      }
      res.status(404).end();
    } catch (error) { res.status(error.statusCode ?? 500).json({ code: error.code, message: error.code }); }
  });
  const server = http.createServer(native); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const runtime = () => ({ generation: 2, version: '2.0.20', baseUrl: `http://127.0.0.1:${server.address().port}`, epoch });
  const owner = { getConfigurationSnapshot: () => snapshot, isReady: () => ready,
    withIntegrationOperation: (spec, action) => grants.withCallerOperation(spec, action),
    credentialMetadata: spec => grants.withCallerOperation(spec, async () => [...records.values()].filter(row => row.integrationID === spec.integrationID)
      .map(row => ({ id: row.id, integrationID: row.integrationID, label: row.label, valueType: row.value.type,
        ...(row.value.methodID ? { methodID: row.value.methodID } : {}), expectedFingerprint: hash(row), active: true }))),
    credentialOperation: (spec, mutation) => grants.withCallerOperation(spec, async () => {
      const bound = { ...binding(spec.kind, spec.methodID, spec.directory, spec.integrationID), operation: mutation.operation, valueType: spec.valueType,
        credentialID: spec.credentialID, expectedFingerprint: spec.expectedFingerprint, requestedFingerprint: spec.requestedFingerprint };
      const grant = await grants.capture({ binding: bound, operation: spec.kind === 'mcp' ? 'remove' : 'mutation',
        requestAuthorization: grants.requestHeaders()['x-devryan-native-integration-grant'] });
      if (revokeBeforeMutation) original.active = false;
      const authority = await grants.resolveMutation({ authorizationID: grant.authorizationID, binding: bound }); await authority.reauthorize();
      if (mutation.operation !== 'create' && hash(records.get(mutation.id)) !== spec.expectedFingerprint) throw denied('fixture_record_changed');
      mutations.push(mutation.operation);
      if (mutation.operation === 'create') records.set('created_key', { id: 'created_key', label: '', ...mutation.input });
      if (mutation.operation === 'update') records.get(mutation.id).label = mutation.updates.label;
      if (mutation.operation === 'remove') records.delete(mutation.id);
      return { credentialID: mutation.id ?? 'created_key' };
    }) };
  const app = express(); app.use((req, _res, next) => context.run(req.headers['x-fixture-other'] ? replacement : original, next));
  app.use('/api', createOpenCodeV2FacadeRouter({ openCodeClient: { generation: () => 2 }, getOpenCodeRuntime: runtime,
    getNativeRuntimeOwner: () => owner, resolveRequestDirectory: () => '/owned',
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer owned-native-http', ...grants.requestHeaders() }) }));
  return { app, original, records, oauthBodies, completeOAuth: status => { for(const attempt of attempts.values()) attempt.status = status; }, nativeCalls, nativeLocations, mutations, starts: () => starts,
    pauseStart: () => { startPause = new Promise(resolve => { releaseStart = resolve; }); return { entered: startBarrier, release: () => releaseStart() }; },
    allowStart: value => { allowStart = value; },
    allowForeign: () => { original.directories.add('/foreign'); },
    loseStartAck: () => { loseStartAcknowledgement = true; },
    enableCursor: () => { snapshot.locations[0].configuration.providers['cursor-acp'] = {}; },
    configureProvider: () => { snapshot.locations[0].configuration.providers.openai = { models: { fixture: {} } }; },
    bumpEpoch: () => { epoch++; }, revokeAtCommit: () => { revokeBeforeMutation = true; } };
}

describe('native integration public facade with original caller grants', () => {
  it('polls automatic OpenAI status without calling complete and supports cancel and restart', async () => {
    const f = await setup();
    expect((await request(f.app).post('/api/provider/openai/oauth/authorize').send({ method: 0 })).body.method).toBe('auto');
    expect((await request(f.app).post('/api/provider/openai/oauth/callback').send({ method: 0 })).body).toEqual({ status: 'pending' });
    f.completeOAuth('complete');
    expect((await request(f.app).post('/api/provider/openai/oauth/callback').send({ method: 0 })).body).toEqual({ status: 'complete' });
    expect(f.nativeCalls.some(call => call.path.endsWith('/complete'))).toBe(false);
    expect((await request(f.app).post('/api/provider/openai/oauth/authorize').send({ method: 0 })).status).toBe(200);
    expect((await request(f.app).post('/api/provider/openai/oauth/authorize').send({ method: 0 })).status).toBe(200);
    expect((await request(f.app).post('/api/provider/openai/oauth/cancel').send({ method: 0 })).status).toBe(200);
    expect(f.nativeCalls.filter(call => call.method === 'DELETE' && call.path.includes('/connect/oauth/'))).toHaveLength(2);
  });

  it('preserves MCP routes and rejects disabled or foreign-location effects before dispatch', async () => {
    const f = await setup();
    expect((await request(f.app).post('/api/mcp/remote/connect').send({})).status).toBe(200);
    const started = await request(f.app).post('/api/mcp/remote/auth').send({});
    expect(started.status).toBe(200); expect(started.body.authorizationUrl).toBe('http://127.0.0.1:9/owned-issuer');
    expect(JSON.stringify(started.body)).not.toMatch(/acquisitionID|authorizationID|configurationDigest|synthetic-access/);
    expect((await request(f.app).post('/api/mcp/remote/auth/callback').send({ code: 'owned-code' })).status).toBe(200);
    const before = f.nativeCalls.length;
    expect((await request(f.app).post('/api/mcp/disabled/connect').send({})).status).toBe(403);
    expect((await request(f.app).post('/api/mcp/remote/connect?directory=/foreign').send({})).status).toBe(403);
    expect(f.nativeCalls).toHaveLength(before);
  });
  it('maps provider methods and key creation without a public secret credential route', async () => {
    const f = await setup();
    // Every connectable catalog provider; no web-search tool, MCP server, form-only method,
    // retired Anthropic or OpenCode Console OAuth.
    // OpenCode's provider name rides on each method when it differs from the ID.
    expect((await request(f.app).get('/api/provider/auth')).body).toEqual({
      openai: [{ type: 'api', label: 'API key', providerName: 'OpenAI' }, { type: 'oauth', label: 'Codex browser (legacy)', providerName: 'OpenAI' }],
      xai: [{ type: 'oauth', label: 'SuperGrok Subscription' }, { type: 'api', label: 'Manually enter API Key' }],
      opencode: [{ type: 'api', label: 'API key' }], 'opencode-go': [{ type: 'api', label: 'API key' }], 'cursor-acp': [{ type: 'api', label: 'API key', providerName: 'Cursor' }],
      deepseek: [{ type: 'api', label: '', providerName: 'DeepSeek' }],
      // Forms Providers can render travel with the method; snowflake's integer field cannot, so it is left out.
      azure: [{ type: 'api', label: 'API key', fields: [{ key: 'resourceName', type: 'string', required: true }] }],
      'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot', providerName: 'GitHub Copilot', fields: [
        { key: 'deploymentType', type: 'string', title: 'Deployment', required: true, options: [{ value: 'github.com', label: 'GitHub.com' }, { value: 'enterprise', label: 'Enterprise' }] },
        { key: 'enterpriseUrl', type: 'string', required: true, when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }] }] }] });
    expect((await request(f.app).put('/api/auth/deepseek').send({ type: 'api', key: 'synthetic-deepseek' })).status).toBe(200);
    expect(f.records.get('created_key')).toMatchObject({ integrationID: 'deepseek' });
    for (const providerID of ['github-copilot', 'azure', 'tinyfish', 'anthropic', 'mcp_remote', 'claude-agent'])
      expect([providerID, (await request(f.app).put('/api/auth/' + providerID).send({ type: 'api', key: 'synthetic' })).status]).not.toEqual([providerID, 200]);
    // Form answers are checked as OpenCode checks them, then forwarded with the method.
    for (const answer of [undefined, {}, { deploymentType: 'gitlab.com' }, { deploymentType: 'enterprise' }, { deploymentType: 'github.com', enterpriseUrl: 'x.ghe.com' }, { deploymentType: 'github.com', extra: 'x' }])
      expect((await request(f.app).post('/api/provider/github-copilot/oauth/authorize').send({ method: 0, ...(answer ? { answer } : {}) })).status).toBe(400);
    const copilot = await request(f.app).post('/api/provider/github-copilot/oauth/authorize').send({ method: 0, answer: { deploymentType: 'enterprise', enterpriseUrl: 'co.ghe.com' } });
    expect(copilot.status).toBe(200); expect(copilot.body).toMatchObject({ url: 'http://127.0.0.1:9/owned-issuer' });
    expect(f.oauthBodies.at(-1)).toEqual({ methodID: 'device', answer: { deploymentType: 'enterprise', enterpriseUrl: 'co.ghe.com' } });
    expect((await request(f.app).put('/api/auth/azure').send({ type: 'api', key: 'synthetic-azure', answer: { resourceName: 'my-models' } })).status).toBe(200);
    expect(f.records.get('created_key')).toMatchObject({ integrationID: 'azure', value: { type: 'key', key: 'synthetic-azure', metadata: { resourceName: 'my-models' } } });
    expect((await request(f.app).put('/api/auth/deepseek').send({ type: 'api', key: 'synthetic', answer: { resourceName: 'x' } })).status).toBe(400);
    expect((await request(f.app).post('/api/provider/github-copilot/oauth/authorize').send({ method: 1 })).status).toBe(400);
    expect((await request(f.app).post('/api/provider/opencode/oauth/authorize').send({ method: 0 })).status).toBe(400);
    f.mutations.splice(0);
    expect((await request(f.app).post('/api/provider/openai/oauth/authorize').send({ method: 1 })).status).toBe(400);
    expect((await request(f.app).post('/api/provider/openai/oauth/callback').send({ method: 1, code: 'owned-code' })).status).toBe(400);
    expect((await request(f.app).put('/api/auth/openai').send({ type: 'api', key: 'synthetic-fixture-key' })).body).toEqual({ success: true, configured: true });
    for (const providerID of ['xai','opencode','opencode-go']) expect((await request(f.app).put('/api/auth/'+providerID).send({type:'api',key:'synthetic-'+providerID})).status).toBe(200);
    expect(f.mutations).toEqual(['create','create','create','create']);
    expect((await request(f.app).get('/api/credential')).status).toBe(404);
    expect((await request(f.app).get('/api/opencode-v2/credential')).status).toBe(404);
    expect(f.nativeCalls.some(call => call.path.startsWith('/api/credential'))).toBe(false);
  });
  it('lists provider accounts as metadata only, never a key, token, refresh grant, value or fingerprint', async () => {
    const f = await setup();
    f.records.set('credential_openai_key', { id: 'credential_openai_key', integrationID: 'openai', label: 'Work', value: { type: 'key', key: 'synthetic-secret-key' } });
    const response = await request(f.app).get('/api/provider/openai/accounts');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ providerID: 'openai', accounts: [
      { id: 'credential_openai', label: 'Account', method: 'oauth', active: true },
      { id: 'credential_openai_key', label: 'Work', method: 'key', active: true },
    ] });
    expectNoSecretFields(response.body);
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-|chatgpt-token-sharing/);
    expect((await request(f.app).get('/api/provider/anthropic/accounts')).status).toBe(501);
    expect(f.nativeCalls.some(call => call.path.startsWith('/api/credential'))).toBe(false);
  });
  it('projects account rows through an allowlist that drops every secret-bearing field', () => {
    const hostile = { id: 'cred_a', integrationID: 'xai', label: 'Personal', valueType: 'oauth', active: true, methodID: 'device',
      access: 'secret-access', refresh: 'secret-refresh', key: 'secret-key', token: 'secret-token', apiKey: 'secret-api-key',
      value: { type: 'oauth', access: 'secret-access' }, expectedFingerprint: 'a'.repeat(64), metadata: { secret: 'secret-meta' } };
    const list = toProviderAccountList('xai', [
      hostile,
      { id: 'cred_b', integrationID: 'xai', label: 42, valueType: 'key', active: 'yes' },
      { id: 'cred_other', integrationID: 'openai', label: 'Elsewhere', valueType: 'key', active: true },
      { id: 'bad id!', integrationID: 'xai', label: 'Bad', valueType: 'key', active: true },
      { id: 'cred_weird', integrationID: 'xai', label: 'Weird', valueType: 'password', active: true },
      null,
    ], [{ type: 'credential', id: 'cred_a', label: 'Personal', method: 'oauth', status: { status: 'needs_auth', message: 'Sign in again', url: 'https://x.test' } }]);
    expect(list).toEqual({ providerID: 'xai', accounts: [
      { id: 'cred_a', label: 'Personal', method: 'oauth', active: true, needsAuth: true },
      { id: 'cred_b', label: '', method: 'key', active: false },
    ] });
    expectNoSecretFields(list);
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(toProviderAccountList('xai', 'not rows', null)).toEqual({ providerID: 'xai', accounts: [] });
  });
  it('binds Integration list and OAuth HTTP calls to each actual reviewed location', async () => {
    const f = await setup(); f.allowForeign();
    expect((await request(f.app).get('/api/provider/auth?directory=/foreign')).status).toBe(200);
    expect((await request(f.app).post('/api/provider/xai/oauth/authorize?directory=/foreign').send({ method: 0 })).status).toBe(200);
    expect((await request(f.app).post('/api/provider/xai/oauth/callback?directory=/foreign').send({ method: 0, code: 'owned-code' })).status).toBe(200);
    expect(f.nativeLocations).toEqual([
      { path: '/api/integration', directory: '/foreign' },
      { path: '/api/websearch/provider', directory: '/foreign' },
      // Starting OAuth first confirms xai is a model provider, not a web-search tool.
      { path: '/api/websearch/provider', directory: '/foreign' },
      { path: '/api/integration/xai', directory: '/foreign' },
      { path: '/api/integration/xai/connect/oauth', directory: '/foreign' },
      // The callback rereads the provider's methods to check the OAuth index before completing.
      { path: '/api/integration/xai', directory: '/foreign' },
      { path: '/api/integration/xai/connect/oauth/attempt_1/complete', directory: '/foreign' },
    ]);
    expect((await request(f.app).get('/api/provider/auth')).status).toBe(200);
    expect(f.nativeLocations.slice(-2)).toEqual(['/api/integration','/api/websearch/provider'].map(path=>({path,directory:'/owned'})));
  });
  it('uses current credential fingerprints for account actions and exact MCP removal', async () => {
    const f = await setup();
    expect((await request(f.app).patch('/api/credential/credential_openai').send({ label: 'Renamed' })).status).toBe(200);
    expect((await request(f.app).post('/api/credential/credential_openai/activate').send({})).status).toBe(200);
    expect((await request(f.app).delete('/api/mcp/remote/auth')).status).toBe(200);
    expect(f.records.has('credential_mcp')).toBe(false); expect(f.mutations).toEqual(['update', 'activate', 'remove']);
    expect((await request(f.app).patch('/api/credential/credential_openai').send({ value: { type: 'key', key: 'injected' } })).status).toBe(400);
    expect(f.mutations).toHaveLength(3);
  });
  it('reserves concurrent OAuth starts before native creation and cancels the exact pending attempt', async () => {
    const f = await setup(), pause = f.pauseStart();
    const first = request(f.app).post('/api/mcp/remote/auth').send({}).then(response => response);
    await pause.entered;
    const second = await request(f.app).post('/api/mcp/remote/auth').send({});
    expect(second.status).toBe(409); expect(second.body.code).toBe('native_integration_attempt_pending');
    pause.release(); expect((await first).status).toBe(200); expect(f.starts()).toBe(1);
    expect((await request(f.app).delete('/api/mcp/remote/auth')).status).toBe(200);
    expect(f.nativeCalls).toContainEqual({ method: 'DELETE', path: '/api/integration/mcp_remote/connect/oauth/attempt_1' });
    expect((await request(f.app).post('/api/mcp/remote/auth').send({})).status).toBe(200);
    expect(f.starts()).toBe(2);
  });
  it('releases a start reservation when original authorization refuses before native dispatch', async () => {
    const f = await setup(); f.allowStart(false);
    expect((await request(f.app).post('/api/mcp/remote/auth').send({})).status).toBe(403);
    expect(f.starts()).toBe(0);
    f.allowStart(true);
    expect((await request(f.app).post('/api/mcp/remote/auth').send({})).status).toBe(200);
    expect(f.starts()).toBe(1);
  });
  it('uses native Cursor key grants for create, label, selection and disconnect', async () => {
    const f = await setup(); f.enableCursor();
    expect((await request(f.app).get('/api/provider/auth')).body['cursor-acp']).toEqual([{ type: 'api', label: 'API key', providerName: 'Cursor' }]);
    expect((await request(f.app).put('/api/auth/cursor-acp').send({ type: 'api', key: 'synthetic-cursor' })).status).toBe(200);
    expect(f.records.get('created_key').integrationID).toBe('cursor-acp');
    expect((await request(f.app).patch('/api/credential/created_key').send({ label: 'Cursor account' })).status).toBe(200);
    expect((await request(f.app).post('/api/credential/created_key/activate').send({})).status).toBe(200);
    expect((await request(f.app).post('/api/provider/cursor-acp/oauth/authorize').send({ method: 0 })).status).toBe(400);
    expect((await request(f.app).put('/api/auth/cursor-acp').send({ type: 'oauth', key: 'synthetic' })).status).toBe(400);
    expect(f.mutations).toEqual(['create', 'update', 'activate']);
    const removed = await request(f.app).delete('/api/provider/cursor-acp/auth?scope=auth');
    expect(removed.status).toBe(200); expect(removed.body.removed).toBe(true);
    expect(f.records.has('created_key')).toBe(false); expect(f.records.has('credential_openai')).toBe(true);
    expect(f.mutations).toEqual(['create', 'update', 'activate', 'remove']);
  });
  it('retains an uncertain native OAuth start instead of issuing a replacement attempt', async () => {
    const f = await setup(); f.loseStartAck();
    expect((await request(f.app).post('/api/mcp/remote/auth').send({})).status).toBe(503);
    expect(f.starts()).toBe(1);
    const again = await request(f.app).post('/api/mcp/remote/auth').send({});
    expect(again.status).toBe(409); expect(again.body.code).toBe('native_integration_attempt_pending');
    expect(f.starts()).toBe(1);
  });
  it('normal Disconnect removes native OAuth credentials', async () => {
    const f = await setup();
    const removed = await request(f.app).delete('/api/provider/openai/auth?scope=auth');
    expect(removed.status).toBe(200); expect(f.records.has('credential_openai')).toBe(false); expect(f.mutations).toEqual(['remove']);
  });
  it('refuses config-wide disconnect before any credential effect when prepared config would remain', async () => {
    const f = await setup(); f.configureProvider();
    const response = await request(f.app).delete('/api/provider/openai/auth?scope=all');
    expect(response.status).toBe(501); expect(response.body.capability).toBe('providerConfigurationRemoval');
    expect(f.mutations).toEqual([]); expect(f.nativeCalls).toEqual([]);
    expect(f.records.has('credential_openai')).toBe(true);
  });
  it('retains the original OAuth caller after the starting HTTP scope ends', async () => {
    const f = await setup();
    expect((await request(f.app).post('/api/mcp/remote/auth').send({})).status).toBe(200);
    f.original.active = false;
    const completed = await request(f.app).post('/api/mcp/remote/auth/callback').set('x-fixture-other', 'true').send({ code: 'owned-code' });
    expect(completed.status).toBe(403); expect(completed.body.error).toContain('original_caller_revoked');
    expect(f.mutations).toEqual([]);
  });
  it('refuses revocation before concrete commit and copied attempts after runtime replacement', async () => {
    const f = await setup(); f.records.get('credential_openai').value = { type: 'key', key: 'fixture-key' }; f.revokeAtCommit();
    expect((await request(f.app).delete('/api/credential/credential_openai')).status).toBe(403);
    expect(f.records.has('credential_openai')).toBe(true); expect(f.mutations).toEqual([]);
    f.original.active = true;
    expect((await request(f.app).post('/api/provider/xai/oauth/authorize').send({ method: 0 })).status).toBe(200);
    f.bumpEpoch();
    const completed = await request(f.app).post('/api/provider/xai/oauth/callback').send({ method: 0, code: 'owned-code' });
    expect(completed.status).toBe(403); expect(completed.body.code).toBe('native_integration_grant_expired');
    expect(f.mutations).toEqual([]);
    expect((await request(f.app).post('/api/provider/xai/oauth/authorize').send({ method: 0 })).status).toBe(200);
    expect(f.starts()).toBe(2);
  });
});
