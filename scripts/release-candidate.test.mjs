import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidateIdentity, describeCandidate, verifyCandidate, waitForCandidate, CANDIDATE_ARTIFACT, CANDIDATE_IDENTITY_ARTIFACT } from './release-candidate.mjs';

const environment = { GITHUB_REPOSITORY: '1H-Team/DevRyan', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', VERSION: '2.1.7' };
const identity = candidateIdentity(environment);
const run = { head_sha: identity.revision, path: '.github/workflows/release.yml', repository: { full_name: environment.GITHUB_REPOSITORY }, run_attempt: 1, status: 'in_progress' };
const artifact = { id: 456, name: CANDIDATE_ARTIFACT, expired: false, workflow_run: { id: 123, head_sha: identity.revision } };
function fixture({ producer = { name: 'electron-package', id: 10, run_attempt: 1, status: 'completed', conclusion: 'success' }, candidate = artifact, source = run } = {}) {
  let time = 0;
  return { environment, now: () => time, wait: async ms => { time += ms; }, timeoutMs: 10_000,
    request: async (_method, url) => url.includes('/jobs?') ? { jobs: [producer] } : url.includes('/artifacts?') ? { artifacts: candidate ? [candidate, { ...artifact, name: CANDIDATE_IDENTITY_ARTIFACT }] : [] } : source };
}

test('wait accepts only this run and source after the packaging job succeeds', async () => {
  assert.equal((await waitForCandidate(fixture())).artifact.id, 456);
  await assert.rejects(waitForCandidate(fixture({ producer: { name: 'electron-package', id: 10, run_attempt: 1, status: 'in_progress' } })), /deadline/);
});
for (const conclusion of ['failure', 'cancelled', 'skipped']) test(`candidate producer ${conclusion} aborts immediately`, async () => {
  await assert.rejects(waitForCandidate(fixture({ producer: { name: 'electron-package', id: 10, run_attempt: 1, status: 'completed', conclusion } })), new RegExp(conclusion));
});
test('candidate absence expires and changed producer/artifact identity fails closed', async () => {
  await assert.rejects(waitForCandidate(fixture({ candidate: null })), /deadline/);
  for (const change of [{ head_sha: 'b'.repeat(40) }, { run_attempt: 2 }, { repository: { full_name: 'other/repo' } }]) {
    await assert.rejects(waitForCandidate(fixture({ source: { ...run, ...change } })), /identity/);
  }
  await assert.rejects(waitForCandidate(fixture({ candidate: { ...artifact, workflow_run: { id: 124, head_sha: identity.revision } } })), /another/);
});
test('candidate handoff rejects wrong run, attempt, SHA and installer bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-candidate-'));
  try {
    const name = `DevRyan-${identity.version}-arm64.dmg`;
    await fs.writeFile(path.join(root, name), 'installer');
    await fs.writeFile(path.join(root, 'candidate.json'), JSON.stringify(await describeCandidate(root, identity)));
    assert.equal(await verifyCandidate(root, identity), path.join(root, name));
    for (const change of [{ runID: '124' }, { attempt: '2' }, { revision: 'b'.repeat(40) }]) await assert.rejects(verifyCandidate(root, { ...identity, ...change }), /mismatch/);
    await fs.writeFile(path.join(root, name), 'corrupted');
    await assert.rejects(verifyCandidate(root, identity), /mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('a failed-job rerun can reuse the successful producer from an earlier attempt of this exact run', async () => {
  const options = fixture({ source: { ...run, run_attempt: 2 } });
  options.environment = { ...environment, GITHUB_RUN_ATTEMPT: '2' };
  assert.equal((await waitForCandidate(options)).identity.attempt, '1');
});

test('copied successful jobs retain the actual producer attempt, including after a real rebuild', async () => {
  for (const rebuilt of [false, true]) {
    const options = fixture({ source: { ...run, run_attempt: 3 } });
    options.environment = { ...environment, GITHUB_RUN_ATTEMPT: '3' };
    const original = { name: 'electron-package', id: 10, run_attempt: 1, status: 'completed', conclusion: 'success',
      started_at: '2026-10-21T10:00:00Z', completed_at: '2026-10-21T10:05:00Z' };
    const actual = rebuilt ? { ...original, id: 20, run_attempt: 2,
      started_at: '2026-10-21T10:10:00Z', completed_at: '2026-10-21T10:15:00Z' } : original;
    const request = options.request;
    options.request = (method, url) => url.includes('/jobs?')
      ? { jobs: [...(rebuilt ? [original] : []), actual, { ...actual, id: 30, run_attempt: 3 }] }
      : request(method, url);
    assert.equal((await waitForCandidate(options)).identity.attempt, String(actual.run_attempt));
  }
});
