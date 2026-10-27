import { createRunRoot } from './run-root.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createQaNativePreparationFactory } from './native-profile-factory.mjs';
import { prepareQaNativeBundle, readQaNativeSelectionView, createQaNativeLaunchEnvironment, qaNativeRequiredProviders, verifyQaNativeInput } from './native-profile-preparation.mjs';
import { runtimeUiAgentOverrides } from './native-backend-ui-diagnostic.mjs';
import { translateNativeConfiguration } from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import { defaultNativeRegistrations } from '../../packages/web/server/lib/opencode/runtime-host/native-default-bundle.js';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { assertQaPrivateDirectory, readQaPinnedFile, qaHash, parseQaSavedGraph } from './live-setup-mirror.mjs';
import { validateQaMatrixConfig } from './matrix-config.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** Credential-free setup: all packaged role routes use one frozen catalog tuple.
 * Resolve the saved graph through the real compiled configuration owner. */
export async function prepareFocusedProviderInputs({ artifactRoot, outputRoot, providerId, modelId, variant }) {
  if (!['anthropic', 'cursor-acp'].includes(providerId) || typeof modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(modelId)
    || variant !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(variant ?? '')) throw fail('qa_focused_selection_invalid');
  await assertQaPrivateDirectory(artifactRoot); await assertQaPrivateDirectory(path.dirname(outputRoot));
  await fs.mkdir(outputRoot, { mode: 0o700 });
  const run = createRunRoot({ dir: outputRoot, owner: 'scripts/qa/focused-provider-inputs.mjs', keepOnPass: true, keepArtifacts: false, argv: [], env: {}, signals: 'exit' });
  let interrupted = false, passed = false;
  const interrupt = () => { interrupted = true; };
  const check = () => { if (interrupted) throw fail('qa_focused_inputs_interrupted'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    await assertQaPrivateDirectory(outputRoot);
    const sourceHome = path.join(outputRoot, 'mirror'), probe = path.join(outputRoot, 'graph-probe');
    const runtimeRoot = path.join(probe, 'runtime'), workspace = path.join(probe, 'workspace');
    for (const directory of [sourceHome, probe, runtimeRoot, workspace, path.join(sourceHome, 'opencode'), path.join(sourceHome, 'web')]) await fs.mkdir(directory, { mode: 0o700 });
    const manifestPath = path.join(artifactRoot, 'native-bundle.json'), manifestSha256 = qaHash(await readQaPinnedFile(manifestPath, undefined, 4 * 1024 * 1024));
    check();
    const artifacts = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256, launcher: path.join(artifactRoot, `DevRyan-execution-${process.platform}-${process.arch}`) });
    check();
    const model = `${providerId}/${modelId}`;
    const agents = Object.fromEntries(Object.entries(runtimeUiAgentOverrides()).map(([name, row]) => [name, { model, variant,
      ...(row.councillors ? { councillors: row.councillors.map(() => ({ model, variant })) } : {}) }]));
    const legacy = { model, default_agent: 'builder', agent: agents, plugin: [], mcp: {} };
    const settings = { defaultModel: model, defaultAgent: 'builder', agentModelSelections: Object.fromEntries(['builder', 'orchestrator'].map(name => [name, { providerId, modelId, variant }])), helperModelSelection: { providerID: providerId, modelID: modelId }, desktopLanAccessEnabled: false };
    const pinnedAgents = Object.fromEntries(Object.keys(agents).map(name => [name, { model, variant }]));
    const values = { 'opencode/opencode.json': legacy,
      'opencode/devryan-agents.json': { preset: 'qa', presets: { qa: pinnedAgents }, agents: pinnedAgents },
      'opencode/.devryan/config.json': { agentOverrides: agents }, 'web/settings.json': settings,
      'reviewed-native.json': { schema: 1, configuration: translateNativeConfiguration({ legacy, agents }), locations: [], catalogRequirements: { agents: ['builder'], tools: ['read'], models: [], plugins: [] } },
      'reviewed-plugins.json': { schema: 1, plugins: defaultNativeRegistrations(artifacts.manifest.inputs.reviewedPlugins) } };
    const files = [];
    for (const [relative, value] of Object.entries(values)) {
      check();
      const file = path.join(sourceHome, relative), bytes = JSON.stringify(value) + '\n';
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
      files.push({ path: relative, sha256: qaHash(bytes) });
    }
    const preparedInput = { sourceHome, artifactRoot, files }, mirror = { reviewedNativeFile: 'reviewed-native.json', reviewedPluginFile: 'reviewed-plugins.json', opencodeConfigDirectory: 'opencode', webConfigDirectory: 'web' };
    try {
      const factory = await createQaNativePreparationFactory({ preparedInput, mirror, bootstrapCredentials: async () => { throw fail('qa_focused_no_credentials'); } });
      const source = await factory.prepareSource({ runtimeRoot, workspace, sourceHome, artifactRoot });
      check();
      const { binding } = await prepareQaNativeBundle({ runtimeRoot, source });
      check();
      await fs.writeFile(path.join(binding.descriptor.launch.global.home, '.devryan-qa-home'), 'DevRyan focused graph probe\n', { flag: 'wx', mode: 0o600 });
      const view = await readQaNativeSelectionView(binding, createQaNativeLaunchEnvironment({ binding, runtimeRoot }), workspace);
      check();
      if (qaNativeRequiredProviders(view).some(id => id !== providerId)) throw fail('qa_focused_foreign_provider_route');
      const savedGraph = parseQaSavedGraph(Object.fromEntries(['agentSelections', 'nativeBackupSelections', 'nativeCompactionSettings', 'councilMembers'].map(key => [key, view[key]])));
      const preparation = { schema: 1, status: 'prepared-no-credentials-no-runtime', preparedInput, inputDigest: await verifyQaNativeInput(preparedInput), mirror, savedGraph,
        artifact: { manifestSha256, buildID: artifacts.manifest.buildId }, qualification: 'credential-free-focused-provider-inputs' };
      const preparationFile = path.join(outputRoot, 'preparation.json');
      await fs.writeFile(preparationFile, JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
      const matrix = { schemaVersion: 1, evidenceRoot: path.join(outputRoot, 'evidence'), cells: ['web', 'electron'].map(runtime => ({ id: `${providerId}-${runtime}`, runtime,
        transport: 'live', providerId, modelId, variant, agent: 'builder', planMode: false, scenarioIds: ['focused-provider'], repetitions: 1, timeoutMs: 300000, preserveOrchestration: true })) };
      validateQaMatrixConfig(matrix);
      const matrixFile = path.join(outputRoot, 'matrix.json'); await fs.writeFile(matrixFile, JSON.stringify(matrix, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
      const result = { preparationFile, mirrorSha256: qaHash(await readQaPinnedFile(preparationFile)), matrixFile, matrixSha256: qaHash(await readQaPinnedFile(matrixFile)), evidenceRoot: matrix.evidenceRoot, inference: 'not-run' };
      check(); passed = true; return result;
    } finally { try { await fs.rm(probe, { recursive: true, force: true }); } catch (error) { passed = false; throw error; } }
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    run.finish(interrupted ? 'interrupted' : passed ? 'passed' : 'failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [artifactRoot, outputRoot, providerId, modelId, effort] = process.argv.slice(2);
  if (process.argv.length !== 7) throw fail('qa_focused_flags_invalid');
  process.stdout.write(JSON.stringify(await prepareFocusedProviderInputs({ artifactRoot: path.resolve(artifactRoot), outputRoot: path.resolve(outputRoot), providerId, modelId, variant: effort === 'default' ? null : effort })) + '\n');
}
