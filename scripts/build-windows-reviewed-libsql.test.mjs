import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertWindowsBinaryArchitecture,readWindowsReviewedLibsqlAsset } from './build-windows-reviewed-libsql.mjs';

test('native dependency architecture refuses foreign and truncated PE images', () => {
  const image = Buffer.alloc(128); image.write('MZ'); image.writeUInt32LE(64, 60); image.write('PE\0\0', 64, 'binary'); image.writeUInt16LE(0xaa64, 68);
  assert.doesNotThrow(() => assertWindowsBinaryArchitecture(image, 'arm64'));
  assert.throws(() => assertWindowsBinaryArchitecture(image, 'x64'), /differs from host/);
  for (const bytes of [image.subarray(0, 63), image.subarray(0, 69), Buffer.alloc(128)]) assert.throws(() => assertWindowsBinaryArchitecture(bytes, 'arm64'));
});

test('libsql compilation candidates require source pins, both ABI probes and exact unaliased binary bytes', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-libsql-candidate-')));
  const directory = path.join(root, '.cache/windows-native/x64');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const image = Buffer.alloc(128); image.write('MZ'); image.writeUInt32LE(64, 60); image.write('PE\0\0', 64, 'binary'); image.writeUInt16LE(0x8664, 68);
  const inputs = {
    'Cargo.toml': 'cf729f40413e3131258e98579ab760b2e75238255cd56729ebb65b4f410ea953',
    'Cargo.lock': '897f93398893ce805b389b482ddf7555b75365a5f48a2e345703f21c1c58d74e',
    'rust-toolchain.toml': 'df9ff8a9ca1dcbadc9b912fa46d0e99d20f2e3695a4fa4c009df5f02b44bece8',
    'package.json': '9b38bb06405f07a6c7458bd3e821e3bebae0b19b4c6cd8b08607f36916228e50',
  };
  const evidence = { schema: 1, status: 'asset-candidate-passed', stage: 'complete', version: '0.5.29',
    sourceCommit: '55bee86d1c284f1ddf2b9e280e870d2b6cef884a', target: 'x86_64-pc-windows-msvc',
    toolchain: '1.85.1-x86_64-pc-windows-msvc', cmakeGenerator: 'NMake Makefiles', inputs, inputSha256: inputs,
    binary: 'DevRyan-libsql-win32-x64.node', sha256: digest(image), smokes: ['node', 'bun'].map(runtime => ({
      status: 'passed', platform: 'win32', arch: 'x64', runtime, version: runtime === 'bun' ? '1.3.14' : '22.23.3' })) };
  const receipt = path.join(directory, 'libsql-source-evidence.json'), binary = path.join(directory, evidence.binary);
  const read = () => readWindowsReviewedLibsqlAsset({ repository: root, arch: 'x64' });
  try {
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(binary, image);
    await fs.writeFile(receipt, JSON.stringify(evidence));
    const asset = await read(); assert.equal(asset.sha256, digest(image)); assert.equal(asset.path, evidence.binary);
    for (const change of [
      { status: 'failed' }, { sourceCommit: '0'.repeat(40) }, { inputSha256: { ...inputs, 'Cargo.lock': '0'.repeat(64) } },
      { smokes: evidence.smokes.slice(0, 1) }, { smokes: evidence.smokes.map(probe => ({ ...probe, arch: 'arm64' })) },
      { binary: '../foreign.node' }, { sha256: '0'.repeat(64) },
    ]) { await fs.writeFile(receipt, JSON.stringify({ ...evidence, ...change })); await assert.rejects(read()); }
    await fs.writeFile(receipt, JSON.stringify(evidence));
    image.writeUInt16LE(0xaa64, 68); await fs.writeFile(binary, image);
    await assert.rejects(read(), /differs from host/);
    image.writeUInt16LE(0x8664, 68); await fs.writeFile(binary, image);
    await fs.link(binary, path.join(directory, 'alias.node')); await assert.rejects(read(), /candidate path invalid/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
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
