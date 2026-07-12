import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveCursorSdkSqliteDirectory,
  resolveWorkspacePackageDirectory,
} from './native-module-paths.mjs';

test('rebuilds the Cursor SDK sqlite3 binding for Electron', async () => {
  const source = await readFile(new URL('./rebuild-native.mjs', import.meta.url), 'utf8');

  assert.match(source, /resolveCursorSdkSqliteDirectory\(repoRoot\)/);
  assert.doesNotMatch(source, /cursor-sdk-runtime[^\n]*node_modules/s);
  assert.match(
    source,
    /rebuild\(\{[^}]*buildPath:\s*cursorSqliteDir[^}]*onlyModules:\s*\[['"]sqlite3['"]\]/s,
  );
  assert.match(
    source,
    /rebuild\(\{[^}]*buildPath:\s*betterSqliteDir[^}]*onlyModules:\s*\[['"]better-sqlite3['"]\]/s,
  );
});

test('resolves Cursor sqlite3 without a workspace-local node_modules link', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'devryan-electron-native-paths-'));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const cursorRuntimeDirectory = path.join(repoRoot, 'packages', 'cursor-sdk-runtime');
  const webDirectory = path.join(repoRoot, 'packages', 'web');
  const cursorSdkDirectory = path.join(repoRoot, 'node_modules', '@cursor', 'sdk');
  const betterSqliteDirectory = path.join(repoRoot, 'node_modules', 'better-sqlite3');
  const sqliteDirectory = path.join(repoRoot, 'node_modules', 'sqlite3');
  await mkdir(path.join(cursorSdkDirectory, 'dist', 'cjs'), { recursive: true });
  await mkdir(cursorRuntimeDirectory, { recursive: true });
  await mkdir(webDirectory, { recursive: true });
  await mkdir(betterSqliteDirectory, { recursive: true });
  await mkdir(sqliteDirectory, { recursive: true });
  await writeFile(path.join(cursorRuntimeDirectory, 'package.json'), '{"name":"@openchamber/cursor-sdk-runtime"}');
  await writeFile(path.join(webDirectory, 'package.json'), '{"name":"@openchamber/web"}');
  await writeFile(path.join(cursorSdkDirectory, 'package.json'), '{"name":"@cursor/sdk","main":"dist/cjs/index.js"}');
  await writeFile(path.join(cursorSdkDirectory, 'dist', 'cjs', 'index.js'), 'module.exports = {};');
  await writeFile(path.join(betterSqliteDirectory, 'package.json'), '{"name":"better-sqlite3"}');
  await writeFile(path.join(sqliteDirectory, 'package.json'), '{"name":"sqlite3"}');

  await assert.rejects(access(path.join(cursorRuntimeDirectory, 'node_modules')), { code: 'ENOENT' });
  assert.equal(resolveCursorSdkSqliteDirectory(repoRoot), await realpath(sqliteDirectory));
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
