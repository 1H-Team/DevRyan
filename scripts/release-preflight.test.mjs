import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STAGING_RUN_TITLE, changedPipelinePaths, isPipelinePath, pipelineChangeGate, preflight } from './release-preflight.mjs';

test('pipeline code is the release workflow and release scripts, not their tests or other files', () => {
  for (const file of ['.github/workflows/release.yml', 'scripts/release.mjs', 'scripts/release-github.mjs', 'scripts/qa/release-upgrade-lane.mjs']) assert.equal(isPipelinePath(file), true, file);
  for (const file of ['.github/workflows/ci.yml', 'scripts/release.test.mjs', 'scripts/qa/release-upgrade-lane.test.mjs', 'scripts/qa/run-root.mjs', 'scripts/releases/x.mjs', 'scripts/qa/releaser.mjs']) {
    assert.equal(isPipelinePath(file), false, file);
  }
  assert.deepEqual(changedPipelinePaths({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' }), ['b', 'c', 'd']);
});

const blobs = { previous: { '.github/workflows/release.yml': '1', 'scripts/release.mjs': '2' }, head: { '.github/workflows/release.yml': '1', 'scripts/release.mjs': '3', 'scripts/release-github.mjs': '4' } };
const lsTree = files => Object.entries(files).map(([file, blob]) => `100644 blob ${blob.padStart(40, '0')}\t${file}`).join('\n') + '\n';
const fakeGit = (head = blobs.head) => async (command, args) => {
  assert.equal(command, 'git');
  assert.equal(args[0], 'ls-tree');
  return { stdout: lsTree(args[1] === 'v9.8.6^{commit}' ? blobs.previous : head) + '100644 blob ' + 'f'.repeat(40) + '\tscripts/release.test.mjs\n' };
};
function fakeClient({ runs = [], trees = {}, jobs = {} } = {}) {
  return { repository: '1H-Team/DevRyan',
    paginate: async url => url === '/releases' ? [{ tag_name: 'v9.8.6', draft: false, prerelease: false }, { tag_name: 'v9.8.7', draft: false, prerelease: false },
      { tag_name: 'v9.8.5', draft: false, prerelease: false }, { tag_name: 'v9.9.0', draft: true, prerelease: false }] : runs,
    request: async (_method, url) => {
      const contents = /^\/contents\/(.+)\?ref=(\w+)$/.exec(url);
      if (contents) return Object.entries(trees[contents[2]] ?? {}).filter(([file]) => file.startsWith(`${contents[1]}/`) && !file.slice(contents[1].length + 1).includes('/'))
        .map(([file, sha]) => ({ type: 'file', path: file, sha: sha.padStart(40, '0') }));
      return { jobs: jobs[/\/actions\/runs\/(\d+)\/jobs/.exec(url)[1]] ?? [] };
    } };
}
const stagingRun = (id, sha) => ({ id, head_sha: sha, path: '.github/workflows/release.yml', display_title: STAGING_RUN_TITLE, conclusion: 'success', repository: { full_name: '1H-Team/DevRyan' } });
const passingJobs = [{ name: 'stage', conclusion: 'success' }, { name: 'publish', conclusion: 'success' }];

test('the gate passes with no pipeline change since the previous published release', async () => {
  assert.match(await pipelineChangeGate({ client: fakeClient(), version: '9.8.7', run: fakeGit(blobs.previous), log: () => {} }), /no release pipeline changes since v9\.8\.6/);
});

test('changed pipeline code needs a passing staging dry run of exactly that code', async () => {
  const lines = [];
  await assert.rejects(pipelineChangeGate({ client: fakeClient(), version: '9.8.7', run: fakeGit(), log: line => lines.push(line) }),
    /changed since v9\.8\.6 without a passing staging dry run.*gh workflow run release\.yml --ref <branch> -f mode=stage/);
  assert.match(lines.join('\n'), /scripts\/release-github\.mjs\n {2}scripts\/release\.mjs/);
  const runs = [stagingRun(10, 'old'), stagingRun(11, 'same'), { ...stagingRun(12, 'same'), display_title: 'Release build dry run' }];
  const trees = { old: blobs.previous, same: blobs.head };
  assert.match(await pipelineChangeGate({ client: fakeClient({ runs, trees, jobs: { 11: passingJobs } }), version: '9.8.7', run: fakeGit(), log: () => {} }),
    /staging dry run 11 at same ran exactly this code/);
  await assert.rejects(pipelineChangeGate({ client: fakeClient({ runs, trees, jobs: { 11: [passingJobs[0]] } }), version: '9.8.7', run: fakeGit(), log: () => {} }), /without a passing staging dry run/,
    'a staging run whose publish job did not pass does not count');
  await assert.rejects(pipelineChangeGate({ client: fakeClient({ runs: [stagingRun(13, 'near')], trees: { near: { ...blobs.head, 'scripts/release.mjs': '5' } }, jobs: { 13: passingJobs } }),
    version: '9.8.7', run: fakeGit(), log: () => {} }), /without a passing staging dry run/, 'any other pipeline code does not count');
});

test('local preflight reports every check and fails on any of them', async () => {
  const shipped = JSON.parse(readFileSync(new URL('./fixtures/shipped-updater/shipped.json', import.meta.url), 'utf8'));
  const run = (failing) => async (command, args) => {
    if (command === failing) throw new Error(`${command} failed`);
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
  await assert.rejects(preflight({ environment: {}, run: run('bun'), log: () => {}, localOnly: true }), /Release preflight failed: frozen lockfile/);
});
