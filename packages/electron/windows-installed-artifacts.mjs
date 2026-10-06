import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** The same production verifier gates both updater installation and runtime
 * launch. Unaccepted Windows manifests never become accepted via this adapter. */
export async function verifyWindowsInstalledArtifacts({ target, arch, owner, verifyNativeArtifacts }) {
  if (!['x64', 'arm64'].includes(arch) || !owner || typeof verifyNativeArtifacts !== 'function') throw new Error('update_native_verifier_unavailable');
  owner.assertHeld?.();
  const before = await owner.tree(target);
  const directory = path.win32.join(target, 'resources', 'revert-runtime', `win32-${arch}`);
  const manifestPath = path.win32.join(directory, 'native-bundle.json'), launcher = path.win32.join(directory, `DevRyan-execution-win32-${arch}.exe`);
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('update_native_manifest_unverified');
  const bytes = await fs.readFile(manifestPath);
  if (bytes.length !== stat.size) throw new Error('update_native_manifest_changed');
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  const verified = await verifyNativeArtifacts({ manifestPath, manifestSha256, launcher });
  owner.assertHeld?.();
  if (await owner.tree(target) !== before) throw new Error('update_installation_changed');
  return verified;
}
