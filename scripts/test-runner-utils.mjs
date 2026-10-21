import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const testFilePattern = /(?:^|[./-])test\.[cm]?[jt]sx?$/;

export function isBunTestSource(source) {
  // Node runner tests may contain Bun imports inside generated fixture source.
  // Match Electron's declared Node-first dispatch before selecting Bun.
  return !/\bfrom\s*['"]node:test['"]/.test(source)
    && /\bfrom\s*['"]bun:test['"]/.test(source);
}

/**
 * Bun workers for one package run: the cores left to it by the outer pool
 * (DEVRYAN_TEST_CONCURRENCY units at a time), at least two.
 * DEVRYAN_TEST_WORKERS overrides it.
 */
export function bunTestWorkers(environment = process.env, cores = os.availableParallelism()) {
  const explicit = environment.DEVRYAN_TEST_WORKERS;
  if (explicit !== undefined && explicit !== '') {
    if (!/^[1-9]\d*$/.test(explicit)) throw new Error('DEVRYAN_TEST_WORKERS must be a positive integer');
    return Number(explicit);
  }
  const outer = Number(environment.DEVRYAN_TEST_CONCURRENCY) || Math.min(2, cores);
  return Math.max(2, Math.floor(cores / outer));
}

/**
 * `bun test` arguments for a package run: isolated parallel workers, and
 * randomized order when DEVRYAN_TEST_SEED is set (CI sets it and prints it;
 * reproduce a failure with the same seed).
 */
export function bunTestArgs(targets, environment = process.env) {
  const seed = environment.DEVRYAN_TEST_SEED;
  // Bun accepts 32-bit seeds; CI passes the workflow run number.
  if (seed !== undefined && seed !== '' && !(/^\d+$/.test(seed) && Number(seed) <= 0xffffffff)) throw new Error('DEVRYAN_TEST_SEED must be an integer from 0 to 4294967295');
  return ['test', `--parallel=${bunTestWorkers(environment)}`, ...(seed ? ['--randomize', `--seed=${seed}`] : []), ...targets];
}

export function discoverTestFiles(directory, rootDirectory, options = {}) {
  const pattern = options.pattern ?? testFilePattern;
  const ignoredDirectories = options.ignoredDirectories ?? new Set(['node_modules', 'dist']);
  const results = [];

  function walk(currentDirectory) {
    if (!existsSync(currentDirectory)) return;
    // Nested checkouts own their test inventory; the explicitly requested root still runs.
    if (currentDirectory !== directory && existsSync(path.join(currentDirectory, '.git'))) return;

    for (const entry of readdirSync(currentDirectory)) {
      if (entry === '.git' || ignoredDirectories.has(entry)) continue;

      const absolutePath = path.join(currentDirectory, entry);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      const relativePath = path.relative(rootDirectory, absolutePath).split(path.sep).join('/');
      if (pattern.test(relativePath)) results.push(relativePath);
    }
  }

  walk(directory);
  return results.sort();
}
