import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { createRuntimeBundleStore } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle.js';
import { createRuntimeBundleCheckpoint } from '../../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js';
import { runNativeMigrationProcess } from '../../packages/web/server/lib/opencode/runtime-host/native-migration-process.js';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { projectNativeSetupCredentials } from '../../packages/web/server/lib/opencode/runtime-host/native-setup-credential-data.js';
import { NATIVE_SETUP_CREDENTIAL_FILE } from '../../packages/web/server/lib/opencode/runtime-host/native-setup-seed.js';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { createEmptyRuntimeFixture } from './migration-fixture.mjs';
import { createCompiledBundleUpgradeLane } from './package-bundle-upgrade-lane.mjs';
import { runSelectedNativeLifecycle } from './package-rollback-lane.mjs';

// native-setup-credentials.ts NATIVE_SETUP_CREDENTIAL_STAMP (compiled controller source).
export const NATIVE_SETUP_CREDENTIAL_STAMP = 'devryan.setup.credentials/1';
// An unregistered integration: the original credential graph without builtin provider discovery.
export const SEEDED_INTEGRATION_ID = 'devryan-credential-fixture-seeded';
const SEEDED_FAKE_KEY = 'devryan-fixture-seeded-not-a-credential';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const environmentFor = (globals, inherited) => createQaHostLaunchEnvironment({ ...inherited, HOME: globals.home, XDG_CONFIG_HOME: globals.config,
  XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp, TMP: globals.tmp, TEMP: globals.tmp });

/** The setup seed exactly as native-setup-seed.js saves it from an auth.json
 * account, here a fake API key, into a fresh source's OpenCode config. */
export async function writeNativeSetupSeed(opencodeConfigDirectory) {
  const projected = projectNativeSetupCredentials({ [SEEDED_INTEGRATION_ID]: { type: 'api', key: SEEDED_FAKE_KEY } }, { onSkip: () => {
    throw new Error('Fixture seed account was skipped by the production projection');
  } });
  const bytes = Buffer.from(JSON.stringify(projected) + '\n');
  const seedPath = path.join(opencodeConfigDirectory, NATIVE_SETUP_CREDENTIAL_FILE);
  await fs.writeFile(seedPath, bytes, { mode: 0o600, flag: 'wx' });
  return { seedPath, sha256: sha256(bytes), bytes: bytes.length, count: projected.credentials.length };
}

/** Consumption is the controller's own: the transient seed is unlinked only
 * after the original transaction stamped its exact digest and count. */
export async function assertNativeSetupSeedConsumed({ seedPath, databasePath, sha256: expected, count }) {
  await assert.rejects(fs.lstat(seedPath), error => error.code === 'ENOENT', 'Native setup seed survived its first boot');
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  let row;
  try { row = db.prepare('SELECT value FROM kv WHERE key=?').get(NATIVE_SETUP_CREDENTIAL_STAMP); } finally { db.close(); }
  assert.ok(row, 'Native setup seed was never stamped as applied');
  const stamp = JSON.parse(row.value);
  assert.deepEqual(stamp, { schema: 1, sha256: expected, count }, 'Native setup stamp does not bind the seeded bytes');
  return stamp;
}

/** A fresh empty initialization whose setup seed is present at first boot,
 * prepared, selected and started like the default bundle: the 2.0.1 blocker
 * (seed imported, then unlinking it failed in the confined controller) only
 * appears on this path. The fake key never reaches a provider. */
export async function runCompiledSeededCredentialBoot({ root, artifacts, manifestPath, manifestSha256, reviewedPluginManifestPath,
  configuration, catalogRequirements, provider, observations }) {
  const laneRoot = path.join(root, 'seeded-credential'); await fs.mkdir(laneRoot);
  const fixture = await createEmptyRuntimeFixture({ root: laneRoot });
  const seed = await writeNativeSetupSeed(fixture.sourceLaunch.opencodeConfigDirectory);
  const locations = fixture.projectMap.map(row => ({ directory: row.targetDirectory, readRoots: [row.targetDirectory],
    protectedRoots: [fixture.sourceLaunch.global.home, fixture.sourceLaunch.webDataDirectory] }));
  const reviewedNativeConfigPath = path.join(laneRoot, 'reviewed-native.json');
  await fs.writeFile(reviewedNativeConfigPath, JSON.stringify({ schema: 1, configuration, locations, catalogRequirements }) + '\n');
  const launchArtifacts = { controllerBinary: artifacts.controller, writerBinary: artifacts.writer, artifactManifestPath: manifestPath,
    artifactManifestSha256: manifestSha256, reviewedNativeConfigPath, reviewedPluginManifestPath };
  const sourceLaunch = { ...fixture.sourceLaunch, global: { home: fixture.sourceLaunch.global.home } };
  const controlRoot = path.join(laneRoot, 'bundles');
  // The default bundle's never-started fresh-source checkpoint.
  const sourceCheckpoint = createRuntimeBundleCheckpoint({ ownerID: 'seeded-fresh-source', generation: 1, launch: sourceLaunch, neverStarted: true,
    closeAdmission: async () => {}, getController: () => null, executionHost: { drain: async () => {} }, drainStores: async () => {},
    stopProducers: async () => { assert.deepEqual(await fs.readdir(sourceLaunch.webDataDirectory), []); } });
  const store = createRuntimeBundleStore({ controlRoot, withQuiescedSource: (input, action) => {
    assert.equal(input.kind, 'legacy', 'Seeded first boot prepares only its fresh source');
    return sourceCheckpoint(input, action);
  }, runMigration: request => runNativeMigrationProcess({ binary: artifacts.controller, request, cwd: laneRoot,
    environment: environmentFor(Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp', 'bin', 'log', 'repos']
      .map(key => [key, path.join(request.isolatedRoot, key)])), fixture.environment),
    beforeSpawn: () => verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256, launcher: artifacts.launcher }) }) });
  const descriptor = await store.prepare({ bundleID: 'seeded', generation: 2, source: { kind: 'legacy', launch: sourceLaunch },
    projectMap: fixture.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts });
  await store.select({ bundleID: 'seeded', expectedRevision: 0 });
  const bundleSeed = path.join(descriptor.launch.global.config, NATIVE_SETUP_CREDENTIAL_FILE);
  assert.equal(sha256(await fs.readFile(bundleSeed)), seed.sha256, 'Prepared bundle did not carry the setup seed to first boot');
  const marker = 'Seeded native credential first boot';
  let requests = 0;
  await provider.setResponder(request => {
    requests++;
    assert.equal(requests, 1, 'Seeded first boot must infer exactly once');
    assert.ok(request.body.messages.some(row => row.role === 'user' && JSON.stringify(row.content).includes(marker)));
    return { items: [{ type: 'textDelta', text: 'Seeded native first boot complete' }], reason: 'stop' };
  });
  let lifecycle;
  try {
    lifecycle = await runSelectedNativeLifecycle({ controlRoot, descriptor, configuration, fixture, seedInput: marker,
      logFile: path.join(laneRoot, 'seeded-lifecycle.log') });
  } finally { await provider.setResponder(() => { throw new Error('Unsolicited packaged model request'); }); }
  assert.equal(requests, 1);
  const stamp = await assertNativeSetupSeedConsumed({ seedPath: bundleSeed, databasePath: descriptor.launch.opencodeDatabasePath,
    sha256: seed.sha256, count: seed.count });
  const assertHeld = async () => {
    for (const pid of lifecycle.controllerPIDs) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  };
  const captured = await createCompiledBundleUpgradeLane({ observations }).captureCredentials({ descriptor, assertHeld });
  const seeded = captured.snapshot.credentials.filter(row => row.integrationID === SEEDED_INTEGRATION_ID);
  assert.equal(captured.snapshot.credentials.length, 1, 'Seeded first boot imported an unexpected credential set');
  assert.equal(seeded.length, 1, 'Seeded credential is missing from the native credential store');
  // Compare without printing the (fake) value.
  assert.ok(seeded[0].active === true && seeded[0].value?.type === 'key' && seeded[0].value.key === SEEDED_FAKE_KEY,
    'Seeded credential was not imported active and unchanged');
  return { id: 'compiled-seeded-credential-first-boot', status: 'passed', bundleID: descriptor.bundleID,
    seed: { sha256: seed.sha256, bytes: seed.bytes, presentAtFirstBoot: true, consumed: true }, stamp,
    credentials: { integrationIDs: [SEEDED_INTEGRATION_ID], captureSha256: captured.sha256 },
    restart: lifecycle.restart, controllerPIDs: lifecycle.controllerPIDs,
    source: 'actual-compiled-controller-first-boot-consumed-native-setup-seed-then-supervised-restart' };
}
