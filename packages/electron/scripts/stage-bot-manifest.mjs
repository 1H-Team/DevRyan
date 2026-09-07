import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readAndVerifyBotRuntimeImagesManifest,
  stageVerifiedBotRuntimeImagesManifest,
} from '../../../scripts/verify-bot-runtime-images.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const electronDir = path.join(repoRoot, 'packages', 'electron');

const resourcesDir = path.join(electronDir, 'resources');
const releaseManifestPath = path.join(resourcesDir, 'bot-runtime', 'images.release.json');

export const prepareBotRuntimeReleaseManifest = async ({ required = true } = {}) => {
  const sourcePath = process.env.DEVRYAN_BOT_RUNTIME_MANIFEST_PATH?.trim();
  const sourceUrl = process.env.DEVRYAN_BOT_RUNTIME_MANIFEST_URL?.trim();
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
