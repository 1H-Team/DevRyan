#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';

import { discoverTestFiles, isBunTestSource } from './test-runner-utils.mjs';
import { runTestUnits, summarizeTestUnits, testConcurrency } from './test-pool.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Exclusive pool resource shared by native graph files (see planScriptTests). */
export const NATIVE_GRAPH_RESOURCE = 'native-graph';

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

/**
 * The script suite as independent processes: one `node --test` run for the
 * Node files, and one `bun test` process per Bun file, because native graph
 * fixtures must not share Bun's resolver and loader state. Graph files are
 * listed first so a bounded pool starts the longest processes early.
 */
export function planScriptTests(root = repositoryRoot, environment = process.env) {
  const bun = [], node = [], heavyNative = new Set();
  for (const file of discoverScriptTestFiles(root)) {
    const source = readFileSync(path.join(root, file), 'utf8');
    // Native graph files build and spawn the pinned runtime (CPU-heavy, and the
    // shared fixture's real OAuth flow binds localhost:1455): one at a time.
    if (/\.graph\.test\.[cm]?[jt]s$/.test(file) || source.includes('controller-integrations.graph-fixture.mjs')) heavyNative.add(file);
    if (isBunTestSource(source)) bun.push(file);
    else node.push(file);
  }
  // The Node batch runs beside other package suites in the outer pool.
  // Each test gets a deadline and the file exits once its tests settle, so a
  // never-resolving await or a leaked handle fails that test instead of hanging.
  const args = ['--test', '--test-concurrency=1', '--test-timeout=300000', '--test-force-exit'];
  const concurrency = environment.DEVRYAN_SCRIPT_TEST_CONCURRENCY;
  if (concurrency !== undefined) {
    if (!/^[1-9]\d*$/.test(concurrency) || !Number.isSafeInteger(Number(concurrency))) {
      throw new Error('DEVRYAN_SCRIPT_TEST_CONCURRENCY must be a positive integer');
    }
    args[1] = `--test-concurrency=${concurrency}`;
  }
  const graphFirst = [...bun].sort((left, right) => Number(right.includes('.graph.')) - Number(left.includes('.graph.')) || left.localeCompare(right));
  return [
    ...(node.length ? [{ name: 'scripts:node', command: process.execPath, args: [...args, ...node], cwd: root }] : []),
    ...graphFirst.map((file) => ({ name: `scripts:${file}`, command: 'bun', args: ['test', `./${file}`], cwd: root,
      ...(heavyNative.has(file) ? { resource: NATIVE_GRAPH_RESOURCE } : {}) })),
  ];
}

/**
 * Fixtures that must stay inside the repository create their run dirs under
 * these .cache families and assume the family exists; a fresh checkout or a
 * pruned .cache has none. QA fixtures require their parent to be private.
 * Returns the environment with a private per-run TMPDIR (inside any
 * caller-chosen TMPDIR) and a cleanup that removes it, so suite leaks cannot
 * accumulate.
 */
export function prepareScriptTestEnvironment(root = repositoryRoot, environment = process.env) {
  for (const family of ['v2-validation', 'perf', 'qa']) mkdirSync(path.join(root, '.cache', family), { recursive: true, mode: 0o700 });
  chmodSync(path.join(root, '.cache', 'qa'), 0o700);
  const parent = environment.TMPDIR || os.tmpdir();
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'devryan-script-tests-'));
  const env = { ...environment, TMPDIR: temporary };
  delete env.DEVRYAN_MUTATION_TEST_SHARD;
  delete env.DEVRYAN_STREAM_TEST_SHARD;
  return { env, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
}

export async function runScriptTests(root = repositoryRoot) {
  const units = planScriptTests(root);
  if (units.length === 0) {
    console.log('No repository script tests matched.');
    return 0;
  }
  const { env, cleanup } = prepareScriptTestEnvironment(root);
  try {
    const outcome = await runTestUnits(units.map((unit) => ({ ...unit, env })), { concurrency: testConcurrency(), label: 'test:scripts', cwd: root, cleanup });
    summarizeTestUnits(outcome, { label: 'test:scripts' });
    return outcome.passed ? 0 : 1;
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runScriptTests();
}
