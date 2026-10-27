import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { toV1ToolName } from '../../packages/web/server/lib/opencode/v2/projection/tools.js';
const effectiveVariant = value => value === undefined || value === null || value === '' ? 'default' : value;

/** Fence the fixture host too: compatibility discovery owns a fixed remote URL. */
export function builtinCatalogPreflightFetch(endpoint, nativeFetch = globalThis.fetch) {
  const loopback = new URL(endpoint);
  assert.equal(loopback.protocol, 'http:'); assert.equal(loopback.hostname, '127.0.0.1');
  assert.ok(loopback.port); assert.equal(loopback.pathname, '/');
  assert.equal(loopback.username + loopback.password + loopback.search + loopback.hash, '');
  return (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === 'https://api.githubcopilot.com/models') {
      const redirected = input instanceof Request ? new Request(new URL('/models', loopback), input) : new URL('/models', loopback);
      return nativeFetch(redirected, options);
    }
    assert.equal(url.protocol, 'http:', 'Builtin fixture refuses external networking');
    assert.equal(url.hostname, '127.0.0.1', 'Builtin fixture refuses external networking');
    return nativeFetch(input, options);
  };
}

/** Active builtin grants use a disposable discovery endpoint, never a real provider. */
export async function createBuiltinCatalogPreflight() {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/models') { response.writeHead(404).end(); return; }
    requests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'devryan-startup-copilot', name: 'Synthetic startup Copilot',
      version: '2026-10-09', model_picker_enabled: true, supported_endpoints: ['/chat/completions'],
      capabilities: { family: 'gpt-5', limits: { max_context_window_tokens: 32768, max_prompt_tokens: 16384,
        max_output_tokens: 4096 }, supports: { tool_calls: true, vision: false } } }] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const model = name => ({ name, capabilities: { tools: true, input: ['text'], output: ['text'] },
    limit: { context: 32768, input: 16384, output: 4096 } });
  return { endpoint, providers: {
    openai: { models: { 'gpt-5.6-sol': model('Synthetic startup OpenAI') } },
    'cursor-acp': { package: 'aisdk:@ai-sdk/openai-compatible', env: [], settings: { baseURL: endpoint },
      models: { 'devryan-startup-cursor': model('Synthetic startup Cursor') } },
  }, expected: [{ providerID: 'openai', id: 'gpt-5.6-sol' },
    { providerID: 'cursor-acp', id: 'devryan-startup-cursor' }, { providerID: 'github-copilot', id: 'devryan-startup-copilot' }],
  evidence: () => ({ discoveryRequests: requests }),
  close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

export async function assertBuiltinCatalogPreflight({ client, directories, expected }) {
  const locations = [];
  for (const directory of directories) {
    const deadline = Date.now() + 10000;
    let providers;
    do {
      providers = await client.catalog.providerList({ directory });
      if (expected.every(model => providers.connected?.includes(model.providerID)
        && providers.all.find(row => row.id === model.providerID)?.models?.[model.id])) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    for (const model of expected) {
      assert.ok(providers.connected?.includes(model.providerID), `Synthetic builtin is not active: ${model.providerID}`);
      assert.ok(providers.all.find(row => row.id === model.providerID)?.models?.[model.id],
        `Missing active builtin catalog model: ${model.providerID}/${model.id}`);
    }
    locations.push({ directory, models: expected });
  }
  return { id: 'compiled-active-builtin-startup-catalog', status: 'passed', locations, synthetic: true };
}

export function assertPackagePreflightOptions({ preflight, reviewedSetup, onParentDeathReady }) {
  if (!preflight) return;
  assert.equal(reviewedSetup, true, 'Composition preflight requires --reviewed-setup');
  assert.equal(onParentDeathReady, undefined, 'Composition preflight cannot run the parent-death lane');
}

/** Read the same compiled location graphs and frozen expected selections.
 * Presence is a composition check; tool/control behavior remains separately tested. */
export async function assertCompiledCompositionCatalogs({ runtimeOwner, client, readNativePlugins }) {
  const snapshot = runtimeOwner.getConfigurationSnapshot();
  assert.equal(snapshot.locations.length, 2, 'Package preflight requires both relocated locations');
  const locations = [];
  for (const location of snapshot.locations) {
    const query = { directory: location.directory };
    const agents = await client.catalog.agents(query);
    const providers = await client.catalog.providerList(query);
    const tools = await client.catalog.tools(query);
    const commands = await client.catalog.commands(query);
    const skills = await client.catalog.skills(query);
    const mcp = await client.catalog.mcp(query);
    const plugins = await readNativePlugins(location.directory);
    assert.equal(plugins.location.directory, location.directory, 'Plugin catalog crossed locations');
    const required = location.requiredCatalogs;
    for (const id of new Set([...location.activeRegistrationIDs, ...required.plugins])) {
      assert.ok(plugins.data.some(row => row.id === id && row.state.status === 'active'), `Inactive compiled plugin: ${id}`);
    }
    for (const id of required.agents) assert.ok(agents.some(row => row.name === id), `Missing compiled agent: ${id}`);
    for (const id of required.tools) assert.ok(tools.ids.includes(toV1ToolName(id)), `Missing compiled tool: ${id}`);
    for (const id of required.commands) assert.ok(commands.some(row => row.name === id), `Missing compiled command: ${id}`);
    for (const id of required.skills) assert.ok(skills.some(row => row.id === id), `Missing compiled skill: ${id}`);
    for (const id of required.mcp) assert.equal(mcp[id]?.status, 'connected', `Disconnected compiled MCP: ${id}`);
    const tuples = [];
    const checkModel = (providerID, modelID, variant) => {
      const model = providers.all.find(row => row.id === providerID)?.models?.[modelID];
      assert.ok(model, `Missing compiled model: ${providerID}/${modelID}`);
      if (effectiveVariant(variant) !== 'default') {
        assert.ok(Object.hasOwn(model.variants, variant), `Missing compiled effort: ${providerID}/${modelID}/${variant}`);
      }
    };
    for (const model of required.models) checkModel(model.providerID, model.id, model.variant);
    const selectedModel = required.models[0];
    assert.ok(selectedModel, 'Compiled composition requires a declared model');
    const toolDefinitions = await client.catalog.tools({ ...query, providerID: selectedModel.providerID, modelID: selectedModel.id });
    for (const id of required.tools) {
      const definition = toolDefinitions.definitions?.find(row => row.id === toV1ToolName(id));
      assert.ok(definition?.parameters && typeof definition.parameters === 'object', `Missing compiled tool schema: ${id}`);
    }
    for (const [name, definition] of Object.entries(location.configuration.agents ?? {})) {
      if (definition.disabled || !definition.model) continue;
      const { providerID, model: modelID, variant } = definition.model;
      assert.equal(typeof providerID, 'string'); assert.equal(typeof modelID, 'string');
      const actual = agents.find(row => row.name === name);
      assert.deepEqual(actual?.model, { providerID, modelID }, `Compiled agent selection changed: ${name}`);
      assert.equal(effectiveVariant(actual.variant), effectiveVariant(variant), `Compiled agent effort changed: ${name}`);
      checkModel(providerID, modelID, variant);
      tuples.push({ agent: name, providerID, modelID, variant: effectiveVariant(variant) });
    }
    locations.push({ directory: location.directory, tuples, plugins: plugins.data.length, tools: tools.ids.length,
      toolDefinitions: toolDefinitions.definitions.length, commands: commands.length, skills: skills.length, requiredMcp: required.mcp });
  }
  return { id: 'compiled-composition-catalogs-two-locations', status: 'passed', locations,
    source: 'actual-compiled-location-catalogs-and-frozen-required-selections', personalProviderParity: false };
}

export function packagePreflightResult(artifact) {
  return { status: 'preflight-passed', artifact, qualification: 'composition-preflight-only',
    remainingMandatoryGates: ['full-package-qualification'] };
}
