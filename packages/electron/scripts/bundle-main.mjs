/**
 * Bundle main.mjs into a single file. Small electron-* helper deps are
 * inlined; everything else — including the in-process web server
 * (@openchamber/web) and native modules — stays external so it resolves
 * from node_modules at runtime inside the packaged app.
 *
 * Why external matters: packages/web/server pulls in bun-pty, which has
 * a top-level `import { dlopen } from "bun:ffi"`. If we inline it here,
 * Node's ESM loader sees `bun:ffi` at package load time and crashes with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME before any runtime guard can skip it.
 * Leaving @openchamber/web external means the conditional
 * `if (isBunRuntime) await import('bun-pty')` stays dynamic and is never
 * reached under Electron.
 *
 * @openchamber/harness-runtime intentionally remains inline if Electron ever
 * imports it directly. Today it is consumed through the external in-process
 * web server; the package is dependency-free ESM with no native loader edge.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAndVerifyBotRuntimeImagesManifest } from '../../../scripts/verify-bot-runtime-images.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

if (process.env.DEVRYAN_BOT_RUNTIME_REQUIRE_RELEASE_MANIFEST === '1') {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const expectedRevision = process.env.DEVRYAN_BOT_RUNTIME_SOURCE_REVISION?.trim()
    || process.env.GITHUB_SHA?.trim();
  const expectedRepositoryPrefix = process.env.DEVRYAN_BOT_RUNTIME_REPOSITORY_PREFIX?.trim();
  await readAndVerifyBotRuntimeImagesManifest({
    manifestPath: path.join(root, 'resources', 'bot-runtime', 'images.release.json'),
    expectedReleaseId: packageJson.version,
    ...(expectedRevision ? { expectedRevision } : {}),
    ...(expectedRepositoryPrefix ? { expectedRepositoryPrefix } : {}),
  });
  console.log('[electron] verified Bot runtime release manifest before main-process bundling');
}

const result = await Bun.build({
  entrypoints: [path.join(root, 'main.mjs')],
  outdir: path.join(root, 'dist-bundle'),
  target: 'node',
  format: 'esm',
  external: [
    'electron',
    '@openchamber/web',
    '@openchamber/web/*',
    'bun-pty',
    'node-pty',
    'better-sqlite3',
  ],
  minify: false,
  sourcemap: 'none',
  naming: '[name].mjs',
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

console.log('[electron] main.mjs bundled -> dist-bundle/main.mjs');
