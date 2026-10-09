import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createRuntimeBundleStore } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle.js';
import { createRuntimeBundleCheckpoint } from '../../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js';
import { runNativeMigrationProcess } from '../../packages/web/server/lib/opencode/runtime-host/native-migration-process.js';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { readRollbackIntentSync } from '../../packages/web/server/lib/opencode/runtime-host/bundle-rollback-intent.js';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { createFreshInstallSource, fixtureSha256 } from './migration-fixture.mjs';
import { assertBundleCloneLayout, createCompiledBundleUpgradeLane, readBundleConversationRows, readNativeMigrationIDs,
  snapshotCheckpointedBundleSource, verifyCompiledCloneCompatibility } from './package-bundle-upgrade-lane.mjs';
import { runSelectedNativeLifecycle } from './package-rollback-lane.mjs';

const isolatedEnvironment = (isolatedRoot, inherited) => {
  const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp'].map(key => [key, path.join(isolatedRoot, key)]));
  return createQaHostLaunchEnvironment({ ...inherited, HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data,
    XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp, TMP: globals.tmp, TEMP: globals.tmp });
};
// The default bundle's never-started checkpoint stubs (native-default-bundle.js).
const neverStarted = (ownerID, generation, launch) => createRuntimeBundleCheckpoint({ ownerID, generation, launch, neverStarted: true,
  closeAdmission: async () => {}, getController: () => null, stopProducers: async () => {}, drainStores: async () => {},
  executionHost: { drain: async () => {} } });

/** The legacy lane's forward clone and rollback on the layout every real 2.x
 * install has. Its own control root starts from the production empty source:
 * the baseline importer and controller create and run A, the reviewed gate
 * admits the A→B clone from the closed fresh database, the candidate controller
 * runs B, rollback projects B's credentials into A through A's original
 * controller, and A's controller boots the rolled-back database again. */
export async function runCompiledFreshInstallUpgrade({ root, baseline, candidate, reviewedPluginManifestPath, configuration,
  catalogRequirements, provider, observations }) {
  const laneRoot = path.join(root, 'fresh-install-upgrade'); await fs.mkdir(laneRoot);
  const fixture = await createFreshInstallSource({ root: laneRoot });
  const locations = fixture.projectMap.map(row => ({ directory: row.targetDirectory, readRoots: [row.targetDirectory],
    protectedRoots: [fixture.sourceLaunch.global.home, fixture.sourceLaunch.webDataDirectory] }));
  const reviewedNativeConfigPath = path.join(laneRoot, 'reviewed-native.json');
  await fs.writeFile(reviewedNativeConfigPath, JSON.stringify({ schema: 1, configuration, locations, catalogRequirements }) + '\n');
  const launchArtifacts = ({ artifacts, manifestPath, manifestSha256 }) => ({ controllerBinary: artifacts.controller, writerBinary: artifacts.writer,
    artifactManifestPath: manifestPath, artifactManifestSha256: manifestSha256, reviewedNativeConfigPath, reviewedPluginManifestPath });
  const controlRoot = path.join(laneRoot, 'bundles');
  const lane = createCompiledBundleUpgradeLane({ observations });
  const sourceCheckpoint = neverStarted('fresh-source', 1, fixture.sourceLaunch);
  const prepared = new Map(), settled = new Map(), gates = [];
  let imports = 0;
  const store = createRuntimeBundleStore({ controlRoot, captureCredentials: lane.captureCredentials,
    withQuiescedSource: async (input, action) => {
      if (input.kind === 'legacy') return sourceCheckpoint(input, action);
      const evidence = settled.get(input.bundleID);
      if (!evidence) {
        const descriptor = prepared.get(input.bundleID);
        assert.ok(descriptor, 'Fresh-install lane source has no checkpoint owner');
        return neverStarted(descriptor.bundleID, 2, descriptor.launch)(input, action);
      }
      const assertHeld = async () => {
        for (const pid of evidence.controllerPIDs) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'Settled controller restarted');
      };
      await assertHeld();
      return action(evidence.quiescence, { assertHeld });
    },
    runMigration: request => {
      imports++;
      assert.equal(request.bundleID, 'fresh-baseline', 'Only the fresh baseline is imported');
      return runNativeMigrationProcess({ binary: baseline.artifacts.controller, request, cwd: laneRoot,
        environment: isolatedEnvironment(request.isolatedRoot, fixture.environment),
        beforeSpawn: () => verifyNativeRuntimeArtifacts({ manifestPath: baseline.manifestPath, manifestSha256: baseline.manifestSha256,
          launcher: baseline.artifacts.launcher }) });
    },
    verifyV2Compatibility: async input => {
      const proof = await verifyCompiledCloneCompatibility(input);
      gates.push(input.source.bundleID); return proof;
    } });
  const respondOnce = async marker => {
    let requests = 0;
    await provider.setResponder(request => {
      requests++;
      assert.equal(requests, 1, 'Fresh-install lifecycle must infer exactly once');
      assert.ok(request.body.messages.some(row => row.role === 'user' && JSON.stringify(row.content).includes(marker)));
      return { items: [{ type: 'textDelta', text: `${marker} complete` }], reason: 'stop' };
    });
    return () => requests;
  };
  const unsolicited = () => provider.setResponder(() => { throw new Error('Unsolicited packaged model request'); });

  const a = await store.prepare({ bundleID: 'fresh-baseline', generation: 2, source: { kind: 'legacy', launch: fixture.sourceLaunch },
    projectMap: fixture.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts: launchArtifacts(baseline) });
  assert.equal(imports, 1);
  assert.equal(fixtureSha256(await fs.readFile(fixture.sourceLaunch.opencodeDatabasePath)), fixture.expected.databaseSha256,
    'Fresh import mutated its empty source');
  const imported = JSON.parse(await fs.readFile(a.migrationReceiptPath, 'utf8'));
  assert.equal(imported.status, 'completed');
  prepared.set(a.bundleID, a);
  await store.select({ bundleID: a.bundleID, expectedRevision: 0 });
  // Synthetic grants through A's original compiled SDK, before A ever starts.
  await neverStarted(a.bundleID, 2, a.launch)({ kind: 'bundle', bundleID: a.bundleID }, (_, scope) => lane.seedBaseline(a, scope.assertHeld));
  const baselineMarker = 'Fresh-install baseline';
  let requests = await respondOnce(baselineMarker), aRun;
  try {
    aRun = await runSelectedNativeLifecycle({ controlRoot, descriptor: a, configuration, fixture, seedInput: baselineMarker,
      logFile: path.join(laneRoot, 'baseline-lifecycle.log') });
  } finally { await unsolicited(); }
  assert.equal(requests(), 1); assert.equal(aRun.version, baseline.artifacts.manifest.opencodeVersion);
  settled.set(a.bundleID, aRun);
  const closedA = await snapshotCheckpointedBundleSource(a), aMigrations = readNativeMigrationIDs(a.launch.opencodeDatabasePath);
  const layoutCase = assertBundleCloneLayout({ kind: 'fresh-install', databasePath: a.launch.opencodeDatabasePath,
    left: baseline.artifacts.manifest, right: candidate.artifacts.manifest });

  const b = await store.prepare({ bundleID: 'fresh-candidate', generation: 2, source: { kind: 'bundle', bundleID: a.bundleID },
    projectMap: a.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts: launchArtifacts(candidate) });
  assert.equal(imports, 1, 'A→B clone must not rerun the importer');
  assert.deepEqual(gates, baseline.manifestSha256 === candidate.manifestSha256 ? [] : [a.bundleID], 'Clone bypassed the compatibility gate');
  const { physical: closedBytes, walBytes: closedWal, ...closedData } = closedA;
  const { physical: clonedBytes, walBytes: clonedWal, ...clonedData } = await snapshotCheckpointedBundleSource(a);
  assert.deepEqual(clonedData, closedData, 'Clone changed its closed fresh source');
  // A's own credential capture may only drain pending WAL frames into the same data.
  const sourceWalCheckpointed = !isDeepStrictEqual(clonedBytes, closedBytes);
  if (sourceWalCheckpointed) assert.ok(closedWal > 0 && !clonedWal, 'Closed fresh source bytes changed other than by a WAL checkpoint');
  const cloneCase = await lane.assertClone({ baseline: a, candidate: b });
  prepared.set(b.bundleID, b);
  await store.select({ bundleID: b.bundleID, expectedRevision: 1 });
  await neverStarted(b.bundleID, 2, b.launch)({ kind: 'bundle', bundleID: b.bundleID }, (_, scope) => lane.rotateCandidate(b, scope.assertHeld));
  const candidateMarker = 'Fresh-install candidate';
  requests = await respondOnce(candidateMarker);
  let bRun;
  try {
    // B creates its own work, restarts, then rolls back to A in the same host.
    bRun = await runSelectedNativeLifecycle({ controlRoot, descriptor: b, configuration, fixture, sessionIDs: aRun.sessionIDs,
      seedInput: candidateMarker, logFile: path.join(laneRoot, 'candidate-rollback-lifecycle.log'),
      rollback: { phase: 'complete', targetBundleID: a.bundleID, expectedRevision: 2 } });
  } finally { await unsolicited(); }
  assert.equal(requests(), 1); assert.equal(bRun.version, candidate.artifacts.manifest.opencodeVersion);
  assert.equal(bRun.rollback.phase, 'complete'); assert.equal(bRun.rollback.retention.historyMerged, false);
  const selected = await store.readSelected();
  assert.equal(selected.selection.selectedBundleID, a.bundleID); assert.equal(selected.selection.previousBundleID, b.bundleID);
  assert.equal(selected.selection.revision, 3); assert.equal(selected.selection.reconciliationRequired, false);
  assert.equal(readRollbackIntentSync(controlRoot).state, 'completed');
  const bMigrations = readNativeMigrationIDs(b.launch.opencodeDatabasePath);
  assert.deepEqual(readNativeMigrationIDs(a.launch.opencodeDatabasePath), aMigrations, 'Candidate migrations reached the rollback target');
  assert.deepEqual(bMigrations.slice(0, aMigrations.length), aMigrations);
  assert.deepEqual(readBundleConversationRows(a), closedA.history, 'Rollback merged candidate history into the baseline');
  const stopped = async () => {
    for (const pid of [...aRun.controllerPIDs, ...bRun.controllerPIDs]) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  };
  const bCredentials = await lane.captureCredentials({ descriptor: b, assertHeld: stopped });
  const aCredentials = await lane.captureCredentials({ descriptor: a, assertHeld: stopped });
  assert.deepEqual(aCredentials.snapshot, bCredentials.snapshot, 'Rollback lost the candidate credential state');
  const providerRequests = provider.requests.length;
  const recovery = await runSelectedNativeLifecycle({ controlRoot, descriptor: a, configuration, fixture, sessionIDs: aRun.sessionIDs,
    logFile: path.join(laneRoot, 'baseline-recovery-lifecycle.log') });
  assert.equal(recovery.version, baseline.artifacts.manifest.opencodeVersion);
  assert.equal(provider.requests.length, providerRequests, 'Rolled-back baseline inspection inferred or replayed a prompt');
  return [layoutCase, { ...cloneCase, id: 'compiled-fresh-install-clone', layout: 'fresh-install', sourceWalCheckpointed }, {
    id: 'compiled-fresh-install-rollback', status: 'passed', baselineVersion: aRun.version, candidateVersion: bRun.version,
    gate: layoutCase.gate, importMarker: imported.marker, migrations: { baseline: aMigrations.length, candidate: bMigrations.length },
    selection: selected.selection, credentialSha256: aCredentials.sha256, retention: bRun.rollback.retention,
    controllers: { baseline: aRun.controllerPIDs, candidate: bRun.controllerPIDs, recovery: recovery.controllerPIDs },
    source: 'production-empty-source-actual-baseline-import-reviewed-clone-gate-candidate-controller-original-SDK-rollback-baseline-restart' }];
}
