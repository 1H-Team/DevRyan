import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { repositoryRoot } from './artifacts.mjs';

export const performanceSha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const performanceRole = Object.freeze({ description: 'Isolated runtime performance fixture', prompt: 'Execute the exact fixture request. Do not perform additional work.', mode: 'primary' });
// The identical local profile retains the whole 100-operation workload. Actual
// compaction thresholds and continuity are qualified by the separate F lanes.
export const performanceModelLimits = Object.freeze({ context: 1048576, input: 1000000, output: 4096 });
const failure = code => Object.assign(new Error(code), { code });

/** Same-stream, content-free arrival clock. It has no inference or settlement
 * authority; canonical transcript and real receipts remain independently read. */
export function createPerformanceTerminalObserver({ generation, directory, maxRecords = 4096 }) {
  assert.equal(generation, 2);
  assert.ok(typeof directory === 'string' && directory);
  assert.ok(Number.isSafeInteger(maxRecords) && maxRecords > 0 && maxRecords <= 4096);
  const terminals = new Map();
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
  return {
    observe(event, arrivedAtMs) {
      const envelope = event?.payload ?? event;
      const eventDirectory = generation === 2 ? envelope?.location?.directory : event?.directory;
      if (generation === 2 ? eventDirectory !== directory : eventDirectory !== undefined && eventDirectory !== directory) return null;
      let sessionID, assistantMessageID;
      if (generation === 2 && envelope?.type === 'session.step.ended') {
        sessionID = envelope.data?.sessionID; assistantMessageID = envelope.data?.assistantMessageID;
        if (!identity(envelope.id)) return null;
      } else return null;
      if (!identity(sessionID) || !identity(assistantMessageID) || !Number.isFinite(arrivedAtMs) || arrivedAtMs < 0) return null;
      const key = `${sessionID}\0${assistantMessageID}`;
      if (terminals.has(key)) return null; // Retain first actual arrival, not replay time.
      if (terminals.size >= maxRecords) throw failure('benchmark_terminal_observation_bound');
      const sequence = envelope.sequence ?? envelope.seq;
      const row = { generation, type: envelope.type, sessionID, assistantMessageID,
        eventID: identity(envelope.id) ? envelope.id : null,
        sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null,
        created: Number.isFinite(envelope.created) ? envelope.created : null, arrivedAtMs };
      terminals.set(key, row); return row;
    },
    join({ sessionID, assistantMessageID, submissionAtMs, completionObservedAtMs }) {
      const terminal = terminals.get(`${sessionID}\0${assistantMessageID}`);
      const unavailable = reason => ({ status: 'unavailable', reason, sessionID, assistantMessageID });
      if (!terminal) return unavailable('exact_canonical_terminal_arrival_missing');
      if (![submissionAtMs, completionObservedAtMs].every(Number.isFinite) || submissionAtMs < 0
        || completionObservedAtMs < submissionAtMs) return unavailable('operation_clock_invalid');
      if (terminal.arrivedAtMs < submissionAtMs) return unavailable('terminal_arrival_precedes_submission');
      if (terminal.arrivedAtMs > completionObservedAtMs) return unavailable('terminal_arrival_follows_completion_observation');
      return { status: 'observed', source: 'same-native-sse-stream-exact-canonical-assistant', terminal, submissionAtMs, completionObservedAtMs,
        submissionToTerminalArrivalMs: terminal.arrivedAtMs - submissionAtMs,
        terminalArrivalToCompletionObservationMs: completionObservedAtMs - terminal.arrivedAtMs };
    },
  };
}

/** Routes concurrent real model requests using the last exact user marker, never a current-session map. */
export function createPerformanceResponder() {
  const turns = new Map();
  const register = ({ id, calls = [], text = 'Fixture complete.', deltas = 32 }) => {
    assert.match(id, /^[a-z0-9_-]{1,100}$/);
    assert.ok(!turns.has(id));
    const marker = `[devryan-performance:${id}]`;
    const state = { issued: false, completed: false, requests: [], tools: [] };
    turns.set(id, { marker, calls, text, deltas, state });
    return { marker, complete: () => {
      assert.ok(state.completed, `Unsettled real provider turn ${id}`);
      return { id, providerRequests: state.requests, observedTools: state.tools };
    } };
  };
  const respond = request => {
    const messages = request.body?.messages;
    assert.ok(Array.isArray(messages));
    const user = messages.findLast(row => row.role === 'user');
    const marker = JSON.stringify(user?.content).match(/\[devryan-performance:([a-z0-9_-]+)\]/)?.[1];
    const turn = turns.get(marker);
    assert.ok(turn, 'Unrelated benchmark model request');
    const { state, calls, text, deltas } = turn;
    assert.equal(state.completed, false, 'Duplicate benchmark inference after terminal response');
    state.requests.push(request.id);
    const tools = request.body.tools?.map(row => row.function?.name).filter(Boolean) ?? [];
    state.tools = [...new Set([...state.tools, ...tools])].sort();
    if (calls.length && !state.issued) {
      for (const call of calls) assert.ok(tools.includes(call.name), `Missing actual tool ${call.name}`);
      state.issued = true;
      return { items: calls.map((call, index) => ({ type: 'toolCall', index, ...call })), reason: 'tool-calls' };
    }
    if (calls.length) {
      const results = messages.filter(row => row.role === 'tool' && calls.some(call => call.id === row.tool_call_id));
      assert.deepEqual(results.map(row => row.tool_call_id).sort(), calls.map(row => row.id).sort(), 'Missing or duplicate actual tool results');
    }
    state.completed = true;
    // Each packet is a real provider text delta; the runtime, rather than this
    // fixture, owns token accumulation, HTTP/SSE delivery and transcript commit.
    const length = Math.max(1, Math.ceil(text.length / deltas));
    return { items: Array.from({ length: Math.ceil(text.length / length) }, (_, index) =>
      ({ type: 'textDelta', text: text.slice(index * length, (index + 1) * length) })), reason: 'stop' };
  };
  return { register, respond };
}

/** Explicit copied fixture layers; this never invokes ambient settings discovery. */
export async function loadPerformanceLocation({ directory, launch }) {
  const { readConfigFile, mergeConfigs, parseMdFile } = await import('../../packages/web/server/lib/opencode/shared.js');
  let legacy = {};
  const layers = [path.join(launch.opencodeConfigDirectory, 'opencode.json'),
    path.join(launch.opencodeConfigDirectory, 'opencode.jsonc'), path.join(directory, '.opencode/opencode.json'),
    path.join(directory, '.opencode/opencode.jsonc')];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    await assert.rejects(fs.lstat(path.join(directory, name)), error => error.code === 'ENOENT',
      'This isolated profile has no project-root configuration outside the stamped .opencode tree');
  }
  for (const file of layers) {
    let stat; try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'Unreviewed fixture configuration file');
    assert.equal(await fs.realpath(file), file, 'Fixture configuration escaped its copied root');
    legacy = mergeConfigs(legacy, readConfigFile(file));
  }
  // This benchmark profile intentionally has no executable package/plugin,
  // command, instruction, skill or MCP data. Unexpected inputs fail visibly.
  for (const key of ['plugin', 'plugins', 'instructions', 'skills', 'command', 'mcp']) {
    const value = legacy[key];
    assert.ok(value === undefined || typeof value === 'object' && value !== null && Object.keys(value).length === 0,
      `Unexpected active benchmark setting ${key}`);
  }
  return { legacy, agents: structuredClone(legacy.agent ?? {}), commands: {}, skills: [],
    slim: { mergedConfig: {} }, parseMarkdown: parseMdFile };
}

/** Actual accepted binaries and production web owners, isolated to this new fixture root. */
export async function createPerformanceFixture({ root, generation, artifactRoot, fileCount = 1000, eventReconcileIntervalMs = 750 }) {
  assert.equal(generation, 2);
  assert.ok(Number.isSafeInteger(eventReconcileIntervalMs) && eventReconcileIntervalMs >= 0);
  assert.ok([1000, 12000].includes(fileCount));
  root = await fs.realpath(root);
  assert.ok(root.startsWith(repositoryRoot + path.sep));
  assert.equal(process.env.DEVRYAN_RUNTIME_BUNDLE_ROOT, undefined, 'An installed/selected runtime cannot seed a benchmark');
  const [{ createSessionExecutionHost }, { createOpenCodeClient }, { createOpenCodeAdmission, createV2MessageId },
    { createHttpProvider, createHttpProviderConfiguration },
    { createQaHostLaunchEnvironment }, { readSessionExecutionReceipt }] = await Promise.all([
    import('../../packages/web/server/lib/opencode/session-execution-host.js'),
    import('../../packages/web/server/lib/opencode/opencode-client/index.js'),
    import('../../packages/web/server/lib/opencode/v2/admission.js'), import('./http-provider.mjs'),
    import('../qa/launch-environment.mjs'),
    import('../../packages/harness-runtime/lib/session-execution.js'),
  ]);
  const observations = [], diagnostics = [], cleanupFailures = [];
  const nativeWriterHandles = new Map(), writerDescriptors = new Map();
  const writerStartListeners = new Set();
  let writerStartObserverFailed = false;
  const subscribeWriterStarts = listener => {
    assert.equal(typeof listener, 'function');
    writerStartListeners.add(listener);
    return () => writerStartListeners.delete(listener);
  };
  let writerProcessLauncher;
  const responder = createPerformanceResponder();
  let provider;
  provider = await createHttpProvider({ responder: responder.respond, maxRequests: 1024,
    maxBodyBytes: 4 * 1024 * 1024, onRequest: row => {
      observations.push({phase:'provider',...row});
      // The original transport already hashed the complete request. Retain
      // that evidence, rather than accumulating quadratic history copies in
      // the measured Node host merely for fixture observation.
      const request=provider.requests.find(value=>value.id===row.requestID);
      if(request)request.body={model:request.body.model,stream:request.body.stream};
    } });
  let host, managed, runtimeOwner, nativeURL, epoch = 0, controller;
  let directory, environment, artifactSha256, version, pluginHash, configuration, startupMs, modelLimits;
  let stopEvents;
  const started = performance.now();
  const cleanup = async () => {
    for (const close of [() => stopEvents?.(), () => runtimeOwner?.close(), () => host?.drain(),
      () => managed?.close(), () => provider.close()]) {
      try { await close(); } catch (error) { cleanupFailures.push({ code: error.code, message: error.message }); }
    }
    const evidence = { cleanupFailures,
      nativeExited: controller ? controller.hasExited() : null };
    await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures.map(row => failure(row.code ?? row.message)), 'Benchmark cleanup incomplete');
    if (controller) assert.equal(controller.hasExited(), true);
    return evidence;
  };
  const deps = { getRuntime: () => ({ generation, baseUrl: nativeURL, version, epoch }),
    getAuthHeaders: () => runtimeOwner?.getAuthHeaders() ?? {}, recordDiagnostic: row => diagnostics.push(row),
    withNativeWebOperation: (spec, action) => runtimeOwner.nativeOwner.withWebOperation(spec, action) };
  const admission = createOpenCodeAdmission(deps, { beforePromptDispatch: (receipt, context) => managed?.admitNativePrompt(receipt, context),
    onPromptDispatchFailure: receipt => managed?.markNativePromptUncertain(receipt), nativeOwner: {
      requestHeaders: () => runtimeOwner.nativeOwner.requestHeaders(),
      withAcceptedOperation: (receipt, action) => runtimeOwner.nativeOwner.withAcceptedOperation(receipt, action),
      withCommandSelection: (input, action) => runtimeOwner.nativeOwner.withCommandSelection(input, action),
      checkQueuedPromptAdmission:(...args)=>runtimeOwner.nativeOwner.checkQueuedPromptAdmission(...args),
    stageQueuedPromptAdmission:(...args)=>runtimeOwner.nativeOwner.stageQueuedPromptAdmission(...args),
    assertQueuedPromptReconciled:(...args)=>runtimeOwner.nativeOwner.assertQueuedPromptReconciled(...args),
    queuedPromptWasRejected:(...args)=>runtimeOwner.nativeOwner.queuedPromptWasRejected(...args),
    updateAcceptedOperation: receipt => runtimeOwner.nativeOwner.updateAcceptedOperation(receipt),
    } });
  const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });
  const buildOpenCodeUrl = route => new URL(route, nativeURL).href;
  try {
    {
      // This is the same production composition as compiled package acceptance:
      // private empty setup seed -> coherent copy -> actual SDK initialization ->
      // selected bundle -> root runtime owner. No native SDK replacement.
      const [{ createEmptyRuntimeFixture }, { createRuntimeBundleStore }, { createRuntimeBundleCheckpoint },
        { runNativeMigrationProcess }, { verifyNativeRuntimeArtifacts }, { createNativeAuthorization },
        { createOpenAiOAuthCoordinator }, { loadNativeRuntimeBundle, createNativeRuntimeOwner },
        { createNativeManagedFixture }, { readRuntimeBundleBinding }, { DEFAULT_RG, RG_SHA256 },
        { createNativeConfigurationSnapshotResolver }] = await Promise.all([
        import('./migration-fixture.mjs'), import('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle.js'),
        import('../../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js'),
        import('../../packages/web/server/lib/opencode/runtime-host/native-migration-process.js'),
        import('../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js'),
        import('../../packages/web/server/lib/opencode/runtime-host/native-authorization.js'),
        import('../../packages/web/server/lib/opencode/openai-oauth-coordinator.js'),
        import('../../packages/web/server/lib/opencode/runtime-host/native-runtime-owner.js'), import('./managed-fixture.mjs'),
        import('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js'), import('./artifacts.mjs'),
        import('../../packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js'),
      ]);
      artifactRoot = await fs.realpath(artifactRoot);
      assert.ok(artifactRoot.startsWith(repositoryRoot + path.sep));
      const manifestPath = path.join(artifactRoot, 'native-bundle.json');
      artifactSha256 = performanceSha256(await fs.readFile(manifestPath));
      const artifacts = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: artifactSha256,
        launcher: path.join(artifactRoot, `DevRyan-execution-${process.platform}-${process.arch}`) });
      const fixture = await createEmptyRuntimeFixture({ root });
      configuration = createHttpProviderConfiguration(provider.baseURL);
      for (const model of Object.values(configuration.providers['devryan-smoke'].models)) model.limit = { ...performanceModelLimits };
      configuration.agents.benchmark = { description:performanceRole.description,system:performanceRole.prompt,mode:performanceRole.mode,model:'devryan-smoke/smoke-write' };
      // Persist the declared profile in the source copy, then resolve that same
      // copied data under the immutable registration policy on each start.
      const copiedConfigPath = path.join(fixture.sourceLaunch.opencodeConfigDirectory, 'opencode.json');
      const copiedConfig = JSON.parse(await fs.readFile(copiedConfigPath, 'utf8'));
      await fs.writeFile(copiedConfigPath, JSON.stringify({ ...copiedConfig, providers: configuration.providers,
        model: 'devryan-smoke/smoke-write', default_agent: 'benchmark', permission: 'allow', formatter: false,
        agent: { ...copiedConfig.agent, benchmark: { ...performanceRole, model: 'devryan-smoke/smoke-write', variant: 'default' } } }));
      const locations = fixture.projectMap.map(row => ({ directory: row.targetDirectory, readRoots: [row.targetDirectory],
        protectedRoots: [fixture.sourceLaunch.global.home, fixture.sourceLaunch.webDataDirectory] }));
      const reviewedNativeConfigPath = path.join(root, 'reviewed-native.json'), reviewedPluginManifestPath = path.join(root, 'reviewed-plugins.json');
      await fs.writeFile(reviewedNativeConfigPath, JSON.stringify({ schema: 1, configuration, locations,
        catalogRequirements: { agents: ['benchmark'], tools: ['read', 'write', 'glob'], plugins: ['devryan.managed-task'],
          models: [{ providerID: 'devryan-smoke', id: 'smoke-write' }] } }));
      await fs.writeFile(reviewedPluginManifestPath, JSON.stringify({ schema: 1, plugins: artifacts.manifest.inputs.reviewedPlugins }));
      const launchArtifacts = { controllerBinary: artifacts.controller, writerBinary: artifacts.writer,
        artifactManifestPath: manifestPath, artifactManifestSha256: artifactSha256, reviewedNativeConfigPath, reviewedPluginManifestPath };
      const sourceLaunch = { ...fixture.sourceLaunch, global: { home: fixture.sourceLaunch.global.home } };
      const sourceHost = createSessionExecutionHost({ dataDirectory: sourceLaunch.webDataDirectory, openCodeClient: client,
        getLauncher: () => artifacts.launcher, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders });
      const checkpoint = createRuntimeBundleCheckpoint({ ownerID: 'owned-performance-source', generation: 1, launch: sourceLaunch, neverStarted: true,
        closeAdmission: () => sourceHost.runtime.drain(), getController: () => null,
        stopProducers: async () => assert.deepEqual(await fs.readdir(sourceLaunch.webDataDirectory), []),
        executionHost: sourceHost, drainStores: () => sourceHost.runtime.drain() });
      const controlRoot = path.join(root, 'bundles');
      const privateEnvironment = globals => createQaHostLaunchEnvironment({ ...fixture.environment,
        HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state,
        XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp, TMP: globals.tmp, TEMP: globals.tmp });
      const preparedBundles = new Map();
      const withQuiescedSource = async (input,action) => {
        if(input.kind==='legacy')return checkpoint(input,action);
        const prepared = preparedBundles.get(input.bundleID);
        assert.ok(prepared, 'Only an actually prepared never-started fixture bundle may checkpoint');
        const copiedHost=createSessionExecutionHost({dataDirectory:prepared.launch.webDataDirectory,openCodeClient:client,
          getLauncher:()=>artifacts.launcher,buildOpenCodeUrl,getOpenCodeAuthHeaders:deps.getAuthHeaders});
        return createRuntimeBundleCheckpoint({ownerID:prepared.bundleID,generation:prepared.generation,launch:prepared.launch,neverStarted:true,
          closeAdmission:()=>copiedHost.runtime.drain(),getController:()=>null,
          stopProducers:async()=>assert.deepEqual(await fs.readdir(prepared.launch.webDataDirectory),[]),
          executionHost:copiedHost,drainStores:()=>copiedHost.runtime.drain()})(input,action);
      };
      const store = createRuntimeBundleStore({ controlRoot, withQuiescedSource,
        runMigration: request => runNativeMigrationProcess({ binary: artifacts.controller, request, cwd: root,
          environment: privateEnvironment(Object.fromEntries(['home','config','data','state','cache','tmp','bin','log','repos']
            .map(key => [key, path.join(request.isolatedRoot, key)]))),
          beforeSpawn: () => verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: artifactSha256, launcher: artifacts.launcher }) }),
        reconcileRollback: () => { throw failure('performance_rollback_not_requested'); } });
      const descriptor = await store.prepare({ bundleID: 'performance', generation: 2, source: { kind: 'legacy', launch: sourceLaunch },
        projectMap: fixture.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts });
      preparedBundles.set(descriptor.bundleID, descriptor);
      await store.select({ bundleID: 'performance', expectedRevision: 0 });
      const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot });
      const loadedBundle = await loadNativeRuntimeBundle({ binding, launcher: artifacts.launcher });
      const resolveSnapshot = createNativeConfigurationSnapshotResolver({ loadLocation: loadPerformanceLocation });
      const registrationDigest = performanceSha256(await fs.readFile(descriptor.launch.reviewedPluginManifestPath));
      const bundle = { ...loadedBundle, resolveConfiguration: revision => resolveSnapshot({ binding, revision,
        expectedRegistrationDigest: registrationDigest }) };
      const globals = descriptor.launch.global;
      for (const dir of Object.values(globals)) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(globals.tmp, 'package.json'), '{"type":"commonjs"}\n');
      const rg = path.join(globals.cache, 'opencode/bin/rg'); await fs.mkdir(path.dirname(rg), { recursive: true });
      assert.equal(performanceSha256(await fs.readFile(DEFAULT_RG)), RG_SHA256); await fs.copyFile(DEFAULT_RG, rg); await fs.chmod(rg, 0o755);
      environment = privateEnvironment(globals); directory = locations[0].directory;
      host = createSessionExecutionHost({ dataDirectory: descriptor.launch.webDataDirectory, openCodeClient: client,
        getLauncher: () => artifacts.launcher, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders,
        onDiagnostic: row => diagnostics.push(row), nativeExecution: { writerConfig: { formatter: false }, isReady: () => Boolean(nativeURL), locations,
          socketDirectory: null, workerBrowsers: false, helperRoots: locations.map(row => row.directory), gitCommand: '/usr/bin/git',
          deniedReadDirectories: ['packages','scripts','node_modules'].map(name => path.join(repositoryRoot, name)),
          workerCommand: artifacts.writer, workerArgs: [], workerEnvironment: environment,
          recheckPermit: input => runtimeOwner.nativeOwner.recheckExecution(input), stopSessions: input => runtimeOwner.stopSessions(input),
          onTermination: row => observations.push({ ...row, phase: 'termination_verified' }),
          onOutcome: row => observations.push({ ...row, phase: row.state === 'published' ? 'published' : 'discarded' }),
        } });
      writerProcessLauncher=artifacts.launcher;
      const nativeExecution=host.nativeExecution;
      host.nativeExecution=async(input,context)=>{
        const result=await nativeExecution(input,context);
        if(input.action==='start' && typeof result.handle==='string') nativeWriterHandles.set(result.handle,{directory:input.directory,
          sessionID:input.sessionID,messageID:input.messageID,callID:input.callID,kind:input.kind,pids:new Set()});
        if(input.action==='read') {
          const scope=nativeWriterHandles.get(input.handle);
          for(const event of result.events??[]) if(scope && event.type==='started' && Number.isSafeInteger(event.pid) && !scope.pids.has(event.pid)) {
            scope.pids.add(event.pid);
            if (scope.kind === 'writer') for (const listener of writerStartListeners) {
              try { listener(event.pid); } catch { writerStartObserverFailed = true; }
            }
          }
        }
        return result;
      };
      managed = createNativeManagedFixture({ client, admissionOwner: {
        withManagedTaskDispatch: (input, action) => runtimeOwner.nativeOwner.withManagedTaskDispatch(input, action),
        withPermit: (permit, action) => runtimeOwner.nativeOwner.withPermit(permit, action) }, executionHost: host, directory,
        dataDirectory: descriptor.launch.webDataDirectory, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders,
        environment, observations, diagnostics, eventReconcileIntervalMs, executionModel: { providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'default' } });
      const principal = Object.freeze({ scope: 'local-admin', id: 'local-admin' });
      const authorization = createNativeAuthorization({ locations, manifest: artifacts.manifest, getRequestPrincipal: () => principal,
        captureLocalAuthorization: original => original === principal ? () => true : null,
        getMultiUserRuntime: () => ({ enabled: false, connection: { configured: false, isLocalAccessActive: () => true } }) });
      runtimeOwner = createNativeRuntimeOwner({ bundle, openCodeClient: client, admission, executionHost: host, clientDependencies: deps,
        recordDiagnostic: row => { diagnostics.push(row); return true; },
        withCredentialMutationQueue: createOpenAiOAuthCoordinator({ readAuth: () => undefined }).withAuthMutation,
        primaryRuntime: managed.primaryRuntime, taskContext: managed.taskContext, getManagedRuntime: managed.getManagedRuntime,
        authorization, environment, supervisedController: { deniedReadDirectories: ['packages','scripts','node_modules'].map(name => path.join(repositoryRoot, name)) },
        onExit: exit => observations.push({ phase: 'controller_exit', ...exit }), onBound: child => { controller = child; nativeURL = child.url; epoch++; } });
      // These checkpoints are valid only before a controller/store producer starts.
      preparedBundles.clear();
      const readyStarted = performance.now();
      controller = await runtimeOwner.start(); startupMs = performance.now() - readyStarted;
      assert.equal(controller.bound.catalog.asserted, true);
      version = (await client.health.runtimeInfo()).version; assert.equal(version, '2.0.20');
      pluginHash = performanceSha256(artifacts.manifest.inputs.reviewedPlugins);
    }
    // Fixture preparation is outside all scenario measurement spans.
    const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
    const execute = promisify(execFile);
    await execute('/usr/bin/git', ['init', '--quiet', '--initial-branch=main'], { cwd: directory, env: environment });
    await fs.mkdir(path.join(directory, 'files'), { recursive: true });
    for (let offset = 0; offset < fileCount; offset += 64) await Promise.all(Array.from({ length: Math.min(64, fileCount - offset) }, (_, index) =>
      fs.writeFile(path.join(directory, 'files', `fixture-${String(offset + index).padStart(5,'0')}.txt`), `fixture ${offset + index}\n`)));
    await execute('/usr/bin/git', ['add','--','files'], { cwd: directory, env: environment });
    await execute('/usr/bin/git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','--quiet','-m','performance fixture'], { cwd: directory, env: environment });
    const agents = await client.catalog.agents({ directory });
    const observedRole=agents.find(agent=>agent.name==='benchmark');
    assert.ok(observedRole,'Actual benchmark role was not registered');
    assert.equal(observedRole.prompt,performanceRole.prompt,'Actual runtime role prompt differs');
    assert.equal(observedRole.mode,performanceRole.mode);
    assert.equal(observedRole.description,performanceRole.description);
    assert.deepEqual(observedRole.model,{providerID:'devryan-smoke',modelID:'smoke-write'});
    const catalog = await client.catalog.providers({ directory });
    modelLimits = catalog.providers.find(row => row.id === 'devryan-smoke')?.models?.['smoke-write']?.limit;
    assert.deepEqual(modelLimits, performanceModelLimits, 'Actual local benchmark model limits differ');
    const model = { providerID:'devryan-smoke', modelID:'smoke-write' };
    const createSession = async title => {
      const session = await client.sessions.create({ title, agent:'benchmark', model, variant:'default' }, { directory });
      await managed.admitPrimary(session.id);
      return session.id;
    };
    const messages = async sessionID => {
      const value = await client.sessions.messages(sessionID, {}, { directory });
      return Array.isArray(value) ? value : value.records;
    };
    const streamAbort = new AbortController();
    const stream = await fetch(client.events.url({ directory }), { headers:await deps.getAuthHeaders(), signal:streamAbort.signal });
    assert.ok(stream.ok && stream.body, 'Actual native SSE unavailable');
    const eventCounts = {}, eventHash = createHash('sha256'), terminalObserver = createPerformanceTerminalObserver({ generation, directory });
    let eventBytes=0, eventBlocks=0, streamFailure;
    const streamWork = (async () => {
      const decoder = new TextDecoder(); let pending='';
      for await (const bytes of stream.body) {
        eventHash.update(bytes); eventBytes += bytes.length; pending += decoder.decode(bytes,{stream:true});
        assert.ok(pending.length < 4*1024*1024, 'Native SSE block exceeded fixture bound');
        let end; while ((end=pending.indexOf('\n\n')) >= 0) {
          const block=pending.slice(0,end); pending=pending.slice(end+2);
          const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          const event=JSON.parse(data), type=event.type ?? event.payload?.type ?? 'unknown';
          eventCounts[type]=(eventCounts[type]??0)+1; eventBlocks++;
          const terminal = terminalObserver.observe(event, performance.now());
          if (terminal) observations.push({ phase: 'canonical_terminal_arrival', ...terminal });
          if (['session.execution.failed','session.step.failed','session.tool.failed'].includes(type)) {
            const payload=(event.payload ?? event).data;
            observations.push({phase:'native-failure',type,sessionID:payload?.sessionID,
              error:{type:payload?.error?.type,message:String(payload?.error?.message ?? 'Native execution failed').slice(0,512)}});
          }
        }
      }
    })().catch(error => { if (!streamAbort.signal.aborted) streamFailure=error; });
    stopEvents = async () => { streamAbort.abort(); await streamWork; if (streamFailure) throw streamFailure; };
    const streamEvidence = () => { if (streamFailure) throw streamFailure; return {bytes:eventBytes,blocks:eventBlocks,types:{...eventCounts},sha256:eventHash.copy().digest('hex')}; };
    const check = () => {
      if (writerStartObserverFailed) throw Object.assign(new Error('writer_start_observer_failed'), { code: 'writer_start_observer_failed' });
      provider.check(); streamEvidence();
      assert.equal(eventCounts['session.compaction.started'] ?? eventCounts['session.compacted'] ?? 0, 0,
        'Local full-history benchmark unexpectedly compacted; use the separate compaction qualification');
      if (controller) assert.equal(controller.hasExited(),false,'Native controller exited during measurement');
    };
    const invoke = async ({ sessionID, id, calls = [], text = `completed ${id}`, deltas = 32, noReply = false }) => {
      check();
      const turn = noReply ? { marker:`[devryan-performance:${id}]`, complete:() => ({ id, observedTools:[], providerRequests:[] }) }
        : responder.register({ id, calls, text, deltas });
      const input = { messageID:createV2MessageId(), variant:'default', agent:'benchmark', model,
        parts:[{ type:'text', text:turn.marker }], ...(noReply ? { noReply:true } : {}) };
      const wall = performance.now();
      const observationStart = observations.length;
      await client.prompts.prompt(sessionID, input, { directory, origin:'native_performance', timeoutMs:120_000 });
      if (noReply) return { id, kind:'history-seed' };
      const deadline = Date.now() + 120_000;
      let transcript, final;
      for (;;) {
        check();
        const failed=observations.slice(observationStart).find(row=>row.phase==='native-failure'&&row.sessionID===sessionID);
        if(failed)throw Object.assign(new Error(failed.error.message),{code:'benchmark_native_execution_failed'});
        transcript = await messages(sessionID);
        final = transcript.find(row => row.info?.role === 'assistant' && Number.isFinite(row.info.time?.completed)
          && row.parts?.some(part => part.type === 'text' && part.text === text));
        if (final) {
          assert.equal(final.info.providerID,model.providerID);assert.equal(final.info.modelID,model.modelID);
          assert.equal(final.info.agent,'benchmark');assert.equal(final.info.variant,'default');
          break;
        }
        assert.ok(Date.now() < deadline, `Canonical terminal missing ${id}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const providerProof = turn.complete(), toolProofs = [];
      for (const expected of calls) {
        const record = transcript.find(row => row.parts?.some(part => part.type === 'tool' && part.callID === expected.id));
        const tool = record?.parts.find(part => part.type === 'tool' && part.callID === expected.id);
        assert.equal(tool?.state.status, 'completed', `Actual tool failed ${expected.id}`);
        let ledger;
        if (expected.name === 'write') {
          const lease = await host.runtime.leaseForCall({ directory, sessionID, callID:expected.id });
          assert.equal(lease?.state,'published'); assert.equal(lease.executionKind,'process');
          assert.equal(lease.scope.sessionID,sessionID); assert.equal(lease.scope.callID,expected.id);
          assert.equal(lease.scope.messageID,record.info.id);
          const receipt = await readSessionExecutionReceipt(lease);
          assert.equal(receipt?.terminated,true); assert.equal(receipt?.confined,true);
          assert.ok(lease.result?.operationID);
          const filePath=expected.input.filePath??path.resolve(directory,expected.input.path);
          assert.equal(await fs.readFile(filePath,'utf8'),expected.input.content,'Published actual writer bytes differ');
          const launches=[...nativeWriterHandles.values()].filter(scope=>scope.directory===directory && scope.sessionID===sessionID
              && scope.messageID===record.info.id && scope.callID===expected.id).flatMap(scope=>[...scope.pids].map(pid=>({pid,
                receiptToken:lease.token,launcher:writerProcessLauncher,viewDirectory:lease.viewDirectory,
                receiptPath:path.join(path.dirname(lease.viewDirectory),'termination.json')})));
          if(launches.length===1) writerDescriptors.set(lease.token,launches[0]);
          ledger = { token:lease.token, result:lease.result, receipt };
        }
        toolProofs.push({ callID:expected.id, messageID:record.info.id, state:tool.state, ledger });
      }
      check();
      const completionObservedAtMs = performance.now();
      const terminalTiming = terminalObserver.join({ sessionID, assistantMessageID: final.info.id,
        submissionAtMs: wall, completionObservedAtMs });
      return { id, kind:'canonical-terminal', sessionID, messageID:final.info.id, parentID:final.info.parentID,
        completedAt:final.info.time.completed, durationMs:completionObservedAtMs-wall, terminalTiming, providerProof, toolProofs };
    };
    return { root, generation, directory, model, modelLimits, configuration, version, artifactSha256, pluginHash, eventReconcileIntervalMs,
      startupMs, preparationMs:performance.now()-started-startupMs, streamEvidence, pid:controller.pid, observations, diagnostics,
      writerProcessLauncher, subscribeWriterStarts, receiptProcessDescriptors:()=>[...writerDescriptors.values()], createSession, invoke, check, cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error,cleanupError], 'Performance fixture startup and cleanup failed'); }
    throw error;
  }
}
