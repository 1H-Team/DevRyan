#!/usr/bin/env node
// `packages/ui` tests: one `bun test --parallel` run. Bun gives every file its
// own global and module registry in a worker, so `mock.module` and window or
// storage replacements cannot leak between files, without a process per file.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { bunTestArgs, discoverTestFiles } from './test-runner-utils.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.join(repositoryRoot, 'packages/ui');

export function discoverUiTestFiles(root = uiRoot) {
  return discoverTestFiles(path.join(root, 'src'), root);
}

export function runUiTests({ root = uiRoot, explicitFiles = [] } = {}) {
  const files = explicitFiles.length > 0
    ? explicitFiles.map((file) => file.split(path.sep).join('/'))
    : discoverUiTestFiles(root);
  if (files.length === 0) {
    console.log('No UI test files matched.');
    return 0;
  }
  const args = bunTestArgs(explicitFiles.length > 0 ? files.map((file) => `./${file}`) : ['src']);
  console.log(`\n$ bun ${args.join(' ')}`);
  return spawnSync('bun', args, { cwd: root, stdio: 'inherit', env: process.env }).status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runUiTests({ explicitFiles: process.argv.slice(2) }));
}
