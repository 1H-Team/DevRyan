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

test('a red CI attempt followed by a green re-run within the deadline qualifies', async () => {
  const responses = [[{ ...canonical, conclusion: 'failure', run_attempt: 1 }], [{ ...canonical, conclusion: 'failure', run_attempt: 1 }],
    [{ ...canonical, status: 'in_progress', conclusion: null, run_attempt: 2 }], [{ ...canonical, run_attempt: 2 }]];
  const lines = [];
  const result = await waitForTrustedCI({ environment, ...clock(), log: line => lines.push(line), request: async () => ({ workflow_runs: responses.shift() }) });
  assert.equal(result.run_attempt, 2);
  assert.match(lines[0], /attempt 1 concluded failure\. Re-run it \(gh run rerun 1 --failed\); this job keeps waiting/);
  assert.equal(lines.filter(line => line.includes('concluded failure')).length, 1, 'the hint is printed once per red attempt');
  assert.match(lines.at(-1), /attempt 2 passed/);
});

test('a newer canonical run for the same SHA can replace a red one', async () => {
  const responses = [[{ ...canonical, conclusion: 'cancelled' }], [{ ...canonical, conclusion: 'cancelled' }, { ...canonical, id: 2 }]];
  assert.equal((await waitForTrustedCI({ environment, ...clock(), log: () => {}, request: async () => ({ workflow_runs: responses.shift() }) })).id, 2);
});

for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) test(`CI ${conclusion} that is never re-run fails at the deadline with the re-run hint`, async () => {
  const time = clock();
  await assert.rejects(waitForTrustedCI({ environment, ...time, timeoutMs: 60_000, log: () => {}, request: async () => ({ workflow_runs: [{ ...canonical, conclusion }] }) }),
    new RegExp(`Canonical CI 1 attempt 1 ${conclusion} and was not re-run to success within 1 minutes\\. Re-run CI \\(gh run rerun 1 --failed\\)`));
  assert.equal(time.now(), 60_000);
});

test('newer main pushes, pull requests, other workflows and repositories cannot qualify a release', async () => {
  const impostors = [{ head_sha: 'b'.repeat(40), id: 99 }, { event: 'pull_request' }, { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/DevRyan' } }].map(change => ({ ...canonical, ...change }));
  await assert.rejects(waitForTrustedCI({ environment, ...clock(), timeoutMs: 25_000,
    request: async () => ({ workflow_runs: impostors }) }), /deadline/);
});

test('a later exact-source canonical failure cannot be hidden by an older passing run', async () => {
  await assert.rejects(waitForTrustedCI({ environment, ...clock(), timeoutMs: 30_000, log: () => {}, request: async () => ({ workflow_runs: [canonical,
    { ...canonical, id: 2, conclusion: 'failure' }] }) }), /Canonical CI 2 attempt 1 failure/);
});
