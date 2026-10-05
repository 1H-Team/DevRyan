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
  'rollback-requested', 'rollback-blocked', 'rolled-back', 'aborted']);
export const applicationRoots = () => ['/Applications', path.join(os.homedir(), 'Applications')];
export const processStart = async (pid) => {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 3000 })).stdout.trim() || null; }
  catch (error) { if (error.code === 1) return null; throw error; }
};
const syncDirectory = async (directory) => {
  const handle = await fs.open(directory, 'r');try { await handle.sync(); } finally { await handle.close(); }
};
export async function readUpdateIntent(intentPath, roots = applicationRoots()) {
  const handle = await fs.open(intentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    || !/^[a-f0-9]{64}$/.test(intent.manifestSha256 ?? '') || !/^[a-f0-9]{64}$/.test(intent.bridgeSha256 ?? '')) throw fail('update_intent_invalid');
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

/** Standalone installer: waits for proven owner exit; never kills a process. */
export async function runDesktopUpdateInstall(intentPath, { roots = applicationRoots(), verifyBundle = verifyMacUpdateBundle,
  renameExclusive, swapApplications,
  ownerExited = waitForExit, launch = (bundle, nonce) => exec('/usr/bin/open', ['-n', bundle, '--args', `--devryan-update-attempt=${nonce}`], { timeout: 10_000 }),
  startupTimeoutMs = 120_000, onWaiting = () => {} } = {}) {
  let intent = await readUpdateIntent(intentPath, roots);
  if (!renameExclusive) {
    const bridge = path.join(path.dirname(intentPath), `installer-${intent.nonce}`, 'DevRyanRuntimeServiceControl.node');
    const handle = await fs.open(bridge, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)
        || hash(await handle.readFile()) !== intent.bridgeSha256 || await fs.realpath(bridge) !== bridge) throw fail('update_installer_bridge_invalid');
    } finally { await handle.close(); }
    const control = createRequire(import.meta.url)(bridge);
    renameExclusive = control.renameExclusive;swapApplications = control.swapApplications;
  }
  if (typeof renameExclusive !== 'function' || typeof swapApplications !== 'function') throw fail('update_installer_bridge_invalid');
  intent = await mutateUpdateIntent(intentPath, intent.nonce, ['prepared'], { phase: 'waiting-for-owner', helperPID: process.pid,
    helperStart: await processStart(process.pid) }, roots);
  onWaiting(intent.nonce);
  if (!await ownerExited(intent.ownerPID, intent.ownerStart, 120_000)) {
    await mutateUpdateIntent(intentPath, intent.nonce, ['waiting-for-owner'], { phase: 'aborted', errorCode: 'update_owner_still_active' }, roots);
    throw fail('update_owner_still_active');
  }
  let switched = false, candidateIdentity;
  try {
    const actual = await fs.lstat(intent.target);
    if (!actual.isDirectory() || actual.dev !== intent.previous.dev || actual.ino !== intent.previous.ino) throw fail('update_installation_changed');
    await verifyBundle(intent.target, { version: intent.previous.version, signing: intent.signing, arch: intent.arch });
    const candidate = await verifyBundle(intent.candidate, { version: intent.version, signing: intent.signing, arch: intent.arch });
    candidateIdentity = await fs.lstat(intent.candidate);
    if (candidate.manifestSha256 !== intent.manifestSha256) throw fail('update_native_identity_changed');
    await mutateUpdateIntent(intentPath, intent.nonce, ['waiting-for-owner'], { phase: 'swapping',
      candidateIdentity: { dev: candidateIdentity.dev, ino: candidateIdentity.ino } }, roots);
    // An atomic exchange keeps the installed path available across interruption.
    // The original app becomes the private candidate path until backup naming.
    await swapApplications(intent.candidate, intent.target);switched = true;
    await syncDirectory(path.dirname(intent.target));await syncDirectory(intent.stage);
    await renameExclusive(intent.candidate, intent.backup);
    const backup = await fs.lstat(intent.backup);
    if (backup.dev !== intent.previous.dev || backup.ino !== intent.previous.ino) throw fail('update_installation_changed');
    const published = await fs.lstat(intent.target);
    if (published.dev !== candidateIdentity.dev || published.ino !== candidateIdentity.ino) throw fail('update_installation_changed');
    await syncDirectory(path.dirname(intent.target));await syncDirectory(intent.stage);
    await mutateUpdateIntent(intentPath, intent.nonce, ['swapping'], { phase: 'launching' }, roots);
    await launch(intent.target, intent.nonce);
    const deadline = Date.now() + startupTimeoutMs;
    do {
      intent = await readUpdateIntent(intentPath, roots);
      if (intent.phase === 'accepted') {
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
        // Before the durable launch phase no candidate was started. Afterwards
        // require both a cleanup receipt and the exact candidate's process exit.
        if (intent.phase !== 'swapping') {
          if (intent.phase === 'launching') intent = await mutateUpdateIntent(intentPath, intent.nonce, ['launching'], { phase: 'rollback-requested', errorCode: error.code ?? 'update_install_failed' }, roots);
          const deadline = Date.now() + 120_000;
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
        const original = await fs.lstat(intent.backup).then(() => intent.backup,
          error => { if (error.code === 'ENOENT') return intent.candidate;throw error; });
        const previous = await fs.lstat(original), current = await fs.lstat(intent.target);
        if (!previous.isDirectory() || previous.dev !== intent.previous.dev || previous.ino !== intent.previous.ino
          || !current.isDirectory() || current.dev !== candidateIdentity.dev || current.ino !== candidateIdentity.ino) throw fail('update_installation_changed');
        await verifyBundle(original, { version: intent.previous.version, signing: intent.signing, arch: intent.arch });
        await swapApplications(original, intent.target);
        await renameExclusive(original, intent.failed);
      }
      catch (rollbackError) {
        await mutateUpdateIntent(intentPath, intent.nonce, ['swapping', 'launching', 'rollback-requested', 'rollback-blocked'],
          { phase: 'rollback-blocked', errorCode: rollbackError.code ?? 'update_installation_changed' }, roots);
        throw rollbackError;
      }
    }
    await syncDirectory(path.dirname(intent.target));
    await mutateUpdateIntent(intentPath, intent.nonce, ['waiting-for-owner', 'swapping', 'launching', 'rollback-requested'],
      { phase: 'rolled-back', errorCode: error.code ?? 'update_install_failed' }, roots);
    // The owner has exited even when pre-swap verification refused. Relaunch
    // only the original verified installation; never a concurrent replacement.
    const restored = await fs.lstat(intent.target);
    if (restored.dev === intent.previous.dev && restored.ino === intent.previous.ino) {
      await verifyBundle(intent.target, { version: intent.previous.version, signing: intent.signing, arch: intent.arch });
      await launch(intent.target, intent.nonce);
    }
    return 'rolled-back';
  }
}

if (path.basename(fileURLToPath(import.meta.url)) === 'desktop-update-install.mjs' && process.argv[2] === '--devryan-install-intent') {
  try {
    if (process.argv.length !== 4 || process.platform !== 'darwin') throw fail('update_installer_arguments_invalid');
    const outcome = await runDesktopUpdateInstall(path.resolve(process.argv[3]), {
      onWaiting: (nonce) => { process.stdout.write(`${JSON.stringify({ protocol: 'devryan.desktop-update/1', nonce, status: 'waiting' })}\n`); },
    });
    process.exitCode = outcome === 'complete' ? 0 : 2;
  } catch (error) { process.stderr.write(`${error.code ?? 'update_installer_failed'}\n`);process.exitCode = 2; }
}
