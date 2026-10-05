import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { withCrossProcessFileLock, writeFileAtomic } from '../harness-runtime/lib/atomic-file.js';

const exec = promisify(execFile);
const fail = (code) => Object.assign(new Error(code), { code });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const phases = new Set(['prepared', 'waiting-for-owner', 'swapping', 'launching', 'accepted', 'complete',
  'rollback-requested', 'rolling-back', 'rollback-blocked', 'rolled-back', 'aborted']);
export const applicationRoots = () => ['/Applications', path.join(os.homedir(), 'Applications')];
export const processStart = async (pid) => {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 3000 })).stdout.trim() || null; }
  catch (error) { if (error.code === 1) return null; throw error; }
};
const syncDirectory = async (directory) => {
  const handle = await fs.open(directory, 'r');try { await handle.sync(); } finally { await handle.close(); }
};
export async function readUpdateIntent(intentPath, roots = applicationRoots()) {
  const handle = await fs.open(intentPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let intent;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.size > 16 * 1024
      || await fs.realpath(intentPath) !== intentPath) throw fail('update_intent_invalid');
    intent = JSON.parse(await handle.readFile('utf8'));
    const after = await handle.stat(), named = await fs.lstat(intentPath);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || named.dev !== stat.dev || named.ino !== stat.ino || after.nlink !== 1) throw fail('update_intent_changed');
  } finally { await handle.close(); }
  if (intent.protocol !== 'devryan.desktop-update/1' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(intent.nonce ?? '')
    || !phases.has(intent.phase) || !roots.includes(path.dirname(intent.target ?? '')) || path.basename(intent.target ?? '') !== 'DevRyan.app'
    || !/^\d+\.\d+\.\d+$/.test(intent.version ?? '') || !/^[a-f0-9]{64}$/.test(intent.sha256 ?? '')
    || !Number.isSafeInteger(intent.ownerPID) || intent.ownerPID <= 0 || typeof intent.ownerStart !== 'string' || !intent.ownerStart
    || !Number.isSafeInteger(intent.previous?.dev) || !Number.isSafeInteger(intent.previous?.ino)
    || !/^\d+\.\d+\.\d+$/.test(intent.previous?.version ?? '') || !['adhoc', 'release'].includes(intent.signing?.mode)
    || intent.signing.identifier !== 'dev.openchamber.desktop' || intent.arch !== 'arm64'
    || !/^[a-f0-9]{40,64}$/.test(intent.signing.cdhash ?? '')
    || intent.candidateSigning?.mode !== intent.signing.mode || intent.candidateSigning?.identifier !== intent.signing.identifier
    || intent.candidateSigning?.teamID !== intent.signing.teamID || !/^[a-f0-9]{40,64}$/.test(intent.candidateSigning?.cdhash ?? '')
    || !/^[a-f0-9]{64}$/.test(intent.manifestSha256 ?? '') || !/^[a-f0-9]{64}$/.test(intent.bridgeSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(intent.installerSha256 ?? '')) throw fail('update_intent_invalid');
  for (const prefix of ['helper', 'candidate', 'recoveryOwner']) {
    const pid = intent[`${prefix}PID`], start = intent[`${prefix}Start`];
    if (pid !== undefined || start !== undefined) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || typeof start !== 'string' || !start || start.length > 256) throw fail('update_intent_invalid');
    }
  }
  if (intent.candidateIdentity !== undefined && (!Number.isSafeInteger(intent.candidateIdentity?.dev)
    || !Number.isSafeInteger(intent.candidateIdentity?.ino))) throw fail('update_intent_invalid');
  if (intent.candidateStopped !== undefined && typeof intent.candidateStopped !== 'boolean') throw fail('update_intent_invalid');
  const stage = path.join(path.dirname(intent.target), `.DevRyan-update-${intent.nonce}`);
  if (intent.stage !== stage || intent.candidate !== path.join(stage, 'candidate.app')
    || intent.backup !== path.join(stage, 'previous.app') || intent.failed !== path.join(stage, 'failed.app')) throw fail('update_intent_invalid');
  const directory = await fs.lstat(stage).catch((error) => {
    if (error.code === 'ENOENT' && ['complete', 'rolled-back', 'aborted'].includes(intent.phase)) return null;
    throw error;
  });
  if (!directory) return intent;
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)
    || directory.dev !== intent.stageIdentity?.dev || directory.ino !== intent.stageIdentity?.ino
    || await fs.realpath(stage) !== stage || await fs.realpath(path.dirname(intent.target)) !== path.dirname(intent.target)) throw fail('update_intent_invalid');
  return intent;
}
export async function mutateUpdateIntent(intentPath, nonce, allowedPhases, patch, roots) {
  return withCrossProcessFileLock(`${intentPath}.lock`, async () => {
    const intent = await readUpdateIntent(intentPath, roots);
    if (intent.nonce !== nonce || !allowedPhases.includes(intent.phase)) throw fail('update_intent_changed');
    const next = { ...intent, ...patch };
    await writeFileAtomic(intentPath, `${JSON.stringify(next)}\n`);return next;
  });
}

/** Verifies data and signatures without executing anything from the candidate. */
export async function verifyMacUpdateBundle(bundle, { version, signing, arch = 'arm64', run = exec } = {}) {
  const stat = await fs.lstat(bundle);
  if (!stat.isDirectory() || await fs.realpath(bundle) !== bundle) throw fail('update_bundle_invalid');
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')], { timeout: 10_000, maxBuffer: 64 * 1024 });
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== 'dev.openchamber.desktop' || info.CFBundleExecutable !== 'DevRyan'
    || info.CFBundleShortVersionString !== version) throw fail('update_bundle_identity_mismatch');
  const binary = path.join(bundle, 'Contents/MacOS/DevRyan');
  const architectures = (await run('/usr/bin/lipo', ['-archs', binary], { timeout: 10_000 })).stdout.trim().split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== arch) throw fail('update_bundle_architecture_mismatch');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 60_000, maxBuffer: 64 * 1024 });
  const signature = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle], { timeout: 10_000, maxBuffer: 64 * 1024 })).stderr;
  const identifier = /^Identifier=(.+)$/m.exec(signature)?.[1], cdhash = /^CDHash=([a-f0-9]{40,64})$/m.exec(signature)?.[1];
  const team = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1];
  const actual = /Signature=adhoc/.test(signature) ? { mode: 'adhoc', identifier, cdhash }
    : team && team !== 'not set' ? { mode: 'release', identifier, cdhash, teamID: team } : null;
  if (!actual || identifier !== info.CFBundleIdentifier || !cdhash || signing
    && (actual.mode !== signing.mode || actual.teamID !== signing.teamID)) throw fail('update_bundle_signing_mismatch');
  const agentPath = path.join(bundle, 'Contents/Library/LaunchAgents/dev.openchamber.desktop.runtime-service.plist');
  const agent = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', agentPath], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout);
  if (agent.Label !== 'dev.openchamber.desktop.runtime-service' || agent.BundleProgram !== 'Contents/MacOS/DevRyan'
    || agent.ProgramArguments?.[0] !== 'DevRyan' || agent.ProgramArguments?.[1] !== '--runtime-service') throw fail('update_bundle_service_mismatch');
  const bridge = path.join(bundle, 'Contents/Resources/native/DevRyanRuntimeServiceControl.node');
  await run('/usr/bin/codesign', ['--verify', '--strict', bridge], { timeout: 10_000, maxBuffer: 64 * 1024 });
  const bridgeInfo = (await run('/usr/bin/codesign', ['-d', '--verbose=4', bridge], { timeout: 10_000, maxBuffer: 64 * 1024 })).stderr;
  const bridgeTeam = /^TeamIdentifier=(.+)$/m.exec(bridgeInfo)?.[1];
  if ((actual.teamID ?? 'not set') !== bridgeTeam) throw fail('update_bundle_service_mismatch');
  const manifestPath = path.join(bundle, `Contents/Resources/revert-runtime/darwin-${arch}/native-bundle.json`);
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.buildId ?? '') || manifest.target !== `bun-darwin-${arch}`) throw fail('update_native_identity_invalid');
  return { signing: actual, manifestPath, manifestSha256: hash(manifestBytes), buildId: manifest.buildId, dev: stat.dev, ino: stat.ino };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForExit = async (pid, start, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  do { if (await processStart(pid) !== start) return true;await pause(250); } while (Date.now() < deadline);
  return false;
};

/** Standalone installer: waits for proven owner exit; never kills a process.
 * An interrupted helper resumes only from sealed file identities. The execution
 * lock prevents two helpers from interpreting the same durable decision. */
export async function runDesktopUpdateInstall(intentPath, { roots = applicationRoots(), verifyBundle = verifyMacUpdateBundle,
  renameExclusive, swapApplications,
  ownerExited = waitForExit, launch = (bundle, nonce) => exec('/usr/bin/open', ['-n', bundle, '--args', `--devryan-update-attempt=${nonce}`], { timeout: 10_000 }),
  startupTimeoutMs = 120_000, onWaiting = () => {} } = {}) {
  return withCrossProcessFileLock(`${intentPath}.execution.lock`, async () => {
    let intent = await readUpdateIntent(intentPath, roots);
    if (['complete', 'rolled-back', 'aborted'].includes(intent.phase)) return intent.phase;
    if (intent.helperPID && await processStart(intent.helperPID) === intent.helperStart) throw fail('update_installer_still_active');
    const resumed = intent.phase !== 'prepared';
    if (!renameExclusive) {
      const bridge = path.join(path.dirname(intentPath), `installer-${intent.nonce}`, 'DevRyanRuntimeServiceControl.node');
      const handle = await fs.open(bridge, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4 * 1024 * 1024
          || hash(await handle.readFile()) !== intent.bridgeSha256 || await fs.realpath(bridge) !== bridge) throw fail('update_installer_bridge_invalid');
      } finally { await handle.close(); }
      const control = createRequire(import.meta.url)(bridge);
      renameExclusive = control.renameExclusive;swapApplications = control.swapApplications;
    }
    if (typeof renameExclusive !== 'function' || typeof swapApplications !== 'function') throw fail('update_installer_bridge_invalid');
    intent = await mutateUpdateIntent(intentPath, intent.nonce, [intent.phase], {
      ...(intent.phase === 'prepared' ? { phase: 'waiting-for-owner' } : {}),
      helperPID: process.pid, helperStart: await processStart(process.pid),
    }, roots);
    onWaiting(intent.nonce);
    if (!await ownerExited(intent.ownerPID, intent.ownerStart, 120_000)
      || intent.recoveryOwnerPID && !await ownerExited(intent.recoveryOwnerPID, intent.recoveryOwnerStart, 120_000)) {
      if (intent.phase === 'waiting-for-owner') await mutateUpdateIntent(intentPath, intent.nonce, ['waiting-for-owner'], { phase: 'aborted', errorCode: 'update_owner_still_active' }, roots);
      throw fail('update_owner_still_active');
    }
    const stat = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null;throw error; });
    const matches = (value, identity) => value?.isDirectory() && value.dev === identity?.dev && value.ino === identity?.ino;
    const verifyCandidate = async file => {
      if (!matches(await stat(file), intent.candidateIdentity)) throw fail('update_installation_changed');
      const verified = await verifyBundle(file, { version: intent.version, signing: intent.signing, arch: intent.arch });
      if (verified.manifestSha256 !== intent.manifestSha256 || verified.signing?.cdhash !== intent.candidateSigning.cdhash) throw fail('update_native_identity_changed');
    };
    const verifyPrevious = async file => {
      if (!matches(await stat(file), intent.previous)) throw fail('update_installation_changed');
      const verified = await verifyBundle(file, { version: intent.previous.version, signing: intent.signing, arch: intent.arch });
      if (verified.signing?.cdhash !== intent.signing.cdhash) throw fail('update_installation_changed');
    };
    let switched = !['waiting-for-owner', 'swapping'].includes(intent.phase), launchNow = false;
    try {
      if (intent.phase === 'waiting-for-owner') {
        await verifyPrevious(intent.target);
        const candidate = await verifyBundle(intent.candidate, { version: intent.version, signing: intent.signing, arch: intent.arch });
        const candidateIdentity = await stat(intent.candidate);
        if (candidate.manifestSha256 !== intent.manifestSha256 || candidate.signing?.cdhash !== intent.candidateSigning.cdhash) throw fail('update_native_identity_changed');
        intent = await mutateUpdateIntent(intentPath, intent.nonce, ['waiting-for-owner'], { phase: 'swapping',
          candidateIdentity: { dev: candidateIdentity.dev, ino: candidateIdentity.ino } }, roots);
      }
      if (intent.phase === 'swapping') {
        if (matches(await stat(intent.target), intent.previous)) {
          await verifyPrevious(intent.target);await verifyCandidate(intent.candidate);
          switched = true;
          await swapApplications(intent.candidate, intent.target);
        }
        // The atomic exchange may have completed before a killed helper wrote
        // another byte. Both sides must still be the exact recorded apps.
        switched = true;
        if (await stat(intent.backup)) await verifyPrevious(intent.backup);
        else { await verifyPrevious(intent.candidate);await renameExclusive(intent.candidate, intent.backup); }
        await verifyCandidate(intent.target);
        await syncDirectory(path.dirname(intent.target));await syncDirectory(intent.stage);
        intent = await mutateUpdateIntent(intentPath, intent.nonce, ['swapping'], { phase: 'launching' }, roots);
        launchNow = true;
      }
      if (['rollback-requested', 'rollback-blocked', 'rolling-back'].includes(intent.phase)) throw fail(intent.errorCode ?? 'update_candidate_startup_failed');
      if (intent.phase === 'accepted') {
        await verifyCandidate(intent.target);await verifyPrevious(intent.backup);
        await mutateUpdateIntent(intentPath, intent.nonce, ['accepted'], { phase: 'complete' }, roots);return 'complete';
      }
      if (intent.phase !== 'launching') throw fail('update_intent_changed');
      await verifyCandidate(intent.target);await verifyPrevious(intent.backup);
      // A durable launch whose acknowledgement was lost is never replayed.
      // Its candidate either reopens and acknowledges readiness or proves its
      // shutdown before rollback; absence alone is not a cleanup receipt.
      if (launchNow) await launch(intent.target, intent.nonce);
      const deadline = Date.now() + startupTimeoutMs;
      do {
        intent = await readUpdateIntent(intentPath, roots);
        if (intent.phase === 'accepted') {
          await verifyCandidate(intent.target);await verifyPrevious(intent.backup);
          await mutateUpdateIntent(intentPath, intent.nonce, ['accepted'], { phase: 'complete' }, roots);return 'complete';
        }
        if (intent.phase === 'rollback-requested' || intent.phase === 'rollback-blocked') throw fail('update_candidate_startup_failed');
        await pause(250);
      } while (Date.now() < deadline);
      throw fail('update_candidate_startup_timeout');
    } catch (error) {
      intent = await readUpdateIntent(intentPath, roots);
      if (switched) {
        try {
          if (intent.phase !== 'swapping' && intent.phase !== 'rolling-back') {
            if (intent.phase === 'launching') intent = await mutateUpdateIntent(intentPath, intent.nonce, ['launching'], { phase: 'rollback-requested', errorCode: error.code ?? 'update_install_failed' }, roots);
            const deadline = Date.now() + startupTimeoutMs;
            do {
              intent = await readUpdateIntent(intentPath, roots);
              if (intent.phase === 'rollback-blocked') break;
              if (intent.candidateStopped === true && Number.isSafeInteger(intent.candidatePID) && typeof intent.candidateStart === 'string'
                && await ownerExited(intent.candidatePID, intent.candidateStart, 1000)) break;
              await pause(250);
            } while (Date.now() < deadline);
            if (intent.candidateStopped !== true || !Number.isSafeInteger(intent.candidatePID) || typeof intent.candidateStart !== 'string'
              || !await ownerExited(intent.candidatePID, intent.candidateStart, 1000)) throw fail('update_candidate_shutdown_unconfirmed');
          }
          if (intent.phase !== 'rolling-back') intent = await mutateUpdateIntent(intentPath, intent.nonce,
            ['swapping', 'launching', 'rollback-requested', 'rollback-blocked'], { phase: 'rolling-back', errorCode: error.code ?? 'update_install_failed' }, roots);
          if (!matches(await stat(intent.target), intent.previous)) {
            const original = await stat(intent.backup) ? intent.backup : intent.candidate;
            await verifyPrevious(original);await verifyCandidate(intent.target);
            await swapApplications(original, intent.target);
          }
          await verifyPrevious(intent.target);
          if (await stat(intent.failed)) await verifyCandidate(intent.failed);
          else {
            const failed = await stat(intent.backup) ? intent.backup : intent.candidate;
            await verifyCandidate(failed);await renameExclusive(failed, intent.failed);
          }
          await syncDirectory(intent.stage);
        } catch (rollbackError) {
          await mutateUpdateIntent(intentPath, intent.nonce, ['swapping', 'launching', 'accepted', 'rollback-requested', 'rolling-back', 'rollback-blocked'],
            { phase: 'rollback-blocked', errorCode: rollbackError.code ?? 'update_installation_changed' }, roots);
          throw rollbackError;
        }
      } else if (resumed && intent.phase === 'swapping') {
        // Ambiguous pre-exchange identities stay held, with all copies intact.
        throw error;
      }
      await syncDirectory(path.dirname(intent.target));
      try { await verifyPrevious(intent.target); }
      catch (restoreError) {
        await mutateUpdateIntent(intentPath, intent.nonce, ['waiting-for-owner', 'swapping', 'launching', 'rollback-requested', 'rolling-back'],
          { phase: 'rollback-blocked', errorCode: restoreError.code ?? 'update_installation_changed' }, roots);
        throw restoreError;
      }
      await mutateUpdateIntent(intentPath, intent.nonce, ['waiting-for-owner', 'swapping', 'launching', 'rollback-requested', 'rolling-back'],
        { phase: 'rolled-back', errorCode: error.code ?? 'update_install_failed' }, roots);
      await launch(intent.target, intent.nonce);
      return 'rolled-back';
    }
  }, { timeoutMs: 0 });
}

if (path.basename(fileURLToPath(import.meta.url)) === 'desktop-update-install.mjs'
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--devryan-install-intent') {
  try {
    if (process.argv.length !== 4 || process.platform !== 'darwin') throw fail('update_installer_arguments_invalid');
    const outcome = await runDesktopUpdateInstall(path.resolve(process.argv[3]), {
      onWaiting: (nonce) => { process.stdout.write(`${JSON.stringify({ protocol: 'devryan.desktop-update/1', nonce, status: 'waiting' })}\n`); },
    });
    process.exitCode = outcome === 'complete' ? 0 : 2;
  } catch (error) { process.stderr.write(`${error.code ?? 'update_installer_failed'}\n`);process.exitCode = 2; }
}
