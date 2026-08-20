#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rebuild } from '@electron/rebuild';
import { resolveWorkspacePackageDirectory } from './native-module-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const electronDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronDir, '..', '..');
const require = createRequire(import.meta.url);

const electronPkg = require('electron/package.json');
const electronVersion = electronPkg.version;
const betterSqliteDir = resolveWorkspacePackageDirectory(repoRoot, 'packages/web', 'better-sqlite3');
const arch = process.env.ELECTRON_BUILDER_ARCH || process.arch;

console.log(`[electron] rebuilding native modules against Electron ${electronVersion}...`);

// Rebuild the Node PTY declared at the root. Dependencies declared only by a
// workspace package are rebuilt directly below so Bun's hoisting layout cannot
// make @electron/rebuild silently skip them.
await rebuild({
  buildPath: repoRoot,
  electronVersion,
  force: true,
  arch,
  onlyModules: ['node-pty'],
});

await rebuild({
  buildPath: betterSqliteDir,
  electronVersion,
  force: true,
  arch,
  onlyModules: ['better-sqlite3'],
});

console.log('[electron] native modules rebuilt successfully');
