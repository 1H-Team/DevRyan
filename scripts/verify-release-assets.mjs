#!/usr/bin/env node

const appArchs = ['arm64', 'x64'];

export function requiredReleaseAssetNames(version) {
  const appAssets = appArchs.flatMap((arch) => [
    `DevRyan-${version}-${arch}.dmg`,
    `DevRyan-${version}-${arch}.dmg.blockmap`,
    `DevRyan-${version}-${arch}.zip`,
    `DevRyan-${version}-${arch}.zip.blockmap`,
  ]);

  return [
    ...appAssets,
    'latest-mac.yml',
    `DevRyan-web-${version}.tgz`,
    `DevRyan-bot-runtime-images-${version}.json`,
  ];
}

export function missingRequiredReleaseAssets(assetNames, version) {
  const available = new Set(assetNames);
  return requiredReleaseAssetNames(version).filter((name) => !available.has(name));
}

export function legacyBrandedReleaseAssetNames(assetNames) {
  return assetNames.filter((name) => /^openchamber[_-]/i.test(name));
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) for ${url}: ${body}`);
  }

  return response.json();
}

async function fetchReleaseAssetNames({ repo, tag, token }) {
  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, token);
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
  const assetNames = await fetchReleaseAssetNames({ repo, tag, token });
  const missing = missingRequiredReleaseAssets(assetNames, version);

  if (missing.length > 0) {
    throw new Error(`Release ${tag} is missing required assets:\n${missing.map((name) => `- ${name}`).join('\n')}`);
  }

  const legacyBranded = legacyBrandedReleaseAssetNames(assetNames);
  if (legacyBranded.length > 0) {
    throw new Error(`Release ${tag} contains legacy-branded public assets:\n${legacyBranded.map((name) => `- ${name}`).join('\n')}`);
  }

  console.log(`Release ${tag} has all required branded app and Bot runtime assets.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
