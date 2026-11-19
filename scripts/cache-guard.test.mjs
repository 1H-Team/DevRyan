// The scratch guard, proven on seeded violations in
// throwaway Git repositories under the OS temp dir (never in this checkout).
// No test depends on a short real-time budget: every wait is for evidence (a
// file the unit writes) with a deadline that only bounds a hang.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { GUARD_ALLOWANCES, KEPT_CACHE_FAMILIES, scratchGrowthFailure, snapshotRepository } from './cache-guard.mjs';
import { runTestUnits } from './test-pool.mjs';

const HANG_BOUND_MS = 120_000;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const runRootUrl = pathToFileURL(path.join(import.meta.dirname, 'qa/run-root.mjs')).href;
const scratch = (t, prefix) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => { spawnSync('chmod', ['-R', 'u+rwx', directory]); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
};

function repository(t) {
  const root = scratch(t, 'devryan-scratch-guard-');
  const put = (relative, content = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  put('.gitignore', '.cache/\nnode_modules\ndist\n');
  put('package.json', '{}\n');
  put('packages/web/server/index.js', 'export {};\n');
  put('packages/agents-core/src/index.ts', 'export {};\n');
  for (const name of ['electron', 'native', 'ui']) put(`packages/${name}/package.json`, '{}\n');
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@devryan.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  put('packages/web/node_modules/dependency/index.js');
  for (const family of ['v2-validation', 'qa', 'perf']) fs.mkdirSync(path.join(root, '.cache', family), { recursive: true });
  put('.cache/v2-validation/older-run/kept.txt');
  return { root, put, git };
}

async function waitFor(file, describe) {
  for (const started = Date.now(); !fs.existsSync(file);) {
    assert.ok(Date.now() - started < HANG_BOUND_MS, `${describe()} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The unit renames the file into place, so it is whole once it exists; the deadline only bounds a hang.
  for (const started = Date.now(); ;) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      assert.ok(Date.now() - started < HANG_BOUND_MS, `${describe()} never parsed: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/**
 * A unit that makes one createRunRoot run directory (with no signal handlers, as a
 * test whose cleanup cannot run) and one loose folder under .cache, reports, then hangs.
 */
function hangingUnit(t, root, name) {
  const directory = scratch(t, 'devryan-scratch-unit-');
  const script = path.join(directory, 'unit.mjs'), ready = path.join(directory, 'ready.json');
  fs.writeFileSync(script, `import fs from 'node:fs';
import path from 'node:path';
import { createRunRoot } from ${JSON.stringify(runRootUrl)};
const root = ${JSON.stringify(root)};
const run = createRunRoot({ parent: path.join(root, '.cache/v2-validation'), prefix: ${JSON.stringify(`${name}-`)}, owner: 'fixture', env: {}, argv: [], signals: false });
fs.writeFileSync(path.join(run.dir, 'graph.mjs'), 'x');
fs.mkdirSync(path.join(root, '.cache/qa', ${JSON.stringify(`${name}-loose`)}));
fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify({ pid: process.pid, run: path.relative(root, run.dir) }));
fs.renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
setInterval(() => {}, 1000);
`);
  return { unit: { name, command: process.execPath, args: [script] }, ready, script };
}

test('every allowance names its writer and the prune list is derived from it', () => {
  for (const entry of GUARD_ALLOWANCES) assert.ok(entry.reason?.length > 10, JSON.stringify(entry));
  for (const { pattern } of GUARD_ALLOWANCES.filter((entry) => entry.kind === 'dropping')) {
    assert.match(pattern.source, /^\^.*\$$/, `${pattern} is anchored at both ends`);
    assert.doesNotMatch(pattern.source, /^\^[^(]*\|/, `${pattern} has no top-level alternation that escapes an anchor`);
  }
  assert.deepEqual(KEPT_CACHE_FAMILIES, ['typecheck', 'shared', 'session-execution', 'windows-native', 'worktrees', 'sessions']);
});

test('a new file outside .cache, an empty directory and a dot-named directory in a package folder each fail the gate', (t) => {
  const { root, put } = repository(t);
  const before = snapshotRepository(root);
  const seeds = [
    ['packages/web/stray-output.json', () => put('packages/web/stray-output.json', '{}'), /- packages\/web\/stray-output\.json \(/],
    ['packages/agents-core/deepwork-goal-gate-AbC123', () => fs.mkdirSync(path.join(root, 'packages/agents-core/deepwork-goal-gate-AbC123')),
      /- packages\/agents-core\/deepwork-goal-gate-AbC123 \(empty directory\)/],
    ['packages/web/.ffmpeg-test-XyZ', () => put('packages/web/.ffmpeg-test-XyZ/ffmpeg/README'), /- packages\/web\/\.ffmpeg-test-XyZ \(directory, .+\)\n {4}packages\/web\/\.ffmpeg-test-XyZ\/ffmpeg\/README/],
    // Outputs are whole path segments, and droppings are file names only.
    ['packages/web/dist-extra', () => put('packages/web/dist-extra/a.js'), /- packages\/web\/dist-extra \(directory/],
    ['packages/web/.DS_Store', () => put('packages/web/.DS_Store/hidden.txt'), /- packages\/web\/\.DS_Store \(directory/],
  ];
  for (const [seeded, create, expected] of seeds) {
    create();
    const failure = scratchGrowthFailure(root, before);
    assert.match(failure ?? '', /These 1 entry appeared in the repository during this run/, seeded);
    assert.match(failure, expected, seeded);
    assert.match(failure, /A file you created yourself during the run \(or another tool did\) is not test scratch: re-run/);
    assert.match(failure, /Scratch a test left must be fixed in the test/);
    assert.doesNotMatch(failure, /cache:prune/, 'the prune hint is for .cache leftovers');
    fs.rmSync(path.join(root, seeded), { recursive: true, force: true });
    assert.equal(scratchGrowthFailure(root, before), null, `${seeded} removed`);
  }
  // A dropping matches one whole file name: a name that merely starts or ends like one is reported.
  for (const nearMiss of ['packages/ui/.DS_Store-scratch', 'packages/ui/x.DS_Store', 'packages/web/server/.index.js.swp.tmp', 'packages/web/server/49130',
    'packages/web/server/index.js~.bak', 'packages/web/server/~', 'packages/web/server/a.#lock', 'packages/web/server/index.js___jb_tmp___.json']) {
    put(nearMiss);
    assert.match(scratchGrowthFailure(root, before) ?? '', new RegExp(`These 1 entry appeared[^]*- ${escape(nearMiss)} \\(`), nearMiss);
    fs.rmSync(path.join(root, nearMiss));
  }
  put('.cache/qa/left-behind-run/log.txt');
  put('.cache/top-level-scratch-1/a.txt');
  const failure = scratchGrowthFailure(root, before);
  assert.match(failure, /These 2 entries appeared[^]*- \.cache\/qa\/left-behind-run \(directory[^]*- \.cache\/top-level-scratch-1 \(directory/);
  assert.match(failure, /preview with `bun run cache:prune`/);
});

test('outputs, kept caches, family folders, dependencies, .claude, droppings and nested checkouts may change', (t) => {
  const { root, put } = repository(t);
  put('.worktrees/lane/.git', 'gitdir: elsewhere\n');
  fs.rmSync(path.join(root, '.cache'), { recursive: true, force: true });
  const before = snapshotRepository(root);
  put('packages/web/dist/assets/index-abc.js');
  put('packages/electron/dist-bundle/main.mjs');
  put('packages/web/node_modules/.vite/deps/x.js');
  put('packages/native/target/debug/build.log');
  put('.cache/typecheck/ui.tsbuildinfo');
  for (const family of ['v2-validation', 'qa', 'perf']) fs.mkdirSync(path.join(root, '.cache', family), { recursive: true });
  put('.claude/worktrees/new-agent/.git', 'gitdir: elsewhere\n');
  put('.claude/settings.local.json', '{}');
  for (const dropping of ['packages/ui/.DS_Store', 'packages/web/server/.index.js.swp', 'packages/web/server/4913', 'packages/web/server/index.js~',
    'packages/web/server/.#index.js', 'packages/web/server/index.js___jb_tmp___']) put(dropping);
  put('.worktrees/lane/new-file-in-that-checkout.txt');
  assert.equal(scratchGrowthFailure(root, before), null);
  // A tracked file that reappears (a checkout restoring it) is not scratch.
  fs.rmSync(path.join(root, 'package.json'));
  const withoutTracked = snapshotRepository(root);
  assert.equal(spawnSync('git', ['checkout', '--', 'package.json'], { cwd: root }).status, 0);
  assert.equal(scratchGrowthFailure(root, withoutTracked), null);
});

test('the walk never follows a symbolic link: new content in a linked folder is not entered, a new link is reported', (t) => {
  const { root } = repository(t);
  const outside = scratch(t, 'devryan-scratch-outside-');
  fs.symlinkSync(outside, path.join(root, '.cache/qa/linked'));
  const before = snapshotRepository(root);
  fs.writeFileSync(path.join(outside, 'new-in-target.txt'), 'x');
  assert.equal(scratchGrowthFailure(root, before), null);
  fs.symlinkSync(outside, path.join(root, '.cache/qa/new-link'));
  assert.match(scratchGrowthFailure(root, before), /- \.cache\/qa\/new-link \(/);
});

test('the guard fails closed: a symbolic-link .cache, an unreadable folder and a Git failure are reported as not judged', (t) => {
  {
    const { root } = repository(t);
    const target = scratch(t, 'devryan-scratch-linked-cache-');
    fs.renameSync(path.join(root, '.cache'), path.join(target, 'cache'));
    fs.symlinkSync(path.join(target, 'cache'), path.join(root, '.cache'));
    const before = snapshotRepository(root);
    fs.mkdirSync(path.join(target, 'cache/qa/leak'));
    assert.match(scratchGrowthFailure(root, before), /could not judge this run:\n- \.cache is not a real directory/);
  }
  {
    const { root } = repository(t);
    fs.chmodSync(path.join(root, '.cache/v2-validation/older-run'), 0o000);
    const before = snapshotRepository(root);
    fs.chmodSync(path.join(root, '.cache/v2-validation/older-run'), 0o700);
    assert.match(scratchGrowthFailure(root, before), /could not judge this run:\n- \.cache\/v2-validation\/older-run could not be read \(EACCES\)/);
  }
  {
    const { root } = repository(t);
    const before = snapshotRepository(root);
    fs.mkdirSync(path.join(root, '.cache/qa/new-run'));
    fs.renameSync(path.join(root, '.git'), path.join(root, '.git-away'));
    assert.match(scratchGrowthFailure(root, before), /could not judge this run:\n- git ls-files failed[^]*New entries it saw[^]*- \.cache\/qa\/new-run/);
  }
});

test('a unit the pool kills leaves its scratch in place, and the gate names it with the exact command to remove it', async (t) => {
  const { root } = repository(t);
  const before = snapshotRepository(root);
  const { unit, ready } = hangingUnit(t, root, 'native-stream-killed');
  const pool = runTestUnits([unit], { concurrency: 1, label: 'fixture', env: process.env, log: () => {}, write: () => {}, loadCeiling: Number.POSITIVE_INFINITY });
  const started = await waitFor(ready, () => 'the unit\'s ready file');
  process.kill(started.pid, 'SIGKILL');
  const outcome = await pool;
  assert.equal(outcome.results[0].signal, 'SIGKILL');
  assert.ok(fs.existsSync(path.join(root, started.run, 'graph.mjs')), 'the pool removes nothing a killed unit made');
  assert.ok(fs.existsSync(path.join(root, '.cache/qa/native-stream-killed-loose')));
  assert.ok(fs.existsSync(path.join(root, '.cache/v2-validation/older-run/kept.txt')));
  const failure = scratchGrowthFailure(root, before);
  assert.match(failure, new RegExp(`These 2 entries appeared[^]*- \\.cache/qa/native-stream-killed-loose \\(empty directory\\)[^]*- ${escape(started.run)} \\(directory`));
  assert.match(failure, /Nothing was removed\. A test that was killed/);
  assert.match(failure, /`bun run cache:prune` keeps anything modified in the last hour; to remove these leftovers now, run:/);
  const command = failure.split('\n').find((line) => line.startsWith('  rm -rf -- '));
  assert.equal(command, `  rm -rf -- '${path.join(root, '.cache/qa/native-stream-killed-loose')}' '${path.join(root, started.run)}'`);
  assert.match(failure, /after an hour, preview with `bun run cache:prune` and delete with `bun run cache:prune -- --apply`/);
  // Running the printed command clears exactly what was named, and the gate passes.
  assert.equal(spawnSync('/bin/sh', ['-c', command.trim()]).status, 0);
  assert.equal(scratchGrowthFailure(root, before), null);
  assert.ok(fs.existsSync(path.join(root, '.cache/v2-validation/older-run/kept.txt')));
});

test('the printed remove command quotes every path for the shell', (t) => {
  const { root } = repository(t);
  const before = snapshotRepository(root);
  const awkward = ".cache/qa/it's $(touch pwned) run";
  fs.mkdirSync(path.join(root, awkward));
  const command = scratchGrowthFailure(root, before).split('\n').find((line) => line.startsWith('  rm -rf -- '));
  assert.equal(spawnSync('/bin/sh', ['-c', command.trim()], { cwd: root }).status, 0);
  assert.equal(fs.existsSync(path.join(root, awkward)), false);
  assert.equal(fs.existsSync(path.join(root, 'pwned')), false, 'nothing in a path is executed');
});

test('an interrupted pool exits 130 and leaves what its stopped unit made for the gate to name', async (t) => {
  const { root } = repository(t);
  const before = snapshotRepository(root);
  const { script, ready } = hangingUnit(t, root, 'interrupted-run');
  const driverFile = path.join(scratch(t, 'devryan-scratch-driver-'), 'driver.mjs');
  fs.writeFileSync(driverFile, `import { runTestUnits } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'test-pool.mjs')).href)};
await runTestUnits([{ name: 'hang', command: process.execPath, args: [${JSON.stringify(script)}] }],
  { concurrency: 1, label: 'fixture', log: () => {}, loadCeiling: Infinity });
`);
  const child = spawn(process.execPath, [driverFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const started = await waitFor(ready, () => `the unit's ready file (driver stderr: ${stderr})`);
  child.kill('SIGINT');
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 130, stderr);
  assert.ok(fs.existsSync(path.join(root, started.run, 'graph.mjs')), 'an interrupt removes nothing in the repository');
  assert.match(scratchGrowthFailure(root, before), new RegExp(`These 2 entries appeared[^]*- \\.cache/qa/interrupted-run-loose[^]*- ${escape(started.run)} \\(directory[^]*rm -rf -- `));
});
