#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { discoverTestFiles } from './test-runner-utils.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function discoverScriptTestFiles(root = repositoryRoot) {
  return [
    ...discoverTestFiles(path.join(root, 'scripts'), root, {
      pattern: /(?:^|[./-])test\.[cm]?js$/,
    }),
    ...discoverTestFiles(path.join(root, '.opencode', 'plugins'), root, {
      pattern: /(?:^|[./-])test\.[cm]?js$/,
    }),
  ].sort();
}

export function runScriptTests(root = repositoryRoot) {
  const files = discoverScriptTestFiles(root);
  if (files.length === 0) {
    console.log('No repository script tests matched.');
    return 0;
  }

  console.log(`\n$ node --test ${files.join(' ')}`);
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runScriptTests());
}
