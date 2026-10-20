import assert from 'node:assert/strict';
import YAML from 'yaml';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { discoverTestFiles, isBunTestSource, isIsolatedUiTestSource } from './test-runner-utils.mjs';
import { discoverElectronTestFiles, planElectronTests } from './test-electron.mjs';
import { discoverScriptTestFiles } from './test-scripts.mjs';
import { buildPlan } from './validate.mjs';

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
      `import { runScriptTests } from ${JSON.stringify(new URL('./test-scripts.mjs', import.meta.url).href)}; process.exit(runScriptTests(process.argv[1]));`, root],
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

describe('isIsolatedUiTestSource', () => {
  test('isolates source that mutates global window through supported patterns', () => {
    assert.equal(isIsolatedUiTestSource('globalThis.window = {}'), true);
    assert.equal(isIsolatedUiTestSource('globalWithWindow.window = previousWindow'), true);
    assert.equal(isIsolatedUiTestSource('(globalThis as Record<string, unknown>).window = w'), true);
    assert.equal(isIsolatedUiTestSource("Object.defineProperty(globalThis, 'window', { value: {} })"), true);
  });

  test('isolates module mocks and mutable browser globals', () => {
    assert.equal(isIsolatedUiTestSource("mock.module('@/lib/opencode/client', () => ({}))"), true);
    assert.equal(isIsolatedUiTestSource('globalThis.sessionStorage = storage'), true);
    assert.equal(isIsolatedUiTestSource('Object.defineProperty(globalThis, "sessionStorage", { value: storage })'), true);
    assert.equal(isIsolatedUiTestSource('globalThis.FileReader = MockFileReader'), true);
    assert.equal(isIsolatedUiTestSource('Object.defineProperty(globalThis, "FileReader", { value: MockFileReader })'), true);
  });

  test('does not isolate plain window reads', () => {
    assert.equal(isIsolatedUiTestSource('globalThis.window.addEventListener("x", listener)'), false);
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
    const environment = { ...process.env, DEVRYAN_RUN_BOT_DB_DOCKER_TESTS: '', DEVRYAN_RUN_DMG_INSTALLER_NATIVE_TESTS: '' };
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
      writeFileSync(path.join(root, 'tests/bot-catalog.docker.test.mjs'), `import { test } from 'bun:test';
        test('explicit Docker prerequisite', () => { throw new Error('Docker was not requested'); });`);
      writeFileSync(path.join(root, 'tests/desktop-update-install-native.test.mjs'), `import { test } from 'node:test';
        test('explicit macOS native prerequisite', () => { throw new Error('Native acceptance was not requested'); });`);
      const plan = planElectronTests(root, {});
      assert.deepEqual(plan.node, ['nested.test.mjs']);
      assert.deepEqual(plan.isolatedBun, ['a.mock.test.mjs']);
      assert.deepEqual(plan.bun, ['b.clean.test.mjs']);
      assert.deepEqual(plan.optional, ['tests/bot-catalog.docker.test.mjs', 'tests/desktop-update-install-native.test.mjs']);
      assert.ok(planElectronTests(root, { DEVRYAN_RUN_BOT_DB_DOCKER_TESTS: '1' }).bun.includes('tests/bot-catalog.docker.test.mjs'));
      assert.ok(planElectronTests(root, { DEVRYAN_RUN_DMG_INSTALLER_NATIVE_TESTS: '1' }).node.includes('tests/desktop-update-install-native.test.mjs'));
      const passing = run();
      assert.equal(passing.status, 0, passing.stdout + passing.stderr);
      assert.match(passing.stdout, /Native DMG installer acceptance is a separate opt-in gate/);
      writeFileSync(path.join(root, 'nested.test.mjs'), `import { test } from 'node:test'; test('failure propagates', () => { throw new Error('expected fixture failure'); });`);
      assert.notEqual(run().status, 0, 'A failing framework must fail the combined runner');
      writeFileSync(path.join(root, 'splash.test.mjs'), "import { test } from 'vitest'; test('splash', () => {});");
      assert.deepEqual(planElectronTests(root, {}).vitest, ['splash.test.mjs']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('release workflow', () => {
  test('includes the Bots runtime package in the full test gate and version script', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));
    const bumpVersionSource = readFileSync(new URL('scripts/bump-version.mjs', repoRoot), 'utf8');

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/bots-runtime test/,
    );
    assert.match(bumpVersionSource, /packages\/bots-runtime\/package\.json/);
  });

  test('versions and runs the confined Bot service packages', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));
    const bumpVersionSource = readFileSync(new URL('scripts/bump-version.mjs', repoRoot), 'utf8');
    for (const packageName of [
      'bot-supervisor', 'bot-engine-proxy', 'bot-egress', 'bot-computer', 'bot-indexer', 'bot-db',
    ]) {
      assert.match(
        packageJson.scripts['test:full'],
        new RegExp(`bun run --cwd packages/${packageName} test`),
      );
      assert.match(bumpVersionSource, new RegExp(`packages/${packageName}/package\\.json`));
    }
  });

  test('includes the Cursor runtime package in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/cursor-sdk-runtime test/,
    );
  });

  test('includes the managed orchestration runtime package in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/orchestration-runtime test/,
    );
  });

  test('includes the Electron package suite in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/electron test/,
    );
  });

  test('runs only the legacy Tauri JavaScript contract in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));
    const desktopCommands = packageJson.scripts['test:full'].split(' && ')
      .filter((command) => command.includes('packages/desktop'));
    assert.deepEqual(desktopCommands, ['bun run --cwd packages/desktop test:managed-orchestration']);
  });

  test('builds Bot images with the input-hashing recipe and publishes only through release.mjs', async () => {
    const { BOT_RUNTIME_IMAGE_BUILD_RECIPE } = await import('./bot-runtime-image-inputs.mjs');
    const workflow = YAML.parse(readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8'));
    const build = workflow.jobs['bot-build'].steps.find((step) => step.uses === 'docker/build-push-action@v6').with;
    assert.equal(build.context, BOT_RUNTIME_IMAGE_BUILD_RECIPE.context);
    assert.equal(build.platforms, BOT_RUNTIME_IMAGE_BUILD_RECIPE.platforms.join(','));
    assert.equal(build.provenance, BOT_RUNTIME_IMAGE_BUILD_RECIPE.provenance);
    assert.equal(build.sbom, BOT_RUNTIME_IMAGE_BUILD_RECIPE.sbom);

    assert.ok(workflow.jobs['electron-prepare'].steps.some((step) => step.run === "bun install --frozen-lockfile --cpu '*' --os darwin"));
    const packaging = workflow.jobs['electron-package'].steps.find((step) => step.name === 'Package the app');
    assert.equal(packaging.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.match(packaging.run, /-c\.mac\.identity=null -c\.mac\.notarize=false -c\.dmg\.sign=false/);

    // Nothing publishes until the packaged candidate upgrades a profile aged by the previous releases.
    assert.ok(workflow.jobs.publish.needs.includes('upgrade-check'));
    assert.equal(workflow.concurrency, undefined, 'workflow cancellation must not interrupt production');
    assert.equal(workflow.jobs.publish.concurrency['cancel-in-progress'], false);
    assert.equal(workflow.jobs.publish.concurrency.group, 'devryan-production-publication');
    assert.ok(workflow.jobs.admit.steps.some(step => step.run === 'node scripts/release.mjs trusted-ci'));
    assert.match(workflow.jobs['verify-published'].if, /outputs.published == 'true'/);
    assert.equal(workflow.jobs['verify-published'].steps.find(step => step.uses === 'actions/download-artifact@v4').with['run-id'], '${{ needs.admit.outputs.candidate_run_id }}');
    for (const name of ['web', 'electron-prepare', 'bot-resolve']) assert.match(workflow.jobs[name].if, /outputs.published != 'true'/);
    assert.deepEqual(workflow.jobs['upgrade-check'].strategy.matrix.baseline, ['aging', 'v2.0.2', 'v2.0.15']);
    assert.ok(workflow.jobs['final-dmg-smoke']['continue-on-error'].includes('qualified-3-runs'));
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) {
      if (step.uses === 'actions/upload-artifact@v4') assert.equal(step.with['retention-days'], 14);
    }
    assert.match(workflow.jobs.publish.if, /needs\.upgrade-check\.result == 'success'/);
    assert.ok(workflow.jobs['upgrade-check'].steps.some((step) => step.run?.includes('node scripts/qa/release-upgrade-lane.mjs')));

    const steps = workflow.jobs.publish.steps;
    const index = (name) => steps.findIndex((step) => step.name === name);
    const upload = index('Check the DMG and attach it to the draft');
    const supabase = index('Deploy and verify Supabase configuration and migrations');
    const publish = index('Publish and confirm the in-app updater discovers the DMG');
    assert.ok(upload >= 0 && upload < supabase && supabase < publish, 'publish order: attach DMG, deploy Supabase, publish');
    assert.equal(steps[upload].run, 'node scripts/release.mjs upload');
    assert.equal(steps[publish].run, 'node scripts/release.mjs publish');
    assert.equal(steps[supabase].if, "${{ github.event_name == 'push' && steps.upload.outputs.published != 'true' }}");
    assert.equal(steps[publish].if, "${{ github.event_name == 'push' }}");
    assert.match(steps[supabase].run, /node scripts\/sync-supabase-auth-password-policy\.mjs\n\s*supabase db push --linked --dry-run/);
  });
});

describe('Bots affected validation planning', () => {
  const tests = (files) => buildPlan('fast', files).commands.map((entry) => entry.label).filter((label) => label.startsWith('test:'));

  test('runs Bots plus web, Electron, and UI dependents for core changes', () => {
    const plan = buildPlan('fast', ['packages/bots-runtime/run-state.js']);
    assert.deepEqual(plan.commands.map((entry) => entry.label), [
      'typeCheck:electron',
      'typeCheck:ui',
      'typeCheck:web',
      'import-boundaries',
      'browser-graph',
      'test:bots',
      'test:electron',
      'test:ui',
      'test:web',
      'test:startup',
    ]);
  });

  test('runs confined service suites and the Electron host', () => {
    assert.deepEqual(tests([
      'packages/bot-supervisor/src/contract.js',
      'packages/bot-engine-proxy/src/docker.js',
      'packages/bot-egress/src/connect-policy.js',
      'packages/bot-computer/src/browser.js',
      'packages/bot-indexer/src/index-store.js',
    ]), [
      'test:botComputer',
      'test:botEgress',
      'test:botEngineProxy',
      'test:botIndexer',
      'test:botSupervisor',
      'test:electron',
      'test:startup',
    ]);
  });

  test('runs the local Bot catalog suite and its Electron and web consumers', () => {
    const labels = tests(['packages/bot-db/sql/bootstrap-database.sql']);
    for (const label of ['test:botDb', 'test:electron', 'test:web']) assert.ok(labels.includes(label), label);
  });
});

describe('maintenance validation selection', () => {
  test('checks documentation without running unrelated code suites', () => {
    assert.deepEqual(buildPlan('fast', ['docs/TESTING.md']).commands.map(c => c.label), ['docs:validate']);
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
      assert.deepEqual(testCommands, [
        { label: 'test:desktop', executable: 'bun', args: ['run', '--cwd', 'packages/desktop', 'test:managed-orchestration'] },
        { label: 'test:startup', executable: 'bun', args: ['run', 'test:startup'] },
      ], file);
    }
  });

  test('lints and type-checks everything for shared configuration, and re-tests a package for its own manifest', () => {
    for (const file of ['package.json', 'bun.lock', '.opencode/opencode.json']) {
      const labels = buildPlan('fast', [file]).commands.map(c => c.label);
      assert.ok(labels.includes('lint:full') && labels.includes('type-check:full'), file);
    }
    assert.ok(buildPlan('fast', ['packages/ui/package.json']).commands.some(c => c.label === 'test:ui'));
    assert.ok(buildPlan('fast', ['packages/bot-indexer/package-lock.json']).commands.some(c => c.label === 'test:botIndexer'));
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

  test('runs every check in full mode and refuses unknown modes', () => {
    assert.deepEqual(buildPlan('full').commands.map(c => c.label), ['lint:full', 'import-boundaries', 'browser-graph', 'type-check:full', 'docs:validate', 'build', 'bundle:check', 'test:full']);
    assert.throws(() => buildPlan('quick', []), /Unknown validation mode/);
  });
});
