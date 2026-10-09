import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyRevertRuntimeArtifacts, restoreRevertRuntimeExecutableModes, SUPPORTED_NATIVE_RUNTIME_TARGETS } from './verify-revert-runtime-artifacts.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('native packaging rejects retired runtime artifacts and unavailable targets before payload reads', async t => {
  assert.deepEqual(SUPPORTED_NATIVE_RUNTIME_TARGETS, ['darwin-arm64']);
  const directory = await fs.mkdtemp(path.resolve('.cache/native-packaging-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(verifyRevertRuntimeArtifacts({ directory, platform: 'darwin', arch: 'x64' }), /unavailable/);
  await assert.rejects(verifyRevertRuntimeArtifacts({ directory, platform: 'linux', arch: 'arm64' }), /unavailable/);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const location = path.join(directory, 'darwin-arm64'); await fs.mkdir(location);
  await fs.writeFile(path.join(location, 'companion.json'), '{"acceptance":true}');
  await assert.rejects(verifyRevertRuntimeArtifacts({ directory }), { code: 'ENOENT' });
  const manifest = { schema: 1, opencodeVersion: '1.18.33', target: 'bun-darwin-arm64', files: [] };
  await fs.writeFile(path.join(location, 'native-bundle.json'), JSON.stringify(manifest));
  await assert.rejects(verifyRevertRuntimeArtifacts({ directory }), /inventory invalid/);
});

test('mode restoration refuses changed or unmanifested bytes before mutating any payload', async t => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') { t.skip('Actual native target unavailable'); return; }
  const directory = await fs.mkdtemp(path.resolve('.cache/native-modes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const location = path.join(directory, 'darwin-arm64'); await fs.mkdir(location);
  const filename = 'DevRyan-native-controller', target = path.join(location, filename);
  const policyName = 'DevRyan-execution-darwin-arm64.json', policy = path.join(location, policyName);
  await fs.writeFile(policy, 'policy'); await fs.chmod(policy, 0o644);
  const manifest = { schema: 1, opencodeVersion: '2.0.26', target: 'bun-darwin-arm64',
    files: [{ path: policyName, role: 'asset', mode: 0o600, size: 6, sha256: hash('policy') },
      { path: filename, role: 'controller', mode: 0o755, size: 7, sha256: hash('fixture') }] };
  await fs.writeFile(target, 'changed'); await fs.chmod(target, 0o644);
  await fs.writeFile(path.join(location, 'native-bundle.json'), JSON.stringify(manifest));
  await assert.rejects(restoreRevertRuntimeExecutableModes({ directory }), /payload changed/);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
  assert.equal((await fs.stat(policy)).mode & 0o777, 0o644);
  await fs.writeFile(target, 'fixture');
  await fs.writeFile(path.join(location, 'DevRyan-opencode-darwin-arm64'), 'retired');
  await assert.rejects(restoreRevertRuntimeExecutableModes({ directory }), /Unmanifested/);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
  assert.equal((await fs.stat(policy)).mode & 0o777, 0o644);
  await fs.rm(path.join(location, 'DevRyan-opencode-darwin-arm64'));
  manifest.files[1].path = 'DevRyan-opencode-darwin-arm64';
  await fs.writeFile(path.join(location, 'native-bundle.json'), JSON.stringify(manifest));
  await assert.rejects(restoreRevertRuntimeExecutableModes({ directory }), /inventory invalid/);
});
