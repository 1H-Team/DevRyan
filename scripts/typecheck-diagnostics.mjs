#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';

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
  heapLimitMiB: Math.round(getHeapStatistics().heap_size_limit / 1024 ** 2),
  hostMemoryMiB: Math.round(totalmem() / 1024 ** 2),
  nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS),
  incrementalCache: 'fresh',
}));

process.on('exit', (exitCode) => {
  console.log(JSON.stringify({ target, exitCode,
    elapsedMs: Math.round(performance.now() - start),
    maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  }));
  rmSync(cache, { recursive: true, force: true });
});

// Run the actual CLI in this Node process, so the reported heap and RSS belong
// to the compiler. TypeScript retains its own diagnostics and nonzero exit codes.
const compiler = require.resolve('typescript/lib/tsc.js');
process.argv = [process.execPath, compiler, ...args];
await import(pathToFileURL(compiler).href);
