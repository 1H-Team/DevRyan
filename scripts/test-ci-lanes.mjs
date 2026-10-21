import path from 'node:path';
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
    if (unit.suite === 'harness') return discoverTestFiles(path.join(root, 'packages/harness-runtime'), root).flatMap(file => {
      const base = { ...unit, cwd: root, name: `harness:${file}`, args: ['test', `./${file}`] };
      return file.endsWith('/session-mutations.test.js') ? Array.from({ length: 4 }, (_, index) => ({ ...base,
        name: `${base.name}:${index + 1}/4`, env: { ...(unit.env ?? options.scriptEnvironment ?? process.env), DEVRYAN_MUTATION_TEST_SHARD: `${index + 1}/4` } })) : [base];
    });
    if (unit.name.endsWith('/native-stream-continuation.graph.test.ts')) return Array.from({ length: 2 }, (_, index) => ({ ...unit,
      name: `${unit.name}:${index + 1}/2`, env: { ...(unit.env ?? options.scriptEnvironment ?? process.env), DEVRYAN_STREAM_TEST_SHARD: `${index + 1}/2` } }));
    if (unit.name.startsWith('web:vitest')) return [{ ...unit, args: [...unit.args, ...MAC_WEB_TESTS.flatMap(file => ['--exclude', file])] }];
    if (unit.name === 'web:native') return [unit, { suite: 'web', name: 'web:macos', command: 'bun',
      args: ['run', '--cwd', 'packages/web', 'test:vitest', ...MAC_WEB_TESTS] }];
    return [unit];
  });
}

export function planCITests(root, lane, options) {
  if (!CI_LANES.includes(lane)) throw new Error(`Unknown CI test lane: ${lane}`);
  const assignments = Object.fromEntries(CI_LANES.map(key => [key, []]));
  let portable = 0, native = 0;
  for (const unit of ciTestInventory(root, options)) {
    const key = requiresMac(unit) ? `native-${native++ % 2 + 1}` : `portable-${portable++ % 4 + 1}`;
    assignments[key].push(unit);
  }
  return assignments[lane];
}
