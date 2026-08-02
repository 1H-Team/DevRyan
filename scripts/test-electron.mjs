#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { discoverTestFiles } from './test-runner-utils.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronRoot = path.join(repositoryRoot, 'packages/electron');

export function discoverElectronTestFiles(root = electronRoot) {
  return discoverTestFiles(root, root, {
    pattern: /(?:^|[./-])test\.[cm]?[jt]sx?$/,
    ignoredDirectories: new Set(['node_modules', 'dist', 'dist-bundle', 'resources']),
  });
}

export function runElectronTests(root = electronRoot) {
  const files = discoverElectronTestFiles(root);
  if (files.length === 0) {
    console.log('No Electron test files matched.');
    return 0;
  }

  console.log(`\n$ bun test ${files.join(' ')}`);
  const result = spawnSync('bun', ['test', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runElectronTests());
}
