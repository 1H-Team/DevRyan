// Release upgrade lane: age a private profile through the previous published
// releases' own server code and shipped native runtimes, then cold-start this
// checkout with the candidate runtime and require the production startup
// upgrade, verifier and native readiness to succeed. Headless; no Electron.
// Usage: docs/QA.md "Release upgrade lane".
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createV200PrepareEnvironment } from './first-launch-smoke.mjs';
import { startOwnedProcess } from './process.mjs';
import { createRunRoot, scratchParent } from './run-root.mjs';
import { createPhaseTimings } from './phase-timings.mjs';
import { withMountedDmg } from './mounted-dmg.mjs';
import { runUpgradeCommand as run, stopUpgradeChildren, trackUpgradeChild } from './upgrade-processes.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
export const DIRECT_UPGRADE_BASELINES = Object.freeze(['v2.0.2', 'v2.0.15']);
// These are the shipped releases, not approximations built with today's server.
// 2.0.2 predates the startup-upgrade status module; readiness and its actual
// selected descriptor still have to prove that its profile was provisioned.
export function releaseHopAdapter(release) {
  if (release === 'v2.0.2') return { statusModule: false };
  if (/^v2\.0\./.test(release) && !['v2.0.10', 'v2.0.11', 'v2.0.12', 'v2.0.15'].includes(release)) throw new Error(`Unsupported legacy release hop: ${release}`);
  return { statusModule: true };
}
const USAGE = 'Usage: node scripts/qa/release-upgrade-lane.mjs --candidate-artifacts <abs dir> [--chain v2.0.12,v2.0.15,v2.1.0 | --direct-baseline v2.0.2|v2.0.15] [--report <abs JSON>] [--hop-timeout-ms 240000] [--keep-artifacts]';
const usageError = message => Object.assign(new Error(`${message}\n${USAGE}`), { code: 'qa_release_upgrade_usage' });

export function parseReleaseUpgradeArgs(argv) {
  const options = { chain: null, hopTimeoutMs: 240000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep-artifacts') continue;
    const value = argv[index + 1];
    if (!['--candidate-artifacts', '--chain', '--hop-timeout-ms', '--direct-baseline', '--report'].includes(flag)) throw usageError(`Unknown argument: ${flag}`);
    if (value === undefined || value === '' || value.startsWith('--')) throw usageError(`${flag} requires a value`);
    index += 1;
    if (flag === '--report') {
      if (!path.isAbsolute(value)) throw usageError('--report must be absolute');
      options.report = value;
    } else if (flag === '--direct-baseline') {
      if (!DIRECT_UPGRADE_BASELINES.includes(value)) throw usageError('--direct-baseline must be v2.0.2 or v2.0.15');
      options.directBaseline = value;
    } else if (flag === '--candidate-artifacts') {
      if (!path.isAbsolute(value)) throw usageError('--candidate-artifacts must be absolute');
      options.candidateArtifacts = value;
    } else if (flag === '--chain') {
      const tags = value.split(',');
      if (!tags.length || tags.some(tag => !RELEASE_TAG.test(tag)) || new Set(tags).size !== tags.length) throw usageError('--chain takes distinct vX.Y.Z tags, oldest first');
      options.chain = tags;
    } else {
      const timeout = Number(value);
      if (!Number.isInteger(timeout) || timeout < 30000) throw usageError('--hop-timeout-ms must be an integer of at least 30000');
      options.hopTimeoutMs = timeout;
    }
  }
  if (!options.candidateArtifacts) throw usageError('--candidate-artifacts is required');
  if (options.directBaseline && options.chain) throw usageError('--direct-baseline and --chain are mutually exclusive');
  return options;
}

/** The newest `count` published (non-draft, non-prerelease) release tags, oldest first. */
export function selectPreviousReleases(releases, count = 3) {
  return releases.filter(release => !release.isDraft && !release.isPrerelease && RELEASE_TAG.test(release.tagName))
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, count).map(release => release.tagName).reverse();
}

/**
 * Pure grading. Aging hops reproduce what installed users have: a refused or
 * failed published upgrade is recorded, not a lane failure, because users stay
 * on the runtime it left. Only the candidate hop must upgrade, verify, become
 * ready and keep the surviving sessions while the deleted ones stay gone.
 */
export function gradeReleaseUpgrade({ hops, candidate, candidateManifestSha256, directBaseline = false }) {
  const failures = [];
  if ([...hops, candidate].some(hop => hop?.exited === false || hop?.cleanupErrors?.length)) failures.push('A hop timed out or left an owned process running');
  if (!hops.length || hops[0].result?.provisioned !== true) failures.push('The oldest release did not provision a profile');
  if (directBaseline && (hops.length !== 1 || hops[0].result?.ready !== true || hops[0].result?.kept?.length !== 1 || hops[0].result?.deleted?.length !== 1)) {
    failures.push('The direct baseline did not become ready and create/delete its retained history fixture');
  }
  const result = candidate?.result ?? {};
  if (result.error) failures.push(`Candidate startup failed: ${result.error.code ?? 'error'}`);
  if (result.upgradeFailure) failures.push(`Candidate startup upgrade was refused: ${result.upgradeFailure}`);
  if (result.selected?.artifactManifestSha256 !== candidateManifestSha256) failures.push('The candidate runtime is not the selected bundle');
  if (result.ready !== true) failures.push('The candidate native runtime did not become ready');
  const kept = hops.flatMap(hop => hop.result?.kept ?? []), deleted = hops.flatMap(hop => hop.result?.deleted ?? []);
  if (!kept.length || !deleted.length) failures.push('The historical chain did not create retained and deleted history');
  const listed = new Set(result.sessions ?? []);
  const lost = kept.filter(id => !listed.has(id)), revived = deleted.filter(id => listed.has(id));
  if (lost.length) failures.push(`Sessions lost across the upgrade: ${lost.join(', ')}`);
  if (revived.length) failures.push(`Deleted sessions reappeared: ${revived.join(', ')}`);
  return { passed: failures.length === 0, failures };
}

/** What the data-root migration sees: the pre-rename folder and the DevRyan root. */
export async function inspectDataRoots(home) {
  const describe = async directory => {
    const stat = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return { kind: 'absent' };
    if (stat.isSymbolicLink()) return { kind: 'link', target: await readlink(directory) };
    return stat.isDirectory() ? { kind: 'directory', entries: (await readdir(directory)).sort() } : { kind: 'other' };
  };
  return { legacy: await describe(path.join(home, '.config', 'openchamber')), root: await describe(path.join(home, '.config', 'devryan')) };
}

/**
 * Pure grading of the data-root migration across the candidate start: the aged
 * ~/.config/openchamber must become (or remain) a link to devryan, and every
 * entry in the aged root must remain in ~/.config/devryan.
 */
export function gradeDataRootMigration({ before, after }) {
  const failures = [];
  const alreadyMigrated = before?.legacy?.kind === 'link' && before.legacy.target === 'devryan'
    && before?.root?.kind === 'directory';
  if (!alreadyMigrated) {
    if (before?.legacy?.kind !== 'directory') failures.push('The aged profile has no ~/.config/openchamber folder to migrate');
    if (before?.root?.kind !== 'absent') failures.push('~/.config/devryan existed before the candidate start without the migration link');
  }
  if (after?.legacy?.kind !== 'link' || after.legacy.target !== 'devryan') failures.push('~/.config/openchamber is not a link to devryan after the candidate start');
  if (after?.root?.kind !== 'directory') failures.push('~/.config/devryan is not a folder after the candidate start');
  const moved = new Set(after?.root?.entries ?? []);
  const missing = ((alreadyMigrated ? before.root.entries : before?.legacy?.entries) ?? []).filter(name => !moved.has(name));
  if (missing.length) failures.push(`Entries missing after the move: ${missing.join(', ')}`);
  return { passed: failures.length === 0, failures };
}

/**
 * Pure grading of the held-recovery fixture. A selection that requires rollback
 * reconciliation must start only the recovery composition: health 503 with the
 * held runtime, a held bundle at the same revision, no readiness, and an
 * untouched selection. Once the hold is cleared, the candidate must start ready
 * on the same bundle with the history the aging hops left.
 */
export function gradeHeldRecovery({ hops, held, selectionUnchanged, selectedRevision, resumed, candidateManifestSha256 }) {
  const failures = [];
  const result = held?.result ?? {}, status = result.held ?? {};
  if (held?.exited === false || held?.cleanupErrors?.length) failures.push('Held recovery timed out or left an owned process running');
  if (result.error) failures.push(`Held startup failed: ${result.error.code ?? 'error'}`);
  if (status.healthStatus !== 503 || status.executionRuntime !== 'held') failures.push('The held selection did not start the recovery composition');
  if (status.bundleState !== 'held' || status.reconciliationRequired !== true || status.revision !== selectedRevision) failures.push('Recovery did not report the held selection');
  if (result.ready !== false) failures.push('The held selection reported a ready runtime');
  if (selectionUnchanged !== true) failures.push('The held start changed the selection');
  const after = gradeReleaseUpgrade({ hops, candidate: resumed, candidateManifestSha256 });
  failures.push(...after.failures.map(failure => `After the hold cleared: ${failure}`));
  return { passed: failures.length === 0, failures };
}

// Runs inside one release's source tree. Importing server/index.js performs
// that release's own provisioning or cold startup upgrade, exactly as at launch.
const HOP_CHILD = `
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const request = JSON.parse(process.argv[1]);
const result = { provisioned: false, ready: false, kept: [], deleted: [], sessions: [] };
let server;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const status = request.statusModule ? await import(request.statusModule) : {};
  const application = await import(request.serverModule);
  result.upgradeFailure = status.readStartupBundleUpgradeFailure?.() ?? null;
  const selectionPath = path.join(request.controlRoot, 'selection.json');
  result.provisioned = existsSync(selectionPath);
  if (result.provisioned) {
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
    const descriptor = JSON.parse(readFileSync(path.join(request.controlRoot, 'bundles', selection.selectedBundleID, 'descriptor.json'), 'utf8'));
    result.selected = { bundleID: selection.selectedBundleID, revision: selection.revision, artifactManifestSha256: descriptor.launch.artifactManifestSha256 };
  }
  server = await application.startWebUiServer({ host: '127.0.0.1', port: 0, attachSignals: false });
  if (request.expectHeld) {
    // The recovery composition never becomes ready; inspect it instead of waiting.
    const get = async route => {
      const response = await fetch('http://127.0.0.1:' + server.getPort() + route, { signal: AbortSignal.timeout(30000) });
      return { status: response.status, body: await response.json() };
    };
    const health = await get('/api/health'), bundle = await get('/api/runtime/bundle');
    result.held = { healthStatus: health.status, executionRuntime: health.body?.executionRuntime?.state ?? null,
      bundleState: bundle.body?.state ?? null, reconciliationRequired: bundle.body?.reconciliationRequired === true, revision: bundle.body?.revision ?? null };
  } else {
    const deadline = Date.now() + request.readyTimeoutMs;
    while (!server.isReady() && Date.now() < deadline) await delay(500);
  }
  result.ready = server.isReady();
  if (result.ready) {
    const origin = 'http://127.0.0.1:' + server.getPort(), owner = await server.issueLocalOwnerSession();
    const directory = encodeURIComponent(request.workspace);
    const api = async (method, route, body) => {
      const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000),
        headers: { origin, cookie: owner.name + '=' + owner.value, 'content-type': 'application/json', 'x-devryan-csrf': '1', 'x-opencode-directory': directory },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw Object.assign(new Error(method + ' ' + route.split('?')[0] + ' HTTP ' + response.status), { code: 'qa_release_upgrade_api' });
      return response.status === 204 ? null : response.json();
    };
    const listed = await api('GET', '/api/session?directory=' + directory);
    result.sessions = listed.map(row => row.id);
    if (request.activity) {
      const kept = await api('POST', '/api/session?directory=' + directory, { title: 'Upgrade lane ' + request.release });
      const removed = await api('POST', '/api/session?directory=' + directory, { title: 'Upgrade lane deleted ' + request.release });
      await api('DELETE', '/api/session/' + removed.id + '?directory=' + directory);
      result.kept.push(kept.id); result.deleted.push(removed.id);
    }
  }
} catch (error) {
  result.error = { code: typeof error?.code === 'string' ? error.code : null, message: String(error?.message ?? error).slice(0, 400) };
} finally {
  try { await server?.stop?.({ exitProcess: false }); } catch (error) { result.stopError = String(error?.message ?? error).slice(0, 200); }
}
writeFileSync(request.resultPath, JSON.stringify(result), { mode: 0o600 });
process.exit(0);
`;

const settledInputs = async operations => {
  const results = await Promise.allSettled(operations);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
};

/** The shipped native runtime of a published release, copied with its modes and signatures. */
async function fetchReleaseArtifacts(tag, root) {
  const download = path.join(root, 'downloads', tag), mount = path.join(root, 'mounts', tag), target = path.join(root, 'artifacts', tag);
  await mkdir(download, { recursive: true }); await mkdir(mount, { recursive: true });
  const release = JSON.parse((await run('gh', ['api', `repos/1H-Team/DevRyan/releases/tags/${tag}`], { cwd: repository })).stdout);
  const assets = release.assets.filter(asset => asset.name === `DevRyan-${tag.slice(1)}-arm64.dmg`);
  if (release.draft || release.prerelease || assets.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest ?? '')) {
    throw new Error('Baseline release lacks a verified installer identity');
  }
  await run('gh', ['release', 'download', tag, '--pattern', assets[0].name, '--dir', download], { cwd: repository });
  const bytes = await readFile(path.join(download, assets[0].name));
  if (bytes.length !== assets[0].size || `sha256:${digest(bytes)}` !== assets[0].digest) throw new Error('Baseline installer digest mismatch');
  const dmg = assets[0].name;
  await withMountedDmg(path.join(download, dmg), mount, () => run('/usr/bin/ditto', [path.join(mount, 'DevRyan.app/Contents/Resources/revert-runtime/darwin-arm64'), target]), run);
  return { artifacts: target, installerSha256: assets[0].digest, assetID: assets[0].id, releaseID: release.id };
}

/** The release's own source at its tag, installed without the Electron prepare step. */
async function prepareReleaseSource(tag, root) {
  const target = path.join(root, 'source', tag);
  await mkdir(target, { recursive: true });
  await mkdir(path.join(root, 'downloads'), { recursive: true });
  const archive = path.join(root, 'downloads', `${tag}.tar`);
  const revision = (await run('git', ['rev-parse', `${tag}^{commit}`], { cwd: repository })).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Baseline source revision is invalid');
  await run('git', ['archive', '--format=tar', '-o', archive, revision], { cwd: repository });
  await run('/usr/bin/tar', ['-xf', archive, '-C', target]);
  await run('bun', ['install', '--frozen-lockfile'], { cwd: target, env: { ...process.env, DEVRYAN_SKIP_INSTALL_PREPARE: '1' }, timeout: 600000 });
  return { source: target, sourceRevision: revision };
}

async function runHop({ release, source, artifacts, layout, activity, expectHeld = false, timeoutMs }) {
  const resultPath = path.join(layout.root, `hop-${release}.json`);
  const env = { ...createV200PrepareEnvironment({ home: layout.home }), DEVRYAN_EXECUTION_ARTIFACTS: artifacts,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: layout.root };
  const request = { release, workspace: layout.workspace, controlRoot: layout.controlRoot, resultPath, activity, expectHeld, readyTimeoutMs: timeoutMs - 30000,
    serverModule: pathToFileURL(path.join(source, 'packages/web/server/index.js')).href,
    statusModule: releaseHopAdapter(release).statusModule ? pathToFileURL(path.join(source, 'packages/web/server/lib/opencode/runtime-host/bundle-startup-upgrade-status.js')).href : null };
  const started = performance.now();
  const child = startOwnedProcess(process.execPath, ['--input-type=module', '-e', HOP_CHILD, JSON.stringify(request)], { cwd: layout.workspace, env });
  const untrack = trackUpgradeChild(child);
  const exited = await new Promise(resolve => {
    if (child.child.exitCode !== null || child.child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  const cleanupErrors = [];
  try { await child.stop(); } catch { cleanupErrors.push('Owned hop process cleanup failed'); } finally { untrack(); }
  let result = null;
  try { result = JSON.parse(await readFile(resultPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { release, exited, elapsedMs: Math.round(performance.now() - started), result, cleanupErrors, log: result?.ready ? undefined : child.getLog().slice(-4000) };
}

/**
 * Held-recovery fixture on the upgraded profile. Marking the selection as
 * requiring rollback reconciliation is the state a crashed rollback leaves; a
 * cold start must route to the recovery composition and change nothing. The
 * fixture then restores the exact selection bytes (the owner's resume needs the
 * original rollback checkpoint, which no published hop produces) and requires a
 * normal ready start on the same bundle.
 */
async function runHeldRecovery({ hops, layout, artifacts, candidateManifestSha256, timeoutMs }) {
  const selectionPath = path.join(layout.controlRoot, 'selection.json');
  const original = await readFile(selectionPath), selection = JSON.parse(original.toString('utf8'));
  if (selection.reconciliationRequired !== false) throw Object.assign(new Error('The upgraded selection is already held'), { code: 'qa_release_upgrade_held_fixture' });
  const heldBytes = Buffer.from(JSON.stringify({ ...selection, reconciliationRequired: true }));
  await writeFile(selectionPath, heldBytes, { mode: 0o600 });
  let held, selectionUnchanged;
  try {
    held = await runHop({ release: 'held-recovery', source: repository, artifacts, layout, activity: false, expectHeld: true, timeoutMs });
    selectionUnchanged = (await readFile(selectionPath)).equals(heldBytes);
  } finally { await writeFile(selectionPath, original, { mode: 0o600 }); }
  const resumed = await runHop({ release: 'held-cleared', source: repository, artifacts, layout, activity: false, timeoutMs });
  const grade = gradeHeldRecovery({ hops, held, selectionUnchanged, selectedRevision: selection.revision, resumed, candidateManifestSha256 });
  return { held, selectionUnchanged, resumed, ...grade };
}

const reportHop = ({ log, result, ...hop }) => {
  if (!result) return { ...hop, result };
  const { error, stopError, ...safe } = result;
  return { ...hop, result: { ...safe, ...(error ? { error: { code: error.code ?? 'qa_release_upgrade_failed' } } : {}),
    ...(stopError ? { stopFailed: true } : {}) } };
};

export function finishUpgradeScratch(runRoot, status) {
  runRoot.finish(status);
  if (!runRoot.keepArtifacts && existsSync(runRoot.dir)) throw new Error('Qualification scratch cleanup incomplete');
}

async function* releaseUpgradePhases(options) {
  const timings = createPhaseTimings();
  const runRoot = createRunRoot({ parent: scratchParent('release-upgrade'), owner: 'release-upgrade-lane', onInterrupt: stopUpgradeChildren });
  try {
    const root = await realpath(runRoot.dir);
    const chain = options.directBaseline ? [options.directBaseline] : options.chain ?? selectPreviousReleases(JSON.parse((await run('gh', ['release', 'list', '--limit', '20',
      '--json', 'tagName,isDraft,isPrerelease,publishedAt'], { cwd: repository })).stdout));
    if (!chain.length || !options.directBaseline && !options.chain && chain.length !== 3) throw Object.assign(new Error('No published release to upgrade from'), { code: 'qa_release_upgrade_no_baseline' });
    const layout = { root, home: path.join(root, 'home'), workspace: path.join(root, 'workspace') };
    layout.controlRoot = path.join(layout.home, '.local/state/devryan/runtime-bundles');
    for (const directory of [layout.home, layout.workspace]) await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(path.join(root, 'git-template'), { mode: 0o700 });
    await run('git', ['init', '--quiet', '--initial-branch=main', `--template=${path.join(root, 'git-template')}`], { cwd: layout.workspace,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root } });
    await writeFile(path.join(layout.workspace, 'README.md'), '# Release upgrade lane\n');
    // The installed desktop app always has its host folder; seed it so the
    // candidate's data-root migration has data to move even when a headless
    // release hop writes nothing there.
    await mkdir(path.join(layout.home, '.config', 'openchamber'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(layout.home, '.config', 'openchamber', 'release-upgrade-sentinel.json'), '{"kept":true}\n', { mode: 0o600 });
    const prepareInput = options.prepareInput ?? createBaselineInputs(root);
    const prepared = await settledInputs(chain.map(release => prepareInput(release, timings)));
    const baselineInputs = prepared.map(({ source, artifacts, ...identity }) => identity);
    const hops = [];
    for (const { release, source, artifacts } of prepared) {
      hops.push(await timings.measure(`historical-hop:${release}`, () => runHop({ release, source, artifacts, layout, activity: true, timeoutMs: options.hopTimeoutMs })));
    }
    const candidateArtifacts = yield { chain, baselineInputs, hops: hops.map(reportHop) };
    if (!path.isAbsolute(candidateArtifacts ?? '')) throw usageError('Candidate artifacts must be absolute');
    const candidateManifestSha256 = digest(await readFile(path.join(candidateArtifacts, 'native-bundle.json')));
    const dataRootsBefore = await inspectDataRoots(layout.home);
    const candidate = await timings.measure('candidate-hop', () => runHop({ release: 'candidate', source: repository, artifacts: candidateArtifacts, layout, activity: false, timeoutMs: options.hopTimeoutMs }));
    const dataRoots = { before: dataRootsBefore, after: await inspectDataRoots(layout.home) };
    const dataRootGrade = gradeDataRootMigration(dataRoots);
    const releaseGrade = gradeReleaseUpgrade({ hops, candidate, candidateManifestSha256, directBaseline: Boolean(options.directBaseline) });
    const upgrade = { passed: releaseGrade.passed && dataRootGrade.passed,
      failures: [...releaseGrade.failures, ...dataRootGrade.failures.map(failure => `Data root: ${failure}`)] };
    const heldRecovery = upgrade.passed ? await timings.measure('held-recovery', () => runHeldRecovery({ hops, layout, artifacts: candidateArtifacts,
      candidateManifestSha256, timeoutMs: options.hopTimeoutMs })) : { passed: false, failures: ['Not run: the candidate upgrade failed'] };
    const grade = { passed: upgrade.passed && heldRecovery.passed,
      failures: [...upgrade.failures, ...heldRecovery.failures.map(failure => `Held recovery: ${failure}`)] };
    const evidence = { schemaVersion: 1, kind: 'release-upgrade-lane', sourceRevision: process.env.GITHUB_SHA ?? null, directBaseline: options.directBaseline ?? null, chain, baselineInputs, candidateManifestSha256,
      hops: hops.map(reportHop), candidate: reportHop(candidate), dataRoots, heldRecovery: { ...heldRecovery,
        ...(heldRecovery.held ? { held: reportHop(heldRecovery.held), resumed: reportHop(heldRecovery.resumed) } : {}) }, timings: timings.phases, ...grade };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (options.report) await timings.measure('report-write', async () => { await mkdir(path.dirname(options.report), { recursive: true }); await writeFile(options.report, `${JSON.stringify(evidence, null, 2)}\n`); });
    timings.measureSync('scratch-cleanup', () => finishUpgradeScratch(runRoot, grade.passed ? 'passed' : 'failed'));
    if (options.report) await timings.measure('report-finalize', () => writeFile(options.report, `${JSON.stringify(evidence, null, 2)}\n`));
    return evidence;
  } catch (error) {
    timings.measureSync('scratch-cleanup', () => finishUpgradeScratch(runRoot, 'failed'));
    if (options.report) {
      await mkdir(path.dirname(options.report), { recursive: true });
      await writeFile(options.report, `${JSON.stringify({ schemaVersion: 1, kind: 'release-upgrade-lane', sourceRevision: process.env.GITHUB_SHA ?? null,
        directBaseline: options.directBaseline ?? null, timings: timings.phases, passed: false, failures: ['Release upgrade lane could not complete'], errorCode: /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'qa_release_upgrade_failed' }, null, 2)}\n`);
    }
    throw error;
  } finally {
    if (runRoot.status === 'running') timings.measureSync('scratch-cleanup', () => finishUpgradeScratch(runRoot, 'failed'));
  }
}

export function createBaselineInputs(root) {
  const inputs = new Map();
  return (release, timings) => {
    if (!inputs.has(release)) inputs.set(release, settledInputs([
      timings.measure(`baseline-download:${release}`, () => fetchReleaseArtifacts(release, root)),
      timings.measure(`baseline-install:${release}`, () => prepareReleaseSource(release, root)),
    ]).then(([artifactInput, sourceInput]) => ({ release, ...artifactInput, ...sourceInput })));
    return inputs.get(release);
  };
}

export async function prepareReleaseUpgradeLane(options) {
  const phases = releaseUpgradePhases(options);
  const prepared = await phases.next();
  let consumed = false;
  return {
    evidence: prepared.value,
    async qualify(candidateArtifacts) {
      if (consumed) throw new Error('Prepared profile already consumed');
      consumed = true;
      return (await phases.next(candidateArtifacts)).value;
    },
    async cleanup() { consumed = true; await phases.return(); },
  };
}

export async function runReleaseUpgradeLane(options) {
  const prepared = await prepareReleaseUpgradeLane(options);
  try { return await prepared.qualify(options.candidateArtifacts); }
  finally { await prepared.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('exit', () => console.log(`[qualification] process-exit: ${Math.round(process.uptime() * 1000)}ms total`));
  try {
    const evidence = await runReleaseUpgradeLane(parseReleaseUpgradeArgs(process.argv.slice(2)));
    process.exitCode = evidence.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
