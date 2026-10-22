#!/usr/bin/env node
// GitHub Release steps for .github/workflows/release.yml.
//
//   admit             read-only qualification and published-candidate recovery routing (run by preflight)
//   stage             reconcile the draft and upload the DMG; write staged.json (publication lock, drafts only)
//   publish           one PATCH that publishes the unchanged staged draft, record the ledger, verify discovery
//   verify-published  read-only: published bytes, ledger, shipped discovery and the public download
//
// A version is used up only once it is published: a failed attempt re-runs, or the
// tag moves to a fixed commit and locked `stage` reuses the unpublished draft. Published
// bytes are recorded in the devryan-release/vX.Y.Z ledger tag and never replaced.
// RELEASE_DRY_RUN=true makes no GitHub writes (stage checks local files only).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, RELEASE_VERSION_PATTERN, releaseAssetName, releaseAssetDownloadUrl } from '../packages/electron/release-assets.mjs';
import { verifyDownloadedUpdate } from '../packages/electron/desktop-updater.mjs';
import { describeDirectoryAssets, verifyReleaseAssets } from './verify-release-assets.mjs';
import { createRunRoot, scratchParent } from './qa/run-root.mjs';
import { githubClient } from './release-github.mjs';
import { CANONICAL_RELEASE_REPOSITORY } from './release-artifacts.mjs';
import { readReleaseManifest } from './release-candidate.mjs';
import { assertShippedDiscovery, formatReleaseMarker, ledgerTagName, parseReleaseMarker, projectForDiscovery, releaseBody, releaseState } from './release-state.mjs';

export { githubClient };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'desktop-macos-arm64';
const PUBLICATION_LOCK = 'devryan-production-publication';

function requirePublicationLock(environment) {
  if (environment.RELEASE_PUBLICATION_LOCK !== PUBLICATION_LOCK) throw new Error('Release mutations require the workflow production publication lock');
}

export const VERSION_FILES = [
  'package.json',
  'packages/agents-core/package.json',
  'packages/bot-computer/package.json',
  'packages/bot-db/package.json',
  'packages/bot-engine-proxy/package.json',
  'packages/bot-egress/package.json',
  'packages/bot-indexer/package.json',
  'packages/bot-supervisor/package.json',
  'packages/bots-runtime/package.json',
  'packages/cursor-sdk-runtime/package.json',
  'packages/harness-runtime/package.json',
  'packages/orchestration-runtime/package.json',
  'packages/shared-runtime/package.json',
  'packages/ui/package.json',
  'packages/web/package.json',
  'packages/desktop/package.json',
  'packages/electron/package.json',
  'packages/desktop/src-tauri/tauri.conf.json',
];

export async function releaseVersion(repositoryRoot, environment) {
  const frozen = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const ref = environment.GITHUB_REF ?? '';
  const version = ref.startsWith('refs/tags/v') ? ref.slice('refs/tags/v'.length) : frozen;
  if (!RELEASE_VERSION_PATTERN.test(version)) throw new Error(`Release version must be x.y.z, got "${version}" from ${ref || 'package.json'}`);
  if (version !== frozen) throw new Error(`Tag v${version} does not match package.json ${frozen}. Run: node scripts/bump-version.mjs ${version}`);
  return version;
}

export async function versionMismatches(repositoryRoot, version) {
  const mismatches = [];
  for (const file of VERSION_FILES) {
    const found = JSON.parse(await fs.readFile(path.join(repositoryRoot, file), 'utf8')).version;
    if (found !== version) mismatches.push(`${file}: ${found}`);
  }
  const cargoToml = await fs.readFile(path.join(repositoryRoot, 'packages/desktop/src-tauri/Cargo.toml'), 'utf8');
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1];
  if (cargoVersion !== version) mismatches.push(`packages/desktop/src-tauri/Cargo.toml: ${cargoVersion ?? 'missing'}`);
  const cargoLock = await fs.readFile(path.join(repositoryRoot, 'packages/desktop/src-tauri/Cargo.lock'), 'utf8');
  const lockVersion = cargoLock.match(/name = "devryan-desktop"\nversion = "([^"]+)"/)?.[1];
  if (lockVersion !== version) mismatches.push(`packages/desktop/src-tauri/Cargo.lock: ${lockVersion ?? 'missing'}`);
  return mismatches;
}

/** Workspace versions recorded in bun.lock for the version-file packages; a frozen install needs them to match. */
export async function lockfileVersionMismatches(repositoryRoot, version) {
  const lock = await fs.readFile(path.join(repositoryRoot, 'bun.lock'), 'utf8');
  const recorded = new Map([...lock.matchAll(/^ {4}"(packages\/[^"]+)": \{\n {6}"name": "[^"]+",\n {6}"version": "([^"]+)",/gm)].map(match => [match[1], match[2]]));
  const mismatches = [];
  for (const file of VERSION_FILES.filter(file => /^packages\/[^/]+\/package\.json$/.test(file))) {
    const directory = path.dirname(file);
    if (recorded.get(directory) !== version) mismatches.push(`bun.lock ${directory}: ${recorded.get(directory) ?? 'missing'}`);
  }
  return mismatches;
}

/** `check-versions`: every version file and bun.lock workspace agrees with package.json (no tag needed). */
export async function checkVersions({ repositoryRoot = root, log = console.log } = {}) {
  const version = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const mismatches = [...await versionMismatches(repositoryRoot, version), ...await lockfileVersionMismatches(repositoryRoot, version)];
  if (mismatches.length) throw new Error(`Version ${version} does not match:\n${mismatches.join('\n')}\nRun: node scripts/bump-version.mjs ${version}`);
  log(`Version files and bun.lock workspaces agree on ${version}.`);
}

export function releaseNotes(changelog, version) {
  const start = changelog.indexOf(`## [${version}]`);
  if (start === -1) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  const sectionStart = changelog.indexOf('\n', start);
  const next = changelog.indexOf('\n## ', sectionStart + 1);
  const body = changelog.slice(sectionStart + 1, next === -1 ? undefined : next).trim();
  if (!body) throw new Error(`CHANGELOG.md release notes for ${version} are empty`);
  return body;
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    const delta = Number(left.split('.')[index]) - Number(right.split('.')[index]);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

/** Releases are written only to the canonical repository, with its GITHUB_TOKEN. */
export function releaseTarget(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY || RELEASE_REPOSITORY;
  if (repository !== CANONICAL_RELEASE_REPOSITORY) throw new Error(`Releases are published only from ${CANONICAL_RELEASE_REPOSITORY}`);
  return { repository, token: environment.GITHUB_TOKEN };
}

const targetClient = (environment, target, options) => githubClient({ ...options, token: target.token, repository: target.repository, environment });

// Only the canonical main-push workflow is a release qualification. A PR check,
// another workflow with the same display name, or another commit proves nothing.
export async function requireTrustedCI({ environment = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (environment.GITHUB_REPOSITORY !== RELEASE_REPOSITORY || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA || '')) throw new Error('Trusted CI requires the canonical repository and exact source SHA');
  const client = githubClient({ token: environment.GITHUB_TOKEN, fetchImpl, environment });
  const response = await client.request('GET', `/actions/workflows/ci.yml/runs?head_sha=${environment.GITHUB_SHA}&event=push&branch=main&per_page=100`);
  const runs = (response.workflow_runs || []).filter(run => run.path === '.github/workflows/ci.yml' && run.head_sha === environment.GITHUB_SHA
    && run.head_branch === 'main' && run.event === 'push' && run.repository?.full_name === RELEASE_REPOSITORY).sort((a, b) => b.id - a.id);
  const latest = runs[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error(`Trusted CI for ${environment.GITHUB_SHA} is ${latest ? `${latest.status}/${latest.conclusion ?? 'pending'}` : 'missing'}. Wait for the canonical main CI to pass, then rerun this release.`);
  log(`Trusted CI run ${latest.id} passed for ${environment.GITHUB_SHA}.`);
  return latest;
}

export async function findReleases(client, tag) {
  return (await client.paginate('/releases')).filter((release) => release.tag_name === tag);
}

async function tagCommit(client, tag) {
  const ref = await client.request('GET', `/git/ref/tags/${tag}`, { allowNotFound: true });
  if (!ref) return null;
  if (ref.object.type === 'tag') return (await client.request('GET', `/git/tags/${ref.object.sha}`)).object.sha;
  return ref.object.sha;
}

async function assertTagAtSource(client, tag, source) {
  const commit = await tagCommit(client, tag);
  if (commit !== source) {
    throw new Error(`${tag} now points at ${commit ?? 'nothing'}, not this run's ${source}. The newer tag push publishes instead.`);
  }
}

async function latestVersion(client) {
  const latest = await client.request('GET', '/releases/latest', { allowNotFound: true });
  return latest?.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1] ?? null;
}

/** The published-bytes ledger entry for `version`: an annotated devryan-release/vX.Y.Z tag. */
export async function readLedger(client, version) {
  const name = ledgerTagName(version);
  const ref = await client.request('GET', `/git/ref/tags/${name}`, { allowNotFound: true });
  if (!ref) return null;
  if (ref.object?.type !== 'tag') throw new Error(`${name} is not an annotated ledger tag; inspect it before releasing v${version}`);
  const ledger = parseReleaseMarker((await client.request('GET', `/git/tags/${ref.object.sha}`)).message);
  if (ledger?.version !== version) throw new Error(`${name} does not record v${version}; inspect it before releasing v${version}`);
  return ledger;
}

/** Write-once: an existing entry must name the same bytes. */
async function recordLedger(client, { version, marker, commit, log }) {
  const expected = parseReleaseMarker(marker);
  const same = ledger => ledger.sha256 === expected.sha256 && ledger.size === expected.size;
  const existing = await readLedger(client, version);
  if (existing) {
    if (!same(existing)) throw new Error(`Ledger ${ledgerTagName(version)} records sha256:${existing.sha256}, not the published sha256:${expected.sha256}`);
    return existing;
  }
  const object = await client.request('POST', '/git/tags', { body: { tag: ledgerTagName(version), message: `${marker}\n`, object: commit, type: 'commit' } });
  try {
    await client.request('POST', '/git/refs', { body: { ref: `refs/tags/${ledgerTagName(version)}`, sha: object.sha } });
  } catch (error) {
    // A concurrent or earlier write won; it must name the same bytes.
    if (error.status !== 422) throw error;
    const raced = await readLedger(client, version);
    if (!raced || !same(raced)) throw error;
  }
  log(`[release] ledger ${ledgerTagName(version)}: ${marker}`);
  return expected;
}

async function retainedCandidateRun(client, environment) {
  const runs = (await client.paginate(`/actions/workflows/release.yml/runs?head_sha=${environment.GITHUB_SHA}&event=push`, { key: 'workflow_runs', maxPages: 5 }))
    .filter(run => run.path === '.github/workflows/release.yml' && run.head_sha === environment.GITHUB_SHA
    && run.event === 'push' && run.head_branch === environment.GITHUB_REF?.slice('refs/tags/'.length)
    && run.repository?.full_name === RELEASE_REPOSITORY).sort((a, b) => b.id - a.id);
  for (const run of runs) {
    const artifacts = await client.paginate(`/actions/runs/${run.id}/artifacts`, { key: 'artifacts', maxPages: 5 });
    if (artifacts.some(artifact => artifact.name === 'DevRyan-macos-arm64-release' && artifact.expired === false)) return String(run.id);
  }
  throw new Error('Published release recovery requires its original retained DMG artifact; it is missing or expired. Never rebuild or replace published bytes. Recover the original run artifact before retrying verification.');
}

export async function admit({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const version = await releaseVersion(repositoryRoot, environment);
  const mismatches = await versionMismatches(repositoryRoot, version);
  if (mismatches.length) throw new Error(`Version ${version} does not match:\n${mismatches.join('\n')}\nRun: node scripts/bump-version.mjs ${version}`);
  const notes = releaseNotes(await fs.readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8'), version);
  const tag = `v${version}`;
  const source = environment.GITHUB_SHA;
  if (environment.RELEASE_DRY_RUN === 'true') {
    log(`Dry run: ${tag} at ${source} would be drafted with ${notes.length} characters of notes.`);
    return { version, releaseId: '' };
  }
  const client = githubClient({ token: environment.GITHUB_TOKEN, fetchImpl, repository: releaseTarget(environment).repository, environment });
  // The ledger is write-once and recorded after promotion, so it is read before the releases.
  const ledger = await readLedger(client, version);
  const state = releaseState({ version, releases: await findReleases(client, tag), ledger, source });
  if (state.action === 'refuse') throw new Error(state.message);
  await assertTagAtSource(client, tag, source);
  if (state.action === 'verify-published') {
    const candidateRunId = await retainedCandidateRun(client, environment);
    log(`Published ${tag}: recover the original candidate from run ${candidateRunId} and verify only.`);
    return { version, releaseId: String(state.release.id), published: true, candidateRunId };
  }
  const latest = await latestVersion(client);
  if (latest && compareVersions(latest, version) > 0) throw new Error(`Refusing ${tag}: v${latest} is already latest; release a higher version`);
  log(`Qualified ${tag} at ${source} (${state.action}); draft reconciliation waits for the production publication lock.`);
  return { version, releaseId: '' };
}

async function localInstaller(directory, version) {
  const local = await describeDirectoryAssets(directory);
  const digests = new Map(local.map((asset) => [asset.name, asset.digest?.slice('sha256:'.length)]));
  const failures = verifyReleaseAssets(local, { version, scope: SCOPE, digests });
  if (failures.length) throw new Error(`${directory} is not exactly the public release assets:\n${failures.join('\n')}`);
  return { asset: local[0], digests };
}

async function verifyRemoteInstaller(client, release, version, asset, digests) {
  const remote = await client.paginate(`/releases/${release.id}/assets`);
  const failures = verifyReleaseAssets(remote, { version, scope: SCOPE, digests });
  if (release.tag_name !== `v${version}` || release.prerelease === true || remote[0]?.size !== asset.size || failures.length) {
    throw new Error(`${release.draft ? 'Draft' : 'Published'} release identity does not match the candidate: ${failures.join('; ') || 'tag, size or prerelease mismatch'}`);
  }
  return remote;
}

async function stagedEnvironmentFile(environment, staged) {
  if (environment.RELEASE_STAGED_PATH) await fs.writeFile(environment.RELEASE_STAGED_PATH, `${JSON.stringify(staged, null, 2)}\n`);
  if (environment.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(environment.GITHUB_STEP_SUMMARY, `### Staged ${staged.tag}\n\n\`\`\`json\n${JSON.stringify(staged, null, 2)}\n\`\`\`\n`);
  }
}

/**
 * Inside the publication lock: reconcile the single draft for this version,
 * make its one asset exactly the manifest's DMG, prove every shipped updater
 * would discover it once published, and describe the result in staged.json.
 */
export async function stage({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log, wait, now } = {}) {
  const version = await releaseVersion(repositoryRoot, environment);
  const target = releaseTarget(environment);
  const tag = `v${version}`, source = environment.GITHUB_SHA;
  const directory = path.resolve(environment.RELEASE_ASSET_DIRECTORY ?? '');
  const { asset } = await localInstaller(directory, version);
  if (!environment.RELEASE_MANIFEST_PATH) throw new Error('RELEASE_MANIFEST_PATH is required');
  const manifest = await readReleaseManifest(path.resolve(environment.RELEASE_MANIFEST_PATH), { version, sourceSha: source });
  if (asset.name !== manifest.name || asset.size !== manifest.size || asset.digest !== `sha256:${manifest.sha256}`) throw new Error('The DMG does not match its release manifest');
  if (environment.RELEASE_DRY_RUN === 'true') {
    log(`Dry run: ${asset.name} (${asset.size} bytes, ${asset.digest}) is the only public asset.`);
    return { published: false, releaseId: '' };
  }
  requirePublicationLock(environment);
  const client = targetClient(environment, target, { fetchImpl, log, ...(wait ? { wait } : {}), ...(now ? { now } : {}) });
  await assertTagAtSource(client, tag, source);
  const ledger = await readLedger(client, version);
  const state = releaseState({ version, releases: await findReleases(client, tag), ledger, source, sha256: manifest.sha256 });
  if (state.action === 'refuse') throw new Error(state.message);
  const marker = formatReleaseMarker({ version, sha256: manifest.sha256, size: manifest.size, source, runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT });
  if (state.action === 'verify-published') {
    // Publish then only records a missing ledger entry and verifies; the release is never changed.
    const assets = await client.paginate(`/releases/${state.release.id}/assets`);
    const recorded = parseReleaseMarker(state.release.body);
    const staged = { schema: 1, repository: target.repository, version, tag, source, targetCommitish: source, marker: recorded ? formatReleaseMarker(recorded) : marker,
      releaseId: String(state.release.id), releaseUpdatedAt: state.release.updated_at, assetId: String(assets[0]?.id), assetUpdatedAt: assets[0]?.updated_at,
      name: asset.name, size: asset.size, digest: `sha256:${manifest.sha256}` };
    await stagedEnvironmentFile(environment, staged);
    log(`Published ${tag} already has the identical candidate; verification only.`);
    return { published: true, releaseId: staged.releaseId, staged };
  }
  const latest = await latestVersion(client);
  if (latest && compareVersions(latest, version) > 0) throw new Error(`Refusing to stage ${tag}: v${latest} is already latest; production deployment must not run`);
  await assertTagAtSource(client, tag, source);
  const notes = releaseNotes(await fs.readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8'), version);
  const fields = { tag_name: tag, target_commitish: source, name: `DevRyan ${tag}`, body: releaseBody(notes, marker), draft: true, prerelease: false };
  let release;
  if (state.action === 'create') release = await client.request('POST', '/releases', { body: fields });
  else {
    const current = await client.request('GET', `/releases/${state.release.id}`);
    if (!current.draft) throw new Error('Release became published before draft reconciliation; rerun verification only');
    release = await client.request('PATCH', `/releases/${current.id}`, { body: fields });
  }
  for (const stale of state.stale ?? []) {
    const current = await client.request('GET', `/releases/${stale.id}`);
    if (!current.draft) throw new Error('Refusing to remove a published duplicate release');
    await client.request('DELETE', `/releases/${current.id}`);
  }
  // Only assets that are not exactly this candidate are removed.
  for (const extra of (await client.paginate(`/releases/${release.id}/assets`)).filter(row => row.name !== asset.name)) {
    await client.request('DELETE', `/releases/assets/${extra.id}`);
  }
  const upload = await client.uploadAsset(release.id, { name: asset.name, file: path.join(directory, asset.name), size: asset.size, sha256: manifest.sha256 });
  const assets = await client.paginate(`/releases/${release.id}/assets`);
  const failures = verifyReleaseAssets(assets, { version, scope: SCOPE, digests: new Map([[asset.name, manifest.sha256]]) });
  if (failures.length) throw new Error(`Draft ${tag} assets failed verification after upload:\n${failures.join('\n')}`);
  const draft = await client.request('GET', `/releases/${release.id}`);
  if (!draft.draft || draft.tag_name !== tag || draft.target_commitish !== source) throw new Error(`Draft ${tag} changed while it was staged`);
  const expected = { version, name: asset.name, sha256: manifest.sha256, size: asset.size };
  await assertShippedDiscovery(projectForDiscovery({ ...draft, assets }, { version }), expected);
  const staged = { schema: 1, repository: target.repository, version, tag, source, targetCommitish: source, marker,
    releaseId: String(draft.id), releaseUpdatedAt: draft.updated_at, assetId: String(assets[0].id), assetUpdatedAt: assets[0].updated_at,
    name: asset.name, size: asset.size, digest: `sha256:${manifest.sha256}` };
  await stagedEnvironmentFile(environment, staged);
  log(`${upload.uploaded ? 'Uploaded' : 'Kept'} ${asset.name} (${asset.size} bytes, sha256:${manifest.sha256}) on draft ${tag} in ${target.repository}; every shipped updater discovers it once published.`);
  return { published: false, releaseId: staged.releaseId, staged };
}

/** Download the unauthenticated public URL and use the shipped updater's byte verifier. */
export async function verifyPublicInstaller(update, { fetchImpl = fetch, timeoutMs = 180_000 } = {}) {
  const controller = new AbortController();
  const run = createRunRoot({ parent: scratchParent('release-download'), owner: 'release-public-download', onInterrupt: () => controller.abort() });
  let passed = false;
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref();
  try {
    const response = await fetchImpl(update.url, { signal: controller.signal, headers: { 'Accept-Encoding': 'identity' } });
    if (!response.ok || !response.body) throw new Error(`Public installer download failed (${response.status})`);
    const file = path.join(run.dir, update.name);
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > update.size) { controller.abort(); throw new Error('Public installer exceeds the expected size'); }
        await handle.writeFile(chunk);
      }
    } finally { await handle.close(); }
    await verifyDownloadedUpdate(file, update);
    passed = true;
  } finally { clearTimeout(timer); run.finish(passed ? 'passed' : 'failed'); }
}

/**
 * After promotion: within 60 seconds, /releases/latest must be discovered by
 * every shipped updater with exactly these bytes, and the public download must
 * hash to them. A release superseded by a newer latest only re-verifies its bytes.
 */
async function verifyPublicRelease({ client, target, version, expected, fetchImpl, log, wait, attempts, now, promoted = false }) {
  const tag = `v${version}`;
  const publicUrl = releaseAssetDownloadUrl('macos-arm64', version, target.repository);
  // Just promoted with make_latest after checking that nothing newer is latest.
  const latest = promoted ? null : await latestVersion(client);
  if (latest && compareVersions(latest, version) > 0) {
    await verifyPublicInstaller({ name: expected.name, url: publicUrl, sha256: expected.sha256, size: expected.size }, { fetchImpl });
    log(`Verified identical published ${tag}; superseded by v${latest}. Latest is unchanged.`);
    return;
  }
  const discoveryDeadline = now() + 60_000;
  let lastError = new Error('Updater discovery deadline expired (60 seconds)');
  for (let attempt = 1; attempt <= attempts && now() < discoveryDeadline; attempt++) {
    try {
      const payload = await client.request('GET', '/releases/latest', { attempts: 1, signal: AbortSignal.timeout(Math.max(1, discoveryDeadline - now())) });
      const [{ update }] = await assertShippedDiscovery(payload, expected);
      if (now() >= discoveryDeadline) throw new Error('Updater discovery deadline expired (60 seconds)');
      await verifyPublicInstaller({ ...update, url: publicUrl }, { fetchImpl, timeoutMs: discoveryDeadline - now() });
      if (now() >= discoveryDeadline) throw new Error('Public verification deadline expired (60 seconds)');
      log(`Published ${tag}; the in-app updater discovers ${expected.name} (${expected.size} bytes, sha256:${expected.sha256}); public download bytes verified.`);
      log(`[release] updater-discovery-verified-at=${new Date(now()).toISOString()}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || now() >= discoveryDeadline) break;
      await wait(Math.min(5_000, discoveryDeadline - now()));
    }
  }
  throw new Error(`Published ${tag} but public verification failed within the 60-second discovery deadline: ${lastError.message}. Retry verification with the original candidate; never rebuild or replace published bytes.`, { cause: lastError });
}

/** The staged draft and its single asset must be exactly what staged.json recorded. */
export function stagedDifferences(release, assets, staged) {
  const differences = [];
  const check = (label, actual, wanted) => { if (actual !== wanted) differences.push(`${label}: ${actual ?? 'missing'} (staged ${wanted})`); };
  check('release', String(release.id), staged.releaseId);
  check('tag', release.tag_name, staged.tag);
  check('target', release.target_commitish, staged.targetCommitish);
  check('release updated_at', release.updated_at, staged.releaseUpdatedAt);
  check('prerelease', release.prerelease, false);
  const marker = parseReleaseMarker(release.body);
  check('marker', marker && formatReleaseMarker(marker), staged.marker);
  check('asset count', assets.length, 1);
  const [asset] = assets;
  check('asset', String(asset?.id), staged.assetId);
  check('asset name', asset?.name, staged.name);
  check('asset state', asset?.state, 'uploaded');
  check('asset size', asset?.size, staged.size);
  check('asset digest', asset?.digest, staged.digest);
  check('asset updated_at', asset?.updated_at, staged.assetUpdatedAt);
  return differences;
}

export async function publish({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = Infinity, now = Date.now } = {}) {
  const version = await releaseVersion(repositoryRoot, environment);
  const target = releaseTarget(environment);
  const tag = `v${version}`, source = environment.GITHUB_SHA;
  const staged = JSON.parse(environment.RELEASE_STAGED || 'null');
  if (staged?.schema !== 1 || staged.repository !== target.repository || staged.version !== version || staged.source !== source) {
    throw new Error('RELEASE_STAGED must be the staged.json of this version, source and target repository');
  }
  const { asset } = await localInstaller(path.resolve(environment.RELEASE_ASSET_DIRECTORY ?? ''), version);
  if (asset.digest !== staged.digest || asset.size !== staged.size) throw new Error('The downloaded DMG is not the staged candidate');
  const client = targetClient(environment, target, { fetchImpl, log, wait, now });
  await assertTagAtSource(client, tag, source);
  const release = await client.request('GET', `/releases/${staged.releaseId}`);
  const assets = await client.paginate(`/releases/${staged.releaseId}/assets`);
  const promoted = release.draft;
  if (release.draft) {
    const differences = stagedDifferences(release, assets, staged);
    if (differences.length) throw new Error(`Draft ${tag} changed since it was staged; rerun stage:\n${differences.join('\n')}`);
    const latest = await latestVersion(client);
    if (latest && compareVersions(latest, version) > 0) throw new Error(`Refusing to promote ${tag}: v${latest} is already latest`);
    requirePublicationLock(environment);
    await assertTagAtSource(client, tag, source);
    await client.request('PATCH', `/releases/${staged.releaseId}`, { body: { draft: false, make_latest: 'true' } });
  } else if (release.tag_name !== tag || assets.length !== 1 || assets[0].digest !== staged.digest || assets[0].size !== staged.size) {
    throw new Error(`Published ${tag} does not carry the staged bytes; never replace published bytes`);
  }
  await recordLedger(client, { version, marker: staged.marker, commit: source, log });
  await verifyPublicRelease({ client, target, version, fetchImpl, log, wait, attempts, now, promoted,
    expected: { version, name: releaseAssetName('macos-arm64', version), sha256: staged.digest.slice('sha256:'.length), size: staged.size } });
}

/**
 * Read-only verification of an already published version against its original
 * retained DMG: release state, ledger, asset bytes, shipped discovery and the
 * public download. Never writes, rebuilds or re-records anything.
 */
export async function verifyPublished({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = Infinity, now = Date.now } = {}) {
  const version = await releaseVersion(repositoryRoot, environment);
  const target = releaseTarget(environment);
  const tag = `v${version}`, source = environment.GITHUB_SHA;
  const { asset, digests } = await localInstaller(path.resolve(environment.RELEASE_ASSET_DIRECTORY ?? ''), version);
  const client = targetClient(environment, target, { fetchImpl, log, wait, now });
  await assertTagAtSource(client, tag, source);
  const ledger = await readLedger(client, version);
  const releases = await findReleases(client, tag);
  const state = releaseState({ version, releases, ledger, source, sha256: asset.digest.slice('sha256:'.length) });
  if (state.action === 'refuse') throw new Error(state.message);
  if (state.action !== 'verify-published') throw new Error('Published verification refuses an unpublished release');
  await verifyRemoteInstaller(client, state.release, version, asset, digests);
  if (!ledger) log(`[release] warning: ${ledgerTagName(version)} is missing (published before the ledger, or publish stopped before recording it); rerun the publish job to record it.`);
  await verifyPublicRelease({ client, target, version, fetchImpl, log, wait, attempts, now,
    expected: { version, name: asset.name, sha256: asset.digest.slice('sha256:'.length), size: asset.size } });
}

const operations = { admit, stage, publish, 'trusted-ci': requireTrustedCI, 'verify-published': verifyPublished, 'check-versions': checkVersions };

if (import.meta.url === `file://${process.argv[1]}`) {
  const operation = operations[process.argv[2]];
  if (!operation) {
    console.error('Usage: release.mjs trusted-ci|admit|stage|publish|verify-published|check-versions');
    process.exit(2);
  }
  operation().then(async (result) => {
    if (result && process.env.GITHUB_OUTPUT) {
      const fields = result.version ? `version=${result.version}\nrelease_id=${result.releaseId}\npublished=${result.published === true}\ncandidate_run_id=${result.candidateRunId ?? ''}\n`
        : typeof result.published === 'boolean' ? `published=${result.published}\nrelease_id=${result.releaseId}\nstaged=${JSON.stringify(result.staged ?? null)}\n` : '';
      await fs.appendFile(process.env.GITHUB_OUTPUT, fields);
    }
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
