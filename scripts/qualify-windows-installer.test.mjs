import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureInstallerQualificationSource, installerQualificationStatus,
  WINDOWS_INSTALLER_PREREQUISITES, WINDOWS_INSTALLER_SCENARIOS } from './qualify-windows-installer.mjs';

const rows = (ids, status = 'passed') => ids.map(id => ({ id, status }));

test('installer acceptance requires all native prerequisites and all five actual scenarios', () => {
  const prerequisites = rows(WINDOWS_INSTALLER_PREREQUISITES), scenarios = rows(WINDOWS_INSTALLER_SCENARIOS);
  assert.equal(installerQualificationStatus(prerequisites, scenarios), 'passed');
  for (let index = 0; index < prerequisites.length; index++) {
    const failed = structuredClone(prerequisites); failed[index].status = 'failed';
    assert.equal(installerQualificationStatus(failed, scenarios), 'blocked');
  }
  for (let index = 0; index < scenarios.length; index++) {
    const failed = structuredClone(scenarios); failed[index].status = 'failed';
    assert.equal(installerQualificationStatus(prerequisites, failed), 'failed');
    failed[index].status = 'blocked';
    assert.equal(installerQualificationStatus(prerequisites, failed), 'failed');
  }
  assert.throws(() => installerQualificationStatus(prerequisites.slice(1), scenarios));
  assert.throws(() => installerQualificationStatus(prerequisites, scenarios.slice(1)));
  assert.throws(() => installerQualificationStatus(prerequisites, scenarios.map(row => ({ ...row, id: 'installation' }))));
  assert.equal(Object.isFrozen(WINDOWS_INSTALLER_SCENARIOS), true);
});

test('source evidence binds current tracked and new owner bytes in an owned disposable repository', async () => {
  const fixtureParent = fileURLToPath(new URL('../.cache/test-fixtures/', import.meta.url));
  await fs.mkdir(fixtureParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(fixtureParent, 'windows-installer-source-'));
  try {
    execFileSync('git', ['init', '-q', root], { stdio: 'pipe' });
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.writeFile(path.join(root, 'scripts/existing.mjs'), 'export const value = 1;\n');
    await fs.writeFile(path.join(root, 'bun.lock'), 'disposable lock\n');
    execFileSync('git', ['add', 'scripts/existing.mjs', 'bun.lock'], { cwd: root, stdio: 'pipe' });
    const before = await captureInstallerQualificationSource(root);
    assert.deepEqual(before.sourceFiles.map(file => file.path), ['bun.lock', 'scripts/existing.mjs']);
    assert.equal((await captureInstallerQualificationSource(root)).sourceTreeSha256, before.sourceTreeSha256);
    await fs.writeFile(path.join(root, 'scripts/existing.mjs'), 'export const value = 2;\n');
    const modified = await captureInstallerQualificationSource(root);
    assert.notEqual(modified.sourceTreeSha256, before.sourceTreeSha256);
    await fs.writeFile(path.join(root, 'scripts/new-owner.mjs'), 'export const owner = true;\n');
    const added = await captureInstallerQualificationSource(root);
    assert.notEqual(added.sourceTreeSha256, modified.sourceTreeSha256);
    assert.ok(added.sourceFiles.some(file => file.path === 'scripts/new-owner.mjs'));
    // NSIS also carries rebuilt UI assets and external web/workspace code.
    for (const input of ['packages/ui/src/application.tsx', 'packages/web/server/application.js',
      'packages/bot-db/index.js', 'package.json', 'vite.config.ts']) {
      await fs.mkdir(path.dirname(path.join(root, input)), { recursive: true });
      await fs.writeFile(path.join(root, input), 'first build input\n');
    }
    const built = await captureInstallerQualificationSource(root);
    assert.notEqual(built.sourceTreeSha256, added.sourceTreeSha256);
    for (const input of ['packages/ui/src/application.tsx', 'packages/web/server/application.js',
      'packages/bot-db/index.js', 'package.json', 'vite.config.ts']) {
      await fs.writeFile(path.join(root, input), 'changed build input\n');
      assert.notEqual((await captureInstallerQualificationSource(root)).sourceTreeSha256, built.sourceTreeSha256, input);
      await fs.writeFile(path.join(root, input), 'first build input\n');
    }
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'outside the declared source closure\n');
    assert.equal((await captureInstallerQualificationSource(root)).sourceTreeSha256, built.sourceTreeSha256);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('qualification entrypoint validates arguments before touching native or installed state', () => {
  const command = fileURLToPath(new URL('./qualify-windows-installer.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [command, 'unused-output', 'extra-argument'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Pass only the owned native supervisor output directory/);
  if (process.platform !== 'win32') {
    const unavailable = spawnSync(process.execPath, [command, 'unused-output'], { encoding: 'utf8' });
    assert.equal(unavailable.status, 1);
    assert.match(unavailable.stderr, /Actual native Windows installer qualification required/);
  }
});
