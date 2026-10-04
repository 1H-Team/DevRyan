import assert from 'node:assert/strict';
import { toV1ToolName } from '../../packages/web/server/lib/opencode/v2/projection/tools.js';
const effectiveVariant = value => value === undefined || value === null || value === '' ? 'default' : value;

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
