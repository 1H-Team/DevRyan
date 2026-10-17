// Release upgrade lane: age a private profile through the previous published
// releases' own server code and shipped native runtimes, then cold-start this
// checkout with the candidate runtime and require the production startup
// upgrade, verifier and native readiness to succeed. Headless; no Electron.
// Usage: docs/QA.md "Release upgrade lane".
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createV200PrepareEnvironment } from './first-launch-smoke.mjs';
import { startOwnedProcess } from './process.mjs';
import { createRunRoot, scratchParent } from './run-root.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const execFileAsync = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const USAGE = 'Usage: node scripts/qa/release-upgrade-lane.mjs --candidate-artifacts <abs dir> [--chain v2.0.12,v2.0.15,v2.1.0] [--hop-timeout-ms 240000] [--keep-artifacts]';
const usageError = message => Object.assign(new Error(`${message}\n${USAGE}`), { code: 'qa_release_upgrade_usage' });

export function parseReleaseUpgradeArgs(argv) {
  const options = { chain: null, hopTimeoutMs: 240000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep-artifacts') continue;
    const value = argv[index + 1];
    if (!['--candidate-artifacts', '--chain', '--hop-timeout-ms'].includes(flag)) throw usageError(`Unknown argument: ${flag}`);
    if (value === undefined || value === '' || value.startsWith('--')) throw usageError(`${flag} requires a value`);
    index += 1;
    if (flag === '--candidate-artifacts') {
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
export function gradeReleaseUpgrade({ hops, candidate, candidateManifestSha256 }) {
  const failures = [];
  if (!hops.length || hops[0].result?.provisioned !== true) failures.push('The oldest release did not provision a profile');
  const result = candidate?.result ?? {};
  if (result.error) failures.push(`Candidate startup failed: ${result.error.code ?? 'error'}: ${result.error.message}`);
  if (result.upgradeFailure) failures.push(`Candidate startup upgrade was refused: ${result.upgradeFailure}`);
  if (result.selected?.artifactManifestSha256 !== candidateManifestSha256) failures.push('The candidate runtime is not the selected bundle');
  if (result.ready !== true) failures.push('The candidate native runtime did not become ready');
  const kept = hops.flatMap(hop => hop.result?.kept ?? []), deleted = hops.flatMap(hop => hop.result?.deleted ?? []);
  const listed = new Set(result.sessions ?? []);
  const lost = kept.filter(id => !listed.has(id)), revived = deleted.filter(id => listed.has(id));
  if (lost.length) failures.push(`Sessions lost across the upgrade: ${lost.join(', ')}`);
  if (revived.length) failures.push(`Deleted sessions reappeared: ${revived.join(', ')}`);
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
  const status = await import(request.statusModule);
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
  const deadline = Date.now() + request.readyTimeoutMs;
  while (!server.isReady() && Date.now() < deadline) await delay(500);
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

const run = (command, args, options = {}) => execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024, ...options });

/** The shipped native runtime of a published release, copied with its modes and signatures. */
async function fetchReleaseArtifacts(tag, root) {
  const download = path.join(root, 'downloads', tag), mount = path.join(root, 'mounts', tag), target = path.join(root, 'artifacts', tag);
  await mkdir(download, { recursive: true }); await mkdir(mount, { recursive: true });
  await run('gh', ['release', 'download', tag, '--pattern', 'DevRyan-*-arm64.dmg', '--dir', download], { cwd: repository });
  const { stdout } = await run('/bin/ls', [download]);
  const dmg = stdout.split('\n').find(name => name.endsWith('-arm64.dmg'));
  if (!dmg) throw Object.assign(new Error(`${tag} has no arm64 DMG`), { code: 'qa_release_upgrade_dmg_missing' });
  await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.join(download, dmg)]);
  try {
    await run('/usr/bin/ditto', [path.join(mount, 'DevRyan.app/Contents/Resources/revert-runtime/darwin-arm64'), target]);
  } finally { await run('/usr/bin/hdiutil', ['detach', mount, '-force']); }
  return target;
}

/** The release's own source at its tag, installed without the Electron prepare step. */
async function prepareReleaseSource(tag, root) {
  const target = path.join(root, 'source', tag);
  await mkdir(target, { recursive: true });
  const archive = path.join(root, 'downloads', `${tag}.tar`);
  await run('git', ['archive', '--format=tar', '-o', archive, tag], { cwd: repository });
  await run('/usr/bin/tar', ['-xf', archive, '-C', target]);
  await run('bun', ['install', '--frozen-lockfile'], { cwd: target, env: { ...process.env, DEVRYAN_SKIP_INSTALL_PREPARE: '1' }, timeout: 600000 });
  return target;
}

async function runHop({ release, source, artifacts, layout, activity, timeoutMs }) {
  const resultPath = path.join(layout.root, `hop-${release}.json`);
  const env = { ...createV200PrepareEnvironment({ home: layout.home }), DEVRYAN_EXECUTION_ARTIFACTS: artifacts,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: layout.root };
  const request = { release, workspace: layout.workspace, controlRoot: layout.controlRoot, resultPath, activity, readyTimeoutMs: timeoutMs - 30000,
    serverModule: pathToFileURL(path.join(source, 'packages/web/server/index.js')).href,
    statusModule: pathToFileURL(path.join(source, 'packages/web/server/lib/opencode/runtime-host/bundle-startup-upgrade-status.js')).href };
  const started = performance.now();
  const child = startOwnedProcess(process.execPath, ['--input-type=module', '-e', HOP_CHILD, JSON.stringify(request)], { cwd: layout.workspace, env });
  const exited = await new Promise(resolve => {
    if (child.child.exitCode !== null || child.child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  const cleanupErrors = [];
  try { await child.stop(); } catch (error) { cleanupErrors.push(error.message); }
  let result = null;
  try { result = JSON.parse(await readFile(resultPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { release, exited, elapsedMs: Math.round(performance.now() - started), result, cleanupErrors, log: result?.ready ? undefined : child.getLog().slice(-4000) };
}

export async function runReleaseUpgradeLane(options) {
  const runRoot = createRunRoot({ parent: scratchParent('release-upgrade'), owner: 'release-upgrade-lane' });
  try {
    const root = await realpath(runRoot.dir);
    const chain = options.chain ?? selectPreviousReleases(JSON.parse((await run('gh', ['release', 'list', '--limit', '20',
      '--json', 'tagName,isDraft,isPrerelease,publishedAt'], { cwd: repository })).stdout));
    if (!chain.length) throw Object.assign(new Error('No published release to upgrade from'), { code: 'qa_release_upgrade_no_baseline' });
    const candidateManifestSha256 = digest(await readFile(path.join(options.candidateArtifacts, 'native-bundle.json')));
    const layout = { root, home: path.join(root, 'home'), workspace: path.join(root, 'workspace') };
    layout.controlRoot = path.join(layout.home, '.local/state/devryan/runtime-bundles');
    for (const directory of [layout.home, layout.workspace]) await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(path.join(root, 'git-template'), { mode: 0o700 });
    await run('git', ['init', '--quiet', '--initial-branch=main', `--template=${path.join(root, 'git-template')}`], { cwd: layout.workspace,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root } });
    await writeFile(path.join(layout.workspace, 'README.md'), '# Release upgrade lane\n');
    const prepared = await Promise.all(chain.map(async release => {
      const [artifacts, source] = await Promise.all([fetchReleaseArtifacts(release, root), prepareReleaseSource(release, root)]);
      return { release, artifacts, source };
    }));
    const hops = [];
    for (const { release, source, artifacts } of prepared) {
      hops.push(await runHop({ release, source, artifacts, layout, activity: true, timeoutMs: options.hopTimeoutMs }));
    }
    const candidate = await runHop({ release: 'candidate', source: repository, artifacts: options.candidateArtifacts, layout, activity: false, timeoutMs: options.hopTimeoutMs });
    const grade = gradeReleaseUpgrade({ hops, candidate, candidateManifestSha256 });
    const evidence = { schemaVersion: 1, kind: 'release-upgrade-lane', chain, candidateManifestSha256,
      hops: hops.map(({ log, ...hop }) => hop), candidate, ...grade };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    runRoot.finish(grade.passed ? 'passed' : 'failed');
    return evidence;
  } catch (error) {
    runRoot.finish('failed');
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = await runReleaseUpgradeLane(parseReleaseUpgradeArgs(process.argv.slice(2)));
    process.exitCode = evidence.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
