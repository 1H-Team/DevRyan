// The public release is the exact allowlist in packages/electron/release-assets.mjs
// for the distribution scope. Every listed asset must be uploaded, non-empty and
// carry the SHA-256 of the packaged bytes. scripts/release.mjs applies it to the
// staged DMG and to the draft after upload.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { releaseAssetNames } from '../packages/electron/release-assets.mjs';

const list = (title, names) => `${title}:\n${names.map((name) => `- ${name}`).join('\n')}`;

export const requiredReleaseAssetNames = (version, scope = 'desktop-macos-arm64') => releaseAssetNames(scope, version);

export function legacyBrandedReleaseAssetNames(assetNames) {
  return assetNames.filter((name) => /^openchamber[_-]/i.test(name));
}

export function unsupportedExtensionAssets(assetNames) {
  return assetNames.filter((name) => /\.vsix(?:\.|$)|vscode/i.test(name));
}

// assets: [{ name, size, state, digest: 'sha256:<hex>' | null }] as the GitHub API reports them.
export function verifyReleaseAssets(assets, { version, scope = 'desktop-macos-arm64', digests }) {
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
    const file = path.join(directory, entry.name), handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) throw new Error('Release asset is not a regular single-link file');
      const hash = crypto.createHash('sha256');
      for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
      const after = await handle.stat(), named = await fs.lstat(file);
      if (!named.isFile() || before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('Release asset changed during hashing');
      assets.push({ name: entry.name, size: after.size, state: 'uploaded', digest: `sha256:${hash.digest('hex')}` });
    } finally { await handle.close(); }
  }
  return assets;
}
