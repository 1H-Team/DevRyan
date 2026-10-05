// electron-updater is consulted only when the release publishes its channel file;
// otherwise it would log a missing latest-mac.yml as an updater error.
export const releaseListsUpdaterChannel = (payload) =>
  Array.isArray(payload?.assets) && payload.assets.some((asset) => asset?.name === 'latest-mac.yml');

// Releases without electron-updater metadata ship only the arm64 DMG; the
// Update action then opens that installer in the browser, or else this
// version's tag page. Only those exact repository URLs are accepted.
export const resolveUpdateDownloadFallback = ({ payload, version, repositoryUrl }) => {
  if (!payload || typeof payload !== 'object' || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const assetName = `DevRyan-${version}-arm64.dmg`;
  const expected = `${repositoryUrl}/releases/download/v${version}/${assetName}`;
  const assets = Array.isArray(payload.assets) ? payload.assets.filter((asset) => asset?.name === assetName) : [];
  if (assets.length === 1 && assets[0].browser_download_url === expected) return { url: expected, kind: 'installer' };
  const releasePage = `${repositoryUrl}/releases/tag/v${version}`;
  return payload.html_url === releasePage ? { url: releasePage, kind: 'release-page' } : null;
};
