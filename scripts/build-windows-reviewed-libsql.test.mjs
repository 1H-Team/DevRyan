import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertWindowsBinaryArchitecture } from './build-windows-reviewed-libsql.mjs';

test('native dependency architecture refuses foreign and truncated PE images', () => {
  const image = Buffer.alloc(128); image.write('MZ'); image.writeUInt32LE(64, 60); image.write('PE\0\0', 64, 'binary'); image.writeUInt16LE(0xaa64, 68);
  assert.doesNotThrow(() => assertWindowsBinaryArchitecture(image, 'arm64'));
  assert.throws(() => assertWindowsBinaryArchitecture(image, 'x64'), /differs from host/);
  for (const bytes of [image.subarray(0, 63), image.subarray(0, 69), Buffer.alloc(128)]) assert.throws(() => assertWindowsBinaryArchitecture(bytes, 'arm64'));
});

test('Git checkout overrides Windows CRLF conversion without changing source bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-libsql-checkout-'));
  const source = path.join(root, 'source'), clone = path.join(root, 'clone'), template = path.join(root, 'template');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const git = (cwd, args, extra = {}) => execFileSync('git', args, { cwd, env: { ...env, ...extra }, timeout: 10000, stdio: 'pipe' });
  try {
    await fs.mkdir(source); await fs.mkdir(template);
    const bytes = Buffer.from('[package]\nname = "fixture"\nversion = "0.5.29"\n');
    await fs.writeFile(path.join(source, 'Cargo.toml'), bytes);
    git(source, ['init', '--quiet', '--initial-branch=main', `--template=${template}`]);
    git(source, ['add', 'Cargo.toml']);
    git(source, ['-c', 'user.name=Disposable fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
    git(root, ['clone', '--quiet', '--no-checkout', source, clone]);
    git(clone, ['config', 'core.autocrlf', 'true']);
    git(clone, ['checkout', '--quiet', 'main']);
    assert.notDeepEqual(await fs.readFile(path.join(clone, 'Cargo.toml')), bytes);
    await fs.rm(path.join(clone, 'Cargo.toml'));
    git(clone, ['restore', '--worktree', '--', 'Cargo.toml'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
    assert.deepEqual(await fs.readFile(path.join(clone, 'Cargo.toml')), bytes);
    assert.equal(git(clone, ['status', '--porcelain']).toString(), '');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
