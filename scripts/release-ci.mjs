import { packWebRelease } from './pack-web-release.mjs';
// Fixed CI operations; reusable validation lives in release-artifacts/image modules.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BOT_RUNTIME_IMAGE_DEFINITIONS, assembleBotRuntimeImages, createBotRuntimeImageBuildPlan, signBotRuntimeImage } from './build-bot-runtime-images.mjs';
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
const botIdentity = { version: identity.release, revision: identity.revision, repositoryPrefix: `ghcr.io/${env.GITHUB_REPOSITORY_OWNER?.toLowerCase()}` };
switch (env.RELEASE_OPERATION) {
  case 'image-plan': {
    const plan = createBotRuntimeImageBuildPlan({ ...botIdentity, root });
    const build = plan.builds.find((entry) => entry.key === env.IMAGE_KEY);
    if (!build) throw new Error('Unknown image');
    await fs.appendFile(env.GITHUB_OUTPUT, `dockerfile=${BOT_RUNTIME_IMAGE_DEFINITIONS[build.key].dockerfile}\nrepository=${build.repository}\ntags=${build.repository}:${identity.release},${build.repository}:sha-${identity.revision.slice(0, 12)}\n`);
    break;
  }
  case 'image-sign':
    await write(`${env.IMAGE_KEY}.json`, await signBotRuntimeImage({ ...botIdentity, key: env.IMAGE_KEY, indexDigest: env.IMAGE_DIGEST, root }));
    break;
  case 'image-assemble': {
    const entries = await fs.readdir(output);
    const results = await Promise.all(entries.filter((name) => name.endsWith('.json')).map(read));
    await write(`DevRyan-bot-runtime-images-${identity.release}.json`, await assembleBotRuntimeImages({ ...botIdentity, results, root }));
    break;
  }
  case 'web-pack':
    await verifyWebArtifact(path.join(root, 'packages/web/dist'), await read('web.json'), identity);
    await packWebRelease({ root, destination: path.join(root, 'packages/web') });
    break;
  case 'web-describe':
    await write('web.json', await describeWebArtifact(path.join(output, 'web'), identity));
    break;
  case 'web-stage':
    await stageWebArtifact({ source: path.join(output, 'web'), metadata: await read('web.json'), identity,
      destination: path.join(root, env.RELEASE_WEB_TARGET === 'electron' ? 'packages/electron/resources/web-dist' : 'packages/web/dist') });
    break;
  case 'prepare-export': {
    const arch = env.ELECTRON_BUILDER_ARCH;
    if (!['arm64', 'x64'].includes(arch)) throw new Error('Invalid prepared architecture');
    await fs.mkdir(output, { recursive: true });
    const files = ['node_modules', 'packages/electron/dist-bundle', 'packages/electron/resources/native', 'packages/electron/resources/runtime-service'];
    for (const entry of await fs.readdir(path.join(root, 'packages'))) {
      const relative = `packages/${entry}/node_modules`;
      if (await fs.lstat(path.join(root, relative)).then(() => true, () => false)) files.push(relative);
    }
    run(['-czf', path.join(output, 'prepared.tgz'), ...files]);
    await write('prepared.json', { version: 1, kind: 'electron-prepared', ...identity, arch, archiveHash: hash(await fs.readFile(path.join(output, 'prepared.tgz'))) });
    break;
  }
  case 'prepare-import':
    verifyPreparedMetadata(await read('prepared.json'), identity, env.ELECTRON_BUILDER_ARCH,
      hash(await fs.readFile(path.join(output, 'prepared.tgz'))));
    run(['-xzf', path.join(output, 'prepared.tgz')]);
    break;
  default: throw new Error('Unknown release CI operation');
}
