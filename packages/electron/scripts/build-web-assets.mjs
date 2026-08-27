import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  readAndVerifyBotRuntimeImagesManifest,
  stageVerifiedBotRuntimeImagesManifest,
} from '../../../scripts/verify-bot-runtime-images.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const webDir = path.join(repoRoot, 'packages', 'web');
const electronDir = path.join(repoRoot, 'packages', 'electron');

const resourcesDir = path.join(electronDir, 'resources');
const resourcesWebDistDir = path.join(resourcesDir, 'web-dist');
const webDistDir = path.join(webDir, 'dist');
const releaseManifestPath = path.join(resourcesDir, 'bot-runtime', 'images.release.json');

const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
};

const resolveBun = () => {
  if (typeof process.env.BUN === 'string' && process.env.BUN.trim()) {
    return process.env.BUN.trim();
  }
  const result = spawnSync('/bin/bash', ['-lc', 'command -v bun'], { encoding: 'utf8' });
  const resolved = (result.stdout || '').trim();
  return resolved || 'bun';
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const removeDir = async (target) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await sleep(100 * (attempt + 1));
    }
  }
};

const copyDir = async (src, dst) => {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await fs.copyFile(from, to);
    }
  }
};

const prepareBotRuntimeReleaseManifest = async () => {
  const sourcePath = process.env.DEVRYAN_BOT_RUNTIME_MANIFEST_PATH?.trim();
  const sourceUrl = process.env.DEVRYAN_BOT_RUNTIME_MANIFEST_URL?.trim();
  const required = process.env.DEVRYAN_BOT_RUNTIME_REQUIRE_RELEASE_MANIFEST === '1';
  if (sourcePath && sourceUrl) {
    throw new Error('Configure only one Bot runtime release manifest source');
  }
  if (!sourcePath && !sourceUrl && !required) return;
  const packageJson = JSON.parse(
    await fs.readFile(path.join(electronDir, 'package.json'), 'utf8'),
  );
  const expectedRevision = process.env.DEVRYAN_BOT_RUNTIME_SOURCE_REVISION?.trim()
    || process.env.GITHUB_SHA?.trim();
  const expectedRepositoryPrefix = process.env.DEVRYAN_BOT_RUNTIME_REPOSITORY_PREFIX?.trim();
  const expectations = {
    expectedReleaseId: packageJson.version,
    ...(expectedRevision ? { expectedRevision } : {}),
    ...(expectedRepositoryPrefix ? { expectedRepositoryPrefix } : {}),
  };
  if (sourcePath || sourceUrl) {
    await stageVerifiedBotRuntimeImagesManifest({
      ...(sourcePath ? { sourcePath: path.resolve(sourcePath) } : { sourceUrl }),
      destinationPath: releaseManifestPath,
      token: process.env.GITHUB_TOKEN,
      ...expectations,
    });
    console.log(`[electron] staged verified Bot runtime release manifest: ${releaseManifestPath}`);
    return;
  }
  await readAndVerifyBotRuntimeImagesManifest({
    manifestPath: releaseManifestPath,
    ...expectations,
  });
  console.log(`[electron] verified staged Bot runtime release manifest: ${releaseManifestPath}`);
};

const bunExe = resolveBun();

await prepareBotRuntimeReleaseManifest();

console.log('[electron] building web UI dist...');
run(bunExe, ['run', 'build'], webDir);

console.log('[electron] staging packaged resources...');
await fs.mkdir(resourcesDir, { recursive: true });
const stagedWebDistDir = await fs.mkdtemp(path.join(resourcesDir, 'web-dist-staging-'));
await copyDir(webDistDir, stagedWebDistDir);
await removeDir(resourcesWebDistDir);
await fs.rename(stagedWebDistDir, resourcesWebDistDir);

console.log(`[electron] web assets ready: ${resourcesWebDistDir}`);
