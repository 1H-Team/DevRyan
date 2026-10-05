import fs from 'node:fs/promises';
import { watch, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withCrossProcessFileLock, writeFileAtomic } from '../harness-runtime/lib/atomic-file.js';
import { verifyDownloadedUpdate } from './desktop-updater.mjs';
import { applicationRoots, processStart, readUpdateIntent, mutateUpdateIntent, verifyMacUpdateBundle } from './desktop-update-install.mjs';

const exec = promisify(execFile);
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function createMacDmgInstaller({ installedBundle, currentVersion, cacheDirectory, verifyNativeArtifacts,
  roots = applicationRoots(), run = exec, spawnImpl = spawn, executable = process.execPath, trashItem,
  onRollbackRequested = async () => {} }) {
  const intentPath = path.join(cacheDirectory, 'install-intent.json');
  let startup = null, watcher = null, rollbackRequested = false;
  const inspect = async () => readUpdateIntent(intentPath, roots).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  const finalizeCompleted = async () => {
    const intent = await inspect();
    if (!intent || !['complete', 'rolled-back', 'aborted'].includes(intent.phase)) return;
    if (installedBundle !== intent.target || currentVersion !== (intent.phase === 'complete' ? intent.version : intent.previous.version)) throw fail('update_installation_changed');
    // Trash only the installer-created stage, after the installed app is ready.
    if (typeof trashItem !== 'function') return;
    await writeFileAtomic(path.join(cacheDirectory, `install-${intent.nonce}.json`), `${JSON.stringify(intent)}\n`);
    if (await fs.lstat(intent.stage).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) await trashItem(intent.stage);
    await fs.unlink(intentPath);
  };
  const prepare = async ({ file, update }) => withCrossProcessFileLock(`${intentPath}.prepare.lock`, async () => {
    if (typeof verifyNativeArtifacts !== 'function') throw fail('update_native_verifier_unavailable');
    if (!roots.includes(path.dirname(installedBundle)) || path.basename(installedBundle) !== 'DevRyan.app'
      || /(?:\/AppTranslocation\/|^\/Volumes\/)/.test(installedBundle) || await fs.realpath(installedBundle) !== installedBundle) {
      throw fail('update_installation_readonly', 'Install DevRyan in Applications before applying an update');
    }
    await fs.access(path.dirname(installedBundle), constants.W_OK);
    const previousIntent = await inspect();
    if (previousIntent) throw fail('update_installation_pending', 'An earlier update needs to finish before another can be installed');
    await verifyDownloadedUpdate(file, update);
    const previous = await verifyMacUpdateBundle(installedBundle, { version: currentVersion, run });
    const bridgePath = path.join(installedBundle, 'Contents/Resources/native/DevRyanRuntimeServiceControl.node');
    const bridge = createRequire(import.meta.url)(bridgePath);
    if (typeof bridge.renameExclusive !== 'function' || typeof bridge.swapApplications !== 'function') throw fail('update_installer_bridge_invalid');
    const bridgeSha256 = hash(await fs.readFile(bridgePath));
    const mount = await fs.mkdtemp(path.join(cacheDirectory, 'mounted-'));
    const nonce = randomUUID(), stage = path.join(path.dirname(installedBundle), `.DevRyan-update-${nonce}`);
    let mounted = false, prepared = false;
    try {
      await run('/usr/bin/hdiutil', ['verify', file, '-quiet'], { timeout: 120_000, maxBuffer: 64 * 1024 });
      await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, file], { timeout: 120_000, maxBuffer: 64 * 1024 });
      mounted = true;
      const source = path.join(mount, 'DevRyan.app');
      const candidate = await verifyMacUpdateBundle(source, { version: update.version, signing: previous.signing, run });
      const launcher = path.join(path.dirname(candidate.manifestPath), 'DevRyan-execution-darwin-arm64');
      await verifyNativeArtifacts({ manifestPath: candidate.manifestPath, manifestSha256: candidate.manifestSha256, launcher });
      const size = Number.parseInt((await run('/usr/bin/du', ['-sk', source], { timeout: 30_000, maxBuffer: 4096 })).stdout, 10) * 1024;
      const space = await fs.statfs(path.dirname(installedBundle));
      if (!Number.isSafeInteger(size) || size <= 0 || space.bavail * space.bsize < size * 2 + 16 * 1024 * 1024) {
        throw fail('update_disk_space', 'There is not enough free space to stage and roll back the update');
      }
      await fs.mkdir(stage, { mode: 0o700 });
      const stageIdentity = await fs.lstat(stage);
      const candidatePath = path.join(stage, 'candidate.app');
      await run('/usr/bin/ditto', [source, candidatePath], { timeout: 120_000, maxBuffer: 64 * 1024 });
      const copied = await verifyMacUpdateBundle(candidatePath, { version: update.version, signing: previous.signing, run });
      if (copied.manifestSha256 !== candidate.manifestSha256) throw fail('update_native_identity_changed');
      await verifyNativeArtifacts({ manifestPath: copied.manifestPath, manifestSha256: copied.manifestSha256,
        launcher: path.join(path.dirname(copied.manifestPath), 'DevRyan-execution-darwin-arm64') });
      const current = await fs.lstat(installedBundle);
      if (current.dev !== previous.dev || current.ino !== previous.ino) throw fail('update_installation_changed');
      const ownerStart = await processStart(process.pid);
      if (!ownerStart) throw fail('update_owner_identity_unavailable');
      const intent = { protocol: 'devryan.desktop-update/1', nonce, phase: 'prepared', target: installedBundle,
        stage, stageIdentity: { dev: stageIdentity.dev, ino: stageIdentity.ino },
        candidate: candidatePath, backup: path.join(stage, 'previous.app'), failed: path.join(stage, 'failed.app'),
        version: update.version, sha256: update.sha256, arch: 'arm64', signing: previous.signing,
        manifestSha256: copied.manifestSha256, bridgeSha256, previous: { version: currentVersion, dev: previous.dev, ino: previous.ino },
        ownerPID: process.pid, ownerStart };
      await writeFileAtomic(intentPath, `${JSON.stringify(intent)}\n`);
      prepared = true;
      return { intentPath, nonce };
    } finally {
      if (mounted) await run('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000, maxBuffer: 64 * 1024 });
      await fs.rm(mount, { recursive: true, force: true });
      if (!prepared) await fs.rm(stage, { recursive: true, force: true });
    }
  });
  const launchPrepared = async ({ nonce }) => {
    const intent = await inspect();
    if (!intent || intent.nonce !== nonce || intent.phase !== 'prepared' || intent.ownerPID !== process.pid
      || intent.ownerStart !== await processStart(process.pid)) throw fail('update_intent_changed');
    const helper = path.join(cacheDirectory, `installer-${nonce}`, 'desktop-update-install.mjs');
    const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop-update-install.mjs');
    await writeFileAtomic(helper, await fs.readFile(source));
    const bridgeBytes = await fs.readFile(path.join(installedBundle, 'Contents/Resources/native/DevRyanRuntimeServiceControl.node'));
    if (hash(bridgeBytes) !== intent.bridgeSha256) throw fail('update_installer_bridge_changed');
    await writeFileAtomic(path.join(path.dirname(helper), 'DevRyanRuntimeServiceControl.node'), bridgeBytes);
    const errorLog = await fs.open(path.join(cacheDirectory, `installer-${nonce}.log`), 'ax', 0o600);
    let child;
    try {
      child = spawnImpl(executable, [helper, '--devryan-install-intent', intentPath], { detached: true,
        env: { ELECTRON_RUN_AS_NODE: '1', HOME: os.homedir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        stdio: ['ignore', 'pipe', errorLog.fd] });
      await new Promise((resolve, reject) => {
        let bytes = '';
        const timer = setTimeout(() => finish(fail('update_installer_start_timeout')), 10_000);
        const finish = (error) => {
          clearTimeout(timer);child.stdout?.off('data', onData);child.off('error', onError);child.off('exit', onExit);
          error ? reject(error) : resolve();
        };
        const onError = () => finish(fail('update_installer_start_failed'));
        const onExit = () => finish(fail('update_installer_exited'));
        const onData = (chunk) => {
          bytes += chunk.toString('utf8');
          if (bytes.length > 4096) return finish(fail('update_installer_reply_invalid'));
          if (!bytes.endsWith('\n')) return;
          try {
            const value = JSON.parse(bytes);
            if (Object.keys(value).length !== 3 || value.protocol !== 'devryan.desktop-update/1' || value.nonce !== nonce || value.status !== 'waiting') throw fail('update_installer_reply_invalid');
            finish();
          } catch { finish(fail('update_installer_reply_invalid')); }
        };
        child.once('error', onError);child.once('exit', onExit);child.stdout?.on('data', onData);
      });
      const held = await inspect();
      if (held?.phase !== 'waiting-for-owner' || held.helperPID !== child.pid || held.helperStart !== await processStart(child.pid)) throw fail('update_installer_owner_invalid');
      child.stdout?.destroy();child.unref();
    } catch (error) {
      const held = await inspect();
      if (held?.nonce === nonce && ['prepared', 'waiting-for-owner'].includes(held.phase)) {
        await mutateUpdateIntent(intentPath, nonce, [held.phase], { phase: 'aborted', errorCode: error.code ?? 'update_installer_start_failed' }, roots);
      }
      throw error;
    } finally { await errorLog.close(); }
  };
  const beginStartup = async (nonce) => {
    const intent = await inspect();
    if (!intent) return false;
    if (['complete', 'rolled-back', 'aborted'].includes(intent.phase)) return false;
    if (intent.phase === 'prepared' && await processStart(intent.ownerPID) !== intent.ownerStart) {
      await mutateUpdateIntent(intentPath, intent.nonce, ['prepared'], { phase: 'aborted', errorCode: 'update_owner_exited_before_install' }, roots);return false;
    }
    if (intent.phase !== 'launching' || nonce !== intent.nonce || currentVersion !== intent.version || installedBundle !== intent.target) {
      throw fail('update_installation_pending', 'An update is in progress. Reopen DevRyan after it finishes.');
    }
    startup = await mutateUpdateIntent(intentPath, nonce, ['launching'], { candidatePID: process.pid,
      candidateStart: await processStart(process.pid), candidateStopped: false }, roots);
    const checkRollback = async () => {
      if (rollbackRequested) return;
      const current = await inspect();
      if (!rollbackRequested && current?.nonce === nonce && current.phase === 'rollback-requested') {
        rollbackRequested = true;
        await onRollbackRequested();
      }
    };
    watcher = watch(cacheDirectory, (_event, filename) => {
      if (filename?.toString() === path.basename(intentPath)) void checkRollback().catch(() => {});
    });
    watcher.unref();return true;
  };
  const acceptStartup = async () => {
    if (!startup) { await finalizeCompleted();return; }
    await mutateUpdateIntent(intentPath, startup.nonce, ['launching'], { phase: 'accepted' }, roots);
    watcher?.close();watcher = null;
    // The helper commits completion after seeing this acknowledgement. Retain
    // its rollback copy until a following launch confirms the completed intent.
    startup = null;
  };
  const refuseStartup = async () => {
    if (!startup || rollbackRequested) return;
    rollbackRequested = true;
    try { await mutateUpdateIntent(intentPath, startup.nonce, ['launching', 'rollback-requested'], { phase: 'rollback-requested', errorCode: 'update_candidate_startup_failed' }, roots); }
    catch (error) { rollbackRequested = false;throw error; }
    await onRollbackRequested();
  };
  const recordCandidateStopped = async (stopped) => {
    if (!startup) return;
    await mutateUpdateIntent(intentPath, startup.nonce, ['rollback-requested'], stopped
      ? { candidateStopped: true } : { phase: 'rollback-blocked', errorCode: 'update_candidate_shutdown_unconfirmed' }, roots);
    watcher?.close();watcher = null;
  };
  return { prepare, launchPrepared, beginStartup, acceptStartup, refuseStartup, recordCandidateStopped,
    isCandidateStartup: () => Boolean(startup), finalizeCompleted };
}
