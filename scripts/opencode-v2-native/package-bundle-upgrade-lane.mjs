import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { runNativeBundleCredentialProcess, NATIVE_BUNDLE_CREDENTIAL_CONTRACT } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-process.js';
import { createHash } from 'node:crypto';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { nativeBundleCredentialFingerprint } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-contract.js';
import { inspectNativeCloneLayout, isReviewedNativeClonePair, verifyNativeCloneCompatibility, REVIEWED_NATIVE_CLONE_LAYOUT,
  REVIEWED_NATIVE_FRESH_CLONE_LAYOUT } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-compatibility.js';
import { snapshotOwnedTree } from './package-rollback-lane.mjs';
import { cloneTree } from '../qa/run-root.mjs';

/** The production clone gate over both re-verified artifacts and the closed source database. */
export async function verifyCompiledCloneCompatibility({ source, artifacts }) {
  const verify = (manifestPath, manifestSha256) => verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256,
    launcher: path.join(path.dirname(manifestPath), 'DevRyan-execution-darwin-arm64') });
  const left = await verify(source.launch.artifactManifestPath, source.launch.artifactManifestSha256);
  const right = await verify(artifacts.artifactManifestPath, artifacts.artifactManifestSha256);
  verifyNativeCloneCompatibility({ left: left.manifest, right: right.manifest, databasePath: source.launch.opencodeDatabasePath });
  return { status: 'compatible', binding: { protocol: 'devryan-v2-clone/1', sourceBundleID: source.bundleID,
    sourceManifestSha256: source.launch.artifactManifestSha256, targetManifestSha256: artifacts.artifactManifestSha256 } };
}

const reviewedCloneLayouts = Object.freeze({ legacy: REVIEWED_NATIVE_CLONE_LAYOUT, 'fresh-install': REVIEWED_NATIVE_FRESH_CLONE_LAYOUT });
/** Each source kind must reach its own reviewed layout: a legacy import keeps
 * __drizzle_migrations, a fresh install has none. Release-independent structure
 * is always checked; the exact reviewed layout and release pair only across
 * releases, the only clones whose gate inspects the database. */
export function assertBundleCloneLayout({ kind, databasePath, left, right }) {
  const reviewed = reviewedCloneLayouts[kind];
  assert.ok(reviewed, 'Unknown clone source layout');
  const layout = inspectNativeCloneLayout(databasePath);
  assert.equal(layout.migrationsSha256 === null, kind === 'fresh-install', `The ${kind} baseline has the wrong legacy migration journal`);
  const crossRelease = left.opencodeVersion !== right.opencodeVersion;
  if (crossRelease) {
    assert.deepEqual(layout, { ...reviewed }, `The ${kind} baseline is not the reviewed ${kind} layout`);
    assert.equal(isReviewedNativeClonePair(left, right, layout), true, `${left.opencodeVersion} → ${right.opencodeVersion} is not a reviewed clone pair`);
  }
  return { id: `compiled-clone-layout-${kind}`, status: 'passed', layout, baselineVersion: left.opencodeVersion,
    candidateVersion: right.opencodeVersion, gate: crossRelease ? 'reviewed-cross-release-layout' : 'same-release-structure-only' };
}

/** Applied native migration IDs; a clone must never move its source to another level. */
export function readNativeMigrationIDs(databasePath) {
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  try { return db.prepare('SELECT id FROM migration ORDER BY id').all().map(row => row.id); } finally { db.close(); }
}

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

/** A clone captures A's credentials through A's original controller, which
 * checkpoints any committed WAL frames when it closes. That rewrites
 * opencode.db/-wal bytes but never their data, so this snapshot compares the
 * schema and every table's rows (one readonly transaction) instead of those two
 * files; every other byte and the original history stay exact. */
export async function snapshotCheckpointedBundleSource(descriptor) {
  const closed = await snapshotClosedBundleSource(descriptor), database = ['opencode/opencode.db', 'opencode/opencode.db-wal'];
  const db = resolveSqliteDriver().open(descriptor.launch.opencodeDatabasePath, { readonly: true });
  let tables;
  try {
    db.prepare('BEGIN').run();
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    tables = { schema, rows: Object.fromEntries(schema.filter(row => row.type === 'table').map(row => [row.name,
      createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all()
        .map(value => JSON.stringify(value)).sort())).digest('hex')])) };
  } finally { try { db.prepare('ROLLBACK').run(); } finally { db.close(); } }
  return { files: closed.files.filter(row => !database.includes(row.path)), database: tables, history: closed.history,
    walBytes: closed.files.find(row => row.path === database[1]) ? (await fs.stat(descriptor.launch.opencodeDatabasePath + '-wal')).size : null,
    physical: closed.files.filter(row => database.includes(row.path)) };
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
      cloneTree(path.dirname(descriptor.launch.artifactManifestPath), target);
      try {
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
      } finally { await fs.rm(target, { recursive: true, force: true }); }
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
