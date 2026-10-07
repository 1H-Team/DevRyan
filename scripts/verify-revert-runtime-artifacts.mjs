// Compatibility command name; all packaged execution artifacts are native v2.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyNativeRuntimeArtifacts } from '../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const exec = promisify(execFile);
export const SUPPORTED_NATIVE_RUNTIME_TARGETS = Object.freeze(['darwin-arm64']);
// The universal web package retains its platform contract. A host-specific
// artifact cannot satisfy missing platform and signature qualification.
export const REQUIRED_WEB_NATIVE_RUNTIME_TARGETS = Object.freeze([
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
]);
export function assertUniversalNativeReleaseAvailable() {
  const missingTargets = REQUIRED_WEB_NATIVE_RUNTIME_TARGETS.filter(target => !SUPPORTED_NATIVE_RUNTIME_TARGETS.includes(target));
  if (missingTargets.length) throw Object.assign(new Error(`Universal native web release unavailable; verified artifacts required for ${missingTargets.join(', ')}`),
    { code: 'native_web_release_unavailable', missingTargets });
}


async function inventory({ directory = path.join(root, 'packages/web/runtime'), platform = process.platform, arch = process.arch } = {}) {
  const target = `${platform}-${arch}`;
  if (!SUPPORTED_NATIVE_RUNTIME_TARGETS.includes(target) || platform !== process.platform || arch !== process.arch) {
    throw new Error(`Native runtime verification unavailable for ${target} on this host`);
  }
  const location = path.resolve(directory, target), manifestPath = path.join(location, 'native-bundle.json');
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Native bundle manifest unavailable');
  const bytes = await fs.readFile(manifestPath), manifest = JSON.parse(bytes.toString());
  if (manifest.schema !== 1 || manifest.opencodeVersion !== '2.0.24' || manifest.target !== `bun-${target}`
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 256) throw new Error('Native bundle inventory invalid');
  const names = new Set(['native-bundle.json']);
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^DevRyan-[A-Za-z0-9._-]+$/.test(file.path)
      || file.path.startsWith('DevRyan-opencode') || names.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error('Native bundle inventory invalid');
    names.add(file.path);
    const actual = await fs.lstat(path.join(location, file.path));
    if (!actual.isFile() || actual.isSymbolicLink() || actual.size !== file.size || await digest(path.join(location, file.path)) !== file.sha256) throw new Error('Native bundle payload changed');
  }
  if ((await fs.readdir(location)).some(name => !names.has(name))) throw new Error('Unmanifested native runtime artifact');
  const launcherName = `DevRyan-execution-${target}`;
  if (manifest.acceptedLauncher?.path !== launcherName || !names.has(launcherName) || !names.has(launcherName + '.json')) throw new Error('Native bundle launcher invalid');
  return { location, manifestPath, manifest, manifestSha256: createHash('sha256').update(bytes).digest('hex'), launcher: path.join(location, launcherName) };
}

export async function verifyRevertRuntimeArtifacts(options) {
  const verified = await inventory(options);
  const native = await verifyNativeRuntimeArtifacts({ manifestPath: verified.manifestPath, manifestSha256: verified.manifestSha256, launcher: verified.launcher });
  return { ...verified, native };
}

export async function verifySupportedRevertRuntimeArtifacts({ directory } = {}) {
  for (const target of SUPPORTED_NATIVE_RUNTIME_TARGETS) {
    const [platform, arch] = target.split('-');
    await verifyRevertRuntimeArtifacts({ directory, platform, arch });
  }
}

// Downloaded archives may lose modes. Check every immutable payload before
// restoring only manifest-owned modes, then perform full signature verification.
export async function restoreRevertRuntimeExecutableModes(options) {
  const verified = await inventory(options);
  for (const file of verified.manifest.files) await fs.chmod(path.join(verified.location, file.path), file.mode);
  return verifyRevertRuntimeArtifacts(options);
}

// Receives the exact pre-signing verification result. The caller signs this
// owned payload before refreshing signatures and resealing the enclosing app.
export async function refreshSignedRevertDigests({ location, manifest, manifestPath, launcher }) {
  if (process.platform !== 'darwin') throw new Error('Native signature refresh requires macOS');
  const launcherPolicyPath = launcher + '.json';
  const policy = JSON.parse(await fs.readFile(launcherPolicyPath, 'utf8'));
  policy.sha256 = await digest(launcher);
  if (policy.spawnLibrary) policy.spawnSha256 = await digest(path.join(location, policy.spawnLibrary));
  await fs.writeFile(launcherPolicyPath, JSON.stringify(policy, null, 2) + '\n');
  for (const file of manifest.files) {
    const target = path.join(location, file.path);
    if (file.mode & 0o111) {
      await exec('/usr/bin/codesign', ['--verify', '--strict', target]);
      const { stderr } = await exec('/usr/bin/codesign', ['-d', '--verbose=4', target]);
      const cdhash = /^CDHash=(.+)$/m.exec(stderr)?.[1], teamID = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1];
      if (!/^[a-f0-9]{40,64}$/.test(cdhash ?? '')) throw new Error('Native signed artifact identity unavailable');
      file.signing = { mode: teamID && teamID !== 'not set' ? 'release' : 'adhoc', verified: true, cdhash,
        ...(teamID && teamID !== 'not set' ? { teamID } : {}) };
    }
    file.sha256 = await digest(target); file.size = (await fs.stat(target)).size;
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await verifyRevertRuntimeArtifacts({ directory: path.dirname(location) });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await verifyRevertRuntimeArtifacts();
  console.log('Native v2 runtime artifacts verified');
}
