import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareSessionExecution, verifySessionExecutionLauncher } from './session-execution.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

test('all confined workers use their scratch home and temporary paths, including QA-preloaded providers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-home-')); roots.push(root);
  const viewDirectory = path.join(root, 'view'); await fs.mkdir(viewDirectory);
  const prepared = await prepareSessionExecution({ launcher: path.join(root, 'launcher'), lease: { viewDirectory } });
  expect(prepared.environment).toMatchObject({ DEVRYAN_EXECUTION_WORKER: '1', HOME: prepared.scratchDirectory,
    TMPDIR: prepared.scratchDirectory, TMP: prepared.scratchDirectory, TEMP: prepared.scratchDirectory,
    TMPPREFIX: path.join(prepared.scratchDirectory, 'zsh') });
});

test('an intact artifact without native acceptance cannot attest complete confinement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-manifest-')); roots.push(root);
  const launcher = path.join(root, 'DevRyan-execution-linux');
  const bytes = Buffer.from('fixture binary'); await fs.writeFile(launcher, bytes);
  await fs.writeFile(`${launcher}.json`, JSON.stringify({ version: 1, policy: 2, acceptance: false, platform: 'linux', arch: process.arch,
    binary: path.basename(launcher), sha256: createHash('sha256').update(bytes).digest('hex') }));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'linux' })).toBe(false);
});

test('native artifact verification rejects changed bytes and unsupported policy versions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-manifest-')); roots.push(root);
  const launcher = path.join(root, 'DevRyan-execution-darwin');
  const bytes = Buffer.from('fixture binary'); await fs.writeFile(launcher, bytes);
  const manifest = { version: 1, policy: 2, acceptance: true, platform: 'darwin', arch: process.arch,
    binary: path.basename(launcher), sha256: createHash('sha256').update(bytes).digest('hex'),
    spawnLibrary: `${path.basename(launcher)}-spawn.dylib`, spawnSha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(`${launcher}-spawn.dylib`, bytes);
  await fs.writeFile(`${launcher}.json`, JSON.stringify(manifest));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
  await fs.appendFile(launcher, 'changed');
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(false);
  await fs.writeFile(launcher, bytes);
  await fs.writeFile(`${launcher}.json`, JSON.stringify({ ...manifest, policy: 3 }));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(false);
});

test('launcher verification is cached by file identity and invalidated by any replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-cache-')); roots.push(root);
  const launcher = path.join(root, 'DevRyan-execution-darwin');
  const bytes = Buffer.from('fixture binary'); await fs.writeFile(launcher, bytes);
  const manifest = { version: 1, policy: 2, acceptance: true, platform: 'darwin', arch: process.arch,
    binary: path.basename(launcher), sha256: createHash('sha256').update(bytes).digest('hex'),
    spawnLibrary: `${path.basename(launcher)}-spawn.dylib`, spawnSha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(`${launcher}-spawn.dylib`, bytes);
  await fs.writeFile(`${launcher}.json`, JSON.stringify(manifest));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
  const reads = spyOn(fs, 'readFile');
  try {
    expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    // Same bytes written again still changes the identity and forces a re-hash.
    await fs.writeFile(`${launcher}-spawn.dylib`, Buffer.from('replaced library'));
    expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(false);
    await fs.writeFile(`${launcher}-spawn.dylib`, bytes);
    expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
    expect(reads).toHaveBeenCalled();
  } finally { reads.mockRestore(); }
});

test('a symlinked launcher artifact is always re-hashed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-link-')); roots.push(root);
  const launcher = path.join(root, 'DevRyan-execution-darwin');
  const bytes = Buffer.from('fixture binary'); await fs.writeFile(launcher, bytes);
  const target = path.join(root, 'real-spawn.dylib'); await fs.writeFile(target, bytes);
  await fs.symlink(target, `${launcher}-spawn.dylib`);
  await fs.writeFile(`${launcher}.json`, JSON.stringify({ version: 1, policy: 2, acceptance: true, platform: 'darwin', arch: process.arch,
    binary: path.basename(launcher), sha256: createHash('sha256').update(bytes).digest('hex'),
    spawnLibrary: `${path.basename(launcher)}-spawn.dylib`, spawnSha256: createHash('sha256').update(bytes).digest('hex') }));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
  await fs.writeFile(target, Buffer.from('rewritten target'));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(false);
});
