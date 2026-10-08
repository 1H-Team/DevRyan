import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSessionExecutionHost } from '../packages/web/server/lib/opencode/session-execution-host.js';
import { createNativeRevertConversation } from '../packages/web/server/lib/opencode/session-revert-coordinator.js';
import { createOpenCodeClient } from '../packages/web/server/lib/opencode/opencode-client/index.js';
import { createOpenCodeAdmission, createV2MessageId } from '../packages/web/server/lib/opencode/v2/admission.js';
import { resolveSqliteDriver } from '../packages/web/server/lib/opencode/db-maintenance-core.js';
import { createRuntimeBundleStore } from '../packages/web/server/lib/opencode/runtime-host/runtime-bundle.js';
import { verifyNativeCloneCompatibility } from '../packages/web/server/lib/opencode/runtime-host/native-bundle-compatibility.js';
import { resumeRuntimeBundle } from '../packages/web/server/lib/opencode/runtime-host/runtime-bundle-resume.js';
import { readRollbackIntentSync, rollbackIntentPath, assertRollbackPhysicalExit } from '../packages/web/server/lib/opencode/runtime-host/bundle-rollback-intent.js';
import { createRuntimeBundleCheckpoint } from '../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js';
import { runNativeMigrationProcess } from '../packages/web/server/lib/opencode/runtime-host/native-migration-process.js';
import { verifyNativeRuntimeArtifacts } from '../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { createNativeAuthorization } from '../packages/web/server/lib/opencode/runtime-host/native-authorization.js';
import { createOpenAiOAuthCoordinator } from '../packages/web/server/lib/opencode/openai-oauth-coordinator.js';
import { loadNativeRuntimeBundle, createNativeRuntimeOwner } from '../packages/web/server/lib/opencode/runtime-host/native-runtime-owner.js';
import { createNativeConfigurationSnapshotResolver } from '../packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js';
import { createQaHostLaunchEnvironment } from './qa/launch-environment.mjs';
import { createNativeManagedFixture } from './opencode-v2-native/managed-fixture.mjs';
import { createHttpProvider, createHttpProviderConfiguration } from './opencode-v2-native/http-provider.mjs';
import { createEmptyRuntimeFixture, assertMigratedFixture, fixtureSha256 } from './opencode-v2-native/migration-fixture.mjs';
import { repositoryRoot, captureNativeAcceptanceSource, DEFAULT_RG, RG_SHA256 } from './opencode-v2-native/artifacts.mjs';
import { toolTurn, assertWriterOutcome } from './opencode-v2-native/assertions.mjs';
import { waitFor } from './opencode-v2-native/process-lanes.mjs';
import { runCompiledAssetAcceptance } from './opencode-v2-native/compiled-process.mjs';
import { runTrackedCompiledReplacement } from './opencode-v2-native/package-restart-lane.mjs';
import { runCompiledTodoReplacement } from './opencode-v2-native/package-todo-lane.mjs';
import { runCompiledRecoveredInputs } from './opencode-v2-native/package-recovered-input-lane.mjs';
import { capturePackageFailureEvents } from './opencode-v2-native/package-failure-events.mjs';
import { runPortableArtifactTampering, runCompiledFormatter, verifyPackageBuildInputs } from './opencode-v2-native/package-lanes.mjs';
import { runCompiledMigrationReplay } from './opencode-v2-native/migration-lanes.mjs';
import { snapshotOwnedTree, runSelectedNativeLifecycle } from './opencode-v2-native/package-rollback-lane.mjs';
import { reviewedCommandConfiguration, runCompiledPromptLanes, runCompiledWorkspaceRevert } from './opencode-v2-native/package-prompt-lanes.mjs';
import { prepareCompiledParentDeathProbe, runCompiledParentDeath } from './opencode-v2-native/package-parent-death.mjs';
import {runCompiledDiagnostics} from './opencode-v2-native/package-diagnostics-lane.mjs';
import {createReviewedSetupSession,reviewedSetupRegistrations,attachReviewedSetup,assertReviewedSetupBoot,runReviewedSetupCommands} from './opencode-v2-native/reviewed-setup.mjs';
import {preparePackageSkillData,runCompiledSkillChecks} from './opencode-v2-native/package-skill-lane.mjs';
import { createCompiledBrowserLane } from './opencode-v2-native/package-browser-lane.mjs';
import { runCompiledDocuments } from './opencode-v2-native/package-document-lane.mjs';
import { compiledCouncilMembers, runCompiledCouncil } from './opencode-v2-native/package-council-lane.mjs';
import { createCompiledSlimWebBridge, runCompiledSlimInterview } from './opencode-v2-native/package-slim-lane.mjs';
import { createCompiledMcpLane } from './opencode-v2-native/package-mcp-lane.mjs';
import { runCompiledSlimTools } from './opencode-v2-native/package-slim-tools-lane.mjs';
import { createCompiledImageLane } from './opencode-v2-native/package-image-lane.mjs';
import { readNativeRemovalRows, assertNativeRemovalAbsent, assertCompletedRemoval } from './opencode-v2-native/removal-lanes.mjs';
import { assertPackagePreflightOptions, assertCompiledCompositionCatalogs, packagePreflightResult } from './opencode-v2-native/package-preflight.mjs';
import { runCompiledManagedIntervalArm } from './opencode-v2-native/package-managed-interval-lane.mjs';
import { runCompiledIntervalCorrectness, validateEventReconcileInterval, intervalCorrectnessArmTimeoutMs } from './opencode-v2-native/package-interval-correctness.mjs';
import { runCompiledHumanQueue } from './opencode-v2-native/package-human-queue-lane.mjs';
import { createCompiledBundleUpgradeLane, snapshotClosedBundleSource, snapshotRetainedBundleWork } from './opencode-v2-native/package-bundle-upgrade-lane.mjs';
import { runCompiledClaudeCredentialBridge } from './opencode-v2-native/compiled-claude-credentials.mjs';
import { runCompiledHelperIsolation } from './opencode-v2-native/package-helper-isolation-lane.mjs';
import { createCompiledHelperAgentFixture } from './opencode-v2-native/package-helper-agent-fixture.mjs';
import { createFixtureJournal } from './opencode-v2-native/fixture-journal.mjs';
import { gradeJournalRoot, compiledDurableJournalCase } from './opencode-v2-native/journal-evidence.mjs';
import { runCompiledSeededCredentialBoot } from './opencode-v2-native/package-seeded-credential-lane.mjs';
import { createRunRoot } from './qa/run-root.mjs';

const privateEnvironment = (globals, inherited) => createQaHostLaunchEnvironment({ ...inherited,
  HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state,
  XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp, TMP: globals.tmp, TEMP: globals.tmp });
const errorEvidence = error => ({ name: error.name, code: error.code, message: error.message,
  ...(error.protocolEvidence ? { protocolEvidence: error.protocolEvidence } : {}),
  ...(error.missingCatalog ? { missingCatalog: error.missingCatalog } : {}),
  ...(error.errors ? { causes: Array.from(error.errors, errorEvidence) } : {}) });

/** Qualified production binaries and real web owners; model replies alone are fixture data. */
export async function runNativePackageAcceptance({ artifactRoot = path.join(repositoryRoot, '.cache/v2-validation/native-artifact'), baselineArtifactRoot, diagnostic = false, reviewedSetup = false, browser = false, preflight = false, skillDataRoot, onParentDeathReady, managedInterval, eventReconcileIntervalMs, managedCorrectness = false } = {}) {
  validateEventReconcileInterval(eventReconcileIntervalMs);
  assert.equal(typeof managedCorrectness, 'boolean');
  if (managedCorrectness) assert.ok(!managedInterval && !reviewedSetup && !browser && !preflight && !skillDataRoot && !onParentDeathReady,
    'Managed interval correctness is a separate compiled qualification');
  if (managedInterval && eventReconcileIntervalMs !== undefined) assert.equal(eventReconcileIntervalMs, managedInterval.intervalMs,
    'Conflicting managed reconciliation intervals');
  assertPackagePreflightOptions({ preflight, reviewedSetup, onParentDeathReady });
  if (managedInterval) {
    assert.equal(diagnostic, true, 'Managed interval arms are diagnostic only');
    assert.ok([750, 1500].includes(managedInterval.intervalMs));
    assert.match(managedInterval.caseID, /^interval-[a-f0-9-]+$/);
    assert.ok(!reviewedSetup && !browser && !preflight && !skillDataRoot && !onParentDeathReady,
      'Managed interval diagnostic cannot replace another package qualification');
  }
  const cache = path.join(repositoryRoot, '.cache/v2-validation'); await fs.mkdir(cache, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(cache, 'package-')));
  const run = createRunRoot({ dir: root, owner: 'scripts/verify-opencode-v2-package.mjs',
    extraPayloads: ['bundles', 'negative', 'legacy', 'relocated', 'asset-supervision', 'denied-read-control'] });
  const cases = [], observations = [], diagnostics = [], cleanupFailures = [];
  const source = await captureNativeAcceptanceSource();
  const runnerSha256 = fixtureSha256(await fs.readFile(fileURLToPath(import.meta.url)));
  let provider, runtimeOwner, host, managed, fixture, result, browserLane, slimWeb, mcpLane, imageLane, failureEvents, journal;
  try {
    assert.equal(process.env.DEVRYAN_RUNTIME_BUNDLE_ROOT, undefined, 'Package QA requires an isolated launch environment');
    if (browser) assert.equal(reviewedSetup, true, 'Compiled browser qualification requires the active reviewed setup');
    artifactRoot = await fs.realpath(artifactRoot);
    assert.ok(artifactRoot.startsWith(repositoryRoot + path.sep), 'Artifacts must remain repository-owned');
    const manifestPath = path.join(artifactRoot, 'native-bundle.json');
    const manifestSha256 = fixtureSha256(await fs.readFile(manifestPath));
    const artifacts = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256,
      launcher: path.join(artifactRoot, 'DevRyan-execution-darwin-arm64') });
    let baselineArtifacts = artifacts, baselineManifestPath = manifestPath, baselineManifestSha256 = manifestSha256;
    if (baselineArtifactRoot) {
      baselineArtifactRoot = await fs.realpath(baselineArtifactRoot);
      assert.ok(baselineArtifactRoot.startsWith(repositoryRoot + path.sep), 'Baseline artifacts must remain repository-owned');
      baselineManifestPath = path.join(baselineArtifactRoot, 'native-bundle.json');
      baselineManifestSha256 = fixtureSha256(await fs.readFile(baselineManifestPath));
      baselineArtifacts = await verifyNativeRuntimeArtifacts({ manifestPath: baselineManifestPath, manifestSha256: baselineManifestSha256,
        launcher: path.join(baselineArtifactRoot, 'DevRyan-execution-darwin-arm64') });
    }
    observations.push({ phase: 'qualified_release_pair', baselineVersion: baselineArtifacts.manifest.opencodeVersion,
      baselineManifestSha256, candidateVersion: artifacts.manifest.opencodeVersion, candidateManifestSha256: manifestSha256 });
    assert.ok(Array.isArray(artifacts.manifest.inputs.resolvedPackages));
    assert.equal(artifacts.manifest.inputs.sourceFiles.some(row => /scripts\/opencode-v2-native\/(simulation|fixture-host)\./.test(row.path)), false);
    cases.push({ id: 'compiled-production-artifacts', status: 'passed', buildId: artifacts.manifest.buildId, manifestSha256,
      optionalSimulationLibraryLinked: artifacts.manifest.inputs.resolvedPackages.some(row => row.name === '@opencode/simulation'),
      simulationEnabled: false });
    cases.push(await verifyPackageBuildInputs({ manifest: artifacts.manifest }));
    if (!preflight && !managedInterval && !managedCorrectness) {
      cases.push(await runPortableArtifactTampering({ artifacts, root }));
      cases.push(await runCompiledAssetAcceptance({ artifacts, root }));
    }
    fixture = await createEmptyRuntimeFixture({ root });
    let skillData;
    if(skillDataRoot){
      assert.equal(reviewedSetup,true,'Personal skill qualification requires the active reviewed setup');
      skillDataRoot=await fs.realpath(skillDataRoot);assert.ok(skillDataRoot.startsWith(repositoryRoot+path.sep));
      skillData=await preparePackageSkillData({dataRoot:skillDataRoot,sourceLaunch:fixture.sourceLaunch});
    }
    provider = await createHttpProvider({ responder: () => { throw new Error('Unsolicited packaged model request'); },
      ...(managedCorrectness ? { allowStreaming: true, timeoutMs: intervalCorrectnessArmTimeoutMs } : {}),
      onRequest: row => observations.push({ phase: 'http_provider_request', ...row }) });
    if (reviewedSetup) mcpLane = await createCompiledMcpLane();
    const configuration = createHttpProviderConfiguration(provider.baseURL);
    if (!managedInterval && !managedCorrectness) {
      const helperFixture = await createCompiledHelperAgentFixture({ root });
      Object.assign(configuration.agents, helperFixture.agents);
      observations.push({ phase: 'compiled_helper_agent_configuration', ...helperFixture.evidence });
    }
    if (managedCorrectness) {
      configuration.agents.oracle = { mode: 'subagent', model: 'devryan-smoke/smoke-write' };
    }
    configuration.commands = reviewedCommandConfiguration;
    const locations = fixture.projectMap.map(row => ({ directory: row.targetDirectory, readRoots: [row.targetDirectory],
      protectedRoots: [fixture.sourceLaunch.global.home, fixture.sourceLaunch.webDataDirectory] }));
    const catalogRequirements = { agents: ['orchestrator', 'fixer'], tools: ['read', 'write', 'edit', 'patch', 'shell', 'devryan_task'],
      plugins: ['devryan.managed-task'], models: ['smoke-write', 'gpt-5-native-smoke'].map(id => ({ providerID: 'devryan-smoke', id })) };
    if (managedCorrectness) catalogRequirements.agents.push('oracle');
    const reviewedNativeConfigPath = path.join(root, 'reviewed-native.json');
    const reviewedPluginManifestPath = path.join(root, 'reviewed-plugins.json');
    await fs.writeFile(reviewedNativeConfigPath, JSON.stringify({ schema: 1, configuration, locations, catalogRequirements }) + '\n');
    await fs.writeFile(reviewedPluginManifestPath, JSON.stringify({ schema: 1, plugins: reviewedSetup ? reviewedSetupRegistrations(artifacts.manifest.inputs.reviewedPlugins,{browser}) : artifacts.manifest.inputs.reviewedPlugins }) + '\n');
    const launchArtifacts = { controllerBinary: artifacts.controller, writerBinary: artifacts.writer, artifactManifestPath: manifestPath,
      artifactManifestSha256: manifestSha256, reviewedNativeConfigPath, reviewedPluginManifestPath };
    const baselineLaunchArtifacts = { ...launchArtifacts, controllerBinary: baselineArtifacts.controller, writerBinary: baselineArtifacts.writer,
      artifactManifestPath: baselineManifestPath, artifactManifestSha256: baselineManifestSha256 };
    const sourceLaunch = { ...fixture.sourceLaunch, global: { home: fixture.sourceLaunch.global.home } };
    let nativeURL, epoch = 0, descriptor, currentController, baselineSnapshot;
    const nativeTransport = { fetch: globalThis.fetch };
    const intervalReads = { active: 0, history: 0, total: 0 };
    const deps = { getRuntime: () => ({ generation: 2, baseUrl: nativeURL, version: '2.0.24', epoch }),
      fetchImpl: (url, input) => {
        if (managedInterval) {
          intervalReads.total++;
          const route = new URL(url).pathname;
          if (!input?.method || input.method === 'GET') {
            if (route === '/api/session/active') intervalReads.active++;
            if (/^\/api\/session\/[^/]+\/message$/.test(route)) intervalReads.history++;
          }
        }
        return nativeTransport.fetch(url, input);
      },
      getAuthHeaders: () => runtimeOwner?.getAuthHeaders() ?? {},
      removeNativeSession: (sessionID, options) => runtimeOwner.removeSession(sessionID, options),
      withNativeWebOperation: (spec, action) => runtimeOwner.nativeOwner.withWebOperation(spec, action),
      recordDiagnostic: row => { diagnostics.push(row); journal?.clientDiagnostic(row); } };
    const admission = createOpenCodeAdmission(deps, { beforePromptDispatch: (receipt, context) => managed.admitNativePrompt(receipt, context),
      onPromptDispatchFailure: receipt => managed.markNativePromptUncertain(receipt), nativeOwner: {
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
    const checkpointOwners = new Map(), settledCheckpoints = new Map();
    const controlRoot = path.join(root, 'bundles');
    const executeMigration = request => {
      const selected = request.bundleID === 'baseline' ? baselineArtifacts : artifacts;
      const selectedManifestPath = request.bundleID === 'baseline' ? baselineManifestPath : manifestPath;
      const selectedManifestSha256 = request.bundleID === 'baseline' ? baselineManifestSha256 : manifestSha256;
      return runNativeMigrationProcess({ binary: selected.controller, request, cwd: root,
      environment: privateEnvironment(Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp', 'bin', 'log', 'repos']
        .map(key => [key, path.join(request.isolatedRoot, key)])), fixture.environment),
      beforeSpawn: () => verifyNativeRuntimeArtifacts({ manifestPath: selectedManifestPath, manifestSha256: selectedManifestSha256, launcher: selected.launcher }) });
    };

    let loseImportAck = true, actualImports = 0;
    const upgradeLane = createCompiledBundleUpgradeLane({ observations });
    const withQuiescedSource = async (input, action) => {
      const saved = input.kind === 'legacy' ? { generation: 1, launch: input.launch } : await checkpointOwners.get(input.bundleID);
      assert.ok(saved, 'Missing owned source checkpoint descriptor');
      const launch = saved.launch;
      if (input.kind === 'bundle' && settledCheckpoints.has(input.bundleID)) {
        const evidence = settledCheckpoints.get(input.bundleID);
        const assertHeld = async () => {
          assert.equal(evidence.actualExitConfirmed, true);
          for (const pid of evidence.controllerPIDs) {
            assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'Settled baseline controller restarted');
          }
        };
        await assertHeld();
        return action(evidence.quiescence, { assertHeld });
      }
      const ownerID = input.kind === 'legacy' ? 'owned-never-started-source' : input.bundleID;
      if (input.kind === 'bundle' && input.bundleID === descriptor?.bundleID && currentController) {
        const checkpoint = createRuntimeBundleCheckpoint({ ownerID, generation: 2, launch,
          closeAdmission: () => { journal.beginDrain(); return runtimeOwner.closeAdmissionForCheckpoint(); }, getController: () => currentController,
          assertAdmissionClosed: () => runtimeOwner.assertCheckpointAdmissionClosed(),
          stopProducers: () => managed.close(), beforeControllerStop: () => runtimeOwner.drainCredentialOwners(),
          afterExit: () => runtimeOwner.close(), executionHost: host,
          drainStores: async () => { await host.runtime.drain(); await journal.drain(); } });
        return checkpoint(input, action);
      }
      const sourceHost = createSessionExecutionHost({ dataDirectory: launch.webDataDirectory, openCodeClient: client,
        getLauncher: () => artifacts.launcher, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders });
      // This fixture was created here and never had a controller or producers.
      // The real constructor-owned checkpoint drains its existing store owners.
      const checkpoint = createRuntimeBundleCheckpoint({ ownerID, generation: saved.generation, launch, neverStarted: true,
        closeAdmission: async () => sourceHost.runtime.drain(), getController: () => null,
        stopProducers: async () => { assert.deepEqual(await fs.readdir(launch.webDataDirectory), []); },
        executionHost: sourceHost, drainStores: () => sourceHost.runtime.drain() });
      return checkpoint(input, action);
    };
    const store = createRuntimeBundleStore({ controlRoot, withQuiescedSource, runMigration: async request => {
      const receipt = await runCompiledMigrationReplay({ request, run: executeMigration }); actualImports++;
      if (loseImportAck) { loseImportAck = false; throw Object.assign(new Error('fixture_import_ack_lost'), { code: 'fixture_import_ack_lost' }); }
      return receipt;
    }, verifyV2Compatibility: async ({ source, artifacts: target }) => {
      const sourceArtifact = await verifyNativeRuntimeArtifacts({ manifestPath: source.launch.artifactManifestPath,
        manifestSha256: source.launch.artifactManifestSha256, launcher: path.join(path.dirname(source.launch.artifactManifestPath), 'DevRyan-execution-darwin-arm64') });
      const targetArtifact = await verifyNativeRuntimeArtifacts({ manifestPath: target.artifactManifestPath,
        manifestSha256: target.artifactManifestSha256, launcher: path.join(path.dirname(target.artifactManifestPath), 'DevRyan-execution-darwin-arm64') });
      verifyNativeCloneCompatibility({ left: sourceArtifact.manifest, right: targetArtifact.manifest, databasePath: source.launch.opencodeDatabasePath });
      return { status: 'compatible', binding: { protocol: 'devryan-v2-clone/1', sourceBundleID: source.bundleID,
        sourceManifestSha256: source.launch.artifactManifestSha256, targetManifestSha256: target.artifactManifestSha256 } };
    }, captureCredentials: upgradeLane.captureCredentials, reconcileRollback: async input => {
      assert.equal(currentController.hasExited(), true, 'Rollback did not stop the actual compiled controller');
      for (const location of locations) assert.deepEqual(await host.runtime.activeLeases({ directory: location.directory }), []);
      assert.equal(fixtureSha256(await fs.readFile(fixture.sourceLaunch.opencodeDatabasePath)), fixture.expected.databaseSha256);
      for (const mapping of input.candidate.projectMap) {
        assert.equal(mapping.mode, 'synthetic-copy'); assert.notEqual(mapping.sourceDirectory, mapping.targetDirectory);
        assert.deepEqual(await snapshotOwnedTree(mapping.sourceDirectory), originalProjectSnapshots.get(mapping.sourceDirectory));
      }
      return upgradeLane.reconcileRollback(input);
    } });
    const originalProjectSnapshots = new Map(await Promise.all(fixture.projectMap.map(async row => [row.sourceDirectory, await snapshotOwnedTree(row.sourceDirectory)])));
    const baselineInput = { bundleID: 'baseline', generation: 2, source: { kind: 'legacy', launch: sourceLaunch },
      projectMap: fixture.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts: baselineLaunchArtifacts };
    await assert.rejects(store.prepare(baselineInput), error => error.code === 'fixture_import_ack_lost');
    const draft = path.join(controlRoot, 'bundles/baseline');
    assert.equal((await fs.stat(path.join(draft, 'sources/migration.json'))).isFile(), true);
    await assert.rejects(fs.stat(path.join(draft, 'prepared.json')), error => error.code === 'ENOENT');
    const baseline = await store.prepare(baselineInput); assert.equal(actualImports, 2);
    cases.push({ id: 'compiled-empty-initialization-lost-ack-resume', status: 'passed', source: 'actual-import-receipt-retained-and-exact-preparation-retry' });
    cases.push({ id: 'compiled-empty-initialization-idempotent-replay', status: 'passed', source: 'actual-compiled-importer-same-source-and-verification-hashes' });
    cases.push({ id: 'compiled-fresh-native-initialization', status: 'passed', ...await assertMigratedFixture({ fixture, descriptor: baseline }) });
    checkpointOwners.set('baseline', Promise.resolve(baseline));
    await store.select({ bundleID: 'baseline', expectedRevision: 0 });
    // The isolated original empty initializer has no producers yet; use its
    // original checkpoint to seed synthetic credentials through the compiled SDK.
    const baselineSeedHost = createSessionExecutionHost({ dataDirectory: baseline.launch.webDataDirectory, openCodeClient: client,
      getLauncher: () => artifacts.launcher, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders });
    const baselineSeed = createRuntimeBundleCheckpoint({ ownerID: baseline.bundleID, generation: 2, launch: baseline.launch, neverStarted: true,
      closeAdmission: () => baselineSeedHost.runtime.drain(), getController: () => null, stopProducers: async () => {},
      executionHost: baselineSeedHost, drainStores: () => baselineSeedHost.runtime.drain() });
    await baselineSeed({ kind: 'bundle', bundleID: baseline.bundleID }, async (_, scope) => {
      await upgradeLane.seedBaseline(baseline, scope.assertHeld);
      if (!preflight && !managedInterval && !managedCorrectness) {
        cases.push(await upgradeLane.assertIncompatibleTarget({ descriptor: baseline, artifacts: baselineArtifacts, root, assertHeld: scope.assertHeld }));
      }
    });
    const baselineMarker = 'Fresh native v2 rollback baseline';
    let baselineRequests = 0;
    await provider.setResponder(request=>{
      baselineRequests++;
      assert.equal(baselineRequests,1,'Fresh baseline must infer exactly once');
      assert.ok(request.body.messages.some(row=>row.role==='user' && JSON.stringify(row.content).includes(baselineMarker)));
      return {items:[{type:'textDelta',text:'Fresh native baseline complete'}],reason:'stop'};
    });
    const baselineEvidence = await runSelectedNativeLifecycle({controlRoot,descriptor:baseline,configuration,fixture,
      seedInput:baselineMarker,logFile:path.join(root,'native-baseline-lifecycle.log')});
    assert.equal(baselineRequests,1);
    cases.push({...baselineEvidence,id:'fresh-v2-baseline-checkpoint'});
    settledCheckpoints.set('baseline',baselineEvidence);
    baselineSnapshot = await snapshotClosedBundleSource(baseline);
    await provider.setResponder(()=>{throw new Error('Unsolicited packaged model request');});
    const candidateInput = { bundleID: 'candidate', generation: 2, source: { kind: 'bundle', bundleID: baseline.bundleID },
      projectMap: baseline.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts };
    const importsBeforeClone = actualImports;
    descriptor = await store.prepare(candidateInput);
    assert.equal(actualImports, importsBeforeClone, 'A→B clone must not rerun the legacy importer');
    const afterCloneSnapshot=await snapshotClosedBundleSource(baseline);
    assert.deepEqual(afterCloneSnapshot, baselineSnapshot, 'Clone changed its closed durable source or logical history');
    observations.push({phase:'closed_source_clone_invariance',historySha256:fixtureSha256(JSON.stringify(baselineSnapshot.history)),
      sessions:baselineSnapshot.history.sessions.length,messages:baselineSnapshot.history.messages.length,transientExclusion:'opencode/opencode.db-shm'});
    checkpointOwners.set('candidate', Promise.resolve(descriptor));
    cases.push(await upgradeLane.assertClone({ baseline, candidate: descriptor }));
    await assert.rejects(store.select({ bundleID: 'candidate', expectedRevision: 0 }), error => error.code === 'bundle_selection_revision_conflict');
    assert.equal((await store.readSelected()).descriptor.bundleID, 'baseline');
    await store.select({ bundleID: 'candidate', expectedRevision: 1 });
    // Native projection is private/offline and cannot open ordinary admission.
    const candidateSeedHost = createSessionExecutionHost({ dataDirectory: descriptor.launch.webDataDirectory, openCodeClient: client,
      getLauncher: () => artifacts.launcher, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders });
    const candidateSeed = createRuntimeBundleCheckpoint({ ownerID: descriptor.bundleID, generation: 2, launch: descriptor.launch, neverStarted: true,
      closeAdmission: () => candidateSeedHost.runtime.drain(), getController: () => null, stopProducers: async () => {},
      executionHost: candidateSeedHost, drainStores: () => candidateSeedHost.runtime.drain() });
    await candidateSeed({ kind: 'bundle', bundleID: descriptor.bundleID }, (_, scope) => upgradeLane.rotateCandidate(descriptor, scope.assertHeld));
    const { readRuntimeBundleBinding } = await import('../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js');
    const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot });
    const bundle = await loadNativeRuntimeBundle({ binding, launcher: artifacts.launcher });
    if(reviewedSetup)attachReviewedSetup({bundle,binding,registrationBytes:await fs.readFile(descriptor.launch.reviewedPluginManifestPath),configuration,skillData,councilMembers:compiledCouncilMembers,browser,remoteMcp:mcpLane.configuration});
    else {
      // The baseline and parent-death fixtures use their owned loopback config,
      // through the same snapshot capture as the reviewed setup.
      const { agents, commands = {}, ...legacy } = structuredClone(configuration);
      const resolve = createNativeConfigurationSnapshotResolver({ loadLocation: async () => ({
        legacy: structuredClone(legacy), agents: structuredClone(agents), commands: structuredClone(commands),
        skills: [], slim: { mergedConfig: {} }, parseMarkdown: () => { throw new Error('Unexpected baseline skill'); },
      }) });
      const expectedRegistrationDigest = fixtureSha256(await fs.readFile(descriptor.launch.reviewedPluginManifestPath));
      bundle.resolveConfiguration = revision => resolve({ binding, revision, expectedRegistrationDigest });
    }
    const globals = descriptor.launch.global;
    for (const directory of Object.values(globals)) await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(globals.tmp, 'package.json'), '{"type":"commonjs"}\n');
    const rg = path.join(globals.cache, 'opencode/bin/rg'); await fs.mkdir(path.dirname(rg), { recursive: true });
    assert.equal(fixtureSha256(await fs.readFile(DEFAULT_RG)), RG_SHA256, 'Unreviewed ripgrep artifact');
    await fs.copyFile(DEFAULT_RG, rg); await fs.chmod(rg, 0o755);
    const environment = privateEnvironment(globals, fixture.environment);
    const directory = locations[0].directory;
    const writerConfig = { formatter: false };
    // The production web journal on the selected descriptor; diagnostics stay teed into the result arrays.
    journal = await createFixtureJournal({ webDataDirectory: descriptor.launch.webDataDirectory, label: `fixture-main-${randomBytes(4).toString('hex')}` });
    host = createSessionExecutionHost({ dataDirectory: descriptor.launch.webDataDirectory, openCodeClient: client,
      getLauncher: () => artifacts.launcher, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders,
      onDiagnostic: row => { diagnostics.push(row); journal.sessionExecution(row); }, nativeExecution: { writerConfig, isReady: () => Boolean(nativeURL),
        conversation:createNativeRevertConversation({openCodeClient:client,clientDeps:deps,isReady:()=>runtimeOwner?.isReady()===true,
          admissionOwner:{withRevertOperation:(input,action)=>runtimeOwner.nativeOwner.withRevertOperation(input,action),
            releaseTransactionHolds:input=>runtimeOwner.nativeOwner.releaseTransactionHolds(input),
            recoverTransactionHolds:input=>runtimeOwner.nativeOwner.recoverTransactionHolds(input)}}),
        locations,
        socketDirectory: null, workerBrowsers: false, helperRoots: locations.map(row => row.directory), gitCommand: '/usr/bin/git',
        deniedReadDirectories: ['packages', 'scripts', 'node_modules'].map(name => path.join(repositoryRoot, name)),
        workerCommand: artifacts.writer, workerArgs: [], workerEnvironment: environment,
        reviewedAst:artifacts.reviewedAst,
        ...Object.fromEntries([['reviewedAstOrigin','devryan.slim'],['reviewedBrowserOrigin','devryan.browser'],
          ['reviewedDocumentOrigin','devryan.document-reader'],['reviewedImagegenOrigin','opencode-gpt-imagegen']].map(([key,id])=>{
          const origin=artifacts.manifest.inputs.reviewedPlugins.find(row=>row.id===id);return [key,origin?{kind:'plugin',...origin}:undefined];
        })),
        captureContextAssets:input=>runtimeOwner.captureContextAssets(input),
        getReviewedBrowser:()=>runtimeOwner.getReviewedBrowser(),
        browserOperation:async(invocation,event,context)=>{
          const result=await runtimeOwner.browserOperation(invocation,event,context);
          if(['resolve','acquire'].includes(event.operation))observations.push({phase:'compiled_browser_operation',operation:event.operation,
            previewPresent:typeof result?.previewUrl==='string',previewLoopback:typeof result?.previewUrl==='string'&&new URL(result.previewUrl).hostname==='127.0.0.1'});
          return result;
        },
        imageGeneration:(invocation,args,context)=>runtimeOwner.imageGeneration(invocation,args,context),
        recheckPermit: input => runtimeOwner.nativeOwner.recheckExecution(input),
        stopSessions: input => runtimeOwner.stopSessions(input),
        onTermination: row => observations.push({ ...row, phase: 'termination_verified' }),
        onOutcome: row => observations.push({ ...row, phase: row.state === 'published' ? 'published' : 'discarded' }),
      } });
    const ownerDelegate = { withManagedTaskDispatch: (input, action) => runtimeOwner.nativeOwner.withManagedTaskDispatch(input, action),
      withPermit: (permit, action) => runtimeOwner.nativeOwner.withPermit(permit, action) };
    managed = createNativeManagedFixture({ client, admissionOwner: ownerDelegate, executionHost: host, directory,
      ...(eventReconcileIntervalMs !== undefined || managedInterval
        ? { eventReconcileIntervalMs: eventReconcileIntervalMs ?? managedInterval.intervalMs } : {}),
      dataDirectory: descriptor.launch.webDataDirectory, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders,
      isNativeFallbackError: error => bundle.reviewedConfiguration?.isReviewedSlimFailoverError(error) === true,
      dispatchNativeRecovery: (record, prompt) => runtimeOwner.dispatchNativeRecovery(record, prompt),
      environment, observations, diagnostics, journal, executionModel: { providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'default' } });
    // This constructor grant belongs only to this private package smoke fixture.
    // Authentication parity is established by the product authenticator tests.
    const fixturePrincipal = Object.freeze({ scope: 'local-admin', id: 'local-admin' });
    const authorization = createNativeAuthorization({ locations, manifest: artifacts.manifest,
      getRequestPrincipal: () => fixturePrincipal,
      captureLocalAuthorization: original => original === fixturePrincipal ? () => true : null,
      getMultiUserRuntime: () => ({ enabled: false, connection: { configured: false, isLocalAccessActive: () => true } }) });
    if (browser && !preflight) browserLane = await createCompiledBrowserLane({ root, client });
    // Catalog-only preflight seals the same installed browser asset without
    // starting Electron or acquiring a browser lease.
    const browserEnvironment = browser ? { DEVRYAN_AGENT_BROWSER_BIN: path.join(repositoryRoot, '.cache/browser-upgrade/current/node_modules/agent-browser/bin',
      `agent-browser-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`) } : undefined;
    if (reviewedSetup) slimWeb = await createCompiledSlimWebBridge();
    if (reviewedSetup && !preflight) {
      imageLane = await createCompiledImageLane({root,getOwnedOrigins:()=>[provider.baseURL,nativeURL].filter(Boolean).map(value=>new URL(value).origin)});
      await imageLane.prepare({databasePath:descriptor.launch.opencodeDatabasePath,directory});
    }
    const startController = async () => {
    runtimeOwner = createNativeRuntimeOwner({ bundle, openCodeClient: client, admission, executionHost: host,
      clientDependencies: deps,
      recordDiagnostic: row => { diagnostics.push(row); journal.ownerDiagnostic(row); return true; },
      ...(browser ? { getManagedBrowserEnvironment: () => browserLane?.environment ?? browserEnvironment, getBrowserLeaseRuntime: () => browserLane?.runtime } : {}),
      ...(slimWeb ? { getWebBaseURL: slimWeb.getWebBaseURL, emitIntegrationEvent: slimWeb.emitIntegrationEvent } : {}),
      captureCommandPromptAdmission: async ({sessionID,directory:capturedDirectory}) => ({
        admit: (receipt,authorizeWrite) => {
          assert.equal(receipt.sessionID,sessionID);assert.equal(receipt.directory,capturedDirectory);
          return managed.admitNativePrompt(receipt,authorizeWrite);
        },
        uncertain: receipt => {
          assert.equal(receipt.sessionID,sessionID);assert.equal(receipt.directory,capturedDirectory);
          return managed.markNativePromptUncertain(receipt);
        },
      }),
      withCredentialMutationQueue: createOpenAiOAuthCoordinator({ readAuth: () => undefined }).withAuthMutation,
      primaryRuntime: managed.primaryRuntime, taskContext: managed.taskContext, getManagedRuntime: managed.getManagedRuntime, authorization,
      environment, supervisedController: { deniedReadDirectories: ['packages', 'scripts', 'node_modules'].map(name => path.join(repositoryRoot, name)) },
      onExit: exit => observations.push({ phase: 'compiled_controller_exit', ...exit }), onBound: child => { currentController = child; nativeURL = child.url; epoch++; observations.push({ phase: 'compiled_bound_catalog', catalog: child.bound.catalog, instanceID: child.instanceID }); } });
    slimWeb?.bindRuntimeOwner(runtimeOwner);
    return runtimeOwner.start();
    };
    const controller = await (imageLane ? imageLane.withCapturedTransport(startController) : startController());
    if (!preflight && !managedInterval && !managedCorrectness) {
      cases.push(...await runCompiledClaudeCredentialBridge({ artifacts, root, controller, environment, observations }));
    }
    imageLane?.captureRestarts(runtimeOwner);
    if (!managedInterval) failureEvents = await capturePackageFailureEvents({ client, getAuthHeaders: () => runtimeOwner.getAuthHeaders(), controller, observations });
    assert.equal(controller.bound.catalog.asserted, true);
    if(reviewedSetup)await assertReviewedSetupBoot({runtimeOwner,controller,client,browser,onCase:row=>cases.push(row)});
    cases.push({ id: 'compiled-ready-catalog', status: 'passed', instanceID: controller.instanceID, source: 'accepted-supervisor-source-denied-full-serve' });
    if (reviewedSetup) cases.push(await assertCompiledCompositionCatalogs({ runtimeOwner, client, readNativePlugins: async directory => {
      const response = await fetch(new URL('/api/plugin', controller.url), { headers: { ...runtimeOwner.getAuthHeaders(),
        'x-opencode-directory': encodeURIComponent(directory) }, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, 'Compiled plugin catalog unavailable');
      return response.json();
    } }));
    if (managedCorrectness) {
      cases.push(...await runCompiledIntervalCorrectness({ intervalMs: eventReconcileIntervalMs ?? 750, client, managed, provider,
        executionHost: host, directory, observations, getAuthHeaders: () => runtimeOwner.getAuthHeaders(),
        databasePath: descriptor.launch.opencodeDatabasePath, environment, nativeTransport }));
      result = { status: 'interval-correctness-passed', qualification: 'compiled-managed-adverse-interval-only',
        artifact: { buildId: artifacts.manifest.buildId, manifestSha256 }, remainingMandatoryGates: ['full-package-qualification'],
        eventReconcileIntervalMs: eventReconcileIntervalMs ?? 750 };
    } else if (managedInterval) {
      const arm = await runCompiledManagedIntervalArm({ ...managedInterval, client, managed, provider, executionHost: host,
        controller, directory, observations, getAuthHeaders: () => runtimeOwner.getAuthHeaders(),
        readCounts: () => ({ ...intervalReads }), writerProcessLauncher: artifacts.launcher });
      // Only the fixture's exact loopback provider address and private root are
      // normalized. Model/tool/plugin selections remain part of the identity.
      const configurationIdentity = { configuration, locations, catalogRequirements,
        plugins: artifacts.manifest.inputs.reviewedPlugins };
      const normalized = JSON.stringify(configurationIdentity).replaceAll(provider.baseURL, '$FIXTURE_PROVIDER')
        .replaceAll(root, '$PRIVATE_ARM');
      arm.identity = { artifactSha256: manifestSha256, sourceSha256: source.sourceDigest,
        configurationSha256: fixtureSha256(normalized) };
      cases.push({ id: 'compiled-managed-interval-arm', status: 'passed', intervalMs: managedInterval.intervalMs });
      result = { status: 'interval-diagnostic-passed', artifact: { buildId: artifacts.manifest.buildId, manifestSha256 },
        managedInterval: arm, remainingMandatoryGates: ['full-seven-workload-matrix', 'interval-missed-event-deadline-cancel-correctness'] };
    } else {
    if (!preflight) cases.push(await runCompiledHelperIsolation({ runtimeOwner, client, provider, directory }));
    const sessionInput={ title: 'Compiled native writer qualification', model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } };
    const session = reviewedSetup
      ? await createReviewedSetupSession({client,directory,input:sessionInput,admitPrimary:managed.admitPrimary})
      : await client.sessions.create(sessionInput,{directory});
    const invoke = async (scenario, options = {}) => {
      const operationDirectory = options.directory ?? directory, sessionID = options.sessionID ?? session.id;
      const foreignBefore = scenario.deniedBeforePermission ? await fs.readFile(scenario.input.path) : undefined;
      const turn = toolTurn(scenario.tool, scenario.input, scenario.id);
      await provider.setResponder(options.transformResponder ? options.transformResponder(turn.responder) : turn.responder);
      await client.prompts.prompt(sessionID, { messageID: createV2MessageId(), variant: 'default',
        ...(reviewedSetup?{agent:'orchestrator'}:{}),
        model: { providerID: 'devryan-smoke', modelID: scenario.tool === 'patch' ? 'gpt-5-native-smoke' : 'smoke-write' },
        parts: [{ type: 'text', text: turn.marker }, ...(options.parts ?? [])] }, { directory: operationDirectory, origin: 'native_acceptance', timeoutMs: 30_000 });
      if (scenario.approveExternal) {
        const requests = await waitFor(() => client.interaction.permissions.list({ directory: operationDirectory }, { sessionID }),
          rows => rows.some(row => row.sessionID === sessionID && row.tool?.callID === turn.callID), 'Cross-location read never requested its exact native external permission');
        const request = requests.find(row => row.sessionID === sessionID && row.tool?.callID === turn.callID);
        assert.equal(request.permission, 'external_directory', 'Compiled read requested a different native permission');
        await client.interaction.permissions.reply(request.id, { reply: 'once' }, { directory: operationDirectory, sessionID });
      }
      const messages = await waitFor(() => client.sessions.messages(sessionID, {}, { directory: operationDirectory }),
        page => page.records.some(row => row.parts?.some(part => part.type === 'text' && part.text === `completed ${scenario.id}`)),
        `Compiled ${scenario.id} did not reach its real HTTP continuation`, 60_000);
      const call = messages.records.flatMap(row => row.parts ?? []).find(part => part.type === 'tool' && part.callID === turn.callID);
      assert.equal(call?.state.status, scenario.expectedError ? 'error' : 'completed');
      if (scenario.expectedError) assert.match(call.state.error, scenario.expectedError);
      if (scenario.approveExternal === false) {
        const pending = await client.interaction.permissions.list({ directory: operationDirectory }, { sessionID });
        assert.equal(pending.some(request => request.sessionID === sessionID && request.tool?.callID === turn.callID), false,
          'Compiled read left an unexpected external permission request');
      }
      if (scenario.deniedBeforePermission) {
        assert.equal(reviewedSetup, true);
        assert.equal(scenario.tool, 'read');
        assert.equal(scenario.approveExternal, false);
        const db = resolveSqliteDriver().open(descriptor.launch.opencodeDatabasePath, { readonly: true });
        try {
          const rows = db.prepare("SELECT m.id,m.type,j.value FROM session_message m,json_each(m.data,'$.content') j WHERE m.session_id=? AND json_extract(j.value,'$.id')=?")
            .all(sessionID, turn.callID);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].type, 'assistant');
          const native = JSON.parse(rows[0].value);
          assert.equal(native.name, 'read');
          assert.equal(native.executed, false);
          assert.equal(native.state.status, 'error');
          assert.equal(native.state.input.path, scenario.input.path);
          assert.equal(native.state.error.message, 'native_read_root_denied');
        } finally { db.close(); }
        assert.deepEqual(await fs.readFile(scenario.input.path), foreignBefore, 'Read-root refusal changed the foreign file');
      }
      turn.complete();
      if (scenario.control) {
        const outcomes = await host.runtime.executionOutcomes({ directory: operationDirectory, sessionID, calls: [{ messageID: call.messageID, callID: turn.callID }] });
        assert.equal(outcomes.length, 1); assert.equal(outcomes[0].outcome, 'finished');
      } else if (!scenario.direct) await assertWriterOutcome({ runtime: host.runtime, directory: operationDirectory, sessionID, callID: turn.callID, observations, succeeded: true });
      cases.push({ id: scenario.id, status: 'passed', source: scenario.deniedBeforePermission ? 'compiled-reviewed-read-root-preflight-refusal'
        : scenario.expectedError ? 'compiled-native-tool-refusal' : scenario.control ? 'compiled-native-owned-control'
          : scenario.direct ? 'compiled-native-direct-read' : 'compiled-writer-real-termination-publication' });
      return call;
    };
    cases.push(...await runCompiledHumanQueue({ provider, client, managed, runtimeOwner, controller: currentController,
      nativeTransport, directory, executionHost: host, observations }));
    for (const scenario of [
      { id: 'package-read', tool: 'read', input: { path: 'seed.txt' }, direct: true },
      { id: 'package-write', tool: 'write', input: { path: 'package.txt', content: 'compiled first\n' } },
    ]) {
      await invoke(scenario);
      if(scenario.id==='package-read')cases.push(await runCompiledWorkspaceRevert({invoke,client,executionHost:host,directory,sessionID:session.id,observations}));
      if (onParentDeathReady && scenario.id === 'package-write') await onParentDeathReady(await prepareCompiledParentDeathProbe({
        root, provider, client, host, controller, descriptor, directory, sessionID: session.id, journal, inheritedJournals: [baselineEvidence.journal] }));
    }
    if (reviewedSetup) cases.push(await runCompiledCouncil({ invoke, runtime: host.runtime, client, managed, directory, runtimeOwner }));
    const secondDirectory = locations[1].directory;
    const secondSession = await client.sessions.create({ title: 'Second relocated native location', model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } }, { directory: secondDirectory });
    if (!preflight) {
      await invoke({ id: 'second-location-write', tool: 'write', input: { path: 'second-location.txt', content: 'second relocated compiled write\n' } }, { directory: secondDirectory, sessionID: secondSession.id });
      assert.equal(await fs.readFile(path.join(secondDirectory, 'second-location.txt'), 'utf8'), 'second relocated compiled write\n');
      await assert.rejects(fs.stat(path.join(directory, 'second-location.txt')), error => error.code === 'ENOENT');
      await invoke({ id: 'second-location-read-isolation', tool: 'read', direct: true, approveExternal: !reviewedSetup,
        deniedBeforePermission: reviewedSetup, expectedError: /native_read_root_denied/, input: { path: path.join(directory, 'seed.txt') } }, { directory: secondDirectory, sessionID: secondSession.id });
    }
    if (mcpLane) cases.push(await mcpLane.run({ invoke, directory, secondDirectory, secondSessionID: secondSession.id }));
    if(reviewedSetup)await runReviewedSetupCommands({provider,client,runtimeOwner,directory,onCase:row=>cases.push(row),waitFor,admitPrimary:managed.admitPrimary,artifacts});
    if(reviewedSetup)await runCompiledSlimInterview({provider,client,runtimeOwner,directory,onCase:row=>cases.push(row),waitFor,
      admitPrimary:managed.admitPrimary,bridge:slimWeb,executionHost:host,observations,databasePath:descriptor.launch.opencodeDatabasePath});
    await failureEvents.close();
    await runCompiledRecoveredInputs({ provider, client, managed, runtimeOwner, nativeTransport, executionHost: host,
      databasePath: descriptor.launch.opencodeDatabasePath, observations,
      getController: () => currentController, directory, reviewedSetup,
      onCase: row => cases.push(row), onExit: exit => observations.push({ phase: 'recovered_input_controller_exit', ...exit }) });
    if (preflight) result = packagePreflightResult({ buildId: artifacts.manifest.buildId, manifestSha256 });
    else {
      for (const scenario of [
        { id: 'package-edit', tool: 'edit', input: { path: 'package.txt', oldString: 'first', newString: 'second' } },
        { id: 'package-patch', tool: 'patch', input: { patchText: '*** Begin Patch\n*** Update File: package.txt\n@@\n-compiled second\n+compiled third\n*** End Patch' } },
      ]) await invoke(scenario);
      cases.push(await runCompiledFormatter({ directory, writerConfig, invoke }));
      cases.push(await runCompiledDiagnostics({invoke,runtime:host.runtime,directory,sessionID:session.id}));
      await runCompiledPromptLanes({ provider, client, directory, databasePath: descriptor.launch.opencodeDatabasePath, diagnostics, onCase: row => cases.push(row),
        admitPrimary: managed.admitPrimary });
      if(reviewedSetup)cases.push(...await runCompiledSlimTools({invoke,createSession:(input,options)=>admission.create(input,options),directory,runtime:host.runtime,observations,admitPrimary:managed.admitPrimary}));
      if(imageLane)cases.push(...await imageLane.run({invoke,client,directory,executionHost:host,managed,runtimeOwner,
        databasePath:descriptor.launch.opencodeDatabasePath,environment,observations,provider}));
      if(skillData)await runCompiledSkillChecks({data:skillData,runtimeOwner,launch:descriptor.launch,invoke,directory,onCase:row=>cases.push(row)});
      if (browserLane) cases.push(await browserLane.run({ invoke, directory }));
      if (reviewedSetup) cases.push(await runCompiledDocuments({ invoke, client, directory, admitPrimary: managed.admitPrimary }));
      cases.push(await runTrackedCompiledReplacement({ provider, client, managed, executionHost: host, runtimeOwner, controller: currentController, directory,
        databasePath: descriptor.launch.opencodeDatabasePath, observations, invoke }));
      cases.push(await runCompiledTodoReplacement({ provider, client, managed, runtimeOwner, controller: currentController, directory }));
      const removalChild = await client.sessions.create({ title: 'Compiled removal child', parentID: secondSession.id,
        model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } }, { directory: secondDirectory });
      const removalIDs = [secondSession.id, removalChild.id];
      const retainedSecond = await snapshotOwnedTree(secondDirectory);
      assert.equal(await client.sessions.remove(secondSession.id, { directory: secondDirectory }), true);
      assertNativeRemovalAbsent(await readNativeRemovalRows({ databasePath: descriptor.launch.opencodeDatabasePath, environment, sessions: removalIDs }));
      const removalState = await host.runtime.nativeAdmissionState({ directory: secondDirectory, sessionID: secondSession.id });
      const removalID = removalState.holds.find(hold => hold.removalID)?.removalID;
      assert.ok(removalID, 'Compiled removal lost its durable tombstone');
      assertCompletedRemoval(await host.runtime.nativeRemoval({ directory: secondDirectory, intentID: removalID }), removalIDs);
      assert.deepEqual(await snapshotOwnedTree(secondDirectory), retainedSecond, 'Compiled removal altered published project bytes');
      assert.equal((await client.sessions.get(session.id, { directory })).id, session.id, 'Compiled removal crossed locations');
      cases.push({ id: 'compiled-owned-subtree-removal', status: 'passed', sessions: removalIDs, intentID: removalID,
        source: 'actual-public-client-production-owner-compiled-native-leaf-control' });
      const interruptedRoot = await client.sessions.create({ title: 'Compiled interrupted removal',
        model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } }, { directory });
      const interruptedChild = await client.sessions.create({ title: 'Compiled lost removal acknowledgement', parentID: interruptedRoot.id,
        model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } }, { directory });
      const interruptedIDs = [interruptedRoot.id, interruptedChild.id], originalCall = currentController.call;
      let interruptedIntent;
      // Lose only the real native delete acknowledgement. The product owner
      // must retain its prior durable decision and recover it on replacement.
      currentController.call = async (...args) => {
        const result = await originalCall(...args);
        if (args[0].action === 'remove-leaf-owned' && !interruptedIntent) {
          interruptedIntent = args[0].intentID;
          throw Object.assign(new Error('fixture_compiled_delete_ack_lost'), { code: 'fixture_compiled_delete_ack_lost' });
        }
        return result;
      };
      try { await assert.rejects(client.sessions.remove(interruptedRoot.id, { directory }), error => error.code === 'fixture_compiled_delete_ack_lost'); }
      finally { currentController.call = originalCall; }
      const committedRemoval = await host.runtime.nativeRemoval({ directory, intentID: interruptedIntent });
      assert.equal(committedRemoval.state, 'committed'); assert.deepEqual(committedRemoval.removed, []);
      assert.deepEqual((await readNativeRemovalRows({ databasePath: descriptor.launch.opencodeDatabasePath, environment,
        sessions: interruptedIDs })).session_v2.map(row => row.id), [interruptedRoot.id]);
      const oldRemovalInstance = currentController.instanceID;
      const removalExit = await currentController.killForRecovery();
      assert.equal(removalExit.receipt?.terminated, true); assert.equal(removalExit.receipt?.confined, true);
      assert.equal(runtimeOwner.isReady(), false);
      const recoveredController = await runtimeOwner.start();
      assert.notEqual(recoveredController.instanceID, oldRemovalInstance); assert.equal(runtimeOwner.isReady(), true);
      assertNativeRemovalAbsent(await readNativeRemovalRows({ databasePath: descriptor.launch.opencodeDatabasePath, environment, sessions: interruptedIDs }));
      assertCompletedRemoval(await host.runtime.nativeRemoval({ directory, intentID: interruptedIntent }), interruptedIDs);
      cases.push({ id: 'compiled-removal-startup-recovery', status: 'passed', intentID: interruptedIntent, sessions: interruptedIDs,
        source: 'lost-real-leaf-ack-supervised-controller-exit-production-startup-recovery', controllerExit: removalExit });
      assert.equal(await fs.readFile(path.join(directory, 'package.txt'), 'utf8'), 'compiled third\n');
      const selected = await store.readSelected();
      // The real lost-ACK checkpoint belongs to a fresh B host. The verifier
      // first drains its own B owners, but never pretends its live PID exited.
      let expectedCredentials, retainedWork;
      await withQuiescedSource({ kind: 'bundle', bundleID: descriptor.bundleID }, async (_proof, scope) => {
        expectedCredentials = await upgradeLane.captureCredentials({ descriptor, assertHeld: scope.assertHeld });
        retainedWork = await snapshotRetainedBundleWork(descriptor);
      });
      assert.equal(currentController.hasExited(), true);
      const providerCountBeforeRollback = provider.requests.length;
      const lost = await runSelectedNativeLifecycle({ controlRoot, descriptor, configuration, fixture,
        sessionIDs: baselineEvidence.sessionIDs, logFile: path.join(root, 'native-rollback-lost-ack.log'),
        rollback: { phase: 'ack-loss', targetBundleID: baseline.bundleID, expectedRevision: selected.selection.revision } });
      assert.equal(lost.rollback.phase, 'ack-loss');
      assert.equal(lost.rollback.heldRetryRefused, true); assert.equal(lost.rollback.sameHostResumeRefused, true);
      assert.equal(lost.rollback.retention.staleBaselineRefused, true);
      const intent = readRollbackIntentSync(controlRoot);
      assert.deepEqual(intent.settlement.host, lost.hostIdentity);
      assert.equal(intent.settlement.controller.instanceID, lost.restart.replacementInstance);
      assert.equal(fixtureSha256(await fs.readFile(rollbackIntentPath(controlRoot))), lost.rollback.intentSha256);
      assert.equal(intent.nativeCredentialSha256, expectedCredentials.sha256);
      await assertRollbackPhysicalExit(intent, descriptor);
      const closedCandidate = await snapshotClosedBundleSource(descriptor);
      const resumed = await resumeRuntimeBundle({ controlRoot, input: { expectedRevision: lost.rollback.selection.revision } });
      assert.equal(resumed.bundleID, descriptor.bundleID); assert.equal(resumed.previousBundleID, baseline.bundleID);
      assert.equal(resumed.revision, selected.selection.revision + 2); assert.equal(resumed.reconciliationRequired, false);
      assert.equal(readRollbackIntentSync(controlRoot).state, 'resumed');
      assert.deepEqual(await snapshotClosedBundleSource(descriptor), closedCandidate, 'Resume changed stopped B bytes or history');
      assert.deepEqual(await snapshotRetainedBundleWork(descriptor), retainedWork);
      const completed = await runSelectedNativeLifecycle({ controlRoot, descriptor, configuration, fixture,
        sessionIDs: baselineEvidence.sessionIDs, logFile: path.join(root, 'native-rollback-recomposed.log'),
        rollback: { phase: 'complete', targetBundleID: baseline.bundleID, expectedRevision: resumed.revision } });
      assert.notEqual(completed.hostIdentity.pid, lost.hostIdentity.pid);
      assert.notEqual(completed.restart.replacementInstance, lost.restart.replacementInstance);
      const rolledBack = await store.readSelected();
      assert.equal(rolledBack.selection.selectedBundleID, baseline.bundleID); assert.equal(rolledBack.selection.previousBundleID, descriptor.bundleID);
      assert.equal(rolledBack.selection.revision, selected.selection.revision + 3); assert.equal(rolledBack.selection.reconciliationRequired, false);
      const completedIntent = readRollbackIntentSync(controlRoot);
      assert.equal(completedIntent.state, 'completed');
      assert.deepEqual(completedIntent.settlement.host, completed.hostIdentity);
      assert.equal(completedIntent.settlement.controller.instanceID, completed.restart.replacementInstance);
      assert.equal(completedIntent.nativeCredentialSha256, intent.nativeCredentialSha256);
      assert.equal(completedIntent.expectedTargetCredentialSha256, intent.expectedTargetCredentialSha256);
      assert.equal(completedIntent.targetManifestSha256, intent.targetManifestSha256);
      assert.equal(completedIntent.completion.appliedSha256, intent.nativeCredentialSha256);
      await assertRollbackPhysicalExit(completedIntent, descriptor);
      assert.deepEqual(await snapshotRetainedBundleWork(descriptor), retainedWork, 'Fresh B composition changed retained work/configuration');
      const assertClosed = async () => {
        assert.equal(currentController.hasExited(), true);
        await runtimeOwner.assertCheckpointAdmissionClosed();
        for (const pid of [...lost.controllerPIDs, ...completed.controllerPIDs]) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
      };
      const candidateCredentials = await upgradeLane.captureCredentials({ descriptor, assertHeld: assertClosed });
      const targetCredentials = await upgradeLane.captureCredentials({ descriptor: baseline, assertHeld: assertClosed });
      assert.deepEqual(candidateCredentials.snapshot, expectedCredentials.snapshot);
      assert.deepEqual(targetCredentials.snapshot, expectedCredentials.snapshot, 'Idempotent original SDK projection lost current credential state');
      assert.equal(provider.requests.length, providerCountBeforeRollback, 'Rollback/resume inspection inferred or replayed a prompt');
      cases.push({ ...lost.rollback.retention, source: 'original-compiled-SDK-lost-ACK-dead-host-resume-fresh-B-checkpoint-idempotent-projection',
        resumeRevision: resumed.revision, completedRevision: rolledBack.selection.revision,
        closedCandidateUnchangedThroughResume: true, freshCompositionWorkConfigurationUnchanged: true,
        lossHost: lost.hostIdentity, replacementHost: completed.hostIdentity,
        scope: 'Full stopped B bytes through Resume and within each checkpoint; canonical history, credentials, configuration and project work across fresh composition' });
      cases.push({ id: 'candidate-work-rollback-retention', status: 'passed', source: 'actual-quiescence-derived-v2-copy-original-credential-reconciliation-and-complete-candidate-retained' });
      const providerCountBeforeRecovery = provider.requests.length;
      const recoveryEvidence = await runSelectedNativeLifecycle({ controlRoot, descriptor: baseline, configuration, fixture, sessionIDs:baselineEvidence.sessionIDs,
        logFile: path.join(root, 'native-recovery-lifecycle.log') });
      cases.push(recoveryEvidence);
      assert.equal(provider.requests.length, providerCountBeforeRecovery, 'Native inspection/restart inferred or replayed a prompt');
      assert.equal(fixtureSha256(await fs.readFile(fixture.sourceLaunch.opencodeDatabasePath)), fixture.expected.databaseSha256);
      assert.deepEqual(await snapshotRetainedBundleWork(descriptor), retainedWork);
      // Separate control root: a fresh default-shaped initialization that still holds its setup seed at first boot.
      const providerCountBeforeSeeded = provider.requests.length;
      cases.push(await runCompiledSeededCredentialBoot({ root, artifacts, manifestPath, manifestSha256, reviewedPluginManifestPath,
        configuration, catalogRequirements, provider, observations }));
      assert.equal(provider.requests.length, providerCountBeforeSeeded + 1, 'Seeded first boot inferred other than its one seed prompt');
      const parentDeath = await runCompiledParentDeath({ artifactRoot, root, environment: fixture.environment });
      cases.push(parentDeath);
      // Every descriptor-owned root: the selected candidate (this host, both
      // rollback hosts and the baseline seed copied by the clone), the baseline
      // (seed and recovery hosts) and the SIGKILLed parent-death candidate.
      const gapLog = id => path.join(root, 'journal-gaps', `${id}.log`);
      const journalCase = compiledDurableJournalCase([
        await gradeJournalRoot({ id: 'candidate', journalDirectory: journal.journalDirectory, logPath: gapLog('candidate'),
          tees: [journal.summary(), lost.journal, completed.journal], inherited: [baselineEvidence.journal] }),
        await gradeJournalRoot({ id: 'baseline', journalDirectory: path.join(baseline.launch.webDataDirectory, 'harness', 'journal'),
          logPath: gapLog('baseline'), tees: [baselineEvidence.journal, recoveryEvidence.journal] }),
        await gradeJournalRoot({ id: 'parent-death', journalDirectory: parentDeath.journal.directory, logPath: gapLog('parent-death'),
          tees: [parentDeath.journal.recovery], crashed: [parentDeath.journal.flushed], inherited: parentDeath.journal.inherited }),
      ]);
      cases.push(journalCase);
      assert.equal(journalCase.status, 'passed', `Compiled durable journal roots passed ${journalCase.passed}/${journalCase.required}`);
      result = { status: 'passed', artifact: { buildId: artifacts.manifest.buildId, manifestSha256 }, remainingMandatoryGates: [] };
    }
    }
  } catch (error) { result = { status: 'failed', error: errorEvidence(error) }; }
  finally {
    for (const close of [() => failureEvents?.close(), () => runtimeOwner?.close(), () => managed?.close(), () => host?.drain(), () => journal?.drain(), () => provider?.close(), () => browserLane?.close(), () => slimWeb?.close(), () => mcpLane?.close(), () => imageLane?.close()]) {
      try { await close(); } catch (error) { cleanupFailures.push(errorEvidence(error)); }
    }
  }
  const after = await captureNativeAcceptanceSource();
  const changedPaths = [...new Set([...Object.keys(source.sources), ...Object.keys(after.sources)])]
    .filter(file => source.sources[file] !== after.sources[file]);
  if (fixtureSha256(await fs.readFile(fileURLToPath(import.meta.url))) !== runnerSha256) changedPaths.push('scripts/verify-opencode-v2-package.mjs');
  result = { ...result, root, diagnostic, reviewedSetup, browser, preflight, managedCorrectness,
    eventReconcileIntervalMs: eventReconcileIntervalMs ?? managedInterval?.intervalMs ?? 750,
    cases, observations, diagnostics, cleanupFailures, source,
    sourceCohort: { valid: changedPaths.length === 0, changedPaths } };
  if (cleanupFailures.length || changedPaths.length) result.status = 'failed';
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  run.finish(['passed', 'preflight-passed', 'interval-correctness-passed'].includes(result.status) ? 'passed' : 'failed');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{diagnostic:{type:'boolean'},'reviewed-setup':{type:'boolean'},browser:{type:'boolean'},preflight:{type:'boolean'},'artifact-root':{type:'string'},'baseline-artifact-root':{type:'string'},'skill-data':{type:'string'},'managed-correctness':{type:'boolean'},'keep-artifacts':{type:'boolean'},'event-reconcile-interval-ms':{type:'string'}}});
  if (values['event-reconcile-interval-ms'] !== undefined) assert.match(values['event-reconcile-interval-ms'], /^(750|1500)$/,
    '--event-reconcile-interval-ms must be 750 or 1500');
  const result = await runNativePackageAcceptance({ diagnostic:values.diagnostic??false,reviewedSetup:values['reviewed-setup']??false,browser:values.browser??false,preflight:values.preflight??false,
    managedCorrectness: values['managed-correctness'] ?? false,
    ...(values['event-reconcile-interval-ms'] === undefined ? {} : { eventReconcileIntervalMs: Number(values['event-reconcile-interval-ms']) }),
    ...(values['baseline-artifact-root'] ? { baselineArtifactRoot: path.resolve(values['baseline-artifact-root']) } : {}),
    ...(values['artifact-root']?{artifactRoot:path.resolve(values['artifact-root'])}:{}),...(values['skill-data']?{skillDataRoot:path.resolve(values['skill-data'])}:{}) });
  process.stdout.write(JSON.stringify({ status: result.status, artifact: path.join(result.root, 'result.json'), cases: result.cases }) + '\n');
  if (!['passed', 'preflight-passed', 'interval-correctness-passed'].includes(result.status)) process.exitCode = 1;
}
