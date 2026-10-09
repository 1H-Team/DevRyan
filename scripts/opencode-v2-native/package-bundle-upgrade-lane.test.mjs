import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { NATIVE_BUNDLE_CREDENTIAL_CONTRACT, nativeBundleCredentialFingerprint as fingerprint, parseNativeBundleCredentialBoot } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-contract.js';
import { runSelectedNativeLifecycle } from './package-rollback-lane.mjs';
import { emptyClaudeLifecycle } from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
import { assertBundleCloneLayout, createCompiledBundleUpgradeLane, readNativeMigrationIDs, snapshotCheckpointedBundleSource, snapshotClosedBundleSource, snapshotRetainedBundleWork } from './package-bundle-upgrade-lane.mjs';
import { REVIEWED_NATIVE_CLONE_RELEASES } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-compatibility.js';

const protocol = NATIVE_BUNDLE_CREDENTIAL_CONTRACT;
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.cache/v2-validation/bundle-upgrade-contract-'));
  const states = new Map(), intents = new Map(), observations = [], actions = [];
  const credentialProcess = async ({ descriptor, assertHeld, action }) => {
    await assertHeld();
    parseNativeBundleCredentialBoot({ protocol, requestID: 'request-fixture', instanceID: 'instance-fixture', buildID: 'b'.repeat(64),
      bundleID: descriptor.bundleID, databasePath: descriptor.launch.opencodeDatabasePath, webDataDirectory: descriptor.launch.webDataDirectory,
      globals: descriptor.launch.global, action });
    actions.push(action.action);
    const snapshot = states.get(descriptor.bundleID);
    if (action.action === 'capture') return { protocol, status: 'captured', snapshot: structuredClone(snapshot), sha256: fingerprint(snapshot) };
    const intent = fingerprint(action);
    if (intents.get(descriptor.bundleID) !== intent && fingerprint(snapshot) !== action.binding.expectedTargetSha256) {
      throw Object.assign(new Error('bundle_credential_baseline_changed'), { code: 'bundle_credential_baseline_changed' });
    }
    states.set(descriptor.bundleID, structuredClone(action.source)); intents.set(descriptor.bundleID, intent);
    return { protocol, status: 'projected', ...action.binding, appliedSha256: fingerprint(action.source) };
  };
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  const create = async bundleID => {
    const bundle = path.join(root, bundleID);
    const opencode = path.join(bundle, 'opencode'); await fs.mkdir(opencode, { recursive: true });
    const database = path.join(opencode, 'opencode.db'); await fs.writeFile(database, '');
    const db = resolveSqliteDriver().open(database);
    db.exec('CREATE TABLE session_v2(id TEXT PRIMARY KEY); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,seq INTEGER,data TEXT)'); db.close();
    const descriptor = { bundleID, preparedManifestPath: path.join(bundle, 'prepared.json'), projectMap: [{ directory, targetDirectory: directory }],
      launch: { opencodeDatabasePath: database, webDataDirectory: path.join(bundle, 'web-data'), artifactManifestSha256: 'c'.repeat(64),
        global: Object.fromEntries(['home','config','data','state','cache','tmp','bin','log','repos'].map(key => [key,path.join(bundle,key === 'config' ? 'config/opencode' : 'global/'+key)])) } };
    states.set(bundleID, { protocol, credentials: [], refreshBlockState: null, claudeLifecycle: emptyClaudeLifecycle() }); return descriptor;
  };
  return { root, states, intents, actions, observations, credentialProcess, create, lane: createCompiledBundleUpgradeLane({ observations, credentialProcess }) };
}
const held = async () => {};
const history = (descriptor, id) => {
  const db = resolveSqliteDriver().open(descriptor.launch.opencodeDatabasePath);
  try { db.prepare('INSERT INTO session_v2 VALUES (?)').run(id); db.prepare('INSERT INTO session_message VALUES (?,?,?,?)').run('msg_'+id,id,1,'synthetic history'); }
  finally { db.close(); }
};

test('private compiled-lane contract retains lost ACK evidence and reconciles the persisted projection from a fresh B lane without merging A history', async () => {
  const f = await fixture();
  try {
    const a = await f.create('baseline'); await f.lane.seedBaseline(a, held); history(a, 'ses_a');
    assert.deepEqual(f.states.get(a.bundleID).credentials.map(row=>row.integrationID),['devryan-credential-fixture-removed','devryan-credential-fixture-selected']);
    const before = await f.lane.captureCredentials({ descriptor: a, assertHeld: held });
    const b = await f.create('candidate'); b.sourceBundleID = a.bundleID;
    await fs.copyFile(a.launch.opencodeDatabasePath,b.launch.opencodeDatabasePath);
    f.states.set(b.bundleID, structuredClone(f.states.get(a.bundleID)));
    const sources = path.join(path.dirname(b.preparedManifestPath), 'sources'); await fs.mkdir(sources);
    await fs.writeFile(path.join(sources,'clone.json'),JSON.stringify({ sourceBundleID:a.bundleID,sourceCredentialSha256:before.sha256,compatibility:{protocol:'devryan-v2-clone/1'} }));
    assert.equal((await f.lane.assertClone({ baseline:a,candidate:b })).status,'passed');
    await f.lane.rotateCandidate(b, held); history(b,'ses_b');
    const candidate = await f.lane.captureCredentials({ descriptor:b,assertHeld:held });
    const credentialBinding = { sourceBundleID:b.bundleID,targetBundleID:a.bundleID,targetManifestSha256:a.launch.artifactManifestSha256,
      expectedTargetSha256:before.sha256,sourceSha256:candidate.sha256 };
    const input = { candidate:b,target:a,credentialBinding,assertHeld:held };
    assert.deepEqual(await f.lane.reconcileRollback(input), {status:'blocked',reason:'bundle_credential_ack_lost'});
    const lost = await f.lane.assertRollbackRetention(b);
    assert.equal(lost.staleBaselineRefused, true);
    const fresh = createCompiledBundleUpgradeLane({ observations:f.observations, credentialProcess:f.credentialProcess, rollbackPhase:'complete' });
    fresh.restoreRollbackBaseline(a);
    await fresh.captureCredentials({ descriptor:b,assertHeld:held });
    const retried = await fresh.reconcileRollback(input);
    assert.deepEqual(retried.credentialReceipt,{protocol,status:'projected',...credentialBinding,appliedSha256:candidate.sha256});
    assert.equal((await fresh.assertRollbackRetention(b)).historyMerged,false);
    assert.deepEqual(f.states.get(a.bundleID),candidate.snapshot);
    assert.equal(candidate.snapshot.credentials.some(row=>row.id==='cred_fixtureRemoved'),false);
    assert.deepEqual(candidate.snapshot.credentials.filter(row=>row.active).map(row=>row.id),['cred_fixtureNewSelected']);
    assert.equal(candidate.snapshot.refreshBlockState.blocked,true);
    assert.ok(candidate.snapshot.credentials.every(row=>row.integrationID==='devryan-credential-fixture-selected'));
    assert.ok(f.actions.includes('project')); assert.doesNotMatch(JSON.stringify(f.observations),/synthetic-access|synthetic-refresh/);
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

test('open checkpoint and invalid closed history refuse instead of claiming a compiled clone', async () => {
  const f = await fixture();
  try {
    const a = await f.create('baseline');
    await assert.rejects(f.lane.seedBaseline(a,async()=>{throw new Error('fixture_admission_open');}),/fixture_admission_open/);
    assert.deepEqual(f.actions,[]);
    const b = await f.create('candidate');b.sourceBundleID=a.bundleID;
    await assert.rejects(f.lane.assertClone({baseline:a,candidate:b}));
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

test('closed bundle source ignores only exact transient SHM and retains durable bytes and original history',async()=>{
 const f=await fixture();
 try{
  const a=await f.create('baseline');history(a,'ses_original');
  const directory=path.dirname(a.preparedManifestPath),shm=a.launch.opencodeDatabasePath+'-shm';
  await fs.writeFile(shm,'transient-index-A');
  const before=await snapshotClosedBundleSource(a);
  await fs.writeFile(shm,'transient-index-B');
  assert.deepEqual(await snapshotClosedBundleSource(a),before);
  await fs.writeFile(path.join(directory,'retained.txt'),'changed durable source');
  assert.notDeepEqual(await snapshotClosedBundleSource(a),before);
  await fs.rm(path.join(directory,'retained.txt'));
  history(a,'ses_new');
  const after=await snapshotClosedBundleSource(a);assert.notDeepEqual(after.history,before.history);
  assert.notDeepEqual(after.files,before.files);
  assert.ok(before.files.some(row=>row.path==='opencode/opencode.db'));
  assert.ok(before.files.every(row=>row.path!=='opencode/opencode.db-shm'));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});


test('fresh-composition work snapshot retains original history, configuration, home, project and immutable metadata', async () => {
  const f = await fixture();
  try {
    const b = await f.create('candidate'); history(b, 'ses_retained');
    const root = path.dirname(b.preparedManifestPath);
    b.launch.webConfigDirectory = path.join(root, 'web-config');
    for (const directory of [path.join(root, 'sources'), b.launch.global.home, b.launch.global.config, b.launch.webConfigDirectory]) await fs.mkdir(directory, {recursive:true});
    for (const file of ['descriptor.json','prepared.json']) await fs.writeFile(path.join(root,file),'immutable '+file);
    const config = path.join(b.launch.global.config, 'opencode.json'); await fs.writeFile(config,'saved configuration');
    const registration = path.join(root, 'config', 'reviewed-plugins.json'); await fs.writeFile(registration, 'saved registration');
    const projectFile = path.join(f.root,'project','retained.txt'); await fs.writeFile(projectFile,'retained work');
    const before = await snapshotRetainedBundleWork(b);
    await fs.mkdir(path.join(root,'.native-controller'),{recursive:true});
    await fs.writeFile(path.join(root,'.native-controller','new-owner-receipt.json'),'actual new owner receipt');
    assert.deepEqual(await snapshotRetainedBundleWork(b), before, 'A new lifecycle receipt is separate from durable work');
    for (const file of [config, registration, projectFile, path.join(root,'prepared.json')]) {
      const bytes = await fs.readFile(file); await fs.writeFile(file,'changed');
      assert.notDeepEqual(await snapshotRetainedBundleWork(b), before);
      await fs.writeFile(file,bytes);
    }
    history(b,'ses_changed'); assert.notDeepEqual(await snapshotRetainedBundleWork(b), before);
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});


test('selected lifecycle identity failure closes its actual owned child before propagating the original failure', async () => {
  const f = await fixture();
  try {
    const descriptor = await f.create('candidate'), logFile = path.join(f.root, 'identity-failure.log');
    let pid;
    const original = Object.assign(new Error('fixture_identity_unavailable'), {code:'fixture_identity_unavailable'});
    await assert.rejects(runSelectedNativeLifecycle({controlRoot:f.root,descriptor,configuration:{},
      fixture:{root:f.root,environment:{}},logFile,readProcessIdentity:childPID=>{pid=childPID;throw original;}}),
      error=>error===original);
    assert.ok(pid > 0);
    assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
    const exit = JSON.parse(await fs.readFile(logFile+'.exit.json','utf8'));
    assert.equal(exit.pid,pid); assert.equal(exit.signal,'SIGTERM'); assert.equal(exit.timedOut,false);
    assert.equal(exit.failure,'selected_native_lifecycle_failed'); assert.equal(exit.hostIdentity,null);
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});


test('each clone source kind keeps its own layout; only a cross-release pair must match the exact reviewed layout', async () => {
  const root = await fs.mkdtemp(path.resolve('.cache/v2-validation/bundle-clone-layout-'));
  const release = version => ({ opencodeVersion: version, inputs: { coreDigest: REVIEWED_NATIVE_CLONE_RELEASES[version] } });
  const database = async (name, sql) => {
    const file = path.join(root, name); await fs.writeFile(file, '');
    const db = resolveSqliteDriver().open(file); try { db.exec(sql); } finally { db.close(); }
    return file;
  };
  try {
    const fresh = await database('fresh.db', 'CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);'
      + "INSERT INTO migration VALUES ('20260127222353_b',2),('20260127222353_a',1)");
    const legacy = await database('legacy.db', 'CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);'
      + 'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL, name TEXT NOT NULL)');
    const same = { left: release('2.0.26'), right: release('2.0.26') }, cross = { left: release('2.0.20'), right: release('2.0.26') };
    const freshCase = assertBundleCloneLayout({ kind: 'fresh-install', databasePath: fresh, ...same });
    assert.equal(freshCase.id, 'compiled-clone-layout-fresh-install'); assert.equal(freshCase.gate, 'same-release-structure-only');
    assert.equal(freshCase.layout.migrationsSha256, null);
    const legacyCase = assertBundleCloneLayout({ kind: 'legacy', databasePath: legacy, ...same });
    assert.match(legacyCase.layout.migrationsSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => assertBundleCloneLayout({ kind: 'fresh-install', databasePath: legacy, ...same }), /wrong legacy migration journal/);
    assert.throws(() => assertBundleCloneLayout({ kind: 'legacy', databasePath: fresh, ...same }), /wrong legacy migration journal/);
    // Neither synthetic DDL is a reviewed layout, so a cross-release pair refuses both.
    assert.throws(() => assertBundleCloneLayout({ kind: 'fresh-install', databasePath: fresh, ...cross }), /not the reviewed fresh-install layout/);
    assert.throws(() => assertBundleCloneLayout({ kind: 'legacy', databasePath: legacy, ...cross }), /not the reviewed legacy layout/);
    assert.throws(() => assertBundleCloneLayout({ kind: 'imported', databasePath: fresh, ...same }), /Unknown clone source layout/);
    assert.deepEqual(readNativeMigrationIDs(fresh), ['20260127222353_a', '20260127222353_b']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('checkpoint-aware source snapshot ignores only a WAL drain and still detects data and durable-file changes', async () => {
  const f = await fixture();
  try {
    const a = await f.create('baseline'); history(a, 'ses_original');
    const writer = resolveSqliteDriver().open(a.launch.opencodeDatabasePath);
    try {
      writer.pragma('journal_mode=WAL'); writer.pragma('wal_autocheckpoint=0');
      writer.prepare('INSERT INTO session_v2 VALUES (?)').run('ses_pending_in_wal');
      const before = await snapshotCheckpointedBundleSource(a);
      assert.ok(before.walBytes > 0);
      assert.deepEqual(before.history.sessions.map(row => row.id), ['ses_original', 'ses_pending_in_wal']);
      writer.pragma('wal_checkpoint(TRUNCATE)');
      const after = await snapshotCheckpointedBundleSource(a);
      assert.equal(after.walBytes, 0); assert.notDeepEqual(after.physical, before.physical);
      const strip = ({ physical, walBytes, ...data }) => data;
      assert.deepEqual(strip(after), strip(before));
      writer.prepare('INSERT INTO session_message VALUES (?,?,?,?)').run('msg_new', 'ses_original', 2, 'changed data');
      assert.notDeepEqual(strip(await snapshotCheckpointedBundleSource(a)).database, strip(before).database);
    } finally { writer.close(); }
    await fs.writeFile(path.join(path.dirname(a.preparedManifestPath), 'retained.txt'), 'changed durable source');
    assert.ok((await snapshotCheckpointedBundleSource(a)).files.some(row => row.path === 'retained.txt'));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
