// Fixed CI operations; reusable validation lives in release-artifacts/image modules.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseAssetName } from '../packages/electron/release-assets.mjs';
import { describeDirectoryAssets } from './verify-release-assets.mjs';
import { BOT_RUNTIME_IMAGE_DEFINITIONS, assembleBotRuntimeImages, createBotRuntimeImageBuildPlan, signBotRuntimeImage } from './build-bot-runtime-images.mjs';
import { readBotRuntimeImageInputs, resolveBotRuntimeImages, tagBotRuntimeImageInputs } from './bot-runtime-image-inputs.mjs';
import { describeWebArtifact, verifyWebArtifact, stageWebArtifact, hash, releaseIdentity, verifyPreparedMetadata } from './release-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const identity = await releaseIdentity(root, env.GITHUB_SHA);
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
const botIdentity = { version: identity.release, revision: identity.revision, repositoryPrefix: `ghcr.io/${env.GITHUB_REPOSITORY_OWNER?.toLowerCase()}` };
if (![undefined, 'true', 'false'].includes(env.RELEASE_DRY_RUN)) throw new Error('Invalid RELEASE_DRY_RUN');
switch (env.RELEASE_OPERATION) {
  case 'asset-describe': {
    const name = releaseAssetName(env.RELEASE_ASSET_PLATFORM, identity.release);
    const directory = path.resolve(env.RELEASE_ASSET_DIRECTORY ?? '');
    if (!directory.startsWith(root + path.sep) || await fs.realpath(directory) !== directory) throw new Error('Owned release asset directory required');
    const assets = await describeDirectoryAssets(directory), asset = assets.find(asset => asset.name === name);
    if (!asset || asset.state !== 'uploaded' || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Packaged release asset missing or invalid');
    await fs.appendFile(env.GITHUB_OUTPUT, `sha256=${asset.digest.slice(7)}\n`);
    break;
  }
  case 'image-plan': {
    const plan = createBotRuntimeImageBuildPlan({ ...botIdentity, root });
    const build = plan.builds.find((entry) => entry.key === env.IMAGE_KEY);
    if (!build) throw new Error('Unknown image');
    await fs.appendFile(env.GITHUB_OUTPUT, `dockerfile=${BOT_RUNTIME_IMAGE_DEFINITIONS[build.key].dockerfile}\nrepository=${build.repository}\ntags=${build.repository}:${identity.release},${build.repository}:sha-${identity.revision.slice(0, 12)}\n`);
    break;
  }
  case 'image-resolve': {
    // An image whose inputs match a verified signed :in-<digest> image is reused; the rest are built.
    if (!['true', 'false', undefined].includes(env.REBUILD_BOT_IMAGES)) throw new Error('Invalid REBUILD_BOT_IMAGES');
    const resolution = await resolveBotRuntimeImages({ ...botIdentity, root, workflowRepository: env.GITHUB_REPOSITORY,
      keys: env.IMAGE_KEY ? [env.IMAGE_KEY] : undefined, rebuild: env.REBUILD_BOT_IMAGES === 'true' });
    for (const result of resolution.reused) {
      await write(`${result.key}.json`, result);
      console.log(`[bots] ${result.key}: reusing ${result.image.repository}@${result.image.indexDigest}`);
    }
    for (const key of resolution.build) console.log(`[bots] ${key}: building (${resolution.reasons[key]})`);
    if (env.RELEASE_DRY_RUN === 'true' && resolution.build.length) {
      throw new Error('Dry run cannot publish new Bot images. Qualification requires verified signed images for the changed inputs: ' + resolution.build.join(', '));
    }
    await fs.appendFile(env.GITHUB_OUTPUT, `build=${JSON.stringify(resolution.build)}\n`);
    await write('resolution.txt', { build: resolution.build });
    break;
  }
  case 'image-sign': {
    const result = await signBotRuntimeImage({ ...botIdentity, key: env.IMAGE_KEY, indexDigest: env.IMAGE_DIGEST, root });
    const { digest } = await readBotRuntimeImageInputs({ key: env.IMAGE_KEY, root });
    const tagged = await tagBotRuntimeImageInputs({ repository: result.image.repository, indexDigest: result.image.indexDigest, inputDigest: digest, environment: env });
    console.log(tagged ? `[bots] ${env.IMAGE_KEY}: tagged ${tagged}` : `[bots] ${env.IMAGE_KEY}: input tag skipped outside tag-triggered release.yml runs`);
    await write(`${env.IMAGE_KEY}.json`, result);
    break;
  }
  case 'image-assemble': {
    const entries = await fs.readdir(output);
    const results = await Promise.all(entries.filter((name) => name.endsWith('.json')).map(read));
    await write(`DevRyan-bot-runtime-images-${identity.release}.json`, await assembleBotRuntimeImages({ ...botIdentity, results, root }));
    break;
  }
  case 'web-pack': {
    const { packWebRelease } = await import('./pack-web-release.mjs');
    const { restoreRevertRuntimeExecutableModes, assertUniversalNativeReleaseAvailable, SUPPORTED_NATIVE_RUNTIME_TARGETS } = await import('./verify-revert-runtime-artifacts.mjs');
    assertUniversalNativeReleaseAvailable();
    await verifyWebArtifact(path.join(root, 'packages/web/dist'), await read('web.json'), identity);
    for (const target of SUPPORTED_NATIVE_RUNTIME_TARGETS) {
      const [platform, arch] = target.split('-');
      await restoreRevertRuntimeExecutableModes({ platform, arch });
    }
    await packWebRelease({ root, destination: path.join(root, 'packages/web') });
    break;
  }
  case 'web-describe':
    await write('web.json', await describeWebArtifact(path.join(output, 'web'), identity));
    break;
  case 'web-stage':
    await stageWebArtifact({ source: path.join(output, 'web'), metadata: await read('web.json'), identity,
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
