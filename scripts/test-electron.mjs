#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { discoverTestFiles, isIsolatedUiTestSource } from './test-runner-utils.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronRoot = path.join(repositoryRoot, 'packages/electron');
const require = createRequire(import.meta.url);

export function discoverElectronTestFiles(root = electronRoot) {
  return discoverTestFiles(root, root, {
    pattern: /(?:^|[./-])test\.[cm]?[jt]sx?$/,
    ignoredDirectories: new Set(['node_modules', 'dist', 'dist-bundle', 'resources']),
  });
}

export function planElectronTests(root = electronRoot, environment = process.env) {
  const node = [], bun = [], isolatedBun = [], vitest = [], optional = [];
  for (const file of discoverElectronTestFiles(root)) {
    if (file === 'tests/bot-catalog.docker.test.mjs' && environment.DEVRYAN_RUN_BOT_DB_DOCKER_TESTS !== '1') {
      optional.push(file);
      continue;
    }
    const source = readFileSync(path.join(root, file), 'utf8');
    if (/\bfrom\s*['"]node:test['"]/.test(source)) node.push(file);
    else if (/\bfrom\s*['"]vitest['"]/.test(source)) vitest.push(file);
    else if (/\bfrom\s*['"]bun:test['"]/.test(source)) {
      (isIsolatedUiTestSource(source) ? isolatedBun : bun).push(file);
    } else throw new Error(`No supported test framework declared in ${file}`);
  }
  return { node, bun, isolatedBun, vitest, optional };
}

export function runElectronTests(root = electronRoot) {
  const plan = planElectronTests(root);
  if (plan.optional.length > 0) {
    console.log('Docker acceptance is a separate opt-in gate (DEVRYAN_RUN_BOT_DB_DOCKER_TESTS=1).');
  }
  const vitestEntry = plan.vitest.length
    ? path.join(path.dirname(require.resolve('vitest/package.json', { paths: [root, electronRoot] })), 'vitest.mjs')
    : null;
  const commands = [
    ...(plan.node.length ? [[process.execPath, ['--test', '--test-concurrency=1', ...plan.node]]] : []),
    ...plan.isolatedBun.map((file) => ['bun', ['test', file]]),
    ...(plan.bun.length ? [['bun', ['test', ...plan.bun]]] : []),
    ...(vitestEntry ? [[process.execPath, [vitestEntry, 'run', '--no-file-parallelism', '--maxWorkers=1', ...plan.vitest]]] : []),
  ];
  if (commands.length === 0) {
    console.log('No Electron test files matched.');
    return 0;
  }

  for (const [command, args] of commands) {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runElectronTests());
}
