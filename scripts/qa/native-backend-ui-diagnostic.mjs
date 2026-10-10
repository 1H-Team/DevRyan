import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHttpProvider, createHttpProviderConfiguration } from '../opencode-v2-native/http-provider.mjs';
import { createQaNativePreparationFactory } from './native-profile-factory.mjs';
import { createQaNativeInputVerifier, createQaNativeLaunchEnvironment } from './native-profile-preparation.mjs';
import { createRuntimeBundleStore } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle.js';
import { createRuntimeBundleCheckpoint } from '../../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { translateNativeConfiguration, nativeProviderConfigurations } from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import { listPackagedAgents } from '../../packages/web/server/lib/opencode/packaged-agents.js';
import { openChangeStore, changeKey } from '../../packages/harness-runtime/lib/session-changes-store.js';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';
import { runQaMatrix } from './matrix-runner.mjs';
import { TARGET_OPENCODE_VERSION } from '../../packages/web/server/lib/opencode/version-policy.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const inside = (root, file) => file.startsWith(root + path.sep);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ownedFutureDirectory(file) {
  if (!path.isAbsolute(file ?? '') || path.resolve(file) !== file || !inside(path.join(repository, '.cache'), file)) throw fail('qa_runtime_fixture_path_invalid');
  let ancestor = file;
  for (;;) { try { await fs.lstat(ancestor); break; } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); } }
  if (await fs.realpath(ancestor) !== ancestor) throw fail('qa_runtime_fixture_path_invalid');
}
export const runtimeUiTuple = Object.freeze({ providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'high' });
export const runtimeUiToolPrompt = 'DevRyan synthetic backend tool proof: read src/tasks.mjs, then write runtime-ui-proof.txt with exactly "DevRyan actual backend publication\\n", then reply exactly: DevRyan tools complete.';
const outputBytes = 'DevRyan actual backend publication\n';

/** Pin every real packaged role in the private fixture, including Council's
 * separate members; a primary-only override leaves real default routes active. */
export function runtimeUiAgentOverrides() {
  const model = `${runtimeUiTuple.providerID}/${runtimeUiTuple.modelID}`;
  const packaged = listPackagedAgents();
  const overrides = Object.fromEntries(['build', ...packaged.map(agent => agent.name)]
    .map(name => [name, { model, variant: runtimeUiTuple.variant }]));
  const council = packaged.find(agent => agent.name === 'council');
  assert.ok(council?.frontmatter.councillors?.length, 'Packaged Council members required');
  overrides.council.councillors = council.frontmatter.councillors.map(() => ({ model, variant: runtimeUiTuple.variant }));
  return overrides;
}

export function runtimeUiConfiguration(baseURL) {
  const url = new URL(baseURL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1'
    || url.search || url.hash || url.username || url.password) throw fail('qa_runtime_fixture_origin_invalid');
  const model = `${runtimeUiTuple.providerID}/${runtimeUiTuple.modelID}`;
  return { model, small_model: model, default_agent: 'builder', plugin: [], mcp: {}, snapshot: false, lsp: false,
    enabled_providers: [runtimeUiTuple.providerID], permission: 'allow', provider: { [runtimeUiTuple.providerID]: {
      npm: '@ai-sdk/openai-compatible', name: 'Synthetic actual-backend UI model', options: { baseURL, apiKey: '' },
      models: { [runtimeUiTuple.modelID]: { name: 'Synthetic UI', tool_call: true, limit: { context: 32768, output: 4096 },
        variants: { high: { temperature: 0 } } } },
    } }, agent: { ...Object.fromEntries(['builder', 'orchestrator'].map(name => [name, { mode: 'primary',
      description: `Synthetic ${name}`, prompt: 'Follow only the isolated QA request.', model, variant: 'high' }])), title: { disable: true } } };
}

export function runtimeUiNativeConfiguration(legacy, catalogProviders = {}) {
  assert.ok(!Object.hasOwn(catalogProviders, runtimeUiTuple.providerID), 'Catalog fixture must preserve the UI tuple');
  const native = translateNativeConfiguration({ legacy, agents: legacy.agent });
  const declared = createHttpProviderConfiguration(legacy.provider['devryan-smoke'].options.baseURL);
  native.providers = { ...declared.providers, ...nativeProviderConfigurations(catalogProviders) };
  delete native.providers['devryan-smoke'].models['gpt-5-native-smoke'];
  native.providers['devryan-smoke'].models['smoke-write'].variants = [{ id: 'high', settings: { temperature: 0 } }];
  return native;
}

export function createRuntimeUiResponder({ generation, directory }) {
  assert.equal(generation, 2); assert.ok(path.isAbsolute(directory));
  const tools = [{ id: 'runtime_ui_read', name: 'read', input: { path: 'src/tasks.mjs' } },
  { id: 'runtime_ui_write', name: 'write', input: { path: 'runtime-ui-proof.txt', content: outputBytes } }];
  return request => {
    assert.equal(request.body.model, runtimeUiTuple.modelID);
    const messages = request.body.messages;
    const user = messages.findLast(row => row.role === 'user');
    const text = typeof user?.content === 'string' ? user.content
      : (user?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    const results = messages.filter(row => row.role === 'tool');
    if (text.includes('DevRyan synthetic backend tool proof:')) {
      const completed = new Set(results.map(row => row.tool_call_id));
      const next = tools.find(call => !completed.has(call.id));
      if (next) {
        assert.ok(request.body.tools?.some(row => row.function?.name === next.name), `Missing original tool ${next.name}`);
        return { items: [{ type: 'toolCall', index: 0, ...next }], reason: 'tool-calls' };
      }
      return { items: [{ type: 'textDelta', text: 'DevRyan tools complete.' }], reason: 'stop' };
    }
    let response;
    if (text.includes('250 numbered one-line test cases')) response = Array.from({ length: 250 }, (_, i) => `${i + 1}. Synthetic cancellation case.\n`).join('');
    else if (text.includes('DevRyan reconnect complete.')) response = Array.from({ length: 60 }, (_, i) => `${i + 1}. Synthetic reconnect case.\n`).join('') + 'DevRyan reconnect complete.';
    else if (text.includes('DevRyan live QA ready.')) response = 'DevRyan live QA ready.';
    else throw fail('qa_runtime_fixture_unrelated_prompt');
    return { items: response.match(/.{1,48}(?:\n|$)?/gs).map(text => ({ type: 'textDelta', text })), reason: 'stop' };
  };
}

/** Original bounded HTTP provider packets, paced only at the owned loopback
 * transport so the actual runtime/UI can observe cancellation and reconnect. */
export async function createRuntimeUiProvider({ generation, directory, packetDelayMs = 80 }) {
  assert.ok(Number.isSafeInteger(packetDelayMs) && packetDelayMs >= 0 && packetDelayMs <= 500);
  const observations = [], active = new Set(), sockets = new Set(); let failure;
  const original = await createHttpProvider({ responder: createRuntimeUiResponder({ generation, directory }),
    maxRequests: 64, onRequest: row => observations.push({ ...row }) });
  const server = createServer(async (request, response) => {
    const controller = new AbortController(); active.add(controller);
    const timer = setTimeout(() => controller.abort(), 30_000);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
        || request.headers.authorization || request.headers['x-api-key']) throw fail('qa_runtime_fixture_request_invalid');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw fail('qa_runtime_fixture_body_bound'); chunks.push(chunk); }
      const upstream = await fetch(original.baseURL + '/chat/completions', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks), signal: controller.signal });
      if (!upstream.ok) throw fail('qa_runtime_fixture_provider_failed');
      const output = await upstream.text(); if (Buffer.byteLength(output) > 1024 * 1024) throw fail('qa_runtime_fixture_output_bound');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const packet of output.split('\n\n').filter(Boolean)) {
        if (controller.signal.aborted) break;
        response.write(packet + '\n\n');
        if (packetDelayMs) await pause(packetDelayMs);
      }
      response.end();
    } catch (error) {
      if (!controller.signal.aborted) { failure ??= error; if (!response.headersSent) response.writeHead(500); response.end(); }
    } finally { clearTimeout(timer); active.delete(controller); response.off('close', disconnect); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, observations,
    check() { if (failure) throw failure; original.check(); },
    async close() { for (const controller of active) controller.abort(); for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve)); await original.close();
      const deadline = Date.now() + 5000;
      while (active.size) { if (Date.now() > deadline) throw fail('qa_runtime_fixture_transport_unsettled'); await pause(10); }
      if (failure) throw failure; } };
}

/** Read one committed ledger tree without creating, recovering or committing
 * state. Pending materialization is not publication evidence. */
export async function readRuntimeUiLease({ storage, directory, sessionID, callID }) {
  await ownedFutureDirectory(storage); await ownedFutureDirectory(directory);
  const root = path.join(storage, changeKey(directory)), gitDir = path.join(root, 'git');
  for (const target of [directory, root, gitDir]) {
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || await fs.realpath(target) !== target) throw fail('qa_runtime_fixture_ledger_missing');
  }
  const db = await openChangeStore(root, gitDir);
  const meta = await db.get('meta.json');
  if (!db.exists || meta?.version !== 1 || meta.directory !== directory) throw fail('qa_runtime_fixture_ledger_invalid');
  if (await db.get('materialization.json') !== null) throw fail('qa_runtime_fixture_materialization_pending');
  const call = await db.get(`calls/${changeKey(sessionID + '\0' + callID)}.json`);
  if (typeof call?.token !== 'string' || !/^[a-f0-9-]{36}$/.test(call.token)) throw fail('qa_runtime_fixture_call_missing');
  const lease = await db.get(`leases/${changeKey(call.token)}.json`);
  if (!lease || lease.token !== call.token) throw fail('qa_runtime_fixture_lease_missing');
  return lease;
}

export async function assertRuntimeUiPublication({ rows, sessionID, directory, leaseForCall, readReceipt = readSessionExecutionReceipt }) {
  const calls = ['runtime_ui_read', 'runtime_ui_write'].map(callID => {
    const matching = rows.filter(row => row.parts?.some(part => part.type === 'tool' && part.callID === callID));
    assert.equal(matching.length, 1, 'Missing or duplicate actual tool call');
    const row = matching[0];
    const parts = row.parts.filter(part => part.type === 'tool' && part.callID === callID);
    assert.equal(parts.length, 1, 'Duplicate actual tool part');
    const tool = parts[0];
    assert.equal(row?.info.sessionID, sessionID); assert.equal(tool?.state?.status, 'completed');
    assert.equal(tool.tool, callID.endsWith('read') ? 'read' : 'write');
    return { callID, messageID: row.info.id };
  });
  const write = calls[1], lease = await leaseForCall({ directory, sessionID, callID: write.callID });
  assert.equal(lease?.state, 'published'); assert.equal(lease.executionKind, 'process');
  assert.equal(lease.directory, directory);
  assert.equal(lease.scope.sessionID, sessionID); assert.equal(lease.scope.callID, write.callID); assert.equal(lease.scope.messageID, write.messageID);
  assert.ok(lease.result?.operationID);
  const receipt = await readReceipt(lease); assert.equal(receipt.terminated, true); assert.equal(receipt.confined, true);
  assert.equal(receipt.cancelled, false); assert.equal(receipt.exitCode, 0);
  const actual = await fs.readFile(path.join(directory, 'runtime-ui-proof.txt'), 'utf8'); assert.equal(actual, outputBytes);
  return { calls, state: lease.state, operationID: lease.result.operationID,
    termination: { terminated: receipt.terminated, confined: receipt.confined, exitCode: receipt.exitCode }, sha256: hash(actual) };
}

/** Data-only preparation. The matrix's real web/Electron host remains the
 * sole process/runtime owner; this never starts a controller or reads accounts. */
/** Constructor-only location policy for genuine production startup provisioning. */
export function runtimeUiBundleLayout(runtimeRoot, startupUpgrade = false) {
  assert.equal(typeof startupUpgrade, 'boolean');
  assert.ok(path.isAbsolute(runtimeRoot) && path.resolve(runtimeRoot) === runtimeRoot);
  const stateRoot = startupUpgrade ? path.join(runtimeRoot, 'state') : null;
  const controlRoot = stateRoot ? path.join(stateRoot, 'devryan/runtime-bundles') : path.join(runtimeRoot, 'bundles');
  return { controlRoot, createLaunchEnvironment(binding) {
    assert.equal(binding.controlRoot, controlRoot);
    const env = createQaNativeLaunchEnvironment({ binding, runtimeRoot });
    if (stateRoot) {
      // An explicit root skips production provisioning; the normal XDG root
      // lets the packaged application perform its own cold startup upgrade.
      delete env.DEVRYAN_RUNTIME_BUNDLE_ROOT;
      env.XDG_STATE_HOME = stateRoot;
    }
    return env;
  } };
}

export async function prepareRuntimeUiProfile({ cell, runtimeRoot, workspace, targetGeneration, artifactRoot, startupUpgrade = false, catalogProviders, legacyOpenAiBrowser = false }) {
  assert.equal(targetGeneration, 2);
  assert.equal(cell.transport, 'runtime-fixture');
  const layout = runtimeUiBundleLayout(runtimeRoot, startupUpgrade);
  await ownedFutureDirectory(runtimeRoot); await ownedFutureDirectory(workspace);
  if (await fs.realpath(workspace) !== workspace || !path.isAbsolute(artifactRoot ?? '')
    || !inside(path.join(repository, '.cache'), artifactRoot) || await fs.realpath(artifactRoot) !== artifactRoot) throw fail('qa_runtime_fixture_path_invalid');
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const provider = await createRuntimeUiProvider({ generation: targetGeneration, directory: workspace });
  try {
    const sourceHome = path.join(runtimeRoot, 'mirror'); await fs.mkdir(sourceHome);
    const legacy = runtimeUiConfiguration(provider.baseURL), native = runtimeUiNativeConfiguration(legacy, catalogProviders);
    const primaryAgents = ['builder', 'orchestrator'];
    const agentOverrides = runtimeUiAgentOverrides();
    const pinnedAgents = Object.fromEntries(Object.entries(agentOverrides).map(([name, value]) => [name, { model: value.model, variant: value.variant }]));
    const copiedConfiguration = { ...legacy, provider: undefined, providers: native.providers };
    const manifest = JSON.parse(await fs.readFile(path.join(artifactRoot, 'native-bundle.json'), 'utf8'));
    const files = { 'opencode/opencode.json': JSON.stringify(copiedConfiguration),
      'opencode/oh-my-opencode-slim.json': JSON.stringify({ preset: 'qa', presets: { qa: pinnedAgents }, agents: pinnedAgents }),
      'opencode/.openchamber/config.json': JSON.stringify({ agentOverrides }),
      'web/settings.json': JSON.stringify({ lastDirectory: workspace, activeProjectId: 'qa-project',
        defaultModel: legacy.model, defaultAgent: 'builder',
        agentModelSelections: Object.fromEntries(primaryAgents.map(name => [name, { providerId: runtimeUiTuple.providerID,
          modelId: runtimeUiTuple.modelID, variant: runtimeUiTuple.variant }])),
        projects: [{ id: 'qa-project', path: workspace, label: 'Synthetic actual backend' }], showReasoningTraces: true,
        messageStreamTransport: 'sse', desktopWindowState: { width: 1280, height: 800, maximized: false } }),
      'reviewed-native.json': JSON.stringify({ schema: 1, configuration: native, locations: [],
        catalogRequirements: { agents: ['builder', 'orchestrator'], tools: ['read', 'write'], plugins: [],
          models: [{ providerID: runtimeUiTuple.providerID, id: runtimeUiTuple.modelID, variant: 'high' }] } }),
      'reviewed-plugins.json': JSON.stringify({ schema: 1, plugins: manifest.inputs.reviewedPlugins }) };
    for (const [file, bytes] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(sourceHome, file)), { recursive: true }); await fs.writeFile(path.join(sourceHome, file), bytes, { mode: 0o600 }); }
    const preparedInput = { sourceHome, artifactRoot, files: Object.entries(files).map(([file, bytes]) => ({ path: file, sha256: hash(bytes) })) };
    const verifier = await createQaNativeInputVerifier(preparedInput);
    // This constructor-only refusal is never consulted: source copying is
    // reused separately from live account admission, which remains unchanged.
    const factory = await createQaNativePreparationFactory({ preparedInput,
      mirror: { reviewedNativeFile: 'reviewed-native.json', reviewedPluginFile: 'reviewed-plugins.json', opencodeConfigDirectory: 'opencode', webConfigDirectory: 'web' },
      bootstrapCredentials: async () => { throw fail('qa_runtime_fixture_accounts_forbidden'); } });
    const source = await factory.prepareSource({ runtimeRoot, workspace, sourceHome, artifactRoot });
    const emptyStartupSource = startupUpgrade && manifest.opencodeVersion !== TARGET_OPENCODE_VERSION;
    if (emptyStartupSource) {
      // Production first installs import an empty.db, rather than the factory's
      // legacy schema seeded by the current SDK. Let the baseline's own
      // controller create its original reviewed native database layout.
      source.launch.opencodeDatabasePath = path.join(path.dirname(source.launch.opencodeDatabasePath), 'empty.db');
      await fs.writeFile(source.launch.opencodeDatabasePath, '', { flag: 'wx', mode: 0o600 });
    }
    await verifier.verifyInputs();
    await fs.copyFile(path.join(sourceHome, 'web/settings.json'), path.join(source.launch.webDataDirectory, 'settings.json'));
    const controlRoot = layout.controlRoot, descriptors = new Map(), checkpoints = new Map();
    const store = createRuntimeBundleStore({ controlRoot, runMigration: source.runMigration, withQuiescedSource: async (scope, action) => {
      const current = scope.kind === 'legacy' ? { bundleID: 'synthetic-source', generation: 1, launch: source.launch } : descriptors.get(scope.bundleID);
      if (!current) throw fail('qa_runtime_fixture_checkpoint_missing');
      if (!checkpoints.has(current.bundleID)) checkpoints.set(current.bundleID, createRuntimeBundleCheckpoint({
        ...await source.checkpointOptions({ ownerID: current.bundleID, generation: current.generation, launch: current.launch }),
        ownerID: current.bundleID, generation: current.generation, launch: current.launch }));
      return checkpoints.get(current.bundleID)(scope, action);
    } });
    const selected = await store.prepare({ bundleID: 'candidate', generation: 2,
      source: { kind: 'legacy', launch: source.launch }, projectMap: source.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts: source.nativeArtifacts });
    if (legacyOpenAiBrowser) {
      assert.equal(manifest.opencodeVersion, TARGET_OPENCODE_VERSION, 'Legacy credential fixture requires the current initialized database');
      const { Database } = await import('bun:sqlite');
      const fixtureDB = new Database(selected.launch.opencodeDatabasePath);
      try {
        fixtureDB.query('INSERT INTO credential (id,integration_id,label,value,active,connector_id,method_id,time_created,time_updated) VALUES (?,?,?,?,1,NULL,NULL,?,?)')
          .run('crd_legacy_fixture','openai','Synthetic retired login',JSON.stringify({type:'oauth',methodID:'chatgpt-browser',access:'synthetic-access',refresh:'synthetic-refresh',expires:Date.now()+3600000,metadata:{accountID:'synthetic-account'}}),Date.now(),Date.now());
      } finally { fixtureDB.close(); }
    }
    if (emptyStartupSource) assert.equal((await fs.stat(source.launch.opencodeDatabasePath)).size, 0, 'Baseline import must preserve the empty source');
    descriptors.set('candidate', selected);
    await store.select({ bundleID: selected.bundleID, expectedRevision: 0 });
    const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }), launch = binding.descriptor.launch;
    await fs.writeFile(path.join(launch.global.home, '.devryan-qa-home'), 'Owned synthetic actual-backend UI\n', { mode: 0o600 });
    await fs.writeFile(path.join(runtimeRoot, 'credentials.env.json'), '{}\n', { mode: 0o600 });
    const env = layout.createLaunchEnvironment(binding);
    env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1';
    const storage = path.join(launch.webDataDirectory, 'harness/session-mutations');
    return { env, controlRoot, bootstrapPath: fileURLToPath(new URL('./isolated-host.mjs', import.meta.url)), nativeLogRoot: launch.global.log,
      toolPrompt: runtimeUiToolPrompt, verifyInputs: verifier.verifyInputs,
      verifyToolPublication: async input => { provider.check(); return assertRuntimeUiPublication({ ...input, directory: workspace,
        leaseForCall: scope => readRuntimeUiLease({ ...scope, storage }) }); },
      close: () => provider.close(),
      evidence: { transport: 'runtime-fixture', generation: targetGeneration, credentialsCopied: false, personalSetup: false, legacyOpenAiBrowser,
        inputDigest: verifier.inputDigest, sourceHome, modelSelection: runtimeUiTuple, providerRequests: provider.observations,
        nativeBundle: { bundleID: selected.bundleID, revision: binding.selection.revision },
        excludedAcceptance: ['saved-user-graph', 'paid-provider', 'reasoning-policy', 'native-compaction', 'managed-task-ui'] } };
  } catch (error) { try { await provider.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Synthetic preparation and cleanup failed'); } throw error; }
}

/** Explicit constructor driver; no ambient home/default account acquisition. */
export function runNativeBackendUiDiagnostic({ configPath, artifactRoot }) {
  return runQaMatrix(configPath, { prepareRuntimeFixtureProfile: input => prepareRuntimeUiProfile({ ...input, artifactRoot }) });
}
