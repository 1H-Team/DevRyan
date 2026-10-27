#!/usr/bin/env node
// Ad-hoc sign the dev Electron binary with a STABLE identifier so macOS TCC
// (Documents/Desktop/Downloads consent) persists across `npm install` and
// Electron upgrades. Without this, every `npx electron` run can be treated as
// a different TCC subject and re-prompt the user.
//
// Safe to run on every install — it's a no-op on non-darwin and idempotent.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..');
const STABLE_IDENTIFIER = 'dev.devryan.desktop';

function exit(msg, code = 0) {
  if (msg) console.log(`[sign-dev-electron] ${msg}`);
  process.exit(code);
}

if (process.platform !== 'darwin') exit('skipped (not macOS)');

// Electron 42+ no longer downloads its binary in a postinstall script; the
// package downloads it the first time its path is resolved. Resolve it here so
// the binary exists before signing, as it did before, and resolve from this
// package so a hoisted or isolated install is found. A failed download leaves
// the install usable: the first `electron` run downloads it again.
let electronAppPath;
try {
  const electronExecutable = createRequire(path.join(electronDir, 'package.json'))('electron');
  electronAppPath = path.resolve(path.dirname(electronExecutable), '..', '..');
} catch (error) {
  exit(`skipped (Electron binary unavailable: ${error instanceof Error ? error.message : String(error)})`);
}

if (path.basename(electronAppPath) !== 'Electron.app' || !existsSync(electronAppPath)) {
  exit(`skipped (no Electron.app at ${electronAppPath})`);
}

console.log(`[sign-dev-electron] Signing ${electronAppPath} with identifier ${STABLE_IDENTIFIER}`);
const result = spawnSync(
  'codesign',
  [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--identifier',
    STABLE_IDENTIFIER,
    electronAppPath,
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.warn(`[sign-dev-electron] codesign failed to start: ${result.error.message}`);
  exit('continuing despite failure', 0);
}

if (result.status !== 0) {
  console.warn(`[sign-dev-electron] codesign exited ${result.status} — TCC prompts may repeat in dev`);
  exit('continuing despite failure', 0);
}

exit('done');
