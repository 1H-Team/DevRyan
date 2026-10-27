#!/usr/bin/env node
// GitHub Release steps for .github/workflows/release.yml.
//
//   admit             read-only qualification and published-candidate recovery routing (run by preflight)
//   release           stage, recheck CI, publish: one process inside the publication lock (the `release` job)
//   stage             reconcile the draft and upload the DMG; write staged.json (publication lock, drafts only)
//   publish           one PATCH that publishes the unchanged staged draft and records the ledger
//   verify-published  read-only: published bytes, ledger, shipped discovery and the public download
//
// Success is promotion plus the ledger. Discovery and the public download are
// verified afterwards by scripts/release-verify-public.mjs (`post-publish-verify`),
// whose failure means "published, verification pending", never a failed release.
// A version is used up only once it is published: a failed attempt re-runs, or the
// tag moves to a fixed commit and locked `stage` reuses the unpublished draft. Published
// bytes are recorded in the devryan-release/vX.Y.Z ledger tag and never replaced.
// RELEASE_DRY_RUN=true makes no GitHub writes (stage checks local files only).
// `--simulate` runs stage, publish or release against the in-memory GitHub of
// scripts/release-github-fake.mjs with the real DMG and manifest, writing nothing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, RELEASE_VERSION_PATTERN } from '../packages/electron/release-assets.mjs';
import { describeDirectoryAssets, verifyReleaseAssets } from './verify-release-assets.mjs';
import { createRunRoot, scratchParent } from './qa/run-root.mjs';
import { githubClient } from './release-github.mjs';
import { CANONICAL_RELEASE_REPOSITORY } from './release-artifacts.mjs';
import { readReleaseManifest } from './release-candidate.mjs';
import { assertShippedDiscovery, formatReleaseMarker, installedVersionsBefore, ledgerTagName, manifestIdentityProblems, parseReleaseMarker, projectForDiscovery, releaseBody,
  releasePayloadProblems, releaseState } from './release-state.mjs';
import { readLedger, verifyPublicInstaller, verifyPublicRelease } from './release-verify-public.mjs';

export { githubClient, readLedger, verifyPublicInstaller };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'desktop-macos-arm64';
const PUBLICATION_LOCK = 'devryan-production-publication';

function requirePublicationLock(environment) {
  if (environment.RELEASE_PUBLICATION_LOCK !== PUBLICATION_LOCK) throw new Error('Release mutations require the workflow production publication lock');
}

export const VERSION_FILES = [
  'package.json',
  'packages/agents-core/package.json',
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

/**
 * Stage writes the ledger's annotated tag object before publication. Nothing
 * references it, so it is inert if the version is never published, and a
 * crash that loses the response only leaves another unreferenced object.
 */
async function createLedgerObject(client, { version, marker, commit }) {
  const object = await client.request('POST', '/git/tags', { body: { tag: ledgerTagName(version), message: `${marker}\n`, object: commit, type: 'commit' } });
  if (!/^[a-f0-9]{40}$/.test(object?.sha ?? '')) throw new Error(`GitHub did not return the ${ledgerTagName(version)} tag object`);
  return object.sha;
}

/** The staged object must be exactly this ledger entry before a ref makes it the ledger. */
async function checkLedgerObject(client, { version, marker, commit, object }) {
  const staged = /^[a-f0-9]{40}$/.test(object ?? '') ? await client.request('GET', `/git/tags/${object}`, { allowNotFound: true }) : null;
  const recorded = parseReleaseMarker(staged?.message);
  if (staged?.tag !== ledgerTagName(version) || !recorded || formatReleaseMarker(recorded) !== marker || staged.object?.sha !== commit) {
    throw new Error(`The staged ledger tag object ${object ?? '(none)'} is not ${ledgerTagName(version)} for this marker and source; rerun the release job, whose stage writes it again`);
  }
}

/** Write-once: an existing entry must name the same bytes. After promotion only the ref is written. */
async function recordLedger(client, { version, marker, commit, object, log }) {
  const expected = parseReleaseMarker(marker);
  const same = ledger => ledger.sha256 === expected.sha256 && ledger.size === expected.size;
  const existing = await readLedger(client, version);
  if (existing) {
    if (!same(existing)) throw new Error(`Ledger ${ledgerTagName(version)} records sha256:${existing.sha256}, not the published sha256:${expected.sha256}`);
    return existing;
  }
  await checkLedgerObject(client, { version, marker, commit, object });
  try {
    await client.request('POST', '/git/refs', { body: { ref: `refs/tags/${ledgerTagName(version)}`, sha: object } });
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

/**
 * `tagPushed: false` is `release:tag` before the push: the tag must not exist
 * yet, or may already name this source (`tagged: true`); moving it to this
 * source is allowed only with `move` while the version is unpublished.
 */
export async function admit({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log, tagPushed = true, move = false } = {}) {
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
  if (!tagPushed) {
    if (state.action === 'verify-published') throw new Error(`${tag} is already published; a published version is final, so bump the patch version`);
    const commit = await tagCommit(client, tag);
    if (commit && commit !== source && !move) throw new Error(`${tag} already points at ${commit}. Move it to ${source} only for a code fix of the unpublished version: bun run release:tag -- --move`);
    const latest = await latestVersion(client);
    if (latest && compareVersions(latest, version) >= 0) throw new Error(`Refusing ${tag}: v${latest} is already latest; release a higher version`);
    log(`Qualified ${tag} at ${source} before tagging (${state.action}).`);
    return { version, releaseId: '', tagged: commit === source, movedFrom: commit && commit !== source ? commit : null };
  }
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
  const identityProblems = await manifestIdentityProblems(manifest);
  if (identityProblems.length) throw new Error(identityProblems.join('\n'));
  const notes = releaseNotes(await fs.readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8'), version);
  const budget = releasePayloadProblems({ body: releaseBody(notes, formatReleaseMarker({ version, sha256: manifest.sha256, size: manifest.size, source, runId: '0', runAttempt: '0' })) });
  if (budget.length) throw new Error(budget.join('\n'));
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
    const publishedMarker = recorded ? formatReleaseMarker(recorded) : marker;
    const staged = { schema: 1, repository: target.repository, version, tag, source, targetCommitish: source, marker: publishedMarker,
      releaseId: String(state.release.id), releaseUpdatedAt: state.release.updated_at, assetId: String(assets[0]?.id), assetUpdatedAt: assets[0]?.updated_at,
      name: asset.name, size: asset.size, digest: `sha256:${manifest.sha256}`,
      ledgerObject: ledger ? null : await createLedgerObject(client, { version, marker: publishedMarker, commit: source }) };
    await stagedEnvironmentFile(environment, staged);
    log(`Published ${tag} already has the identical candidate; verification only.`);
    return { published: true, releaseId: staged.releaseId, staged };
  }
  const latest = await latestVersion(client);
  if (latest && compareVersions(latest, version) > 0) throw new Error(`Refusing to stage ${tag}: v${latest} is already latest; production deployment must not run`);
  await assertTagAtSource(client, tag, source);
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
  const projected = projectForDiscovery({ ...draft, assets }, { version });
  const payloadProblems = releasePayloadProblems({ body: projected.body, payload: projected });
  if (payloadProblems.length) throw new Error(`Draft ${tag} would not be discoverable:\n${payloadProblems.join('\n')}`);
  await assertShippedDiscovery(projected, expected, { installedVersions: installedVersionsBefore(await client.paginate('/releases'), version) });
  // The ledger's tag object is written now, unreferenced, so publishing is one PATCH and then one ref.
  const staged = { schema: 1, repository: target.repository, version, tag, source, targetCommitish: source, marker,
    releaseId: String(draft.id), releaseUpdatedAt: draft.updated_at, assetId: String(assets[0].id), assetUpdatedAt: assets[0].updated_at,
    name: asset.name, size: asset.size, digest: `sha256:${manifest.sha256}`, ledgerObject: await createLedgerObject(client, { version, marker, commit: source }) };
  await stagedEnvironmentFile(environment, staged);
  log(`${upload.uploaded ? 'Uploaded' : 'Kept'} ${asset.name} (${asset.size} bytes, sha256:${manifest.sha256}) on draft ${tag} in ${target.repository}; every shipped updater discovers it once published.`);
  return { published: false, releaseId: staged.releaseId, staged };
}

/**
 * The hard draft check. Drafts are visible only to a writer's token, so it runs
 * here in the `release` job; the read-only post-publish verifier cannot see them.
 */
export async function assertNoDrafts(client, tag) {
  const drafts = (await findReleases(client, tag)).filter(row => row.draft !== false);
  if (drafts.length) throw new Error(`${tag} is published, but ${drafts.length} draft(s) of it remain (${drafts.map(row => row.id).join(', ')}); rerun the release job, which removes them`);
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

/**
 * Inside the publication lock: one PATCH promotes the unchanged staged draft,
 * then the ledger is recorded and any other draft of the version is removed.
 * That is the success point; discovery and the public download are verified
 * afterwards by the read-only post-publish-verify job.
 */
export async function publish({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, staged: stagedState } = {}) {
  const version = await releaseVersion(repositoryRoot, environment);
  const target = releaseTarget(environment);
  const tag = `v${version}`, source = environment.GITHUB_SHA;
  const staged = stagedState ?? JSON.parse(environment.RELEASE_STAGED || 'null');
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
    // Before anything is public: the ref written after promotion must have its object.
    if (!await readLedger(client, version)) await checkLedgerObject(client, { version, marker: staged.marker, commit: source, object: staged.ledgerObject });
    await assertTagAtSource(client, tag, source);
    await client.request('PATCH', `/releases/${staged.releaseId}`, { body: { draft: false, make_latest: 'true' } });
  } else if (release.tag_name !== tag || assets.length !== 1 || assets[0].digest !== staged.digest || assets[0].size !== staged.size) {
    throw new Error(`Published ${tag} does not carry the staged bytes; never replace published bytes`);
  }
  await recordLedger(client, { version, marker: staged.marker, commit: source, object: staged.ledgerObject, log });
  // Stage removed stale drafts; one created since (by hand or a raced run) must not linger beside the published version.
  for (const draft of (await findReleases(client, tag)).filter(row => row.draft === true)) {
    const current = await client.request('GET', `/releases/${draft.id}`, { allowNotFound: true });
    if (current?.draft !== true) continue;
    await client.request('DELETE', `/releases/${current.id}`);
    log(`[release] removed stale draft ${current.id} of ${tag}`);
  }
  await assertNoDrafts(client, tag);
  log(`${promoted ? 'Published' : 'Already published'} ${tag} with ${staged.name} (${staged.size} bytes, ${staged.digest}); ledger ${ledgerTagName(version)} recorded. post-publish-verify confirms discovery and the public download.`);
  log(`[release] promoted-at=${new Date(now()).toISOString()}`);
  return { published: true, releaseId: staged.releaseId, staged };
}

/**
 * The `release` job: stage, recheck exact-source CI, then publish, in one
 * process holding the publication lock, with the staged state in memory.
 * staged.json is still written (RELEASE_STAGED_PATH) for audit and resume:
 * a rerun stages again (reusing the identical draft) and publishes.
 */
export async function release({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, trustedCI = requireTrustedCI } = {}) {
  const staged = await stage({ repositoryRoot, environment, fetchImpl, log, wait, now });
  if (environment.RELEASE_DRY_RUN === 'true') return staged;
  await trustedCI({ environment, fetchImpl, log });
  return publish({ repositoryRoot, environment, fetchImpl, log, wait, now, staged: staged.staged });
}

/**
 * Read-only verification of an already published version against its original
 * retained DMG: release state, ledger, asset bytes, shipped discovery and the
 * public download. Never writes, rebuilds or re-records anything.
 */
export async function verifyPublished({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, verification = {} } = {}) {
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
  if (!ledger) log(`[release] warning: ${ledgerTagName(version)} is missing (published before the ledger, or the release job stopped before recording it); rerun the release job to record it.`);
  return verifyPublicRelease({ client, repository: target.repository, version, fetchImpl, log, wait, now, repositoryRoot, rerun: 'rerun the verify-published job',
    expected: { sha256: asset.digest.slice('sha256:'.length), size: asset.size }, ...verification });
}

/**
 * `stage|publish|release --simulate`: the unchanged release code against the
 * in-memory GitHub of scripts/release-github-fake.mjs, with the real DMG and
 * manifest from RELEASE_ASSET_DIRECTORY and RELEASE_MANIFEST_PATH. `release`
 * also runs the post-publish verifier (discovery and the public download)
 * against the fake. `stage` and `publish` run in separate processes share the
 * fake through RELEASE_SIMULATION_STATE, which `publish` removes. Nothing
 * reaches the network: the fake refuses every other host.
 */
export async function simulate(operation, { repositoryRoot = root, environment = process.env, log = console.log, source: givenSource } = {}) {
  if (!['stage', 'publish', 'release'].includes(operation)) throw new Error('--simulate applies to stage, publish and release');
  const { createFakeGitHub, restoreFakeGitHub } = await import('./release-github-fake.mjs');
  const version = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const source = givenSource ?? environment.GITHUB_SHA ?? (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const statePath = environment.RELEASE_SIMULATION_STATE ? path.resolve(environment.RELEASE_SIMULATION_STATE) : null;
  if (operation !== 'release' && !statePath) throw new Error('stage --simulate and publish --simulate share the simulated GitHub through RELEASE_SIMULATION_STATE');
  const run = createRunRoot({ parent: scratchParent('release-simulate'), owner: 'release-simulate' });
  const blobDirectory = statePath ? `${statePath}.blobs` : path.join(run.dir, 'blobs');
  let passed = false;
  try {
    await fs.mkdir(blobDirectory, { recursive: true, mode: 0o700 });
    const fake = operation === 'publish' ? restoreFakeGitHub(await fs.readFile(statePath, 'utf8'), { blobDirectory })
      : createFakeGitHub({ tags: { [`v${version}`]: source }, blobDirectory, ciRuns: [{ id: 1, path: '.github/workflows/ci.yml', head_sha: source, head_branch: 'main',
        event: 'push', status: 'completed', conclusion: 'success', repository: { full_name: CANONICAL_RELEASE_REPOSITORY } }] });
    const env = { ...environment, GITHUB_REF: `refs/tags/v${version}`, GITHUB_SHA: source, GITHUB_REPOSITORY: CANONICAL_RELEASE_REPOSITORY, GITHUB_TOKEN: 'simulated-token',
      RELEASE_DRY_RUN: 'false', RELEASE_PUBLICATION_LOCK: PUBLICATION_LOCK, GITHUB_RUN_ID: environment.GITHUB_RUN_ID || '0', GITHUB_RUN_ATTEMPT: environment.GITHUB_RUN_ATTEMPT || '1',
      RELEASE_STAGED_PATH: undefined, GITHUB_STEP_SUMMARY: undefined, GITHUB_OUTPUT: undefined };
    const options = { repositoryRoot, environment: env, fetchImpl: fake.fetchImpl, log: line => log(`[simulate] ${line}`) };
    let result;
    if (operation === 'stage') {
      result = await stage(options);
      fake.state.simulatedStaged = result.staged;
      await fs.writeFile(statePath, fake.serialize(), { mode: 0o600 });
    } else {
      result = operation === 'release' ? await release(options)
        : await publish({ ...options, staged: environment.RELEASE_STAGED ? JSON.parse(environment.RELEASE_STAGED) : fake.state.simulatedStaged });
      const anonymous = githubClient({ anonymous: true, fetchImpl: fake.fetchImpl, environment: { RELEASE_DRY_RUN: 'true' } });
      await verifyPublicRelease({ version, client: anonymous, fetchImpl: fake.fetchImpl, repositoryRoot, log: options.log, pollMs: 1_000, rerun: 'rerun the simulation' });
      const problems = [...fake.state.violations];
      if (fake.publicReleases().length !== 1) problems.push(`${fake.publicReleases().length} published releases`);
      if (fake.state.releases.some(row => row.draft)) problems.push('a draft remains');
      if (fake.ledgerRefs().length !== 1) problems.push(`${fake.ledgerRefs().length} ledger tags`);
      if (problems.length) throw new Error(`Simulated release left an invalid state: ${problems.join('; ')}`);
    }
    log(`[simulate] ${operation} of v${version} at ${source} passed against the simulated GitHub (${fake.requests.length} requests, no network writes).`);
    passed = true;
    return result;
  } finally {
    if (operation !== 'stage' || !passed) {
      if (statePath) await fs.rm(statePath, { force: true });
      await fs.rm(blobDirectory, { recursive: true, force: true });
    }
    run.finish(passed ? 'passed' : 'failed');
  }
}

const operations = { admit, release, stage, publish, 'trusted-ci': requireTrustedCI, 'verify-published': verifyPublished, 'check-versions': checkVersions };
const OUTPUT_OPERATIONS = new Set(['admit', 'release', 'stage', 'publish']);

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, ...flags] = process.argv.slice(2);
  const simulated = flags.length === 1 && flags[0] === '--simulate';
  const operation = operations[name];
  if (!operation || (flags.length && !simulated) || (simulated && !['stage', 'publish', 'release'].includes(name))) {
    console.error('Usage: release.mjs trusted-ci|admit|release|stage|publish|verify-published|check-versions, or release|stage|publish --simulate');
    process.exit(2);
  }
  (simulated ? simulate(name) : operation()).then(async (result) => {
    if (result && process.env.GITHUB_OUTPUT && !simulated && OUTPUT_OPERATIONS.has(name)) {
      const fields = result.version ? `version=${result.version}\nrelease_id=${result.releaseId}\npublished=${result.published === true}\ncandidate_run_id=${result.candidateRunId ?? ''}\n`
        : typeof result.published === 'boolean' ? `published=${result.published}\nrelease_id=${result.releaseId}\nstaged=${JSON.stringify(result.staged ?? null)}\n` : '';
      await fs.appendFile(process.env.GITHUB_OUTPUT, fields);
    }
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
