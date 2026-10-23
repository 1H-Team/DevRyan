#!/usr/bin/env node
// Release visual QA (non-gating): the unchanged release DMG on a disposable
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

const execute = promisify(execFile);
const VERSION = /^\d+\.\d+\.\d+$/;
const STEPS = Object.freeze(['dmg', 'install', 'splash', 'ready', 'about', 'updateCheck', 'stopped']);

export function parseVisualQaArgs(argv) {
  const options = { isolatedHost: false, keepArtifacts: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--isolated-host') options.isolatedHost = true;
    else if (flag === '--keep-artifacts') options.keepArtifacts = true;
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

export function gradeVisualQa(evidence) {
  const failures = STEPS.filter(step => evidence.steps?.[step]?.passed !== true);
  if (evidence.upgrade && !['passed', 'skipped'].includes(evidence.upgrade.status)) failures.push('upgrade');
  if (evidence.cleanupFailures?.length) failures.push('cleanup');
  return { passed: failures.length === 0, failures };
}

const sha256File = async file => {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close().catch(() => {}); }
  return hash.digest('hex');
};

async function publicRelease(tag, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/${tag === 'latest' ? 'latest' : `tags/${tag}`}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Release discovery for ${tag} failed (${response.status})`);
  return response.json();
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
async function launchApp(app, { root, name }) {
  const home = path.join(root, name, 'home');
  await fs.mkdir(path.join(home, '.config/devryan'), { recursive: true });
  const port = await reservePort(), debugPort = await reservePort();
  await fs.writeFile(path.join(home, '.config/devryan/settings.json'), JSON.stringify({ desktopLocalPort: port, desktopLanAccessEnabled: false,
    enableBackgroundBots: false, productionBotsRuntimeMode: 'disabled', lastDirectory: home }));
  const env = qaPackagedAppEnvironment({ home, root });
  const child = startOwnedProcess(path.join(app, 'Contents/MacOS/DevRyan'),
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(home, 'electron-profile')}`, '--use-mock-keychain'], { cwd: home, env });
  return { child, home, port, debugPort };
}

async function pageTargets(debugPort) {
  return (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1_000) })).json())
    .filter(row => row.type === 'page' && row.webSocketDebuggerUrl);
}

export async function runVisualQa(options, { log = console.log } = {}) {
  const outputDirectory = path.dirname(options.report);
  await fs.mkdir(outputDirectory, { recursive: true });
  const evidence = { schemaVersion: 1, kind: 'release-visual-qa', sourceRevision: process.env.GITHUB_SHA ?? null, runID: process.env.GITHUB_RUN_ID ?? null,
    version: options.version ?? null, steps: {}, screenshots: {}, nonGating: true };
  const step = (name, passed, detail = {}) => { evidence.steps[name] = { passed, ...detail }; log(`[visual-qa] ${passed ? 'pass' : 'FAIL'} ${name}`); };
  let root, cdpModule, cdp, launched, upgradeLaunch, failed = true;
  const cleanupFailures = [];
  const stopAll = async () => {
    cdp?.close(); cdp = null;
    for (const owned of [launched, upgradeLaunch]) {
      if (!owned) continue;
      try { await owned.child.stop(); } catch (error) { cleanupFailures.push({ step: 'app', message: boundedDiagnostic(error?.message, root?.dir) }); }
    }
    // A relaunched app (after an update restart) is not our child; it is found only by its path inside this run root.
    if (root) {
      const stray = (await execute('/usr/bin/pgrep', ['-f', root.dir]).catch(() => ({ stdout: '' }))).stdout.trim().split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid);
      for (const pid of stray) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
      if (stray.length) {
        await new Promise(resolve => setTimeout(resolve, 5_000));
        const left = (await execute('/usr/bin/pgrep', ['-f', root.dir]).catch(() => ({ stdout: '' }))).stdout.trim();
        if (left) cleanupFailures.push({ step: 'processes', message: 'processes from the run root survived SIGTERM' });
      }
    }
  };
  const capture = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 10_000 });
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
    const installed = await installFromDmg(dmg, { mount: path.join(root.dir, 'mount'), applications: path.join(root.dir, 'Applications') });
    step('install', installed.volume.includes('DevRyan.app') && installed.volume.includes('Applications') && installed.shortVersion === version,
      { volume: installed.volume, shortVersion: installed.shortVersion, bundleId: installed.bundleId });

    // 2. Splash, then the ready main window.
    launched = await launchApp(installed.app, { root: root.dir, name: 'candidate' });
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
    await ui.key(',', { code: 'Comma', modifiers: 4 });
    await ui.click({ text: 'About', selector: 'button,[role="button"],a,[role="tab"],[role="menuitem"]' });
    await ui.waitVisibleText(version);
    await capture('about.png');
    step('about', appVersion === version && installed.shortVersion === version, { appVersion, shortVersion: installed.shortVersion });

    // 4. The real feed's answer for this version.
    const latest = (await publicRelease('latest'))?.tag_name?.slice(1) ?? null;
    const expected = expectedUpdate({ current: version, latest });
    const check = await invoke('desktop_check_for_updates');
    await capture('update-check.png');
    step('updateCheck', check?.available === expected.available && (check?.version ?? null) === expected.version, { latest, offered: check?.version ?? null, expected });

    cdp.close(); cdp = null;
    await launched.child.stop();
    launched = null;
    const left = (await execute('/usr/bin/pgrep', ['-f', root.dir]).catch(() => ({ stdout: '' }))).stdout.trim();
    step('stopped', !left);

    // 5. Optional: the older release updates in place to X.Y.Z once X.Y.Z is the published latest.
    if (options.upgradeFrom) evidence.upgrade = await upgradePath({ from: options.upgradeFrom.slice(1), to: version, latest, root, capture: async (name, connection) => { cdp = connection; await capture(name); },
      register: owned => { upgradeLaunch = owned; }, cdpModule, log });
    failed = false;
  } catch (error) {
    evidence.error = { code: boundedDiagnostic(error?.code ?? ''), message: boundedDiagnostic(error?.message, root?.dir) };
    if (cdp) await capture('failure.png').catch(() => {});
  } finally {
    await stopAll();
    if (cleanupFailures.length) evidence.cleanupFailures = cleanupFailures;
    Object.assign(evidence, gradeVisualQa(evidence));
    if (failed && !evidence.failures.includes('error')) evidence.failures.push('error');
    evidence.passed = evidence.failures.length === 0;
    await fs.writeFile(options.report, `${JSON.stringify(evidence, null, 2)}\n`);
    root?.finish(evidence.passed ? 'passed' : 'failed');
  }
  return evidence;
}

async function upgradePath({ from, to, latest, root, capture, register, cdpModule, log }) {
  if (latest !== to) return { status: 'skipped', reason: `v${to} is not the published latest (the feed offers v${latest ?? 'nothing'})` };
  const directory = path.join(root.dir, 'upgrade');
  await fs.mkdir(directory, { recursive: true });
  const dmg = await downloadPublicDmg(from, directory);
  const installed = await installFromDmg(dmg, { mount: path.join(directory, 'mount'), applications: path.join(directory, 'Applications') });
  const owned = await launchApp(installed.app, { root: root.dir, name: 'upgrade' });
  register(owned);
  const connect = async () => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      try {
        const main = (await pageTargets(owned.debugPort)).find(row => row.url.startsWith(`http://127.0.0.1:${owned.port}/`));
        if (main) {
          const connection = await cdpModule.CdpConnection.connect(main.webSocketDebuggerUrl);
          if (await cdpModule.evaluate(connection, `fetch('/api/health').then(r=>r.ok?r.json():null).then(h=>h?.isOpenCodeReady===true).catch(()=>false)`, { timeoutMs: 5_000 })) return connection;
          connection.close();
        }
      } catch { /* the app is still starting or restarting */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('The upgrade app did not become ready within 180 seconds');
  };
  let connection = await connect();
  const invoke = (command) => cdpModule.evaluate(connection, `window.__TAURI__.core.invoke(${JSON.stringify(command)})`, { timeoutMs: 20 * 60_000 });
  const before = await invoke('desktop_get_app_version');
  const offer = await invoke('desktop_check_for_updates');
  if (offer?.version !== to) return { status: 'failed', reason: `v${before} was offered ${offer?.version ?? 'nothing'}, not v${to}` };
  await capture('upgrade-offer.png', connection);
  await invoke('desktop_download_and_install_update');
  await capture('upgrade-downloaded.png', connection);
  await cdpModule.evaluate(connection, `window.__TAURI__.core.invoke('desktop_restart').catch(()=>null)`, { timeoutMs: 10_000 }).catch(() => null);
  connection.close();
  log('[visual-qa] restarting into the update');
  connection = await connect();
  const after = await invoke('desktop_get_app_version');
  await capture('upgrade-about.png', connection);
  const kept = await fs.readFile(path.join(owned.home, '.config/devryan/settings.json'), 'utf8').then(text => JSON.parse(text).desktopLanAccessEnabled === false, () => false);
  connection.close();
  return { status: after === to && kept ? 'passed' : 'failed', from: before, to: after, settingsKept: kept };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseVisualQaArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  const evidence = await runVisualQa(options);
  console.log(JSON.stringify({ passed: evidence.passed, failures: evidence.failures }));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Release visual QA (non-gating)\n\n${evidence.passed ? 'Passed' : `Failed: ${evidence.failures.join(', ')}${evidence.error?.message ? ` (${evidence.error.message})` : ''}`}\n`);
  }
  process.exitCode = evidence.passed ? 0 : 1;
}
