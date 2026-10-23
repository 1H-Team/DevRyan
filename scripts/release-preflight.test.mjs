import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { scratchParent } from './qa/run-root.mjs';
import { preflight, preflightInCleanCheckout } from './release-preflight.mjs';

const execute = promisify(execFile);

test('local preflight reports every check and fails on any of them', async () => {
  const shipped = JSON.parse(readFileSync(new URL('./fixtures/shipped-updater/shipped.json', import.meta.url), 'utf8'));
  const run = (failing) => async (command, args) => {
    if (command === failing) throw new Error(`${command} failed`);
    if (command === 'bun') assert.deepEqual(args, ['install', '--frozen-lockfile', '--dry-run', '--ignore-scripts']);
    if (command === 'git' && args[0] === 'rev-parse' && args[1].includes(':')) {
      const [tag, file] = args[1].split(':');
      return { stdout: `${shipped[tag][file]}\n` };
    }
    return { stdout: 'a'.repeat(40) };
  };
  const lines = [];
  const output = await preflight({ environment: {}, run: run(null), log: line => lines.push(line), localOnly: true });
  assert.equal(output.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(lines.map(line => line.split(':')[0]), ['[preflight] pass version files and bun.lock', '[preflight] pass CHANGELOG section', '[preflight] pass frozen lockfile', '[preflight] pass shipped discovery fixtures']);
  assert.match(lines[1], /within the 65536-byte updater budget/);
  await assert.rejects(preflight({ environment: {}, run: run('bun'), log: () => {}, localOnly: true }), /Release preflight failed: frozen lockfile/);
});

const git = (cwd, ...args) => execute('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd });
const runs = () => existsSync(scratchParent('release-preflight')) ? readdirSync(scratchParent('release-preflight')) : [];

test('the local preflight runs in a temporary worktree of the commit as it would be pushed, then removes it', async t => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preflight-repo-'));
  t.after(() => fs.rm(repository, { recursive: true, force: true }));
  await git(repository, 'init', '--quiet', '--initial-branch=main');
  await fs.writeFile(path.join(repository, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(repository, 'tracked.txt'), 'committed\n');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '--quiet', '-m', 'fixture');
  const head = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim();
  await fs.writeFile(path.join(repository, 'tracked.txt'), 'edited, not committed\n');
  await fs.writeFile(path.join(repository, 'new.txt'), 'untracked\n');
  await fs.mkdir(path.join(repository, 'node_modules/local'), { recursive: true });
  await fs.writeFile(path.join(repository, 'node_modules/local/index.js'), '');
  const statusBefore = (await git(repository, 'status', '--porcelain')).stdout;
  const before = runs();

  let seen;
  const status = await preflightInCleanCheckout({ repositoryRoot: repository, args: ['--local-only'], environment: { PATH: process.env.PATH },
    spawnPreflight: async (cwd, argv, env) => {
      seen = { cwd, argv, sha: env.GITHUB_SHA, tracked: await fs.readFile(path.join(cwd, 'tracked.txt'), 'utf8'),
        untracked: await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), nodeModules: existsSync(path.join(cwd, 'node_modules')) };
      return 0;
    } });
  assert.equal(status, 0);
  assert.ok(seen.cwd.startsWith(scratchParent('release-preflight') + path.sep), 'in the OS temp dir, never the repository');
  assert.deepEqual(seen.argv, ['--local-only']);
  assert.equal(seen.sha, head, 'GitHub checks name the real commit, not the snapshot');
  assert.equal(seen.tracked, 'edited, not committed\n');
  assert.equal(seen.untracked, 'untracked\n');
  assert.equal(seen.nodeModules, false, 'no node_modules, as on a fresh runner');
  assert.equal(existsSync(seen.cwd), false);
  assert.equal((await git(repository, 'worktree', 'list', '--porcelain')).stdout.match(/^worktree /gm).length, 1, 'the temporary worktree is unregistered');
  assert.equal((await git(repository, 'status', '--porcelain')).stdout, statusBefore, 'the real index and working tree are untouched');
  assert.equal((await git(repository, 'stash', 'list')).stdout, '', 'the shared stash list is untouched');
  assert.deepEqual(runs(), before);

  // A failing or crashing preflight cleans up the same way.
  assert.equal(await preflightInCleanCheckout({ repositoryRoot: repository, environment: {}, spawnPreflight: async () => 1 }), 1);
  await assert.rejects(preflightInCleanCheckout({ repositoryRoot: repository, environment: {}, spawnPreflight: async () => { throw new Error('crashed'); } }), /crashed/);
  assert.equal((await git(repository, 'worktree', 'list', '--porcelain')).stdout.match(/^worktree /gm).length, 1);
  assert.deepEqual(runs(), before);
});
