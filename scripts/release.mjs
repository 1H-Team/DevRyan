#!/usr/bin/env node
// GitHub Release steps for .github/workflows/release.yml.
//
//   admit    check version metadata and notes, then create or reuse the draft for vX.Y.Z
//   upload   check the packaged DMG against the asset allowlist and attach it to the draft
//   publish  publish the draft and confirm the shipped updater discovers the new DMG
//
// A version is used up only once it is published: a failed attempt re-runs, or the
// tag moves to a fixed commit and `admit` reuses the unpublished draft.
// RELEASE_DRY_RUN=true makes no GitHub writes (admit prints, upload checks local files).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, RELEASE_VERSION_PATTERN, releaseAssetName } from '../packages/electron/release-assets.mjs';
import { discoverDesktopUpdate } from '../packages/electron/desktop-updater.mjs';
import { describeDirectoryAssets, verifyReleaseAssets } from './verify-release-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'desktop-macos-arm64';

export const VERSION_FILES = [
  'package.json',
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
  const lockVersion = cargoLock.match(/name = "openchamber-desktop"\nversion = "([^"]+)"/)?.[1];
  if (lockVersion !== version) mismatches.push(`packages/desktop/src-tauri/Cargo.lock: ${lockVersion ?? 'missing'}`);
  return mismatches;
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
  const request = async (method, url, { body, contentType, allowNotFound = false } = {}) => {
    const target = url.startsWith('https://') ? url : `https://api.github.com/repos/${repository}${url}`;
    const response = await fetchImpl(target, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': contentType ?? 'application/json' } : {}) },
      body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${target} failed (${response.status}): ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };
  return { repository, request };
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
  if (published) throw new Error(`${tag} is already published (${published.html_url}). Bump the version: node scripts/bump-version.mjs <next>`);
  const [draft, ...extra] = matching;
  for (const stale of extra) await client.request('DELETE', `/releases/${stale.id}`);
  const fields = { tag_name: tag, target_commitish: source, name: `DevRyan ${tag}`, body: `${notes}\n`, draft: true, prerelease: false };
  if (!draft) {
    const created = await client.request('POST', '/releases', { body: fields });
    log(`Created draft ${tag} (${created.id}) at ${source}.`);
    return { version, releaseId: String(created.id) };
  }
  await client.request('PATCH', `/releases/${draft.id}`, { body: fields });
  for (const asset of await releaseAssets(client, draft.id)) await client.request('DELETE', `/releases/assets/${asset.id}`);
  log(`Reused draft ${tag} (${draft.id}) at ${source}; removed its earlier assets.`);
  return { version, releaseId: String(draft.id) };
}

async function localInstaller(directory, version) {
  const local = await describeDirectoryAssets(directory);
  const digests = new Map(local.map((asset) => [asset.name, asset.digest?.slice('sha256:'.length)]));
  const failures = verifyReleaseAssets(local, { version, scope: SCOPE, digests });
  if (failures.length) throw new Error(`${directory} is not exactly the public release assets:\n${failures.join('\n')}`);
  return { asset: local[0], digests };
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
  const releaseId = environment.RELEASE_ID;
  const release = await client.request('GET', `/releases/${releaseId}`);
  if (!release.draft) throw new Error(`${tag} (${releaseId}) is already published`);
  for (const existing of await releaseAssets(client, releaseId)) await client.request('DELETE', `/releases/assets/${existing.id}`);
  const bytes = await fs.readFile(path.join(directory, asset.name));
  await client.request('POST', `https://uploads.github.com/repos/${client.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
    { body: bytes, contentType: 'application/octet-stream' });
  const failures = verifyReleaseAssets(await releaseAssets(client, releaseId), { version, scope: SCOPE, digests });
  if (failures.length) throw new Error(`Draft ${tag} assets failed verification after upload:\n${failures.join('\n')}`);
  log(`Uploaded ${asset.name} (${asset.size} bytes, ${asset.digest}) to draft ${tag}.`);
}

export async function publish({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 6 } = {}) {
  const version = await releaseVersion(repositoryRoot, environment);
  const directory = path.resolve(environment.RELEASE_ASSET_DIRECTORY ?? '');
  const { asset } = await localInstaller(directory, version);
  const client = githubClient({ token: environment.GITHUB_TOKEN, fetchImpl, repository: environment.GITHUB_REPOSITORY || RELEASE_REPOSITORY });
  const tag = `v${version}`;
  await assertTagAtSource(client, tag, environment.GITHUB_SHA);
  const releaseId = environment.RELEASE_ID;
  const release = await client.request('GET', `/releases/${releaseId}`);
  if (release.draft) await client.request('PATCH', `/releases/${releaseId}`, { body: { draft: false, make_latest: 'true' } });
  const expected = { version, name: releaseAssetName('macos-arm64', version), sha256: asset.digest.slice('sha256:'.length), size: asset.size };
  for (let attempt = 1; ; attempt++) {
    try {
      const latest = await client.request('GET', '/releases/latest');
      const update = discoverDesktopUpdate(latest, { currentVersion: '0.0.0', platform: 'darwin', arch: 'arm64' });
      const found = { version: update?.version, name: update?.name, sha256: update?.sha256, size: update?.size };
      if (JSON.stringify(found) !== JSON.stringify(expected)) {
        throw new Error(`Updater discovery found ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`);
      }
      log(`Published ${tag}; the in-app updater discovers ${expected.name} (${expected.size} bytes, sha256:${expected.sha256}).`);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await wait(5_000);
    }
  }
}

const operations = { admit, upload, publish };

if (import.meta.url === `file://${process.argv[1]}`) {
  const operation = operations[process.argv[2]];
  if (!operation) {
    console.error('Usage: release.mjs admit|upload|publish');
    process.exit(2);
  }
  operation().then(async (result) => {
    if (result && process.env.GITHUB_OUTPUT) {
      await fs.appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\nrelease_id=${result.releaseId}\n`);
    }
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
