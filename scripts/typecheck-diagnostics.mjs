#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (process.argv.length !== 3 || !['ui', 'web'].includes(target)) {
  console.error('Usage: bun run type-check:diagnose <ui|web>');
  process.exit(2);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const cacheRoot = path.join(root, '.cache', 'typecheck');
mkdirSync(cacheRoot, { recursive: true });
// A fresh cache measures a full check without disturbing normal incremental runs.
const cache = mkdtempSync(path.join(cacheRoot, 'diagnose-'));
const args = ['--noEmit', '--project', path.join(root, 'packages', target, 'tsconfig.json'),
  '--incremental', '--tsBuildInfoFile', path.join(cache, 'check.tsbuildinfo'),
  '--extendedDiagnostics', '--pretty', 'false'];
const start = performance.now();

// Deliberately do not print NODE_OPTIONS or the environment: they can contain secrets.
console.log(JSON.stringify({
  target,
  node: process.version,
  typescript: require('typescript/package.json').version,
  platform: process.platform,
  arch: process.arch,
  hostMemoryMiB: Math.round(totalmem() / 1024 ** 2),
  nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS),
  incrementalCache: 'fresh',
}));

// TypeScript 7 is a native compiler: its --extendedDiagnostics report its own
// memory, and the child's exit code keeps type errors nonzero.
const compiler = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
let exitCode = 1;
try {
  const result = spawnSync(process.execPath, [compiler, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} finally {
  console.log(JSON.stringify({ target, exitCode, elapsedMs: Math.round(performance.now() - start) }));
  rmSync(cache, { recursive: true, force: true });
}
process.exitCode = exitCode;
