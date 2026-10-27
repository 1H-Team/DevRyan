import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hydrateWindowsReviewedExecutables } from './build-windows-reviewed-executables.mjs';

test('reviewed Windows inputs reject foreign architectures before any filesystem or download work', async () => {
  for (const arch of [undefined, 'darwin-arm64', 'ia32', '__proto__', 'constructor']) {
    await assert.rejects(hydrateWindowsReviewedExecutables({ repository: '/does-not-exist', arch,
      fetchImpl: () => { throw Error('must not download'); } }), { code: 'windows_reviewed_architecture_invalid' });
  }
});

test('changed existing Windows executables remain intact without a replacement download', async () => {
  const repository = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-win-existing-')));
  try {
    const directory = path.join(repository, '.cache/windows-native/x64/assets');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'DevRyan-ast-grep-win32-x64.exe');
    await fs.writeFile(file, 'changed binary');
    await assert.rejects(hydrateWindowsReviewedExecutables({ repository, arch: 'x64',
      fetchImpl: () => { throw Error('must not download'); } }), { code: 'windows_reviewed_binary_invalid' });
    assert.equal(await fs.readFile(file, 'utf8'), 'changed binary');
    assert.deepEqual(await fs.readdir(directory), [path.basename(file)]);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});

test('a corrupt Windows archive publishes no executable and removes only its temporary bytes', async () => {
  const repository = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-win-corrupt-')));
  try {
    let downloads = 0;
    await assert.rejects(hydrateWindowsReviewedExecutables({ repository, arch: 'arm64', fetchImpl: async (url, options) => {
      downloads++;
      assert.equal(url, 'https://registry.npmjs.org/@ast-grep/cli-win32-arm64-msvc/-/cli-win32-arm64-msvc-0.45.3.tgz');
      assert.equal(options.redirect, 'error');
      return new Response('corrupt archive');
    } }), { code: 'windows_reviewed_archive_invalid' });
    assert.equal(downloads, 1);
    assert.deepEqual(await fs.readdir(path.join(repository, '.cache/windows-native/arm64/assets')), []);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});

test('an aliased Windows asset directory refuses before reading or downloading assets', async () => {
  const repository = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-win-alias-')));
  try {
    const parent = path.join(repository, '.cache/windows-native/x64'), target = path.join(repository, 'target');
    await fs.mkdir(parent, { recursive: true }); await fs.mkdir(target);
    await fs.symlink(target, path.join(parent, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(hydrateWindowsReviewedExecutables({ repository, arch: 'x64',
      fetchImpl: () => { throw Error('must not download'); } }), { code: 'windows_reviewed_root_invalid' });
    assert.deepEqual(await fs.readdir(target), []);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});
