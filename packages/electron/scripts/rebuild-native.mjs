#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rebuild } from '@electron/rebuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const electronDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronDir, '..', '..');
const require = createRequire(import.meta.url);

const electronPkg = require('electron/package.json');
const electronVersion = electronPkg.version;
const cursorSdkPackagePath = fs.realpathSync(
  path.resolve(
    repoRoot,
    'packages',
    'cursor-sdk-runtime',
    'node_modules',
    '@cursor',
    'sdk',
    'package.json',
  ),
);
const cursorSdkRequire = createRequire(cursorSdkPackagePath);
const cursorSqliteDir = path.dirname(cursorSdkRequire.resolve('sqlite3/package.json'));
const arch = process.env.ELECTRON_BUILDER_ARCH || process.arch;

console.log(`[electron] rebuilding native modules against Electron ${electronVersion}...`);

// Rebuild against the hoisted root node_modules (bun workspace layout).
// force=true re-links regardless of cached state; prebuild-install lookup is
// bypassed by @electron/rebuild in favor of direct node-gyp builds.
await rebuild({
  buildPath: repoRoot,
  electronVersion,
  force: true,
  arch,
  onlyModules: ['better-sqlite3', 'node-pty', 'bun-pty'],
});

// Bun stores transitive dependencies in its isolated .bun tree, outside the
// root node_modules scan used by @electron/rebuild. Target Cursor SDK's
// sqlite3 package directly so its native binding is always shipped.
await rebuild({
  buildPath: cursorSqliteDir,
  electronVersion,
  force: true,
  arch,
  onlyModules: ['sqlite3'],
});

console.log('[electron] native modules rebuilt successfully');
