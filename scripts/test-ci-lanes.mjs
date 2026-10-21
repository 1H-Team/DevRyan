import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTestFiles } from './test-runner-utils.mjs';
import { planFullTests } from './test-full.mjs';

export const CI_LANES = Object.freeze(['portable-1', 'portable-2', 'portable-3', 'portable-4', 'native-1', 'native-2']);
export const MAC_WEB_TESTS = [
  'server/lib/opencode/native-readonly-shell.test.js',
  'server/default-config/plugins/devryan-browser.test.mjs',
  ...['native-artifacts', 'native-process', 'native-setup-seed', 'runtime-bundle-lifecycle']
    .map(name => `server/lib/opencode/runtime-host/${name}.test.js`),
  'server/lib/opencode/runtime-host/runtime-bundle.test.js',
];
const nativeHarness = new Set(['session-mutations-inputs.test.js', 'session-execution-local.test.js', 'session-execution.test.js']);
export function requiresMac(unit) {
  return ['electron', 'agentsCore'].includes(unit.suite) || unit.name === 'web:native' || unit.name === 'web:macos'
    || unit.args.some(arg => /scripts\/opencode-v2-native\/|runtime\/reviewed-inputs\/|verify-revert-runtime-artifacts.test.mjs|scripts\/dev.test.mjs|scripts\/agent-evals\/client.test.mjs/.test(arg))
    || unit.suite === 'harness' && unit.args.some(arg => nativeHarness.has(path.basename(arg)));
}

/** Expand opaque batches before assignment, retaining their original test runner. */
export function ciTestInventory(root, options = {}) {
  return planFullTests(root, options).flatMap(unit => {
    if (unit.name === 'scripts:node') return unit.args.filter(arg => /test\.[cm]?js$/.test(arg))
      .map(file => ({ ...unit, name: `scripts:${file}`, args: ['--test', file] }));
    if (unit.suite === 'harness') return discoverTestFiles(path.join(root, 'packages/harness-runtime'), root)
      .map(file => ({ ...unit, cwd: root, name: `harness:${file}`, args: ['test', `./${file}`] }));
    if (unit.name.endsWith('/native-stream-continuation.graph.test.ts')) return Array.from({ length: 2 }, (_, index) => ({ ...unit,
      name: `${unit.name}:${index + 1}/2`, env: { ...(unit.env ?? options.scriptEnvironment ?? process.env), DEVRYAN_STREAM_TEST_SHARD: `${index + 1}/2` } }));
    if (unit.name.startsWith('web:vitest')) {
      const excluded = { ...unit, args: [...unit.args, ...MAC_WEB_TESTS.flatMap(file => ['--exclude', file])] };
      // The runtime-host project is the longest unit; two Vitest shards balance it across lanes.
      return unit.name === 'web:vitest web-runtime-host' ? Array.from({ length: 2 }, (_, index) => ({ ...excluded,
        name: `${unit.name} ${index + 1}/2`, args: [...excluded.args, `--shard=${index + 1}/2`] })) : [excluded];
    }
    if (unit.name === 'web:native') return [unit, { suite: 'web', name: 'web:macos', command: 'bun',
      args: ['run', '--cwd', 'packages/web', 'test:vitest', ...MAC_WEB_TESTS] }];
    return [unit];
  });
}

const TIMINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-unit-timings.json');

/** Recorded unit durations (ms) from test-unit-timings.json; refreshed from CI artifacts. */
export function readUnitTimings(file = TIMINGS_FILE) {
  return JSON.parse(readFileSync(file, 'utf8')).units;
}

/**
 * Pack units onto lanes longest first, each onto the least-loaded lane.
 * Units without a recording cost the median recorded duration. Ties break by
 * name and lane order, so the assignment is deterministic.
 */
export function packLanes(units, lanes, timings) {
  const recorded = Object.values(timings).sort((left, right) => left - right);
  const median = recorded.length ? recorded[Math.floor(recorded.length / 2)] : 1;
  const cost = unit => timings[unit.name] ?? median;
  const loads = lanes.map(() => 0), assignments = Object.fromEntries(lanes.map(lane => [lane, []]));
  const ordered = [...units].sort((left, right) => cost(right) - cost(left) || left.name.localeCompare(right.name));
  for (const unit of ordered) {
    const index = loads.indexOf(Math.min(...loads));
    loads[index] += cost(unit);
    assignments[lanes[index]].push(unit);
  }
  return assignments;
}

export function planCITests(root, lane, options = {}) {
  if (!CI_LANES.includes(lane)) throw new Error(`Unknown CI test lane: ${lane}`);
  const timings = options.timings ?? readUnitTimings();
  const inventory = ciTestInventory(root, options);
  const pack = (prefix, macOnly) => packLanes(inventory.filter(unit => requiresMac(unit) === macOnly), CI_LANES.filter(key => key.startsWith(prefix)), timings);
  return { ...pack('portable', false), ...pack('native', true) }[lane];
}
