import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWindowsUpdateOwner, WINDOWS_UPDATE_FILE_TOKEN, parseWindowsNsisReceipt, parseWindowsUpdateTree, isWindowsUpdatePath } from './windows-update-owner.mjs';

const fail = code => Object.assign(new Error(code), { code });
const phases = ['preparing', 'prepared', 'waiting-for-owner', 'installing', 'installed', 'launching', 'accepted', 'complete',
  'rollback-requested', 'moving-failed', 'restoring-backup', 'rolled-back', 'held', 'aborted'];
export function validateWindowsUpdateIntent(value) {
  const preparing = value?.phase === 'preparing';
  if (['nonce', 'version', 'previousVersion', 'sha256', 'helperSha256', 'launcherSha256', 'ownerStart'].some(key => typeof value?.[key] !== 'string')) throw fail('update_intent_invalid');
  const treeToken = token => {
    try { return parseWindowsUpdateTree(JSON.stringify({ protocol: 'devryan.windows-update-tree/1', token, namespaceFlushed: false }), false) === token; }
    catch { return false; }
  };
  const fileToken = token => typeof token === 'string' && WINDOWS_UPDATE_FILE_TOKEN.test(token) && Number.isSafeInteger(Number(token.split(':')[3])) && Number(token.split(':')[3]) <= 16 * 1024 * 1024;
  if (!value || value.protocol !== 'devryan.windows-desktop-update/1' || !/^[a-f0-9]{32}$/.test(value.nonce ?? '')
    || !phases.includes(value.phase) || !['x64', 'arm64'].includes(value.arch)
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version ?? '') || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.previousVersion ?? '')
    || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(value.helperSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(value.launcherSha256 ?? '') || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 8 * 1024 ** 3
    || !Number.isSafeInteger(value.ownerPID) || value.ownerPID <= 0 || !/^win32:[a-f0-9]{16}$/.test(value.ownerStart ?? '')
    || !treeToken(value.previousToken) || (!preparing || value.backupToken !== null) && !treeToken(value.backupToken)) throw fail('update_intent_invalid');
  if ((!preparing || value.helperToken !== null) && (!fileToken(value.helperToken) || value.helperToken.split(':')[2] !== value.helperSha256)
    || (!preparing || value.launcherToken !== null) && (!fileToken(value.launcherToken) || value.launcherToken.split(':')[2] !== value.launcherSha256)) throw fail('update_intent_invalid');
  if (value.settled !== undefined) parseWindowsNsisReceipt(value.settled, value.nonce);
  for (const key of ['target', 'backup', 'failed', 'file', 'helper', 'launcher', 'receipt']) {
    const candidate = value[key];
    if (!isWindowsUpdatePath(candidate)) throw fail('update_intent_invalid');
  }
  if (path.win32.basename(value.target) !== 'DevRyan' || value.backup !== path.win32.join(path.win32.dirname(value.target), `.DevRyan-${value.nonce}-backup`)
    || value.failed !== path.win32.join(path.win32.dirname(value.target), `.DevRyan-${value.nonce}-failed`)
    || path.win32.dirname(value.launcher) !== path.win32.dirname(value.helper)
    || ['candidateToken', 'failedToken', 'helperTreeToken'].some(key => value[key] !== undefined && value[key] !== null && !treeToken(value[key]))) throw fail('update_intent_invalid');
  for (const key of ['candidateLaunchAttempted', 'candidateNotCreated', 'candidateStopped', 'cleanupComplete']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw fail('update_intent_invalid');
  }
  for (const prefix of ['helper', 'candidate', 'native', 'recoveryOwner']) if (value[`${prefix}PID`] !== undefined
    && (!Number.isSafeInteger(value[`${prefix}PID`]) || value[`${prefix}PID`] <= 0
      || !/^win32:[a-f0-9]{16}$/.test(value[`${prefix}Start`] ?? ''))) throw fail('update_intent_invalid');
  return value;
}
export function windowsUpdateStore(owner, intentPath) {
  const inspect = async () => {
    try {
      const record = await owner.read(intentPath);
      if (record.bytes.length > 65536) throw fail('update_intent_invalid');
      return { record, intent: validateWindowsUpdateIntent(JSON.parse(record.bytes.toString('utf8'))) };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const mutate = async (nonce, allowed, changes) => {
    const existing = await inspect();
    if (!existing || existing.intent.nonce !== nonce || !allowed.includes(existing.intent.phase)) throw fail('update_intent_changed');
    const next = validateWindowsUpdateIntent({ ...existing.intent, ...changes });
    await owner.write(intentPath, Buffer.from(JSON.stringify(next) + '\n'), { expected: existing.record }); return next;
  };
  return { inspect, mutate };
}
const verifyVersion = async (owner, target, version, arch) => {
  const identity = await owner.version(target);
  if (identity.version !== version || identity.arch !== arch) throw fail('update_version_unverified');
};
export async function rollbackWindowsUpdate({ owner, store, intent }) {
  let current = intent;
  const candidate = current.candidatePID ? await owner.processIdentity(current.candidatePID) : null;
  if (!current.settled || current.settled.terminated !== true || current.settled.namespaceFlushed !== true
    || current.candidateLaunchAttempted && !current.candidateNotCreated && (!current.candidatePID || current.candidateStopped !== true)
    || candidate?.active && candidate.startIdentity === current.candidateStart) throw fail('update_termination_unconfirmed');
  const receipt = parseWindowsNsisReceipt(JSON.parse((await owner.read(current.receipt)).bytes.toString('utf8')), current.nonce);
  if (JSON.stringify(receipt) !== JSON.stringify(current.settled)) throw fail('update_termination_unconfirmed');
  if (current.phase === 'restoring-backup') {
    const restored = await owner.tree(current.target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (restored === current.backupToken) {
      await verifyVersion(owner, current.target, current.previousVersion, current.arch);
      await owner.restoreRegistration(current.target, current.backupToken, current.previousVersion, current.version);
      return store.mutate(current.nonce, ['restoring-backup'], { phase: 'rolled-back' });
    }
    if (restored) throw fail('update_installation_changed');
  }
  await verifyVersion(owner, current.backup, current.previousVersion, current.arch);
  if (await owner.tree(current.backup) !== current.backupToken) throw fail('update_backup_changed');
  if (!['moving-failed', 'restoring-backup'].includes(current.phase)) {
    const target = await owner.tree(current.target);
    if (current.candidateToken && target !== current.candidateToken) throw fail('update_installation_changed');
    current = await store.mutate(current.nonce, [current.phase], { phase: 'moving-failed', failedToken: target });
  }
  if (current.phase === 'moving-failed') {
    const target = await owner.tree(current.target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (target) {
      if (target !== current.failedToken) throw fail('update_installation_changed');
      await owner.rename(current.target, current.failed, target);
    } else if (await owner.tree(current.failed) !== current.failedToken) throw fail('update_installation_changed');
    current = await store.mutate(current.nonce, ['moving-failed'], { phase: 'restoring-backup' });
  }
  const target = await owner.tree(current.target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!target) await owner.rename(current.backup, current.target, current.backupToken);
  else if (target !== current.backupToken) throw fail('update_installation_changed');
  await verifyVersion(owner, current.target, current.previousVersion, current.arch);
  await owner.restoreRegistration(current.target, current.backupToken, current.previousVersion, current.version);
  return store.mutate(current.nonce, ['restoring-backup'], { phase: 'rolled-back' });
}

/** Detached helper. A missing termination receipt keeps both trees and intent;
 * process absence alone never authorizes rollback of an interrupted installer. */
export async function executeWindowsUpdate({ owner, intentPath, launch, acknowledge = () => {}, recover = false }) {
  const store = windowsUpdateStore(owner, intentPath); let current = (await store.inspect())?.intent;
  if (!current) throw fail('update_intent_missing');
  if (recover) {
    const self = await owner.processIdentity(process.pid); if (!self?.active) throw fail('update_owner_identity_unavailable');
    const drain = await owner.waitOwner(current.recoveryOwnerPID, current.recoveryOwnerStart);
    current = await store.mutate(current.nonce, [current.phase], { helperPID: process.pid, helperStart: self.startIdentity });
    acknowledge({ protocol: current.protocol, nonce: current.nonce, status: 'waiting' });
    await drain.settled;
    if (current.nativePID) {
      const native = await owner.processIdentity(current.nativePID);
      if (native?.active && native.startIdentity === current.nativeStart) throw fail('update_installer_still_active');
    }
    if (!current.settled) {
      const settled = parseWindowsNsisReceipt(JSON.parse((await owner.read(current.receipt)).bytes.toString('utf8')), current.nonce);
      if (!['installing', 'held'].includes(current.phase)) throw fail('update_recovery_held');
      current = await store.mutate(current.nonce, [current.phase], { phase: 'rollback-requested', settled, candidateToken: settled.targetToken });
    }
    if (!['rollback-requested', 'moving-failed', 'restoring-backup', 'installed', 'launching', 'held'].includes(current.phase)) throw fail('update_recovery_held');
    return rollbackWindowsUpdate({ owner, store, intent: current });
  }
  if (current.phase !== 'prepared') throw fail('update_intent_changed');
  const helper = await owner.processIdentity(process.pid); if (!helper?.active) throw fail('update_owner_identity_unavailable');
  const held = await owner.holdInstaller(current);
  try {
    current = await store.mutate(current.nonce, ['prepared'], { phase: 'waiting-for-owner', helperPID: process.pid, helperStart: helper.startIdentity,
      nativePID: held.pid, nativeStart: held.start });
    acknowledge({ protocol: current.protocol, nonce: current.nonce, status: 'waiting' });
    current = await store.mutate(current.nonce, ['waiting-for-owner'], { phase: 'installing' });
    const settled = await held.install();
    current = await store.mutate(current.nonce, ['installing'], { phase: 'installed', settled, candidateToken: settled.targetToken });
    if (settled.exitCode !== 0) return rollbackWindowsUpdate({ owner, store, intent: current });
    await verifyVersion(owner, current.target, current.version, current.arch);
    const candidateToken = await owner.tree(current.target);
    if (candidateToken !== settled.targetToken) throw fail('update_installation_changed');
    current = await store.mutate(current.nonce, ['installed'], { phase: 'launching', candidateToken });
    current = await store.mutate(current.nonce, ['launching'], { candidateLaunchAttempted: true });
    const launched = await launch(path.win32.join(current.target, 'DevRyan.exe'), [`--devryan-update-attempt=${current.nonce}`]);
    if (!launched || !Number.isSafeInteger(launched.pid) || !/^win32:[a-f0-9]{16}$/.test(launched.start ?? '')) throw fail('update_candidate_identity_unconfirmed');
    const registered = (await store.inspect())?.intent;
    if (!registered || registered.nonce !== current.nonce || registered.candidatePID && (registered.candidatePID !== launched.pid || registered.candidateStart !== launched.start)) throw fail('update_candidate_identity_unconfirmed');
    if (!registered.candidatePID) await store.mutate(current.nonce, ['launching'], { candidatePID: launched.pid, candidateStart: launched.start, candidateStopped: false });
    let deadline = Date.now() + 120_000, rollbackWaiting = false;
    for (;;) {
      const observed = (await store.inspect())?.intent;
      if (!observed || observed.nonce !== current.nonce) throw fail('update_intent_changed');
      current = observed;
      if (current.phase === 'accepted') return store.mutate(current.nonce, ['accepted'], { phase: 'complete' });
      if (current.phase === 'rollback-requested' && current.candidateStopped === true) {
        const candidate = await owner.processIdentity(current.candidatePID);
        if (!candidate?.active || candidate.startIdentity !== current.candidateStart) return rollbackWindowsUpdate({ owner, store, intent: current });
      }
      if (Date.now() >= deadline) {
        if (rollbackWaiting || current.phase !== 'launching') throw fail('update_candidate_readiness_unconfirmed');
        current = await store.mutate(current.nonce, ['launching'], { phase: 'rollback-requested', errorCode: 'update_candidate_readiness_timeout' });
        rollbackWaiting = true; deadline = Date.now() + 30_000;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    const latest = (await store.inspect())?.intent;
    if (latest?.nonce === current.nonce && !['complete', 'rolled-back'].includes(latest.phase)) {
      if (['moving-failed', 'restoring-backup'].includes(latest.phase)) throw error;
      if (latest.settled && (latest.phase === 'installed' || latest.phase === 'launching' && error.code === 'update_candidate_not_created')) {
        const stopped = latest.phase === 'launching' ? await store.mutate(current.nonce, ['launching'], { candidateNotCreated: true }) : latest;
        return rollbackWindowsUpdate({ owner, store, intent: stopped });
      }
      await store.mutate(current.nonce, [latest.phase], { phase: 'held', errorCode: error.code ?? 'update_installer_failed' });
    }
    throw error;
  } finally { held.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (![4, 5].includes(args.length) || args[0] !== '--intent' || args[2] !== '--launcher' || args.length === 5 && args[4] !== '--recover') throw fail('update_helper_arguments_invalid');
  let inputs;
  const owner = createWindowsUpdateOwner({ launcher: args[3], assertHeld: () => inputs?.assertHeld() });
  const current = (await windowsUpdateStore(owner, args[1]).inspect())?.intent;
  if (!current || current.launcher !== args[3] || current.helper !== fileURLToPath(import.meta.url)) throw fail('update_helper_changed');
  inputs = await owner.holdInputs(current);
  const { spawn } = await import('node:child_process');
  try { await executeWindowsUpdate({ owner, intentPath: args[1], recover: args[4] === '--recover', acknowledge: value => process.stdout.write(JSON.stringify(value) + '\n'),
    launch: async (file, arguments_) => {
      inputs.assertHeld();
      const child = spawn(file, arguments_, { detached: true, windowsHide: false, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '0' } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fail('update_candidate_not_created'))); });
      const identity = await owner.processIdentity(child.pid); child.unref();
      if (!identity?.active) throw fail('update_candidate_identity_unconfirmed');
      return { pid: child.pid, start: identity.startIdentity };
    } }); } finally { await inputs.release(); }
}
