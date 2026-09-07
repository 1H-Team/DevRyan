import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { prepareBotRuntimeReleaseManifest } from './stage-bot-manifest.mjs';

const require = createRequire(import.meta.url);
const run = (args) => {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaging command failed (${result.status ?? result.signal})`);
};

export async function packagePrepared({ args = [], arch = process.env.ELECTRON_BUILDER_ARCH,
  stageManifest = prepareBotRuntimeReleaseManifest, execute = run,
  builder = () => require.resolve('electron-builder/cli.js'),
} = {}) {
  await stageManifest({ required: true });
  execute([builder(), ...args]);
  execute(['./scripts/verify-runtime-service-package.mjs', ...(arch ? ['--arch', arch] : [])]);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await packagePrepared({ args: process.argv.slice(2) });
}
