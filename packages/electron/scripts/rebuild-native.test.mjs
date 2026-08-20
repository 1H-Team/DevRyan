import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveWorkspacePackageDirectory } from './native-module-paths.mjs';

test('rebuilds only declared Electron ABI dependencies', async () => {
  const source = await readFile(new URL('./rebuild-native.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /rebuild\(\{[^}]*buildPath:\s*betterSqliteDir[^}]*onlyModules:\s*\[['"]better-sqlite3['"]\]/s,
  );
  assert.match(source, /onlyModules:\s*\[['"]node-pty['"]\]/);
  assert.doesNotMatch(source, /resolveCursorSdkSqliteDirectory|onlyModules:\s*\[['"]sqlite3['"]\]/);
});

test('resolves a workspace dependency without a workspace-local node_modules link', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'devryan-electron-native-paths-'));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const webDirectory = path.join(repoRoot, 'packages', 'web');
  const betterSqliteDirectory = path.join(repoRoot, 'node_modules', 'better-sqlite3');
  await mkdir(webDirectory, { recursive: true });
  await mkdir(betterSqliteDirectory, { recursive: true });
  await writeFile(path.join(webDirectory, 'package.json'), '{"name":"@openchamber/web"}');
  await writeFile(path.join(betterSqliteDirectory, 'package.json'), '{"name":"better-sqlite3"}');

  assert.equal(
    resolveWorkspacePackageDirectory(repoRoot, 'packages/web', 'better-sqlite3'),
    await realpath(betterSqliteDirectory),
  );
});

test('pins the Electron runtime version used by electron-builder', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const electronVersion = packageJson.devDependencies?.electron;

  assert.match(electronVersion, /^\d+\.\d+\.\d+$/);
});
