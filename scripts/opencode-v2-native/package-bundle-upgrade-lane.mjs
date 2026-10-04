import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { runNativeBundleCredentialProcess, NATIVE_BUNDLE_CREDENTIAL_CONTRACT } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-process.js';
import { createHash } from 'node:crypto';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { nativeBundleCredentialFingerprint } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-contract.js';
import { snapshotOwnedTree } from './package-rollback-lane.mjs';

/** Session history is compared independently of the intentionally reconciled
 * credential/KV state. This is a read of the closed native database, not a write. */
export function readBundleConversationRows(descriptor) {
  const db = resolveSqliteDriver().open(descriptor.launch.opencodeDatabasePath, { readonly: true });
  try {
    db.prepare('BEGIN').run();
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return { sessions: db.prepare('SELECT * FROM session_v2 ORDER BY id').all(),
      messages: db.prepare('SELECT * FROM session_message ORDER BY session_id,seq,id').all() };
  } finally { try{db.prepare('ROLLBACK').run();}finally{db.close();} }
}

/** The WAL index is transient connection coordination, not bundle data.
 * Keep the main DB, WAL and every other byte; compare original logical rows
 * inside one readonly transaction rather than treating SHM locks as data. */
export async function snapshotClosedBundleSource(descriptor){
 const directory=path.dirname(descriptor.preparedManifestPath);
 assert.equal(path.relative(directory,descriptor.launch.opencodeDatabasePath),'opencode/opencode.db');
 return {files:(await snapshotOwnedTree(directory)).filter(row=>row.path!=='opencode/opencode.db-shm'),
  history:readBundleConversationRows(descriptor)};
}

/** Dedicated unregistered integration IDs preserve original credential graph
 * semantics without activating a builtin provider's network discovery.
 * All credential mutations below run the actual artifact-owned original SDK
 * projection. Fixtures contain synthetic grants only; no snapshot is logged. */
export function createCompiledBundleUpgradeLane({ observations, credentialProcess = runNativeBundleCredentialProcess, rollbackPhase = 'ack-loss' }) {
  assert.ok(['ack-loss', 'complete'].includes(rollbackPhase));
  const captured = new Map();
  let originalHistory, retainedCandidate, baselineDescriptor, loseProjectionAck = rollbackPhase === 'ack-loss', refusalChecked = false;
  const captureCredentials = async ({ descriptor, assertHeld }) => {
    const result = await credentialProcess({ descriptor, assertHeld,
      action: { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, action: 'capture' } });
    assert.equal(result.status, 'captured'); captured.set(descriptor.bundleID, result);
    observations.push({ phase: 'bundle_credentials_captured', bundleID: descriptor.bundleID, sha256: result.sha256,
      accounts: result.snapshot.credentials.length });
    return result;
  };
  const project = async (descriptor, before, source, assertHeld, sourceBundleID) => {
    const binding = { sourceBundleID, targetBundleID: descriptor.bundleID,
      targetManifestSha256: descriptor.launch.artifactManifestSha256, expectedTargetSha256: before.sha256,
      sourceSha256: nativeBundleCredentialFingerprint(source) };
    const result = await credentialProcess({ descriptor, assertHeld,
      action: { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, action: 'project', source, binding } });
    assert.equal(result.status, 'projected'); assert.equal(result.appliedSha256, binding.sourceSha256);
    assert.deepEqual((await captureCredentials({ descriptor, assertHeld })).snapshot, source);
    return result;
  };
  const oauth = generation => ({ type: 'oauth', methodID: 'device', refresh: `synthetic-refresh-${generation}`,
    access: `synthetic-access-${generation}`, expires: Date.now() + 3600000 });
  return {
    captureCredentials,
    restoreRollbackBaseline(baseline) {
      assert.equal(baselineDescriptor, undefined);
      baselineDescriptor = baseline;
      originalHistory = readBundleConversationRows(baseline);
      assert.ok(originalHistory.sessions.length > 0); assert.ok(originalHistory.messages.length > 0);
    },
    async assertIncompatibleTarget({ descriptor, artifacts, root, assertHeld }) {
      const target = path.join(root, 'credential-contract-omission');
      await fs.cp(path.dirname(descriptor.launch.artifactManifestPath), target, { recursive: true, errorOnExist: true, force: false });
      const manifestPath = path.join(target, 'native-bundle.json');
      const manifest = structuredClone(artifacts.manifest);
      manifest.compiledContracts = manifest.compiledContracts.filter(value => value !== NATIVE_BUNDLE_CREDENTIAL_CONTRACT);
      await fs.writeFile(manifestPath, JSON.stringify(manifest) + '\n');
      const manifestSha256 = createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex');
      const verified = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256, launcher: path.join(target, path.basename(artifacts.launcher)) });
      const incompatible = { ...descriptor, launch: { ...descriptor.launch, controllerBinary: verified.controller, writerBinary: verified.writer,
        artifactManifestPath: manifestPath, artifactManifestSha256: manifestSha256 } };
      await assert.rejects(credentialProcess({ descriptor: incompatible, assertHeld, action: { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, action: 'capture' } }),
        error => error.code === 'bundle_credential_contract_incompatible');
      return { id: 'compiled-credential-target-contract-refusal', status: 'passed', omittedContract: NATIVE_BUNDLE_CREDENTIAL_CONTRACT,
        manifestSha256, buildId: manifest.buildId, scope: 'capability-omission negative; same signed compiled payload, not a different binary version' };
    },
    async seedBaseline(descriptor, assertHeld) {
      const before = await captureCredentials({ descriptor, assertHeld });
      assert.deepEqual(before.snapshot.credentials, []);
      const source = { ...before.snapshot, credentials: [
        { id: 'cred_fixtureSelected', integrationID: 'devryan-credential-fixture-selected', label: 'Synthetic selected', value: oauth('A'), active: true },
        { id: 'cred_fixtureRemoved', integrationID: 'devryan-credential-fixture-removed', label: 'Synthetic removed', value: oauth('removed'), active: true },
      ].sort((left,right)=>left.id.localeCompare(right.id)) };
      await project(descriptor, before, source, assertHeld, 'synthetic_seed');
      baselineDescriptor = descriptor;
    },
    async assertClone({ baseline, candidate }) {
      assert.equal(candidate.sourceBundleID, baseline.bundleID);
      assert.deepEqual(candidate.projectMap, baseline.projectMap);
      assert.notEqual(candidate.launch.opencodeDatabasePath, baseline.launch.opencodeDatabasePath);
      originalHistory = readBundleConversationRows(baseline);
      assert.ok(originalHistory.sessions.length > 0); assert.ok(originalHistory.messages.length > 0);
      assert.deepEqual(readBundleConversationRows(candidate), originalHistory);
      const clone = JSON.parse(await fs.readFile(path.join(path.dirname(candidate.preparedManifestPath), 'sources/clone.json'), 'utf8'));
      assert.equal(clone.sourceBundleID, baseline.bundleID);
      assert.equal(clone.sourceCredentialSha256, captured.get(baseline.bundleID).sha256);
      assert.equal(clone.compatibility.protocol, 'devryan-v2-clone/1');
      return { id: 'compiled-v2-derived-bundle-clone', status: 'passed', sourceBundleID: baseline.bundleID,
        candidateBundleID: candidate.bundleID, sessions: originalHistory.sessions.length, messages: originalHistory.messages.length };
    },
    async rotateCandidate(descriptor, assertHeld) {
      const before = await captureCredentials({ descriptor, assertHeld });
      const source = { ...before.snapshot, credentials: [
        { ...before.snapshot.credentials.find(row => row.id === 'cred_fixtureSelected'), value: oauth('B'), active: false },
        { id: 'cred_fixtureNewSelected', integrationID: 'devryan-credential-fixture-selected', label: 'Synthetic new selected', value: oauth('B-selected'), active: true },
      ].sort((left,right)=>left.id.localeCompare(right.id)), refreshBlockState: { fingerprint: 'a'.repeat(64), generation: '11111111-1111-1111-1111-111111111111', blocked: true,
        refreshing: true, refreshFingerprint: 'b'.repeat(64), blockedRefreshFingerprints: ['b'.repeat(64)] } };
      await project(descriptor, before, source, assertHeld, 'synthetic_rotation');
    },
    async reconcileRollback({ candidate, target, credentialBinding, assertHeld }) {
      const source = captured.get(candidate.bundleID);
      assert.equal(source.sha256, credentialBinding.sourceSha256);
      assert.deepEqual(readBundleConversationRows(target), originalHistory, 'B history entered A before rollback');
      const candidateHistory = readBundleConversationRows(candidate);
      assert.ok(candidateHistory.sessions.length > originalHistory.sessions.length, 'B must retain independently created native work');
      const before = await captureCredentials({ descriptor: target, assertHeld });
      if (!refusalChecked && rollbackPhase === 'ack-loss') {
        assert.equal(before.sha256, credentialBinding.expectedTargetSha256);
        await assert.rejects(credentialProcess({ descriptor: target, assertHeld, action: {
          protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, action: 'project', source: source.snapshot,
          binding: { ...credentialBinding, expectedTargetSha256: '0'.repeat(64) },
        } }), error => error.code === 'bundle_credential_baseline_changed');
        assert.equal((await captureCredentials({ descriptor: target, assertHeld })).sha256, before.sha256);
        refusalChecked = true;
      }
      retainedCandidate ??= { bundle: (await snapshotClosedBundleSource(candidate)).files,
        history: candidateHistory, projects: await Promise.all(candidate.projectMap.map(row => snapshotOwnedTree(row.targetDirectory))) };
      const credentialReceipt = await credentialProcess({ descriptor: target, assertHeld, action: {
        protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, action: 'project', source: source.snapshot, binding: credentialBinding,
      } });
      assert.deepEqual((await captureCredentials({ descriptor: target, assertHeld })).snapshot, source.snapshot);
      assert.deepEqual(readBundleConversationRows(target), originalHistory, 'Credential projection merged B session history into A');
      assert.deepEqual(readBundleConversationRows(candidate), retainedCandidate.history);
      if (loseProjectionAck) {
        loseProjectionAck = false;
        // The real transaction and host-state publication completed. Lost ACK
        // is represented by held rollback; only a dead-host Resume and a
        // fresh B checkpoint can later retry the original SDK projection intent.
        return { status: 'blocked', reason: 'bundle_credential_ack_lost' };
      }
      return { status: 'reconciled', credentialReceipt };
    },
    async assertRollbackRetention(candidate) {
      assert.equal(refusalChecked, rollbackPhase === 'ack-loss'); assert.equal(loseProjectionAck, false);
      assert.deepEqual((await snapshotClosedBundleSource(candidate)).files, retainedCandidate.bundle);
      assert.deepEqual(await Promise.all(candidate.projectMap.map(row => snapshotOwnedTree(row.targetDirectory))), retainedCandidate.projects);
      assert.deepEqual(readBundleConversationRows(baselineDescriptor), originalHistory);
      return { id: 'compiled-v2-credential-rollback-reconciliation', status: 'passed',
        source: 'original-compiled-SDK-capture-project-active-selection-removal-rotation-block-state-and-idempotent-lost-ACK-projection',
        historyMerged: false, candidateWorkRetained: true, staleBaselineRefused: refusalChecked };
    },
  };
}

/** Stable work across a genuine new runtime composition. Full stopped B bytes
 * are checked separately across Resume; runtime receipts and SQLite storage
 * layout may legitimately change when a new owner opens the same database. */
export async function snapshotRetainedBundleWork(descriptor) {
  const root = path.dirname(descriptor.preparedManifestPath);
  const files = await Promise.all(['descriptor.json', 'prepared.json'].map(async name => ({
    path: name, sha256: createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex'),
  })));
  const directories = [...new Set([path.join(root, 'sources'), path.join(root, 'config'), descriptor.launch.global.home,
    descriptor.launch.global.config, descriptor.launch.webConfigDirectory])];
  return { files, configuration: await Promise.all(directories.map(async directory => ({ directory,
    files: await snapshotOwnedTree(directory) }))), history: readBundleConversationRows(descriptor),
    projects: await Promise.all(descriptor.projectMap.map(row => snapshotOwnedTree(row.targetDirectory))) };
}
