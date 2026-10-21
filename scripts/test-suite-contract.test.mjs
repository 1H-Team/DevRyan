import { CI_LANES, ciTestInventory, requiresMac, MAC_WEB_TESTS } from './test-ci-lanes.mjs';
import { testCaseShard } from './test-case-shard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { FEATURE_TEST_MATRIX } from './feature-test-matrix.mjs';
import { discoverElectronTestFiles } from './test-electron.mjs';
import { discoverScriptTestFiles, planScriptTests } from './test-scripts.mjs';
import { FULL_TEST_COMMANDS, FULL_TEST_SUITES, HARNESS_WORKERS, WEB_VITEST_PROJECTS, planFullTests } from './test-full.mjs';
import { buildPlan, testUnitsForPlan } from './validate.mjs';
import { discoverTestFiles } from './test-runner-utils.mjs';
import { discoverUiTestFiles } from './test-ui.mjs';
import { STARTUP_CONTRACT_GROUPS } from './test-startup-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('full test-suite contract', () => {
  test('discovers every repository script test, including release verification', () => {
    const files = discoverScriptTestFiles(repositoryRoot);
    assert.ok(files.includes('scripts/verify-release-assets.test.mjs'));
    assert.ok(files.includes('scripts/verify-bot-runtime-images.test.mjs'));
    assert.ok(files.includes('scripts/test-suite-contract.test.mjs'));
    assert.ok(files.includes('scripts/opencode-v2-native/bootstrap.test.ts'));
    // agents-core tests run once, through their own package (test:full, validate).
    assert.ok(!files.some(file => file.startsWith('packages/agents-core/')));
    const web = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/web/package.json'), 'utf8'));
    assert.equal(web.scripts.test, 'bun run test:vitest && bun run test:native');
    const vitestConfig = readFileSync(path.join(repositoryRoot, 'packages/web/vitest.config.ts'), 'utf8');
    assert.ok(vitestConfig.includes("'runtime/reviewed-inputs/**'"));
    for (const file of ['server/lib/opencode/runtime-host/native-helper.test.js', 'server/lib/opencode/runtime-host/native-retention-quiet.test.ts', 'server/lib/opencode/runtime-host/native-queued-input.test.ts']) {
      assert.ok(vitestConfig.includes(`'${file}'`), `${file} stays out of Vitest`);
      assert.ok(web.scripts['test:native'].startsWith('bun test ') && web.scripts['test:native'].split(' ').includes(file));
    }
    assert.deepEqual(files, [...files].sort());
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
    assert.ok(FULL_TEST_COMMANDS.includes('bun run test:visual-fixture'));
    assert.equal(rootPackage.scripts['test:visual-fixture'], 'bun test tests/visual-production-bots/matrix.test.mjs');

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
      'packages/bot-computer/',
      'packages/bot-db/',
      'packages/bot-engine-proxy/',
      'packages/bot-egress/',
      'packages/bot-indexer/',
      'packages/bot-supervisor/',
      'packages/bots-runtime/',
      'packages/cursor-sdk-runtime/',
      'packages/desktop/',
      'packages/electron/',
      'packages/harness-runtime/',
      'packages/orchestration-runtime/',
      'packages/shared-runtime/',
      'packages/ui/',
      'packages/web/',
      'tests/visual-production-bots/',
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
        assert.equal(unit.resource, 'native-oauth-callback:1455', `${file} shares the native callback port`);
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
    // Harness: the package's own `bun test`, with file workers.
    const harness = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/harness-runtime/package.json'), 'utf8'));
    assert.equal(harness.scripts.test, 'bun test');
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
    assert.equal(workflow.jobs.tests.needs, 'build');
    assert.deepEqual(workflow.jobs['native-tests'].needs, ['build', 'native-runtime']);
    for (const job of testJobs) {
      assert.equal(job.strategy['fail-fast'], false);
      assert.ok(job.steps.some(step => step.run === 'node scripts/validate.mjs ci:${{ matrix.lane }}'));
      assert.equal(job.env.DEVRYAN_TEST_SEED, '${{ github.run_id }}');
    }
    assert.ok(workflow.jobs.static.steps.some(step => step.run === 'node scripts/validate.mjs static'));
    assert.ok(workflow.jobs.build.steps.some(step => step.run === 'node scripts/validate.mjs build'));
    const nonTest = buildPlan('full').commands.filter(item => item.label !== 'test:full').map(item => item.label);
    assert.deepEqual(buildPlan('checks').commands.map(item => item.label), nonTest);
    assert.deepEqual([...buildPlan('static').commands, ...buildPlan('build').commands].map(item => item.label).sort(), [...nonTest].sort());
    const nativeUpload = workflow.jobs['native-runtime'].steps.find(step => step.uses === 'actions/upload-artifact@v4').with;
    assert.ok(workflow.jobs['native-tests'].steps.some(step => step.uses === 'actions/download-artifact@v4' && step.with.name === nativeUpload.name));
    assert.ok(workflow.jobs['native-runtime'].steps.some(step => step.run === 'bun scripts/build-native-runtime.mjs'));
    const key = unit => JSON.stringify([unit.name, unit.command, unit.args, unit.cwd]);
    const laneUnits = CI_LANES.flatMap(lane => testUnitsForPlan(buildPlan(`ci:${lane}`).commands));
    assert.deepEqual(laneUnits.map(key).sort(), ciTestInventory(repositoryRoot).map(unit => key({ ...unit, cwd: unit.cwd ?? repositoryRoot })).sort());
    assert.equal(new Set(laneUnits.map(unit => unit.name)).size, laneUnits.length);
    for (const lane of CI_LANES) for (const unit of testUnitsForPlan(buildPlan(`ci:${lane}`).commands)) {
      assert.equal(requiresMac(unit), lane.startsWith('native'), unit.name);
    }
    const scriptFiles = laneUnits.filter(unit => unit.suite === 'scripts').flatMap(unit => unit.args.filter(arg => /test\.[cm]?[jt]sx?$/.test(arg)).map(arg => arg.replace(/^\.\//, '')));
    assert.deepEqual([...new Set(scriptFiles)].sort(), discoverScriptTestFiles(repositoryRoot));
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
      for (const unit of laneUnits.filter(unit => unit.name.startsWith('web:vitest'))) assert.ok(unit.args.includes(file));
    }
    const split = new Set(['scripts', 'harness', 'web']);
    assert.deepEqual(laneUnits.filter(unit => !split.has(unit.suite)).map(key).sort(),
      testUnitsForPlan(buildPlan('full').commands).filter(unit => !split.has(unit.suite)).map(key).sort());
    assert.throws(() => buildPlan('ci:unknown'), /Unknown CI test lane/);
    const upload = workflow.jobs.build.steps.find(step => step.uses === 'actions/upload-artifact@v4').with;
    for (const job of testJobs) {
      const download = job.steps.find(step => step.uses === 'actions/download-artifact@v4' && step.with.name === upload.name).with;
      assert.equal(download.path, 'packages');
    }
    for (const directory of ['packages/web/dist/', 'packages/electron/resources/web-dist/', 'packages/electron/dist-bundle/']) assert.ok(upload.path.split('\n').includes(directory));
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
    const web = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/web/package.json'), 'utf8'));
    const webExcludes = [...web.scripts['test:vitest'].matchAll(/--exclude '([^']+)'/g)].map((match) => match[1]);
    for (const group of STARTUP_CONTRACT_GROUPS) {
      assert.ok(files(group).length > 0, group.name);
      for (const file of files(group)) {
        if (group.owner in discovered) assert.ok(discovered[group.owner].has(file), `${file} is not discovered by the ${group.owner} suite`);
        else if (group.owner === 'web') {
          assert.ok(existsSync(path.join(repositoryRoot, 'packages/web', file)), file);
          assert.ok(!webExcludes.some((pattern) => pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern), `${file} is excluded from web test:vitest`);
        } else {
          // shared-runtime and harness-runtime run plain `bun test` over their package.
          const directory = { shared: 'packages/shared-runtime', harness: 'packages/harness-runtime' }[group.owner];
          assert.equal(JSON.parse(readFileSync(path.join(repositoryRoot, directory, 'package.json'), 'utf8')).scripts.test, 'bun test');
          assert.ok(file.startsWith(`${directory}/`) && existsSync(path.join(repositoryRoot, file)), file);
        }
      }
    }
  });

  test('contains no silent skip or todo declarations in deterministic tests', () => {
    const files = discoverTestFiles(repositoryRoot, repositoryRoot, {
      ignoredDirectories: new Set(['.git', '.cache', '.worktrees', 'node_modules', 'dist', 'dist-bundle', 'target', 'resources']),
    }).filter((file) => file !== 'scripts/test-suite-contract.test.mjs');
    const forbidden = new RegExp(String.raw`\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\bskip\s*:`);
    const offenders = files.filter((file) => forbidden.test(readFileSync(path.join(repositoryRoot, file), 'utf8')));
    assert.deepEqual(offenders, []);
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
