import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { effectiveQaSelectionIsReady, initialBootstrapIsReady, initialBootstrapSnapshotExpression, reloadQaInitialBootstrap } from './initial-bootstrap.mjs';

const cell = { providerId: 'fixture', modelId: 'fixture-model', agent: 'builder' };
const ready = { origin: 'http://127.0.0.1:1234', initialized: true, providersLoadStatus: 'ready', agentsLoadStatus: 'ready',
  pinnedModelAvailable: true, nativeAgent: 'build', composer: true, newChat: true, modelControl: true, agentControl: true };
const catalog = { all: [{ id: 'fixture', models: { 'fixture-model': {} } }], connected: ['fixture'] };
const agents = [{ name: 'build' }];
const cdpFor = snapshot => ({
  calls: [],
  waitFor: async () => ({}),
  async send(method) {
    this.calls.push(method);
    if (method === 'Runtime.evaluate') return { result: { value: snapshot() } };
    return {};
  },
});
const fetchCatalog = async url => new Response(JSON.stringify(url.pathname === '/api/provider' ? catalog : agents));

test('cold initialization can exceed ordinary reload30s while requiring real ready UI and catalogs', async () => {
  let clock = 0;
  const cdp = cdpFor(() => clock < 35000 ? { ...ready, initialized: false } : ready);
  const snapshots = [];
  const result = await reloadQaInitialBootstrap({ cdp, cell, directory: '/owned/project', cellDeadline: 420000,
    now: () => clock, wait: async () => { clock += 35000; }, fetchImpl: fetchCatalog,
    record: async value => snapshots.push(structuredClone(value)) });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.elapsedMs, 35000);
  assert.equal(result.timeoutMs, 180000);
  assert.equal(result.catalog.nativeAgent, 'build');
  assert.equal(cdp.calls.filter(method => method === 'Page.reload').length, 1);
  assert.deepEqual(result.phases.map(phase => phase.name), ['reload-started', 'document-loaded', 'native-catalogs-ready', 'usable-ui-ready']);
  assert.ok(snapshots.some(value => value.lastSnapshot?.initialized === false && value.outcome === 'pending'));
});

test('every visual and catalog condition must hold instead of accepting health or a textarea alone', () => {
  assert.equal(initialBootstrapIsReady(ready), true);
  for (const [key, value] of Object.entries({ initialized: false, providersLoadStatus: 'loading', agentsLoadStatus: 'error',
    pinnedModelAvailable: false, nativeAgent: null, composer: false, newChat: false, modelControl: false, agentControl: false })) {
    assert.equal(initialBootstrapIsReady({ ...ready, [key]: value }), false, key);
  }
});

test('pre-send selection requires the exact effective model and native primary after agent changes', () => {
  const selectedModel = { providerId:'fixture', modelId:'fixture-model', agent:'build', catalogAvailable:true };
  const snapshot = {...ready,selectedModel};
  assert.equal(effectiveQaSelectionIsReady(snapshot,cell,'build'),true);
  for(const patch of [{providerId:'openai'},{modelId:'gpt-5.5'},{agent:'orchestrator'},{catalogAvailable:false}]) {
    assert.equal(effectiveQaSelectionIsReady({...snapshot,selectedModel:{...selectedModel,...patch}},cell,'build'),false);
  }
  assert.equal(effectiveQaSelectionIsReady({...snapshot,selectedModel:null},cell,'build'),false);
  assert.equal(effectiveQaSelectionIsReady({...snapshot,agentsLoadStatus:'loading'},cell,'build'),false);
  assert.equal(effectiveQaSelectionIsReady({...snapshot,nativeAgent:'builder'},cell,'build'),false);
  assert.equal(effectiveQaSelectionIsReady({...snapshot,nativeAgent:'orchestrator',selectedModel:{...selectedModel,agent:'orchestrator'}},
    {...cell,agent:'orchestrator'},'orchestrator'),true);
});

test('effective selection projection reads current store IDs independently of pinned catalog availability', () => {
  const state = {isInitialized:true,providersLoadStatus:'ready',agentsLoadStatus:'ready',currentProviderId:'openai',currentModelId:'gpt-5.5',currentAgentName:'orchestrator',
    providers:[{id:'fixture',models:[{id:'fixture-model'}]},{id:'openai',models:[{id:'gpt-5.5'}]}],agents:[{name:'build'},{name:'orchestrator'}]};
  const project = new Function('window','document','location','getComputedStyle',`return ${initialBootstrapSnapshotExpression({...cell,agent:'orchestrator'})}`);
  const snapshot = project({__zustand_config_store__:{getState:()=>state}},{querySelectorAll:()=>[]},{origin:'http://127.0.0.1:1234'},()=>({}));
  assert.equal(snapshot.pinnedModelAvailable,true);
  assert.deepEqual(snapshot.selectedModel,{providerId:'openai',modelId:'gpt-5.5',agent:'orchestrator',variant:null,catalogAvailable:true});
  assert.equal(effectiveQaSelectionIsReady({...snapshot,composer:true,newChat:true,modelControl:true,agentControl:true},{...cell,agent:'orchestrator'},'orchestrator'),false);
});

test('fixture selection proves merged Low defaults and visible Low before requested effort selection', () => {
  const fixtureCell={...cell,transport:'fixture'};
  const snapshot={...ready,selectedModel:{providerId:'fixture',modelId:'fixture-model',agent:'build',variant:'low',catalogAvailable:true},
    selectedAgentDefault:{model:{providerID:'fixture',modelID:'fixture-model'},variant:'low'},thinkingLabels:['Low']};
  assert.equal(effectiveQaSelectionIsReady(snapshot,fixtureCell,'build'),true);
  for(const patch of [{selectedModel:{...snapshot.selectedModel,variant:null}},{thinkingLabels:['Default']},
    {selectedAgentDefault:{...snapshot.selectedAgentDefault,variant:null}},
    {selectedAgentDefault:{...snapshot.selectedAgentDefault,model:{providerID:'openai',modelID:'gpt-5.5'}}}]) {
    assert.equal(effectiveQaSelectionIsReady({...snapshot,...patch},fixtureCell,'build'),false);
  }
});

test('missing connected pinned model or requested primary fails without fallback selection', async () => {
  const cases = [
    { providers: { ...catalog, connected: [] }, agents, error: /pinned model access/ },
    { providers: { all: [{ id: 'fixture', models: { another: {} } }], connected: ['fixture'] }, agents, error: /pinned model access/ },
    { providers: catalog, agents: [{ name: 'orchestrator' }], error: /pinned primary agent/ },
    { providers: catalog, agents: [{ name: 'build', hidden: true }], error: /pinned primary agent/ },
  ];
  for (const value of cases) {
    const cdp = cdpFor(() => ready);
    let recorded;
    await assert.rejects(reloadQaInitialBootstrap({ cdp, cell, directory: '/owned/project', cellDeadline: Date.now() + 1000,
      fetchImpl: async url => new Response(JSON.stringify(url.pathname === '/api/provider' ? value.providers : value.agents)),
      record: async evidence => { recorded = structuredClone(evidence); } }), value.error);
    assert.equal(recorded.outcome, 'failed');
    assert.equal(recorded.lastSnapshot.composer, true);
    assert.ok(cdp.calls.every(method => !method.startsWith('Input.')));
  }
});

test('cell deadline caps the cold gate and retains its last unresolved readiness snapshot', async () => {
  let clock = 0, recorded;
  await assert.rejects(reloadQaInitialBootstrap({ cdp: cdpFor(() => ({ ...ready, agentsLoadStatus: 'loading' })),
    cell, directory: '/owned/project', cellDeadline: 50, now: () => clock, wait: async ms => { clock += ms; },
    fetchImpl: fetchCatalog, record: async evidence => { recorded = structuredClone(evidence); } }), /Timed out: initial application bootstrap/);
  assert.equal(recorded.timeoutMs, 50);
  assert.equal(recorded.elapsedMs, 50);
  assert.equal(recorded.lastSnapshot.agentsLoadStatus, 'loading');
  assert.equal(recorded.outcome, 'failed');
});

test('bounded native catalog reads retry a stalled request and503 without blocking the renderer', async () => {
  let providerCalls = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ route: url.pathname, directory: url.searchParams.get('directory'), header: req.headers['x-opencode-directory'] });
    if (url.pathname === '/api/provider') {
      providerCalls += 1;
      if (providerCalls === 1) return;
      if (providerCalls === 2) { res.writeHead(503).end(); return; }
      res.end(JSON.stringify(catalog)); return;
    }
    res.end(JSON.stringify(agents));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await reloadQaInitialBootstrap({ cdp: cdpFor(() => ({ ...ready, origin })), cell, directory: '/owned/project',
      cellDeadline: Date.now() + 3000, requestTimeoutMs: 30, intervalMs: 5 });
    assert.equal(result.outcome, 'passed');
    assert.equal(providerCalls, 3);
    assert.equal(result.catalogAttempts.length, 3);
    assert.ok(result.catalogAttempts[0].requests.find(request => request.route === '/api/provider').retry);
    assert.equal(result.catalogAttempts[1].requests.find(request => request.route === '/api/provider').status, 503);
    assert.ok(requests.every(request => request.directory === '/owned/project' && request.header === '/owned/project'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('permanent native API errors fail immediately and remain explicit in the evidence', async () => {
  let recorded;
  await assert.rejects(reloadQaInitialBootstrap({ cdp: cdpFor(() => ready), cell, directory: '/owned/project',
    cellDeadline: Date.now() + 1000, fetchImpl: async () => new Response('', { status: 401 }),
    record: async evidence => { recorded = structuredClone(evidence); } }), /HTTP 401/);
  assert.equal(recorded.outcome, 'failed');
  assert.match(recorded.error, /HTTP 401/);
});
