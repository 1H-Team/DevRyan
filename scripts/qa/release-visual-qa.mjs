#!/usr/bin/env node
// Release visual QA: the unchanged release DMG on a disposable
// macOS arm64 host, with one screenshot per step.
//
//   node scripts/qa/release-visual-qa.mjs (--dmg <absolute DMG> | --version X.Y.Z) --report <absolute report.json>
//     [--manifest <release-manifest.json>] [--upgrade-from vA.B.C] [--isolated-host] [--keep-artifacts]
//
//   1. The DMG's sha256 (against --manifest, and the public release when it exists),
//      mounted read-only, its volume listed, DevRyan.app ditto'd into the run root
//      (never /Applications).
//   2. First launch on a private HOME/XDG profile with a mock keychain and CDP:
//      splash, then the ready window (OpenCode ready, no error toast).
//   3. Settings → About shows exactly X.Y.Z, equal to CFBundleShortVersionString.
//   4. An update check against the real feed offers exactly what /releases/latest
//      says it should (nothing when the candidate is the newest).
//   5. Optional (--upgrade-from): once X.Y.Z is the published latest, the older
//      release's public DMG is installed the same way, offered X.Y.Z, downloads it,
//      restarts into it and keeps its profile.
//   6. Quit, with no process left running from the run root.
//
// Launchd labels live in the real gui/<uid> domain whatever HOME says, so this
// never runs beside the owner's app: it requires a GitHub Actions runner or
// --isolated-host (a separate macOS user or VM), and refuses while any DevRyan
// process runs for this user. The run root is removed on success, failure and
// interruption; screenshots and report.json are written next to --report.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRunRoot, scratchParent } from './run-root.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { qaPackagedAppEnvironment } from './launch-environment.mjs';
import { withMountedDmg } from './mounted-dmg.mjs';
import { boundedDiagnostic } from './release-qualification-failure.mjs';
import { RELEASE_REPOSITORY, releaseAssetDownloadUrl, releaseAssetName } from '../../packages/electron/release-assets.mjs';
import { createFeedMirror, createUpdaterFixture, updaterFixtureScript, updaterObservationScript } from './release-updater-fixture.mjs';
import { processStart, readUpdateIntent, verifyMacUpdateBundle } from '../../packages/electron/desktop-update-install.mjs';

const execute = promisify(execFile);
const VERSION = /^\d+\.\d+\.\d+$/;
export const STEPS = Object.freeze(['dmg', 'install', 'splash', 'ready', 'about', 'updateCheck', 'stopped']);
// Product error codes are short snake_case words; anything else is bounded and redacted.
const errorCode = value => /^[a-z][a-z0-9_]{0,79}$/.test(value ?? '') ? value : boundedDiagnostic(value ?? '');

export function parseVisualQaArgs(argv) {
  const options = { isolatedHost: false, keepArtifacts: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--isolated-host') options.isolatedHost = true;
    else if (flag === '--keep-artifacts') options.keepArtifacts = true;
    else if (flag === '--candidate-upgrade') options.candidateUpgrade = true;
    else if (['--dmg', '--version', '--report', '--manifest', '--upgrade-from'].includes(flag) && argv[index + 1] !== undefined) {
      options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
    } else throw new Error(`Unknown or incomplete argument ${flag}`);
  }
  if (Boolean(options.dmg) === Boolean(options.version)) throw new Error('Pass exactly one of --dmg <absolute DMG> or --version X.Y.Z');
  if (options.dmg && !path.isAbsolute(options.dmg)) throw new Error('--dmg must be absolute');
  if (options.version && !VERSION.test(options.version)) throw new Error('--version must be X.Y.Z');
  if (!path.isAbsolute(options.report ?? '')) throw new Error('--report <absolute report.json> is required');
  if (options.manifest && !path.isAbsolute(options.manifest)) throw new Error('--manifest must be absolute');
  if (options.upgradeFrom && !/^v\d+\.\d+\.\d+$/.test(options.upgradeFrom)) throw new Error('--upgrade-from must be vA.B.C');
  if (options.candidateUpgrade && (!options.dmg || !options.manifest || !options.upgradeFrom)) throw new Error('--candidate-upgrade requires --dmg, --manifest and --upgrade-from');
  return options;
}

/** Why this host must not run the visual QA, or null. Never beside the owner's app. */
export function visualQaHostRefusal({ platform = process.platform, arch = process.arch, environment = process.env, isolatedHost = false, runningApps = [] } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') return 'macos_arm64_required';
  if (environment.GITHUB_ACTIONS !== 'true' && !isolatedHost) return 'disposable_host_required';
  if (runningApps.length) return 'devryan_running_for_this_user';
  return null;
}

/** What the real feed should make an installed `current` offer, given the published latest version. */
export function expectedUpdate({ current, latest }) {
  if (!latest) return { available: false, version: null };
  const parts = value => value.split('.').map(Number);
  const [left, right] = [parts(latest), parts(current)];
  const newer = left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  return newer > 0 ? { available: true, version: latest } : { available: false, version: null };
}

/** Whether release `from` is older than `to` (both X.Y.Z). */
export function versionPredates(from, to) {
  const [left, right] = [from, to].map(value => value.split('.').map(Number));
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] < right[index];
  return false;
}

export function gradeVisualQa(evidence) {
  const failures = (evidence.upgradeOnly ? ['dmg'] : STEPS).filter(step => evidence.steps?.[step]?.passed !== true);
  if (evidence.upgradeRequired ? evidence.upgrade?.status !== 'passed' : evidence.upgrade && !['passed', 'skipped'].includes(evidence.upgrade.status)) failures.push('upgrade');
  if (evidence.cleanupFailures?.length) failures.push('cleanup');
  return { passed: failures.length === 0, failures };
}

export function observeInstalledDownload(progress, previous, now = Date.now()) {
  if (!progress) throw new Error('Installed update observation was lost during download');
  if (progress.state === 'complete') return { ...previous, complete: true };
  if (progress.state === 'failed') throw new Error(`Installed update download failed: ${boundedDiagnostic(progress.message)}`);
  const advanced = Number.isSafeInteger(progress.downloaded) && progress.downloaded > previous.lastBytes;
  const next = advanced ? { lastBytes: progress.downloaded, lastProgressAt: now } : previous;
  if (now - next.lastProgressAt >= 90_000) throw new Error(`Installed update made no download progress for 90 seconds (${next.lastBytes} bytes)`);
  return next;
}

/**
 * A window that has not composited a frame yet (seen on hosted runners right
 * after the main window replaces the splash) stalls Page.captureScreenshot.
 * Only that timeout is retried, after bringing the page forward; the
 * screenshot remains required.
 */
export async function captureScreenshot(connection, { attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await connection.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 10_000 }); }
    catch (error) {
      if (attempt >= attempts || error?.message !== 'Timed out waiting for CDP Page.captureScreenshot') throw error;
      await connection.send('Page.bringToFront', {}, { timeoutMs: 5_000 }).catch(() => {});
    }
  }
}

/**
 * Cmd+, opens Settings. A keystroke sent before the window takes key focus
 * (seen on hosted runners) is dropped, so a missing About control after five
 * seconds brings the page forward and presses again, three presses at most.
 */
export async function openSettingsAbout(ui, bringToFront, { attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    await bringToFront().catch(() => {});
    await ui.key(',', { code: 'Comma', modifiers: 4 });
    try {
      return await ui.click({ text: 'About', selector: 'button,[role="button"],a,[role="tab"],[role="menuitem"]', ...(attempt < attempts ? { timeout: 5_000 } : {}) });
    } catch (error) {
      if (attempt >= attempts || !/^Timed out: visible control About/.test(error?.message ?? '')) throw error;
    }
  }
}

/** The restart IPC runs installer preparation in main; a refusal ends the wait with its own code. */
export function observeInstalledRestart(progress) {
  if (!progress) throw new Error('Installed update observation was lost before restart');
  const restart = progress.restart;
  if (restart?.state === 'failed') {
    const detail = boundedDiagnostic(restart.diagnostic ?? restart.message ?? '');
    throw Object.assign(new Error(`Installed update preparation refused: ${errorCode(restart.code) || 'no code'}${detail ? ` ${detail}` : ''}`),
      { code: errorCode(restart.code), preparationRefused: true });
  }
  return restart?.state === 'returned' ? 'returned' : 'pending';
}

export function installedReceiptComplete(intent, expected) {
  if (!intent) return false;
  if (intent.target !== expected.target || intent.previous?.version !== expected.from || intent.version !== expected.to
    || intent.sha256 !== expected.sha256 || intent.ownerPID !== expected.ownerPID || intent.ownerStart !== expected.ownerStart) {
    throw new Error('Installed update receipt does not identify this upgrade');
  }
  if (['rollback-requested', 'rolling-back', 'rollback-blocked', 'rolled-back', 'aborted'].includes(intent.phase)) {
    throw Object.assign(new Error(`Installed update failed: ${intent.phase} (${intent.errorCode ?? 'no code'})`), { code: intent.errorCode ?? '' });
  }
  return intent.phase === 'complete';
}

export async function setQaLaunchEnvironment(environment, run = execute) {
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'DEVRYAN_ELECTRON_USER_DATA_DIR'];
  const previous = new Map(), changed = new Set();
  for (const key of keys) previous.set(key, await run('/bin/launchctl', ['getenv', key], { timeout: 5_000 }).then(result => result.stdout.trimEnd(), error => {
    if (error.code === 1) return null;
    throw error;
  }));
  const restore = async () => {
    const errors = [];
    for (const key of [...changed].reverse()) {
      try {
        await run('/bin/launchctl', previous.get(key) === null ? ['unsetenv', key] : ['setenv', key, previous.get(key)], { timeout: 5_000 });
        changed.delete(key);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Could not restore isolated launch environment');
  };
  try {
    for (const key of keys) {
      if (typeof environment[key] !== 'string') throw new Error(`Missing isolated launch value: ${key}`);
      changed.add(key);
      await run('/bin/launchctl', ['setenv', key, environment[key]], { timeout: 5_000 });
    }
    return restore;
  } catch (error) { await restore(); throw error; }
}

const sha256File = async file => {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close().catch(() => {}); }
  return hash.digest('hex');
};

/** The release metadata response as GitHub sent it: status 200 or 404 and the exact body. */
export async function publicReleaseResponse(tag, fetchImpl = fetch, token = process.env.GITHUB_TOKEN) {
  const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/${tag === 'latest' ? 'latest' : `tags/${tag}`}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15_000) });
  if (response.status !== 404 && !response.ok) throw new Error(`Release discovery for ${tag} failed (${response.status})`);
  return { status: response.status, body: await response.text() };
}

export async function publicRelease(tag, fetchImpl = fetch, token = process.env.GITHUB_TOKEN) {
  const { status, body } = await publicReleaseResponse(tag, fetchImpl, token);
  return status === 404 ? null : JSON.parse(body);
}

async function downloadPublicDmg(version, directory) {
  const release = await publicRelease(`v${version}`);
  const name = releaseAssetName('macos-arm64', version);
  const asset = release?.assets?.find(row => row.name === name);
  if (!asset?.digest) throw new Error(`v${version} has no published ${name}`);
  const file = path.join(directory, name);
  const response = await fetch(releaseAssetDownloadUrl('macos-arm64', version), { headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Downloading ${name} failed (${response.status})`);
  const handle = await fs.open(file, 'wx', 0o600);
  try { for await (const chunk of response.body) await handle.write(chunk); } finally { await handle.close(); }
  if (`sha256:${await sha256File(file)}` !== asset.digest) throw new Error(`${name} does not match its published digest`);
  return file;
}

/** Mount read-only, list the volume, and ditto DevRyan.app into `applications` (inside the run root). */
async function installFromDmg(dmg, { mount, applications }) {
  await fs.mkdir(mount, { recursive: true });
  await fs.mkdir(applications, { recursive: true });
  return withMountedDmg(dmg, mount, async () => {
    const volume = (await fs.readdir(mount)).filter(entry => !entry.startsWith('.')).sort();
    const app = path.join(applications, 'DevRyan.app');
    await execute('/usr/bin/ditto', [path.join(mount, 'DevRyan.app'), app], { timeout: 300_000 });
    const info = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { timeout: 30_000 })).stdout);
    return { app, volume, shortVersion: info.CFBundleShortVersionString, bundleId: info.CFBundleIdentifier };
  });
}

/** A launched app on its own private profile, observed over CDP. */
async function launchApp(app, { root, name, fixture }) {
  const home = path.join(root, name, 'home');
  await fs.mkdir(path.join(home, '.config/devryan'), { recursive: true });
  const port = await reservePort(), debugPort = await reservePort();
  await fs.writeFile(path.join(home, '.config/devryan/settings.json'), JSON.stringify({ desktopLocalPort: port, desktopLanAccessEnabled: false,
    enableBackgroundBots: false, productionBotsRuntimeMode: 'disabled', lastDirectory: home }));
  const env = { ...qaPackagedAppEnvironment({ home, root }), DEVRYAN_ELECTRON_USER_DATA_DIR: path.join(home, 'electron-profile') };
  const inspectorPort = fixture || name === 'upgrade' ? await reservePort() : null;
  const child = startOwnedProcess(path.join(app, 'Contents/MacOS/DevRyan'),
    [...(inspectorPort ? [`--inspect-brk=127.0.0.1:${inspectorPort}`] : []), `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(home, 'electron-profile')}`, '--use-mock-keychain'], { cwd: home, env });
  const owned = { child, home, port, debugPort, inspectorPort, inspectorTargets: new Set() };
  try {
    if (inspectorPort) {
      const deadline = Date.now() + 30_000;
      while (!await prepareFixtureInspector(owned, fixture)) {
        child.check();
        if (Date.now() >= deadline) throw new Error('Installed app main-process inspector did not start');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return owned;
  } catch (error) { closeInspectorSessions(owned); await child.stop(); throw error; }
}

export async function prepareFixtureInspector(owned, fixture) {
  // The main-process inspector advertises type=node, unlike renderer pages.
  const response = await fetch(`http://127.0.0.1:${owned.inspectorPort}/json/list`, { signal: AbortSignal.timeout(1_000) })
    .then(response => response.json()).catch(() => []);
  const target = response.find(row => row.webSocketDebuggerUrl);
  if (!target) return false;
  if (owned.inspectorTargets.has(target.id)) return true;
  const { CdpConnection } = await import('./cdp.mjs');
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
  let kept = false;
  try {
    await connection.send('Runtime.enable');
    await connection.send('Debugger.enable');
    const paused = connection.waitFor('Debugger.paused', 5_000);
    await connection.send('Runtime.runIfWaitingForDebugger');
    const frame = await paused;
    const injected = await connection.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrames[0].callFrameId,
      expression: `${fixture ? fixture.script ?? updaterFixtureScript(fixture) : 'true'}; ${updaterObservationScript()}`, returnByValue: true });
    if (injected.exceptionDetails || injected.result?.value !== true) throw new Error(`Could not install test-process updater fixture: ${boundedDiagnostic(injected.exceptionDetails?.exception?.description ?? injected.exceptionDetails?.text ?? 'invalid result')}`);
    owned.inspectorTargets.add(target.id);
    // --inspect-brk also holds every worker_threads Worker (the session-mutation
    // host is one) until a debugger releases it; 2.1.14+ never became ready.
    // This session stays open for the process lifetime and releases each one.
    connection.on('NodeWorker.attachedToWorker', ({ sessionId, waitingForDebugger }) => {
      if (!waitingForDebugger) return;
      void connection.send('NodeWorker.sendMessageToWorker', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' }) })
        .then(() => connection.send('NodeWorker.detach', { sessionId })).catch(() => {});
    });
    await connection.send('NodeWorker.enable', { waitForDebuggerOnStart: true });
    await connection.send('Debugger.resume');
    await connection.send('Debugger.disable');
    await connection.send('Runtime.disable');
    (owned.inspectorSessions ??= []).push(connection);
    kept = true;
  } finally { if (!kept) connection.close(); }
  return true;
}

export const closeInspectorSessions = owned => { for (const session of owned?.inspectorSessions?.splice(0) ?? []) session.close(); };

async function pageTargets(debugPort) {
  return (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1_000) })).json())
    .filter(row => row.type === 'page' && row.webSocketDebuggerUrl);
}

export async function runVisualQa(options, { log = console.log } = {}) {
  const outputDirectory = path.dirname(options.report);
  await fs.mkdir(outputDirectory, { recursive: true });
  const evidence = { schemaVersion: 1, kind: 'release-visual-qa', sourceRevision: process.env.GITHUB_SHA ?? null, runID: process.env.GITHUB_RUN_ID ?? null,
    version: options.version ?? null, steps: {}, screenshots: {}, upgradeRequired: Boolean(options.candidateUpgrade || options.requireUpgrade),
    ...(options.upgradeOnly ? { upgradeOnly: true } : {}) };
  const step = (name, passed, detail = {}) => { evidence.steps[name] = { passed, ...detail }; log(`[visual-qa] ${passed ? 'pass' : 'FAIL'} ${name}`); };
  let root, cdpModule, cdp, launched, upgradeLaunch, fixture, feedMirror, restoreLaunchEnvironment, failed = true;
  const cleanupFailures = [];
  const stopAll = async () => {
    cdp?.close(); cdp = null;
    for (const owned of [launched, upgradeLaunch]) {
      if (!owned) continue;
      closeInspectorSessions(owned);
      try { await owned.child.stop(); } catch (error) { cleanupFailures.push({ step: 'app', message: boundedDiagnostic(error?.message, root?.dir) }); }
    }
    // A relaunched app (after an update restart) is not our child; it is found only by its path inside this run root.
    if (root) {
      const stray = (await execute('/usr/bin/pgrep', ['-f', root.dir]).catch(() => ({ stdout: '' }))).stdout.trim().split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid);
      for (const pid of stray) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
      if (stray.length) {
        const deadline = Date.now() + 30_000;
        let left;
        do {
          await new Promise(resolve => setTimeout(resolve, 250));
          left = (await execute('/usr/bin/pgrep', ['-f', root.dir]).catch(() => ({ stdout: '' }))).stdout.trim();
        } while (left && Date.now() < deadline);
        if (left) cleanupFailures.push({ step: 'processes', message: 'processes from the run root survived SIGTERM' });
      }
    }
    try { await restoreLaunchEnvironment?.(); } catch (error) { cleanupFailures.push({ step: 'launch-environment', message: boundedDiagnostic(error?.message, root?.dir) }); }
  };
  const capture = async (name) => {
    const shot = await captureScreenshot(cdp);
    const bytes = Buffer.from(shot.data, 'base64');
    await fs.writeFile(path.join(outputDirectory, name), bytes);
    evidence.screenshots[name] = createHash('sha256').update(bytes).digest('hex');
  };
  try {
    const running = (await execute('/usr/bin/pgrep', ['-u', String(process.getuid?.() ?? ''), '-x', 'DevRyan']).catch(() => ({ stdout: '' }))).stdout.trim().split('\n').filter(Boolean);
    const refusal = visualQaHostRefusal({ isolatedHost: options.isolatedHost, runningApps: running });
    if (refusal) throw Object.assign(new Error(refusal), { code: refusal });
    root = createRunRoot({ parent: scratchParent('release-visual-qa'), owner: 'release-visual-qa', keepArtifacts: options.keepArtifacts, onInterrupt: stopAll });
    cdpModule = await import('./cdp.mjs');

    // 1. The DMG and its installation into the run root.
    const dmg = options.dmg ?? await downloadPublicDmg(options.version, root.dir);
    const sha = await sha256File(dmg);
    const manifest = options.manifest ? JSON.parse(await fs.readFile(options.manifest, 'utf8')) : null;
    const version = options.version ?? manifest?.version ?? /DevRyan-(\d+\.\d+\.\d+)-arm64\.dmg$/.exec(dmg)?.[1];
    if (!VERSION.test(version ?? '')) throw new Error('The DMG version is unknown; pass --version or --manifest');
    evidence.version = version;
    evidence.dmgSha256 = sha;
    const published = await publicRelease(`v${version}`).catch(() => null);
    const publishedDigest = published?.assets?.find(row => row.name === releaseAssetName('macos-arm64', version))?.digest ?? null;
    step('dmg', (!manifest || manifest.sha256 === sha) && (!publishedDigest || publishedDigest === `sha256:${sha}`),
      { manifest: manifest ? manifest.sha256 === sha : 'not given', published: publishedDigest ? publishedDigest === `sha256:${sha}` : 'unpublished' });
    const latestResponse = await publicReleaseResponse('latest');
    const latest = latestResponse.status === 200 ? JSON.parse(latestResponse.body)?.tag_name?.slice(1) ?? null : null;
    // An installed-upgrade lane qualifies only the upgrade: the visual-qa job
    // already ran steps 1-4 on these exact bytes.
    if (!options.upgradeOnly) {
      const installed = await installFromDmg(dmg, { mount: path.join(root.dir, 'mount'), applications: path.join(root.dir, 'Applications') });
      step('install', installed.volume.includes('DevRyan.app') && installed.volume.includes('Applications') && installed.shortVersion === version,
        { volume: installed.volume, shortVersion: installed.shortVersion, bundleId: installed.bundleId });

      // 2. Splash, then the ready main window. Its update check reads the real
      // /releases/latest bytes from a loopback mirror (see createFeedMirror).
      feedMirror = await createFeedMirror(latestResponse);
      launched = await launchApp(installed.app, { root: root.dir, name: 'candidate', fixture: feedMirror });
      const deadline = Date.now() + 180_000;
      let splash = false, ready = false;
      while (Date.now() < deadline && !ready) {
        launched.child.check();
        try {
          const targets = await pageTargets(launched.debugPort);
          const main = targets.find(row => row.url.startsWith(`http://127.0.0.1:${launched.port}/`));
          if (!splash && targets.length) {
            cdp = await cdpModule.CdpConnection.connect((main ?? targets[0]).webSocketDebuggerUrl);
            await capture('splash.png'); splash = true;
            step('splash', true, { url: main ? 'main-window' : 'splash-window' });
            cdp.close(); cdp = null;
          }
          if (main) {
            cdp ??= await cdpModule.CdpConnection.connect(main.webSocketDebuggerUrl);
            const health = await cdpModule.evaluate(cdp, `fetch('/api/health').then(r=>r.ok?r.json():null).then(h=>h?.isOpenCodeReady===true).catch(()=>false)`, { timeoutMs: 5_000 });
            if (health) ready = true;
          }
        } catch { cdp?.close(); cdp = null; }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!splash) step('splash', false);
      if (!ready) throw new Error('The main window did not become ready within 180 seconds');
      await new Promise(resolve => setTimeout(resolve, 2_000));
      const errorToasts = await cdpModule.evaluate(cdp, `document.querySelectorAll('[data-sonner-toast][data-type="error"]').length`, { timeoutMs: 5_000 });
      await capture('ready.png');
      step('ready', errorToasts === 0, { errorToasts });

      // 3. About shows exactly X.Y.Z.
      const invoke = (command, args) => cdpModule.evaluate(cdp, `window.__TAURI__.core.invoke(${JSON.stringify(command)}${args ? `, ${JSON.stringify(args)}` : ''})`, { timeoutMs: 120_000 });
      const appVersion = await invoke('desktop_get_app_version');
      const { createQaUiDriver } = await import('./ui-driver.mjs');
      const ui = createQaUiDriver(cdp, { timeoutMs: 30_000, checkAlive: () => launched.child.check() });
      await openSettingsAbout(ui, () => cdp.send('Page.bringToFront', {}, { timeoutMs: 5_000 }));
      await ui.waitVisibleText(version);
      await capture('about.png');
      step('about', appVersion === version && installed.shortVersion === version, { appVersion, shortVersion: installed.shortVersion });

      // 4. The real feed's answer for this version.
      const expected = expectedUpdate({ current: version, latest });
      const check = await invoke('desktop_check_for_updates');
      await capture('update-check.png');
      step('updateCheck', feedMirror.requests.discovery > 0 && check?.available === expected.available && (check?.version ?? null) === expected.version,
        { latest, offered: check?.version ?? null, expected, transport: { kind: 'token-read-feed-mirror', discovery: feedMirror.requests.discovery } });

      cdp.close(); cdp = null;
      closeInspectorSessions(launched);
      await launched.child.stop();
      launched = null;
      const left = (await execute('/usr/bin/pgrep', ['-f', root.dir]).catch(() => ({ stdout: '' }))).stdout.trim();
      step('stopped', !left);
    }

    // 5. Optional: the older release updates in place to X.Y.Z once X.Y.Z is the published latest.
    if (options.candidateUpgrade) fixture = await createUpdaterFixture({ dmg, manifestPath: options.manifest });
    // The supported floor release has no older install to update from.
    if (options.upgradeFrom && !options.requireUpgrade && !options.candidateUpgrade && !versionPredates(options.upgradeFrom.slice(1), version)) evidence.upgrade = { status: 'skipped', reason: 'no-older-supported-release', from: options.upgradeFrom.slice(1) };
    else if (options.upgradeFrom) evidence.upgrade = await upgradePath({ from: options.upgradeFrom.slice(1), to: version, sha256: sha, latest, fixture, root, capture: async (name, connection) => { cdp = connection; await capture(name); },
      captureInstalled: async name => {
        const file = path.join(outputDirectory, name);
        await execute('/usr/sbin/screencapture', ['-x', file], { timeout: 10_000 });
        evidence.screenshots[name] = await sha256File(file);
      },
      registerLaunchEnvironment: restore => { restoreLaunchEnvironment = restore; },
      register: owned => { upgradeLaunch = owned; }, cdpModule, log });
    failed = false;
  } catch (error) {
    evidence.error = { code: errorCode(error?.code), message: boundedDiagnostic(error?.message, root?.dir, 1200), ...(error?.detail ? { detail: error.detail } : {}) };
    if (cdp) await capture('failure.png').catch(() => {});
  } finally {
    if (fixture) evidence.upgradeTransport = { kind: 'isolated-inspector-fixture', sha256: fixture.sha256, ...fixture.requests };
    await stopAll();
    await fixture?.close();
    await feedMirror?.close();
    if (cleanupFailures.length) evidence.cleanupFailures = cleanupFailures;
    Object.assign(evidence, gradeVisualQa(evidence));
    if (failed && !evidence.failures.includes('error')) evidence.failures.push('error');
    evidence.passed = evidence.failures.length === 0;
    await fs.writeFile(options.report, `${JSON.stringify(evidence, null, 2)}\n`);
    root?.finish(evidence.passed ? 'passed' : 'failed');
  }
  return evidence;
}

/**
 * Some earlier shipped apps bound update cleanup to 10 s while their web server
 * waited up to 10 s for the renderer's live streams, so "Restart to update"
 * logged update_cleanup_timeout and kept running. QA then did what the app
 * asked: a confirmed quit (SIGTERM runs performConfirmedQuit, as Quit Now
 * does). No supported install (2.0.0 on) has that defect, so any baseline
 * that times out fails.
 */
export const SHIPPED_UPDATE_CLEANUP_TIMEOUT_BEFORE = '2.0.0';
export const ownerCleanupTimedOut = output => /\[electron\] update cleanup refused \{ code: 'update_cleanup_timeout' \}/.test(String(output ?? ''));
export function ownerQuitForShippedCleanupTimeout(from) {
  const [major, minor, patch] = from.split('.').map(Number), [fixedMajor, fixedMinor, fixedPatch] = SHIPPED_UPDATE_CLEANUP_TIMEOUT_BEFORE.split('.').map(Number);
  const older = major - fixedMajor || minor - fixedMinor || patch - fixedPatch;
  if (older >= 0) throw new Error(`v${from} refused its update quit (update_cleanup_timeout); only installs before v${SHIPPED_UPDATE_CLEANUP_TIMEOUT_BEFORE} have that defect`);
  return { reason: 'update_cleanup_timeout', action: 'confirmed quit (SIGTERM, performConfirmedQuit)', shippedDefectBefore: SHIPPED_UPDATE_CLEANUP_TIMEOUT_BEFORE };
}

/** Electron log files (owner and relaunched candidate) under each home's Library/Logs, wherever the app named its folder. */
export async function electronLogFiles(homes, { readdir = fs.readdir } = {}) {
  const files = [];
  for (const home of new Set(homes)) {
    const logs = path.join(home, 'Library/Logs');
    for (const entry of await readdir(logs, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/devryan|openchamber/i.test(entry.name)) continue;
      const directory = path.join(logs, entry.name);
      for (const scoped of [directory, ...(entry.name.startsWith('@') ? (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter(row => row.isDirectory()).map(row => path.join(directory, row.name)) : [])]) {
        for (const file of await readdir(scoped).catch(() => [])) if (/^(?:main|renderer)\.log$/.test(file)) files.push(path.join(scoped, file));
      }
    }
  }
  return files;
}

/** The relaunched app's unified log, recent crash reports and the launchd environment it inherited. */
export async function relaunchDiagnostics({ homes, root, run = execute, readdir = fs.readdir, readFile = fs.readFile, stat = fs.stat, now = Date.now() }) {
  const bounded = (text, limit) => boundedDiagnostic(String(text ?? '').trim().split('\n').slice(-80).join(' | '), root, limit);
  const unified = await run('/usr/bin/log', ['show', '--last', '6m', '--style', 'compact', '--predicate',
    'process == "DevRyan" OR (process == "launchservicesd" AND eventMessage CONTAINS[c] "devryan") OR (process == "open" AND eventMessage CONTAINS[c] "devryan")'],
  { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).then(result => bounded(result.stdout, 4_000), error => `unavailable: ${boundedDiagnostic(error?.message, root)}`);
  const crashes = [];
  for (const home of new Set(homes)) {
    const directory = path.join(home, 'Library/Logs/DiagnosticReports');
    for (const name of await readdir(directory).catch(() => [])) {
      if (!/devryan/i.test(name)) continue;
      const file = path.join(directory, name);
      if (now - (await stat(file).catch(() => ({ mtimeMs: 0 }))).mtimeMs > 15 * 60_000) continue;
      crashes.push({ name: boundedDiagnostic(name, root, 120), head: boundedDiagnostic((await readFile(file, 'utf8').catch(() => '')).slice(0, 3_000).replace(/\s+/g, ' '), root, 3_000) });
    }
  }
  const launchd = {};
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'DEVRYAN_ELECTRON_USER_DATA_DIR']) {
    launchd[key] = boundedDiagnostic((await run('/bin/launchctl', ['getenv', key], { timeout: 5_000 }).catch(() => ({ stdout: '(unset)' }))).stdout.trim() || '(unset)', root, 200);
  }
  return { unifiedLog: unified, crashReports: crashes.slice(0, 3), launchdEnvironment: launchd };
}

/** Owner process state and bounded, redacted log tails for an installer that never completed. */
export async function ownerDiagnostics({ pid, start, log, logFiles = [], root, run = execute, readFile = fs.readFile }) {
  const tail = (text, lines) => boundedDiagnostic(String(text ?? '').trim().split('\n').slice(-lines).join(' | '), root, 2_000);
  const state = (await run('/bin/ps', ['-o', 'stat=,etime=,lstart=', '-p', String(pid)]).catch(() => ({ stdout: '' }))).stdout.trim();
  const files = [];
  for (const file of logFiles) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text !== null) files.push({ file: boundedDiagnostic(file, root, 200), tail: tail(text, 40) });
  }
  return { owner: state ? { pid, state: boundedDiagnostic(state, root, 120), sameProcess: Boolean(start) && state.includes(start) } : { pid, state: 'exited' },
    output: tail(log, 30), logFiles: files };
}

// Ready, or why not: the HTTP status or health phase, never the payload.
const HEALTH_PROBE = `fetch('/api/health').then(r => r.ok ? r.json().then(h => h?.isOpenCodeReady === true || \`not-ready:\${String(h?.phase ?? h?.status ?? 'unknown').slice(0, 40)}\`) : \`http-\${r.status}\`).catch(() => 'unreachable')`;
const pageOrigin = url => { try { const parsed = new URL(url); return parsed.protocol === 'file:' ? 'file:' : parsed.origin; } catch { return 'invalid'; } };

/** What the baseline showed while it never became ready, bounded for the report. */
export function connectStallMessage({ origin, pages, health, error, process: state, log, root }) {
  const tail = String(log ?? '').trim().split('\n').slice(-12).join(' | ');
  return boundedDiagnostic(`The upgrade app did not become ready within 180 seconds (process: ${state ?? 'unknown'}; expected ${origin}; pages: ${pages ? `[${pages.join(', ')}]` : 'none listed'}; health: ${health ?? 'not probed'}; last error: ${error ?? 'none'}; log: ${tail || 'empty'})`, root, 1200);
}

async function upgradePath({ from, to, sha256, latest, fixture, root, capture, captureInstalled, registerLaunchEnvironment, register, cdpModule, log }) {
  if (!fixture && latest !== to) return { status: 'skipped', reason: `v${to} is not the published latest (the feed offers v${latest ?? 'nothing'})` };
  const directory = path.join(root.dir, 'upgrade');
  await fs.mkdir(directory, { recursive: true });
  const dmg = await downloadPublicDmg(from, directory);
  // The real installer accepts ~/Applications. HOME belongs to this run only.
  const installed = await installFromDmg(dmg, { mount: path.join(directory, 'mount'), applications: path.join(directory, 'home/Applications') });
  const home = path.join(directory, 'home');
  registerLaunchEnvironment(await setQaLaunchEnvironment({ ...qaPackagedAppEnvironment({ home, root: root.dir }),
    DEVRYAN_ELECTRON_USER_DATA_DIR: path.join(home, 'electron-profile') }));
  const owned = await launchApp(installed.app, { root: root.dir, name: 'upgrade', fixture });
  register(owned);
  const connect = async () => {
    const deadline = Date.now() + 180_000;
    const seen = { origin: `http://127.0.0.1:${owned.port}` };
    while (Date.now() < deadline) {
      try {
        if (owned.inspectorPort) await prepareFixtureInspector(owned, fixture);
        const pages = await pageTargets(owned.debugPort);
        seen.pages = pages.map(row => pageOrigin(row.url));
        const main = pages.find(row => row.url.startsWith(`${seen.origin}/`));
        if (main) {
          const connection = await cdpModule.CdpConnection.connect(main.webSocketDebuggerUrl);
          seen.health = await cdpModule.evaluate(connection, HEALTH_PROBE, { timeoutMs: 5_000 });
          if (seen.health === true) return connection;
          connection.close();
        }
      } catch (error) { seen.error = error?.message ?? String(error); } // the app is still starting or restarting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    try { owned.child.check(); seen.process = 'running'; } catch (error) { seen.process = error.message; }
    throw new Error(connectStallMessage({ ...seen, log: owned.child.getLog(), root: root.dir }));
  };
  let connection;
  try { connection = await connect(); }
  catch (error) { await captureInstalled('upgrade-failure.png').catch(() => {}); throw error; }
  const invoke = (command) => cdpModule.evaluate(connection, `window.__TAURI__.core.invoke(${JSON.stringify(command)})`, { timeoutMs: 20 * 60_000 });
  const before = await invoke('desktop_get_app_version');
  if (before !== from) return { status: 'failed', reason: `Baseline reported v${before}, expected v${from}` };
  const offer = await invoke('desktop_check_for_updates');
  if (offer?.version !== to) return { status: 'failed', reason: `v${before} was offered ${offer?.version ?? 'nothing'}, not v${to}` };
  await capture('upgrade-offer.png', connection);
  // CDP requests are capped at 30 seconds. Poll the installed app's promise so
  // a real public download and native verification keep their longer deadline.
  const mainTargets = await (await fetch(`http://127.0.0.1:${owned.inspectorPort}/json/list`, { signal: AbortSignal.timeout(1_000) })).json();
  const main = await cdpModule.CdpConnection.connect(mainTargets.find(row => row.webSocketDebuggerUrl).webSocketDebuggerUrl);
  let userDataDirectory, expected;
  try {
    userDataDirectory = await cdpModule.evaluate(main, `process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.getPath('userData')`);
    if (typeof userDataDirectory !== 'string' || !userDataDirectory.startsWith(`${root.dir}${path.sep}`)) throw new Error('Installed upgrade profile escaped the private run root');
    await cdpModule.evaluate(connection, `(() => { window.__TAURI__.core.invoke('desktop_download_and_install_update').catch(()=>null); return true; })()`);
    const downloadDeadline = Date.now() + 20 * 60_000;
    let observation = { lastBytes: 0, lastProgressAt: Date.now() };
    for (;;) {
      observation = observeInstalledDownload(await cdpModule.evaluate(main, 'globalThis.__devryanUpgradeQa'), observation);
      if (observation.complete) break;
      if (Date.now() >= downloadDeadline) throw new Error('Installed update download exceeded 20 minutes');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    connection.close();
    connection = await connect();
    await capture('upgrade-downloaded.png', connection);
    expected = { target: installed.app, from, to, sha256, ownerPID: owned.child.child.pid,
      ownerStart: await processStart(owned.child.child.pid) };
    if (!expected.ownerStart) throw new Error('Installed update owner identity is unavailable');
    await cdpModule.evaluate(connection, `(() => { window.__TAURI__.core.invoke('desktop_restart').catch(()=>null); return true; })()`, { timeoutMs: 10_000 });
    connection.close();
    // Preparation verifies the candidate before the owner drains; main stays
    // observable until it either refuses or quits into the installer.
    const preparationDeadline = Date.now() + 300_000;
    for (;;) {
      let progress;
      try { progress = await cdpModule.evaluate(main, 'globalThis.__devryanUpgradeQa', { timeoutMs: 5_000 }); }
      catch { break; } // The owner exited after preparation; its receipt decides.
      if (observeInstalledRestart(progress) === 'returned') break;
      if (Date.now() >= preparationDeadline) throw new Error('Installed update preparation did not finish within five minutes');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    // A process started with --inspect-brk does not exit while a debugger
    // session is attached, and the installer waits for the owner to exit.
    main.close();
    closeInspectorSessions(owned);
  }
  log('[visual-qa] restarting into the update');
  // The production installer uses LaunchServices, which deliberately does not
  // retain our debugger flags. Its sealed receipt proves the real relaunch.
  const intentPath = path.join(userDataDirectory, 'updates/install-intent.json');
  const deadline = Date.now() + 300_000;
  let intent, phase, ownerQuit = null;
  try {
    for (;;) {
      intent = await readUpdateIntent(intentPath, [path.dirname(installed.app)]).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (intent?.phase !== phase) { phase = intent?.phase; if (phase) log(`[visual-qa] installer ${phase}`); }
      if (installedReceiptComplete(intent, expected)) break;
      if (!ownerQuit && intent?.phase === 'waiting-for-owner' && ownerCleanupTimedOut(owned.child.getLog())) {
        // The owner refused to quit and told the user to quit; its installer is waiting.
        ownerQuit = ownerQuitForShippedCleanupTimeout(from);
        if (await processStart(expected.ownerPID) !== expected.ownerStart) throw new Error('Installed update owner changed before the confirmed quit');
        process.kill(expected.ownerPID, 'SIGTERM');
        log(`[visual-qa] v${from} refused its update quit (update_cleanup_timeout); quitting it as the app instructs`);
      }
      if (Date.now() >= deadline) throw new Error(`Installed update did not complete within five minutes (${phase ?? 'no receipt'})`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    // What the owner was doing when the installer gave up waiting for it.
    error.detail = await ownerDiagnostics({ pid: expected.ownerPID, start: expected.ownerStart, log: owned.child.getLog(),
      logFiles: await electronLogFiles([owned.home, os.homedir()]), root: root.dir });
    // Whether the relaunched candidate (not our child) was running at all.
    error.detail.runProcesses = boundedDiagnostic((await execute('/usr/bin/pgrep', ['-lf', root.dir]).catch(() => ({ stdout: '' }))).stdout.trim().split('\n').join(' | ') || 'none', root.dir, 1_000);
    // LaunchServices relaunches the candidate outside QA: its output, crash and environment.
    Object.assign(error.detail, await relaunchDiagnostics({ homes: [owned.home, os.homedir()], root: root.dir }));
    throw error;
  }
  if (await processStart(expected.ownerPID) === expected.ownerStart || intent.candidatePID === expected.ownerPID
    || !intent.candidateStart || await processStart(intent.candidatePID) !== intent.candidateStart) throw new Error('Installed update process identity did not advance');
  const verified = await verifyMacUpdateBundle(installed.app, { version: to, signing: intent.candidateSigning });
  if (verified.dev !== intent.candidateIdentity?.dev || verified.ino !== intent.candidateIdentity?.ino
    || verified.signing.cdhash !== intent.candidateSigning.cdhash || verified.manifestSha256 !== intent.manifestSha256) throw new Error('Installed candidate does not match its completed receipt');
  const health = await fetch(`http://127.0.0.1:${owned.port}/api/health`, { signal: AbortSignal.timeout(5_000) }).then(response => response.ok ? response.json() : null);
  if (health?.isOpenCodeReady !== true) throw new Error('Installed candidate runtime is not ready');
  await captureInstalled('upgrade-ready.png');
  const kept = await fs.readFile(path.join(owned.home, '.config/devryan/settings.json'), 'utf8').then(text => {
    const settings = JSON.parse(text);
    return settings.desktopLanAccessEnabled === false && settings.desktopLocalPort === owned.port && settings.lastDirectory === owned.home;
  }, () => false);
  return { status: kept ? 'passed' : 'failed', from: before, to, settingsKept: kept,
    installer: { phase: intent.phase, version: intent.version, manifestSha256: verified.manifestSha256, processIdentityAdvanced: true, runtimeReady: true,
      ...(ownerQuit ? { ownerQuit } : {}) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseVisualQaArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  const evidence = await runVisualQa(options);
  console.log(JSON.stringify({ passed: evidence.passed, failures: evidence.failures }));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Release visual QA\n\n${evidence.passed ? 'Passed' : `Failed: ${evidence.failures.join(', ')}${evidence.error?.message ? ` (${evidence.error.message})` : ''}`}\n`);
  }
  process.exitCode = evidence.passed ? 0 : 1;
}
