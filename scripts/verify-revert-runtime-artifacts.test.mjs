import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyRevertRuntimeArtifacts, restoreRevertRuntimeExecutableModes } from './verify-revert-runtime-artifacts.mjs';

test('packaging refuses changed, unverified and mismatched Revert artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'revert-artifacts-'));
  const location = path.join(root, 'darwin-arm64');
  const binary = 'DevRyan-execution-darwin-arm64', companion = 'DevRyan-opencode-darwin-arm64';
  const sha256 = createHash('sha256').update('fixture').digest('hex');
  const contract = JSON.parse(await fs.readFile(new URL('../packages/web/server/lib/opencode/companion/manifest.json', import.meta.url)));
  const native = { version: 1, policy: 2, acceptance: true, platform: 'darwin', arch: 'arm64', binary, sha256,
    spawnLibrary: binary + '-spawn.dylib', spawnSha256: sha256 };
  const runtime = { ...contract.capability, acceptance: true, platform: 'darwin', arch: 'arm64', binary: companion,
    sha256, patchSha256: contract.patchSha256, baseCommit: contract.baseCommit };
  const verify = () => verifyRevertRuntimeArtifacts({ directory: root, platform: 'darwin', arch: 'arm64' });
  try {
    await fs.mkdir(location);
    for (const file of [binary, native.spawnLibrary, companion]) await fs.writeFile(path.join(location, file), 'fixture');
    await fs.writeFile(path.join(location, binary + '.json'), JSON.stringify(native));
    await fs.writeFile(path.join(location, 'companion.json'), JSON.stringify(runtime));
    await verify();
    if (process.platform !== 'win32') {
      for (const file of [binary, native.spawnLibrary, companion]) await fs.chmod(path.join(location, file), 0o644);
      await restoreRevertRuntimeExecutableModes({ directory: root, platform: 'darwin', arch: 'arm64' });
      for (const file of [binary, native.spawnLibrary, companion]) {
        assert.equal((await fs.stat(path.join(location, file))).mode & 0o777, 0o755);
      }
      await fs.chmod(path.join(location, companion), 0o644);
    }
    await fs.writeFile(path.join(location, companion), 'changed');
    await assert.rejects(verify(), /companion artifact/);
    await assert.rejects(restoreRevertRuntimeExecutableModes({ directory: root, platform: 'darwin', arch: 'arm64' }), /companion artifact/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(location, companion))).mode & 0o777, 0o644);
    await fs.writeFile(path.join(location, companion), 'fixture');
    await fs.writeFile(path.join(location, 'companion.json'), JSON.stringify({ ...runtime, acceptance: false }));
    await assert.rejects(verify(), /companion artifact/);
    await fs.writeFile(path.join(location, 'companion.json'), JSON.stringify({ ...runtime, patchSha256: 'unreviewed' }));
    await assert.rejects(verify(), /companion artifact/);
    await fs.writeFile(path.join(location, 'companion.json'), JSON.stringify(runtime));
    await fs.writeFile(path.join(location, native.spawnLibrary), 'changed');
    await assert.rejects(verify(), /spawn library/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
