import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

export async function verifySupportedRevertRuntimeArtifacts({ directory } = {}) {
  const contract = JSON.parse(await fs.readFile(path.join(root, 'packages/web/server/lib/opencode/companion/manifest.json')));
  if (!Array.isArray(contract.supportedArtifacts) || !contract.supportedArtifacts.length) throw new Error('Missing supported execution artifact policy');
  for (const target of contract.supportedArtifacts) {
    const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(target);
    if (!match) throw new Error('Invalid supported execution artifact policy');
    await verifyRevertRuntimeArtifacts({ directory, platform: match[1], arch: match[2] });
  }
}

export async function verifyRevertRuntimeArtifacts({ directory = path.join(root, 'packages/web/runtime'),
  platform = process.platform, arch = process.arch } = {}) {
  const location = path.join(directory, `${platform}-${arch}`);
  const extension = platform === 'win32' ? '.exe' : '';
  const launcher = `DevRyan-execution-${platform}-${arch}${extension}`;
  const companion = `DevRyan-opencode-${platform}-${arch}${extension}`;
  const contract = JSON.parse(await fs.readFile(path.join(root, 'packages/web/server/lib/opencode/companion/manifest.json')));
  const native = JSON.parse(await fs.readFile(path.join(location, launcher + '.json')));
  const runtime = JSON.parse(await fs.readFile(path.join(location, 'companion.json')));
  if (native.acceptance !== true || native.policy !== 2 || native.version !== 1 || native.binary !== launcher
    || native.platform !== platform || native.arch !== arch || native.sha256 !== await digest(path.join(location, launcher))) {
    throw new Error('Revert native confinement artifact is missing, changed, or unverified');
  }
  if (platform === 'darwin' && (native.spawnLibrary !== launcher + '-spawn.dylib'
    || native.spawnSha256 !== await digest(path.join(location, native.spawnLibrary)))) throw new Error('Revert spawn library changed');
  if (runtime.acceptance !== true || Object.entries(contract.capability).some(([name, value]) => runtime[name] !== value)
    || runtime.platform !== platform || runtime.arch !== arch || runtime.binary !== companion
    || runtime.patchSha256 !== contract.patchSha256 || runtime.baseCommit !== contract.baseCommit
    || runtime.upstreamVersion !== contract.upstreamVersion || !/^[a-f0-9]{64}$/.test(runtime.buildInputsSha256 ?? '')
    || runtime.sha256 !== await digest(path.join(location, companion))) throw new Error('Revert companion artifact is missing, changed, or unverified');
  return { location, native, runtime };
}

// CI artifact downloads may normalize all files to 0644. Restore only the
// executables whose contents and acceptance manifests have just been verified.
export async function restoreRevertRuntimeExecutableModes(options) {
  const verified = await verifyRevertRuntimeArtifacts(options);
  for (const file of [verified.native.binary, verified.runtime.binary, verified.native.spawnLibrary].filter(Boolean)) {
    await fs.chmod(path.join(verified.location, file), 0o755);
  }
  return verified;
}

// Call only after verifying the original payload, then applying the owned
// packaging codesign operation. Never use this to accept unknown artifacts.
export async function refreshSignedRevertDigests({ location, native, runtime }) {
  native.sha256 = await digest(path.join(location, native.binary));
  if (native.spawnLibrary) native.spawnSha256 = await digest(path.join(location, native.spawnLibrary));
  runtime.sha256 = await digest(path.join(location, runtime.binary));
  await fs.writeFile(path.join(location, native.binary + '.json'), JSON.stringify(native, null, 2) + '\n');
  await fs.writeFile(path.join(location, 'companion.json'), JSON.stringify(runtime, null, 2) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await verifyRevertRuntimeArtifacts();
  console.log('Revert runtime artifacts verified');
}
