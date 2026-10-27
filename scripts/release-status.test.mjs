import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubClient } from './release-github.mjs';
import { createFakeGitHub } from './release-github-fake.mjs';
import { formatReleaseMarker } from './release-state.mjs';
import { collectReleaseFacts, formatStatus, main, nextAction } from './release-status.mjs';

const version = '9.8.7', tag = `v${version}`, sha = 'a'.repeat(40);
const digest = 'c'.repeat(64);
const asset = { id: 2, name: `DevRyan-${version}-arm64.dmg`, size: 15, state: 'uploaded', digest: `sha256:${digest}`, created_at: 't', updated_at: 't', blob: { inline: '' } };
const marker = formatReleaseMarker({ version, sha256: digest, size: 15, source: sha, runId: '80', runAttempt: '1' });
const ciRun = conclusion => ({ id: 70, path: '.github/workflows/ci.yml', head_sha: sha, head_branch: 'main', event: 'push', status: conclusion ? 'completed' : 'in_progress', conclusion });
const releaseRun = (status, conclusion, jobs = []) => ({ id: 80, head_sha: sha, head_branch: tag, event: 'push', status, conclusion, run_attempt: 1,
  jobs: jobs.map(([name, jobStatus, jobConclusion], index) => ({ id: 900 + index, name, status: jobStatus, conclusion: jobConclusion })),
  artifacts: [{ name: 'DevRyan-macos-arm64-release', expired: false, expires_at: '2027-01-21T00:00:00Z' }, { name: 'web-release', expired: true }] });

function world({ tagged = true, published = false, draft = false, ledger = false, latest, ci, run } = {}) {
  const fake = createFakeGitHub({ tags: tagged ? { [tag]: sha } : {}, ciRuns: ci ? [ci] : [], releaseRuns: run ? [run] : [] });
  const release = (id, isDraft) => ({ id, tag_name: tag, target_commitish: sha, name: tag, body: `notes\n\n<!-- ${marker} -->\n`, draft: isDraft, prerelease: false,
    created_at: 't', updated_at: 't', published_at: isDraft ? null : '2026-10-23T06:00:00Z', assets: [{ ...asset, id: id + 1 }] });
  if (published) { fake.state.releases.push(release(10, false)); fake.state.latestId = 10; }
  if (draft) fake.state.releases.push(release(20, true));
  if (latest) { fake.state.releases.push({ ...release(30, false), tag_name: `v${latest}`, assets: [] }); fake.state.latestId = 30; }
  if (ledger) {
    fake.state.tagObjects['b'.repeat(40)] = { sha: 'b'.repeat(40), tag: `devryan-release/${tag}`, message: `${marker}\n`, object: { type: 'commit', sha } };
    fake.state.refs[`tags/devryan-release/${tag}`] = { type: 'tag', sha: 'b'.repeat(40) };
  }
  return fake;
}

const status = async (fake, { authenticated = true, v = version } = {}) => {
  const client = githubClient({ token: authenticated ? 'read-token' : '', anonymous: !authenticated, fetchImpl: fake.fetchImpl, environment: { RELEASE_DRY_RUN: 'true' } });
  const facts = await collectReleaseFacts({ version: v, client, authenticated });
  return { facts, next: nextAction(facts) };
};

test('each release situation has exactly one next action', async () => {
  const cases = [
    [world({ tagged: false }), 'push-tag', /^bun run release:tag$/],
    [world({ ci: ciRun(null) }), 'investigate', /gh run list --workflow release\.yml --branch v9\.8\.7/],
    [world({ ci: ciRun(null), run: releaseRun('in_progress', null, [['trusted-ci', 'in_progress', null]]) }), 'wait', /gh run watch 80/],
    [world({ ci: ciRun('failure'), run: releaseRun('in_progress', null, [['trusted-ci', 'in_progress', null]]) }), 'rerun-ci', /gh run rerun 70 --failed/],
    [world({ ci: ciRun('success'), draft: true, run: releaseRun('completed', 'failure', [['upgrade-check', 'completed', 'failure'], ['release', 'completed', 'skipped']]) }), 'rerun-failed-jobs', /gh run rerun 80 --failed/],
    [world({ ci: ciRun('failure'), run: releaseRun('completed', 'failure', [['trusted-ci', 'completed', 'failure']]) }), 'rerun-ci', /gh run rerun 70 --failed/],
    [world({ published: true, ledger: true, ci: ciRun('success'), run: releaseRun('completed', 'failure', [['release', 'completed', 'success'], ['post-publish-verify', 'completed', 'failure']]) }),
      'rerun-post-publish-verify', /gh run rerun 80 --job 901/],
    [world({ published: true, ledger: true, ci: ciRun('success'), run: releaseRun('completed', 'success', [['release', 'completed', 'success'], ['post-publish-verify', 'completed', 'success']]) }), 'done', /release-verify-public\.mjs v9\.8\.7/],
    [world({ published: true, ledger: false, ci: ciRun('success'), run: releaseRun('completed', 'failure', [['release', 'completed', 'failure']]) }), 'rerun-release', /gh run rerun 80 --job 900/],
    [world({ ledger: true }), 'bump-version', /bump-version\.mjs 9\.8\.8/],
    [world({ latest: '10.0.0' }), 'bump-version', /bump-version\.mjs 9\.8\.8/],
  ];
  for (const [fake, action, command] of cases) {
    const { next } = await status(fake);
    assert.equal(next.action, action, JSON.stringify(next));
    assert.match(next.command, command);
    assert.ok(fake.requests.every(request => request.method === 'GET'), 'read-only');
  }
  // A version predating the ledger still needs an observed verifier result.
  const old = createFakeGitHub({ tags: { 'v2.1.9': sha } });
  old.state.releases.push({ id: 5, tag_name: 'v2.1.9', target_commitish: sha, name: 'v2.1.9', body: '', draft: false, prerelease: false, created_at: 't', updated_at: 't', published_at: 't',
    assets: [{ ...asset, name: 'DevRyan-2.1.9-arm64.dmg' }] });
  assert.equal((await status(old, { v: '2.1.9' })).next.action, 'rerun-post-publish-verify');
});

test('the report shows state, ledger, release, draft, asset, CI, jobs and retained artifacts', async () => {
  const { facts, next } = await status(world({ published: true, ledger: true, ci: ciRun('success'), run: releaseRun('completed', 'failure', [['release', 'completed', 'success'], ['post-publish-verify', 'completed', 'failure']]) }));
  const text = formatStatus(facts, next);
  for (const line of [/tag {10}v9\.8\.7 -> a{40}/, /state {8}verify-published/, /ledger {7}devryan-release\/v9\.8\.7 sha256:c{64} 15 bytes, run 80\/1/,
    /release {6}10 published 2026-10-23T06:00:00Z, 1 asset\(s\); DevRyan-9\.8\.7-arm64\.dmg uploaded sha256:c{64} 15 bytes/, /main CI {6}run 70 completed\/success/,
    /post-publish-verify +completed\/failure/, /artifacts {4}DevRyan-macos-arm64-release \(until 2027-01-21\)$/m, /Next action: rerun-post-publish-verify/, /or {3}\$ node scripts\/release-verify-public\.mjs v9\.8\.7/]) {
    assert.match(text, line);
  }
  // Anonymous reads cannot see drafts, and say so.
  const anonymous = await status(world({ draft: true, ci: ciRun(null) }), { authenticated: false });
  assert.equal(anonymous.facts.releases.length, 0);
  assert.match(formatStatus(anonymous.facts, anonymous.next), /anonymous: drafts are not visible/);
});

test('published releases with failed installed public upgrades remain verification pending without republishing', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null, 'success']) {
    const { next } = await status(world({ published: true, ledger: true, run: releaseRun(conclusion ? 'completed' : 'in_progress', conclusion,
      [['post-publish-verify', 'completed', 'success'], ['installed-public-upgrade-check', conclusion ? 'completed' : 'in_progress', conclusion]]) }));
    assert.equal(next.action, conclusion === 'success' ? 'done' : conclusion === null ? 'wait' : conclusion === 'skipped' ? 'investigate' : 'rerun-installed-upgrades');
    if (['failure', 'cancelled', 'timed_out'].includes(conclusion)) assert.equal(next.command, 'gh run rerun 80 --job 901');
  }
});

test('the CLI takes exactly vX.Y.Z and never writes', async () => {
  await assert.rejects(main({ argv: ['9.8.7'] }), /Usage/);
  const fake = world({ tagged: false });
  const lines = [];
  const { next } = await main({ argv: [tag], environment: {}, fetchImpl: fake.fetchImpl, run: async () => ({ stdout: '' }), log: line => lines.push(line) });
  assert.equal(next.action, 'push-tag');
  assert.match(lines[0], /anonymous/);
  assert.ok(fake.requests.every(request => request.method === 'GET'));
});

test('published verification must pass: missing, skipped, failed and cancelled checks remain pending', async () => {
  for (const name of ['post-publish-verify', 'verify-published']) {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null, 'success']) {
      const { next } = await status(world({ published: true, ledger: true,
        run: releaseRun('completed', conclusion === 'success' ? 'success' : 'failure', [[name, 'completed', conclusion]]) }));
      assert.equal(next.action, conclusion === 'success' ? 'done' : 'rerun-post-publish-verify', `${name}/${conclusion}`);
    }
    const { next } = await status(world({ published: true, ledger: true, run: releaseRun('in_progress', null, [[name, 'queued', null]]) }));
    assert.equal(next.action, 'wait');
  }
  const { next } = await status(world({ published: true, ledger: true, run: releaseRun('completed', 'success') }));
  assert.equal(next.action, 'rerun-post-publish-verify');
  assert.equal(next.command, `node scripts/release-verify-public.mjs ${tag}`);
});

test('missing ledger recovery names the original writer even after a whole-workflow rerun skipped it', async () => {
  const original = releaseRun('completed', 'failure', [['release', 'completed', 'failure'], ['release', 'completed', 'skipped']]);
  const fake = world({ published: true, run: original });
  fake.state.releaseRuns.push({ ...releaseRun('completed', 'failure', [['release', 'completed', 'skipped'], ['verify-published', 'completed', 'failure']]), id: 81 });
  const { facts, next } = await status(fake);
  assert.equal(facts.run.id, 81);
  assert.equal(next.action, 'rerun-release');
  assert.equal(next.command, 'gh run rerun 80 --job 900');
  assert.ok(fake.requests.some(row => row.url.includes('/actions/runs/80/jobs?filter=all')));
  assert.ok(fake.requests.every(row => row.method === 'GET'));
  original.status = 'in_progress';
  assert.equal((await status(fake)).next.command, 'gh run watch 80', 'do not rerun an active original writer');
  original.status = 'completed';
  original.jobs = original.jobs.filter(row => row.conclusion === 'skipped');
  assert.equal((await status(fake)).next.action, 'investigate', 'a skipped writer is not a repair target');
  fake.state.releaseRuns = fake.state.releaseRuns.filter(row => row.id !== 80);
  const unknown = await status(fake);
  assert.equal(unknown.next.action, 'investigate');
  assert.doesNotMatch(unknown.next.command, /rerun/);
});
