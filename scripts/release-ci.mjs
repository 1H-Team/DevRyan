// Fixed CI operations for release.yml: the web artifact handoff (web-describe,
// web-stage) and the legacy prepared-tree archive (prepare-export, prepare-import).
// Reusable validation lives in release-artifacts.mjs; GitHub Release admission and
// publication live in release.mjs. The retired Bot image commands were removed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeWebArtifact, stageWebArtifact, hash, releaseIdentity, verifyPreparedMetadata } from './release-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const identity = await releaseIdentity(root, env.GITHUB_SHA);
const webIdentity = { ...identity, runID: env.GITHUB_RUN_ID };
if (env.RELEASE_OPERATION?.startsWith('web-') && !/^\d+$/.test(webIdentity.runID ?? '')) throw new Error('Web artifact requires exact workflow run identity');
const output = path.resolve(env.RELEASE_ARTIFACT_DIR || path.join(root, 'artifacts'));
const write = async (name, value) => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
};
const read = async (name) => JSON.parse(await fs.readFile(path.join(output, name), 'utf8'));
const run = (args) => {
  const result = spawnSync('tar', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Prepared artifact archive operation failed');
};
const preparedArchive = 'prepared.tar.zst';
if (![undefined, 'true', 'false'].includes(env.RELEASE_DRY_RUN)) throw new Error('Invalid RELEASE_DRY_RUN');
switch (env.RELEASE_OPERATION) {
  case 'web-describe':
    await write('web.json', await describeWebArtifact(path.join(output, 'web'), webIdentity));
    break;
  case 'web-stage':
    await stageWebArtifact({ source: path.join(output, 'web'), metadata: await read('web.json'), identity: webIdentity,
      destination: path.join(root, env.RELEASE_WEB_TARGET === 'electron' ? 'packages/electron/resources/web-dist' : 'packages/web/dist') });
    break;
  case 'prepare-export': {
    const { verifyRevertRuntimeArtifacts, SUPPORTED_NATIVE_RUNTIME_TARGETS } = await import('./verify-revert-runtime-artifacts.mjs');
    const arch = env.ELECTRON_BUILDER_ARCH;
    if (!['arm64', 'x64'].includes(arch)) throw new Error('Invalid prepared architecture');
    await fs.mkdir(output, { recursive: true });
    const nativeTarget = `${process.platform}-${arch}`;
    if (!SUPPORTED_NATIVE_RUNTIME_TARGETS.includes(nativeTarget)) throw new Error(`Native prepared artifact verification unavailable for ${nativeTarget}`);
    await verifyRevertRuntimeArtifacts({ platform: process.platform, arch });
    const files = ['node_modules', 'packages/electron/dist-bundle', 'packages/electron/resources/native', 'packages/electron/resources/runtime-service', `packages/web/runtime/${nativeTarget}`];
    for (const entry of await fs.readdir(path.join(root, 'packages'))) {
      const relative = `packages/${entry}/node_modules`;
      if (await fs.lstat(path.join(root, relative)).then(() => true, () => false)) files.push(relative);
    }
    // Multithreaded zstd: single-threaded gzip of the dependency tree dominated this step.
    run(['--use-compress-program', 'zstd -T0 -3', '-cf', path.join(output, preparedArchive), ...files]);
    await write('prepared.json', { version: 1, kind: 'electron-prepared', ...identity, arch, archiveHash: hash(await fs.readFile(path.join(output, preparedArchive))) });
    break;
  }
  case 'prepare-import':
    verifyPreparedMetadata(await read('prepared.json'), identity, env.ELECTRON_BUILDER_ARCH,
      hash(await fs.readFile(path.join(output, preparedArchive))));
    run(['--use-compress-program', 'zstd -d -T0', '-xf', path.join(output, preparedArchive)]);
    break;
  default: throw new Error('Unknown release CI operation');
}
