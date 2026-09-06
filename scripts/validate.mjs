#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'affected';

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
    prefix: 'packages/desktop/',
    lint: ['bun', ['run', 'lint:desktop']],
    typeCheck: ['bun', ['run', 'type-check:desktop']],
    test: ['bun', ['run', '--cwd', 'packages/desktop', 'test']],
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
  cursor: {
    prefix: 'packages/cursor-sdk-runtime/',
    test: ['bun', ['test', 'packages/cursor-sdk-runtime']],
  },
  orchestration: {
    prefix: 'packages/orchestration-runtime/',
    test: ['bun', ['test', 'packages/orchestration-runtime']],
  },
  harness: {
    prefix: 'packages/harness-runtime/',
    test: ['bun', ['test', 'packages/harness-runtime']],
  },
};

const fullValidationFiles = new Set([
  'package.json',
  'bun.lock',
  'eslint.config.js',
  'tsconfig.json',
  'vite-theme-plugin.ts',
  'scripts/validate.mjs',
]);

const fullValidationPrefixes = [
  '.github/',
  'scripts/',
];

const docsOnlyExtensions = new Set(['.md', '.txt']);

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
  const base = process.env.VALIDATE_BASE;
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

function isFullValidationFile(file) {
  return fullValidationFiles.has(file) || fullValidationPrefixes.some((prefix) => file.startsWith(prefix));
}

function isDocsOnlyFile(file) {
  return docsOnlyExtensions.has(path.extname(file)) || file.startsWith('docs/');
}

function isLintableFile(file) {
  return tsLikeExtensions.has(path.extname(file));
}

function isUiTestRelevant(file, quick) {
  if (!file.startsWith('packages/ui/src/')) return false;
  if (testFilePattern.test(file)) return true;
  if (quick) return false;

  // Decision: quick mode intentionally skips non-test UI tests to keep small,
  // likely-safe UI edits light; affected mode runs tests for state/sync/code paths.
  return [
    'packages/ui/src/sync/',
    'packages/ui/src/stores/',
    'packages/ui/src/lib/',
    'packages/ui/src/hooks/',
    'packages/ui/src/components/',
  ].some((prefix) => file.startsWith(prefix));
}

function isWebTestRelevant(file, quick) {
  if (!file.startsWith('packages/web/')) return false;
  if (testFilePattern.test(file)) return true;
  if (quick) return false;

  return file.startsWith('packages/web/server/') || file.startsWith('packages/web/bin/');
}


function isElectronTestRelevant(file, quick) {
  if (!file.startsWith('packages/electron/')) return false;
  if (testFilePattern.test(file)) return true;
  if (quick) return false;
  return ['.js', '.mjs'].includes(path.extname(file)) || file === 'packages/electron/package.json';
}

function isDesktopTestRelevant(file) {
  if (!file.startsWith('packages/desktop/')) return false;
  return file.startsWith('packages/desktop/src-tauri/src/')
    || file === 'packages/desktop/src-tauri/Cargo.toml'
    || file === 'packages/desktop/src-tauri/Cargo.lock'
    || file === 'packages/desktop/src-tauri/tauri.conf.json'
    || file === 'packages/desktop/package.json';
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
  if (includeDependents && changedPackages.has('harness')) {
    result.add('web');
  }
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
    command('type-check:full', 'bun', ['run', 'type-check']),
    command('test:full', 'bun', ['run', 'test:full']),
  ];
}

export function buildPlan(requestedMode, providedFiles) {
  const files = providedFiles ?? changedFilesFromGit();
  const changedPackages = new Set(files.map(packageForFile).filter(Boolean));
  const fullRequired = files.some((file) => isFullValidationFile(file));
  const codeFiles = files.filter((file) => !isDocsOnlyFile(file));

  if (requestedMode === 'full') {
    return { files, commands: fullCommands(), reason: 'full validation requested' };
  }

  if (requestedMode === 'lint-changed') {
    return { files, commands: changedLintCommand(files), reason: 'changed-file lint requested' };
  }

  if (requestedMode === 'type-check-affected') {
    const typeCheckPackages = affectedTypeCheckPackages(changedPackages, true);
    return { files, commands: packageCommands(typeCheckPackages, 'typeCheck'), reason: 'affected type-check requested' };
  }

  if (requestedMode === 'test-affected') {
    const tests = new Set();
    for (const file of files) {
      if (isUiTestRelevant(file, false)) tests.add('ui');
      if (isWebTestRelevant(file, false)) tests.add('web');
      if (isElectronTestRelevant(file, false)) tests.add('electron');
      if (isDesktopTestRelevant(file)) tests.add('desktop');
      if (isBotsTestRelevant(file)) tests.add('bots');
      if (isBotServiceTestRelevant(file, 'packages/bot-supervisor/')) tests.add('botSupervisor');
      if (isBotServiceTestRelevant(file, 'packages/bot-engine-proxy/')) tests.add('botEngineProxy');
      if (isBotServiceTestRelevant(file, 'packages/bot-egress/')) tests.add('botEgress');
      if (isBotServiceTestRelevant(file, 'packages/bot-computer/')) tests.add('botComputer');
      if (isBotServiceTestRelevant(file, 'packages/bot-indexer/')) tests.add('botIndexer');
      if (isCursorTestRelevant(file)) tests.add('cursor');
      if (isOrchestrationTestRelevant(file)) tests.add('orchestration');
      if (isHarnessTestRelevant(file)) tests.add('harness');
    }
    if (tests.has('cursor')) tests.add('web');
    if (tests.has('bots')) {
      tests.add('electron');
      tests.add('ui');
      tests.add('web');
    }
    if (tests.has('botSupervisor') || tests.has('botEngineProxy') || tests.has('botEgress')
      || tests.has('botComputer') || tests.has('botIndexer')) {
      tests.add('electron');
    }
    if (tests.has('orchestration')) {
      tests.add('ui');
      tests.add('web');
    }
    if (tests.has('harness')) {
      tests.add('web');
    }
    return { files, commands: packageCommands(tests, 'test'), reason: 'affected tests requested' };
  }

  if (requestedMode !== 'quick' && requestedMode !== 'affected') {
    throw new Error(`Unknown validation mode: ${requestedMode}`);
  }

  if (files.length === 0 || codeFiles.length === 0) {
    return { files, commands: [], reason: files.length === 0 ? 'no changed files detected' : 'docs-only changes detected' };
  }

  if (fullRequired) {
    return { files, commands: fullCommands(), reason: 'shared validation config changed; using full validation' };
  }

  const commands = [];
  const quick = requestedMode === 'quick';

  if (quick) {
    commands.push(...changedLintCommand(files));
  } else {
    commands.push(...packageCommands(changedPackages, 'lint'));
  }

  const typeCheckPackages = affectedTypeCheckPackages(changedPackages, !quick);
  commands.push(...packageCommands(typeCheckPackages, 'typeCheck'));

  const tests = new Set();
  for (const file of files) {
    if (isUiTestRelevant(file, quick)) tests.add('ui');
    if (isWebTestRelevant(file, quick)) tests.add('web');
    if (isElectronTestRelevant(file, quick)) tests.add('electron');
    if (isDesktopTestRelevant(file)) tests.add('desktop');
    if (isBotsTestRelevant(file)) tests.add('bots');
    if (isBotServiceTestRelevant(file, 'packages/bot-supervisor/')) tests.add('botSupervisor');
    if (isBotServiceTestRelevant(file, 'packages/bot-engine-proxy/')) tests.add('botEngineProxy');
    if (isBotServiceTestRelevant(file, 'packages/bot-egress/')) tests.add('botEgress');
    if (isBotServiceTestRelevant(file, 'packages/bot-computer/')) tests.add('botComputer');
    if (isBotServiceTestRelevant(file, 'packages/bot-indexer/')) tests.add('botIndexer');
    if (isCursorTestRelevant(file)) tests.add('cursor');
    if (isOrchestrationTestRelevant(file)) tests.add('orchestration');
    if (isHarnessTestRelevant(file)) tests.add('harness');
  }
  if (!quick && tests.has('cursor')) tests.add('web');
  if (!quick && tests.has('bots')) {
    tests.add('electron');
    tests.add('ui');
    tests.add('web');
  }
  if (!quick && (tests.has('botSupervisor') || tests.has('botEngineProxy') || tests.has('botEgress')
    || tests.has('botComputer') || tests.has('botIndexer'))) {
    tests.add('electron');
  }
  if (!quick && tests.has('orchestration')) {
    tests.add('ui');
    tests.add('web');
  }
  if (!quick && tests.has('harness')) {
    tests.add('web');
  }
  commands.push(...packageCommands(tests, 'test'));

  return { files, commands, reason: `${requestedMode} validation for changed files` };
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
    runCommands(plan.commands);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
