// Explicitly synthetic factory/production isolated-host startup proof only.
// No saved-user graph, paid provider, installed account, or inference claim.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createQaNativePreparationFactory } from './native-profile-factory.mjs';
import { prepareQaNativeProfile, archiveQaNativeControllerLog } from './native-profile-preparation.mjs';
import { startOwnedProcess } from './process.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { translateNativeConfiguration } from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function runQaNativeFactoryDiagnostic({ artifactRoot, bun = 'bun' }) {
  artifactRoot = await fs.realpath(artifactRoot);
  assert.ok(artifactRoot.startsWith(path.join(repository, '.cache') + path.sep));
  const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/native-factory-'));
  const sourceHome = path.join(root, 'mirror'), workspace = path.join(root, 'workspace'), runtimeRoot = path.join(root, 'runtime');
  for (const directory of [sourceHome, workspace, path.join(sourceHome, 'opencode'), path.join(sourceHome, 'web')]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const names = (await fs.readdir(path.join(repository, 'packages/web/server/default-config/agents'))).filter(file => file.endsWith('.md')).map(file => file.slice(0, -3));
  // The original OAuth catalog deliberately excludes the bare gpt-5.6 row.
  // Declare a supported synthetic tuple, never substitute a saved user's model.
  const modelID = 'gpt-5.6-sol', model = `openai/${modelID}`;
  const agents = Object.fromEntries(names.map(name => [name, { model, variant: 'high',
    ...(name === 'council' ? { councillors: [{ model, variant: 'high' }] } : {}) }]));
  agents.builder ??= { model, variant: 'high' };
  const legacy = { model, default_agent: 'builder', agent: agents, plugin: [] };
  const artifacts = JSON.parse(await fs.readFile(path.join(artifactRoot, 'native-bundle.json'), 'utf8'));
  const bytes = { 'opencode/opencode.json': JSON.stringify(legacy), 'opencode/.openchamber/config.json': JSON.stringify({ agentOverrides: agents }), 'web/settings.json': '{}',
    'reviewed-native.json': JSON.stringify({ schema: 1, configuration: translateNativeConfiguration({ legacy, agents }),
      locations: [], catalogRequirements: { agents: ['builder'], tools: ['read'], plugins: [], models: [] } }),
    'reviewed-plugins.json': JSON.stringify({ schema: 1, plugins: artifacts.inputs.reviewedPlugins }) };
  for (const [file, value] of Object.entries(bytes)) {
    await fs.mkdir(path.dirname(path.join(sourceHome, file)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(sourceHome, file), value, { mode: 0o600 });
  }
  const preparedInput = { sourceHome, artifactRoot, files: Object.entries(bytes).map(([file, value]) => ({ path: file, sha256: hash(value) })) };
  const report = { qualification: 'synthetic-factory-and-actual-isolated-host-startup-only', status: 'failed', cases: [], cleanupFailures: [] };
  let profile, host;
  const bootstrapCredentials = async ({ binding, requiredProviders }) => {
    assert.deepEqual(requiredProviders, ['openai']);
    const profileRoot = path.join(runtimeRoot, 'source-oauth');
    const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp'].map(key => [key, path.join(profileRoot, key)]));
    for (const value of Object.values(globals)) await fs.mkdir(value, { recursive: true, mode: 0o700 });
    const module = fileURLToPath(new URL('../opencode-v2-native/package-image-source-oauth.mjs', import.meta.url));
    const input = { databasePath: binding.descriptor.launch.opencodeDatabasePath, directory: workspace, profileRoot, expiresIn: { A: 3600, B: 3600 } };
    const script = path.join(root, 'source-acquisition.mjs');
    await fs.writeFile(script, `const {prepareSourceOpenAiFixture}=await import(${JSON.stringify(module)});process.stdout.write(JSON.stringify(await prepareSourceOpenAiFixture(${JSON.stringify(input)})));\n`, { mode: 0o600 });
    const { stdout, stderr } = await promisify(execFile)(bun, [script], { cwd: repository, timeout: 60000, maxBuffer: 1024 * 1024,
      env: createQaHostLaunchEnvironment({ HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data,
        XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp,
        GIT_CEILING_DIRECTORIES: repository, GIT_CONFIG_NOSYSTEM: '1' }) });
    const proof = JSON.parse(stdout);
    const creationLogs = stderr.split('\n').filter(Boolean).map(line => {
      const match = line.match(/^timestamp=[0-9TZ:.-]+ level=INFO fiber=#\d+ message="credential created" message="(.+)"$/);
      assert.ok(match, 'Unexpected source acquisition stderr');
      return JSON.parse(match[1].replace(/\\/g, ''));
    });
    assert.deepEqual(creationLogs, proof.accounts.map(account => ({ credentialID: account.credentialID, integrationID: 'openai', type: 'oauth', active: true })), 'Unexpected native credential creation log'); assert.equal(proof.compiledOAuthCreation, false); assert.equal(proof.nativeVersion, '2.0.20');
    assert.equal(proof.reopened.methodID, 'chatgpt-headless');
    report.cases.push({ id: 'synthetic-original-source-oauth', source: proof.source, methodID: proof.reopened.methodID,
      settledMutations: proof.settledMutations, knownNativeCreationLogCount: creationLogs.length, compiledOAuthCreation: false });
    return { status: 'ready', credentials: { openai: { kind: 'native-credential', providerId: 'openai',
      bundleID: binding.descriptor.bundleID, controlRoot: binding.controlRoot, credentialID: proof.reopened.credentialID,
      expectedFingerprint: proof.reopened.expectedFingerprint, valueType: 'oauth', expires: proof.reopened.expires,
      checkedAt: Date.now(), expiryCheck: 'passed' } } };
  };
  try {
    const gitConfig = path.join(root, 'gitconfig'), gitTemplate = path.join(root, 'git-template');
    await fs.writeFile(gitConfig, '', { mode: 0o600 }); await fs.mkdir(gitTemplate, { mode: 0o700 });
    await promisify(execFile)('git', ['init', '--quiet', `--template=${gitTemplate}`, workspace], { cwd: root, timeout: 15000,
      env: createQaHostLaunchEnvironment({ HOME: sourceHome, GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root, GIT_TERMINAL_PROMPT: '0' }) });
    const nativePreparation = await createQaNativePreparationFactory({ preparedInput, mirror: { reviewedNativeFile: 'reviewed-native.json',
      reviewedPluginFile: 'reviewed-plugins.json', opencodeConfigDirectory: 'opencode', webConfigDirectory: 'web' }, bootstrapCredentials });
    profile = await prepareQaNativeProfile({ runtimeRoot, workspace, cell: { agent: 'builder', providerId: 'openai', modelId: modelID, variant: 'high', timeoutMs: 120000 }, nativePreparation });
    assert.equal(profile.evidence.generation, 2); assert.equal(profile.evidence.agentSelections.builder.variant, 'high');
    report.cases.push({ id: 'real-bundle-migration-saved-synthetic-graph', snapshotDigest: profile.evidence.snapshotDigest,
      inputDigest: profile.evidence.inputDigest, nativeBundle: profile.evidence.nativeBundle, agentCount: Object.keys(profile.evidence.agentSelections).length });
    host = startOwnedProcess(process.execPath, [profile.bootstrapPath], { cwd: repository,
      env: { ...profile.env, DEVRYAN_QA_RUNTIME: 'web', OPENCHAMBER_PORT: '0', GIT_CEILING_DIRECTORIES: repository, GIT_CONFIG_NOSYSTEM: '1' } });
    let ready;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      host.check();
      try { ready = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'ready.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Actual isolated host did not publish its listening address');
    const url = new URL(ready.origin); assert.equal(url.hostname, '127.0.0.1');
    let health;
    while (Date.now() < deadline) {
      host.check();
      const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(10000) });
      assert.equal(response.ok, true, 'Actual web host health failed');
      health = await response.json();
      report.lastNativeHealth = { generation: health.openCodeGeneration, ready: health.isOpenCodeReady, port: health.openCodePort,
        errorCodes: String(health.lastOpenCodeError ?? '').match(/(?:native|context|execution|mutation|opencode)_[a-z_]+/g) ?? [],
        errorType: typeof health.lastOpenCodeError, executionState: health.executionRuntime?.state ?? null, executionCode: health.executionRuntime?.code ?? null };
      if (health.isOpenCodeReady && health.openCodeGeneration === 2 && Number.isInteger(health.openCodePort) && health.openCodePort > 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(health?.isOpenCodeReady, true, 'Actual native controller failed readiness');
    assert.equal(health.openCodeGeneration, 2); assert.ok(Number.isInteger(health.openCodePort) && health.openCodePort > 0);
    const query = '?directory=' + encodeURIComponent(workspace);
    const agentResponse = await fetch(new URL('/api/agent' + query, url), { signal: AbortSignal.timeout(10000) });
    assert.equal(agentResponse.ok, true, 'Actual agent catalog failed');
    const agentCatalog = await agentResponse.json(); assert.ok(Array.isArray(agentCatalog));
    const builder = agentCatalog.find(row => row.name === 'builder');
    assert.ok(builder, 'Actual catalog lacks the supplied builder');
    assert.deepEqual(builder.model, { providerID: 'openai', modelID }); assert.equal(builder.variant, 'high');
    const providerResponse = await fetch(new URL('/api/provider' + query, url), { signal: AbortSignal.timeout(10000) });
    assert.equal(providerResponse.ok, true, 'Actual provider/model catalog failed');
    const providers = await providerResponse.json();
    const openai = providers.all.find(row => row.id === 'openai');
    const familyIDs = Object.keys(openai?.models ?? {}).filter(id => id === 'gpt-5.6' || id.startsWith('gpt-5.6-'));
    report.actualCatalog = { providerID: 'openai', providerPresent: Boolean(openai), expectedModelID: modelID,
      expectedModelPresent: Boolean(openai?.models?.[modelID]), familyIDs: familyIDs.slice(0, 32), familyTruncated: familyIDs.length > 32 };
    assert.ok(openai?.models?.[modelID], 'Actual catalog lacks the supplied model');
    report.cases.push({ id: 'actual-production-isolated-web-and-native-controller', hostPID: host.child.pid, nativePort: health.openCodePort,
      effectiveSelection: { agent: builder.name, model: builder.model, variant: builder.variant }, actualModel: openai.models[modelID].id });
    report.status = 'passed';
  } catch (error) {
    report.failure = { name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 512) };
  } finally {
    if (host) report.startupCodes = [...new Set(host.getLog().match(/(?:native|context|execution|mutation|opencode)_[a-z_]+/g) ?? [])];
    if (host) try { report.cleanup = await host.stop(); } catch (error) { report.cleanupFailures.push({ name: error.name, code: error.code ?? null }); }
    if (profile) {
      try { await profile.verifyInputs(); } catch (error) { report.cleanupFailures.push({ code: error.code ?? 'input_verification_failed' }); }
      try { report.nativeLog = await archiveQaNativeControllerLog(profile, root, createDiagnosticSanitizer({ homeDir: profile.env.HOME,
        pathMappings: [{ path: root, placeholder: '<QA_RUN>' }, { path: repository, placeholder: '<REPOSITORY>' }] })); }
      catch (error) { report.cleanupFailures.push({ code: error.code ?? 'native_log_archive_failed' }); }
    }
    if (report.cleanupFailures.length) report.status = 'failed';
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return { root, report };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--artifact-root' || !args[1]) throw Error('Only explicit --artifact-root <repo-artifact-root> is accepted');
  const result = await runQaNativeFactoryDiagnostic({ artifactRoot: args[1] });
  process.stdout.write(JSON.stringify({ root: result.root, status: result.report.status, failure: result.report.failure ?? null }) + '\n');
  process.exitCode = result.report.status === 'passed' ? 0 : 1;
}
