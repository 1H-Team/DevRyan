// Public GitHub Release asset contract shared by the release verifier and the
// in-app updater. One row per installable platform; a scope lists the rows a
// release must carry exactly (nothing else is published).
export const RELEASE_REPOSITORY = '1H-Team/DevRyan';
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const ASSETS = Object.freeze({
  'macos-arm64': (version) => `DevRyan-${version}-arm64.dmg`,
  'win-x64': (version) => `DevRyan-${version}-win-x64.exe`,
  'win-arm64': (version) => `DevRyan-${version}-win-arm64.exe`,
  web: (version) => `DevRyan-web-${version}.tgz`,
});

export const RELEASE_SCOPES = Object.freeze({
  'desktop-macos-arm64': Object.freeze(['macos-arm64']),
  desktop: Object.freeze(['macos-arm64', 'win-x64', 'win-arm64']),
  full: Object.freeze(['macos-arm64', 'web']),
});

const assertVersion = (version) => {
  if (typeof version !== 'string' || !RELEASE_VERSION_PATTERN.test(version)) throw new Error('Release version must be x.y.z');
};

export function releaseAssetName(platform, version) {
  assertVersion(version);
  const name = Object.hasOwn(ASSETS, platform) ? ASSETS[platform] : null;
  if (!name) throw new Error('Unknown release asset platform');
  return name(version);
}

export function releaseAssetNames(scope, version) {
  const platforms = Object.hasOwn(RELEASE_SCOPES, scope) ? RELEASE_SCOPES[scope] : null;
  if (!platforms) throw new Error('Unknown release distribution scope');
  return platforms.map((platform) => releaseAssetName(platform, version));
}

export function releaseAssetDownloadUrl(platform, version, repository = RELEASE_REPOSITORY) {
  return `https://github.com/${repository}/releases/download/v${version}/${releaseAssetName(platform, version)}`;
}
