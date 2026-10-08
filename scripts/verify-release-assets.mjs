#!/usr/bin/env node

// The public release is the exact allowlist in packages/electron/release-assets.mjs
// for the distribution scope. Every listed asset must be uploaded, non-empty and
// carry the SHA-256 its packaging job recorded (RELEASE_SHA256_<PLATFORM>).
// `--directory <dir>` checks staged files instead of the draft (dry runs).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RELEASE_SCOPES, releaseAssetName, releaseAssetNames } from '../packages/electron/release-assets.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const list = (title, names) => `${title}:\n${names.map((name) => `- ${name}`).join('\n')}`;

export const requiredReleaseAssetNames = (version, scope = 'full') => releaseAssetNames(scope, version);

export function legacyBrandedReleaseAssetNames(assetNames) {
  return assetNames.filter((name) => /^openchamber[_-]/i.test(name));
}

export function unsupportedExtensionAssets(assetNames) {
  return assetNames.filter((name) => /\.vsix(?:\.|$)|vscode/i.test(name));
}

export const releaseDigestVariable = (platform) => `RELEASE_SHA256_${platform.toUpperCase().replaceAll('-', '_')}`;

// Asset name -> lowercase SHA-256 hex for every platform in the scope.
export function expectedReleaseDigests(scope, version, environment = process.env) {
  const platforms = Object.hasOwn(RELEASE_SCOPES, scope) ? RELEASE_SCOPES[scope] : null;
  if (!platforms) throw new Error('Unknown release distribution scope');
  return new Map(platforms.map((platform) => {
    const variable = releaseDigestVariable(platform);
    const digest = environment[variable];
    if (!SHA256_PATTERN.test(digest || '')) throw new Error(`${variable} must be the packaging job's SHA-256`);
    return [releaseAssetName(platform, version), digest];
  }));
}

// assets: [{ name, size, state, digest: 'sha256:<hex>' | null }] as the GitHub API reports them.
export function verifyReleaseAssets(assets, { version, scope = 'full', digests }) {
  const names = assets.map((asset) => asset.name);
  const required = requiredReleaseAssetNames(version, scope);
  const failures = [];
  const extensions = unsupportedExtensionAssets(names);
  if (extensions.length > 0) failures.push(list('unsupported extension assets', extensions));
  const legacyBranded = legacyBrandedReleaseAssetNames(names);
  if (legacyBranded.length > 0) failures.push(list('legacy-branded public assets', legacyBranded));
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length > 0) failures.push(list('missing required assets', missing));
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) failures.push(list('duplicate assets', duplicates));
  const unexpected = names.filter((name) => !required.includes(name) && !extensions.includes(name) && !legacyBranded.includes(name));
  if (unexpected.length > 0) failures.push(list('unexpected public assets', unexpected));
  const integrity = [];
  for (const name of required) {
    const asset = assets.find((candidate) => candidate.name === name);
    if (!asset) continue;
    if (asset.state !== 'uploaded') integrity.push(`${name} is not uploaded (${asset.state})`);
    else if (!(Number.isSafeInteger(asset.size) && asset.size > 0)) integrity.push(`${name} is empty`);
    else if (!digests?.get(name) || asset.digest !== `sha256:${digests.get(name)}`) {
      integrity.push(`${name} digest ${asset.digest || 'missing'} does not match the packaged sha256:${digests?.get(name) || 'missing'}`);
    }
  }
  if (integrity.length > 0) failures.push(list('asset integrity failures', integrity));
  return failures;
}

export async function describeDirectoryAssets(directory) {
  const assets = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile()) {
      assets.push({ name: entry.name, size: 0, state: 'not a regular file', digest: null });
      continue;
    }
    const bytes = await fs.readFile(path.join(directory, entry.name));
    assets.push({ name: entry.name, size: bytes.length, state: 'uploaded',
      digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` });
  }
  return assets;
}

async function fetchJson(url, token, { allowNotFound = false, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) for ${url}: ${body}`);
  }

  return response.json();
}

export async function fetchReleaseByTag({ repo, tag, token, fetchImpl = fetch }) {
  const direct = await fetchJson(
    `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
    token,
    { allowNotFound: true, fetchImpl },
  );
  if (direct) return direct;

  for (let page = 1; ; page += 1) {
    const releases = await fetchJson(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      token,
      { fetchImpl },
    );
    const release = releases.find((candidate) => candidate.tag_name === tag);
    if (release) return release;
    if (releases.length < 100) break;
  }

  throw new Error(`GitHub release ${tag} was not found in ${repo}, including drafts`);
}

export async function fetchReleaseAssets({ repo, tag, token, fetchImpl = fetch }) {
  const release = await fetchReleaseByTag({ repo, tag, token, fetchImpl });
  const assets = [];

  for (let page = 1; ; page += 1) {
    const batch = await fetchJson(
      `https://api.github.com/repos/${repo}/releases/${release.id}/assets?per_page=100&page=${page}`,
      token,
      { fetchImpl },
    );
    assets.push(...batch.map(({ name, size, state, digest }) => ({ name, size, state, digest: digest ?? null })));
    if (batch.length < 100) break;
  }

  return assets;
}

export function parseArguments(argv) {
  if (argv.length === 0) return { directory: null };
  if (argv.length === 2 && argv[0] === '--directory' && argv[1]) return { directory: argv[1] };
  throw new Error('Usage: verify-release-assets.mjs [--directory <dir>]');
}

async function main() {
  const { directory } = parseArguments(process.argv.slice(2));
  const version = process.env.VERSION;
  const scope = process.env.RELEASE_SCOPE || 'full';
  if (!version) throw new Error('VERSION is required');
  const digests = expectedReleaseDigests(scope, version);

  let source;
  let assets;
  if (directory) {
    source = directory;
    assets = await describeDirectoryAssets(directory);
  } else {
    const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (!repo) throw new Error('GH_REPO or GITHUB_REPOSITORY is required');
    if (!token) throw new Error('GITHUB_TOKEN is required');
    source = `release v${version}`;
    assets = await fetchReleaseAssets({ repo, tag: `v${version}`, token });
  }

  const failures = verifyReleaseAssets(assets, { version, scope, digests });
  if (failures.length > 0) throw new Error(`${source} assets failed verification:\n${failures.join('\n')}`);
  console.log(`${source} has exactly the ${scope} public assets with their packaged digests.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
