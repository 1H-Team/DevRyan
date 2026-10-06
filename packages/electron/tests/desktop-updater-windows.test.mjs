import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeWindowsUpdate, rollbackWindowsUpdate, windowsUpdateStore, validateWindowsUpdateIntent } from '../desktop-update-install-windows.mjs';
import { createWindowsNsisInstaller } from '../desktop-updater-windows.mjs';
import { isWindowsUpdatePath, parseWindowsUpdateTree, parseWindowsUpdateFile, parseWindowsNsisReceipt } from '../windows-update-owner.mjs';

const failure = code => Object.assign(new Error(code), { code });
const token = digit => `${'1'.repeat(16)}:${digit.repeat(32)}:${digit.repeat(64)}:100:2`;
const fileToken = digit => `${'1'.repeat(16)}:${digit.repeat(32)}:${digit.repeat(64)}:100`;
const start = 'win32:1111111111111111';
const nonce = 'a'.repeat(32);
const target = 'C:\\Apps\\DevRyan', backup = `C:\\Apps\\.DevRyan-${nonce}-backup`, failed = `C:\\Apps\\.DevRyan-${nonce}-failed`;
const intentPath = 'C:\\Updates\\state\\install-intent.json';
function fixture(changes = {}) {
  let revision = 0, interrupted = false, released = 0, held = 0;
  const records = new Map(), trees = new Map([[target, token('2')], [backup, token('3')]]), identities = new Map();
  const registration = { version: '2.0.2', restores: [] };
  const settled = { protocol: 'devryan.windows-nsis-owner/1', status: 'settled', nonce, exitCode: 0, terminated: true, namespaceFlushed: true, targetToken: token('4') };
  const intent = { protocol: 'devryan.windows-desktop-update/1', phase: 'prepared', nonce, arch: 'x64', version: '2.0.3', previousVersion: '2.0.2',
    sha256: 'a'.repeat(64), helperSha256: 'b'.repeat(64), launcherSha256: 'c'.repeat(64), size: 100, ownerPID: 123, ownerStart: start,
    previousToken: token('2'), backupToken: token('3'), target, backup, failed, file: 'C:\\Updates\\installer.exe', helper: 'C:\\Updates\\helper\\install.mjs',
    launcher: 'C:\\Updates\\helper\\owner.exe', receipt: 'C:\\Updates\\receipt\\native.json', helperToken: fileToken('b'), launcherToken: fileToken('c'), ...changes };
  const put = (file, bytes) => { const buffer = Buffer.from(bytes); const record = { bytes: buffer, revision: ++revision, volume: '1'.repeat(16), fileId: '2'.repeat(32), sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length }; records.set(file, record); return record; };
  put(intentPath, JSON.stringify(intent)); put(intent.receipt, JSON.stringify(settled));
  identities.set(process.pid, { active: true, startIdentity: start });
  const owner = {
    read: async file => { const value = records.get(file); if (!value) throw failure('ENOENT'); return value; },
    write: async (file, bytes, options = {}) => { if (Object.hasOwn(options, 'expected') && (records.get(file)?.revision ?? null) !== (options.expected?.revision ?? null)) throw failure('private_file_changed'); return put(file, bytes); },
    tree: async file => { if (!trees.has(file)) throw failure('ENOENT'); return trees.get(file); },
    version: async file => ({ version: file === backup || [token('2'), token('3')].includes(trees.get(file)) ? '2.0.2' : '2.0.3', arch: 'x64' }),
    processIdentity: async pid => identities.get(pid) ?? null,
    waitOwner: async () => ({ settled: Promise.resolve() }),
    holdInstaller: async () => { held++; return { pid: 456, start, install: async () => { trees.set(target, settled.targetToken); registration.version = '2.0.3'; return { ...settled }; }, release: () => { released++; } }; },
    restoreRegistration: async (file, expected, previousVersion, installedVersion) => {
      assert.equal(file, target); assert.equal(trees.get(file), expected); assert.equal(expected, token('3'));
      assert.equal(previousVersion, '2.0.2'); assert.equal(installedVersion, '2.0.3');
      assert.equal(JSON.parse(records.get(intentPath).bytes).phase, 'restoring-backup');
      registration.restores.push({ file, expected, previousVersion, installedVersion });
      if (owner.registrationFailure) throw failure(owner.registrationFailure);
      if (![previousVersion, installedVersion].includes(registration.version)) throw failure('update_registration_changed');
      registration.version = previousVersion;
    },
    rename: async (from, to, expected) => { if (trees.get(from) !== expected || trees.has(to)) throw failure('update_installation_changed'); trees.set(to, trees.get(from)); trees.delete(from); if (owner.interruptAt === to && !interrupted) { interrupted = true; throw failure('simulated_restart'); } },
    holdInputs: async () => ({ assertHeld() {}, release: async () => {} }),
  };
  const store = windowsUpdateStore(owner, intentPath);
  return { owner, store, intent, intentPath, settled, trees, identities, records, put, registration, held: () => held, released: () => released,
    current: async () => (await store.inspect()).intent };
}
const installed = () => { const f = fixture(); f.trees.set(target, token('4')); f.put(intentPath, JSON.stringify({ ...f.intent, phase: 'installed', settled: f.settled, candidateToken: token('4') })); return f; };

test('native installer settlement and registered candidate readiness complete the actual state engine', async () => {
  const f = fixture();
  const result = await executeWindowsUpdate({ ...f, launch: async () => { await f.store.mutate(nonce, ['launching'], { phase: 'accepted', candidatePID: 789, candidateStart: start }); return { pid: 789, start }; } });
  assert.equal(result.phase, 'complete'); assert.equal(f.held(), 1); assert.equal(f.released(), 1); assert.equal(f.trees.get(backup), token('3'));
});
function preparation(f, currentVersion = '2.0.2') {
  f.owner.launcher = 'C:\\Runtime\\owner.exe';
  f.owner.ensureDirectory = async file => { if (!f.trees.has(file)) f.trees.set(file, token('6')); return { volume: '1'.repeat(16), fileId: '6'.repeat(32) }; };
  f.owner.namespace = async () => ({ directoryFlushed: true });
  f.owner.file = async () => ({ size: 100, token: fileToken('a') });
  f.owner.clone = async (from, to, expected) => { assert.equal(f.trees.get(from), expected); assert.equal(f.trees.has(to), false); f.trees.set(to, token('3')); return token('3'); };
  f.owner.version = async () => ({ version: currentVersion, arch: 'x64' });
  f.owner.remove = async (file, expected) => { assert.equal(f.trees.get(file), expected); f.trees.delete(file); };
  return createWindowsNsisInstaller({ owner: f.owner, installedDirectory: target, currentVersion, cacheDirectory: 'C:\\Updates', arch: 'x64', verifyNativeArtifacts: async () => {}, readSource: async () => Buffer.from('bundled helper source') });
}
test('preparation persists its unactivated intent before cloning and records each completed proof', async () => {
  const f = fixture(); f.records.delete(intentPath); const installer = preparation(f); const clone = f.owner.clone;
  f.owner.clone = async (...args) => { const current = await f.current(); assert.equal(current.phase, 'preparing'); assert.equal(current.backupToken, null); assert.equal(current.helperToken, null); return clone(...args); };
  const prepared = await installer.prepare({ file: f.intent.file, update: { version: '2.0.3', size: 100, sha256: 'a'.repeat(64) } });
  const current = await f.current(); assert.equal(current.phase, 'prepared'); assert.equal(current.nonce, prepared.nonce); assert.equal(current.backupToken, token('3')); assert.equal(typeof current.helperToken, 'string'); assert.equal(typeof current.launcherToken, 'string');
});
test('interrupted clone remains a preparing intent and the unchanged previous app can boot', async () => {
  const f = fixture(); f.records.delete(intentPath); const installer = preparation(f);
  f.owner.clone = async () => { throw failure('simulated_restart'); };
  await assert.rejects(installer.prepare({ file: f.intent.file, update: { version: '2.0.3', size: 100, sha256: 'a'.repeat(64) } }), { code: 'simulated_restart' });
  assert.equal((await f.current()).phase, 'preparing'); assert.equal(await installer.beginStartup(), false);
  await assert.rejects(installer.prepare({ file: f.intent.file, update: { version: '2.0.3', size: 100, sha256: 'a'.repeat(64) } }), { code: 'update_installation_pending' });
});
for (const phase of ['prepared', 'waiting-for-owner']) test(`unstarted ${phase} from a dead original owner aborts durably and lets the exact previous app boot`, async () => {
  const f = fixture({ phase, ...(phase === 'waiting-for-owner' ? { helperPID: 456, helperStart: start, nativePID: 567, nativeStart: start } : {}) });
  const installer = preparation(f); assert.equal(await installer.beginStartup(), false); assert.equal(installer.isRecoveryStartup(), false);
  assert.equal((await f.current()).phase, 'aborted'); assert.equal(f.trees.get(target), token('2')); assert.equal(f.trees.get(backup), token('3'));
});
test('unstarted prepared intent preserves the pending attempt while its exact original owner remains active', async () => {
  const f = fixture(); f.identities.set(123, { active: true, startIdentity: start });
  assert.equal(await preparation(f).beginStartup(), false); assert.equal((await f.current()).phase, 'prepared');
});
test('waiting installer with exact active native creation identity prevents previous-app boot', async () => {
  const f = fixture({ phase: 'waiting-for-owner', nativePID: 567, nativeStart: start }); f.identities.set(567, { active: true, startIdentity: start });
  await assert.rejects(preparation(f).beginStartup(), { code: 'update_installation_pending' }); assert.equal((await f.current()).phase, 'waiting-for-owner');
});
test('uncertain native liveness never becomes an unstarted installer abort', async () => {
  const f = fixture({ phase: 'waiting-for-owner', nativePID: 567, nativeStart: start }), identity = f.owner.processIdentity;
  f.owner.processIdentity = async pid => { if (pid === 567) throw failure('update_native_operation_refused'); return identity(pid); };
  await assert.rejects(preparation(f).beginStartup(), { code: 'update_native_operation_refused' }); assert.equal((await f.current()).phase, 'waiting-for-owner');
});
test('previous app boot refuses tree drift even when an installer was never authorized', async () => {
  const f = fixture(); f.trees.set(target, token('5'));
  await assert.rejects(preparation(f).beginStartup(), { code: 'update_installation_changed' }); assert.equal((await f.current()).phase, 'prepared');
});
test('finalized exact completed artifacts permit a subsequent update', async () => {
  const f = installed();
  await f.store.mutate(nonce, ['installed'], { phase: 'complete', helperTreeToken: token('6'), receiptParent: token('7').slice(0, 49) });
  f.trees.set('C:\\Updates\\helper', token('6')); f.trees.set('C:\\Updates\\receipt', token('7'));
  const installer = preparation(f, '2.0.3'); await installer.finalizeCompleted();
  assert.equal((await f.current()).cleanupComplete, true); assert.equal(f.trees.has(backup), false); assert.equal(f.trees.has('C:\\Updates\\helper'), false);
  const second = await installer.prepare({ file: f.intent.file, update: { version: '2.0.4', size: 100, sha256: 'a'.repeat(64) } });
  assert.notEqual(second.nonce, nonce); assert.equal((await f.current()).phase, 'prepared');
});
test('cleanup refuses changed retained helper artifacts and never marks cleanup complete', async () => {
  const f = installed(); await f.store.mutate(nonce, ['installed'], { phase: 'complete', helperTreeToken: token('6') }); f.trees.set('C:\\Updates\\helper', token('5'));
  const installer = preparation(f, '2.0.3'); await assert.rejects(installer.finalizeCompleted(), { code: 'update_cleanup_identity_changed' });
  assert.equal((await f.current()).cleanupComplete, undefined); assert.equal(f.trees.get('C:\\Updates\\helper'), token('5'));
});
test('intent record publication compares the constructor-owned SDK receipt', async () => {
  const f = fixture(), original = f.owner.write;
  f.owner.write = async (file, bytes, options) => { f.put(file, JSON.stringify(f.intent)); return original(file, bytes, options); };
  await assert.rejects(f.store.mutate(nonce, ['prepared'], { phase: 'installing' }), { code: 'private_file_changed' });
});
test('failed native installer rolls back only its settled target tree', async () => {
  const f = fixture(); f.settled.exitCode = 1; f.put(f.intent.receipt, JSON.stringify(f.settled));
  const result = await executeWindowsUpdate({ ...f, launch: async () => assert.fail('failed installer must not launch') });
  assert.equal(result.phase, 'rolled-back'); assert.equal(f.trees.get(target), token('3')); assert.equal(f.trees.get(failed), token('4'));
  assert.equal(f.registration.version, '2.0.2'); assert.equal(f.registration.restores.length, 1);
});
test('registration restoration failure retains restoring-backup and resumes against the already restored tree', async () => {
  const f = installed(); f.registration.version = '2.0.3'; f.owner.registrationFailure = 'update_registration_changed';
  await assert.rejects(rollbackWindowsUpdate({ ...f, intent: await f.current() }), { code: 'update_registration_changed' });
  assert.equal((await f.current()).phase, 'restoring-backup'); assert.equal(f.trees.get(target), token('3')); assert.equal(f.registration.version, '2.0.3');
  assert.equal(f.trees.has(backup), false); assert.equal(f.registration.restores.length, 1);
  delete f.owner.registrationFailure;
  assert.equal((await rollbackWindowsUpdate({ ...f, intent: await f.current() })).phase, 'rolled-back');
  assert.equal(f.registration.version, '2.0.2'); assert.equal(f.registration.restores.length, 2);
});
test('changed per-user installer registration is never silently overwritten by rollback', async () => {
  const f = installed(); f.registration.version = '9.9.9';
  await assert.rejects(rollbackWindowsUpdate({ ...f, intent: await f.current() }), { code: 'update_registration_changed' });
  assert.equal((await f.current()).phase, 'restoring-backup'); assert.equal(f.registration.version, '9.9.9');
});
for (const key of ['terminated', 'namespaceFlushed']) test(`rollback rejects false ${key} settlement`, async () => {
  const f = installed(), current = await f.current(); current.settled[key] = false;
  await assert.rejects(rollbackWindowsUpdate({ ...f, intent: current }), { code: 'update_termination_unconfirmed' }); assert.equal(f.trees.get(target), token('4'));
});
test('rollback rejects a missing or different durable receipt', async () => {
  const f = installed(); f.records.delete(f.intent.receipt);
  await assert.rejects(rollbackWindowsUpdate({ ...f, intent: await f.current() }), { code: 'ENOENT' });
  f.put(f.intent.receipt, JSON.stringify({ ...f.settled, targetToken: token('5') }));
  await assert.rejects(rollbackWindowsUpdate({ ...f, intent: await f.current() }), { code: 'update_termination_unconfirmed' });
});
test('candidate creation with uncertain identity keeps both trees for recovery', async () => {
  const f = fixture();
  await assert.rejects(executeWindowsUpdate({ ...f, launch: async () => ({ pid: 789, start: 'unknown' }) }), { code: 'update_candidate_identity_unconfirmed' });
  assert.equal((await f.current()).phase, 'held'); assert.equal(f.trees.get(target), token('4')); assert.equal(f.trees.get(backup), token('3'));
});
test('proven candidate not created rolls back instead of holding a launch', async () => {
  const f = fixture(); const result = await executeWindowsUpdate({ ...f, launch: async () => { throw failure('update_candidate_not_created'); } });
  assert.equal(result.phase, 'rolled-back'); assert.equal(result.candidateNotCreated, true);
});
test('candidate shutdown receipt alone does not permit rollback while exact process remains active', async () => {
  const f = installed(); await f.store.mutate(nonce, ['installed'], { candidateLaunchAttempted: true, candidatePID: 789, candidateStart: start, candidateStopped: true });
  f.identities.set(789, { active: true, startIdentity: start });
  await assert.rejects(rollbackWindowsUpdate({ ...f, intent: await f.current() }), { code: 'update_termination_unconfirmed' });
  f.identities.set(789, { active: false, startIdentity: start });
  assert.equal((await rollbackWindowsUpdate({ ...f, intent: await f.current() })).phase, 'rolled-back');
});
for (const destination of [failed, target]) test(`rollback restarts safely after committed rename to ${destination === target ? 'target' : 'failed'}`, async () => {
  const f = installed(); f.owner.interruptAt = destination;
  await assert.rejects(rollbackWindowsUpdate({ ...f, intent: await f.current() }), { code: 'simulated_restart' });
  assert.equal((await rollbackWindowsUpdate({ ...f, intent: await f.current() })).phase, 'rolled-back'); assert.equal(f.trees.get(target), token('3'));
});
test('recovery consumes native receipt committed before JS intent publication and acknowledges the drain owner', async () => {
  const f = fixture({ phase: 'installing', recoveryOwnerPID: 123, recoveryOwnerStart: start }); f.trees.set(target, token('4')); let acknowledged = false, drained = false;
  f.owner.waitOwner = async (pid, identity) => { assert.equal(pid, 123); assert.equal(identity, start); return { settled: Promise.resolve().then(() => { drained = true; }) }; };
  const result = await executeWindowsUpdate({ ...f, recover: true, acknowledge: () => { acknowledged = true; }, launch: async () => assert.fail('recovery does not launch') });
  assert.equal(result.phase, 'rolled-back'); assert.equal(acknowledged, true); assert.equal(drained, true);
});
test('rollback refuses changed candidate and backup tree identities', async () => {
  for (const file of [target, backup]) { const f = installed(); f.trees.set(file, token('5')); await assert.rejects(rollbackWindowsUpdate({ ...f, intent: await f.current() }), { code: file === target ? 'update_installation_changed' : 'update_backup_changed' }); assert.equal(f.trees.get(file), token('5')); }
});
test('post-settlement mutation is refused before launching the candidate', async () => {
  const f = fixture(), version = f.owner.version; f.owner.version = async file => { const value = await version(file); if (file === target) f.trees.set(target, token('5')); return value; };
  await assert.rejects(executeWindowsUpdate({ ...f, launch: async () => assert.fail('changed installation must not launch') }), { code: 'update_installation_changed' });
  assert.equal(f.trees.get(target), token('5'));
});
test('candidate startup binds nonce, executable tree and process creation identity before acceptance', async () => {
  const f = installed(); await f.store.mutate(nonce, ['installed'], { phase: 'launching' });
  const installer = createWindowsNsisInstaller({ owner: f.owner, installedDirectory: target, currentVersion: '2.0.3', cacheDirectory: 'C:\\Updates', arch: 'x64', verifyNativeArtifacts: async () => {} });
  assert.equal(await installer.beginStartup(nonce), true); await installer.acceptStartup(); assert.equal((await f.current()).phase, 'accepted');
});
test('helper hold failure prevents detached spawn', async () => {
  const f = fixture(); f.owner.holdInputs = async () => { throw failure('update_helper_changed'); };
  const installer = createWindowsNsisInstaller({ owner: f.owner, installedDirectory: target, currentVersion: '2.0.2', cacheDirectory: 'C:\\Updates', arch: 'x64', verifyNativeArtifacts: async () => {}, spawnImpl: () => assert.fail('unheld helper must not spawn') });
  await assert.rejects(installer.launchPrepared({ nonce }), { code: 'update_helper_changed' });
});
test('lost native helper hold after ACK refuses publication and releases the acquired hold', async () => {
  const f = fixture(); let released = false;
  f.owner.holdInputs = async () => ({ assertHeld: () => { throw failure('update_helper_hold_lost'); }, release: async () => { released = true; } });
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ protocol: f.intent.protocol, nonce, status: 'waiting' }) + '\n')));
    return child;
  };
  const installer = createWindowsNsisInstaller({ owner: f.owner, installedDirectory: target, currentVersion: '2.0.2', cacheDirectory: 'C:\\Updates', arch: 'x64', verifyNativeArtifacts: async () => {}, spawnImpl });
  await assert.rejects(installer.launchPrepared({ nonce }), { code: 'update_helper_hold_lost' }); assert.equal(released, true);
});
test('relocated self-contained Windows helper bundle loads in a real isolated Node process', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await fs.mkdtemp(path.join(root, '.cache/test-fixtures/windows-helper-bundle-'));
  try {
    const output = path.join(directory, 'relocated-install.mjs');
    await promisify(execFile)('bun', ['build', fileURLToPath(new URL('../desktop-update-install-windows.mjs', import.meta.url)), '--target', 'node', '--outfile', output], { cwd: root, maxBuffer: 65536 });
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', 'const module = await import(process.argv[2]); if (typeof module.executeWindowsUpdate !== "function") process.exit(2);', 'import-only', pathToFileURL(output).href], { cwd: directory, maxBuffer: 65536 });
    assert.equal(child.stderr, '');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('Windows path and SDK receipt parsers refuse aliases, wrong platform tokens and false durability', () => {
  assert.equal(isWindowsUpdatePath('C:\\Apps\\DevRyan'), true);
  for (const value of ['C:DevRyan', 'C:\\Apps\\..\\DevRyan', '\\\\server\\share\\DevRyan', 'C:\\Apps\\DevRyan\n']) assert.equal(isWindowsUpdatePath(value), false);
  assert.throws(() => parseWindowsUpdateTree(JSON.stringify({ protocol: 'devryan.windows-update-tree/1', namespaceFlushed: false, token: token('2') }), true), { code: 'update_tree_unverified' });
  assert.throws(() => parseWindowsUpdateFile(JSON.stringify({ protocol: 'devryan.windows-update-file/1', size: 101, token: fileToken('2') })), { code: 'update_file_unverified' });
  assert.throws(() => parseWindowsNsisReceipt({ ...fixture().settled, nonce: 'b'.repeat(32) }, nonce), { code: 'update_termination_unconfirmed' });
  assert.throws(() => validateWindowsUpdateIntent({ ...fixture().intent, helperToken: fileToken('a') }), { code: 'update_intent_invalid' });
});
