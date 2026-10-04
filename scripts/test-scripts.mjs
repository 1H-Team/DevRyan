#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { discoverTestFiles, isBunTestSource } from './test-runner-utils.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function discoverScriptTestFiles(root = repositoryRoot) {
  return [
    ...discoverTestFiles(path.join(root, 'scripts'), root),
    ...discoverTestFiles(path.join(root, 'packages/web/runtime/reviewed-inputs'), root),
    ...discoverTestFiles(path.join(root, '.opencode', 'plugins'), root, {
      pattern: /(?:^|[./-])test\.[cm]?js$/,
    }),
    ...discoverTestFiles(path.join(root, '.opencode', 'agents'), root, {
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

  const bun = [], node = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');
    if (isBunTestSource(source)) bun.push(file);
    else node.push(file);
  }
  const args = ['--test'];
  const concurrency = process.env.DEVRYAN_SCRIPT_TEST_CONCURRENCY;
  if (concurrency !== undefined) {
    if (!/^[1-9]\d*$/.test(concurrency) || !Number.isSafeInteger(Number(concurrency))) {
      throw new Error('DEVRYAN_SCRIPT_TEST_CONCURRENCY must be a positive integer');
    }
    args.push(`--test-concurrency=${concurrency}`);
  }
  const commands = [
    ...(node.length ? [[process.execPath, [...args, ...node]]] : []),
    ...(bun.length ? [['bun', ['test', ...bun]]] : []),
  ];
  for (const [command, arguments_] of commands) {
    console.log(`\n$ ${command} ${arguments_.join(' ')}`);
    const result = spawnSync(command, arguments_, { cwd: root, stdio: 'inherit', env: process.env });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runScriptTests());
}
