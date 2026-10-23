#!/usr/bin/env node
import { BUILD_JOB_TESTS, CI_LANES, planCITests } from './test-ci-lanes.mjs';

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cacheGrowthFailure, snapshotCache } from './cache-guard.mjs';
import { planFullTests } from './test-full.mjs';
import { formatDuration, recordTestTimings, runTestUnits, summarizeTestUnits, testConcurrency } from './test-pool.mjs';
import { planScriptTests, prepareScriptTestEnvironment } from './test-scripts.mjs';
import { STARTUP_CONTRACT_GROUPS, startupContractGroups } from './test-startup-contract.mjs';

const mode = process.argv[2] ?? 'fast';

const workspaceRoot = process.cwd();
const tsLikeExtensions = new Set(['.ts', '.tsx']);
const testFilePattern = /(?:^|[./-])test\.[cm]?[jt]sx?$/;

// Package suites run the same units as `test:full` (scripts/test-full.mjs), keyed by these names.
const packages = {
  ui: {
    prefix: 'packages/ui/',
    lint: ['bun', ['run', 'lint:ui']],
    typeCheck: ['bun', ['run', 'type-check:ui']],
  },
  web: {
    prefix: 'packages/web/',
    lint: ['bun', ['run', 'lint:web']],
    typeCheck: ['bun', ['run', 'type-check:web']],
  },
  electron: {
    prefix: 'packages/electron/',
    lint: ['bun', ['run', 'lint:electron']],
    typeCheck: ['bun', ['run', 'type-check:electron']],
  },
  desktop: {
    // Frozen legacy Tauri package: run JS contract tests; cargo tests need native build assets.
    prefix: 'packages/desktop/',
    lint: ['bun', ['run', 'lint:desktop']],
    typeCheck: ['bun', ['run', 'type-check:desktop']],
  },
  bots: {
    prefix: 'packages/bots-runtime/',
  },
  botSupervisor: {
    prefix: 'packages/bot-supervisor/',
  },
  botEngineProxy: {
    prefix: 'packages/bot-engine-proxy/',
  },
  botEgress: {
    prefix: 'packages/bot-egress/',
  },
  botComputer: {
    prefix: 'packages/bot-computer/',
  },
  botIndexer: {
    prefix: 'packages/bot-indexer/',
  },
  botDb: {
    prefix: 'packages/bot-db/',
  },
  cursor: {
    prefix: 'packages/cursor-sdk-runtime/',
  },
  orchestration: {
    prefix: 'packages/orchestration-runtime/',
  },
  shared: {
    prefix: 'packages/shared-runtime/',
  },
  harness: {
    prefix: 'packages/harness-runtime/',
  },
  agentsCore: {
    prefix: 'packages/agents-core/',
    typeCheck: ['bun', ['run', '--cwd', 'packages/agents-core', 'type-check']],
  },
};

// Shared configuration: a change re-checks lint and types everywhere.
const sharedConfigFiles = new Set([
  'package.json',
  'bun.lock',
  '.oxlintrc.json',
  'tsconfig.json',
  'vite-theme-plugin.ts',
  '.opencode/opencode.json',
]);

const docsOnlyExtensions = new Set(['.md', '.mdx', '.txt']);

// Files `node scripts/bump-version.mjs` rewrites. A change confined to their
// version field is release metadata: `versions` checks they agree instead of
// re-running every package's lint, types and tests (CI still runs everything).
const versionFiles = new Set(['package.json', 'bun.lock', 'packages/desktop/src-tauri/tauri.conf.json',
  'packages/desktop/src-tauri/Cargo.toml', 'packages/desktop/src-tauri/Cargo.lock']);
const isVersionFile = (file) => versionFiles.has(file) || /^packages\/[^/]+\/package\.json$/.test(file);
// Release inputs: a version file, the release notes or the lockfile. A change
// re-runs the local release preflight in a clean worktree, as a release runner sees it.
const isReleaseInput = (file) => isVersionFile(file) || file === 'CHANGELOG.md';
const releasePreflightCommands = (files) => files.some(isReleaseInput)
  ? [{ label: 'release-preflight', executable: 'node', args: ['scripts/release-preflight.mjs', '--local-only'] }] : [];

function withoutVersion(source) {
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  delete value.version;
  return JSON.stringify(value);
}

/** True when `after` differs from `before` only in the version metadata bump-version.mjs writes. */
export function isVersionOnlyChange(file, before, after) {
  if (!isVersionFile(file) || typeof before !== 'string' || typeof after !== 'string' || before === after) return false;
  if (file.endsWith('.json')) {
    try { return withoutVersion(before) === withoutVersion(after); } catch { return false; }
  }
  // Line formats: only version lines change, each in place under the same owner line.
  const left = before.split('\n'), right = after.split('\n');
  if (left.length !== right.length) return false;
  const versionLine = file === 'bun.lock' ? /^\s*"version": "[^"]+",$/ : /^version = "[^"]+"$/;
  const ownerLine = file === 'bun.lock' ? /^\s*"name": "@devryan\/[^"]+",$/
    : file.endsWith('Cargo.lock') ? /^name = "devryan-desktop"$/ : /^name = "[^"]+"$/;
  return left.every((line, index) => line === right[index]
    || (versionLine.test(line) && versionLine.test(right[index]) && index > 0 && ownerLine.test(left[index - 1]) && left[index - 1] === right[index - 1]));
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.ignoreErrors ? 'ignore' : 'pipe'],
  });

  if (result.status !== 0) {
    if (options.ignoreErrors) return '';
    const details = result.stderr?.trim() || `git ${args.join(' ')} failed`;
    throw new Error(details);
  }

  return result.stdout;
}

function validationBase() {
  // Committed but unpushed work counts: compare with the upstream branch unless VALIDATE_BASE is set.
  return process.env.VALIDATE_BASE || runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { ignoreErrors: true }).trim();
}

/** Changed version files whose working-tree content differs from the base only in version metadata. */
function versionOnlyFilesFromGit(files) {
  const base = validationBase();
  const commit = (base && runGit(['merge-base', base, 'HEAD'], { ignoreErrors: true }).trim()) || 'HEAD';
  return new Set(files.filter(isVersionFile).filter((file) => {
    const before = runGit(['show', `${commit}:${file}`], { ignoreErrors: true });
    let after;
    try { after = readFileSync(path.join(workspaceRoot, file), 'utf8'); } catch { return false; }
    return Boolean(before) && isVersionOnlyChange(file, before, after);
  }));
}

function changedFilesFromGit() {
  const base = validationBase();
  const outputs = [];

  if (base) {
    outputs.push(runGit(['diff', '--name-only', `${base}...HEAD`], { ignoreErrors: true }));
  }

  outputs.push(runGit(['diff', '--name-only'], { ignoreErrors: true }));
  outputs.push(runGit(['diff', '--name-only', '--cached'], { ignoreErrors: true }));
  outputs.push(runGit(['ls-files', '--others', '--exclude-standard'], { ignoreErrors: true }));

  return [...new Set(outputs
    .join('\n')
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => !file.includes('/node_modules/'))
  )].sort();
}

function packageForFile(file) {
  return Object.entries(packages).find(([, config]) => file.startsWith(config.prefix))?.[0] ?? null;
}

function isSharedConfigFile(file) {
  return sharedConfigFiles.has(file);
}

function isScriptsFile(file) {
  return file.startsWith('scripts/') || file.startsWith('.github/')
    || file.startsWith('.opencode/agents/') || file.startsWith('.opencode/plugins/');
}

function isRuntimeGuidance(file) {
  return /\.md$/.test(file) && (file.startsWith('.opencode/agents/')
    || file.startsWith('packages/web/server/default-config/agents/')
    || file.startsWith('packages/web/server/lib/agent-browser/assets/'));
}

function isDocsOnlyFile(file) {
  if (isRuntimeGuidance(file)) return false;
  return docsOnlyExtensions.has(path.extname(file)) || file.startsWith('docs/');
}

function isLintableFile(file) {
  return tsLikeExtensions.has(path.extname(file));
}

function isUiTestRelevant(file) {
  if (!file.startsWith('packages/ui/src/')) return false;
  if (testFilePattern.test(file)) return true;
  return [
    'packages/ui/src/sync/',
    'packages/ui/src/stores/',
    'packages/ui/src/lib/',
    'packages/ui/src/hooks/',
    'packages/ui/src/components/',
  ].some((prefix) => file.startsWith(prefix));
}

function isWebTestRelevant(file) {
  if (!file.startsWith('packages/web/')) return false;
  if (isRuntimeGuidance(file) || testFilePattern.test(file)) return true;
  return file.startsWith('packages/web/server/') || file.startsWith('packages/web/bin/');
}

function isElectronTestRelevant(file) {
  if (!file.startsWith('packages/electron/')) return false;
  if (testFilePattern.test(file)) return true;
  return ['.js', '.mjs'].includes(path.extname(file)) || file === 'packages/electron/package.json';
}

function isDesktopTestRelevant(file) {
  return file === 'packages/desktop/scripts/devryan-managed-orchestration.test.mjs'
    || file === 'packages/desktop/src-tauri/resources/default-config/plugins/devryan-managed-orchestration.mjs';
}

function isCursorTestRelevant(file) {
  if (!file.startsWith('packages/cursor-sdk-runtime/')) return false;
  if (testFilePattern.test(file)) return true;
  return ['.js', '.mjs'].includes(path.extname(file));
}

function isBotsTestRelevant(file) {
  if (!file.startsWith('packages/bots-runtime/')) return false;
  if (testFilePattern.test(file)) return true;
  return ['.js', '.mjs', '.sh'].includes(path.extname(file)) || file.endsWith('/Dockerfile');
}

function isBotServiceTestRelevant(file, prefix) {
  if (!file.startsWith(prefix)) return false;
  if (testFilePattern.test(file)) return true;
  return ['.js', '.mjs'].includes(path.extname(file)) || file.endsWith('/Dockerfile');
}

// The local Bot catalog package ships migrations, bootstrap SQL and image
// configuration consumed by the Electron lifecycle and the web import path.
function isBotDbTestRelevant(file) {
  if (!file.startsWith('packages/bot-db/')) return false;
  if (testFilePattern.test(file)) return true;
  return ['.js', '.mjs', '.sql', '.sh', '.conf', '.json'].includes(path.extname(file)) || file.endsWith('/Dockerfile');
}

function isOrchestrationTestRelevant(file) {
  if (!file.startsWith('packages/orchestration-runtime/')) return false;
  if (testFilePattern.test(file)) return true;
  return ['.js', '.mjs'].includes(path.extname(file));
}

function isHarnessTestRelevant(file) {
  if (!file.startsWith('packages/harness-runtime/')) return false;
  if (testFilePattern.test(file)) return true;
  return ['.js', '.mjs'].includes(path.extname(file));
}

function command(label, executable, args) {
  return { label, executable, args };
}

const importBoundaryInputs = new Set(['scripts/import-boundaries.json', 'scripts/check-import-boundaries.mjs', 'scripts/check-browser-graph.mjs']);

// Cross-package import boundaries and the browser bundle graph. A manifest,
// exception-list or checker change re-checks every importer.
function importBoundaryCommands(files) {
  const everything = files.some((file) => importBoundaryInputs.has(file) || /^packages\/[^/]+\/package\.json$/.test(file));
  const importers = files.filter((file) => file.startsWith('packages/') && /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(file));
  if (!everything && importers.length === 0) return [];
  return [
    command('import-boundaries', 'node', ['scripts/check-import-boundaries.mjs', ...(everything ? [] : ['--files', ...importers])]),
    command('browser-graph', 'node', ['scripts/check-browser-graph.mjs']),
  ];
}

function packageCommands(packageNames, commandName) {
  return [...packageNames]
    .sort()
    .map((name) => {
      const entry = packages[name]?.[commandName];
      if (!entry) return null;
      const [executable, args] = entry;
      return command(`${commandName}:${name}`, executable, args);
    })
    .filter(Boolean);
}

// Test commands name a suite; runTests expands them into pool units.
function testCommands(suiteNames) {
  return [...suiteNames].sort().map((name) => ({ ...command(`test:${name}`, 'node', ['scripts/test-full.mjs', `--suite=${name}`]), suite: name }));
}

function startupCommand(coveredBy) {
  const covered = STARTUP_CONTRACT_GROUPS.map((group) => group.owner).filter((owner) => coveredBy.has(owner));
  const unique = [...new Set(covered)].sort();
  return { ...command('test:startup', 'node', ['scripts/test-startup-contract.mjs', ...(unique.length ? [`--covered-by=${unique.join(',')}`] : [])]), coveredBy: unique };
}

function affectedTypeCheckPackages(changedPackages, includeDependents) {
  const result = new Set(changedPackages);
  if (includeDependents && changedPackages.has('ui')) {
    result.add('web');
  }
  if (includeDependents && changedPackages.has('cursor')) {
    result.add('web');
  }
  if (includeDependents && changedPackages.has('bots')) {
    result.add('electron');
    result.add('ui');
    result.add('web');
  }
  if (includeDependents && changedPackages.has('orchestration')) {
    result.add('ui');
    result.add('web');
  }
  if (includeDependents && changedPackages.has('shared')) result.add('web');
  if (includeDependents && changedPackages.has('harness')) {
    result.add('web');
  }
  if (includeDependents && changedPackages.has('agentsCore')) result.add('web');
  return result;
}

function changedLintCommand(files) {
  const lintableFiles = files.filter((file) => isLintableFile(file) && existsSync(path.join(workspaceRoot, file)));
  if (lintableFiles.length === 0) return [];

  return [command('lint:changed', 'bunx', [
    'oxlint',
    '--config', '.oxlintrc.json',
    ...lintableFiles,
  ])];
}

function fullCommands() {
  return [
    command('lint:full', 'bun', ['run', 'lint']),
    command('import-boundaries', 'node', ['scripts/check-import-boundaries.mjs']),
    command('browser-graph', 'node', ['scripts/check-browser-graph.mjs']),
    command('type-check:full', 'bun', ['run', 'type-check']),
    command('docs:validate', 'bun', ['run', 'docs:validate']),
    command('build', 'bun', ['run', 'build']),
    command('bundle:check', 'bun', ['run', 'bundle:check']),
    command('test:full', 'bun', ['run', 'test:full']),
  ];
}

function affectedTests(files) {
  const tests = new Set();
  for (const file of files) {
    if (isUiTestRelevant(file)) tests.add('ui');
    if (isWebTestRelevant(file)) tests.add('web');
    if (isElectronTestRelevant(file)) tests.add('electron');
    if (isDesktopTestRelevant(file)) tests.add('desktop');
    if (isBotsTestRelevant(file)) tests.add('bots');
    if (isBotServiceTestRelevant(file, 'packages/bot-supervisor/')) tests.add('botSupervisor');
    if (isBotServiceTestRelevant(file, 'packages/bot-engine-proxy/')) tests.add('botEngineProxy');
    if (isBotServiceTestRelevant(file, 'packages/bot-egress/')) tests.add('botEgress');
    if (isBotServiceTestRelevant(file, 'packages/bot-computer/')) tests.add('botComputer');
    if (isBotServiceTestRelevant(file, 'packages/bot-indexer/')) tests.add('botIndexer');
    if (isBotDbTestRelevant(file)) tests.add('botDb');
    if (isCursorTestRelevant(file)) tests.add('cursor');
    if (isOrchestrationTestRelevant(file)) tests.add('orchestration');
    if (file.startsWith('packages/shared-runtime/')) tests.add('shared');
    if (isHarnessTestRelevant(file)) tests.add('harness');
    // A package manifest or nested lockfile change re-runs that package's tests.
    if (/(?:^|\/)(?:package\.json|package-lock\.json)$/.test(file)) {
      const name = packageForFile(file);
      if (name) tests.add(name);
    }
  }
  // Dependents: packages whose behaviour runs through the changed one.
  if (tests.has('cursor')) tests.add('web');
  if (tests.has('bots')) ['electron', 'ui', 'web'].forEach((name) => tests.add(name));
  if (['botSupervisor', 'botEngineProxy', 'botEgress', 'botComputer', 'botIndexer'].some((name) => tests.has(name))) tests.add('electron');
  if (tests.has('botDb')) ['electron', 'web'].forEach((name) => tests.add(name));
  if (tests.has('orchestration')) ['ui', 'web'].forEach((name) => tests.add(name));
  if (tests.has('shared')) tests.add('web');
  if (tests.has('harness')) tests.add('web');
  if (tests.has('agentsCore')) tests.add('web');
  return tests;
}

/**
 * `fast` (default, `bun run validate`): the local gate before a push or a release tag.
 * Lint and type-check what changed (everything when shared config changed), run the
 * affected package tests and the scripts suite, and always the startup contract.
 * `full` (`bun run validate:full`, CI): every check including the full test suite.
 */
export function buildPlan(requestedMode, providedFiles, { versionOnly } = {}) {
  // CI splits the non-test checks: `static` (no build output needed) beside
  // `build` (the assets test lanes download, then their bundle budgets).
  const BUILD_LABELS = new Set(['build', 'bundle:check']);
  // The build job also runs the tests of what it built, so no test lane needs its output.
  const builtAssetTests = command('built-assets', 'node', ['--test', ...BUILD_JOB_TESTS]);
  if (requestedMode === 'checks') return { files: providedFiles ?? [], commands: fullCommands().filter(item => item.label !== 'test:full'), reason: 'CI build and static checks' };
  if (requestedMode === 'static') return { files: providedFiles ?? [], commands: fullCommands().filter(item => item.label !== 'test:full' && !BUILD_LABELS.has(item.label)), reason: 'CI static checks' };
  if (requestedMode === 'build') return { files: providedFiles ?? [], commands: [...fullCommands().filter(item => BUILD_LABELS.has(item.label)), builtAssetTests], reason: 'CI build, bundle budgets and built-asset tests' };
  if (requestedMode.startsWith('ci:')) {
    const lane = requestedMode.slice(3);
    if (!CI_LANES.includes(lane)) throw new Error(`Unknown CI test lane: ${requestedMode}`);
    return { files: providedFiles ?? [], commands: [{ ...command('test:full', 'node', ['scripts/validate.mjs', requestedMode]), lane }], reason: `CI test lane ${requestedMode.slice(3)}` };
  }
  if (requestedMode === 'full') {
    return { files: providedFiles ?? [], commands: fullCommands(), reason: 'full validation requested' };
  }
  if (requestedMode !== 'fast') throw new Error(`Unknown validation mode: ${requestedMode} (use fast or full)`);

  const files = providedFiles ?? changedFilesFromGit();
  const metadata = versionOnly ?? (providedFiles ? new Set() : versionOnlyFilesFromGit(files));
  const versionCheck = [...(metadata.size ? [command('versions', 'node', ['scripts/release.mjs', 'check-versions'])] : []), ...releasePreflightCommands(files)];
  const codeFiles = files.filter((file) => !isDocsOnlyFile(file) && !metadata.has(file));
  const docs = files.some((file) => /\.mdx?$/.test(file)) ? [command('docs:validate', 'bun', ['run', 'docs:validate'])] : [];
  if (files.length === 0) return { files, commands: [startupCommand(new Set())], reason: 'no changed files; startup contract only' };
  if (codeFiles.length === 0) {
    if (!metadata.size) return { files, commands: [...docs, ...versionCheck], reason: 'docs-only changes' };
    return { files, commands: [...docs, ...versionCheck, startupCommand(new Set())], reason: 'version metadata and docs only' };
  }

  const changedPackages = new Set(codeFiles.map(packageForFile).filter(Boolean));
  const shared = codeFiles.some(isSharedConfigFile);
  const commands = [...docs, ...versionCheck];
  if (shared) {
    commands.push(command('lint:full', 'bun', ['run', 'lint']), command('type-check:full', 'bun', ['run', 'type-check']));
  } else {
    commands.push(...changedLintCommand(codeFiles));
    commands.push(...packageCommands(affectedTypeCheckPackages(changedPackages, true), 'typeCheck'));
  }
  commands.push(...importBoundaryCommands(codeFiles));
  const suites = affectedTests(codeFiles);
  if (codeFiles.some(isScriptsFile)) suites.add('scripts');
  commands.push(...testCommands(suites));
  commands.push(startupCommand(suites));
  return { files, commands, reason: shared ? 'shared configuration changed; lint and type-check everything'
    : metadata.size ? 'changed files; version metadata checked separately' : 'changed files' };
}
function printPlan(plan) {
  console.log(`Validation mode: ${mode}`);
  console.log(`Reason: ${plan.reason}`);
  console.log(`Changed files: ${plan.files.length === 0 ? 'none' : plan.files.length}`);

  if (plan.files.length > 0) {
    for (const file of plan.files) console.log(`  - ${file}`);
  }

  if (plan.commands.length === 0) {
    console.log('Commands: none');
    return;
  }

  console.log('Commands:');
  for (const item of plan.commands) {
    console.log(`  - ${item.label}: ${[item.executable, ...item.args].join(' ')}`);
  }
}

function runStatic(item) {
  console.log(`\n$ ${[item.executable, ...item.args].join(' ')}`);
  const started = performance.now();
  const result = spawnSync(item.executable, item.args, { cwd: workspaceRoot, stdio: 'inherit', env: process.env });
  return { label: item.label, status: result.status, durationMs: performance.now() - started };
}

/** Pool units for the plan's test commands; each suite's units are those `test:full` runs. */
export function testUnitsForPlan(commands, { root = workspaceRoot, scriptEnvironment } = {}) {
  const units = [];
  for (const item of commands) {
    if (item.label === 'test:full') units.push(...(item.lane ? planCITests(root, item.lane, { scriptEnvironment }) : planFullTests(root, { scriptEnvironment, suites: item.suites })));
    else if (item.label === 'test:startup') {
      units.push(...startupContractGroups({ coveredBy: item.coveredBy ?? [] }).map((group) => ({ ...group, name: `startup:${group.name}`, suite: 'startup' })));
    } else if (item.suite === 'scripts') units.push(...planScriptTests(root).map((unit) => ({ ...unit, env: scriptEnvironment, suite: 'scripts' })));
    else if (item.suite) units.push(...planFullTests(root, { scriptEnvironment, suites: [item.suite] }));
  }
  return units.map((unit) => ({ ...unit, env: unit.env ?? scriptEnvironment, cwd: unit.cwd ?? root }));
}

/**
 * Independent static checks (lint, boundaries, type-check, docs, versions) run
 * concurrently and all report; then the build and its bundle budgets run in
 * order. Any static failure stops before tests. Test commands then run as one
 * bounded pool (DEVRYAN_TEST_CONCURRENCY), each failure reported.
 */
async function runCommands(commands) {
  const isTest = (item) => item.label.startsWith('test:');
  const isBuildChain = (item) => item.label === 'build' || item.label === 'bundle:check' || item.label === 'built-assets';
  const timings = [];
  const started = performance.now();
  const report = () => {
    console.log(`\nValidation ${formatDuration(performance.now() - started)}:`);
    for (const row of timings) console.log(`  ${formatDuration(row.durationMs).padStart(7)}  ${row.status === 0 ? 'ok  ' : 'FAIL'}  ${row.label}`);
  };
  const independent = commands.filter((entry) => !isTest(entry) && !isBuildChain(entry));
  if (independent.length) {
    const outcome = await runTestUnits(independent.map((item) => ({ name: item.label, command: item.executable, args: item.args })),
      { concurrency: independent.length, label: 'checks', cwd: workspaceRoot, heartbeatMs: 0 });
    for (const row of outcome.results) timings.push({ label: row.name, status: row.status === 'passed' ? 0 : 1, durationMs: row.durationMs });
    if (!outcome.passed) { report(); return 1; }
  }
  for (const item of commands.filter(isBuildChain)) {
    const row = runStatic(item);
    timings.push(row);
    if (row.status !== 0) { report(); return row.status ?? 1; }
  }
  const tests = commands.filter(isTest);
  if (tests.length === 0) { report(); return 0; }
  const { env, cleanup } = prepareScriptTestEnvironment(workspaceRoot);
  try {
    const units = testUnitsForPlan(tests, { scriptEnvironment: env });
    const outcome = await runTestUnits(units, { concurrency: testConcurrency(), label: 'validate', cwd: workspaceRoot, cleanup });
    summarizeTestUnits(outcome, { label: 'validate', limit: 20 });
    recordTestTimings(outcome, units, { label: `validate:${mode}` });
    timings.push({ label: `tests (${tests.map((item) => item.label).join(', ')})`, status: outcome.passed ? 0 : 1, durationMs: outcome.wallMs });
    report();
    return outcome.passed ? 0 : 1;
  } finally {
    cleanup();
  }
}

const isDirectExecution = Boolean(
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (isDirectExecution) {
  try {
    const plan = buildPlan(mode);
    printPlan(plan);
    const cacheBefore = snapshotCache(workspaceRoot);
    const status = await runCommands(plan.commands);
    if (status !== 0) process.exit(status);
    const growth = cacheGrowthFailure(workspaceRoot, cacheBefore);
    if (growth) {
      console.error(`\n${growth}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
