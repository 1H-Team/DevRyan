import { BUILD_JOB_TESTS, CI_LANES, ciTestInventory, requiresMac, MAC_WEB_TESTS } from './test-ci-lanes.mjs';
import { testCaseShard } from './test-case-shard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { FEATURE_TEST_MATRIX } from './feature-test-matrix.mjs';
import { discoverElectronTestFiles, planElectronTests } from './test-electron.mjs';
import { NATIVE_GRAPH_RESOURCE, discoverScriptTestFiles, planScriptTests, prepareScriptTestEnvironment } from './test-scripts.mjs';
import { GUARDED_BUN_TEST, ISOLATION_PRELOAD, NODE_ISOLATION_ARGS, PASSED_THROUGH, isStrippedVariable, isolationProblems } from './test-isolation-guard.mjs';
import { FULL_TEST_COMMANDS, FULL_TEST_SUITES, HARNESS_WORKERS, WEB_VITEST_PROJECTS, planFullTests } from './test-full.mjs';
import { buildPlan, testUnitsForPlan } from './validate.mjs';
import { discoverTestFiles } from './test-runner-utils.mjs';
import { discoverUiTestFiles } from './test-ui.mjs';
import { STARTUP_CONTRACT_GROUPS } from './test-startup-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDirectory = path.join(repositoryRoot, 'packages/web');
const testDiscovery = { ignoredDirectories: new Set(['.git', '.cache', '.worktrees', 'node_modules', 'dist', 'dist-bundle', 'target', 'resources']) };

/**
 * The two hand-kept web runner lists: `notVitest` in packages/web/vitest.config.ts
 * and the targets of the `test:native` script (a directory target `dir` is `dir/**`).
 */
function webRunnerLists() {
  const config = readFileSync(path.join(webDirectory, 'vitest.config.ts'), 'utf8');
  const block = /const notVitest = \[([^\]]*)\];/.exec(config);
  assert.ok(block, 'vitest.config.ts declares const notVitest = [...]');
  const notVitest = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const web = JSON.parse(readFileSync(path.join(webDirectory, 'package.json'), 'utf8'));
  const [runner, subcommand, ...targets] = web.scripts['test:native'].split(/\s+/);
  assert.deepEqual([runner, subcommand], ['bun', 'test']);
  const native = targets.map((target) => target.replace(/^\.\//, ''))
    .map((target) => existsSync(path.join(webDirectory, target)) && statSync(path.join(webDirectory, target)).isDirectory() ? `${target}/**` : target);
  return { notVitest, native };
}

/** Test files a `notVitest`/`test:native` entry names, relative to packages/web. */
function webEntryFiles(entry) {
  if (!entry.endsWith('/**')) return [entry];
  return discoverTestFiles(path.join(webDirectory, entry.slice(0, -3)), webDirectory);
}

let vitestListing;
/** What Vitest collects per project with no lane exclusion (`vitest list`, nothing runs). */
function vitestCollectedFiles() {
  if (vitestListing) return vitestListing;
  const vitest = path.join(path.dirname(createRequire(path.join(webDirectory, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
  const env = { ...process.env };
  delete env.DEVRYAN_VITEST_EXCLUDE;
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'devryan-vitest-list-'));
  try {
    const output = path.join(scratch, 'files.json');
    const listed = spawnSync(process.execPath, [vitest, 'list', '--filesOnly', `--json=${output}`],
      { cwd: webDirectory, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    assert.equal(listed.error, undefined, `vitest list could not run or did not finish within 60 s: ${listed.error?.message}`);
    assert.equal(listed.status, 0, listed.stderr);
    vitestListing = JSON.parse(readFileSync(output, 'utf8'))
      .map(({ file, projectName }) => ({ file: path.relative(webDirectory, file).split(path.sep).join('/'), project: projectName }));
    return vitestListing;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Text of the call that starts at `start` (`skipIf(...)`, `t.skip(...)`), through its balanced closing parenthesis. */
function callText(source, start) {
  for (let index = source.indexOf('(', start), depth = 0; index !== -1 && index < source.length; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')' && --depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
}

/**
 * Spans of `source` that match a guard text, whitespace ignored on both sides, so
 * reformatting a guard (`=== ` to `===`) keeps it pinned.
 */
function guardSpans(source, text) {
  const pattern = new RegExp([...text.replace(/\s+/g, '')].map((char) => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('\\s*'), 'g');
  return [...source.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

/** Skip forms in `source` that need an inventory guard: conditional calls and any reference to a skip method (an alias). */
function conditionalSkipSites(source) {
  const sites = [];
  for (const match of source.matchAll(/(?:\.(skipIf|runIf|if)|(?<![\w$])(?:t|ctx|context)\.skip)\s*\(/g)) {
    const start = match[1] ? match.index + 1 : match.index;
    sites.push({ start, text: callText(source, start) });
  }
  for (const match of source.matchAll(/(?<![\w$])(?:test|it|describe|suite|bunTest)\.(?:skip|todo|skipIf|runIf)\b(?!\s*\()/g)) {
    const lineEnd = source.indexOf('\n', match.index);
    sites.push({ start: match.index, text: source.slice(source.lastIndexOf('\n', match.index) + 1, lineEnd === -1 ? undefined : lineEnd).trim() });
  }
  return sites;
}

/** Sites no guard covers: a site is covered when one of the guard texts spans its start. */
function uncoveredSkipSites(source, guards) {
  const spans = guards.flatMap((guard) => guardSpans(source, guard.text));
  return conditionalSkipSites(source).filter(({ start }) => !spans.some(([from, to]) => from <= start && start < to));
}

describe('full test-suite contract', () => {
  test('discovers every repository script test, including release verification', () => {
    const files = discoverScriptTestFiles(repositoryRoot);
    assert.ok(files.includes('scripts/verify-release-assets.test.mjs'));
    assert.ok(files.includes('scripts/test-suite-contract.test.mjs'));
    assert.ok(files.includes('scripts/opencode-v2-native/bootstrap.test.ts'));
    // agents-core tests run once, through their own package (test:full, validate).
    assert.ok(!files.some(file => file.startsWith('packages/agents-core/')));
    const web = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/web/package.json'), 'utf8'));
    assert.equal(web.scripts.test, 'node ../../scripts/test-isolation-guard.mjs bun run test:vitest && node ../../scripts/test-isolation-guard.mjs bun run test:native');
    assert.deepEqual(files, [...files].sort());
  });

  test('web test files run under exactly one of Vitest and test:native', () => {
    const { notVitest, native } = webRunnerLists();
    // Reviewed upstream inputs run in the scripts suite; every other Vitest exclusion is a test:native target.
    assert.ok(notVitest.includes('runtime/reviewed-inputs/**'));
    assert.deepEqual([...notVitest].filter((entry) => entry !== 'runtime/reviewed-inputs/**').sort(), [...native].sort(),
      'vitest.config.ts notVitest and the test:native targets name the same files');
    assert.equal(new Set(native).size, native.length);
    for (const entry of notVitest) assert.ok(existsSync(path.join(webDirectory, entry.replace(/\/\*\*$/, ''))), `${entry} exists`);
    for (const entry of native) assert.ok(webEntryFiles(entry).every((file) => existsSync(path.join(webDirectory, file))) && webEntryFiles(entry).length > 0, `${entry} names test files`);
    const nativeFiles = native.flatMap(webEntryFiles);
    const collected = vitestCollectedFiles();
    const vitestFiles = collected.map((entry) => entry.file);
    assert.deepEqual([...new Set(collected.map((entry) => entry.project))].sort(), [...WEB_VITEST_PROJECTS].sort());
    assert.equal(new Set(vitestFiles).size, vitestFiles.length, 'no web test file is collected by two Vitest projects');
    assert.deepEqual(vitestFiles.filter((file) => nativeFiles.includes(file)), [], 'no test:native file is collected by Vitest');
    const reviewed = webEntryFiles('runtime/reviewed-inputs/**');
    assert.deepEqual(vitestFiles.filter((file) => reviewed.includes(file)), []);
    const webTests = discoverTestFiles(webDirectory, webDirectory).filter((file) => !reviewed.includes(file));
    assert.deepEqual([...vitestFiles, ...nativeFiles].sort(), webTests, 'every web test file runs under Vitest or test:native');
  });

  test('discovers Electron tests recursively', () => {
    const files = discoverElectronTestFiles(path.join(repositoryRoot, 'packages/electron'));
    assert.ok(files.includes('startup-splash.test.mjs'));
    assert.ok(files.includes('scripts/rebuild-native.test.mjs'));
    assert.ok(files.includes('tests/browser-cdp-bridge.test.mjs'));
    assert.deepEqual(files, [...files].sort());
  });

  // packages/desktop is frozen legacy Tauri: only its JavaScript contract runs in the full gate.
  const excludedFromFull = new Set(['desktop']);
  test('includes every test-owning workspace package in the full gate', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    assert.equal(rootPackage.scripts['test:full'], 'node scripts/test-full.mjs');
    assert.equal(rootPackage.scripts.build, 'bun run --cwd packages/electron build:web-assets && bun run build:electron');
    const fullCommand = FULL_TEST_COMMANDS.join(' && ');
    const packageDirectories = readdirSync(path.join(repositoryRoot, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const testPackages = packageDirectories.filter((name) => {
      const manifestPath = path.join(repositoryRoot, 'packages', name, 'package.json');
      if (!existsSync(manifestPath)) return false;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return typeof manifest.scripts?.test === 'string' && !excludedFromFull.has(name);
    });

    for (const packageName of testPackages) {
      assert.match(
        fullCommand,
        new RegExp(`bun run --cwd packages/${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} test`),
        `${packageName} is not included in test:full`,
      );
    }
  });

  test('accounts for every deterministic JavaScript and TypeScript test file', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    assert.equal(rootPackage.scripts['test:visual-fixture'], undefined);

    const ignoredDirectories = new Set([
      '.git',
      '.cache',
      '.worktrees',
      'node_modules',
      'dist',
      'dist-bundle',
      'target',
      'resources',
    ]);
    const allTests = discoverTestFiles(repositoryRoot, repositoryRoot, { ignoredDirectories });
    const desktopTest = 'packages/desktop/scripts/devryan-managed-orchestration.test.mjs';
    const desktop = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/desktop/package.json'), 'utf8'));
    assert.equal(desktop.scripts['test:managed-orchestration'], 'bun test scripts/devryan-managed-orchestration.test.mjs');
    assert.deepEqual(allTests.filter((file) => file.startsWith('packages/desktop/')), [desktopTest]);
    assert.ok(FULL_TEST_COMMANDS.includes('bun run --cwd packages/desktop test:managed-orchestration'));
    const fullGateRoots = [
      '.opencode/agents/',
      '.opencode/plugins/',
      'scripts/',
      'packages/agents-core/',
      'packages/cursor-sdk-runtime/',
      'packages/desktop/',
      'packages/electron/',
      'packages/harness-runtime/',
      'packages/orchestration-runtime/',
      'packages/shared-runtime/',
      'packages/ui/',
      'packages/web/',
    ];
    const uncovered = allTests.filter((file) => !fullGateRoots.some((root) => file.startsWith(root)));
    assert.deepEqual(uncovered, []);

    const scriptTests = new Set(discoverScriptTestFiles(repositoryRoot));
    const electronTests = new Set(
      discoverElectronTestFiles(path.join(repositoryRoot, 'packages/electron'))
        .map((file) => `packages/electron/${file}`),
    );
    const uiTests = new Set(
      discoverUiTestFiles(path.join(repositoryRoot, 'packages/ui'))
        .map((file) => `packages/ui/${file}`),
    );
    for (const file of allTests) {
      if (file.startsWith('.opencode/agents/')) assert.equal(scriptTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('.opencode/plugins/')) assert.equal(scriptTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('packages/web/runtime/reviewed-inputs/')) assert.equal(scriptTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('scripts/')) assert.equal(scriptTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('packages/electron/')) assert.equal(electronTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('packages/ui/')) assert.equal(uiTests.has(file), true, `undiscovered: ${file}`);
    }
  });

  test('the concurrent full runner expands every suite into units that run its files exactly once', () => {
    const units = planFullTests(repositoryRoot);
    const names = units.map((unit) => unit.name);
    assert.deepEqual(names.slice(0, 3), ['web:vitest web-runtime-host',
      'scripts:scripts/opencode-v2-native/native-stream-continuation.graph.test.ts', 'harness-runtime']);
    assert.equal(new Set(names).size, names.length);
    const key = (unit) => JSON.stringify([unit.command, unit.args, unit.cwd ?? null]);
    assert.deepEqual([...new Set(units.map((unit) => unit.suite))].sort(), FULL_TEST_SUITES.map((suite) => suite.key).sort());
    // Script tests: one Node batch plus one Bun process per Bun file, each file once.
    const scriptUnits = units.filter((unit) => unit.name.startsWith('scripts:'));
    for (const unit of scriptUnits) {
      const file = unit.args.at(-1)?.replace(/^\.\//, '');
      if (file && readFileSync(path.join(repositoryRoot, file), 'utf8').includes('controller-integrations.graph-fixture.mjs')) {
        assert.equal(unit.resource, NATIVE_GRAPH_RESOURCE, `${file} shares the native graph resource (callback port 1455)`);
      }
    }
    assert.deepEqual(scriptUnits.map(key).sort(), planScriptTests(repositoryRoot).map(key).sort());
    const scriptFiles = scriptUnits.flatMap((unit) => unit.args.filter((arg) => /test\.[cm]?[jt]sx?$/.test(arg)).map((arg) => arg.replace(/^\.\//, '')));
    assert.deepEqual([...scriptFiles].sort(), discoverScriptTestFiles(repositoryRoot));
    // Web: every Vitest project of the package's own test:vitest, then its test:native.
    const webUnits = units.filter((unit) => unit.name.startsWith('web:'));
    assert.deepEqual(webUnits.map((unit) => unit.args.filter((arg) => !arg.startsWith('--maxWorkers=')).join(' ')).sort(), [
      ...WEB_VITEST_PROJECTS.map((project) => `run --cwd packages/web test:vitest --project=${project}`),
      'run --cwd packages/web test:native',
    ].sort());
    const web = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/web/package.json'), 'utf8'));
    assert.equal(web.scripts['test:vitest'], 'vitest run');
    // Harness: the package's own `bun test` (which its script runs inside the guard), with file workers.
    const harness = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/harness-runtime/package.json'), 'utf8'));
    assert.equal(harness.scripts.test, GUARDED_BUN_TEST);
    assert.deepEqual(units.filter((unit) => unit.name === 'harness-runtime').map((unit) => [unit.args, unit.cwd]),
      [[['test', `--parallel=${HARNESS_WORKERS}`], path.join(repositoryRoot, 'packages/harness-runtime')]]);
    // Every other suite runs its inventory command unchanged.
    const split = new Set(['scripts', 'web', 'harness']);
    const rest = units.filter((unit) => !unit.name.startsWith('scripts:') && !unit.name.startsWith('web:') && unit.name !== 'harness-runtime');
    assert.deepEqual(rest.map(key).sort(), FULL_TEST_SUITES.filter((suite) => !split.has(suite.key)).map(key).sort());
  });

  test('isolated CI lanes run the full inventory exactly once after the shared build', () => {
    const workflow = YAML.parse(readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'));
    const testJobs = [workflow.jobs.tests, workflow.jobs['native-tests']];
    const matrix = testJobs.flatMap(job => job.strategy.matrix.include);
    assert.deepEqual(matrix.map(row => row.lane).sort(), [...CI_LANES].sort());
    assert.ok(workflow.jobs['native-tests'].strategy.matrix.include.every(row => row.runner === 'macos-26' && row.lane.startsWith('native')));
    assert.ok(workflow.jobs.tests.strategy.matrix.include.every(row => row.runner === 'ubuntu-latest' && row.lane.startsWith('portable')));
    assert.equal(workflow.jobs.tests['runs-on'], 'ubuntu-latest');
    assert.equal(workflow.jobs['native-tests']['runs-on'], 'macos-26');
    for (const job of ['static', 'build']) assert.equal(workflow.jobs[job]['runs-on'], 'ubuntu-latest');
    assert.match(workflow.concurrency.group, /github.sha/);
    assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
    // Lanes wait only for the artifacts they consume; static checks run beside them.
    // No job waits for another; no test lane reads the build's output.
    for (const job of Object.values(workflow.jobs)) assert.equal(job.needs, undefined);
    assert.ok(workflow.jobs['native-tests'].steps.some(step => step.run === 'bun scripts/build-native-runtime.mjs'));
    assert.ok(!JSON.stringify(workflow).includes('actions/download-artifact'));
    for (const job of testJobs) {
      assert.equal(job.strategy['fail-fast'], false);
      assert.ok(job.steps.some(step => step.run === 'node scripts/validate.mjs ci:${{ matrix.lane }}'));
      assert.equal(job.env.DEVRYAN_TEST_SEED, '${{ github.run_number }}');
    }
    assert.ok(workflow.jobs.static.steps.some(step => step.run === 'node scripts/validate.mjs static'));
    assert.ok(workflow.jobs.build.steps.some(step => step.run === 'node scripts/validate.mjs build'));
    const nonTest = buildPlan('full').commands.filter(item => item.label !== 'test:full').map(item => item.label);
    assert.deepEqual(buildPlan('checks').commands.map(item => item.label), nonTest);
    assert.deepEqual([...buildPlan('static').commands, ...buildPlan('build').commands].map(item => item.label).filter(label => label !== 'built-assets').sort(), [...nonTest].sort());

    const key = unit => JSON.stringify([unit.name, unit.command, unit.args, unit.cwd]);
    const laneUnits = CI_LANES.flatMap(lane => testUnitsForPlan(buildPlan(`ci:${lane}`).commands));
    assert.deepEqual(laneUnits.map(key).sort(), ciTestInventory(repositoryRoot).map(unit => key({ ...unit, cwd: unit.cwd ?? repositoryRoot })).sort());
    assert.equal(new Set(laneUnits.map(unit => unit.name)).size, laneUnits.length);
    for (const lane of CI_LANES) for (const unit of testUnitsForPlan(buildPlan(`ci:${lane}`).commands)) {
      assert.equal(requiresMac(unit), lane.startsWith('native'), unit.name);
    }
    const scriptFiles = laneUnits.filter(unit => unit.suite === 'scripts').flatMap(unit => unit.args.filter(arg => /test\.[cm]?[jt]sx?$/.test(arg)).map(arg => arg.replace(/^\.\//, '')));
    // Lanes plus the build job's built-asset tests run every script test exactly once.
    assert.deepEqual([...new Set([...scriptFiles, ...BUILD_JOB_TESTS])].sort(), discoverScriptTestFiles(repositoryRoot));
    for (const file of BUILD_JOB_TESTS) assert.ok(!scriptFiles.includes(file), `${file} runs in the build job, not a lane`);
    assert.deepEqual(buildPlan('build').commands.at(-1).args, [...NODE_ISOLATION_ARGS, '--test', ...BUILD_JOB_TESTS]);
    const harnessFiles = laneUnits.filter(unit => unit.suite === 'harness').flatMap(unit => unit.args.filter(arg => /test\.js$/.test(arg)).map(arg => arg.replace(/^\.\//, '')));
    assert.deepEqual([...new Set(harnessFiles)].sort(), discoverTestFiles(path.join(repositoryRoot, 'packages/harness-runtime'), repositoryRoot));
    for (const [suite, variable, count] of [['scripts', 'DEVRYAN_STREAM_TEST_SHARD', 2]]) {
      const shards = laneUnits.filter(unit => unit.suite === suite && unit.env?.[variable]).map(unit => unit.env[variable]);
      assert.deepEqual(shards.sort(), Array.from({ length: count }, (_, index) => `${index + 1}/${count}`));
      for (let index = 0; index < 1000; index++) assert.equal(shards.filter(shard => testCaseShard(index, shard)).length, 1);
    }
    // A case-sharded file registers every test through its one shard filter; a
    // direct registration would run once per shard (it did: 9 redundant heavy runs).
    for (const file of discoverScriptTestFiles(repositoryRoot).filter(file => file !== 'scripts/test-suite-contract.test.mjs' && readFileSync(path.join(repositoryRoot, file), 'utf8').includes('test-case-shard.mjs'))) {
      assert.equal(readFileSync(path.join(repositoryRoot, file), 'utf8').match(/(?<![\w.])(?:bunTest|test|it)\s*\(/g)?.length, 1, `${file} registers tests outside its shard filter`);
    }
    for (const file of MAC_WEB_TESTS) {
      assert.ok(laneUnits.find(unit => unit.name === 'web:macos').args.includes(file));
      for (const unit of laneUnits.filter(unit => unit.name.startsWith('web:vitest'))) assert.ok(unit.env.DEVRYAN_VITEST_EXCLUDE.split(',').includes(file));
    }
    const split = new Set(['scripts', 'harness', 'web']);
    assert.deepEqual(laneUnits.filter(unit => !split.has(unit.suite)).map(key).sort(),
      testUnitsForPlan(buildPlan('full').commands).filter(unit => !split.has(unit.suite)).map(key).sort());
    assert.throws(() => buildPlan('ci:unknown'), /Unknown CI test lane/);
    assert.ok(!workflow.jobs.build.steps.some(step => step.uses === 'actions/upload-artifact@v4'));
  });

  test('platform-gated web checks remain on macOS rather than silently skipping on Ubuntu', () => {
    const guarded = /skipIf\([^\n]*darwin|if\s*\(process\.platform\s*===?\s*['"]darwin|skipIf\(!caseInsensitive|skipIf\(!launcherPresent/;
    for (const file of discoverTestFiles(path.join(repositoryRoot, 'packages/web/server'), repositoryRoot)) {
      if (guarded.test(readFileSync(path.join(repositoryRoot, file), 'utf8'))) {
        assert.ok(MAC_WEB_TESTS.includes(file.replace('packages/web/', '')), `macOS coverage moved off platform: ${file}`);
      }
    }
  });

  test('every startup contract file also runs in its owner suite of the full gate', () => {
    const owners = new Set(STARTUP_CONTRACT_GROUPS.map((group) => group.owner));
    assert.deepEqual([...owners].sort(), ['electron', 'harness', 'scripts', 'shared', 'ui', 'web']);
    const files = (group) => group.args.filter((arg) => /test\.[cm]?[jt]sx?$/.test(arg));
    const discovered = {
      electron: new Set(discoverElectronTestFiles(path.join(repositoryRoot, 'packages/electron')).map((file) => `packages/electron/${file}`)),
      scripts: new Set(discoverScriptTestFiles(repositoryRoot)),
      ui: new Set(discoverUiTestFiles(path.join(repositoryRoot, 'packages/ui'))),
    };
    // Web startup files run through `vitest run <files>` and, in the full gate, through
    // the Vitest projects of test:vitest: each must be collected by one of those projects.
    const web = JSON.parse(readFileSync(path.join(webDirectory, 'package.json'), 'utf8'));
    assert.equal(web.scripts['test:vitest'], 'vitest run');
    const vitestProject = new Map(vitestCollectedFiles().map((entry) => [entry.file, entry.project]));
    const { notVitest } = webRunnerLists();
    for (const group of STARTUP_CONTRACT_GROUPS) {
      assert.ok(files(group).length > 0, group.name);
      for (const file of files(group)) {
        if (group.owner in discovered) assert.ok(discovered[group.owner].has(file), `${file} is not discovered by the ${group.owner} suite`);
        else if (group.owner === 'web') {
          assert.ok(existsSync(path.join(repositoryRoot, 'packages/web', file)), file);
          assert.ok(!notVitest.some((entry) => webEntryFiles(entry).includes(file)), `${file} is excluded from web test:vitest`);
          assert.ok(WEB_VITEST_PROJECTS.includes(vitestProject.get(file)), `${file} is not collected by a web Vitest project`);
        } else {
          // shared-runtime and harness-runtime run plain `bun test` over their package (inside the guard).
          const directory = { shared: 'packages/shared-runtime', harness: 'packages/harness-runtime' }[group.owner];
          assert.equal(JSON.parse(readFileSync(path.join(repositoryRoot, directory, 'package.json'), 'utf8')).scripts.test, GUARDED_BUN_TEST);
          assert.ok(file.startsWith(`${directory}/`) && existsSync(path.join(repositoryRoot, file)), file);
        }
      }
    }
  });

  test('contains no silent skip, todo or only declarations in deterministic tests', () => {
    const files = discoverTestFiles(repositoryRoot, repositoryRoot, testDiscovery).filter((file) => file !== 'scripts/test-suite-contract.test.mjs');
    const forbidden = new RegExp(String.raw`(?<![\w$])(?:test|it|describe|suite|bunTest)\.(?:skip|todo)\s*\(|(?<![\w$])(?:test|it|describe|suite|bunTest)\.only\b|\bskip\s*:`);
    const offenders = files.filter((file) => forbidden.test(readFileSync(path.join(repositoryRoot, file), 'utf8')));
    assert.deepEqual(offenders, []);
  });

  test('every conditional skip is inventoried with its condition and whether CI meets it', () => {
    const { entries } = JSON.parse(readFileSync(path.join(repositoryRoot, 'scripts/test-conditional-skips.json'), 'utf8'));
    const files = entries.map((entry) => entry.file);
    assert.deepEqual(files, [...new Set(files)].sort(), 'one entry per file, sorted by file');
    const units = ciTestInventory(repositoryRoot);
    const nativeFiles = webRunnerLists().native.flatMap(webEntryFiles);
    const packageSuite = (file) => FULL_TEST_SUITES.find((suite) => suite.args[1] === '--cwd' && file.startsWith(`${suite.args[2]}/`))?.key;
    // The CI job(s) whose lanes run `file`: tests (Ubuntu), native-tests (macOS) or build.
    const ciJobs = (file) => {
      if (BUILD_JOB_TESTS.includes(file)) return ['build'];
      let running = units.filter((unit) => unit.args.some((arg) => arg.replace(/^\.\//, '') === file));
      if (!running.length && file.startsWith('packages/web/')) {
        const relative = file.slice('packages/web/'.length);
        running = units.filter((unit) => unit.name === 'web:macos' && unit.args.includes(relative));
        if (!running.length) running = units.filter((unit) => nativeFiles.includes(relative) ? unit.name === 'web:native' : unit.name.startsWith('web:vitest'));
      }
      if (!running.length) running = units.filter((unit) => unit.suite === packageSuite(file));
      return [...new Set(running.map((unit) => requiresMac(unit) ? 'native-tests' : 'tests'))].sort();
    };
    const mechanisms = new Set(['skipIf', 'runIf', 't.skip()', 'skip alias', 'early return', 'if around test']);
    const neverInCi = [];
    for (const entry of entries) {
      assert.ok(existsSync(path.join(repositoryRoot, entry.file)), `${entry.file} no longer exists`);
      const source = readFileSync(path.join(repositoryRoot, entry.file), 'utf8');
      assert.ok(entry.guards.length > 0, `${entry.file} lists its guards`);
      for (const guard of entry.guards) {
        assert.ok(mechanisms.has(guard.mechanism), `${entry.file}: unknown mechanism ${guard.mechanism}`);
        assert.ok(['yes', 'no'].includes(guard.ci), `${entry.file}: ci is yes or no`);
        assert.ok(typeof guard.condition === 'string' && guard.condition.length > 0, `${entry.file}: condition in words`);
        assert.ok(guardSpans(source, guard.text).length > 0, `${entry.file} no longer contains its guard ${guard.text}`);
        if (guard.definition !== undefined) assert.ok(guardSpans(source, guard.definition).length > 0, `${entry.file} no longer contains ${guard.definition}`);
        if (guard.ci === 'no') neverInCi.push(`${entry.file}: ${guard.condition}${guard.note ? ` (${guard.note})` : ''}`);
      }
      assert.deepEqual(entry.ciJobs, ciJobs(entry.file), `${entry.file} runs in the CI job(s) its entry names`);
    }
    // Mechanical forms are found here; early-return and if-wrapped guards are listed by hand.
    const byFile = new Map(entries.map((entry) => [entry.file, entry]));
    const missing = [];
    for (const file of discoverTestFiles(repositoryRoot, repositoryRoot, testDiscovery).filter((name) => name !== 'scripts/test-suite-contract.test.mjs')) {
      const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
      for (const site of uncoveredSkipSites(source, byFile.get(file)?.guards ?? [])) missing.push(`${file}: ${site.text}`);
    }
    assert.deepEqual(missing, [], 'conditional skips missing from scripts/test-conditional-skips.json');
    console.log(`[test-suite-contract] ${neverInCi.length} conditional test guard(s) CI never satisfies, so those tests never run in CI:\n${neverInCi.map((line) => `  - ${line}`).join('\n')}`);
  });
});

describe('conditional-skip guard matching', () => {
  test('ignores whitespace, so a reformatted guard stays pinned', () => {
    const guards = [{ text: "skipIf(process.platform === 'win32')" }];
    const reformatted = "describe.skipIf(process.platform==='win32')('x', () => {});\n";
    assert.deepEqual(guardSpans(reformatted, guards[0].text), [[9, 43]]);
    assert.deepEqual(uncoveredSkipSites(reformatted, guards), []);
    assert.deepEqual(uncoveredSkipSites("describe.skipIf(process.platform !== 'darwin')('x', () => {});\n", guards).map((site) => site.text),
      ["skipIf(process.platform !== 'darwin')"]);
  });

  test('a skip method used without a call is an alias that needs a guard', () => {
    const source = "const macTest = process.platform === 'darwin' ? test : test.skip;\nmacTest('x', () => {});\n";
    assert.deepEqual(uncoveredSkipSites(source, []).map((site) => site.text), ["const macTest = process.platform === 'darwin' ? test : test.skip;"]);
    assert.deepEqual(uncoveredSkipSites(source, [{ text: "const macTest=process.platform==='darwin'?test:test.skip;" }]), []);
    assert.deepEqual(conditionalSkipSites("it.runIf(ok)('x', () => {}); const later = bunTest.skipIf;").map((site) => site.text),
      ['runIf(ok)', "it.runIf(ok)('x', () => {}); const later = bunTest.skipIf;"]);
  });
});

describe('feature-to-test matrix', () => {
  test('has unique feature ids and live source/test anchors', () => {
    const ids = FEATURE_TEST_MATRIX.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length >= 15);

    for (const entry of FEATURE_TEST_MATRIX) {
      assert.ok(entry.sourcePaths.length > 0, `${entry.id} has no source paths`);
      assert.ok(entry.testPaths.length > 0, `${entry.id} has no test paths`);
      for (const relativePath of [...entry.sourcePaths, ...entry.testPaths]) {
        assert.equal(existsSync(path.join(repositoryRoot, relativePath)), true, `${entry.id}: missing ${relativePath}`);
      }
    }
  });
});

// Every test process starts inside the private environment of
// scripts/test-isolation-guard.mjs: Bun through a bunfig.toml preload in the
// directory it starts in, node:test through --import, Vitest through its
// setup files, and the pool through the environment prepareScriptTestEnvironment builds.
const ISOLATION_GUARD_IMPORT = /from '\.\/test-isolation-guard\.mjs'/;
/** Absolute preload entries of `<directory>/bunfig.toml`, or null when it has none. */
function bunPreloads(directory) {
  const file = path.join(directory, 'bunfig.toml');
  if (!existsSync(file)) return null;
  const match = /^\s*preload\s*=\s*\[([^\]]*)\]/m.exec(readFileSync(file, 'utf8'));
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => path.resolve(directory, entry[1])) : null;
}
// packages/desktop is frozen legacy code: no file there changes, so its one Bun
// contract file has no preload. The pool still runs it in the guard's environment
// (checked below for every unit); a direct `bun test` there is not refused.
const UNPRELOADED_FROZEN = new Set([path.join(repositoryRoot, 'packages/desktop')]);
const bunGuarded = (directory) => bunPreloads(directory)?.[0] === ISOLATION_PRELOAD || UNPRELOADED_FROZEN.has(path.resolve(directory));
/** A repository runner script that builds or reuses the guard environment itself. */
const runnerGuarded = (file) => ISOLATION_GUARD_IMPORT.test(readFileSync(path.join(repositoryRoot, file), 'utf8'));

/** Why a package script (each `&&` step) could start a test process without the guard; empty when guarded. */
function packageScriptProblems(directory, name, seen = new Set()) {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, directory, 'package.json'), 'utf8'));
  const script = manifest.scripts?.[name];
  if (typeof script !== 'string') return [`${directory}: no script ${name}`];
  if (seen.has(`${directory}:${name}`)) return [];
  seen.add(`${directory}:${name}`);
  const absolute = path.join(repositoryRoot, directory);
  return script.split('&&').map((step) => step.trim()).flatMap((step) => {
    if (step.startsWith('node ../../scripts/test-isolation-guard.mjs ') || step.startsWith('node scripts/test-isolation-guard.mjs ')) return [];
    if (/^bun test\b/.test(step)) return bunGuarded(absolute) ? [] : [`${directory} ${name}: bun test without the isolation preload`];
    if (/^vitest run\b/.test(step)) return vitestGuarded(absolute) ? [] : [`${directory} ${name}: vitest without the isolation setup`];
    const run = /^bun run ([\w:.-]+)$/.exec(step);
    if (run) return packageScriptProblems(directory, run[1], seen);
    const runner = /^node ((?:\.\.\/)*scripts\/test-[\w-]+\.mjs)\b/.exec(step);
    if (runner) return runnerGuarded(path.relative(repositoryRoot, path.resolve(absolute, runner[1]))) ? [] : [`${directory} ${name}: ${runner[1]} does not use the guard`];
    return [`${directory} ${name}: unrecognised test step ${step}`];
  });
}

function vitestGuarded(directory) {
  const config = path.join(directory, 'vitest.config.ts');
  if (!existsSync(config)) return false;
  const source = readFileSync(config, 'utf8');
  const entries = (key) => [...(new RegExp(`${key}: \\[([^\\]]*)\\]`).exec(source)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => path.resolve(directory, entry[1]));
  const guarded = (file) => existsSync(file) && /scripts\/test-isolation-(?:guard|check)\.mjs'/.test(readFileSync(file, 'utf8')) && /assertTestIsolation\(/.test(readFileSync(file, 'utf8'));
  return entries('globalSetup').some(guarded) && entries('setupFiles').some(guarded);
}

/** Why a pool unit could start a test process without the guard; empty when guarded. */
function unitIsolationProblems(unit) {
  return [...isolationProblems({ env: unit.env ?? {}, home: unit.env?.HOME }).map((problem) => `${unit.name}: ${problem}`), ...commandIsolationProblems(unit)];
}

/** Why a command could start a test process that neither inherits nor builds the guard's environment. */
function commandIsolationProblems(unit) {
  const cwd = unit.cwd ?? repositoryRoot;
  const problems = [];
  const { command, args } = unit;
  if (command === 'node' || command === process.execPath) {
    if (args.includes('--test')) {
      if (!args.slice(0, args.indexOf('--test')).includes(NODE_ISOLATION_ARGS[0])) problems.push(`${unit.name}: node --test without ${NODE_ISOLATION_ARGS[0]}`);
    } else if (!(/^scripts\/test-[\w-]+\.mjs$/.test(args[0]) && runnerGuarded(args[0]))) problems.push(`${unit.name}: node ${args[0]} is not a guarded runner`);
  } else if (command === 'bun' && args[0] === 'test') {
    if (!bunGuarded(cwd)) problems.push(`${unit.name}: bun test in ${path.relative(repositoryRoot, cwd) || '.'} without the isolation preload`);
  } else if (command === 'bun' && args[0] === 'run') {
    const [directory, rest] = args[1] === '--cwd' ? [args[2], args.slice(3)] : [path.relative(repositoryRoot, cwd) || '.', args.slice(1)];
    if (rest[0] === 'vitest') {
      if (!vitestGuarded(path.join(repositoryRoot, directory))) problems.push(`${unit.name}: vitest in ${directory} without the isolation setup`);
    } else problems.push(...packageScriptProblems(directory, rest[0]).map((problem) => `${unit.name}: ${problem}`));
  } else problems.push(`${unit.name}: unrecognised test command ${command} ${args.join(' ')}`);
  return problems;
}

describe('test isolation contract', () => {
  const bunPackages = readdirSync(path.join(repositoryRoot, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()
    && discoverTestFiles(path.join(repositoryRoot, 'packages', entry.name), repositoryRoot, testDiscovery)
      .some((file) => /\bfrom\s*['"]bun:test['"]/.test(readFileSync(path.join(repositoryRoot, file), 'utf8')))).map((entry) => `packages/${entry.name}`);

  test('every directory Bun tests start in loads the isolation preload first', () => {
    assert.deepEqual(bunPackages.sort(), ['agents-core', 'cursor-sdk-runtime', 'desktop', 'electron', 'harness-runtime', 'orchestration-runtime', 'shared-runtime', 'ui', 'web'].map((name) => `packages/${name}`));
    for (const directory of ['.', ...bunPackages]) assert.ok(bunGuarded(path.join(repositoryRoot, directory)), `${directory}/bunfig.toml preloads scripts/test-isolation-preload.mjs first`);
    // The frozen exception stays exactly that one package, with no bunfig of its own.
    assert.deepEqual([...UNPRELOADED_FROZEN].map((directory) => path.relative(repositoryRoot, directory)), ['packages/desktop']);
    assert.equal(existsSync(path.join(repositoryRoot, 'packages/desktop/bunfig.toml')), false);
  });

  test('every package test script starts its tests through the guard', () => {
    for (const entry of readdirSync(path.join(repositoryRoot, 'packages'), { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const directory = `packages/${entry.name}`;
      if (!existsSync(path.join(repositoryRoot, directory, 'package.json'))) continue;
      const scripts = JSON.parse(readFileSync(path.join(repositoryRoot, directory, 'package.json'), 'utf8')).scripts ?? {};
      for (const name of Object.keys(scripts).filter((key) => /^test(?::|$)/.test(key))) {
        // Cargo tests (legacy desktop) start no JavaScript test process.
        if (/^cargo test\b/.test(scripts[name])) continue;
        assert.deepEqual(packageScriptProblems(directory, name), [], `${directory} ${name}`);
      }
    }
    assert.ok(vitestGuarded(webDirectory), 'packages/web Vitest asserts isolation in its global setup and setup file');
  });

  test('every unit of every runner starts with the guard and its environment', () => {
    const { env, cleanup } = prepareScriptTestEnvironment(repositoryRoot);
    try {
      const units = [
        ...testUnitsForPlan(buildPlan('full').commands, { scriptEnvironment: env }),
        ...CI_LANES.flatMap((lane) => testUnitsForPlan(buildPlan(`ci:${lane}`).commands, { scriptEnvironment: env })),
        ...testUnitsForPlan([{ label: 'test:startup', coveredBy: [] }], { scriptEnvironment: env }),
        ...planScriptTests(repositoryRoot).map((unit) => ({ ...unit, env })),
      ];
      assert.ok(units.length > 300);
      assert.deepEqual(units.flatMap(unitIsolationProblems), []);
      // The built-asset tests run outside the pool (the CI build job, validate:full);
      // their node:test import builds the guard's environment in each file's process.
      for (const plan of [buildPlan('build'), buildPlan('full')]) {
        const builtAssets = plan.commands.find((item) => item.label === 'built-assets') ?? { executable: 'node', args: [...NODE_ISOLATION_ARGS, '--test', ...BUILD_JOB_TESTS] };
        assert.deepEqual(commandIsolationProblems({ name: 'built-assets', command: builtAssets.executable, args: builtAssets.args }), []);
      }
      assert.match(readFileSync(path.join(repositoryRoot, 'scripts/validate.mjs'), 'utf8'), /builtAssetsCommand\(\)\] : buildChain/);
      // Runners that start their own pool build the same environment.
      for (const runner of ['scripts/test-scripts.mjs', 'scripts/test-full.mjs', 'scripts/test-startup-contract.mjs', 'scripts/test-ui.mjs', 'scripts/test-electron.mjs']) {
        assert.ok(runnerGuarded(runner) || /prepareScriptTestEnvironment\(/.test(readFileSync(path.join(repositoryRoot, runner), 'utf8')), `${runner} builds the guard environment`);
      }
    } finally { cleanup(); }
  });

  test('a unit or runner added without the guard fails this contract', () => {
    const { env, cleanup } = prepareScriptTestEnvironment(repositoryRoot);
    try {
      const unguarded = { ...env };
      delete unguarded.DEVRYAN_TEST_ISOLATION_ROOT;
      assert.match(unitIsolationProblems({ name: 'x', command: 'node', args: ['--test', 'scripts/x.test.mjs'], env }).join(), /without --import=/);
      assert.match(unitIsolationProblems({ name: 'x', command: 'bun', args: ['test', './x.test.js'], cwd: path.join(repositoryRoot, 'packages/web/server'), env }).join(), /without the isolation preload/);
      assert.match(unitIsolationProblems({ name: 'x', command: 'node', args: ['scripts/release.mjs'], env }).join(), /not a guarded runner/);
      assert.match(unitIsolationProblems({ name: 'x', command: 'bun', args: ['test', './x.test.js'], env: unguarded }).join(), /DEVRYAN_TEST_ISOLATION_ROOT is not set/);
      assert.match(unitIsolationProblems({ name: 'x', command: 'sh', args: ['-c', 'bun test'], env }).join(), /unrecognised test command/);
    } finally { cleanup(); }
  });

  test('every DevRyan, OpenChamber and OpenCode variable product code reads is stripped or deliberately passed through', () => {
    const access = /(?:env|Env|ENV|environment|Environment)\??(?:\.|\[['"])((?:DEVRYAN|OPENCHAMBER|OPENCODE)_[A-Z0-9_]+)|(?:read|set)DevRyanEnv\([^,()]+,\s*['"]((?:DEVRYAN|OPENCHAMBER|OPENCODE)_[A-Z0-9_]+)/g;
    const listed = spawnSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: repositoryRoot, encoding: 'utf8' }).stdout.split('\0')
      .filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && !/(?:^|[./-])(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
        && !file.startsWith('packages/desktop/') && !file.includes('/reviewed-inputs/') && !file.includes('/tests/') && !file.includes('/test/'));
    const names = new Map();
    for (const file of listed) {
      for (const match of readFileSync(path.join(repositoryRoot, file), 'utf8').matchAll(access)) {
        const name = (match[1] ?? match[2]).replace(/^OPENCHAMBER_/, 'DEVRYAN_');
        if (!names.has(name)) names.set(name, file);
      }
    }
    assert.ok(names.size > 150, `found ${names.size} variable names`);
    for (const required of ['OPENCODE_DB', 'DEVRYAN_EXECUTION_ARTIFACTS', 'DEVRYAN_SESSION_TMP', 'OPENCODE_BINARY', 'DEVRYAN_STANDARD_OPENCODE_BINARY',
      'DEVRYAN_SERVER_URL', 'OPENCODE_PORT', 'OPENCODE_SERVER_PASSWORD', 'SSH_AUTH_SOCK']) assert.equal(isStrippedVariable(required), true, required);
    const unknown = [...names].filter(([name]) => !isStrippedVariable(name) && !(name in PASSED_THROUGH)).map(([name, file]) => `${name} (${file})`);
    assert.deepEqual(unknown, [], 'a new variable must be stripped by scripts/test-isolation-check.mjs or listed in PASSED_THROUGH with its reason');
    const strippedButListed = Object.keys(PASSED_THROUGH).filter((name) => isStrippedVariable(name));
    assert.deepEqual(strippedButListed, []);
    const stale = Object.keys(PASSED_THROUGH).filter((name) => !names.has(name) && !['DEVRYAN_TEST_UPDATE_BRIDGE', 'DEVRYAN_TEST_UPDATE_INSTALLER', 'DEVRYAN_VITEST_EXCLUDE', 'DEVRYAN_TEST_ISOLATION_ROOT'].includes(name));
    assert.deepEqual(stale, [], 'PASSED_THROUGH names a variable no product code reads');
  });

  test('every runner collects an isolation canary', () => {
    const scripts = discoverScriptTestFiles(repositoryRoot);
    const plan = planScriptTests(repositoryRoot, {}, { files: ['scripts/test-isolation-canary.test.mjs', 'scripts/test-isolation-canary-bun.test.mjs'] });
    assert.deepEqual(plan.map((unit) => [unit.command === 'bun' ? 'bun' : 'node', unit.args.at(-1)]),
      [['node', 'scripts/test-isolation-canary.test.mjs'], ['bun', './scripts/test-isolation-canary-bun.test.mjs']]);
    assert.ok(scripts.includes('scripts/test-isolation-canary.test.mjs') && scripts.includes('scripts/test-isolation-canary-bun.test.mjs'));
    const electron = planElectronTests(path.join(repositoryRoot, 'packages/electron'), {});
    assert.ok(electron.node.includes('tests/isolation-canary.test.mjs') && electron.bun.includes('tests/isolation-canary-bun.test.mjs'));
    assert.ok(discoverUiTestFiles(path.join(repositoryRoot, 'packages/ui')).includes('src/test/isolation-canary.test.mjs'));
    assert.equal(vitestCollectedFiles().find((entry) => entry.file === 'test/isolation-canary.test.mjs')?.project, 'web');
    assert.equal(vitestCollectedFiles().find((entry) => entry.file === 'server/lib/opencode/runtime-host/isolation-canary.test.mjs')?.project, 'web-runtime-host');
    assert.ok(webRunnerLists().native.includes('test/isolation-canary-native.test.mjs'));
    for (const [directory, file] of [['shared-runtime', 'testing/isolation-canary.test.js'], ['harness-runtime', 'test/isolation-canary.test.js'],
      ['orchestration-runtime', 'isolation-canary.test.js'], ['cursor-sdk-runtime', 'isolation-canary.test.js'], ['agents-core', 'test/isolation-canary.test.mjs']]) {
      assert.ok(discoverTestFiles(path.join(repositoryRoot, 'packages', directory), path.join(repositoryRoot, 'packages', directory)).includes(file), `${directory} collects ${file}`);
    }
  });
});
