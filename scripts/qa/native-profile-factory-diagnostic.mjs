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
import { TARGET_OPENCODE_VERSION } from '../../packages/web/server/lib/opencode/version-policy.js';
import { translateNativeConfiguration } from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import { defaultNativeRegistrations } from '../../packages/web/server/lib/opencode/runtime-host/native-default-bundle.js';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { createRunRoot } from './run-root.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function archiveQaNativeHostLog(host, evidenceDirectory, sanitizer, file = 'host-startup.log') {
  assert.ok(['host-startup.log', 'preparation.stderr.log'].includes(file));
  const log = Buffer.from(sanitizer.sanitizeText(host.getLog()), 'utf8');
  const maximum = 64 * 1024;
  const output = log.subarray(Math.max(0, log.byteLength - maximum));
  await fs.writeFile(path.join(evidenceDirectory, file), output, { mode: 0o600 });
  return { file, state: 'captured', bytes: output.byteLength, sha256: hash(output), truncated: log.byteLength > maximum };
}

export async function runQaNativeFactoryDiagnostic({ artifactRoot, bun = 'bun', providers, activePluginIDs = [], additionalIntegrations = [], legacyOAuthColumns = false, legacyOpenAiBrowser = false }) {
  artifactRoot = await fs.realpath(artifactRoot);
  assert.ok(artifactRoot.startsWith(path.join(repository, '.cache') + path.sep));
  const run = createRunRoot({ parent: path.join(repository, '.cache/v2-validation'), prefix: 'native-factory-', owner: 'scripts/qa/native-profile-factory-diagnostic.mjs' });
  const root = run.dir;
  const sourceHome = path.join(root, 'mirror'), workspace = path.join(root, 'workspace'), runtimeRoot = path.join(root, 'runtime');
  for (const directory of [sourceHome, workspace, path.join(sourceHome, 'opencode'), path.join(sourceHome, 'web')]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const names = (await fs.readdir(path.join(repository, 'packages/web/server/default-config/agents'))).filter(file => file.endsWith('.md')).map(file => file.slice(0, -3));
  // Declare the synthetic model tuple explicitly; never substitute a saved user's model.
  const slim = activePluginIDs.includes('devryan.slim');
  const modelID = slim ? 'gpt-5.5' : 'gpt-5.6-sol', model = `openai/${modelID}`, variant = slim ? 'medium' : 'high';
  const agents = Object.fromEntries(names.map(name => [name, { model, variant,
    ...(name === 'council' ? { councillors: [{ model, variant }] } : {}) }]));
  agents.builder ??= { model, variant };
  const artifacts = JSON.parse(await fs.readFile(path.join(artifactRoot, 'native-bundle.json'), 'utf8'));
  const registrations = defaultNativeRegistrations(artifacts.inputs.reviewedPlugins);
  assert.ok(activePluginIDs.every(id => registrations.some(row => row.id === id && row.legacySpecs.length)));
  const plugins = [...new Set(registrations.filter(row => activePluginIDs.includes(row.id)).map(row => row.legacySpecs[0]))];
  const legacy = { model, default_agent: 'builder', agent: agents, plugin: plugins, ...(providers ? { provider: providers } : {}) };
  const bytes = { 'opencode/opencode.json': JSON.stringify(legacy), 'opencode/.openchamber/config.json': JSON.stringify({ agentOverrides: agents }), 'web/settings.json': '{}',
    'reviewed-native.json': JSON.stringify({ schema: 1, configuration: translateNativeConfiguration({ legacy, agents }),
      locations: [], catalogRequirements: { agents: ['builder'], tools: ['read'], plugins: [], models: [] } }),
    'reviewed-plugins.json': JSON.stringify({ schema: 1, plugins: registrations }) };
  for (const [file, value] of Object.entries(bytes)) {
    await fs.mkdir(path.dirname(path.join(sourceHome, file)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(sourceHome, file), value, { mode: 0o600 });
  }
  const preparedInput = { sourceHome, artifactRoot, files: Object.entries(bytes).map(([file, value]) => ({ path: file, sha256: hash(value) })) };
  const report = { qualification: 'synthetic-factory-and-actual-isolated-host-startup-only', status: 'failed', activePluginIDs, cases: [], cleanupFailures: [] };
  let profile, host;
  const bootstrapCredentials = async ({ binding, requiredProviders }) => {
    assert.deepEqual(requiredProviders, ['openai']);
    const profileRoot = path.join(runtimeRoot, 'source-oauth');
    const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp'].map(key => [key, path.join(profileRoot, key)]));
    for (const value of Object.values(globals)) await fs.mkdir(value, { recursive: true, mode: 0o700 });
    const module = fileURLToPath(new URL('../opencode-v2-native/package-image-source-oauth.mjs', import.meta.url));
    const input = { databasePath: binding.descriptor.launch.opencodeDatabasePath, directory: workspace, profileRoot, expiresIn: { A: 3600, B: 3600 }, additionalIntegrations };
    const script = path.join(root, 'source-acquisition.mjs');
    await fs.writeFile(script, `const {prepareSourceOpenAiFixture}=await import(${JSON.stringify(module)});process.stdout.write(JSON.stringify(await prepareSourceOpenAiFixture(${JSON.stringify(input)})));\n`, { mode: 0o600 });
    const { stdout, stderr } = await promisify(execFile)(bun, [script], { cwd: repository, timeout: 60000, maxBuffer: 1024 * 1024,
      env: createQaHostLaunchEnvironment({ HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data,
        XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp,
        GIT_CEILING_DIRECTORIES: repository, GIT_CONFIG_NOSYSTEM: '1' }) });
    const proof = JSON.parse(stdout);
    if (additionalIntegrations.includes('xai')) {
      const source = `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1],{readonly:true});
        try { const row=db.query("SELECT count(*) AS count FROM credential WHERE integration_id='xai' AND active=1 AND json_extract(value,'$.methodID')='device' AND json_extract(value,'$.expires') < ?").get(Date.now());
          if(row.count!==1)throw Error('Synthetic expired xAI credential missing'); } finally {db.close();}`;
      await promisify(execFile)(bun, ['--eval', source, input.databasePath], { cwd: repository, timeout: 15000, env: createQaHostLaunchEnvironment({ HOME: globals.home }) });
      report.cases.push({ id: 'synthetic-expired-xai-startup-only', methodID: 'device', expiryState: 'expired', inference: 'not-run' });
    }
    if (legacyOAuthColumns) {
      const source = `import {Database} from 'bun:sqlite'; const db=new Database(${JSON.stringify(input.databasePath)});
        try { const changed=db.query("UPDATE credential SET connector_id=NULL,method_id=NULL").run();
          if(changed.changes!==${2 + additionalIntegrations.length})throw Error('Unexpected synthetic credential count'); } finally {db.close();}`;
      await promisify(execFile)(bun, ['--eval', source], { cwd: repository, timeout: 15000, env: createQaHostLaunchEnvironment({ HOME: globals.home }) });
      report.cases.push({ id: 'synthetic-oauth-legacy-columns-null', rows: 2 + additionalIntegrations.length, connectorID: null, methodID: null, additionalIntegrations });
    }
    const creationLogs = stderr.split('\n').filter(Boolean).map(line => {
      const match = line.match(/^timestamp=[0-9TZ:.-]+ level=INFO fiber=#\d+ message="credential created" message="(.+)"$/);
      assert.ok(match, 'Unexpected source acquisition stderr');
      return JSON.parse(match[1].replace(/\\/g, ''));
    });
    assert.deepEqual(creationLogs, proof.accounts.map(account => ({ credentialID: account.credentialID, integrationID: 'openai', type: 'oauth', active: true })), 'Unexpected native credential creation log'); assert.equal(proof.compiledOAuthCreation, false); assert.equal(proof.nativeVersion, TARGET_OPENCODE_VERSION);
    assert.equal(proof.reopened.methodID, 'chatgpt-siwc');
    report.cases.push({ id: 'synthetic-siwc-source-sdk-credential-mutations', source: 'source-sdk-native-credential-create', methodID: proof.reopened.methodID,
      settledMutations: proof.settledMutations, knownNativeCreationLogCount: creationLogs.length,
      oauthEnrollment: 'not-run', deviceCodeGrant: 'not-run', compiledOAuthCreation: false });
    return { status: 'ready', credentials: { openai: { kind: 'native-credential', providerId: 'openai',
      bundleID: binding.descriptor.bundleID, controlRoot: binding.controlRoot, credentialID: proof.reopened.credentialID,
      expectedFingerprint: proof.reopened.expectedFingerprint, valueType: 'oauth', expires: proof.reopened.expires,
      checkedAt: Date.now(), expiryCheck: 'passed' } } };
  };
  try {
    report.stage = 'owned_git_workspace';
    const gitConfig = path.join(root, 'gitconfig'), gitTemplate = path.join(root, 'git-template');
    await fs.writeFile(gitConfig, '', { mode: 0o600 }); await fs.mkdir(gitTemplate, { mode: 0o700 });
    await promisify(execFile)('git', ['init', '--quiet', `--template=${gitTemplate}`, workspace], { cwd: root, timeout: 15000,
      env: createQaHostLaunchEnvironment({ HOME: sourceHome, GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root, GIT_TERMINAL_PROMPT: '0' }) });
    report.stage = 'native_preparation_factory';
    const nativePreparation = await createQaNativePreparationFactory({ preparedInput, mirror: { reviewedNativeFile: 'reviewed-native.json',
      reviewedPluginFile: 'reviewed-plugins.json', opencodeConfigDirectory: 'opencode', webConfigDirectory: 'web' }, bootstrapCredentials });
    report.stage = 'native_profile_preparation';
    profile = await prepareQaNativeProfile({ runtimeRoot, workspace, cell: { agent: 'builder', providerId: 'openai', modelId: modelID, variant, timeoutMs: 120000 }, nativePreparation });
    // Recreate a legacy imported record only after source acquisition; no inference uses this fixture.
    if (legacyOpenAiBrowser) {
      const source = `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1]);
        try { const changed=db.query("UPDATE credential SET value=json_set(value,'$.methodID','chatgpt-browser') WHERE integration_id='openai' AND active=1").run();
          if(changed.changes!==1)throw Error('Unexpected synthetic active OpenAI count'); } finally {db.close();}`;
      const binding = readRuntimeBundleBinding(profile.env);
      await promisify(execFile)(bun, ['--eval', source, binding.descriptor.launch.opencodeDatabasePath], { cwd: repository, timeout: 15000, env: profile.env });
      report.cases.push({ id: 'synthetic-legacy-openai-browser-startup-only', methodID: 'chatgpt-browser', inference: 'not-run' });
    }
    assert.equal(profile.evidence.generation, 2); assert.equal(profile.evidence.agentSelections.builder.variant, variant);
    report.cases.push({ id: 'real-bundle-migration-saved-synthetic-graph', snapshotDigest: profile.evidence.snapshotDigest,
      inputDigest: profile.evidence.inputDigest, nativeBundle: profile.evidence.nativeBundle, agentCount: Object.keys(profile.evidence.agentSelections).length });
    report.stage = 'actual_host_startup';
    host = startOwnedProcess(process.versions.bun ? 'node' : process.execPath, [profile.bootstrapPath], { cwd: repository,
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
    assert.deepEqual(builder.model, { providerID: 'openai', modelID }); assert.equal(builder.variant, variant);
    const providerResponse = await fetch(new URL('/api/provider' + query, url), { signal: AbortSignal.timeout(10000) });
    assert.equal(providerResponse.ok, true, 'Actual provider/model catalog failed');
    const providerCatalog = await providerResponse.json();
    const openai = providerCatalog.all.find(row => row.id === 'openai');
    const familyIDs = Object.keys(openai?.models ?? {}).filter(id => id === 'gpt-5.6' || id.startsWith('gpt-5.6-'));
    report.actualCatalog = { providerID: 'openai', providerPresent: Boolean(openai), expectedModelID: modelID,
      expectedModelPresent: Boolean(openai?.models?.[modelID]), familyIDs: familyIDs.slice(0, 32), familyTruncated: familyIDs.length > 32 };
    assert.ok(openai?.models?.[modelID], 'Actual catalog lacks the supplied model');
    for (const [providerID, configuration] of Object.entries(providers ?? {})) {
      const actual = providerCatalog.all.find(row => row.id === providerID);
      assert.ok(actual, 'Actual catalog lacks the supplied custom provider');
      const expectedModels = Object.keys(configuration.models ?? {});
      for (const id of expectedModels) assert.ok(actual.models?.[id], 'Actual catalog lacks a supplied custom model');
      report.cases.push({ id: 'actual-custom-provider-model-catalog', providerID, expectedModels: expectedModels.length,
        matchedModels: expectedModels.filter(id => actual.models?.[id]).length, connected: providerCatalog.connected.includes(providerID) });
    }
    // Usage discovery and the owned selected-credential reads run against the actual
    // controller. xAI and OpenCode Go have no account here, so each must report "not
    // configured" before any provider request, never an unreadable credential or a
    // missing controller action. OpenAI depends on the fixture credential and is only
    // recorded; its usage endpoint is a live service and is not requested.
    const usageResponse = await fetch(new URL('/api/quota/providers' + query, url), { signal: AbortSignal.timeout(15000) });
    assert.equal(usageResponse.ok, true, 'Actual usage discovery failed');
    const usageProviders = (await usageResponse.json()).providers; assert.ok(Array.isArray(usageProviders));
    const usageResults = [];
    for (const providerID of ['xai', 'opencode-go']) {
      const response = await fetch(new URL('/api/quota/' + providerID + query, url), { signal: AbortSignal.timeout(15000) });
      assert.equal(response.ok, true, 'Actual usage read failed');
      const result = await response.json();
      usageResults.push({ providerID, listed: usageProviders.includes(providerID), ok: result.ok === true,
        configured: result.configured === true, errorCode: typeof result.errorCode === 'string' ? result.errorCode : null });
    }
    report.usageDiscovery = { listed: usageProviders.filter(id => typeof id === 'string').slice(0, 32), results: usageResults };
    for (const result of usageResults) {
      assert.equal(result.listed, false, 'Usage discovery listed a provider without an account');
      assert.equal(result.configured, false, 'Usage read without an account must report not configured');
      assert.equal(result.errorCode, 'NOT_CONFIGURED', 'Usage read without an account reported a credential failure');
    }
    report.cases.push({ id: 'actual-native-usage-discovery-without-accounts', listed: usageProviders.length, results: usageResults.length });
    report.cases.push({ id: 'actual-production-isolated-web-and-native-controller', hostPID: host.child.pid, nativePort: health.openCodePort,
      effectiveSelection: { agent: builder.name, model: builder.model, variant: builder.variant }, actualModel: openai.models[modelID].id });
    report.status = 'passed';
  } catch (error) {
    report.failure = { name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 512) };
    if (error.stderr) {
      const sanitizer = createDiagnosticSanitizer({ homeDir: profile?.env.HOME ?? sourceHome,
        pathMappings: [{ path: root, placeholder: '<QA_RUN>' }, { path: repository, placeholder: '<REPOSITORY>' }] });
      report.preparationLog = await archiveQaNativeHostLog({ getLog: () => String(error.stderr) }, root,
        sanitizer, 'preparation.stderr.log');
    }
  } finally {
    if (host) report.startupCodes = [...new Set(host.getLog().match(/(?:native|context|execution|mutation|opencode)_[a-z_0-9]+/g) ?? [])];
    if (host) try { report.cleanup = await host.stop(); } catch (error) { report.cleanupFailures.push({ name: error.name, code: error.code ?? null }); }
    const sanitizer = createDiagnosticSanitizer({ homeDir: profile?.env.HOME ?? sourceHome,
      pathMappings: [{ path: root, placeholder: '<QA_RUN>' }, { path: repository, placeholder: '<REPOSITORY>' }] });
    if (host) {
      try { report.hostLog = await archiveQaNativeHostLog(host, root, sanitizer); }
      catch (error) { report.cleanupFailures.push({ code: error.code ?? 'host_log_archive_failed' }); }
    }
    if (report.failure) report.failure.message = sanitizer.sanitizeText(report.failure.message);
    if (profile) {
      try { await profile.verifyInputs(); } catch (error) { report.cleanupFailures.push({ code: error.code ?? 'input_verification_failed' }); }
      try { report.nativeLog = await archiveQaNativeControllerLog(profile, root, sanitizer); }
      catch (error) { report.cleanupFailures.push({ code: error.code ?? 'native_log_archive_failed' }); }
    }
    if (report.cleanupFailures.length) report.status = 'failed';
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    run.finish(report.status === 'passed' ? 'passed' : 'failed');
  }
  return { root, report };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(argument => argument !== '--keep-artifacts');
  if (args.length !== 2 || args[0] !== '--artifact-root' || !args[1]) throw Error('Only explicit --artifact-root <repo-artifact-root> is accepted');
  const result = await runQaNativeFactoryDiagnostic({ artifactRoot: args[1] });
  process.stdout.write(JSON.stringify({ root: result.root, status: result.report.status, failure: result.report.failure ?? null }) + '\n');
  process.exitCode = result.report.status === 'passed' ? 0 : 1;
}
