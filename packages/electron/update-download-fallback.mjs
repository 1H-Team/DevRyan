// Releases without electron-updater metadata ship only the arm64 DMG; the
// Update action then opens that installer in the browser. Only URLs on this
// repository's GitHub release pages are accepted from the API payload.
export const resolveUpdateDownloadFallbackUrl = ({ payload, version, repositoryUrl }) => {
  if (!payload || typeof payload !== 'object' || typeof version !== 'string' || !version) return null;
  const assetName = `DevRyan-${version}-arm64.dmg`;
  const expected = `${repositoryUrl}/releases/download/v${version}/${assetName}`;
  const assets = Array.isArray(payload.assets) ? payload.assets.filter((asset) => asset?.name === assetName) : [];
  if (assets.length === 1 && assets[0].browser_download_url === expected) return expected;
  const htmlUrl = payload.html_url;
  if (typeof htmlUrl !== 'string' || !htmlUrl.startsWith(`${repositoryUrl}/releases/`)) return null;
  try {
    const parsed = new URL(htmlUrl);
    return parsed.href === htmlUrl && `${parsed.origin}${parsed.pathname}` === htmlUrl ? htmlUrl : null;
  } catch {
    return null;
  }
};
