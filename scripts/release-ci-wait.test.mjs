import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForTrustedCI } from './release-ci-wait.mjs';

const environment = { GITHUB_REPOSITORY: '1H-Team/DevRyan', GITHUB_SHA: 'a'.repeat(40) };
const canonical = { id: 1, path: '.github/workflows/ci.yml', head_sha: environment.GITHUB_SHA,
  head_branch: 'main', event: 'push', repository: { full_name: environment.GITHUB_REPOSITORY }, status: 'completed', conclusion: 'success' };
const clock = () => { let time = 0; return { now: () => time, wait: async ms => { time += ms; } }; };

test('CI waits through missing registration and pending, accepting only the exact main push', async () => {
  const responses = [[], [{ ...canonical, status: 'in_progress', conclusion: null }], [canonical]];
  const waits = [], time = clock();
  const result = await waitForTrustedCI({ environment, ...time, log: () => {},
    wait: async ms => { waits.push(ms); await time.wait(ms); }, request: async () => ({ workflow_runs: responses.shift() }) });
  assert.equal(result.id, 1);
  assert.deepEqual(waits, [10_000, 10_000]);
});

for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) test(`CI fails immediately on ${conclusion}`, async () => {
  await assert.rejects(waitForTrustedCI({ environment, ...clock(), request: async () => ({ workflow_runs: [{ ...canonical, conclusion }] }) }), new RegExp(conclusion));
});

test('newer main pushes, pull requests, other workflows and repositories cannot qualify a release', async () => {
  const impostors = [{ head_sha: 'b'.repeat(40), id: 99 }, { event: 'pull_request' }, { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/DevRyan' } }].map(change => ({ ...canonical, ...change }));
  await assert.rejects(waitForTrustedCI({ environment, ...clock(), timeoutMs: 25_000,
    request: async () => ({ workflow_runs: impostors }) }), /deadline/);
});

test('a later exact-source canonical failure cannot be hidden by an older passing rerun', async () => {
  await assert.rejects(waitForTrustedCI({ environment, ...clock(), request: async () => ({ workflow_runs: [canonical,
    { ...canonical, id: 2, conclusion: 'failure' }] }) }), /failure/);
});
