import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifySessionExecutionLauncher } from './session-execution.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

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
