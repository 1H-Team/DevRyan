#!/usr/bin/env node
// GitHub Release steps for .github/workflows/release.yml.
//
//   admit    read-only qualification and published-candidate recovery routing
//   upload   check the packaged DMG against the asset allowlist and attach it to the draft
//   publish  publish the draft and confirm the shipped updater discovers the new DMG
//
// A version is used up only once it is published: a failed attempt re-runs, or the
// tag moves to a fixed commit and locked `upload` reuses the unpublished draft.
// RELEASE_DRY_RUN=true makes no GitHub writes (admit prints, upload checks local files).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, RELEASE_VERSION_PATTERN, releaseAssetName, releaseAssetDownloadUrl } from '../packages/electron/release-assets.mjs';
import { discoverDesktopUpdate, verifyDownloadedUpdate } from '../packages/electron/desktop-updater.mjs';
import { describeDirectoryAssets, verifyReleaseAssets } from './verify-release-assets.mjs';
import { createRunRoot, scratchParent } from './qa/run-root.mjs';

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

export function githubClient({ token, fetchImpl = fetch, repository = RELEASE_REPOSITORY }) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const request = async (method, url, { body, contentType, allowNotFound = false, signal } = {}) => {
    const target = url.startsWith('https://') ? url : `https://api.github.com/repos/${repository}${url}`;
    const response = await fetchImpl(target, {
      method,
      ...(signal ? { signal } : {}),
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': contentType ?? 'application/json' } : {}) },
      body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${target} failed (${response.status}): ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };
  return { repository, request };
}

// Only the canonical main-push workflow is a release qualification. A PR check,
// another workflow with the same display name, or another commit proves nothing.
export async function requireTrustedCI({ environment = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (environment.GITHUB_REPOSITORY !== RELEASE_REPOSITORY || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA || '')) throw new Error('Trusted CI requires the canonical repository and exact source SHA');
  const client = githubClient({ token: environment.GITHUB_TOKEN, fetchImpl });
  const response = await client.request('GET', `/actions/workflows/ci.yml/runs?head_sha=${environment.GITHUB_SHA}&event=push&branch=main&per_page=100`);
  const runs = (response.workflow_runs || []).filter(run => run.path === '.github/workflows/ci.yml' && run.head_sha === environment.GITHUB_SHA
    && run.head_branch === 'main' && run.event === 'push' && run.repository?.full_name === RELEASE_REPOSITORY).sort((a, b) => b.id - a.id);
  const latest = runs[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error(`Trusted CI for ${environment.GITHUB_SHA} is ${latest ? `${latest.status}/${latest.conclusion ?? 'pending'}` : 'missing'}. Wait for the canonical main CI to pass, then rerun this release.`);
  log(`Trusted CI run ${latest.id} passed for ${environment.GITHUB_SHA}.`);
  return latest;
}

async function findReleases(client, tag) {
  const releases = await client.request('GET', '/releases?per_page=100');
  return releases.filter((release) => release.tag_name === tag);
}

async function releaseAssets(client, releaseId) {
  return client.request('GET', `/releases/${releaseId}/assets?per_page=100`);
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

async function retainedCandidateRun(client, environment) {
  const response = await client.request('GET', `/actions/workflows/release.yml/runs?head_sha=${environment.GITHUB_SHA}&event=push&per_page=100`);
  const runs = (response.workflow_runs || []).filter(run => run.path === '.github/workflows/release.yml' && run.head_sha === environment.GITHUB_SHA
    && run.event === 'push' && run.head_branch === environment.GITHUB_REF?.slice('refs/tags/'.length)
    && run.repository?.full_name === RELEASE_REPOSITORY).sort((a, b) => b.id - a.id);
  for (const run of runs) {
    const { artifacts = [] } = await client.request('GET', `/actions/runs/${run.id}/artifacts?per_page=100`);
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
  const client = githubClient({ token: environment.GITHUB_TOKEN, fetchImpl, repository: environment.GITHUB_REPOSITORY || RELEASE_REPOSITORY });
  const matching = await findReleases(client, tag);
  const published = matching.find((release) => !release.draft);
  if (published) {
    await assertTagAtSource(client, tag, source);
    if (published.target_commitish !== source || published.prerelease === true) throw new Error('Published release source identity differs; bump the version for changed source');
    const candidateRunId = await retainedCandidateRun(client, environment);
    log(`Published ${tag}: recover the original candidate from run ${candidateRunId} and verify only.`);
    return { version, releaseId: String(published.id), published: true, candidateRunId };
  }
  await assertTagAtSource(client, tag, source);
  log(`Qualified ${tag} at ${source}; draft reconciliation waits for the production publication lock.`);
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
  const remote = await releaseAssets(client, release.id);
  const failures = verifyReleaseAssets(remote, { version, scope: SCOPE, digests });
  if (release.tag_name !== `v${version}` || release.prerelease === true || remote[0]?.size !== asset.size || failures.length) {
    throw new Error(`${release.draft ? 'Draft' : 'Published'} release identity does not match the candidate: ${failures.join('; ') || 'tag, size or prerelease mismatch'}`);
  }
}

export async function upload({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const version = await releaseVersion(repositoryRoot, environment);
  const directory = path.resolve(environment.RELEASE_ASSET_DIRECTORY ?? '');
  const { asset, digests } = await localInstaller(directory, version);
  if (environment.RELEASE_DRY_RUN === 'true') {
    log(`Dry run: ${asset.name} (${asset.size} bytes, ${asset.digest}) is the only public asset.`);
    return;
  }
  const client = githubClient({ token: environment.GITHUB_TOKEN, fetchImpl, repository: environment.GITHUB_REPOSITORY || RELEASE_REPOSITORY });
  const tag = `v${version}`;
  await assertTagAtSource(client, tag, environment.GITHUB_SHA);
  const matching = await findReleases(client, tag);
  let release = matching.find(candidate => !candidate.draft) ?? matching[0];
  if (environment.RELEASE_VERIFY_PUBLISHED === 'true' && !release) throw new Error('Published verification refuses an unpublished release');
  if (environment.RELEASE_VERIFY_PUBLISHED === 'true' && release.draft) throw new Error('Published verification refuses an unpublished release');
  if (release && !release.draft) {
    if (release.target_commitish !== environment.GITHUB_SHA) throw new Error('Published release identity does not match the source commit');
    await verifyRemoteInstaller(client, release, version, asset, digests);
    log(`Published ${tag} already has the identical candidate; verification only.`);
    return { published: true, releaseId: String(release.id) };
  }
  const latest = await client.request('GET', '/releases/latest', { allowNotFound: true });
  const latestVersion = latest?.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (latestVersion && compareVersions(latestVersion, version) > 0) throw new Error(`Refusing to upload ${tag}: v${latestVersion} is already latest; production deployment must not run`);
  requirePublicationLock(environment);
  await assertTagAtSource(client, tag, environment.GITHUB_SHA);
  const notes = releaseNotes(await fs.readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8'), version);
  const fields = { tag_name: tag, target_commitish: environment.GITHUB_SHA, name: `DevRyan ${tag}`, body: `${notes}\n`, draft: true, prerelease: false };
  // All callers that can mutate a release share the workflow's production lock.
  // Admission never touches drafts, including when it overlaps this promotion.
  if (release) {
    release = await client.request('GET', `/releases/${release.id}`);
    if (!release.draft) throw new Error('Release became published before draft reconciliation; rerun verification only');
    await client.request('PATCH', `/releases/${release.id}`, { body: fields });
  } else release = await client.request('POST', '/releases', { body: fields });
  const releaseId = String(release.id);
  for (const stale of matching.filter(candidate => String(candidate.id) !== releaseId)) {
    const current = await client.request('GET', `/releases/${stale.id}`);
    if (!current.draft) throw new Error('Refusing to remove a published duplicate release');
    await client.request('DELETE', `/releases/${current.id}`);
  }
  for (const existing of await releaseAssets(client, releaseId)) await client.request('DELETE', `/releases/assets/${existing.id}`);
  const bytes = await fs.readFile(path.join(directory, asset.name));
  await client.request('POST', `https://uploads.github.com/repos/${client.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
    { body: bytes, contentType: 'application/octet-stream' });
  const failures = verifyReleaseAssets(await releaseAssets(client, releaseId), { version, scope: SCOPE, digests });
  if (failures.length) throw new Error(`Draft ${tag} assets failed verification after upload:\n${failures.join('\n')}`);
  log(`Uploaded ${asset.name} (${asset.size} bytes, ${asset.digest}) to draft ${tag}.`);
  return { published: false, releaseId };
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

export async function publish({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = Infinity, now = Date.now } = {}) {
  const version = await releaseVersion(repositoryRoot, environment);
  const directory = path.resolve(environment.RELEASE_ASSET_DIRECTORY ?? '');
  const { asset, digests } = await localInstaller(directory, version);
  const client = githubClient({ token: environment.GITHUB_TOKEN, fetchImpl, repository: environment.GITHUB_REPOSITORY || RELEASE_REPOSITORY });
  const tag = `v${version}`;
  await assertTagAtSource(client, tag, environment.GITHUB_SHA);
  const releaseId = environment.RELEASE_ID;
  const release = await client.request('GET', `/releases/${releaseId}`);
  if (environment.RELEASE_VERIFY_PUBLISHED === 'true' && release.draft) throw new Error('Published verification refuses an unpublished release');
  await verifyRemoteInstaller(client, release, version, asset, digests);
  if (release.target_commitish !== environment.GITHUB_SHA) throw new Error('Release identity does not match the source commit');
  const latestBefore = await client.request('GET', '/releases/latest', { allowNotFound: true });
  const latestVersion = latestBefore?.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (latestVersion && compareVersions(latestVersion, version) > 0) {
    if (release.draft) throw new Error(`Refusing to promote ${tag}: v${latestVersion} is already latest`);
    await verifyPublicInstaller({ name: asset.name, url: releaseAssetDownloadUrl('macos-arm64', version), sha256: asset.digest.slice(7), size: asset.size }, { fetchImpl });
    log(`Verified identical published ${tag}; superseded by v${latestVersion}. Latest is unchanged.`);
    return;
  }
  if (release.draft) {
    requirePublicationLock(environment);
    await assertTagAtSource(client, tag, environment.GITHUB_SHA);
    await client.request('PATCH', `/releases/${releaseId}`, { body: { draft: false, make_latest: 'true' } });
  }
  const expected = { version, name: releaseAssetName('macos-arm64', version), sha256: asset.digest.slice('sha256:'.length), size: asset.size };
  const discoveryDeadline = now() + 60_000;
  let lastError = new Error('Updater discovery deadline expired (60 seconds)');
  for (let attempt = 1; attempt <= attempts && now() < discoveryDeadline; attempt++) {
    try {
      const latest = await client.request('GET', '/releases/latest', { signal: AbortSignal.timeout(Math.max(1, discoveryDeadline - now())) });
      const update = discoverDesktopUpdate(latest, { currentVersion: '0.0.0', platform: 'darwin', arch: 'arm64' });
      const found = { version: update?.version, name: update?.name, sha256: update?.sha256, size: update?.size };
      if (JSON.stringify(found) !== JSON.stringify(expected)) {
        throw new Error(`Updater discovery found ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`);
      }
      if (now() >= discoveryDeadline) throw new Error('Updater discovery deadline expired (60 seconds)');
      await verifyPublicInstaller(update, { fetchImpl, timeoutMs: discoveryDeadline - now() });
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

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    const delta = Number(left.split('.')[index]) - Number(right.split('.')[index]);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

export async function verifyPublished(options = {}) {
  const environment = { ...(options.environment ?? process.env), RELEASE_VERIFY_PUBLISHED: 'true' };
  const uploaded = await upload({ ...options, environment });
  await publish({ ...options, environment: { ...environment, RELEASE_ID: uploaded.releaseId } });
}

const operations = { admit, upload, publish, 'trusted-ci': requireTrustedCI, 'verify-published': verifyPublished, 'check-versions': checkVersions };

if (import.meta.url === `file://${process.argv[1]}`) {
  const operation = operations[process.argv[2]];
  if (!operation) {
    console.error('Usage: release.mjs trusted-ci|admit|upload|publish|verify-published|check-versions');
    process.exit(2);
  }
  operation().then(async (result) => {
    if (result && process.env.GITHUB_OUTPUT) {
      const fields = result.version ? `version=${result.version}\nrelease_id=${result.releaseId}\npublished=${result.published === true}\ncandidate_run_id=${result.candidateRunId ?? ''}\n` : typeof result.published === 'boolean' ? `published=${result.published}\nrelease_id=${result.releaseId}\n` : '';
      await fs.appendFile(process.env.GITHUB_OUTPUT, fields);
    }
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
