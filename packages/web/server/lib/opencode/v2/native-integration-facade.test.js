import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import http from 'node:http';
import express from 'express';
import request from '../../../test-supertest.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeV2FacadeRouter } from './facade-routes.js';
import { createNativeIntegrationAuthorization } from '../runtime-host/native-integration-authorization.js';
import { credentialMutationFingerprint as hash } from '../runtime-host/native-credential-mutation-owner.js';
import { reviewedMcpConfiguration } from '../runtime-host/reviewed-mcp-configuration.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const denied = code => Object.assign(new Error(code), { code, statusCode: 403 });
async function setup() {
  const context = new AsyncLocalStorage();
  const original = { active: true, directories: new Set(['/owned']) }, replacement = { active: true, directories: new Set(['/owned']) };
  let epoch = 1, ready = true, revokeBeforeMutation = false, starts = 0;
  const nativeCalls = [], nativeLocations = [], mutations = [], attempts = new Map();
  let releaseStart, startEntered;
  const startBarrier = new Promise(resolve => { startEntered = resolve; });
  let startPause, loseStartAcknowledgement = false, allowStart = true;
  const snapshot = { locations: ['/owned', '/foreign'].map(directory => ({ directory, configuration: { providers: { openai: {} } },
    compatibility: { mcp: { remote: { type: 'remote', url: 'http://127.0.0.1:9/mcp', oauth: {}, enabled: true },
      disabled: { type: 'remote', url: 'http://127.0.0.1:9/disabled', enabled: false } } } })) };
  const digest = reviewedMcpConfiguration(snapshot, ['/owned']).get('/owned').get('remote').configurationDigest;
  const records = new Map([
    ['credential_openai', { id: 'credential_openai', integrationID: 'openai', label: 'Account', value: { type: 'oauth', methodID: 'chatgpt-siwc', access: 'synthetic-access', refresh: 'synthetic-refresh' } }],
    ['credential_mcp', { id: 'credential_mcp', integrationID: 'mcp_remote', label: 'Remote', value: { type: 'oauth', methodID: 'mcp_method', access: 'synthetic-mcp-access' } }],
  ]);
  const info = id => ({ id, name: id === 'openai' ? 'OpenAI' : id === 'cursor-acp' ? 'Cursor' : 'remote', metadata: id === 'mcp_remote' ? { source: 'mcp' } : {},
    methods: id === 'openai' ? [{ id: 'key', type: 'key', label: 'API key' }, { id: 'chatgpt-siwc', type: 'oauth', label: 'ChatGPT' }]
      : ['cursor-acp', 'opencode', 'opencode-go'].includes(id) ? [{ id: 'key', type: 'key', label: 'API key' }]
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
      if (req.method === 'GET' && req.path === '/api/integration') return res.json([info('openai'), info('cursor-acp'), info('xai'), info('opencode'), info('opencode-go'), info('mcp_remote')]);
      if (req.method === 'GET' && req.path.startsWith('/api/integration/')) return res.json(info(req.path.split('/')[3]));
      if (req.path.startsWith('/api/experimental/mcp/')) {
        await grants.authorizeControl({ binding: binding('mcp', 'mcp_method', directory), operation: `mcp.${req.path.split('/').at(-1)}`,
          requestAuthorization: req.headers['x-devryan-native-integration-grant'] });
        return res.json(true);
      }
      if (req.path.endsWith('/connect/oauth')) {
        const kind = req.path.includes('/openai/') ? 'openai' : req.path.includes('/xai/') ? 'provider' : 'mcp', bound = binding(kind, req.body.methodID, directory);
        const grant = await grants.capture({ binding: bound, operation: 'oauth', requestAuthorization: req.headers['x-devryan-native-integration-grant'] });
        if (startPause) { startEntered(); await startPause; }
        const attemptID = `attempt_${++starts}`; attempts.set(attemptID, { grant, bound });
        if (loseStartAcknowledgement) return res.status(503).json({ code: 'fixture_start_ack_lost', message: 'fixture_start_ack_lost' });
        return res.json({ attemptID, mode: 'code', url: 'http://127.0.0.1:9/owned-issuer', expiresAt: Date.now() + 60_000 });
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
  return { app, original, records, nativeCalls, nativeLocations, mutations, starts: () => starts,
    pauseStart: () => { startPause = new Promise(resolve => { releaseStart = resolve; }); return { entered: startBarrier, release: () => releaseStart() }; },
    allowStart: value => { allowStart = value; },
    allowForeign: () => { original.directories.add('/foreign'); },
    loseStartAck: () => { loseStartAcknowledgement = true; },
    enableCursor: () => { snapshot.locations[0].configuration.providers['cursor-acp'] = {}; },
    configureProvider: () => { snapshot.locations[0].configuration.providers.openai = { models: { fixture: {} } }; },
    bumpEpoch: () => { epoch++; }, revokeAtCommit: () => { revokeBeforeMutation = true; } };
}

describe('native integration public facade with original caller grants', () => {
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
    expect((await request(f.app).get('/api/provider/auth')).body).toEqual({ openai: [{ type: 'api', label: 'API key' }],
      xai: [{ type: 'oauth', label: 'SuperGrok Subscription' }, { type: 'api', label: 'Manually enter API Key' }],
      opencode: [{ type: 'api', label: 'API key' }], 'opencode-go': [{ type: 'api', label: 'API key' }], 'cursor-acp': [{ type: 'api', label: 'API key' }] });
    expect((await request(f.app).post('/api/provider/openai/oauth/authorize').send({ method: 1 })).status).toBe(400);
    expect((await request(f.app).post('/api/provider/openai/oauth/callback').send({ method: 1, code: 'owned-code' })).status).toBe(400);
    expect((await request(f.app).put('/api/auth/openai').send({ type: 'api', key: 'synthetic-fixture-key' })).body).toEqual({ success: true, configured: true });
    for (const providerID of ['xai','opencode','opencode-go']) expect((await request(f.app).put('/api/auth/'+providerID).send({type:'api',key:'synthetic-'+providerID})).status).toBe(200);
    expect(f.mutations).toEqual(['create','create','create','create']);
    expect((await request(f.app).get('/api/credential')).status).toBe(404);
    expect((await request(f.app).get('/api/opencode-v2/credential')).status).toBe(404);
    expect(f.nativeCalls.some(call => call.path.startsWith('/api/credential'))).toBe(false);
  });
  it('binds Integration list and OAuth HTTP calls to each actual reviewed location', async () => {
    const f = await setup(); f.allowForeign();
    expect((await request(f.app).get('/api/provider/auth?directory=/foreign')).status).toBe(200);
    expect((await request(f.app).post('/api/provider/xai/oauth/authorize?directory=/foreign').send({ method: 0 })).status).toBe(200);
    expect((await request(f.app).post('/api/provider/xai/oauth/callback?directory=/foreign').send({ method: 0, code: 'owned-code' })).status).toBe(200);
    expect(f.nativeLocations).toEqual([
      { path: '/api/integration/openai', directory: '/foreign' },
      { path: '/api/integration/cursor-acp', directory: '/foreign' },
      { path: '/api/integration/xai', directory: '/foreign' },
      { path: '/api/integration/opencode', directory: '/foreign' },
      { path: '/api/integration/opencode-go', directory: '/foreign' },
      { path: '/api/integration/xai', directory: '/foreign' },
      { path: '/api/integration/xai/connect/oauth', directory: '/foreign' },
      { path: '/api/integration/xai/connect/oauth/attempt_1/complete', directory: '/foreign' },
    ]);
    expect((await request(f.app).get('/api/provider/auth')).status).toBe(200);
    expect(f.nativeLocations.slice(-5)).toEqual(['openai','cursor-acp','xai','opencode','opencode-go'].map(id=>({path:'/api/integration/'+id,directory:'/owned'})));
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
    expect((await request(f.app).get('/api/provider/auth')).body['cursor-acp']).toEqual([{ type: 'api', label: 'API key' }]);
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
  it('refuses generic OAuth removal and preserves native saved registrations', async () => {
    const f = await setup();
    const removed = await request(f.app).delete('/api/provider/openai/auth?scope=all');
    expect(removed.status).toBe(409); expect(removed.body.code).toBe('native_chatgpt_siwc_disconnect_required');
    expect(f.records.has('credential_openai')).toBe(true); expect(f.records.has('credential_mcp')).toBe(true);
    expect(f.mutations).toEqual([]);
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
