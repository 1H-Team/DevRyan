import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getRequiredPackagedNativeArtifacts,
  resolvePackagedMacArch,
  verifyPackagedNativeArtifacts,
} from '../scripts/packaged-native-modules.mjs';

const createApp = async (t, arch = 'arm64') => {
  const root = await mkdtemp(path.join(tmpdir(), 'devryan-packaged-native-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const appPath = path.join(root, 'DevRyan.app');
  const artifacts = getRequiredPackagedNativeArtifacts(appPath, arch);
  for (const artifact of artifacts) {
    await mkdir(path.dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, artifact.name);
    if (artifact.executable) {
      await chmod(artifact.path, 0o755);
    }
  }

  return { appPath, artifacts };
};

test('verifies every native artifact required by the packaged Electron runtime', async (t) => {
  const { appPath, artifacts } = await createApp(t);

  assert.deepEqual(
    artifacts.map((artifact) => artifact.name),
    [
      'better-sqlite3',
      'node-pty',
      'Cursor ripgrep',
      'Cursor sandbox',
      'Cursor tree-sitter',
      'Cursor tree-sitter-bash',
    ],
  );
  assert.doesNotThrow(() => verifyPackagedNativeArtifacts(appPath, 'arm64'));
});

test('maps electron-builder architecture enum values to package architecture names', () => {
  assert.equal(resolvePackagedMacArch(1), 'x64');
  assert.equal(resolvePackagedMacArch(3), 'arm64');
  assert.throws(() => resolvePackagedMacArch(4), /Unsupported packaged macOS architecture/);
});

test('reports every missing packaged native artifact together', async (t) => {
  const { appPath, artifacts } = await createApp(t, 'x64');
  await rm(artifacts[0].path);
  await rm(artifacts[4].path);

  assert.throws(
    () => verifyPackagedNativeArtifacts(appPath, 'x64'),
    (error) => {
      assert.match(error.message, /better-sqlite3/);
      assert.match(error.message, /Cursor tree-sitter/);
      assert.match(error.message, /better_sqlite3\.node/);
      assert.match(error.message, /tree-sitter[\\/]binding\.node/);
      return true;
    },
  );
});

test('rejects a packaged Cursor ripgrep binary without execute permission', async (t) => {
  const { appPath, artifacts } = await createApp(t);
  const ripgrep = artifacts.find((artifact) => artifact.name === 'Cursor ripgrep');
  await chmod(ripgrep.path, 0o644);

  assert.throws(
    () => verifyPackagedNativeArtifacts(appPath, 'arm64'),
    /Cursor ripgrep.*not executable/s,
  );
});

test('rejects a packaged Cursor sandbox binary without execute permission', async (t) => {
  const { appPath, artifacts } = await createApp(t);
  const sandbox = artifacts.find((artifact) => artifact.name === 'Cursor sandbox');
  await chmod(sandbox.path, 0o644);

  assert.throws(
    () => verifyPackagedNativeArtifacts(appPath, 'arm64'),
    /Cursor sandbox.*not executable/s,
  );
});
