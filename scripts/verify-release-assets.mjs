#!/usr/bin/env node

// Releases ship Apple silicon only; Intel builds were dropped in 1.2.10.
// The public release is an exact allowlist: the installer DMG, plus the web
// tarball for the full scope. ZIP, blockmaps, latest-mac.yml and the Bot
// runtime manifest stay internal workflow artifacts.
export function requiredReleaseAssetNames(version, scope = 'full') {
  if (!['full', 'desktop-macos-arm64'].includes(scope)) throw new Error('Unknown release distribution scope');
  return [
    `DevRyan-${version}-arm64.dmg`,
    ...(scope === 'full' ? [`DevRyan-web-${version}.tgz`] : []),
  ];
}

export function missingRequiredReleaseAssets(assetNames, version, scope = 'full') {
  const available = new Set(assetNames);
  return requiredReleaseAssetNames(version, scope).filter((name) => !available.has(name));
}

export function unexpectedReleaseAssets(assetNames, version, scope = 'full') {
  const allowed = new Set(requiredReleaseAssetNames(version, scope));
  return assetNames.filter((name) => !allowed.has(name));
}

export function legacyBrandedReleaseAssetNames(assetNames) {
  return assetNames.filter((name) => /^openchamber[_-]/i.test(name));
}

export function unsupportedExtensionAssets(assetNames) {
  return assetNames.filter((name) => /\.vsix(?:\.|$)|vscode/i.test(name));
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

async function fetchReleaseAssetNames({ repo, tag, token }) {
  const release = await fetchReleaseByTag({ repo, tag, token });
  const assetNames = [];

  for (let page = 1; ; page += 1) {
    const assets = await fetchJson(
      `https://api.github.com/repos/${repo}/releases/${release.id}/assets?per_page=100&page=${page}`,
      token,
    );
    assetNames.push(...assets.map((asset) => asset.name));
    if (assets.length < 100) break;
  }

  return assetNames;
}

async function main() {
  const version = process.env.VERSION || process.env.OPENCHAMBER_VERSION;
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  if (!version) throw new Error('VERSION or OPENCHAMBER_VERSION is required');
  if (!repo) throw new Error('GH_REPO or GITHUB_REPOSITORY is required');
  if (!token) throw new Error('GITHUB_TOKEN is required');

  const tag = `v${version}`;
  const scope = process.env.RELEASE_SCOPE || 'full';
  const assetNames = await fetchReleaseAssetNames({ repo, tag, token });
  const failures = verifyReleaseAssetNames(assetNames, version, scope);
  if (failures.length > 0) throw new Error(`Release ${tag} assets failed verification:\n${failures.join('\n')}`);

  console.log(`Release ${tag} has exactly the branded ${scope} public assets.`);
}

export function verifyReleaseAssetNames(assetNames, version, scope = 'full') {
  const failures = [];
  const extensions = unsupportedExtensionAssets(assetNames);
  if (extensions.length > 0) failures.push(`unsupported extension assets:\n${extensions.map((name) => `- ${name}`).join('\n')}`);
  const legacyBranded = legacyBrandedReleaseAssetNames(assetNames);
  if (legacyBranded.length > 0) failures.push(`legacy-branded public assets:\n${legacyBranded.map((name) => `- ${name}`).join('\n')}`);
  const missing = missingRequiredReleaseAssets(assetNames, version, scope);
  if (missing.length > 0) failures.push(`missing required assets:\n${missing.map((name) => `- ${name}`).join('\n')}`);
  const duplicates = assetNames.filter((name, index) => assetNames.indexOf(name) !== index);
  if (duplicates.length > 0) failures.push(`duplicate assets:\n${duplicates.map((name) => `- ${name}`).join('\n')}`);
  const unexpected = unexpectedReleaseAssets(assetNames, version, scope)
    .filter((name) => !extensions.includes(name) && !legacyBranded.includes(name));
  if (unexpected.length > 0) failures.push(`unexpected public assets:\n${unexpected.map((name) => `- ${name}`).join('\n')}`);
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
