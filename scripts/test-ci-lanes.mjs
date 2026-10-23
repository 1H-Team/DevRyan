import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTestFiles } from './test-runner-utils.mjs';
import { planFullTests } from './test-full.mjs';

export const CI_LANES = Object.freeze(['portable-1', 'portable-2', 'native-1', 'native-2', 'native-3']);
/** Tests of the built assets: they run in the CI build job, right after the build, not in a lane. */
export const BUILD_JOB_TESTS = Object.freeze(['scripts/built-web-assets.test.mjs']);
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
    if (unit.name === 'scripts:node') return unit.args.filter(arg => /test\.[cm]?js$/.test(arg) && !BUILD_JOB_TESTS.includes(arg))
      .map(file => ({ ...unit, name: `scripts:${file}`, args: ['--test', file] }));
    if (unit.suite === 'harness') return discoverTestFiles(path.join(root, 'packages/harness-runtime'), root)
      .map(file => ({ ...unit, cwd: root, name: `harness:${file}`, args: ['test', `./${file}`] }));
    if (unit.name.endsWith('/native-stream-continuation.graph.test.ts')) return Array.from({ length: 2 }, (_, index) => ({ ...unit,
      name: `${unit.name}:${index + 1}/2`, env: { ...(unit.env ?? options.scriptEnvironment ?? process.env), DEVRYAN_STREAM_TEST_SHARD: `${index + 1}/2` } }));
    if (unit.name.startsWith('web:vitest')) {
      // Vitest ignores CLI --exclude inside projects; vitest.config.ts reads this list.
      const excluded = { ...unit, env: { ...(unit.env ?? options.scriptEnvironment ?? process.env), DEVRYAN_VITEST_EXCLUDE: MAC_WEB_TESTS.join(',') } };
      // The runtime-host project is the longest unit; two Vitest shards balance it across lanes.
      return unit.name === 'web:vitest web-runtime-host' ? Array.from({ length: 2 }, (_, index) => ({ ...excluded,
        name: `${unit.name} ${index + 1}/2`, args: [...excluded.args, `--shard=${index + 1}/2`] })) : [excluded];
    }
    if (unit.name === 'web:native') return [unit, { suite: 'web', name: 'web:macos', command: 'bun',
      args: ['run', '--cwd', 'packages/web', 'test:vitest', ...MAC_WEB_TESTS] }];
    return [unit];
  });
}

/**
 * Local runs (`test:full`, `validate`) keep the planFullTests inventory but
 * split its two longest serial units and weight the units that start their
 * own workers, so the weighted pool fills the machine without oversubscribing
 * it. CI lanes use ciTestInventory instead.
 */
export const LOCAL_SCRIPT_NODE_SHARDS = 3;
const HEAVY_LOCAL_UNITS = new Set(['web:vitest web', 'harness-runtime']);
export function localTestUnits(units, { timings = readUnitTimings(), scriptShards = LOCAL_SCRIPT_NODE_SHARDS } = {}) {
  return units.flatMap((unit) => {
    if (unit.name === 'scripts:node') {
      const flags = unit.args.filter((arg) => arg.startsWith('--')), files = unit.args.filter((arg) => !arg.startsWith('--'));
      const shards = Math.max(1, Math.min(scriptShards, files.length));
      if (shards === 1) return [unit];
      const lanes = Array.from({ length: shards }, (_, index) => `${index + 1}/${shards}`);
      const packed = packLanes(files.map((file) => ({ name: `scripts:${file}`, file })), lanes, timings);
      return lanes.filter((lane) => packed[lane].length).map((lane) => ({ ...unit, name: `scripts:node ${lane}`,
        args: [...flags, ...packed[lane].map((entry) => entry.file).sort()] }));
    }
    if (unit.name === 'web:vitest web-runtime-host') return Array.from({ length: 2 }, (_, index) => ({ ...unit,
      name: `${unit.name} ${index + 1}/2`, args: [...unit.args, `--shard=${index + 1}/2`] }));
    if (!HEAVY_LOCAL_UNITS.has(unit.name)) return [unit];
    // A heavy unit holds two pool slots, so it may use two slots' share of workers.
    return [{ ...unit, weight: 2, args: unit.args.map((arg) => /^--maxWorkers=\d+$/.test(arg) ? `--maxWorkers=${Number(arg.slice(13)) * 2}` : arg) }];
  });
}

const TIMINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-unit-timings.json');

/** Recorded unit durations (ms) from test-unit-timings.json; refreshed from CI artifacts. */
export function readUnitTimings(file = TIMINGS_FILE) {
  return JSON.parse(readFileSync(file, 'utf8')).units;
}

/**
 * Pack units onto lanes longest first, each onto the least-loaded lane.
 * Units that share an exclusive pool resource run one at a time within a
 * lane, so they are packed first and spread evenly before the rest fill in.
 * Units without a recording cost the median recorded duration. Ties break by
 * name and lane order, so the assignment is deterministic.
 */
export function packLanes(units, lanes, timings) {
  const recorded = Object.values(timings).sort((left, right) => left - right);
  const median = recorded.length ? recorded[Math.floor(recorded.length / 2)] : 1;
  const cost = unit => timings[unit.name] ?? median;
  const loads = lanes.map(() => 0), assignments = Object.fromEntries(lanes.map(lane => [lane, []]));
  const ordered = [...units].sort((left, right) => Number(Boolean(right.resource)) - Number(Boolean(left.resource))
    || cost(right) - cost(left) || left.name.localeCompare(right.name));
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
