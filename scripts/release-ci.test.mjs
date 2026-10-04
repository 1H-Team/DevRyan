import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'a'.repeat(40);

async function checkout(t) {
  const parent = path.join(repository, '.cache/test-fixtures');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'release-ci-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of [
    'package.json', 'bun.lock', 'scripts/release-ci.mjs',
    'scripts/release-artifacts.mjs', 'scripts/build-bot-runtime-images.mjs',
    'scripts/verify-bot-runtime-images.mjs',
    'packages/electron/bot-runtime-manifest.mjs',
    'packages/web/server/lib/opencode/version-policy.js',
  ]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(repository, file), path.join(root, file));
  }
  return root;
}

function run(root, operation, environment = {}) {
  return spawnSync(process.execPath, ['scripts/release-ci.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { GITHUB_SHA: revision, GITHUB_REPOSITORY_OWNER: '1H-Team',
      RELEASE_OPERATION: operation, ...environment },
  });
}

test('image planning succeeds in a checkout without installed runtime dependencies', async t => {
  const root = await checkout(t), output = path.join(root, 'image-output');
  const result = run(root, 'image-plan', { IMAGE_KEY: 'computer', GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  const fields = await fs.readFile(output, 'utf8');
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(fields, `dockerfile=packages/bot-computer/Dockerfile\nrepository=ghcr.io/1h-team/devryan-bot-computer\ntags=ghcr.io/1h-team/devryan-bot-computer:${version},ghcr.io/1h-team/devryan-bot-computer:sha-${revision.slice(0, 12)}\n`);
});

test('prepared import checks archive identity before dependencies have been restored', async t => {
  const root = await checkout(t), output = path.join(root, 'artifacts');
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'prepared.json'), '{}');
  await fs.writeFile(path.join(output, 'prepared.tar.zst'), 'not a prepared archive');
  const result = run(root, 'prepare-import', { ELECTRON_BUILDER_ARCH: 'arm64' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Prepared Electron artifact mismatch/);
  assert.equal(result.error, undefined);
});
