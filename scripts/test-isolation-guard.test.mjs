import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ISOLATION_MARKER, ISOLATION_ROOT_VARIABLE, NODE_ISOLATION_ARGS, REFUSAL_HEADLINE,
  createTestIsolation, isolationProblems, readIsolationMarker, singleFileCommands, spawnStatus, withTestIsolationSync,
} from './test-isolation-guard.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);

/** A scratch parent and a stand-in "real" home, so no case touches the developer's home. */
function scratch() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'devryan-isolation-guard-')));
  const home = path.join(directory, 'real-home');
  mkdirSync(home);
  return { directory, home, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** The developer's shell as the guard sees it: a real HOME, inherited selectors, no isolation. */
const shellEnvironment = (home) => {
  const env = { ...process.env, HOME: home, DEVRYAN_DATA_DIR: path.join(home, '.config/devryan'), OPENCHAMBER_DATA_DIR: path.join(home, '.config/openchamber'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config/opencode'), OPENCODE_CONFIG: path.join(home, 'opencode.json'), DEVRYAN_RUNTIME_BUNDLE_ROOT: path.join(home, 'bundles'),
    DEVRYAN_ELECTRON_USER_DATA_DIR: path.join(home, 'profile'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GIT_DIR: path.join(home, 'repo/.git'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Real Person', DEVRYAN_TEST_SEED: '7', DEVRYAN_KEEP_ARTIFACTS: '',
    OPENCODE_DB: path.join(home, 'opencode.db'), DEVRYAN_EXECUTION_ARTIFACTS: path.join(home, 'artifacts'), DEVRYAN_SESSION_TMP: path.join(home, 'tmp'),
    OPENCODE_BINARY: path.join(home, 'bin/opencode'), DEVRYAN_STANDARD_OPENCODE_BINARY: path.join(home, 'bin/opencode'), DEVRYAN_SERVER_URL: 'http://127.0.0.1:3000',
    OPENCODE_PORT: '4096', OPENCODE_SERVER_PASSWORD: 'secret', SSH_AUTH_SOCK: path.join(home, 'agent.sock'), DEVRYAN_LEDGER_WORKER: '1' };
  delete env[ISOLATION_ROOT_VARIABLE];
  return env;
};

describe('test isolation environment', () => {
  test('puts HOME, the XDG folders and Git configuration in one private root and drops inherited root selectors', () => {
    const { directory, home, cleanup } = scratch();
    try {
      const isolation = createTestIsolation({ environment: shellEnvironment(home), parent: path.join(directory, 'runs') });
      const { env, root } = isolation;
      assert.equal(isolation.owned, true);
      assert.ok(inside(root, path.join(directory, 'runs')));
      assert.equal(env[ISOLATION_ROOT_VARIABLE], root);
      assert.equal(env.HOME, path.join(root, 'home'));
      for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'GIT_CONFIG_GLOBAL']) {
        assert.ok(inside(env[key], env.HOME), `${key} is inside the private home`);
      }
      for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) assert.ok(existsSync(env[key]), key);
      assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
      assert.match(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8'), /email = tests@devryan\.invalid/);
      for (const key of ['DEVRYAN_DATA_DIR', 'OPENCHAMBER_DATA_DIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'DEVRYAN_RUNTIME_BUNDLE_ROOT',
        'DEVRYAN_ELECTRON_USER_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
        'OPENCODE_DB', 'DEVRYAN_EXECUTION_ARTIFACTS', 'DEVRYAN_SESSION_TMP', 'OPENCODE_BINARY', 'DEVRYAN_STANDARD_OPENCODE_BINARY', 'DEVRYAN_SERVER_URL',
        'OPENCODE_PORT', 'OPENCODE_SERVER_PASSWORD', 'SSH_AUTH_SOCK']) {
        assert.equal(env[key], undefined, `${key} is removed so the root resolves under the private home`);
      }
      // Test controls and platform inputs pass through.
      assert.equal(env.DEVRYAN_TEST_SEED, '7');
      assert.equal(env.DEVRYAN_LEDGER_WORKER, '1', 'a behaviour switch passes through');
      assert.equal(env.DEVRYAN_KEEP_ARTIFACTS, '');
      assert.equal(env.PATH, process.env.PATH);
      const marker = readIsolationMarker(env);
      assert.equal(marker.root, root);
      assert.ok(marker.realHomes.includes(home));
      assert.deepEqual(isolationProblems({ env, home: env.HOME }), []);
      // A runner started by another runner shares its root.
      const nested = createTestIsolation({ environment: env, parent: path.join(directory, 'other') });
      assert.deepEqual([nested.owned, nested.root], [false, root]);
      nested.cleanup();
      assert.ok(existsSync(root));
      isolation.cleanup('failed');
      assert.equal(existsSync(root), false, 'the private root is removed when the run ends, whatever its result');
    } finally { cleanup(); }
  });

  test('names every way a process can fail to be isolated', () => {
    const { directory, home, cleanup } = scratch();
    try {
      const shell = shellEnvironment(home);
      assert.deepEqual(isolationProblems({ env: shell, home }), [`${ISOLATION_ROOT_VARIABLE} is not set`]);
      assert.match(isolationProblems({ env: { ...shell, [ISOLATION_ROOT_VARIABLE]: directory }, home })[0], /does not name a private root/);
      const { env, root, cleanup: remove } = createTestIsolation({ environment: shell, parent: path.join(directory, 'runs') });
      try {
        // Bun fixes its home directory at startup: a changed HOME does not move it.
        assert.match(isolationProblems({ env, home }).join('\n'), /the home directory .* is outside the private root/);
        assert.match(isolationProblems({ env: { ...env, HOME: home }, home: env.HOME }).join('\n'), /changed after the process started/);
        assert.match(isolationProblems({ env: { ...env, XDG_STATE_HOME: path.join(home, '.local/state') }, home: env.HOME }).join('\n'), /XDG_STATE_HOME .* is outside/);
        assert.match(isolationProblems({ env: { ...env, OPENCODE_CONFIG_DIR: path.join(home, '.config/opencode') }, home: env.HOME }).join('\n'), /OPENCODE_CONFIG_DIR is set .* outside the private root/);
        assert.match(isolationProblems({ env: { ...env, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') }, home: env.HOME }).join('\n'), /GIT_CONFIG_GLOBAL/);
        // Endpoints and credentials are refused whatever their value.
        for (const [key, value] of [['DEVRYAN_SERVER_URL', 'http://127.0.0.1:3000'], ['OPENCODE_PORT', '4096'], ['OPENCODE_SERVER_PASSWORD', 'x'], ['SSH_AUTH_SOCK', path.join(home, 's')]]) {
          assert.match(isolationProblems({ env: { ...env, [key]: value }, home: env.HOME }).join('\n'), new RegExp(`${key} is set`), key);
        }
        // Inside the root is fine: tests may point a root at their own fixture there.
        assert.deepEqual(isolationProblems({ env: { ...env, DEVRYAN_DATA_DIR: path.join(root, 'fixture') }, home: env.HOME }), []);
        writeFileSync(path.join(root, ISOLATION_MARKER), '{"schemaVersion":1,"root":"/elsewhere","realHomes":[]}');
        assert.match(isolationProblems({ env, home: env.HOME })[0], /does not name a private root/);
      } finally { remove(); }
    } finally { cleanup(); }
  });

  test('a synchronous runner removes its root after its children stop', () => {
    const { directory, home, cleanup } = scratch();
    try {
      let seen = null;
      const status = withTestIsolationSync((env) => { seen = env[ISOLATION_ROOT_VARIABLE]; return 3; }, { environment: shellEnvironment(home) });
      assert.equal(status, 3);
      assert.ok(seen && !existsSync(seen));
      // A child stopped by an interrupt is reported as one, and the root still goes.
      const interrupted = withTestIsolationSync((env) => { seen = env[ISOLATION_ROOT_VARIABLE];
        return spawnStatus(spawnSync('/bin/sh', ['-c', 'kill -INT $$'], { env })); }, { environment: shellEnvironment(home) });
      assert.equal(interrupted, 130);
      assert.ok(!existsSync(seen));
    } finally { cleanup(); }
  });

  test('a Node process started without the environment builds it before any module loads, and removes it on exit and on interrupt', async () => {
    const { home, cleanup } = scratch();
    try {
      const env = { ...shellEnvironment(home) };
      delete env.NODE_TEST_CONTEXT;
      const probe = `import os from 'node:os'; console.log(JSON.stringify({ root: process.env.${ISOLATION_ROOT_VARIABLE}, home: os.homedir(),
        selector: process.env.OPENCODE_CONFIG_DIR ?? null })); if (process.argv[1] === 'interrupt') { process.kill(process.pid, 'SIGINT'); setTimeout(() => {}, 5000); }`;
      for (const mode of ['exit', 'interrupt']) {
        const result = spawnSync(process.execPath, [...NODE_ISOLATION_ARGS, '--input-type=module', '-e', probe, mode], { env, encoding: 'utf8' });
        const report = JSON.parse(result.stdout.trim().split('\n')[0]);
        assert.ok(inside(report.home, report.root), `${mode}: the home is inside the private root\n${result.stderr}`);
        assert.equal(report.selector, null, 'inherited selectors are removed');
        assert.equal(existsSync(report.root), false, `${mode}: the root is removed`);
        if (mode === 'interrupt') assert.equal(result.signal, 'SIGINT', 'the interrupt then takes its course');
        else assert.equal(result.status, 0);
      }
      assert.deepEqual(listTree(home), []);
    } finally { cleanup(); }
  });

  test('a Bun preload cannot see the command line, which is why a bare bun test is refused rather than run again', () => {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'devryan-bun-preload-')));
    try {
      writeFileSync(path.join(directory, 'probe.mjs'), 'console.log("ARGV" + JSON.stringify(process.argv.slice(1)));\n');
      writeFileSync(path.join(directory, 'bunfig.toml'), '[test]\npreload = ["./probe.mjs"]\n');
      writeFileSync(path.join(directory, 'a.test.mjs'), 'import { test } from "bun:test"; test("named case", () => {});\n');
      const result = spawnSync('bun', ['test', './a.test.mjs', '-t', 'named case', '--bail'], { cwd: directory, encoding: 'utf8', env: process.env });
      const argv = JSON.parse(/ARGV(\[.*\])/.exec(result.stdout + result.stderr)[1]);
      // Only the test file: no `test`, no name filter, no flags to run again with.
      assert.deepEqual(argv, [path.join(directory, 'a.test.mjs')]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

// Every runner the repository uses, started directly in its directory. Each
// first runs its canary in this (isolated) process's environment, then again
// without the guard's environment, where it must refuse before any test runs.
const vitest = path.join(path.dirname(createRequire(path.join(repositoryRoot, 'packages/web/package.json')).resolve('vitest/package.json')), 'vitest.mjs');
// Bun runners refuse without the guard's environment (Bun fixes HOME at startup);
// Node runners (`--import` node:test, Vitest) build it in-process and run isolated.
const RUNNERS = [
  { name: 'scripts node:test', cwd: '.', command: process.execPath, args: [...NODE_ISOLATION_ARGS, '--test', 'scripts/test-isolation-canary.test.mjs'], direct: 'isolates' },
  { name: 'scripts bun test', cwd: '.', command: 'bun', args: ['test', './scripts/test-isolation-canary-bun.test.mjs'], direct: 'refuses' },
  { name: 'shared-runtime', cwd: 'packages/shared-runtime', command: 'bun', args: ['test', './testing/isolation-canary.test.js'], direct: 'refuses' },
  { name: 'harness-runtime', cwd: 'packages/harness-runtime', command: 'bun', args: ['test', './test/isolation-canary.test.js'], direct: 'refuses' },
  { name: 'harness-runtime (CI unit, repository root)', cwd: '.', command: 'bun', args: ['test', './packages/harness-runtime/test/isolation-canary.test.js'], direct: 'refuses' },
  { name: 'orchestration-runtime', cwd: 'packages/orchestration-runtime', command: 'bun', args: ['test', './isolation-canary.test.js'], direct: 'refuses' },
  { name: 'cursor-sdk-runtime', cwd: 'packages/cursor-sdk-runtime', command: 'bun', args: ['test', './isolation-canary.test.js'], direct: 'refuses' },
  { name: 'agents-core', cwd: 'packages/agents-core', command: 'bun', args: ['test', './test/isolation-canary.test.mjs'], direct: 'refuses' },
  { name: 'ui', cwd: 'packages/ui', command: 'bun', args: ['test', './src/test/isolation-canary.test.mjs'], direct: 'refuses' },
  { name: 'electron bun', cwd: 'packages/electron', command: 'bun', args: ['test', './tests/isolation-canary-bun.test.mjs'], direct: 'refuses' },
  { name: 'electron node:test', cwd: 'packages/electron', command: process.execPath, args: [...NODE_ISOLATION_ARGS, '--test', 'tests/isolation-canary.test.mjs'], direct: 'isolates' },
  { name: 'web test:native', cwd: 'packages/web', command: 'bun', args: ['test', './test/isolation-canary-native.test.mjs'], direct: 'refuses' },
  { name: 'web Vitest web', cwd: 'packages/web', command: process.execPath, args: [vitest, 'run', '--project=web', 'test/isolation-canary.test.mjs'], direct: 'isolates' },
  { name: 'web Vitest web-runtime-host', cwd: 'packages/web', command: process.execPath,
    args: [vitest, 'run', '--project=web-runtime-host', 'server/lib/opencode/runtime-host/isolation-canary.test.mjs'], direct: 'isolates' },
  // A source subfolder reads no bunfig.toml: the shared fixture stops the file instead.
  { name: 'harness-runtime from a source subfolder', cwd: 'packages/harness-runtime/lib', command: 'bun', args: ['test', './session-changes.test.js'],
    direct: 'refuses', guardedRun: false },
];

const run = ({ command, args, cwd }, env) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: path.join(repositoryRoot, cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.once('error', (error) => resolve({ status: null, output: `${output}${error.message}` }));
  child.once('exit', (status) => resolve({ status, output }));
});

describe('every runner runs the canary, and without the guard isolates itself or refuses', () => {
  test('runs the canary in each runner; started directly, each Node runner isolates itself and each Bun runner refuses', { timeout: 240_000 }, async () => {
    const { home, cleanup } = scratch();
    try {
      // Not isolated: a stand-in real home and no private root, as a developer's shell would be.
      const unguarded = { ...process.env, HOME: home };
      delete unguarded[ISOLATION_ROOT_VARIABLE];
      delete unguarded.NODE_TEST_CONTEXT;
      // This process's own environment when a runner isolated it, else a fresh one (a bare `node --test`).
      const isolation = createTestIsolation();
      const guarded = { ...isolation.env };
      delete guarded.NODE_TEST_CONTEXT;
      const outcomes = await Promise.all(RUNNERS.map(async (runner) => ({ runner,
        passing: runner.guardedRun === false ? null : await run(runner, guarded), direct: await run(runner, unguarded) })))
        .finally(() => isolation.cleanup());
      for (const { runner, passing, direct } of outcomes) {
        if (passing) assert.equal(passing.status, 0, `${runner.name}: the canary passes\n${passing.output}`);
        if (runner.direct === 'isolates') {
          assert.equal(direct.status, 0, `${runner.name}: started directly, it isolates itself and the canary passes\n${direct.output}`);
          continue;
        }
        assert.notEqual(direct.status, 0, `${runner.name}: refuses without the guard\n${direct.output}`);
        assert.ok(direct.output.includes(REFUSAL_HEADLINE), `${runner.name}: prints the refusal\n${direct.output}`);
        for (const line of singleFileCommands(path.join(repositoryRoot, runner.cwd)).commands) {
          assert.ok(direct.output.includes(line), `${runner.name}: names the single-file command for its folder: ${line}\n${direct.output}`);
        }
        assert.doesNotMatch(direct.output, /\b[1-9]\d* pass\b|# pass [1-9]|✓/, `${runner.name}: no test ran`);
      }
      // Nothing a test writes reached the stand-in home: every refusal came before any test,
      // and every self-isolating run moved its home first.
      // The runtimes write their own state there before any preload or setup file
      // runs: Vitest a startup token, Bun its transpiler cache.
      const runtimeOwned = ['Library/Application Support/vitest', 'Library/Caches/bun'];
      const parents = new Set(['Library', 'Library/Application Support', 'Library/Caches']);
      assert.deepEqual(listTree(home).filter((entry) => !parents.has(entry) && !runtimeOwned.some((owned) => inside(entry, owned))), []);
    } finally { cleanup(); }
  });

  test('a package test script builds its own private environment when started directly', { timeout: 120_000 }, async () => {
    const { home, cleanup } = scratch();
    try {
      const unguarded = { ...process.env, HOME: home };
      delete unguarded[ISOLATION_ROOT_VARIABLE];
      delete unguarded.NODE_TEST_CONTEXT;
      const result = await run({ command: 'bun', args: ['run', 'test', './testing/isolation-canary.test.js'], cwd: 'packages/shared-runtime' }, unguarded);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /1 pass/);
      assert.deepEqual(listTree(home), []);
    } finally { cleanup(); }
  });
});

function listTree(directory, prefix = '') {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return [relative, ...(entry.isDirectory() ? listTree(path.join(directory, entry.name), relative) : [])];
  }).sort();
}
