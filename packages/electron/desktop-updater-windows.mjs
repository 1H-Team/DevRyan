import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateWindowsUpdateIntent, windowsUpdateStore } from './desktop-update-install-windows.mjs';
import { isWindowsUpdatePath } from './windows-update-owner.mjs';

const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileToken = receipt => `${receipt.volume}:${receipt.fileId}:${receipt.sha256}:${receipt.size}`;
export function createWindowsNsisInstaller({ installedDirectory, currentVersion, cacheDirectory, arch = process.arch,
  owner, verifyNativeArtifacts, executable = process.execPath, spawnImpl = spawn, onRollbackRequested = async () => {}, readSource = fs.readFile,
  helperSource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop-update-install-windows.mjs') }) {
  if (!isWindowsUpdatePath(installedDirectory) || !isWindowsUpdatePath(cacheDirectory) || path.win32.basename(installedDirectory) !== 'DevRyan'
    || !['x64', 'arm64'].includes(arch) || !owner || typeof verifyNativeArtifacts !== 'function') throw fail('update_installation_readonly');
  const stateDirectory = path.win32.join(cacheDirectory, 'state'), intentPath = path.win32.join(stateDirectory, 'install-intent.json');
  const store = windowsUpdateStore(owner, intentPath);
  let startup = null, polling = null, rollbackRequested = false, recoveryStartup = false;
  const verify = async (target, version) => {
    const identity = await owner.version(target);
    if (identity.version !== version || identity.arch !== arch) throw fail('update_version_unverified');
    await verifyNativeArtifacts({ target, arch });
  };
  const inspect = async () => (await store.inspect())?.intent ?? null;
  const finalizeCompleted = async () => {
    const intent = await inspect();
    if (!intent || !['complete', 'rolled-back', 'aborted'].includes(intent.phase) || intent.cleanupComplete) return;
    const expected = intent.phase === 'complete' ? intent.candidateToken : intent.phase === 'rolled-back' ? intent.backupToken : intent.previousToken;
    const version = intent.phase === 'complete' ? intent.version : intent.previousVersion;
    if (intent.target !== installedDirectory || version !== currentVersion || await owner.tree(installedDirectory) !== expected) throw fail('update_installation_changed');
    await verify(installedDirectory, currentVersion);
    for (const prefix of ['owner', 'helper', 'native']) {
      if (!intent[`${prefix}PID`]) continue;
      const process_ = await owner.processIdentity(intent[`${prefix}PID`]);
      if (process_?.active && process_.startIdentity === intent[`${prefix}Start`]) return;
    }
    await owner.write(path.win32.join(stateDirectory, 'last-completed.json'), Buffer.from(JSON.stringify(intent) + '\n'));
    const removeKnown = async (target, token) => {
      const actual = await owner.tree(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!actual) return;
      if (actual !== token) throw fail('update_cleanup_identity_changed'); await owner.remove(target, token);
    };
    if (intent.phase === 'complete') await removeKnown(intent.backup, intent.backupToken);
    else if (intent.phase === 'rolled-back') await removeKnown(intent.failed, intent.failedToken);
    await removeKnown(path.win32.dirname(intent.helper), intent.helperTreeToken);
    const receiptDirectory = path.win32.dirname(intent.receipt);
    const receiptTree = await owner.tree(receiptDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (receiptTree) {
      if (receiptTree.slice(0, 49) !== intent.receiptParent) throw fail('update_cleanup_identity_changed');
      if (intent.settled) {
        const receipt = await owner.read(intent.receipt);
        if (JSON.stringify(JSON.parse(receipt.bytes.toString('utf8'))) !== JSON.stringify(intent.settled)) throw fail('update_cleanup_identity_changed');
      }
      await owner.remove(receiptDirectory, receiptTree);
    }
    await store.mutate(intent.nonce, [intent.phase], { cleanupComplete: true });
  };
  const prepare = async ({ file, update }) => {
    // The production artifact verifier still refuses unqualified Windows core
    // artifacts. The private SDK owner cannot create execution admission.
    await verify(installedDirectory, currentVersion);
    await owner.ensureDirectory(cacheDirectory); await owner.ensureDirectory(stateDirectory);
    const previous = await store.inspect();
    if (previous && (!['complete', 'rolled-back', 'aborted'].includes(previous.intent.phase) || !previous.intent.cleanupComplete)) throw fail('update_installation_pending');
    const namespace = await owner.namespace(path.win32.join(path.win32.dirname(installedDirectory), '.DevRyan-durability-probe'));
    if (namespace.directoryFlushed !== true) throw fail('update_namespace_durability_unavailable');
    const nonce = randomUUID().replaceAll('-', ''), previousToken = await owner.tree(installedDirectory);
    const downloaded = await owner.file(file);
    if (downloaded.size !== update.size || downloaded.token.split(':')[2] !== update.sha256) throw fail('update_integrity_failed');
    const backup = path.win32.join(path.win32.dirname(installedDirectory), `.DevRyan-${nonce}-backup`);
    let backupToken = null;
    const helperDirectory = path.win32.join(cacheDirectory, `installer-${nonce}`);
    await owner.ensureDirectory(helperDirectory);
    const helper = path.win32.join(helperDirectory, 'desktop-update-install-windows.mjs'), launcher = path.win32.join(helperDirectory, 'DevRyan-update-owner.exe');
    const source = helperSource;
    const helperBytes = await readSource(source), launcherBytes = await readSource(owner.launcher);
    if (helperBytes.length > 16 * 1024 * 1024 || launcherBytes.length > 16 * 1024 * 1024) throw fail('update_helper_size_invalid');
    const receiptDirectory = path.win32.join(cacheDirectory, `receipt-${nonce}`);
    const receiptIdentity = await owner.ensureDirectory(receiptDirectory);
    const identity = await owner.processIdentity(process.pid); if (!identity?.active) throw fail('update_owner_identity_unavailable');
    const intent = validateWindowsUpdateIntent({ protocol: 'devryan.windows-desktop-update/1', phase: 'preparing', nonce, target: installedDirectory,
      previousVersion: currentVersion, previousToken, backup, backupToken, failed: path.win32.join(path.win32.dirname(installedDirectory), `.DevRyan-${nonce}-failed`),
      file, sha256: update.sha256, size: update.size, version: update.version, arch, ownerPID: process.pid, ownerStart: identity.startIdentity,
      helper, helperSha256: hash(helperBytes), helperToken: null, launcher, launcherSha256: hash(launcherBytes), launcherToken: null,
      helperTreeToken: null, receipt: path.win32.join(receiptDirectory, 'native.json'),
      receiptParent: `${receiptIdentity.volume}:${receiptIdentity.fileId}` });
    await owner.write(intentPath, Buffer.from(JSON.stringify(intent) + '\n'), { expected: previous?.record ?? null });
    backupToken = await owner.clone(installedDirectory, backup, previousToken);
    await store.mutate(nonce, ['preparing'], { backupToken }); await verify(backup, currentVersion);
    const helperReceipt = await owner.write(helper, helperBytes, { expected: null });
    await store.mutate(nonce, ['preparing'], { helperToken: fileToken(helperReceipt) });
    const launcherReceipt = await owner.write(launcher, launcherBytes, { expected: null });
    await store.mutate(nonce, ['preparing'], { launcherToken: fileToken(launcherReceipt) });
    await store.mutate(nonce, ['preparing'], { phase: 'prepared', helperTreeToken: await owner.tree(helperDirectory) });
    return { nonce, intentPath };
  };
  const launchPrepared = async ({ nonce, recovery = false }) => {
    const intent = await inspect();
    if (!intent || intent.nonce !== nonce || !recovery && intent.phase !== 'prepared') throw fail('update_intent_changed');
    const held = await owner.holdInputs(intent);
    try {
      const child = spawnImpl(executable, [intent.helper, '--intent', intentPath, '--launcher', intent.launcher, ...(recovery ? ['--recover'] : [])],
        { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      await new Promise((resolve, reject) => {
        let reply = ''; const timer = setTimeout(() => finish(fail('update_installer_start_timeout')), 30_000);
        const finish = error => { clearTimeout(timer); child.stdout.off('data', data); child.off('error', failed); child.off('exit', exited); error ? reject(error) : resolve(); };
        const data = chunk => {
          reply += chunk.toString('utf8'); if (reply.length > 4096) return finish(fail('update_installer_reply_invalid'));
          if (!reply.endsWith('\n')) return;
          try {
            const value = JSON.parse(reply);
            if (Object.keys(value).sort().join(',') !== 'nonce,protocol,status' || value.protocol !== intent.protocol || value.nonce !== nonce || value.status !== 'waiting') throw fail('update_installer_reply_invalid');
            finish();
          } catch (error) { finish(error); }
        };
        const failed = () => finish(fail('update_installer_start_failed')), exited = () => finish(fail('update_installer_exited'));
        child.stdout.on('data', data); child.stderr.on('data', () => {}); child.once('error', failed); child.once('exit', exited);
      });
      held.assertHeld();
      const current = await inspect(), identity = await owner.processIdentity(child.pid);
      if (!identity?.active || current?.helperPID !== child.pid || current.helperStart !== identity.startIdentity) throw fail('update_installer_owner_invalid');
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
    } finally { await held.release(); }
  };
  const beginStartup = async nonce => {
    let intent = await inspect(); if (!intent) return false;
    if (intent.target !== installedDirectory) throw fail('update_installation_changed');
    if (['complete', 'rolled-back', 'aborted'].includes(intent.phase)) return false;
    await verify(installedDirectory, currentVersion);
    const helper = intent.helperPID ? await owner.processIdentity(intent.helperPID) : null;
    const helperAlive = helper?.active && helper.startIdentity === intent.helperStart;
    if (intent.phase === 'preparing') {
      if (await owner.tree(installedDirectory) !== intent.previousToken || currentVersion !== intent.previousVersion) throw fail('update_installation_changed');
      // No installer was authorized. Preserve unknown partial backup identities
      // for attended recovery rather than adopting or deleting them.
      return false;
    }
    if (['prepared', 'waiting-for-owner'].includes(intent.phase) && !helperAlive) {
      const native = intent.nativePID ? await owner.processIdentity(intent.nativePID) : null;
      if (native?.active && native.startIdentity === intent.nativeStart) throw fail('update_installation_pending');
      if (await owner.tree(installedDirectory) !== intent.previousToken || currentVersion !== intent.previousVersion) throw fail('update_installation_changed');
      const original = await owner.processIdentity(intent.ownerPID);
      if (!original?.active || original.startIdentity !== intent.ownerStart) {
        await store.mutate(intent.nonce, [intent.phase], { phase: 'aborted', errorCode: 'update_owner_exited_before_install' });
      }
      return false;
    }
    if (intent.phase === 'launching' && nonce === intent.nonce && currentVersion === intent.version) {
      if (await owner.tree(installedDirectory) !== intent.candidateToken) throw fail('update_installation_changed');
      const self = await owner.processIdentity(process.pid);
      if (!self?.active || intent.candidatePID && (intent.candidatePID !== process.pid || intent.candidateStart !== self.startIdentity)) throw fail('update_candidate_identity_unconfirmed');
      startup = await store.mutate(nonce, ['launching'], { candidatePID: process.pid, candidateStart: self.startIdentity, candidateStopped: false });
      polling = setInterval(() => { void inspect().then(async current => {
        if (!rollbackRequested && current?.nonce === nonce && current.phase === 'rollback-requested') { rollbackRequested = true; await onRollbackRequested(); }
      }).catch(() => {}); }, 250); polling.unref(); return true;
    }
    if (helperAlive) throw fail('update_installation_pending');
    const self = await owner.processIdentity(process.pid); if (!self?.active) throw fail('update_owner_identity_unavailable');
    intent = await store.mutate(intent.nonce, [intent.phase], { recoveryOwnerPID: process.pid, recoveryOwnerStart: self.startIdentity });
    await launchPrepared({ nonce: intent.nonce, recovery: true }); recoveryStartup = true; return false;
  };
  const acceptStartup = async () => {
    if (!startup) { await finalizeCompleted(); return; }
    await store.mutate(startup.nonce, ['launching'], { phase: 'accepted' }); clearInterval(polling); polling = null; startup = null;
  };
  const refuseStartup = async () => {
    if (!startup || rollbackRequested) return; rollbackRequested = true;
    await store.mutate(startup.nonce, ['launching', 'rollback-requested'], { phase: 'rollback-requested', errorCode: 'update_candidate_startup_failed' });
    await onRollbackRequested();
  };
  const recordCandidateStopped = async stopped => {
    if (!startup) return;
    await store.mutate(startup.nonce, ['rollback-requested'], stopped ? { candidateStopped: true } : { phase: 'held', errorCode: 'update_candidate_shutdown_unconfirmed' });
    clearInterval(polling); polling = null;
  };
  return { prepare, launchPrepared, beginStartup, acceptStartup, refuseStartup, recordCandidateStopped,
    isCandidateStartup: () => Boolean(startup), isRecoveryStartup: () => recoveryStartup, finalizeCompleted };
}
