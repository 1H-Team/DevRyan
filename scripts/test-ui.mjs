#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { discoverTestFiles, isIsolatedUiTestSource } from './test-runner-utils.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.join(repositoryRoot, 'packages/ui');
function requiresIsolatedProcess(relativePath, root = uiRoot) {
  const source = readFileSync(path.join(root, relativePath), 'utf8');
  return isIsolatedUiTestSource(source);
}

function runBunTest(files, root = uiRoot) {
  console.log(`\n$ bun test ${files.join(' ')}`);
  const result = spawnSync('bun', ['test', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

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

  // Files using mock.module or mutating global window state must run in isolated processes.
  // All other UI tests run in one Bun process to reduce spawn overhead.
  const isolatedFiles = [];
  const batchableFiles = [];

  for (const file of files) {
    if (requiresIsolatedProcess(file, root)) isolatedFiles.push(file);
    else batchableFiles.push(file);
  }

  for (const file of isolatedFiles) {
    const status = runBunTest([file], root);
    if (status !== 0) return status;
  }

  if (batchableFiles.length > 0) {
    return runBunTest(batchableFiles, root);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runUiTests({ explicitFiles: process.argv.slice(2) }));
}
