import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'a'.repeat(40);

async function checkout(t, extra = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-release-ci-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of [
    'package.json', 'bun.lock', 'scripts/release-ci.mjs', 'scripts/release-artifacts.mjs',
    ...extra,
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

test('the retired Bot image commands are gone and unknown operations fail', async t => {
  const root = await checkout(t);
  for (const operation of ['image-plan', 'image-resolve', 'image-sign', 'image-assemble', 'unknown']) {
    const result = run(root, operation);
    assert.notEqual(result.status, 0, operation);
    assert.match(result.stderr, /Unknown release CI operation/, operation);
  }
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
