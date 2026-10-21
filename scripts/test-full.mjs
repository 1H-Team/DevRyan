#!/usr/bin/env node
// `bun run test:full`: every deterministic suite, as independent processes in
// one bounded pool (scripts/test-pool.mjs). FULL_TEST_SUITES is the suite
// inventory; the long suites are split into units that run at the same time:
// one process per script test file (see test-scripts.mjs), Vitest shards of
// the web suite, and the harness suite's own Bun file workers.
// DEVRYAN_TEST_CONCURRENCY bounds the pool (default: at most two units).
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { recordTestTimings, runTestUnits, summarizeTestUnits, testConcurrency } from './test-pool.mjs';
import { bunTestWorkers } from './test-runner-utils.mjs';
import { planScriptTests, prepareScriptTestEnvironment } from './test-scripts.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const packageSuite = (key, directory, script = 'test') => ({ key, name: `${path.basename(directory)}${script === 'test' ? '' : `:${script}`}`,
  command: 'bun', args: ['run', '--cwd', directory, script] });

/**
 * The suite inventory, in the order the former `&&` chain ran it. `key` is the
 * scripts/validate.mjs test key that selects the suite for a changed package.
 */
export const FULL_TEST_SUITES = Object.freeze([
  { key: 'scripts', name: 'scripts', command: 'bun', args: ['run', 'test:scripts'] },
  { key: 'visualFixture', name: 'visual-fixture', command: 'bun', args: ['run', 'test:visual-fixture'] },
  ...[['bots', 'bots-runtime'], ['botSupervisor', 'bot-supervisor'], ['botEngineProxy', 'bot-engine-proxy'], ['botEgress', 'bot-egress'],
    ['botComputer', 'bot-computer'], ['botIndexer', 'bot-indexer'], ['botDb', 'bot-db'], ['shared', 'shared-runtime'], ['harness', 'harness-runtime'],
    ['orchestration', 'orchestration-runtime'], ['cursor', 'cursor-sdk-runtime'], ['agentsCore', 'agents-core']].map(([key, name]) => packageSuite(key, `packages/${name}`)),
  packageSuite('desktop', 'packages/desktop', 'test:managed-orchestration'),
  packageSuite('electron', 'packages/electron'),
  packageSuite('ui', 'packages/ui'),
  packageSuite('web', 'packages/web'),
].map(Object.freeze));

/** `bun run --cwd packages/x test` lines of FULL_TEST_SUITES, for inventory checks. */
export const FULL_TEST_COMMANDS = Object.freeze(FULL_TEST_SUITES.map((suite) => [suite.command, ...suite.args].join(' ')));

/**
 * Vitest projects of `packages/web` (vitest.config.ts): the file-parallel
 * server suite, and the native runtime-host suite with its own small worker cap.
 */
export const WEB_VITEST_PROJECTS = Object.freeze(['web', 'web-runtime-host']);
/**
 * Bun file workers for the harness suite (same inventory as plain `bun test`).
 * The ledger suites split by concern (session-mutations.*.test.js), so several
 * workers share the long files; Bun starts the slowest recorded files first.
 */
export const HARNESS_WORKERS = 4;

/**
 * Expand the inventory into pool units. Every suite keeps its own runner and
 * command; only scripts, web and harness split, and each split runs the same
 * files as the unsplit command.
 */
export function planFullTests(root = repositoryRoot, { scriptEnvironment, suites } = {}) {
  const selected = suites ? new Set(suites) : null;
  const unknown = selected ? [...selected].filter((key) => !FULL_TEST_SUITES.some((suite) => suite.key === key)) : [];
  if (unknown.length) throw new Error(`Unknown test suite: ${unknown.join(', ')}`);
  const units = [];
  for (const { key, ...suite } of FULL_TEST_SUITES) {
    if (selected && !selected.has(key)) continue;
    const add = (unit) => units.push({ ...unit, suite: key });
    if (key === 'scripts') {
      planScriptTests(root).forEach((unit) => add({ ...unit, env: scriptEnvironment }));
    } else if (key === 'web') {
      for (const project of WEB_VITEST_PROJECTS) {
        add({ name: `web:vitest ${project}`, command: 'bun',
          args: ['run', '--cwd', 'packages/web', 'test:vitest', `--project=${project}`, ...(project === 'web' ? [`--maxWorkers=${bunTestWorkers()}`] : [])] });
      }
      add({ name: 'web:native', command: 'bun', args: ['run', '--cwd', 'packages/web', 'test:native'] });
    } else if (key === 'harness') {
      add({ name: 'harness-runtime', command: 'bun', args: ['test', `--parallel=${HARNESS_WORKERS}`], cwd: path.join(root, 'packages/harness-runtime') });
    } else {
      add(suite);
    }
  }
  // Longest first so the pool never ends on one long unit started late
  // (local baseline 2026-10-21). Start the port-owning stream early so its
  // OAuth peers do not become a serial tail.
  const order = ['web:vitest web-runtime-host', 'scripts:scripts/opencode-v2-native/native-stream-continuation.graph.test.ts',
    'harness-runtime', 'scripts:node', 'web:vitest'];
  const rank = (unit) => { const index = order.findIndex((prefix) => unit.name.startsWith(prefix)); return index === -1 ? order.length : index; };
  return units.map((unit, index) => ({ unit, index })).sort((left, right) => rank(left.unit) - rank(right.unit) || left.index - right.index).map(({ unit }) => unit);
}

export async function runFullTests(root = repositoryRoot, { concurrency = testConcurrency(), suites } = {}) {
  const { env, cleanup } = prepareScriptTestEnvironment(root);
  try {
    const units = planFullTests(root, { scriptEnvironment: env, suites }).map((unit) => ({ ...unit, env: unit.env ?? env, cwd: unit.cwd ?? root }));
    const outcome = await runTestUnits(units, { concurrency, label: 'test:full', cwd: root, cleanup });
    summarizeTestUnits(outcome, { label: 'test:full', limit: 20 });
    recordTestTimings(outcome, units, { label: 'test:full' });
    return outcome.passed ? 0 : 1;
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `--suite=web,ui` runs only those suites' units (what `bun run validate` selects).
  const suites = process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--suite=')) throw new Error(`Unknown argument: ${arg} (use --suite=<key,...>)`);
    return arg.slice('--suite='.length).split(',').filter(Boolean);
  }).flat();
  process.exitCode = await runFullTests(repositoryRoot, { suites: suites.length ? suites : undefined });
}
