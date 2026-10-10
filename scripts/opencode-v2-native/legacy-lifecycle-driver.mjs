// Compatibility filename. Only the selected native v2 lifecycle is runnable.
import assert from 'node:assert/strict';
import { Console } from 'node:console';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
let bytes = '';
for await (const chunk of process.stdin) { bytes += chunk; assert.ok(Buffer.byteLength(bytes) <= 65536); }
const input = JSON.parse(bytes);
if (input.builtinCatalog) {
  const { builtinCatalogPreflightFetch } = await import('./package-preflight.mjs');
  globalThis.fetch = builtinCatalogPreflightFetch(input.builtinCatalog.endpoint);
}
if (input.rollback !== undefined) {
  assert.ok(input.rollback && typeof input.rollback === 'object' && !Array.isArray(input.rollback));
  assert.deepEqual(Object.keys(input.rollback).sort(), ['expectedRevision', 'phase', 'targetBundleID']);
  assert.ok(['ack-loss', 'complete'].includes(input.rollback.phase));
  assert.match(input.rollback.targetBundleID, /^[A-Za-z0-9_-]{1,128}$/);
  assert.ok(Number.isSafeInteger(input.rollback.expectedRevision) && input.rollback.expectedRevision > 0);
}
const { readRuntimeBundleBinding } = await import('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js');
const binding = readRuntimeBundleBinding(); assert.equal(binding.descriptor.generation, 2);
assert.equal(binding.descriptor.bundleID, input.bundleID);
const { loadNativeRuntimeBundle, createNativeRuntimeOwner } = await import('../../packages/web/server/lib/opencode/runtime-host/native-runtime-owner.js');
const { createNativeConfigurationSnapshotResolver } = await import('../../packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js');
const { createNativeAuthorization } = await import('../../packages/web/server/lib/opencode/runtime-host/native-authorization.js');
const { createOpenAiOAuthCoordinator } = await import('../../packages/web/server/lib/opencode/openai-oauth-coordinator.js');
const { createOpenCodeClient } = await import('../../packages/web/server/lib/opencode/opencode-client/index.js');
const { createRuntimeBundleCheckpoint } = await import('../../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js');
const { waitFor } = await import('./process-lanes.mjs');
const { createOpenCodeAdmission, createV2MessageId } = await import('../../packages/web/server/lib/opencode/v2/admission.js');
const { createSessionExecutionHost } = await import('../../packages/web/server/lib/opencode/session-execution-host.js');
const { createNativeManagedFixture } = await import('./managed-fixture.mjs');
const { createRuntimeBundleStore } = await import('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle.js');
const { resumeRuntimeBundle } = await import('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-resume.js');
const { readRollbackIntentSync, rollbackIntentPath, captureRollbackFiles } = await import('../../packages/web/server/lib/opencode/runtime-host/bundle-rollback-intent.js');
const { createCompiledBundleUpgradeLane } = await import('./package-bundle-upgrade-lane.mjs');
const { readManagedOpenCodeRegistry } = await import('../../packages/web/server/lib/opencode/managed-process-registry.js');
const { createFixtureJournal } = await import('./fixture-journal.mjs');
const registryOptions = { registryPath: path.join(binding.descriptor.launch.global.state, 'managed-opencode-processes.json') };
const hash = value => createHash('sha256').update(value).digest('hex');
const launcher = path.join(path.dirname(binding.descriptor.launch.controllerBinary), `DevRyan-execution-${process.platform}-${process.arch}`);
const bundle = await loadNativeRuntimeBundle({ binding, launcher });
const nativeVersion = bundle.artifacts.manifest.opencodeVersion;
const { agents, commands = {}, ...legacy } = input.configuration;
const resolve = createNativeConfigurationSnapshotResolver({ loadLocation: async () => ({ legacy: structuredClone(legacy),
  agents: structuredClone(agents), commands: structuredClone(commands), skills: [], slim: { mergedConfig: {} },
  parseMarkdown: () => { throw new Error('Unexpected restart fixture skill'); } }) });
const registration = hash(await fs.readFile(binding.descriptor.launch.reviewedPluginManifestPath));
bundle.resolveConfiguration = revision => resolve({ binding, revision, expectedRegistrationDigest: registration });
const locations = binding.descriptor.projectMap.map(row => ({ directory: row.targetDirectory, readRoots: [row.targetDirectory],
  protectedRoots: [binding.descriptor.launch.global.home, binding.descriptor.launch.webDataDirectory] }));
const directory = locations[0].directory, observations = [], diagnostics = [], exits = [], registry = [];
// This fresh host owns the descriptor's durable web journal for its lifetime.
const journal = await createFixtureJournal({ webDataDirectory: binding.descriptor.launch.webDataDirectory,
  label: `fixture-lc-${randomBytes(4).toString('hex')}` });
let owner, managed, host, url, epoch = 0;
const deps = { getRuntime: () => ({ generation: 2, baseUrl: url, version: nativeVersion, epoch }),
  getAuthHeaders: () => owner?.getAuthHeaders() ?? {}, withNativeWebOperation: (spec, action) => owner.nativeOwner.withWebOperation(spec, action),
  recordDiagnostic: payload => { diagnostics.push(payload); journal.clientDiagnostic(payload); } };
const admission = createOpenCodeAdmission(deps, { beforePromptDispatch: (receipt, context) => managed.admitNativePrompt(receipt, context),
  onPromptDispatchFailure: receipt => managed.markNativePromptUncertain(receipt), nativeOwner: {
    requestHeaders: () => owner.nativeOwner.requestHeaders(), withAcceptedOperation: (receipt, action) => owner.nativeOwner.withAcceptedOperation(receipt, action),
    withCommandSelection: (request, action) => owner.nativeOwner.withCommandSelection(request, action), checkQueuedPromptAdmission:(...args)=>owner.nativeOwner.checkQueuedPromptAdmission(...args),
    stageQueuedPromptAdmission:(...args)=>owner.nativeOwner.stageQueuedPromptAdmission(...args),
    assertQueuedPromptReconciled:(...args)=>owner.nativeOwner.assertQueuedPromptReconciled(...args),
    queuedPromptWasRejected:(...args)=>owner.nativeOwner.queuedPromptWasRejected(...args),
    updateAcceptedOperation: receipt => owner.nativeOwner.updateAcceptedOperation(receipt) } });
const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });
const buildOpenCodeUrl = route => new URL(route, url).href;
host = createSessionExecutionHost({ dataDirectory: binding.descriptor.launch.webDataDirectory, openCodeClient: client,
  getLauncher: () => launcher, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders,
  onDiagnostic: event => { diagnostics.push(event); journal.sessionExecution(event); },
  nativeExecution: { locations, socketDirectory: null, workerBrowsers: false,
    helperRoots: locations.map(row => row.directory), gitCommand: '/usr/bin/git',
    deniedReadDirectories: ['packages', 'scripts', 'node_modules'].map(name => path.resolve(import.meta.dirname, '../..', name)) } });
managed = createNativeManagedFixture({ client, admissionOwner: { withManagedTaskDispatch: (request, action) => owner.nativeOwner.withManagedTaskDispatch(request, action),
  withPermit: (permit, action) => owner.nativeOwner.withPermit(permit, action) }, executionHost: host, directory,
  dataDirectory: binding.descriptor.launch.webDataDirectory, buildOpenCodeUrl, getOpenCodeAuthHeaders: deps.getAuthHeaders,
  environment: process.env, observations, diagnostics, journal });
const principal = Object.freeze({ scope: 'local-admin', id: 'local-admin' });
const authorization = createNativeAuthorization({ locations, manifest: bundle.artifacts.manifest, getRequestPrincipal: () => principal,
  captureLocalAuthorization: original => original === principal ? () => true : null,
  getMultiUserRuntime: () => ({ enabled: false, connection: { configured: false, isLocalAccessActive: () => true } }) });
owner = createNativeRuntimeOwner({ bundle, openCodeClient: client, admission, executionHost: host, clientDependencies: deps,
  authorization, environment: process.env, withCredentialMutationQueue: createOpenAiOAuthCoordinator({ readAuth: () => undefined }).withAuthMutation,
  supervisedController: { deniedReadDirectories: ['packages', 'scripts', 'node_modules'].map(name => path.resolve(import.meta.dirname, '../..', name)) },
  primaryRuntime: managed.primaryRuntime, taskContext: managed.taskContext, getManagedRuntime: managed.getManagedRuntime,
  recordDiagnostic: row => { diagnostics.push(row); journal.ownerDiagnostic(row); return true; },
  onExit: exit => exits.push(exit), onBound: child => { url = child.url; epoch++; } });
let result;
try {
  const first = await owner.start();
  let builtinCatalog;
  if (input.builtinCatalog) {
    const { assertBuiltinCatalogPreflight } = await import('./package-preflight.mjs');
    builtinCatalog = await assertBuiltinCatalogPreflight({ client, directories: locations.map(row => row.directory),
      expected: input.builtinCatalog.expected });
  }
  registry.push(...readManagedOpenCodeRegistry(registryOptions).map(({ childPid, ownerPid }) => ({ childPid, ownerPid })));
  await fs.writeFile(input.evidencePath, JSON.stringify(registry));
  const sessionIDs = [...input.sessionIDs];
  if (input.seedInput) {
    const session = await client.sessions.create({title:'Fresh v2 rollback baseline',model:{providerID:'devryan-smoke',modelID:'smoke-write'}},{directory});
    await client.prompts.prompt(session.id,{messageID:createV2MessageId(),agent:'orchestrator',variant:'default',
      model:{providerID:'devryan-smoke',modelID:'smoke-write'},parts:[{type:'text',text:input.seedInput}]},
      {directory,origin:'native_acceptance',timeoutMs:30000});
    await waitFor(() => client.sessions.messages(session.id,{}, {directory}),
      page => page.records.some(row=>row.info.role==='assistant' && row.info.time?.completed && !row.info.error),
      'Fresh baseline assistant did not settle');
    await waitFor(() => client.sessions.status({directory}),status=>!status[session.id] || status[session.id].type==='idle',
      'Fresh baseline did not become idle');
    sessionIDs.push(session.id);
  }
  assert.ok(sessionIDs.length > 0, 'Native rollback must inspect real created v2 work');
  const history = new Map();
  const inspect = async () => {
    assert.equal((await client.health.runtimeInfo()).version, nativeVersion);
    for (const sessionID of sessionIDs) {
      const session = await client.sessions.get(sessionID); assert.equal(session.id, sessionID);
      const messages = await client.sessions.messages(sessionID, {}, { directory: session.directory });
      assert.ok(messages.records.length > 0);
      const ids = messages.records.map(row=>row.info.id);
      if (history.has(sessionID)) assert.deepEqual(ids,history.get(sessionID),'Native restart changed canonical history');
      else history.set(sessionID,ids);
    }
  };
  await inspect();
  const stopped = await first.killForRecovery();
  assert.equal(stopped.receipt?.terminated, true); assert.equal(stopped.receipt?.confined, true);
  const second = await owner.start(); assert.notEqual(first.instanceID, second.instanceID);
  registry.push(...readManagedOpenCodeRegistry(registryOptions).map(({ childPid, ownerPid }) => ({ childPid, ownerPid })));
  await fs.writeFile(input.evidencePath, JSON.stringify(registry));
  await inspect();
  const checkpoint = createRuntimeBundleCheckpoint({ownerID:input.bundleID,generation:2,launch:binding.descriptor.launch,
    closeAdmission:()=>{journal.beginDrain();return owner.closeAdmissionForCheckpoint();},getController:()=>second,
    assertAdmissionClosed:()=>owner.assertCheckpointAdmissionClosed(),beforeControllerStop:()=>owner.drainCredentialOwners(),
    afterExit:()=>owner.close(),stopProducers:()=>managed.close(),executionHost:host,
    drainStores:async()=>{await host.runtime.drain();await journal.drain();}});
  let quiescence, rollbackEvidence;
  if (input.rollback) {
    assert.equal(binding.selection.revision, input.rollback.expectedRevision);
    assert.equal(binding.selection.previousBundleID, input.rollback.targetBundleID);
    const target = JSON.parse(await fs.readFile(path.join(binding.controlRoot, 'bundles', input.rollback.targetBundleID, 'descriptor.json'), 'utf8'));
    assert.equal(target.bundleID, input.rollback.targetBundleID);
    const lane = createCompiledBundleUpgradeLane({ observations, rollbackPhase: input.rollback.phase });
    lane.restoreRollbackBaseline(target);
    const store = createRuntimeBundleStore({ controlRoot: binding.controlRoot,
      withQuiescedSource: (source, action) => checkpoint(source, async (stamp, scope) => {
        quiescence = stamp; return action(stamp, scope);
      }), runMigration: async () => { throw new Error('Unexpected rollback fixture migration'); },
      captureCredentials: lane.captureCredentials, reconcileRollback: request => lane.reconcileRollback(request) });
    const transitioned = await store.rollback({ targetBundleID: target.bundleID, expectedRevision: input.rollback.expectedRevision });
    assert.equal(transitioned.selection.selectedBundleID, target.bundleID);
    assert.equal(transitioned.selection.previousBundleID, input.bundleID);
    assert.equal(transitioned.selection.revision, input.rollback.expectedRevision + 1);
    assert.equal(transitioned.selection.reconciliationRequired, input.rollback.phase === 'ack-loss');
    const intent = readRollbackIntentSync(binding.controlRoot);
    assert.equal(intent.settlement.host.pid, process.pid);
    assert.equal(intent.settlement.controller.instanceID, second.instanceID);
    assert.equal(intent.state, input.rollback.phase === 'ack-loss' ? 'pending' : 'completed');
    if (input.rollback.phase === 'ack-loss') {
      assert.equal(transitioned.reason, 'bundle_credential_ack_lost');
      const selectionFile = path.join(binding.controlRoot, 'selection.json'), intentFile = rollbackIntentPath(binding.controlRoot);
      const selector = await fs.readFile(selectionFile), proof = await fs.readFile(intentFile);
      const retained = await captureRollbackFiles(path.dirname(binding.descriptor.preparedManifestPath));
      assert.throws(() => readRuntimeBundleBinding(), error => error.code === 'bundle_rollback_reconciliation_required');
      await assert.rejects(store.rollback({ targetBundleID: target.bundleID, expectedRevision: transitioned.selection.revision }),
        error => error.code === 'bundle_recovery_resume_required');
      await assert.rejects(resumeRuntimeBundle({ controlRoot: binding.controlRoot, input: { expectedRevision: transitioned.selection.revision } }),
        error => error.code === 'bundle_recovery_original_process_active');
      assert.deepEqual(await fs.readFile(selectionFile), selector);
      assert.deepEqual(await fs.readFile(intentFile), proof);
      assert.deepEqual(await captureRollbackFiles(path.dirname(binding.descriptor.preparedManifestPath)), retained);
    } else assert.equal(transitioned.reason, null);
    const retention = await lane.assertRollbackRetention(binding.descriptor);
    rollbackEvidence = { phase: input.rollback.phase, selection: transitioned.selection,
      intentSha256: hash(await fs.readFile(rollbackIntentPath(binding.controlRoot))),
      checkpointID: intent.checkpoint.checkpointID, host: intent.settlement.host,
      controller: intent.settlement.controller, nativeCredentialSha256: intent.nativeCredentialSha256,
      retention, heldRetryRefused: input.rollback.phase === 'ack-loss', sameHostResumeRefused: input.rollback.phase === 'ack-loss' };
  } else quiescence = await checkpoint({kind:'bundle',bundleID:input.bundleID},stamp=>stamp);
  assert.equal(second.hasExited(),true);
  result = { quiescence, ...(rollbackEvidence ? { rollback: rollbackEvidence } : {}), ...(builtinCatalog ? { builtinCatalog } : {}), id: 'rollback-selected-native-lifecycle', status: 'passed', version: nativeVersion, sessionIDs, history: Object.fromEntries(history),
    restart: { previousInstance: first.instanceID, replacementInstance: second.instanceID, exit: stopped },
    source: 'actual-selected-v2-owner-canonical-history-and-supervised-restart' };
} finally {
  await owner.close(); await managed.close(); await host.drain(); await journal.drain();
}
assert.equal(readManagedOpenCodeRegistry(registryOptions).length, 0);
assert.equal(exits.length, 2); assert.ok(exits.every(exit => exit.receipt?.terminated && exit.receipt?.confined));
result.exits = exits;
result.journal = journal.summary();
process.stdout.write(JSON.stringify(result) + '\n');
