import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncRuntimeAgentOverlays } from '../../packages/web/server/lib/opencode/runtime-agent-overlays.js';

export const compiledHelperAgentIDs = Object.freeze(['devryan-title', 'devryan-commit', 'devryan-pr']);

export function assertCompiledHelperAgents(agents) {
  assert.ok(agents && typeof agents === 'object' && !Array.isArray(agents), 'Production helper agents missing');
  assert.deepEqual(Object.keys(agents).sort(), ['title', ...compiledHelperAgentIDs].sort(), 'Production helper agent inventory changed');
  assert.deepEqual(agents.title, { disable: true });
  for (const id of compiledHelperAgentIDs) {
    const agent = agents[id];
    assert.equal(agent.mode, 'subagent');
    assert.equal(agent.hidden, true);
    assert.equal(agent.temperature, 0);
    assert.deepEqual(agent.permission, { '*': 'deny' });
    assert.ok(typeof agent.prompt === 'string' && agent.prompt.length > 0);
    assert.equal(Object.hasOwn(agent, 'model'), false, 'Production helper must retain caller model selection');
    assert.equal(Object.hasOwn(agent, 'variant'), false, 'Production helper must retain caller effort selection');
  }
}

/** Read the original overlay owner's output using only this fixture's empty support inputs. */
export async function createCompiledHelperAgentFixture({ root }) {
  assert.equal(await fs.realpath(root), root, 'Helper support root must be canonical');
  const supportRoot = path.join(root, 'helper-overlay-support');
  await fs.mkdir(supportRoot);
  const owned = Object.fromEntries(['config', 'agents', 'plugins', 'data', 'opencode-data', 'overlay']
    .map(name => [name, path.join(supportRoot, name)]));
  await Promise.all(Object.values(owned).map(directory => fs.mkdir(directory)));
  const unexpected = [];
  const refuse = kind => () => { unexpected.push(kind); throw new Error(`compiled_helper_fixture_unexpected_${kind}`); };
  const result = await syncRuntimeAgentOverlays({
    workingDirectory: null,
    overlayRoot: owned.overlay, targetConfigDirectory: owned.overlay,
    manifestPath: path.join(supportRoot, 'manifest.json'),
    packagedAgentDirectory: owned.agents, packagedPluginDirectory: owned.plugins,
    dataDirectory: owned.data, openCodeDataDirectory: owned['opencode-data'],
    slimConfigDirectory: owned.config, userConfigPath: path.join(owned.config, 'opencode.json'),
    agentOverrides: {}, agentRuntimeSettings: { lsp: true }, env: {},
    readConfig: () => ({}), readOpenCodeConfig: () => ({}), listMcpConfigs: () => [],
    readAuthFile: () => ({}), writeAuthFile: refuse('auth_write'), fetchImpl: refuse('fetch'),
  });
  assert.deepEqual(unexpected, [], 'Production helper materialization attempted an external effect');
  assert.equal(result.targetConfigDirectory, owned.overlay);
  const configurationPath = path.join(result.targetConfigDirectory, 'opencode.json');
  const bytes = await fs.readFile(configurationPath);
  const configuration = JSON.parse(bytes.toString('utf8'));
  assertCompiledHelperAgents(configuration.agent);
  return { agents: structuredClone(configuration.agent), evidence: {
    configurationPath, configurationSha256: createHash('sha256').update(bytes).digest('hex'),
    helperAgentIDs: [...compiledHelperAgentIDs], source: 'original-runtime-agent-overlay-owner-with-owned-empty-inputs',
  } };
}
