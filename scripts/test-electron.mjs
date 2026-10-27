#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

import { bunTestArgs, bunTestWorkers, discoverTestFiles } from './test-runner-utils.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronRoot = path.join(repositoryRoot, 'packages/electron');

export function discoverElectronTestFiles(root = electronRoot) {
  return discoverTestFiles(root, root, {
    pattern: /(?:^|[./-])test\.[cm]?[jt]sx?$/,
    ignoredDirectories: new Set(['node_modules', 'dist', 'dist-bundle', 'resources']),
  });
}

export function planElectronTests(root = electronRoot, environment = process.env) {
  const node = [], bun = [], optional = [];
  for (const file of discoverElectronTestFiles(root)) {
    if (file === 'tests/desktop-update-install-native.test.mjs' && environment.DEVRYAN_RUN_DMG_INSTALLER_NATIVE_TESTS !== '1') {
      optional.push(file);
      continue;
    }
    const source = readFileSync(path.join(root, file), 'utf8');
    if (/\bfrom\s*['"]node:test['"]/.test(source)) node.push(file);
    else if (/\bfrom\s*['"]bun:test['"]/.test(source)) bun.push(file);
    else throw new Error(`No supported test framework declared in ${file} (use node:test or bun:test)`);
  }
  return { node, bun, optional };
}

export function runElectronTests(root = electronRoot) {
  const plan = planElectronTests(root);
  if (plan.optional.includes('tests/desktop-update-install-native.test.mjs')) {
    console.log('Native DMG installer acceptance is a separate opt-in gate (DEVRYAN_RUN_DMG_INSTALLER_NATIVE_TESTS=1; macOS required).');
  }
  // Node-hosted main-process code runs on node:test; Bun files run isolated per file.
  const commands = [
    ...(plan.node.length ? [[process.execPath, ['--test', `--test-concurrency=${Math.min(bunTestWorkers(), os.availableParallelism())}`, ...plan.node]]] : []),
    ...(plan.bun.length ? [['bun', bunTestArgs(plan.bun.map((file) => `./${file}`))]] : []),
  ];
  if (commands.length === 0) {
    console.log('No Electron test files matched.');
    return 0;
  }

  // Every tier runs; the result fails if any tier failed.
  let status = 0;
  for (const [command, args] of commands) {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
    if (result.status !== 0) status = result.status ?? 1;
  }
  return status;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runElectronTests());
}
