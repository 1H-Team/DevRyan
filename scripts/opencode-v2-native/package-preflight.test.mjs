import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPackagePreflightOptions, assertCompiledCompositionCatalogs, packagePreflightResult,
  createBuiltinCatalogPreflight, assertBuiltinCatalogPreflight, builtinCatalogPreflightFetch } from './package-preflight.mjs';

test('builtin fixture routes fixed compatibility discovery to loopback and refuses every other external URL', async () => {
  const calls = [];
  const fetch = builtinCatalogPreflightFetch('http://127.0.0.1:43210', async (input, options) => {
    calls.push({ url: String(input), options }); return new Response('{}');
  });
  await fetch('https://api.githubcopilot.com/models', { headers: { authorization: 'synthetic' } });
  await fetch('http://127.0.0.1:43211/health');
  assert.equal(calls[0].url, 'http://127.0.0.1:43210/models');
  assert.equal(calls[0].options.headers.authorization, 'synthetic');
  for (const url of ['https://api.githubcopilot.com/inference', 'https://api.openai.com/models', 'http://fixture.invalid/models']) {
    assert.throws(() => fetch(url), /refuses external/);
  }
  assert.equal(calls.length, 2);
});

test('builtin catalog preflight discovers only synthetic loopback models and asserts both location catalogs', async () => {
  const lane = await createBuiltinCatalogPreflight();
  try {
    const endpoint = new URL(lane.endpoint);
    assert.equal(endpoint.hostname, '127.0.0.1'); assert.equal(endpoint.protocol, 'http:');
    const response = await fetch(new URL('/models', endpoint));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].id, 'devryan-startup-copilot');
    assert.equal(lane.evidence().discoveryRequests, 1);
    assert.equal((await fetch(new URL('/inference', endpoint))).status, 404);
    const calls = [];
    const client = { catalog: { providerList: async ({ directory }) => {
      calls.push(directory);
      return { connected: lane.expected.map(row => row.providerID),
        all: lane.expected.map(row => ({ id: row.providerID, models: { [row.id]: {} } })) };
    } } };
    const proof = await assertBuiltinCatalogPreflight({ client, directories: ['/owned/one', '/owned/two'], expected: lane.expected });
    assert.deepEqual(calls, ['/owned/one', '/owned/two']);
    assert.equal(proof.locations.length, 2); assert.equal(proof.synthetic, true);
  } finally { await lane.close(); }
});

const fixture = () => {
  const locations = ['/owned/one', '/owned/two'].map(directory => ({ directory, activeRegistrationIDs: ['reviewed'],
    configuration: { agents: { builder: { model: { providerID: 'owned', model: 'm1', variant: 'high' } } } },
    requiredCatalogs: { agents: ['builder'], tools: ['read', 'shell', 'patch'], plugins: ['reviewed'], models: [{ providerID: 'owned', id: 'm1' }],
      commands: ['original'], skills: ['skill-original'], mcp: ['remote'] } }));
  const calls = [], rows = new Map(locations.map(location => [location.directory, {
    agents: [{ name: 'builder', model: { providerID: 'owned', modelID: 'm1' }, variant: 'high' }],
    providerList: { all: [{ id: 'owned', models: { m1: { variants: { high: {} } } } }] },
    tools: { ids: ['read', 'bash', 'apply_patch'], definitions: ['read', 'bash', 'apply_patch'].map(id => ({ id, parameters: { type: 'object' } })) },
    commands: [{ name: 'original' }], skills: [{ id: 'skill-original' }],
    mcp: { remote: { status: 'connected' } },
    plugins: { location: { directory: location.directory }, data: [{ id: 'reviewed', state: { status: 'active' } }] },
  }]));
  const client = { catalog: Object.fromEntries(['agents', 'providerList', 'tools', 'commands', 'skills', 'mcp'].map(name =>
    [name, async ({ directory }) => { calls.push({ name, directory }); return rows.get(directory)[name]; }])) };
  return { locations, rows, calls, options: { runtimeOwner: { getConfigurationSnapshot: () => ({ locations }) }, client,
    readNativePlugins: async directory => rows.get(directory).plugins } };
};

test('focused mode requires active reviewed composition and cannot claim full qualification', () => {
  assert.throws(() => assertPackagePreflightOptions({ preflight: true, reviewedSetup: false }), /requires --reviewed-setup/);
  assert.throws(() => assertPackagePreflightOptions({ preflight: true, reviewedSetup: true, onParentDeathReady: () => {} }), /parent-death lane/);
  assertPackagePreflightOptions({ preflight: false, reviewedSetup: false });
  const result = packagePreflightResult({ buildId: 'owned' });
  assert.equal(result.status, 'preflight-passed'); assert.notEqual(result.status, 'passed');
  assert.equal(result.qualification, 'composition-preflight-only');
  assert.deepEqual(result.remainingMandatoryGates, ['full-package-qualification']);
});

test('composition oracle reads both exact location catalogs and preserves declared model effort', async () => {
  const input = fixture(), result = await assertCompiledCompositionCatalogs(input.options);
  assert.deepEqual(result.locations.map(row => row.directory), input.locations.map(row => row.directory));
  for (const location of input.locations) assert.deepEqual(input.calls.filter(row => row.directory === location.directory).map(row => row.name),
    ['agents', 'providerList', 'tools', 'commands', 'skills', 'mcp', 'tools']);
  assert.deepEqual(result.locations[0].tuples, [{ agent: 'builder', providerID: 'owned', modelID: 'm1', variant: 'high' }]);
  assert.equal(result.personalProviderParity, false);
});

test('a second-location missing registration, effort, command, skill or MCP refuses the preflight', async () => {
  for (const [change, expected] of [
    [row => { row.plugins.location.directory = '/foreign'; }, /crossed locations/],
    [row => { row.plugins.data[0].state.status = 'failed'; }, /Inactive compiled plugin/],
    [row => { row.agents[0].variant = 'low'; }, /agent effort changed/],
    [row => { row.tools.ids = ['read', 'apply_patch']; }, /Missing compiled tool: shell/],
    [row => { row.tools.definitions = []; }, /Missing compiled tool schema/],
    [row => { delete row.providerList.all[0].models.m1.variants.high; }, /Missing compiled effort/],
    [row => { row.commands = []; }, /Missing compiled command/],
    [row => { row.skills = []; }, /Missing compiled skill/],
    [row => { row.mcp.remote.status = 'failed'; }, /Disconnected compiled MCP/],
  ]) {
    const input = fixture(); change(input.rows.get('/owned/two'));
    await assert.rejects(assertCompiledCompositionCatalogs(input.options), expected);
  }
});

test('required fallback model effort belongs to its own location rather than a global union', async () => {
  const input = fixture();
  input.locations[1].requiredCatalogs.models.push({ providerID: 'second-only', id: 'fallback', variant: 'max' });
  input.rows.get('/owned/two').providerList.all.push({ id: 'second-only', models: { fallback: { variants: { max: {} } } } });
  await assertCompiledCompositionCatalogs(input.options);
  delete input.rows.get('/owned/two').providerList.all[1].models.fallback.variants.max;
  await assert.rejects(assertCompiledCompositionCatalogs(input.options), /Missing compiled effort: second-only\/fallback\/max/);
});

test('explicit empty and null configured effort use the pinned resolver default without adding an effort variant', async () => {
  for (const variant of ['', null]) {
    const input = fixture();
    for (const location of input.locations) {
      location.configuration.agents.builder.model.variant = variant;
      const row = input.rows.get(location.directory);
      delete row.agents[0].variant;
      row.providerList.all[0].models.m1.variants = {};
    }
    const result = await assertCompiledCompositionCatalogs(input.options);
    assert.ok(result.locations.every(row => row.tuples[0].variant === 'default'));
  }
});
