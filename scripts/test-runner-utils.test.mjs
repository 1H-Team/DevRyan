import assert from 'node:assert/strict';
import YAML from 'yaml';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bunTestArgs, bunTestWorkers, discoverTestFiles, isBunTestSource } from './test-runner-utils.mjs';
import { discoverElectronTestFiles, planElectronTests } from './test-electron.mjs';
import { discoverScriptTestFiles } from './test-scripts.mjs';
import { FULL_TEST_COMMANDS, FULL_TEST_SUITES } from './test-full.mjs';
import { buildPlan, describeScriptSelection, isVersionOnlyChange, lintRoots, testUnitsForPlan } from './validate.mjs';
import { STARTUP_CONTRACT_GROUPS } from './test-startup-contract.mjs';

const repoRoot = new URL('..', import.meta.url);

describe('script framework dispatch', () => {
  test('keeps Node tests that generate Bun fixtures in the real Node runner', () => {
    assert.equal(isBunTestSource(readFileSync(new URL(import.meta.url), 'utf8')), false);
    assert.equal(isBunTestSource("import { test } from 'node:test'; const fixture = `import { test } from 'bun:test';`;"), false);
    assert.equal(isBunTestSource("import { test } from 'bun:test';"), true);
    assert.equal(isBunTestSource("import { test } from 'node:test';"), false);
  });

  test('isolates discovered Bun paths and propagates their failures', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-script-runner-'));
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { runScriptTests } from ${JSON.stringify(new URL('./test-scripts.mjs', import.meta.url).href)}; process.exit(await runScriptTests(process.argv[1]));`, root],
    { encoding: 'utf8', env: environment });
    try {
      mkdirSync(path.join(root, 'scripts'));
      mkdirSync(path.join(root, 'unowned/scripts'), { recursive: true });
      writeFileSync(path.join(root, 'scripts/selected.test.mjs'), "import { test } from 'bun:test'; test('selected', () => {});");
      writeFileSync(path.join(root, 'scripts/a.fixture.test.mjs'), "import { test, expect } from 'bun:test'; globalThis.devryanRunnerFixture = 'owned'; test('own process state', () => expect(globalThis.devryanRunnerFixture).toBe('owned'));");
      writeFileSync(path.join(root, 'scripts/b.fixture.test.mjs'), "import { test, expect } from 'bun:test'; test('fresh process state', () => expect(globalThis.devryanRunnerFixture).toBeUndefined());");
      writeFileSync(path.join(root, 'unowned/scripts/selected.test.mjs'), "import { test } from 'bun:test'; test('undiscovered', () => { throw Error('undiscovered_test_executed'); });");
      const passing = run();
      assert.equal(passing.status, 0, passing.stdout + passing.stderr);
      assert.doesNotMatch(passing.stdout + passing.stderr, /undiscovered_test_executed/);
      writeFileSync(path.join(root, 'scripts/selected.test.mjs'), "import { test } from 'bun:test'; test('selected failure', () => { throw Error('selected_test_failed'); });");
      const failing = run();
      assert.notEqual(failing.status, 0);
      assert.match(failing.stdout + failing.stderr, /selected_test_failed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Bun package runs', () => {
  test('give each package run the cores the outer pool leaves it, at least two workers', () => {
    // The default outer pool on 16 cores is 4 (defaultTestConcurrency).
    assert.equal(bunTestWorkers({}, 16), 4);
    assert.equal(bunTestWorkers({}, 8), 2);
    assert.equal(bunTestWorkers({ DEVRYAN_TEST_CONCURRENCY: '4' }, 16), 4);
    assert.equal(bunTestWorkers({ DEVRYAN_TEST_CONCURRENCY: '4' }, 4), 2);
    assert.equal(bunTestWorkers({ DEVRYAN_TEST_WORKERS: '3' }, 16), 3);
    assert.throws(() => bunTestWorkers({ DEVRYAN_TEST_WORKERS: '0' }, 16), /DEVRYAN_TEST_WORKERS/);
  });

  test('randomize order only with a reproducible seed', () => {
    assert.deepEqual(bunTestArgs(['src'], { DEVRYAN_TEST_WORKERS: '2' }), ['test', '--parallel=2', 'src']);
    assert.deepEqual(bunTestArgs(['src'], { DEVRYAN_TEST_WORKERS: '2', DEVRYAN_TEST_SEED: '42' }), ['test', '--parallel=2', '--randomize', '--seed=42', 'src']);
    assert.throws(() => bunTestArgs(['src'], { DEVRYAN_TEST_SEED: 'x' }), /DEVRYAN_TEST_SEED/);
    assert.throws(() => bunTestArgs(['src'], { DEVRYAN_TEST_SEED: '39673413952' }), /DEVRYAN_TEST_SEED/);
  });
});

describe('test file discovery', () => {
  test('keeps the requested Git root and normal nested tests while excluding descendant checkouts', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-test-discovery-'));
    try {
      mkdirSync(path.join(root, '.git'));
      mkdirSync(path.join(root, 'tests/nested'), { recursive: true });
      mkdirSync(path.join(root, 'nested-checkout/.git'), { recursive: true });
      mkdirSync(path.join(root, 'nested-worktree/tests'), { recursive: true });
      writeFileSync(path.join(root, '.git/metadata.test.mjs'), '');
      writeFileSync(path.join(root, 'root.test.mjs'), '');
      writeFileSync(path.join(root, 'tests/nested/ordinary.test.mjs'), '');
      writeFileSync(path.join(root, 'nested-checkout/foreign.test.mjs'), '');
      writeFileSync(path.join(root, 'nested-worktree/.git'), 'gitdir: /unused/fixture-only\n');
      writeFileSync(path.join(root, 'nested-worktree/tests/foreign.test.mjs'), '');

      assert.deepEqual(discoverTestFiles(root, root), ['root.test.mjs', 'tests/nested/ordinary.test.mjs']);
      assert.deepEqual(discoverTestFiles(path.join(root, 'nested-worktree'), root), ['nested-worktree/tests/foreign.test.mjs'],
        'An explicitly selected checkout remains its own test root');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('discovers nested test files relative to the package root', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-tests-'));
    try {
      mkdirSync(path.join(root, 'tests/nested'), { recursive: true });
      writeFileSync(path.join(root, 'tests/example.test.ts'), '');
      writeFileSync(path.join(root, 'tests/nested/another.test.ts'), '');
      writeFileSync(path.join(root, 'tests/nested/helper.ts'), '');

      assert.deepEqual(discoverTestFiles(path.join(root, 'tests'), root), [
        'tests/example.test.ts',
        'tests/nested/another.test.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  test('discovers repository script tests recursively', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-script-tests-'));
    try {
      mkdirSync(path.join(root, 'scripts/nested'), { recursive: true });
      mkdirSync(path.join(root, '.opencode/plugins/nested'), { recursive: true });
      writeFileSync(path.join(root, 'scripts/top.test.mjs'), '');
      writeFileSync(path.join(root, 'scripts/nested/release.test.mjs'), '');
      writeFileSync(path.join(root, 'scripts/nested/helper.mjs'), '');
      writeFileSync(path.join(root, '.opencode/plugins/nested/project.test.mjs'), '');

      assert.deepEqual(discoverScriptTestFiles(root), [
        '.opencode/plugins/nested/project.test.mjs',
        'scripts/nested/release.test.mjs',
        'scripts/top.test.mjs',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discovers Electron tests recursively while excluding packaged output', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-electron-tests-'));
    try {
      mkdirSync(path.join(root, 'tests/nested'), { recursive: true });
      mkdirSync(path.join(root, 'dist'), { recursive: true });
      writeFileSync(path.join(root, 'startup.test.mjs'), '');
      writeFileSync(path.join(root, 'tests/nested/browser.test.mjs'), '');
      writeFileSync(path.join(root, 'dist/packaged.test.mjs'), '');

      assert.deepEqual(discoverElectronTestFiles(root), [
        'startup.test.mjs',
        'tests/nested/browser.test.mjs',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Electron framework dispatch', () => {
  test('uses real Node for nested tests and isolates Bun module mocks from sibling suites', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-electron-runner-'));
    const environment = { ...process.env, DEVRYAN_RUN_DMG_INSTALLER_NATIVE_TESTS: '' };
    delete environment.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { runElectronTests } from ${JSON.stringify(new URL('./test-electron.mjs', import.meta.url).href)}; process.exit(runElectronTests(process.argv[1]));`, root],
    { encoding: 'utf8', env: environment });
    try {
      mkdirSync(path.join(root, 'tests'));
      writeFileSync(path.join(root, 'nested.test.mjs'), `import assert from 'node:assert/strict'; import { test } from 'node:test';
        test('native node subtests', async t => { assert.equal(process.versions.bun, undefined); await t.test('child', () => assert.ok(true)); });`);
      writeFileSync(path.join(root, 'shared.mjs'), 'export const value = "original";');
      writeFileSync(path.join(root, 'a.mock.test.mjs'), `import { test, expect, mock } from 'bun:test';
        mock.module('./shared.mjs', () => ({ value: 'mocked' }));
        test('mock', async () => expect((await import('./shared.mjs')).value).toBe('mocked'));`);
      writeFileSync(path.join(root, 'b.clean.test.mjs'), `import { test, expect } from 'bun:test'; import { value } from './shared.mjs';
        test('clean import', () => expect(value).toBe('original'));`);
      writeFileSync(path.join(root, 'tests/desktop-update-install-native.test.mjs'), `import { test } from 'node:test';
        test('explicit macOS native prerequisite', () => { throw new Error('Native acceptance was not requested'); });`);
      const plan = planElectronTests(root, {});
      assert.deepEqual(plan.node, ['nested.test.mjs']);
      // One parallel Bun run isolates each file, so the mock cannot reach b.clean.
      assert.deepEqual(plan.bun, ['a.mock.test.mjs', 'b.clean.test.mjs']);
      assert.deepEqual(plan.optional, ['tests/desktop-update-install-native.test.mjs']);
      assert.ok(planElectronTests(root, { DEVRYAN_RUN_DMG_INSTALLER_NATIVE_TESTS: '1' }).node.includes('tests/desktop-update-install-native.test.mjs'));
      const passing = run();
      assert.equal(passing.status, 0, passing.stdout + passing.stderr);
      assert.match(passing.stdout, /Native DMG installer acceptance is a separate opt-in gate/);
      writeFileSync(path.join(root, 'nested.test.mjs'), `import { test } from 'node:test'; test('failure propagates', () => { throw new Error('expected fixture failure'); });`);
      assert.notEqual(run().status, 0, 'A failing framework must fail the combined runner');
      writeFileSync(path.join(root, 'splash.test.mjs'), "import { test } from 'vitest'; test('splash', () => {});");
      assert.throws(() => planElectronTests(root, {}), /No supported test framework declared in splash\.test\.mjs/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('release workflow', () => {
  test('test:full runs the suite inventory through the concurrent runner', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));
    assert.equal(packageJson.scripts['test:full'], 'node scripts/test-full.mjs');
  });

  test('overlaps release preparation without weakening qualification or publication', async () => {
    const workflow = YAML.parse(readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8'));
    for (const job of ['bot-resolve', 'bot-build', 'bot-publish', 'electron-prepare']) assert.equal(workflow.jobs[job], undefined);
    assert.ok(!JSON.stringify(workflow).includes('ci-built-assets'));
    assert.ok(!JSON.stringify(workflow).includes('prepare-export'));
    assert.ok(!JSON.stringify(workflow).includes('prepare-import'));
    assert.equal(workflow.jobs.web['runs-on'], 'ubuntu-latest');
    assert.equal(workflow.jobs.web.steps.find(step => step.run?.includes('bun run build:web')).env.VITE_ENABLE_REACT_SCAN, 'false');
    assert.ok(workflow.jobs['electron-package'].steps.some((step) => step.run === "bun install --frozen-lockfile --cpu '*' --os darwin"));
    const packaging = workflow.jobs['electron-package'].steps.find((step) => step.name === 'Package the app');
    assert.equal(packaging.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.match(packaging.run, /-c\.mac\.identity=null -c\.mac\.notarize=false -c\.dmg\.sign=false/);

    // Nothing is staged, let alone published, until the packaged candidate upgrades a profile made by the previous supported release.
    assert.ok(workflow.jobs.release.needs.includes('upgrade-check'));
    assert.match(workflow.jobs.release.if, /needs\.upgrade-check\.result == 'success'/);
    assert.equal(workflow.concurrency, undefined, 'workflow cancellation must not interrupt production');
    assert.equal(workflow.jobs.release.concurrency['cancel-in-progress'], false);
    assert.equal(workflow.jobs.release.concurrency.group, 'devryan-production-publication');
    assert.equal(workflow.jobs.release.env.RELEASE_PUBLICATION_LOCK, workflow.jobs.release.concurrency.group);
    assert.equal(workflow.jobs.preflight.permissions.contents, 'read', 'preflight cannot change releases');
    assert.ok(!workflow.jobs.preflight.steps.some(step => step.run === 'node scripts/release.mjs trusted-ci'));
    assert.ok(workflow.jobs['trusted-ci'].steps.some(step => step.run === 'node scripts/release-ci-wait.mjs'));
    assert.equal(workflow.jobs['trusted-ci'].concurrency, undefined);
    // Exact-source CI is rechecked inside the lock by `release.mjs release`, between stage and promotion.
    assert.ok(workflow.jobs.release.needs.includes('trusted-ci'));
    assert.equal(workflow.jobs.release.steps.filter(step => step.run === 'node scripts/release.mjs release').length, 1);
    assert.match(workflow.jobs['verify-published'].if, /outputs.published == 'true'/);
    assert.equal(workflow.jobs['verify-published'].steps.find(step => step.uses === 'actions/download-artifact@v4').with['run-id'], '${{ needs.preflight.outputs.candidate_run_id }}');
    for (const name of ['web', 'electron-package', 'upgrade-check']) assert.match(workflow.jobs[name].if, /outputs.published != 'true'/);
    // Every required lane (scripts/qa/release-upgrade-lanes.mjs REQUIRED_UPGRADE_LANES) in one job, never a subset.
    const upgrade = workflow.jobs['upgrade-check'];
    assert.equal(upgrade.strategy, undefined);
    assert.equal(upgrade.needs, 'preflight');
    assert.equal(upgrade.permissions.actions, 'read');
    assert.ok(upgrade.steps.some(step => step.run === 'node scripts/qa/release-preaged-upgrades.mjs "$RUNNER_TEMP/release-reports"'));
    const fallback = upgrade.steps.find((step) => step.run?.includes('--fallback-reports'));
    assert.equal(fallback.if, '${{ always() }}');
    assert.equal(upgrade.steps.filter((step) => step.uses === 'actions/download-artifact@v4').length, 0);
    // Release builds reuse exact-source CI's type-check instead of repeating it.
    assert.ok(!workflow.jobs.web.steps.some((step) => /type-check/.test(step.run ?? '')));
    assert.equal(workflow.jobs['final-dmg-smoke'], undefined, 'visual qualification owns the GUI smoke');
    assert.equal(workflow.jobs['visual-qa']['continue-on-error'], undefined);
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) {
      if (step.uses === 'actions/upload-artifact@v4') assert.equal(step.with['retention-days'],
        ['DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-candidate-identity', 'release-upgrade', 'release-staged', 'release-installed-upgrades', 'release-installed-public-upgrades'].includes(step.with.name) ? 90 : 14);
    }
    const ci = YAML.parse(readFileSync(new URL('.github/workflows/ci.yml', repoRoot), 'utf8'));
    // Native macOS lanes each build the native runtime in-lane.
    const nativeCI = ci.jobs['native-tests'].strategy.matrix.include.filter(row => row.runner === 'macos-26').length;
    assert.equal(ci.jobs['native-tests'].needs, undefined);
    assert.equal(nativeCI, 3);
    // electron-package runs on macOS unless it adopts a DMG already built at the same SHA.
    assert.deepEqual(Object.entries(workflow.jobs).filter(([, job]) => String(job['runs-on']).includes('macos-26')).map(([name]) => name), ['electron-package', 'upgrade-check', 'visual-qa']);
    assert.ok(workflow.jobs['visual-qa'].needs.includes('electron-package'));
    // GitHub Free runs at most five macOS jobs at once. A release holds two (package
    // and qualification; on a dry run visual QA replaces package) while it waits for CI.
    assert.ok(nativeCI + 2 <= 5, 'CI macOS lanes plus the release macOS jobs fit the Free plan macOS concurrency');
    assert.ok(ci.jobs.tests.strategy.matrix.include.length + nativeCI + 3 <= 9, 'CI workers plus package, qualification and CI wait stay within the total limit');
    assert.equal(YAML.parse(readFileSync(new URL('.github/workflows/release-cache.yml', repoRoot), 'utf8')).on.push, undefined);
    assert.ok(!JSON.stringify(workflow).includes('devryan_bot_schema_version'));
    assert.ok(!JSON.stringify(workflow).includes('PRODUCTION_BOTS_MIGRATION'));

    // Deploy the backend in its own job before the lock, then stage and publish in one locked job.
    assert.equal(workflow.jobs.release.steps.find(step => step.id === 'release').run, 'node scripts/release.mjs release');
    const backend = workflow.jobs['deploy-backend'];
    assert.ok(!backend.needs.includes('release') && workflow.jobs.release.needs.includes('deploy-backend'), 'order: deploy Supabase, then stage and publish');
    assert.match(backend.if, /github\.event_name == 'push'/);
    const supabase = backend.steps.find(step => step.name?.startsWith('Deploy and verify Supabase'));
    assert.match(supabase.run, /node scripts\/sync-supabase-auth-password-policy\.mjs\n\s*supabase db push --linked --dry-run/);
    assert.equal(workflow.jobs['post-publish-verify'].steps.at(-1).run, 'node scripts/release-verify-public.mjs "v${{ needs.preflight.outputs.version }}"');
  });
});

describe('maintenance validation selection', () => {
  test('checks documentation without running unrelated code suites', () => {
    assert.deepEqual(buildPlan('fast', ['docs/TESTING.md']).commands.map(c => c.label), ['docs:validate', 'test:scripts']);
    assert.deepEqual(buildPlan('fast', []).commands.map(c => c.label), ['test:startup']);
  });

  test('always ends a code change with the startup contract', () => {
    for (const file of ['packages/ui/src/lib/format.ts', 'scripts/release.mjs', 'packages/shared-runtime/safe-archive.js']) {
      assert.equal(buildPlan('fast', [file]).commands.at(-1).label, 'test:startup', file);
    }
  });

  test('treats shipped and project agent prompts as executable configuration', () => {
    assert.ok(buildPlan('fast', ['packages/web/server/default-config/agents/explorer.md']).commands.some(c => c.label === 'test:web'));
    assert.ok(buildPlan('fast', ['packages/web/server/lib/agent-browser/assets/agent-browser/SKILL.md']).commands.some(c => c.label === 'test:web'));
    assert.ok(buildPlan('fast', ['.opencode/agents/explorer.md']).commands.some(c => c.label === 'test:scripts'));
    assert.ok(buildPlan('fast', ['.opencode/plugins/orchestrator-autoresume.mjs']).commands.some(c => c.label === 'test:scripts'));
  });

  test('runs the scripts suite for script and workflow changes instead of everything', () => {
    for (const file of ['scripts/release.mjs', '.github/workflows/release.yml']) {
      const labels = buildPlan('fast', [file]).commands.map(c => c.label);
      assert.ok(labels.includes('test:scripts'), file);
      assert.ok(!labels.includes('test:full'), file);
    }
  });

  test('selects script tests by import graph: a leaf script schedules its tests, a shared helper its importers', () => {
    const all = discoverScriptTestFiles();
    const scriptsCommand = file => buildPlan('fast', [file]).commands.find(c => c.label === 'test:scripts');
    const scheduled = command => testUnitsForPlan([command]).flatMap(unit => unit.args.filter(arg => /test\.[cm]?[jt]sx?$/.test(arg))).map(arg => arg.replace(/^\.\//, '')).sort();
    const leaf = scriptsCommand('scripts/release-ci-wait.mjs');
    assert.ok(leaf.tests.includes('scripts/release-ci-wait.test.mjs'));
    assert.ok(leaf.tests.length < all.length / 10, `${leaf.tests.length} tests`);
    assert.ok(!leaf.tests.some(file => /\.graph\.test\./.test(file)));
    assert.deepEqual(scheduled(leaf), leaf.tests);
    // Every script test that names the helper's path is scheduled, and not the whole suite.
    const helper = scriptsCommand('scripts/qa/run-root.mjs');
    const importers = all.filter(file => /['"][^'"]*\/run-root\.mjs['"]/.test(readFileSync(new URL(file, repoRoot), 'utf8')));
    assert.ok(importers.length > 3);
    for (const file of importers) assert.ok(helper.tests.includes(file), file);
    assert.ok(helper.tests.length < all.length);
    assert.deepEqual(scheduled(helper), helper.tests);
    // A subset leaves the startup contract's scripts group to run; the whole suite covers it.
    const subset = buildPlan('fast', ['scripts/release-ci-wait.mjs']);
    assert.deepEqual(subset.commands.at(-1).coveredBy, []);
    const lines = describeScriptSelection(subset.scriptSelection, all.length);
    assert.ok(lines.length <= 2);
    assert.match(lines[0], new RegExp(`^Script tests: ${leaf.tests.length} of ${all.length} selected`));
    assert.match(lines[1], /scripts\/release-ci-wait\.mjs: \d+ reaching it.*CI runs every script test/);
    for (const file of ['scripts/validate.mjs', 'scripts/test-select.mjs', 'scripts/test-pool.mjs', 'bun.lock']) {
      const plan = buildPlan('fast', [file]);
      assert.equal(plan.commands.find(c => c.label === 'test:scripts').tests, undefined, file);
      assert.ok(plan.commands.at(-1).coveredBy.includes('scripts'), file);
      assert.deepEqual(scheduled(plan.commands.find(c => c.label === 'test:scripts')), [...all].sort(), file);
    }
  });

  test('runs the script tests that read every tracked Markdown file for any Markdown change', () => {
    const scriptTests = files => buildPlan('fast', files).commands.find(c => c.label === 'test:scripts')?.tests;
    // docs:validate does not check the release-docs rule, so a docs-only change runs that test too.
    const docsOnly = buildPlan('fast', ['docs/RELEASE_PIPELINE.md']);
    assert.deepEqual(docsOnly.commands.map(c => c.label), ['docs:validate', 'test:scripts']);
    assert.deepEqual(scriptTests(['docs/RELEASE_PIPELINE.md']), ['scripts/release-docs.test.mjs', 'scripts/toolchain-pins.test.mjs']);
    assert.deepEqual(testUnitsForPlan(docsOnly.commands.filter(c => c.label === 'test:scripts')).flatMap(unit => unit.args.filter(arg => arg.endsWith('.test.mjs'))),
      ['scripts/release-docs.test.mjs', 'scripts/toolchain-pins.test.mjs']);
    // Mixed with code: the graph's selection plus the Markdown readers.
    for (const [code, markdown] of [['scripts/release.mjs', 'docs/RELEASE_PIPELINE.md'], ['scripts/release-ci-wait.mjs', 'scripts/perf/INTERACTIVE.md']]) {
      const tests = scriptTests([code, markdown]);
      assert.ok(tests.includes('scripts/release-docs.test.mjs'), code);
      for (const test of scriptTests([code])) assert.ok(tests.includes(test), `${code}: ${test}`);
    }
    // Markdown beside a change that runs no script tests still adds them; the startup scripts group stays.
    const ui = buildPlan('fast', ['packages/ui/src/App.tsx', 'README.md']);
    assert.deepEqual(ui.commands.find(c => c.label === 'test:scripts').tests, ['scripts/release-docs.test.mjs', 'scripts/toolchain-pins.test.mjs']);
    assert.ok(!ui.commands.at(-1).coveredBy.includes('scripts'));
    assert.match(describeScriptSelection(ui.scriptSelection, 295)[1], /README\.md: 2 reading every tracked Markdown file/);
    // The rule skips the changelog (history), so a changelog-only change runs none.
    assert.equal(scriptTests(['CHANGELOG.md']), undefined);
    // No script test reads tracked .txt files, so a text-only change runs none (docs:validate runs for every change).
    assert.deepEqual(buildPlan('fast', ['scripts/notes.txt']).commands.map(c => c.label), ['docs:validate']);
  });

  test('runs the whole scripts suite in full mode and CI lanes, whatever changed', () => {
    for (const mode of ['full', 'ci:portable-1']) {
      const plan = buildPlan(mode, ['scripts/release-ci-wait.mjs']);
      assert.equal(plan.scriptSelection, undefined, mode);
      assert.ok(!plan.commands.some(c => c.tests), mode);
    }
  });

  test('includes shared-runtime behavior and its web dependent', () => {
    const labels = buildPlan('fast', ['packages/shared-runtime/safe-archive.js']).commands.map(c => c.label);
    assert.ok(labels.includes('test:shared'));
    assert.ok(labels.includes('test:web'));
  });

  test('runs the legacy desktop JavaScript contract for its source and test', () => {
    for (const file of [
      'packages/desktop/src-tauri/resources/default-config/plugins/devryan-managed-orchestration.mjs',
      'packages/desktop/scripts/devryan-managed-orchestration.test.mjs',
    ]) {
      const plan = buildPlan('fast', [file]);
      const testCommands = plan.commands.filter((entry) => entry.label.startsWith('test:'));
      // A test file change also runs the suite contract, which inventories every test file.
      const contract = file.endsWith('.test.mjs');
      assert.deepEqual(testCommands.map((entry) => entry.label), ['test:desktop', ...(contract ? ['test:scripts'] : []), 'test:startup'], file);
      // The desktop suite owns no startup group, so the whole startup contract runs too.
      assert.deepEqual(testUnitsForPlan(testCommands).map((unit) => [unit.command, unit.args]), [
        ['bun', ['run', '--cwd', 'packages/desktop', 'test:managed-orchestration']],
        ...(contract ? [[process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=300000', '--test-force-exit', 'scripts/test-suite-contract.test.mjs']]] : []),
        ...STARTUP_CONTRACT_GROUPS.map((group) => [group.command, group.args]),
      ], file);
    }
  });

  test('lints and type-checks everything for shared configuration, and re-tests a package for its own manifest', () => {
    for (const file of ['package.json', 'bun.lock', '.opencode/opencode.json']) {
      const labels = buildPlan('fast', [file]).commands.map(c => c.label);
      assert.ok(labels.includes('lint:full') && labels.includes('type-check:full'), file);
    }
    assert.ok(buildPlan('fast', ['packages/ui/package.json']).commands.some(c => c.label === 'test:ui'));
  });

  test('checks import boundaries for changed package code, and every importer when a manifest or the exception list changes', () => {
    const boundaries = files => buildPlan('fast', files).commands.find(c => c.label === 'import-boundaries')?.args;
    assert.deepEqual(boundaries(['packages/ui/src/App.tsx', 'docs/TESTING.md']), ['scripts/check-import-boundaries.mjs', '--files', 'packages/ui/src/App.tsx']);
    for (const file of ['packages/shared-runtime/package.json', 'scripts/import-boundaries.json', 'scripts/check-browser-graph.mjs']) {
      assert.deepEqual(boundaries([file]), ['scripts/check-import-boundaries.mjs'], file);
      assert.ok(buildPlan('fast', [file]).commands.some(c => c.label === 'browser-graph'), file);
    }
    assert.equal(boundaries(['scripts/release.mjs']), undefined);
  });

  test('checks unreached browser files for package code, tests and the allowlist, and declaration parity for JavaScript and declarations', () => {
    const labels = files => buildPlan('fast', files).commands.map(c => c.label);
    for (const file of ['packages/ui/src/App.tsx', 'packages/ui/package.json', 'scripts/check-browser-graph.mjs', 'scripts/unreached-files.json',
      'scripts/check-unreached-files.mjs', 'tests/visual-reasoning/main.tsx', 'scripts/release.test.mjs']) {
      assert.ok(labels([file]).includes('unreached-files'), file);
    }
    // The allowlist, checker or a test outside packages/ alone does not re-run the boundary checks.
    for (const file of ['scripts/unreached-files.json', 'scripts/release.test.mjs']) assert.ok(!labels([file]).includes('import-boundaries'), file);
    assert.ok(!labels(['scripts/release.mjs']).includes('unreached-files'));
    assert.deepEqual(buildPlan('fast', ['scripts/unreached-files.json']).commands.find(c => c.label === 'unreached-files').args, ['scripts/check-unreached-files.mjs']);
    for (const file of ['packages/harness-runtime/index.js', 'packages/harness-runtime/index.d.ts', 'scripts/native-runtime-assets.d.mts', 'scripts/release.mjs',
      'packages/shared-runtime/package.json', 'scripts/declaration-parity.json', 'scripts/check-declarations.mjs']) {
      assert.ok(labels([file]).includes('declarations'), file);
    }
    for (const file of ['packages/ui/src/App.tsx', 'packages/agents-core/src/agents/registry.ts']) assert.ok(!labels([file]).includes('declarations'), file);
    assert.deepEqual(buildPlan('fast', ['scripts/check-declarations.mjs']).commands.find(c => c.label === 'declarations').args, ['scripts/check-declarations.mjs']);
  });

  test('validates docs for every change, because docs:validate reads manifests, source exports and environment variables', () => {
    for (const file of ['packages/ui/src/App.tsx', 'packages/web/server/index.js', 'scripts/release.mjs', 'packages/shared-runtime/package.json', 'bun.lock', 'scripts/notes.txt']) {
      const docs = buildPlan('fast', [file]).commands.find(c => c.label === 'docs:validate');
      assert.deepEqual(docs && [docs.executable, ...docs.args], ['bun', 'run', 'docs:validate'], file);
    }
    assert.ok(!buildPlan('fast', []).commands.some(c => c.label === 'docs:validate'));
  });

  test('selects every package suite from a test file under that package', () => {
    // FULL_TEST_SUITES is the suite inventory; a suite no change can select never runs locally.
    for (const suite of FULL_TEST_SUITES) {
      const cwd = suite.args.indexOf('--cwd');
      const directory = cwd === -1 ? 'scripts' : suite.args[cwd + 1];
      const file = discoverTestFiles(fileURLToPath(new URL(directory, repoRoot)), fileURLToPath(repoRoot))[0];
      assert.ok(file, directory);
      assert.ok(buildPlan('fast', [file]).commands.some(c => c.label === `test:${suite.key}`), `${suite.key}: ${file}`);
    }
  });

  test('runs the agents-core suite and its web dependent for agents-core source and tests', () => {
    for (const file of ['packages/agents-core/src/agents/registry.ts', 'packages/agents-core/src/admission-runtime.test.ts']) {
      const labels = buildPlan('fast', [file]).commands.map(c => c.label);
      for (const label of ['typeCheck:agentsCore', 'typeCheck:web', 'test:agentsCore', 'test:web', 'test:startup']) assert.ok(labels.includes(label), `${file}: ${label}`);
    }
  });

  test('runs the UI suite for any UI source file and the web suite for any web file', () => {
    for (const file of ['packages/ui/src/App.tsx', 'packages/ui/src/apps/AppEffects.tsx', 'packages/ui/src/contexts/RuntimeAPIProvider.tsx',
      'packages/ui/src/constants/sidebar.ts', 'packages/ui/src/types/question.ts', 'packages/ui/src/styles/typography.css']) {
      assert.ok(buildPlan('fast', [file]).commands.some(c => c.label === 'test:ui'), file);
    }
    for (const file of ['packages/web/src/pwa-service-worker.ts', 'packages/web/src/api/index.ts', 'packages/web/vite-chunking.ts', 'packages/web/vite.config.ts', 'packages/web/vitest.config.ts']) {
      assert.ok(buildPlan('fast', [file]).commands.some(c => c.label === 'test:web'), file);
    }
  });

  test('type-checks web for every UI source change, because the web tsconfig includes the UI source', () => {
    const web = JSON.parse(readFileSync(new URL('packages/web/tsconfig.json', repoRoot), 'utf8'));
    assert.ok(web.include.includes('../ui/src'));
    for (const file of ['packages/ui/src/components/ui/button.tsx', 'packages/ui/src/styles/typography.css', 'packages/ui/src/types/question.ts']) {
      const labels = buildPlan('fast', [file]).commands.map(c => c.label);
      assert.ok(labels.includes('typeCheck:ui') && labels.includes('typeCheck:web'), file);
    }
  });

  test('runs every suite for dependency, patch and toolchain changes, including the MCP client patch test', () => {
    const every = FULL_TEST_SUITES.map(suite => `test:${suite.key}`);
    for (const file of ['bun.lock', 'package.json', 'patches/@modelcontextprotocol%2Fclient@2.3.1.patch', '.nvmrc', 'bunfig.toml']) {
      const labels = buildPlan('fast', [file]).commands.map(c => c.label);
      for (const label of every) assert.ok(labels.includes(label), `${file}: ${label}`);
      assert.equal(labels.at(-1), 'test:startup', file);
    }
    const plan = buildPlan('fast', ['patches/@modelcontextprotocol%2Fclient@2.3.1.patch']);
    const units = testUnitsForPlan(plan.commands.filter(c => c.label === 'test:scripts'));
    assert.ok(units.some(unit => unit.args.includes('scripts/opencode-v2-native/mcp-client-patch.test.mjs')));
  });

  test('runs the owning suites for reviewed runtime inputs, and the catalog check for the model catalog', () => {
    const catalog = buildPlan('fast', ['packages/web/runtime/reviewed-inputs/model-catalog/provenance.json']).commands;
    for (const label of ['catalog:check', 'test:scripts', 'test:web']) assert.ok(catalog.some(c => c.label === label), label);
    assert.deepEqual(catalog.find(c => c.label === 'catalog:check').args, ['run', 'catalog:check']);
    const jsdom = buildPlan('fast', ['packages/web/runtime/reviewed-inputs/jsdom-30.1.1/provenance.json']).commands.map(c => c.label);
    assert.ok(jsdom.includes('test:scripts') && jsdom.includes('test:web'));
    assert.ok(!jsdom.includes('catalog:check'));
    assert.ok(!buildPlan('fast', ['packages/web/server/index.js']).commands.some(c => c.label === 'catalog:check'));
    // The reviewed-inputs manifest hashes their Markdown too, so it is not a docs-only change.
    const readme = buildPlan('fast', ['packages/web/runtime/reviewed-inputs/model-catalog/README.md']).commands.map(c => c.label);
    for (const label of ['docs:validate', 'catalog:check', 'test:scripts', 'test:web', 'test:startup']) assert.ok(readme.includes(label), label);
  });

  test('lints and type-checks everything for a dependency patch, but not for runtime pins', () => {
    const patch = buildPlan('fast', ['patches/@modelcontextprotocol%2Fclient@2.3.1.patch']).commands.map(c => c.label);
    assert.ok(patch.includes('lint:full') && patch.includes('type-check:full'));
    for (const file of ['.nvmrc', 'bunfig.toml']) {
      const labels = buildPlan('fast', [file]).commands.map(c => c.label);
      assert.ok(!labels.includes('type-check:full') && !labels.some(label => label.startsWith('typeCheck:')), file);
    }
  });

  test('type-checks web for the native scripts its runtime-host tsconfig includes', () => {
    const runtimeHost = JSON.parse(readFileSync(new URL('packages/web/server/lib/opencode/runtime-host/tsconfig.json', repoRoot), 'utf8'));
    assert.ok(runtimeHost.include.includes('../../../../../../scripts/opencode-v2-native/**/*.ts'));
    const labels = buildPlan('fast', ['scripts/opencode-v2-native/simulation.ts']).commands.map(c => c.label);
    assert.ok(labels.includes('typeCheck:web') && labels.includes('test:scripts'));
    assert.ok(!buildPlan('fast', ['scripts/release.mjs']).commands.some(c => c.label === 'typeCheck:web'));
  });

  test('lints in fast mode only the files full and CI lint cover', () => {
    const roots = lintRoots();
    assert.deepEqual(roots.filter(root => ['packages/ui/src/', 'packages/web/src/'].includes(root)), ['packages/ui/src/', 'packages/web/src/']);
    const lint = files => buildPlan('fast', files).commands.find(c => c.label === 'lint:changed')?.args.slice(3);
    // Outside every workspace lint target: CI never lints these, so fast mode does not either.
    for (const file of ['packages/agents-core/src/agents/registry.ts', 'scripts/opencode-v2-native/simulation.ts', 'packages/web/vite-chunking.ts']) {
      assert.ok(!roots.some(root => file.startsWith(root)), file);
      assert.equal(lint([file]), undefined, file);
    }
    assert.deepEqual(lint(['packages/agents-core/src/agents/registry.ts', 'packages/ui/src/App.tsx', 'packages/web/src/pwa-service-worker.ts']),
      ['packages/ui/src/App.tsx', 'packages/web/src/pwa-service-worker.ts']);
    assert.deepEqual(buildPlan('full').commands.find(c => c.label === 'lint:full').args, ['run', 'lint']);
  });

  test('runs every check in full mode and refuses unknown modes', () => {
    assert.deepEqual(buildPlan('full').commands.map(c => c.label), ['lint:full', 'import-boundaries', 'browser-graph', 'unreached-files', 'declarations', 'type-check:full', 'docs:validate', 'build', 'bundle:check', 'test:full']);
    // CI's static job runs the same static checks.
    for (const label of ['import-boundaries', 'browser-graph', 'unreached-files', 'declarations', 'docs:validate']) assert.ok(buildPlan('static').commands.some(c => c.label === label), label);
    assert.throws(() => buildPlan('quick', []), /Unknown validation mode/);
  });
});

describe('version-only and startup-covered validation', () => {
  const manifest = (version, extra = {}) => `${JSON.stringify({ name: '@devryan/ui', version, dependencies: { react: '^19.2.8' }, ...extra }, null, 2)}\n`;
  const lock = (version, react = '19.2.8') => [
    '{', '  "workspaces": {', '    "packages/ui": {', '      "name": "@devryan/ui",', `      "version": "${version}",`,
    '      "dependencies": {', `        "react": "${react}",`, '      },', '    },', '  },', '}', ''].join('\n');

  test('recognizes a bump-version change and nothing else as version-only', () => {
    assert.equal(isVersionOnlyChange('packages/ui/package.json', manifest('2.1.5'), manifest('2.1.6')), true);
    assert.equal(isVersionOnlyChange('package.json', manifest('2.1.5'), manifest('2.1.6')), true);
    assert.equal(isVersionOnlyChange('packages/ui/package.json', manifest('2.1.5'), manifest('2.1.6', { scripts: { test: 'bun test' } })), false);
    assert.equal(isVersionOnlyChange('packages/ui/package.json', manifest('2.1.5'), manifest('2.1.5', { dependencies: { react: '^19.3.0' } })), false);
    assert.equal(isVersionOnlyChange('packages/ui/package.json', manifest('2.1.6'), manifest('2.1.6')), false);
    assert.equal(isVersionOnlyChange('packages/ui/src/index.json', manifest('2.1.5'), manifest('2.1.6')), false);
    assert.equal(isVersionOnlyChange('bun.lock', lock('2.1.5'), lock('2.1.6')), true);
    assert.equal(isVersionOnlyChange('bun.lock', lock('2.1.5'), lock('2.1.6', '19.3.0')), false);
    assert.equal(isVersionOnlyChange('bun.lock', lock('2.1.5'), lock('2.1.5').replace('"react": "19.2.8"', '"react": "19.3.0"')), false);
    const cargo = (version) => `[package]\nname = "devryan-desktop"\nversion = "${version}"\nedition = "2021"\n`;
    assert.equal(isVersionOnlyChange('packages/desktop/src-tauri/Cargo.toml', cargo('2.1.5'), cargo('2.1.6')), true);
    const cargoLock = (own, dependency) => `[[package]]\nname = "devryan-desktop"\nversion = "${own}"\n\n[[package]]\nname = "serde"\nversion = "${dependency}"\n`;
    assert.equal(isVersionOnlyChange('packages/desktop/src-tauri/Cargo.lock', cargoLock('2.1.5', '1.0.0'), cargoLock('2.1.6', '1.0.0')), true);
    assert.equal(isVersionOnlyChange('packages/desktop/src-tauri/Cargo.lock', cargoLock('2.1.5', '1.0.0'), cargoLock('2.1.5', '1.0.1')), false);
  });

  test('a release bump checks version agreement and the startup contract instead of every suite', () => {
    const bump = ['CHANGELOG.md', 'bun.lock', 'package.json', 'packages/ui/package.json', 'packages/web/package.json', 'packages/desktop/src-tauri/Cargo.toml'];
    const plan = buildPlan('fast', bump, { versionOnly: new Set(bump.filter((file) => file !== 'CHANGELOG.md')) });
    assert.deepEqual(plan.commands.map((c) => c.label), ['docs:validate', 'versions', 'release-preflight', 'test:startup']);
    assert.deepEqual(plan.commands.find((c) => c.label === 'versions').args, ['scripts/release.mjs', 'check-versions']);
    // Release inputs re-run the local release preflight in a clean worktree, as a release runner sees the commit.
    assert.deepEqual(plan.commands.find((c) => c.label === 'release-preflight').args, ['scripts/release-preflight.mjs', '--local-only']);
    for (const file of ['CHANGELOG.md', 'bun.lock', 'packages/electron/package.json', 'packages/desktop/src-tauri/tauri.conf.json']) {
      assert.ok(buildPlan('fast', [file]).commands.some((c) => c.label === 'release-preflight'), file);
    }
    for (const file of ['docs/TESTING.md', 'scripts/release.mjs', 'packages/ui/src/App.tsx']) {
      assert.ok(!buildPlan('fast', [file]).commands.some((c) => c.label === 'release-preflight'), file);
    }
    // The same files with real manifest changes keep the full shared-configuration plan.
    const labels = buildPlan('fast', bump).commands.map((c) => c.label);
    for (const label of ['lint:full', 'type-check:full', 'test:ui', 'test:web', 'test:startup']) assert.ok(labels.includes(label), label);
    // A version bump alongside code still validates the code.
    const mixed = buildPlan('fast', [...bump, 'packages/ui/src/lib/executionFailure.ts'], { versionOnly: new Set(bump.filter((file) => file !== 'CHANGELOG.md')) });
    const mixedLabels = mixed.commands.map((c) => c.label);
    for (const label of ['versions', 'lint:changed', 'typeCheck:ui', 'typeCheck:web', 'test:ui', 'test:startup']) assert.ok(mixedLabels.includes(label), label);
    assert.ok(!mixedLabels.includes('lint:full'));
  });

  test('startup groups whose owner suite runs in the plan are not run twice', () => {
    const plan = buildPlan('fast', ['packages/web/server/lib/opencode/lifecycle.js']);
    const startup = plan.commands.find((c) => c.label === 'test:startup');
    assert.deepEqual(startup.coveredBy, ['web']);
    const units = testUnitsForPlan(plan.commands.filter((c) => c.label.startsWith('test:')));
    const startupUnits = units.filter((unit) => unit.suite === 'startup').map((unit) => unit.name);
    assert.deepEqual(startupUnits, STARTUP_CONTRACT_GROUPS.filter((group) => group.owner !== 'web').map((group) => `startup:${group.name}`));
    // The web suite itself still runs every Vitest project and its native files.
    assert.ok(units.some((unit) => unit.name === 'web:native'));
    assert.ok(units.filter((unit) => unit.name.startsWith('web:vitest')).length > 1);
    // The whole scripts suite covers its startup group; a selected subset does not.
    const alone = buildPlan('fast', ['scripts/test-pool.mjs']).commands.find((c) => c.label === 'test:startup');
    assert.deepEqual(alone.coveredBy, ['scripts']);
    assert.deepEqual(buildPlan('fast', ['scripts/release.mjs']).commands.find((c) => c.label === 'test:startup').coveredBy, []);
    assert.deepEqual(buildPlan('fast', []).commands.find((c) => c.label === 'test:startup').coveredBy, []);
  });
});
