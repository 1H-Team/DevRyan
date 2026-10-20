#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cacheGrowthFailure, snapshotCache } from './cache-guard.mjs';

const mode = process.argv[2] ?? 'fast';

const workspaceRoot = process.cwd();
const tsLikeExtensions = new Set(['.ts', '.tsx']);
const testFilePattern = /(?:^|[./-])test\.[cm]?[jt]sx?$/;

const packages = {
  ui: {
    prefix: 'packages/ui/',
    lint: ['bun', ['run', 'lint:ui']],
    typeCheck: ['bun', ['run', 'type-check:ui']],
    test: ['bun', ['run', '--cwd', 'packages/ui', 'test']],
  },
  web: {
    prefix: 'packages/web/',
    lint: ['bun', ['run', 'lint:web']],
    typeCheck: ['bun', ['run', 'type-check:web']],
    test: ['bun', ['run', '--cwd', 'packages/web', 'test']],
  },
  electron: {
    prefix: 'packages/electron/',
    lint: ['bun', ['run', 'lint:electron']],
    typeCheck: ['bun', ['run', 'type-check:electron']],
    test: ['bun', ['run', '--cwd', 'packages/electron', 'test']],
  },
  desktop: {
    // Frozen legacy Tauri package: run JS contract tests; cargo tests need native build assets.
    prefix: 'packages/desktop/',
    lint: ['bun', ['run', 'lint:desktop']],
    typeCheck: ['bun', ['run', 'type-check:desktop']],
    test: ['bun', ['run', '--cwd', 'packages/desktop', 'test:managed-orchestration']],
  },
  bots: {
    prefix: 'packages/bots-runtime/',
    test: ['bun', ['run', '--cwd', 'packages/bots-runtime', 'test']],
  },
  botSupervisor: {
    prefix: 'packages/bot-supervisor/',
    test: ['bun', ['run', '--cwd', 'packages/bot-supervisor', 'test']],
  },
  botEngineProxy: {
    prefix: 'packages/bot-engine-proxy/',
    test: ['bun', ['run', '--cwd', 'packages/bot-engine-proxy', 'test']],
  },
  botEgress: {
    prefix: 'packages/bot-egress/',
    test: ['bun', ['run', '--cwd', 'packages/bot-egress', 'test']],
  },
  botComputer: {
    prefix: 'packages/bot-computer/',
    test: ['bun', ['run', '--cwd', 'packages/bot-computer', 'test']],
  },
  botIndexer: {
    prefix: 'packages/bot-indexer/',
    test: ['bun', ['run', '--cwd', 'packages/bot-indexer', 'test']],
  },
  botDb: {
    prefix: 'packages/bot-db/',
    test: ['bun', ['run', '--cwd', 'packages/bot-db', 'test']],
  },
  cursor: {
    prefix: 'packages/cursor-sdk-runtime/',
    test: ['bun', ['test', 'packages/cursor-sdk-runtime']],
  },
  orchestration: {
    prefix: 'packages/orchestration-runtime/',
    test: ['bun', ['test', 'packages/orchestration-runtime']],
  },
  shared: {
    prefix: 'packages/shared-runtime/',
    test: ['bun', ['run', '--cwd', 'packages/shared-runtime', 'test']],
  },
  harness: {
    prefix: 'packages/harness-runtime/',
    test: ['bun', ['test', 'packages/harness-runtime']],
  },
  agentsCore: {
    prefix: 'packages/agents-core/',
    typeCheck: ['bun', ['run', '--cwd', 'packages/agents-core', 'type-check']],
    test: ['bun', ['run', '--cwd', 'packages/agents-core', 'test']],
  },
};

// Shared configuration: a change re-checks lint and types everywhere.
const sharedConfigFiles = new Set([
  'package.json',
  'bun.lock',
  'eslint.config.js',
  'tsconfig.json',
  'vite-theme-plugin.ts',
  '.opencode/opencode.json',
]);

const docsOnlyExtensions = new Set(['.md', '.mdx', '.txt']);

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

function changedFilesFromGit() {
  // Committed but unpushed work counts: compare with the upstream branch unless VALIDATE_BASE is set.
  const base = process.env.VALIDATE_BASE || runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { ignoreErrors: true }).trim();
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
    'eslint',
    '--cache',
    '--cache-location', '.cache/eslint/changed',
    '--config', 'eslint.config.js',
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
      if (name && packages[name].test) tests.add(name);
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
export function buildPlan(requestedMode, providedFiles) {
  if (requestedMode === 'full') {
    return { files: providedFiles ?? [], commands: fullCommands(), reason: 'full validation requested' };
  }
  if (requestedMode !== 'fast') throw new Error(`Unknown validation mode: ${requestedMode} (use fast or full)`);

  const files = providedFiles ?? changedFilesFromGit();
  const codeFiles = files.filter((file) => !isDocsOnlyFile(file));
  const docs = files.some((file) => /\.mdx?$/.test(file)) ? [command('docs:validate', 'bun', ['run', 'docs:validate'])] : [];
  if (files.length === 0) return { files, commands: [command('test:startup', 'bun', ['run', 'test:startup'])], reason: 'no changed files; startup contract only' };
  if (codeFiles.length === 0) return { files, commands: docs, reason: 'docs-only changes' };

  const changedPackages = new Set(files.map(packageForFile).filter(Boolean));
  const shared = files.some(isSharedConfigFile);
  const commands = [...docs];
  if (shared) {
    commands.push(command('lint:full', 'bun', ['run', 'lint']), command('type-check:full', 'bun', ['run', 'type-check']));
  } else {
    commands.push(...changedLintCommand(files));
    commands.push(...packageCommands(affectedTypeCheckPackages(changedPackages, true), 'typeCheck'));
  }
  commands.push(...importBoundaryCommands(files));
  if (files.some(isScriptsFile)) commands.push(command('test:scripts', 'bun', ['run', 'test:scripts']));
  commands.push(...packageCommands(affectedTests(files), 'test'));
  commands.push(command('test:startup', 'bun', ['run', 'test:startup']));
  return { files, commands, reason: shared ? 'shared configuration changed; lint and type-check everything' : 'changed files' };
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

function runCommands(commands) {
  for (const item of commands) {
    console.log(`\n$ ${[item.executable, ...item.args].join(' ')}`);
    const result = spawnSync(item.executable, item.args, {
      cwd: workspaceRoot,
      stdio: 'inherit',
      env: process.env,
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
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
    runCommands(plan.commands);
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
