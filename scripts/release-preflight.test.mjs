import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { scratchParent } from './qa/run-root.mjs';
import { BACKEND_DEPLOY_INPUTS, backendDeployDecision, changedPipelinePaths, isPipelinePath, pipelineChangeGate, preflight, preflightInCleanCheckout } from './release-preflight.mjs';
import { DRY_RUN_GATES } from './release-candidate.mjs';

const execute = promisify(execFile);

test('local preflight reports every check and fails on any of them', async () => {
  const shipped = JSON.parse(readFileSync(new URL('./fixtures/shipped-updater/shipped.json', import.meta.url), 'utf8'));
  const pinned = Object.keys(JSON.parse(readFileSync(new URL('./fixtures/shipped-updater/candidate-pins.json', import.meta.url), 'utf8')));
  // Every recorded installer shipped this checkout's runtime pins with the pinned verifier wiring.
  const tagFile = (file, bunVersion) => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      .replace('verifyNativeArtifacts: verifyUpdateCandidateArtifacts,', 'verifyNativeArtifacts: verifyNativeRuntimeArtifacts,');
    return bunVersion ? text.replace(/NATIVE_BUNDLE_BUN_VERSION = '[^']+'/, `NATIVE_BUNDLE_BUN_VERSION = '${bunVersion}'`) : text;
  };
  const run = (failing, bunVersion) => async (command, args) => {
    if (command === failing) throw new Error(`${command} failed`);
    if (command === 'bun') assert.deepEqual(args, ['install', '--frozen-lockfile', '--dry-run', '--ignore-scripts']);
    if (command === 'git' && args[0] === 'rev-parse' && args[1].includes(':')) {
      const [tag, file] = args[1].split(':');
      return { stdout: `${shipped[tag][file]}\n` };
    }
    if (command === 'git' && args[0] === 'tag') return { stdout: `v2.1.9\n${pinned.join('\n')}\nv2.1.18\n` };
    if (command === 'git' && args[0] === 'show') return { stdout: tagFile(args[1].split(':')[1], bunVersion) };
    return { stdout: 'a'.repeat(40) };
  };
  const lines = [];
  const output = await preflight({ environment: {}, run: run(null), log: line => lines.push(line), localOnly: true });
  assert.equal(output.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(lines.map(line => line.split(':')[0]), ['[preflight] pass version files and bun.lock', '[preflight] pass CHANGELOG section', '[preflight] pass frozen lockfile', '[preflight] pass shipped discovery fixtures', '[preflight] pass shipped installer candidate pins']);
  assert.match(lines[1], /within the 65536-byte updater budget/);
  await assert.rejects(preflight({ environment: {}, run: run('bun'), log: () => {}, localOnly: true }), /Release preflight failed: frozen lockfile/);
  // In-app updates from older installs are not a release gate: drifted pins are reported, never refused
  // (release-state.test.mjs covers the drift report). The 2.0.0 floor has no earlier pinned installer.
  const reported = [];
  await preflight({ environment: {}, run: run(null, '1.4.3'), log: line => reported.push(line), localOnly: true });
  assert.match(reported.find(line => line.includes('shipped installer candidate pins')), pinned.length
    ? /^\[preflight\] pass shipped installer candidate pins: informational: in-app updates from older installs would be refused: .*the tags pin/
    : /^\[preflight\] pass shipped installer candidate pins: no supported pinned installer accept/);
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

test('pipeline code is the release workflow, release scripts and asset allowlist, not their tests or other files', () => {
  for (const file of ['.github/workflows/release.yml', 'scripts/release.mjs', 'scripts/release-github.mjs', 'scripts/release-tag.mjs', 'scripts/qa/release-upgrade-lane.mjs',
    'packages/electron/release-assets.mjs', 'scripts/verify-release-assets.mjs']) assert.equal(isPipelinePath(file), true, file);
  for (const file of ['.github/workflows/ci.yml', 'scripts/release.test.mjs', 'scripts/qa/release-upgrade-lane.test.mjs', 'scripts/qa/run-root.mjs', 'scripts/releases/x.mjs',
    'scripts/qa/releaser.mjs', 'packages/electron/main.mjs']) assert.equal(isPipelinePath(file), false, file);
  assert.deepEqual(changedPipelinePaths({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' }), ['b', 'c', 'd']);
});

const source = 'a'.repeat(40);
const blobs = { previous: { '.github/workflows/release.yml': '1', 'scripts/release.mjs': '2' }, head: { '.github/workflows/release.yml': '1', 'scripts/release.mjs': '3', 'scripts/release-github.mjs': '4' } };
const lsTree = files => Object.entries(files).map(([file, blob]) => `100644 blob ${blob.padStart(40, '0')}\t${file}`).join('\n') + '\n';
const fakeGit = (head = blobs.head) => async (command, args) => {
  assert.equal(command, 'git');
  assert.equal(args[0], 'ls-tree');
  if (args[1] === 'v9.8.5^{commit}') throw new Error('fatal: Not a valid object name v9.8.5^{commit}');
  return { stdout: lsTree(args[1] === 'v9.8.6^{commit}' ? blobs.previous : head) + '100644 blob ' + 'f'.repeat(40) + '\tscripts/release.test.mjs\n' };
};
const dispatch = (id, fields = {}) => ({ id, path: '.github/workflows/release.yml', head_sha: source, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
  repository: { full_name: '1H-Team/DevRyan' }, ...fields });
const retained = id => ['DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-candidate-identity'].map(name => ({ name, expired: false, workflow_run: { id, head_sha: source } }));
function fakeClient({ releases = ['v9.8.6', 'v9.8.5'], runs = [], jobs = {} } = {}) {
  return { repository: '1H-Team/DevRyan',
    paginate: async (url, { key } = {}) => {
      if (url === '/releases') return [...releases.map(tag => ({ tag_name: tag, draft: false, prerelease: false })), { tag_name: 'v9.8.7', draft: false, prerelease: false }, { tag_name: 'v9.9.0', draft: true, prerelease: false }];
      if (key === 'workflow_runs') return runs;
      const id = url.split('/')[3];
      return key === 'jobs' ? jobs[id] ?? [] : retained(Number(id));
    } };
}
const passed = DRY_RUN_GATES.map(name => ({ name, conclusion: 'success' }));

test('the pipeline-change gate passes with no pipeline change since the previous published release', async () => {
  assert.match(await pipelineChangeGate({ client: fakeClient(), version: '9.8.7', source, run: fakeGit(blobs.previous), log: () => {} }), /no release pipeline changes since v9\.8\.6/);
  assert.match(await pipelineChangeGate({ client: fakeClient({ releases: [] }), version: '9.8.7', source, run: fakeGit(), log: () => {} }), /no earlier published release/);
});

test('changed pipeline code needs a green dry run, simulate-release included, at exactly this commit', async () => {
  const lines = [];
  await assert.rejects(pipelineChangeGate({ client: fakeClient(), version: '9.8.7', source, run: fakeGit(), log: line => lines.push(line) }),
    /changed since v9\.8\.6 without a green dry run at a{40}.*gh workflow run release\.yml --ref main/);
  assert.match(lines.join('\n'), /scripts\/release-github\.mjs\n {2}scripts\/release\.mjs/);
  assert.match(await pipelineChangeGate({ client: fakeClient({ runs: [dispatch(11)], jobs: { 11: passed } }), version: '9.8.7', source, run: fakeGit(), log: () => {} }),
    /2 pipeline file\(s\) changed since v9\.8\.6; dry run 11 at this commit passed simulate-release/);
  const simulateFailed = passed.map(job => job.name === 'simulate-release' ? { ...job, conclusion: 'failure' } : job);
  for (const [label, client] of [['simulate-release failed', fakeClient({ runs: [dispatch(11)], jobs: { 11: simulateFailed } })],
    ['a dry run of another commit', fakeClient({ runs: [dispatch(12, { head_sha: 'b'.repeat(40) })], jobs: { 12: passed } })],
    ['a tag-push run', fakeClient({ runs: [dispatch(13, { event: 'push' })], jobs: { 13: passed } })]]) {
    await assert.rejects(pipelineChangeGate({ client, version: '9.8.7', source, run: fakeGit(), log: () => {} }), /without a green dry run/, label);
  }
  await assert.rejects(pipelineChangeGate({ client: fakeClient({ releases: ['v9.8.5'] }), version: '9.8.7', source, run: fakeGit(), log: () => {} }), /cannot read v9\.8\.5 .*git fetch --tags/);
});

test('deploy-backend runs only when a backend input changed since the previous ledger tag', async () => {
  assert.deepEqual(BACKEND_DEPLOY_INPUTS, ['supabase/migrations', 'supabase/config.toml', 'scripts/sync-supabase-auth-password-policy.mjs']);
  const calls = [];
  const git = ({ tags = 'devryan-release/v9.8.5\ndevryan-release/v9.8.6\ndevryan-release/v9.8.7\ndevryan-release/v10.0.0\n', diff = 0 } = {}) => async (command, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'tag') return { stdout: tags };
    if (diff === 0) return { stdout: '' };
    throw Object.assign(new Error(diff === 1 ? 'Command failed: git diff' : 'fatal: bad revision'), { code: diff });
  };
  assert.deepEqual(await backendDeployDecision({ version: '9.8.7', source, run: git() }),
    { deploy: false, detail: 'supabase/migrations, supabase/config.toml, scripts/sync-supabase-auth-password-policy.mjs unchanged since devryan-release/v9.8.6; deploy-backend is skipped' });
  assert.equal(calls.at(-1), `diff --quiet devryan-release/v9.8.6^{commit} ${source} -- ${BACKEND_DEPLOY_INPUTS.join(' ')}`, 'compares with the newest earlier ledger tag');
  assert.deepEqual(await backendDeployDecision({ version: '9.8.7', source, run: git({ diff: 1 }) }), { deploy: true, detail: 'backend inputs changed since devryan-release/v9.8.6; deploying' });
  assert.match((await backendDeployDecision({ version: '9.8.7', source, run: git({ diff: 128 }) })).detail, /could not compare with devryan-release\/v9\.8\.6 .*deploying/);
  assert.equal((await backendDeployDecision({ version: '9.8.7', source, run: git({ diff: 128 }) })).deploy, true);
  assert.deepEqual(await backendDeployDecision({ version: '9.8.7', source, run: git({ tags: 'devryan-release/v9.8.7\n' }) }), { deploy: true, detail: 'no earlier ledger tag to compare with; deploying' });
});
