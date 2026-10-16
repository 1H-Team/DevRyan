import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { hash, assertReleaseWritesAllowed } from './release-artifacts.mjs';
import { admitRelease, assertAdmittedRelease, finalizeRelease, githubReleaseClient, assertPriorGateAttempts, assertRollingGateFailures, selectRollingReleaseGateRuns, assertReleaseSourceHistory, assertRetainedCandidateArtifacts, readReleaseGateHistory, readReleaseGateReceipts, verifyReleasePrepublish, isExplainedReleaseGuiFailure, isExecutedReleaseGateJob, countUnexplainedReleaseGateFailures, requireReleaseGateWriteAdmission, assertCurrentReleaseGateAttempt, hasRetainedRunAdmission, assertPublishedUpdaterDiscovery, waitPublishedUpdaterDiscovery, releaseGateExecutions, readArtifactReceipt, resolveQualifiedReleaseCandidate, verifyPublishedFinalization } from './release-publication.mjs';

const source = 'a'.repeat(40), version = '2.0.10', scope = 'desktop-macos-arm64';
const environment = { GITHUB_REPOSITORY: '1H-Team/DevRyan', GITHUB_TOKEN: 'synthetic-fixture-token', GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '1', RELEASE_DRY_RUN: 'false' };
const admitted = { protocol: 'devryan.release-admission/1', source, version, scope, run: 17 };
const release = () => ({ id: 9, tag_name: `v${version}`, target_commitish: source, draft: true, prerelease: false,
  html_url: `https://github.com/1H-Team/DevRyan/releases/tag/v${version}`,
  body: `Notes\n<!-- devryan-release-admission ${JSON.stringify(admitted)} -->` });
const name = `DevRyan-${version}-arm64.dmg`;
async function fixture(t) {
  const parent = new URL('../.cache/test-fixtures/', import.meta.url);
  await fs.mkdir(parent, { recursive: true }); const directory = await fs.mkdtemp(path.join(parent.pathname, 'release-publication-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic exact installer'); await fs.writeFile(path.join(directory, name), bytes);
  return { directory, bytes, digest: hash(bytes) };
}
function clientFixture(current = release()) {
  const writes = [], assets = []; let frozen = source;
  let retained;
  const client = {
    readFinalizationProof: async () => retained,
    headers: {}, frozenTag: async (v, s) => { assert.equal(v, version); assert.equal(s, frozen, 'Release tag moved'); return true; },
    request: async (route, options = {}) => {
      if (options.method) {
        writes.push({ route, ...options });
        if (options.method === 'POST') { current = { ...options.body, id: 9 }; return current; }
        Object.assign(current, options.body);
        retained = { protocol: 'devryan.release-finalization/1', status: 'published', identity: { source, version, scope, releaseID: current.id },
          finalized: JSON.parse(current.body.match(/devryan-release-admission (\{.*\}) -->/)[1]).finalized };
        return structuredClone(current);
      }
      if (route.includes('/attempts/') && !route.endsWith('/jobs')) return { head_sha: source, path: '.github/workflows/release.yml', head_repository: { full_name: environment.GITHUB_REPOSITORY }, conclusion: 'success' };
      if (route === '/releases/latest') return { ...structuredClone(current), assets: structuredClone(assets) };
      return current ? structuredClone(current) : null;
    },
    pages: async route => route.endsWith('/jobs') ? [{ name: 'finalize-release', conclusion: 'success', steps: [
      { name: 'Deploy and verify Supabase configuration and migrations', conclusion: 'success' }, { name: 'Publish release', conclusion: 'success' }] }] : structuredClone(assets),
    fetchImpl: async (url, options) => { writes.push({ url }); assets.push({ id: 10, name, state: 'uploaded', size: options.body.length, digest: `sha256:${hash(options.body)}`,
      browser_download_url: `https://github.com/1H-Team/DevRyan/releases/download/v${version}/${name}` }); return { ok: true }; },
  };
  return { client, writes, assets, getRelease: () => current, getProof: () => retained, moveTag: () => { frozen = 'b'.repeat(40); } };
}
test('source admission retains the first source and release ID and refuses reused, moved or published writer targets', async () => {
  const f = clientFixture(null);
  const identity = await admitRelease({ source, version, scope, environment, updaterDiscovery: { attempts: 1 }, client: f.client });
  assert.equal(identity.releaseID, 9); assert.equal(f.writes.length, 1);
  await admitRelease({ source, version, scope, environment, updaterDiscovery: { attempts: 1 }, client: f.client }); assert.equal(f.writes.length, 1);
  assertAdmittedRelease(f.getRelease(), identity);
  assert.throws(() => assertAdmittedRelease(f.getRelease(), { ...identity, source: 'b'.repeat(40) }), /cannot be reused/);
  assert.throws(() => assertAdmittedRelease(f.getRelease(), { ...identity, releaseID: 11 }), /ID changed/);
  assert.throws(() => assertAdmittedRelease({ ...f.getRelease(), draft: false }, identity), /Published release writes/);
  f.moveTag(); await assert.rejects(admitRelease({ source, version, scope, environment, updaterDiscovery: { attempts: 1 }, client: f.client }), /tag moved/);
});
test('candidate admission and every core writer reject external writes', async () => {
  const f = clientFixture(null), candidateEnv = { ...environment, RELEASE_CANDIDATE: 'true', RELEASE_DRY_RUN: 'true' };
  await admitRelease({ source, version, scope, candidate: true, environment: candidateEnv, client: f.client });
  assert.equal(f.writes.length, 0);
  for (const key of ['RELEASE_DRY_RUN', 'RELEASE_CANDIDATE']) assert.throws(() => assertReleaseWritesAllowed({ ...environment, [key]: 'true' }), { code: 'release_dry_run_write_forbidden' });
  const client = githubReleaseClient(candidateEnv, () => assert.fail('No fetch should occur for a refused writer'));
  await assert.rejects(client.request('/releases', { method: 'POST', body: {} }), { code: 'release_dry_run_write_forbidden' });
});
test('finalizer uploads only draft exact bytes and promotes once after deployment, with a proof-bound published no-op', async t => {
  const { directory, digest } = await fixture(t), f = clientFixture();
  const identity = { source, version, scope, releaseID: 9 };
  const result = await finalizeRelease({ identity, directory, deploymentVerified: true, environment, updaterDiscovery: { attempts: 1 }, client: f.client });
  assert.equal(result.status, 'published'); assert.equal(f.getRelease().draft, false);
  assert.equal(f.writes.filter(row => row.url).length, 1); assert.equal(f.writes.filter(row => row.method === 'PATCH').length, 1);
  assert.equal(f.assets[0].digest, `sha256:${digest}`);
  const count = f.writes.length;
  assert.equal((await finalizeRelease({ identity, directory, environment, updaterDiscovery: { attempts: 1 }, client: f.client })).status, 'published-noop');
  assert.equal(f.writes.length, count);
  f.getRelease().body = f.getRelease().body.replace('"deployment":"verified"', '"deployment":"unknown"');
  await assert.rejects(finalizeRelease({ identity, directory, environment, updaterDiscovery: { attempts: 1 }, client: f.client }));
});
test('identical upload retry is reused; changed, unknown or duplicate bytes never overwrite a draft', async t => {
  const { directory, bytes, digest } = await fixture(t), identity = { source, version, scope, releaseID: 9 };
  for (const bad of [false, 'changed', 'unknown', 'duplicate']) {
    const f = clientFixture(); f.assets.push({ id: 10, name, state: 'uploaded', size: bytes.length, digest: `sha256:${digest}`,
      browser_download_url: `https://github.com/1H-Team/DevRyan/releases/download/v${version}/${name}` });
    if (bad === 'changed') f.assets[0].digest = `sha256:${'b'.repeat(64)}`;
    if (bad === 'unknown') f.assets.push({ ...f.assets[0], name: 'extra.json' });
    if (bad === 'duplicate') f.assets.push(f.assets[0]);
    const operation = finalizeRelease({ identity, directory, deploymentVerified: true, environment, updaterDiscovery: { attempts: 1 }, client: f.client });
    if (bad) { await assert.rejects(operation); assert.equal(f.writes.length, 0); }
    else { await operation; assert.equal(f.writes.filter(row => row.url).length, 0); }
  }
});
test('missing deployment and a tag moved at promotion retain the draft', async t => {
  const { directory } = await fixture(t), identity = { source, version, scope, releaseID: 9 };
  const missing = clientFixture(); await assert.rejects(finalizeRelease({ identity, directory, environment, updaterDiscovery: { attempts: 1 }, client: missing.client }), /deployment/);
  assert.equal(missing.getRelease().draft, true);
  const moved = clientFixture(); await assert.rejects(finalizeRelease({ identity, directory, deploymentVerified: true, environment, updaterDiscovery: { attempts: 1 }, client: moved.client, beforePromote: moved.moveTag }), /tag moved/);
  assert.equal(moved.getRelease().draft, true);
});
test('all prior gate job names and current-run attempts are checked, and two rolling failures block admission', () => {
  for (const jobName of ['candidate-startup-1', 'candidate-startup-2', 'candidate-startup-3', 'final-dmg-smoke', 'qualify-release-startup']) {
    const jobs = [{ id: 11, run_attempt: 1, name: jobName, conclusion: 'failure' }];
    const receipt = { jobID: 11, runAttempt: 1, sourceCommit: source, dmgSha256: 'b'.repeat(64), outcome: 'failed', cleanupErrors: [], failureClass: 'pre_app_gui_unavailable', appStarted: false, fixtureAttempts: 0, safeCleanup: true };
    assertPriorGateAttempts(jobs, [receipt], { source, dmgSha256: receipt.dmgSha256 });
    for (const change of [{ appStarted: true }, { fixtureAttempts: 1 }, { safeCleanup: false }, { sourceCommit: 'c'.repeat(40) }, { failureClass: 'release_smoke_failed' }])
      assert.throws(() => assertPriorGateAttempts(jobs, [{ ...receipt, ...change }], { source, dmgSha256: receipt.dmgSha256 }));
  }
  assert.throws(() => assertRollingGateFailures([1, 2].map(number => ({ releaseVersion: `2.0.${number}`, unexplainedGateFailure: true }))));
  assertRollingGateFailures([{ releaseVersion: '2.0.1', unexplainedGateFailure: true }]);
});

test('repeated successful no-op runs cannot evict failures from the ten-version window', () => {
  const runs = [
    ...Array.from({ length: 15 }, (_, index) => ({ id: 30 - index, releaseVersion: '3.0.0', unexplainedGateFailure: false })),
    { id: 2, releaseVersion: '2.0.0', unexplainedGateFailure: true },
    { id: 1, releaseVersion: '1.0.0', unexplainedGateFailure: true },
  ];
  assert.equal(selectRollingReleaseGateRuns(runs).length, 17);
  assert.throws(() => assertRollingGateFailures(runs), /Two unexplained/);
});
test('every earlier failed attempt of the selected versions survives later successful runs', () => {
  const recent = Array.from({ length: 10 }, (_, index) => ({ id: 50 - index, releaseVersion: `2.0.${10 - index}`, unexplainedGateFailure: false }));
  const oldAttempts = [{ id: 20, releaseVersion: '2.0.10', unexplainedGateFailure: true },
    { id: 19, releaseVersion: '2.0.1', unexplainedGateFailure: true },
    { id: 18, releaseVersion: '2.0.0', unexplainedGateFailure: true }];
  const selected = selectRollingReleaseGateRuns([...recent, ...oldAttempts]);
  assert.deepEqual(selected.slice(10).map(run => run.id), [20, 19]);
  assert.throws(() => assertRollingGateFailures([...recent, ...oldAttempts]), /Two unexplained/);
  assertRollingGateFailures([...recent, oldAttempts[0], oldAttempts[2]]);
  assert.throws(() => selectRollingReleaseGateRuns(null), /Complete release workflow history/);
});
test('the current unadmitted run cannot displace the tenth prior release', () => {
  const current = { id: Number(environment.GITHUB_RUN_ID), releaseVersion: '3.0.0' };
  const prior = Array.from({ length: 10 }, (_, index) => ({ id: 50 - index, releaseVersion: `2.0.${10 - index}`, unexplainedGateFailure: index === 0 || index === 9 }));
  const selected = selectRollingReleaseGateRuns([current, ...prior].filter(run => run.id !== current.id));
  assert.equal(new Set(selected.map(run => run.releaseVersion)).size, 10);
  assert.throws(() => assertRollingGateFailures(selected), /Two unexplained/);
});
test('an admitted tag cannot be reused after draft deletion', () => {
  const run = { id: 18, releaseVersion: version, head_sha: source };
  const jobs = new Map([[18, [{ name: 'create-release', steps: [{ name: 'Admit immutable release source before heavy work', conclusion: 'success' }] }]]]);
  assertReleaseSourceHistory([run], jobs, { source, version });
  assert.throws(() => assertReleaseSourceHistory([run], jobs, { source: 'b'.repeat(40), version }), /retagged/);
});

test('source admission finds an existing draft when the tag endpoint omits it', async () => {
  const f = clientFixture(), originalRequest = f.client.request;
  f.client.request = (route, options) => route.includes('/releases/tags/') ? null : originalRequest(route, options);
  f.client.pages = async () => [f.getRelease()];
  assert.equal((await admitRelease({ source, version, scope, environment, updaterDiscovery: { attempts: 1 }, client: f.client })).releaseID, 9);
  assert.equal(f.writes.length, 0);
});

test('the signed Bot inputs-only lane cannot invoke the stable GitHub writer', async () => {
  const ref = `refs/tags/v${version}-bot-inputs-${source.slice(0, 12)}`;
  const env = { ...environment, RELEASE_BOT_INPUTS_ONLY: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: source, GITHUB_REF: ref, GITHUB_WORKFLOW_REF: `1H-Team/DevRyan/.github/workflows/release.yml@${ref}` };
  const client = githubReleaseClient(env, () => assert.fail('No GitHub mutation may occur'));
  await assert.rejects(client.request('/releases', { method: 'POST', body: {} }), /prohibits application/);
});

test('finalization rejects missing admitted ID or attempt proof before any upload', async t => {
  const { directory } = await fixture(t), identity = { source, version, scope, releaseID: 9 };
  for (const change of [{ identity: { ...identity, releaseID: 0 } }, { environment: { ...environment, GITHUB_RUN_ATTEMPT: undefined } }]) {
    const f = clientFixture();
    await assert.rejects(finalizeRelease({ identity, directory, deploymentVerified: true, environment, updaterDiscovery: { attempts: 1 }, client: f.client, ...change }));
    assert.equal(f.writes.length, 0);
  }
});

test('a mutable published marker cannot replace the retained original release ID, deployment or digest receipt', async t => {
  const { directory } = await fixture(t), identity = { source, version, scope, releaseID: 9 }, f = clientFixture();
  await finalizeRelease({ identity, directory, deploymentVerified: true, environment, updaterDiscovery: { attempts: 1 }, client: f.client });
  f.getProof().identity.releaseID = 11;
  await assert.rejects(finalizeRelease({ identity, directory, environment, updaterDiscovery: { attempts: 1 }, client: f.client }));
});

test('candidate admission requires retained exact artifacts and never rebuilds expired bytes', () => {
  const samples = [1, 2, 3].map(() => ({ run_attempt: 1 }));
  const artifacts = ['DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-packaging', 'DevRyan-upgrade-rollback',
    ...[1, 2, 3].map(sample => `DevRyan-startup-attempt-1-candidate-${sample}`)].map(name => ({ name, expired: false }));
  assertRetainedCandidateArtifacts(artifacts, samples);
  for (const rows of [artifacts.slice(1), [{ ...artifacts[0], expired: true }, ...artifacts.slice(1)], [...artifacts, artifacts[0]]])
    assert.throws(() => assertRetainedCandidateArtifacts(rows, samples), /rebuilding is forbidden/);
});

test('candidate history uses immutable frozen versions across changed sources and branches', async () => {
  const candidates = [
    { id: 20, head_branch: 'main', head_sha: 'b'.repeat(40), unexplainedGateFailure: true },
    { id: 19, head_branch: 'release-fix', head_sha: 'c'.repeat(40), unexplainedGateFailure: true },
    ...Array.from({ length: 10 }, (_, index) => ({ id: 18 - index, head_branch: 'main', head_sha: source })),
    { id: 1, head_branch: 'main', head_sha: 'b'.repeat(40), unexplainedGateFailure: true },
  ].map(run => ({ ...run, head_repository: { full_name: environment.GITHUB_REPOSITORY } }));
  const current = { ...candidates[0], id: 21 }, requests = [];
  const client = { pages: async route => {
    requests.push(route); if (route === '/releases') return []; const id = Number(route.match(/runs\/(\d+)/)[1]);
    return route.includes('/jobs') ? [{ name: 'candidate-startup-1', conclusion: 'failure' }]
      : [{ id, name: 'DevRyan-release-admission', expired: false }];
  }, readAdmissionProof: async (_artifact, run) => ({ source: run.head_sha, scope,
    version: [20, 1].includes(run.id) ? '2.0.20' : run.id === 19 ? '2.0.19' : `2.0.${run.id}` }) };
  const history = await readReleaseGateHistory(process.cwd(), client, [current, ...candidates], current.id);
  assert.equal(history.runs.length, candidates.length);
  assert.equal(requests.some(route => route.includes('/runs/21/')), false, 'Current unadmitted run excluded');
  const selected = selectRollingReleaseGateRuns(history.runs);
  assert.equal(new Set(selected.map(run => run.releaseVersion)).size, 10);
  assert.ok(selected.some(run => run.id === 1), 'Old failed attempt of a selected version retained');
  assert.ok(!selected.some(run => run.id === 9), 'Eleventh distinct version excluded');
  assert.throws(() => assertRollingGateFailures(history.runs), /Two unexplained/);
  const jobs = new Map([[20, [{ name: 'create-release', steps: [{ name: 'Admit immutable release source before heavy work', conclusion: 'success' }] }]]]);
  assert.throws(() => assertReleaseSourceHistory(history.runs, jobs, { source, version: '2.0.20' }), /retagged/);
});

test('required historical candidate identity cannot disappear, expire or change source', async () => {
  const run = { id: 30, head_branch: 'main', head_sha: source, head_repository: { full_name: environment.GITHUB_REPOSITORY } };
  for (const bad of ['missing', 'expired', 'source', 'duplicate', 'version', 'jobs']) {
    const client = { pages: async route => {
      if (route === '/releases') return [];
      if (route.includes('/jobs')) { if (bad === 'jobs') throw Error('History unavailable'); return [{ name: 'candidate-startup-2', conclusion: 'failure' }]; }
      const artifact = { id: 30, name: 'DevRyan-release-admission', expired: bad === 'expired' };
      return bad === 'missing' ? [] : bad === 'duplicate' ? [artifact, artifact] : [artifact];
    }, readAdmissionProof: async () => ({ source: bad === 'source' ? 'b'.repeat(40) : source, scope, version: bad === 'version' ? 'main' : version }) };
    await assert.rejects(readReleaseGateHistory(process.cwd(), client, [run], 31), undefined, bad);
  }
});

test('historical GUI exclusions require the exact admitted source, version and safely settled failed attempt', () => {
  const run = { id: 30, head_sha: source, releaseVersion: version }, job = { id: 42, run_attempt: 1 };
  const receipt = { runID: '30', jobID: 42, runAttempt: 1, sourceCommit: source, version, dmgSha256: 'b'.repeat(64),
    outcome: 'failed', failureClass: 'pre_app_gui_unavailable', appStarted: false, fixtureAttempts: 0, safeCleanup: true, cleanupErrors: [] };
  assert.equal(isExplainedReleaseGuiFailure(job, [receipt], run), true);
  for (const change of [{ sourceCommit: 'c'.repeat(40) }, { version: '2.0.11' }, { runID: '31' }, { jobID: 43 }, { runAttempt: 2 },
    { dmgSha256: 'unknown' }, { outcome: 'passed' }, { appStarted: true }, { fixtureAttempts: 1 }, { safeCleanup: false },
    { cleanupErrors: ['cleanup_failed'] }, { failureClass: 'release_smoke_product_or_evidence_failure' }])
    assert.equal(isExplainedReleaseGuiFailure(job, [{ ...receipt, ...change }], run), false);
});

test('two unexplained candidate gate attempts in one retained run block admission', () => {
  const run = { id: 30, head_sha: source, releaseVersion: version };
  const jobs = [1, 2].map(number => ({ id: 40 + number, run_attempt: 1, name: `candidate-startup-${number}`, conclusion: 'failure' }));
  const unexplainedGateFailures = countUnexplainedReleaseGateFailures(jobs, [], run);
  assert.equal(unexplainedGateFailures, 2);
  assert.throws(() => assertRollingGateFailures([{ ...run, unexplainedGateFailures }]), /Two unexplained/);
  const gui = { runID: '30', jobID: 41, runAttempt: 1, sourceCommit: source, version, dmgSha256: 'b'.repeat(64), outcome: 'failed',
    failureClass: 'pre_app_gui_unavailable', appStarted: false, fixtureAttempts: 0, safeCleanup: true, cleanupErrors: [] };
  assert.equal(countUnexplainedReleaseGateFailures(jobs, [gui], run), 1);
  assertRollingGateFailures([{ ...run, unexplainedGateFailures: 1 }]);
});

test('current-run earlier gate attempts fence admission before heavy work without entering the ten-release window', async () => {
  const identity = { source, version, lockfile: 'f'.repeat(64) };
  const jobs = [{ id: 42, name: 'candidate-startup-1', conclusion: 'failure', run_attempt: 1 }];
  const metadata = { protocol: 'devryan.release-candidate/1', sourceCommit: source, version, dmgSha256: 'b'.repeat(64), lockfile: identity.lockfile };
  const artifacts = ['DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-packaging'].map((name, index) => ({ id: 60 + index, name, expired: false }));
  const receipt = { runID: '50', jobID: 42, runAttempt: 1, sourceCommit: source, version, dmgSha256: metadata.dmgSha256,
    outcome: 'failed', failureClass: 'pre_app_gui_unavailable', appStarted: false, fixtureAttempts: 0, safeCleanup: true, cleanupErrors: [] };
  const client = { pages: async route => route.includes('/jobs') ? jobs : artifacts, readCandidateProof: async () => metadata, readGateReceipts: async () => [receipt] };
  const input = { root: process.cwd(), client, identity, currentRunID: 50, currentRunAttempt: 2 };
  await assert.rejects(assertCurrentReleaseGateAttempt(input), { code: 'release_retry_failed_gate_jobs_only' });
  for (const change of [{ failureClass: 'release_smoke_product_or_evidence_failure' }, { appStarted: true }, { fixtureAttempts: 1 },
    { safeCleanup: false }, { sourceCommit: 'c'.repeat(40) }, { version: '2.0.11' }, { dmgSha256: 'c'.repeat(64) },
    { runID: '51' }, { jobID: 43 }, { cleanupErrors: ['cleanup_failed'] }]) {
    let heavyWork = 0;
    await assert.rejects(assertCurrentReleaseGateAttempt({ ...input, client: { ...client, readGateReceipts: async () => [{ ...receipt, ...change }] } }).then(() => { heavyWork++; }));
    assert.equal(heavyWork, 0);
  }
  await assert.rejects(assertCurrentReleaseGateAttempt({ ...input, currentRunAttempt: 4 }), { code: 'release_retry_failed_gate_jobs_only' });
  await assert.rejects(assertCurrentReleaseGateAttempt({ ...input, client: { ...client, readGateReceipts: async () => [] } }), /earlier product/);
  await assert.rejects(assertCurrentReleaseGateAttempt({ ...input, client: { ...client, pages: async route => route.includes('/jobs') ? jobs : [] } }), /retained candidate identity/);
  await assert.rejects(assertCurrentReleaseGateAttempt({ ...input, client: { ...client, readCandidateProof: async () => ({ ...metadata, sourceCommit: 'c'.repeat(40) }) } }));
  const prior = Array.from({ length: 10 }, (_, index) => ({ id: 30 - index, releaseVersion: `2.0.${10 - index}` }));
  const selected = selectRollingReleaseGateRuns(prior);
  assert.equal(new Set(selected.map(run => run.releaseVersion)).size, 10);
  assert.ok(!selected.some(run => run.id === input.currentRunID));
  const successful = { ...client, pages: async route => route.includes('/jobs') ? jobs.map(job => ({ ...job, conclusion: 'success' })) : artifacts };
  await assert.rejects(assertCurrentReleaseGateAttempt({ ...input, client: successful }), { code: 'release_retry_failed_gate_jobs_only' });
  const admissionOnly = { ...client, pages: async route => route.includes('/jobs') ? [] : [{ id: 60, name: 'DevRyan-release-admission', expired: false }] };
  await assert.rejects(assertCurrentReleaseGateAttempt({ ...input, client: admissionOnly }), { code: 'release_retry_failed_gate_jobs_only' });
  await assertCurrentReleaseGateAttempt({ ...input, client: { pages: async () => [] } }); // A pre-admission failure retained no artifact.
});

test('published same-run retry verifies original finalization and reuses only exact immutable admission despite earlier GUI failures', async t => {
  const { directory } = await fixture(t), identity = { source, version, scope, releaseID: 9 }, f = clientFixture();
  await finalizeRelease({ identity, directory, deploymentVerified: true, environment, updaterDiscovery: { attempts: 1 }, client: f.client });
  const count = f.writes.length;
  const readOnly = await admitRelease({ source, version, scope, environment: { ...environment, RELEASE_DRY_RUN: 'true' }, client: f.client });
  assert.equal(readOnly.publishedNoop, true); assert.equal(f.writes.length, count);
  const originalPages = f.client.pages;
  const artifact = { id: 70, name: 'DevRyan-release-admission', expired: false };
  f.client.pages = async route => route.includes('/artifacts') ? [artifact] : route.includes('/jobs?filter=all')
    ? [{ id: 42, name: 'candidate-startup-1', run_attempt: 1, conclusion: 'failure' }] : originalPages(route);
  f.client.readAdmissionProof = async () => ({ source, version, scope, releaseID: 9 });
  assert.equal(await hasRetainedRunAdmission({ root: process.cwd(), client: f.client, admission: readOnly, runID: 17 }), true);
  for (const change of [{ source: 'b'.repeat(40) }, { version: '2.0.11' }, { scope: 'full' }, { releaseID: 10 }]) {
    f.client.readAdmissionProof = async () => ({ source, version, scope, releaseID: 9, ...change });
    await assert.rejects(hasRetainedRunAdmission({ root: process.cwd(), client: f.client, admission: readOnly, runID: 17 }), /Original run admission changed/);
  }
  f.client.pages = async route => route.includes('/artifacts') ? [] : originalPages(route);
  assert.equal(await hasRetainedRunAdmission({ root: process.cwd(), client: f.client, admission: readOnly, runID: 18 }), false, 'Fresh no-op run may retain its own admission artifact');
  f.client.pages = async route => route.includes('/artifacts') ? [artifact, artifact] : originalPages(route);
  await assert.rejects(hasRetainedRunAdmission({ root: process.cwd(), client: f.client, admission: readOnly, runID: 17 }), /One immutable/);
  f.getProof().finalized.deployment = 'unknown';
  await assert.rejects(admitRelease({ source, version, scope, environment: { ...environment, RELEASE_DRY_RUN: 'true' }, client: f.client }));
  assert.equal(f.writes.length, count, 'No GitHub mutations in the published retry path');
});

test('two failed gates allow a read-only corrected candidate but require newer exact measured qualification before writes', async () => {
  const failures = [1, 2].map(number => ({ id: number, releaseVersion: `2.0.${number}`, head_sha: String(number).repeat(40),
    unexplainedGateFailures: 1, unexplainedGateCompletedAt: Date.parse('2026-10-14T10:00:00Z') }));
  const identity = { source, version, lockfile: 'f'.repeat(64) }, options = { root: process.cwd(), identity, currentRunID: 51, runs: failures };
  let queries = 0;
  const empty = { pages: async () => { queries++; return []; } };
  assert.equal(await requireReleaseGateWriteAdmission({ ...options, client: empty, candidate: true }), null);
  assert.equal(queries, 0, 'Read-only correction does not need an already-qualified candidate');
  await assert.rejects(requireReleaseGateWriteAdmission({ ...options, client: empty, candidate: false }), /Three green rehearsals/);
  const run = { id: 50, head_sha: source, status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
    head_repository: { full_name: environment.GITHUB_REPOSITORY }, created_at: '2026-10-14T10:01:00Z', run_attempt: 1 };
  const samples = [1, 2, 3].map(sample => ({ id: 60 + sample, name: `candidate-startup-${sample}`, conclusion: 'success', run_attempt: 1, runner_id: 100 + sample }));
  const artifacts = ['DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-packaging', 'DevRyan-upgrade-rollback',
    ...[1, 2, 3].map(sample => `DevRyan-startup-attempt-1-candidate-${sample}`)].map((name, index) => ({ id: 70 + index, name, expired: false }));
  const receipts = samples.map((job, index) => {
    const phases = Object.fromEntries(['inspection', 'firstReady', 'chat', 'stop', 'reopen', 'history', 'cleanup', 'receipt'].map(key =>
      [key, { status: 'passed', limitSeconds: ['firstReady', 'reopen'].includes(key) ? 30 : 10, elapsedMs: 1000 }]));
    return { protocol: 'devryan.release-startup-smoke/1', sourceCommit: source, version, dmgSha256: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64), appSha256: 'd'.repeat(64), runID: '50', runAttempt: 1, qualificationAttempt: 1, runnerID: job.runner_id, jobID: job.id, sample: index + 1, rehearsal: true,
      outcome: 'passed', appStarted: true, fixtureAttempts: 1, safeCleanup: true, cleanupErrors: [], guiPrerequisites: 'passed',
      eventStream: 'acknowledged', providerObservation: 'passed', completedAssistant: 'passed', renderedResponse: 'passed', retainedHistory: 'passed',
      gapRecords: 0, nativeCorrelation: { status: 'passed' }, elapsedMs: 8000, phases,
      ioWitness: { protocol: 'devryan.release-receipt-io/1', receiptSha256: 'e'.repeat(64) },
      ioObservation: { protocol: 'devryan.release-receipt-observation/1', receiptSha256: 'e'.repeat(64), witnessSha256: 'f'.repeat(64), phase: phases.receipt, elapsedMs: 8000 } };
  });
  const metadata = { protocol: 'devryan.release-candidate/1', sourceCommit: source, version, dmgSha256: receipts[0].dmgSha256, lockfile: identity.lockfile };
  const upgrade = { protocol: 'devryan.release-upgrade-rollback/1', sourceCommit: source, version, dmgSha256: metadata.dmgSha256,
    manifestSha256: receipts[0].manifestSha256, baseline: { sourceCommit: 'e'.repeat(40), version: '2.0.1', dmgSha256: 'e'.repeat(64), manifestSha256: 'f'.repeat(64) },
    outcome: 'passed', diagnostic: false, attempts: 1, safeCleanup: true, cleanupErrors: [], sourceChanged: false,
    cases: ['compiled-clone-layout-legacy', 'compiled-clone-layout-fresh-install', 'compiled-fresh-install-clone', 'compiled-fresh-install-rollback', 'candidate-work-rollback-retention'].map(id => ({ id, status: 'passed' })) };
  const client = { pages: async route => route.includes('/workflows/') ? [run] : route.includes('/jobs')
    ? [...samples, { id: 64, name: 'candidate-upgrade-rollback', conclusion: 'success', run_attempt: 1 }] : artifacts,
    readGateReceipts: async () => receipts, readCandidateProof: async () => metadata, readUpgradeProof: async () => upgrade };
  const qualified = await requireReleaseGateWriteAdmission({ ...options, client, candidate: false });
  assert.equal(qualified.run.id, 50); assert.deepEqual(qualified.samples.map(row => row.id), [61, 62, 63]);
  const originalJobs = [...samples, { id: 64, name: 'candidate-upgrade-rollback', conclusion: 'success', run_attempt: 1 }]
    .map(job => ({ ...job, runner_id: job.runner_id ?? 104, started_at: '2026-10-14T10:01:01Z', completed_at: '2026-10-14T10:01:02Z',
      steps: [{ name: 'Complete job', number: 1, status: 'completed', conclusion: 'success', started_at: '2026-10-14T10:01:01Z', completed_at: '2026-10-14T10:01:02Z' }] }));
  const copiedJobs = originalJobs.map(job => ({ ...job, id: job.id + 100, run_attempt: 3 }));
  const copied = { ...client, pages: async route => route.includes('/jobs') ? [...originalJobs, ...copiedJobs] : client.pages(route) };
  assert.equal(releaseGateExecutions([...originalJobs, ...copiedJobs]).length, 4);
  assert.equal(releaseGateExecutions([...originalJobs, { ...copiedJobs[0], completed_at: '2026-10-14T10:02:02Z' }]).length, 5, 'A fresh execution is not a reused copy');
  assert.equal(releaseGateExecutions([...originalJobs, { ...copiedJobs[0], conclusion: 'failure' }]).length, 5, 'Failed jobs are never discarded as copied success');
  assert.deepEqual((await resolveQualifiedReleaseCandidate({ ...options, client: copied })).samples.map(job => job.id), [61, 62, 63],
    'Copied successful siblings resolve to their original producer receipts');
  const completing = { ...copied, pages: async route => route.includes('/workflows/') ? [{ ...run, status: 'in_progress', conclusion: null }] : copied.pages(route) };
  assert.equal((await resolveQualifiedReleaseCandidate({ ...options, client: completing, candidateRunID: 50, candidateCompletion: true })).run.id, 50,
    'Candidate workflow freezes feasible budget before completing, tagging or drafting');
  const reusedRunner={...client,pages:async route=>route.includes('/jobs')?samples.map(job=>({...job,runner_id:101})).concat({id:64,name:'candidate-upgrade-rollback',conclusion:'success',run_attempt:1}):client.pages(route),
    readGateReceipts:async()=>receipts.map(row=>({...row,runnerID:101}))};
  await assert.rejects(resolveQualifiedReleaseCandidate({...options,client:reusedRunner}),/distinct original hosted runners/);
  for (const change of ['older', 'receipt', 'source', 'digest', 'manifest', 'budget', 'upgrade', 'expired']) {
    const altered = structuredClone({ run, receipts, metadata, upgrade, artifacts });
    if (change === 'older') altered.run.created_at = '2026-10-14T09:59:00Z';
    if (change === 'receipt') altered.receipts.pop();
    if (change === 'source') altered.metadata.sourceCommit = '9'.repeat(40);
    if (change === 'digest') altered.metadata.dmgSha256 = '9'.repeat(64);
    if (change === 'manifest') altered.receipts[1].manifestSha256 = '9'.repeat(64);
    if (change === 'budget') for (const row of altered.receipts) for (const phase of Object.values(row.phases)) { phase.elapsedMs = 90000; phase.limitSeconds = 120; }
    if (change === 'upgrade') altered.upgrade.manifestSha256 = '9'.repeat(64);
    if (change === 'expired') altered.artifacts[0].expired = true;
    const invalid = { ...client, pages: async route => route.includes('/workflows/') ? [altered.run] : route.includes('/artifacts') ? altered.artifacts : client.pages(route),
      readGateReceipts: async () => altered.receipts, readCandidateProof: async () => altered.metadata, readUpgradeProof: async () => altered.upgrade };
    await assert.rejects(requireReleaseGateWriteAdmission({ ...options, client: invalid, candidate: false }), undefined, change);
  }
  // Failure history is preserved; qualification authorizes this exact new cohort only.
  assert.throws(() => assertRollingGateFailures(failures), /Two unexplained/);
});

test('expired attempt evidence retains authoritative cohort identity inside and outside ten versions without a failure pardon', async () => {
  const runs = Array.from({ length: 11 }, (_, index) => ({ id: 40 - index, head_branch: 'main',
    head_sha: (40 - index).toString(16).padStart(40, '0'), head_repository: { full_name: environment.GITHUB_REPOSITORY } }));
  const identityFor = run => ({ source: run.head_sha, version: `2.0.${run.id}`, scope });
  for (const inventoryOwner of ['published', 'retained-admission']) {
    let expiredID = runs[10].id;
    const client = { pages: async route => {
      if (route === '/releases') {
        if (inventoryOwner !== 'published') return [];
        const proof = { ...admitted, ...identityFor(runs[10]) };
        return [{ ...release(), tag_name: `v${proof.version}`, target_commitish: proof.source,
          body: `<!-- devryan-release-admission ${JSON.stringify(proof)} -->` }];
      }
      const id = Number(route.match(/runs\/(\d+)/)[1]);
      return route.includes('/jobs') ? [{ name: 'candidate-startup-1', conclusion: 'success' }]
        : [{ id, name: 'DevRyan-release-admission', expired: id === expiredID }];
    }, readAdmissionProof: async (_artifact, run) => ({ ...identityFor(run),
      ...(inventoryOwner === 'retained-admission' && run.id === runs[0].id ? { history: [{ ...identityFor(runs[10]), runs: [runs[10].id] }] } : {}) }) };
    const outside = await readReleaseGateHistory(process.cwd(), client, runs, 50);
    assert.equal(outside.runs.length, 11);
    assert.equal(outside.inventory.length, 11, 'Unpublished identities carried forward, without failure pardon');
    expiredID = runs[1].id;
    // The oldest evidence becomes retained; newest proof identifies the now-expired selected run.
    const original = client.readAdmissionProof;
    client.readAdmissionProof = async (artifact, run) => ({ ...await original(artifact, run),
      ...(run.id === runs[0].id ? { history: [{ ...identityFor(runs[1]), runs: [runs[1].id] }] } : {}) });
    const retainedIdentity = await readReleaseGateHistory(process.cwd(), client, runs, 50);
    assert.equal(retainedIdentity.runs.length, 11, 'Expired attempt evidence cannot erase trusted identity or crash history');
  }
});

test('prepublication rejects missing/foreign receipt IO, changed qualified budgets and installer before any writer', async t => {
  const { directory, digest } = await fixture(t), proofRoot = path.join(directory, 'proof');
  await fs.mkdir(proofRoot);
  // Keep evidence outside the exact public asset directory.
  const assetRoot = path.join(directory, 'assets'); await fs.mkdir(assetRoot);
  await fs.rename(path.join(directory, name), path.join(assetRoot, name));
  const qualified = { sourceCommit: source, version, dmgSha256: digest, manifestSha256: 'c'.repeat(64), appSha256: 'd'.repeat(64) };
  const limits = { inspection: 10, firstReady: 30, chat: 10, stop: 10, reopen: 30, history: 10, cleanup: 10, receipt: 10 };
  const file = path.join(proofRoot, 'final.json'), identityPath = path.join(proofRoot, 'identity.json'), limitsPath = path.join(proofRoot, 'limits.json');
  const writeProof = async (change = {}) => {
    const receipt = { protocol: 'devryan.release-startup-smoke/1', ...qualified, rehearsal: false, sample: 0, runID: '17', runAttempt: 1, qualificationAttempt: 1, runnerID: 100,
      outcome: 'passed', appStarted: true, fixtureAttempts: 1, safeCleanup: true, cleanupErrors: [], guiPrerequisites: 'passed',
      eventStream: 'acknowledged', providerObservation: 'passed', completedAssistant: 'passed', renderedResponse: 'passed', retainedHistory: 'passed',
      gapRecords: 0, nativeCorrelation: { status: 'passed' }, elapsedMs: 1000,
      phases: Object.fromEntries(Object.entries(limits).map(([key, limitSeconds]) => [key, { status: key === 'receipt' ? 'pending' : 'passed', limitSeconds, elapsedMs: 10 }])), ...change };
    const bytes = JSON.stringify(receipt), bound = { sourceCommit: receipt.sourceCommit, dmgSha256: receipt.dmgSha256, sample: receipt.sample, runID: receipt.runID, runAttempt: receipt.runAttempt, qualificationAttempt: receipt.qualificationAttempt, runnerID: receipt.runnerID };
    const witness = JSON.stringify({ protocol: 'devryan.release-receipt-io/1', receiptSha256: hash(bytes), ...bound });
    const observation = { protocol: 'devryan.release-receipt-observation/1', receiptSha256: hash(bytes), witnessSha256: hash(witness), ...bound,
      phase: { ...receipt.phases.receipt, status: 'passed' }, elapsedMs: 1000, clockScope: 'receipt-json-and-digest-witness-io', observationCommit: 'bounded-by-receipt-deadline-excluded-from-observation' };
    await Promise.all([fs.writeFile(file, bytes), fs.writeFile(`${file}.receipt-io`, witness), fs.writeFile(`${file}.receipt-observation`, JSON.stringify(observation)),
      fs.writeFile(identityPath, JSON.stringify(qualified)), fs.writeFile(limitsPath, JSON.stringify(limits))]);
  };
  const options = { receiptPath: file, identityPath, limitsPath, directory: assetRoot, identity: { source, version, scope, dmgSha256: digest }, runID: '17', runAttempt: 1 };
  await writeProof(); await verifyReleasePrepublish(options);
  for (const missing of [file, `${file}.receipt-io`, `${file}.receipt-observation`, identityPath, limitsPath]) {
    await writeProof(); await fs.rm(missing); let writes = 0;
    await assert.rejects(verifyReleasePrepublish(options).then(() => { writes++; })); assert.equal(writes, 0);
  }
  for (const change of [{ sourceCommit: 'e'.repeat(40) }, { manifestSha256: 'e'.repeat(64) }, { appSha256: 'e'.repeat(64) }, { runID: '18' }, { runAttempt: 2 }, { rehearsal: true }]) {
    await writeProof(change); await assert.rejects(verifyReleasePrepublish(options));
  }
  await writeProof(); await fs.writeFile(limitsPath, JSON.stringify({ ...limits, chat: 11 }));
  await assert.rejects(verifyReleasePrepublish(options), /qualified phase budget/);
  await writeProof(); await fs.writeFile(`${file}.receipt-io`, '{}'); await assert.rejects(verifyReleasePrepublish(options));
  await writeProof(); await fs.writeFile(path.join(assetRoot, name), 'changed installer'); await assert.rejects(verifyReleasePrepublish(options));
});

test('read-only history excludes skipped and never-started gates while retaining executed legacy failures', async () => {
  const runs = [1, 2, 3].map(id => ({ id, head_sha: source, head_branch: `v${version}`, event: 'push',
    head_repository: { full_name: environment.GITHUB_REPOSITORY } }));
  const jobs = [
    { id: 11, name: 'qualify-release-startup', conclusion: 'skipped', started_at: null, steps: [] },
    { id: 12, name: 'final-dmg-smoke', conclusion: 'cancelled', started_at: null, steps: [] },
    { id: 13, name: 'qualify-release-startup', conclusion: 'failure', run_attempt: 6, started_at: '2026-10-14T10:00:00Z', steps: [{ name: 'Launch', conclusion: 'failure' }] },
  ];
  const requests = [];
  const client = { pages: async route => {
    requests.push(route); if (route === '/releases') return [];
    const id = Number(route.match(/runs\/(\d+)/)[1]);
    return route.includes('/jobs') ? [jobs[id - 1]] : [];
  }, tagSource: async () => source };
  const history = await readReleaseGateHistory(process.cwd(), client, runs, 10);
  assert.deepEqual(history.runs.map(run => run.id), [3]);
  assert.equal(requests.some(route => /runs\/1\/artifacts/.test(route)), false, 'Skipped jobs need no receipt');
  assert.ok(requests.some(route => /runs\/2\/artifacts/.test(route)), 'Sparse cancelled job still checks original execution receipts');
  assert.equal(countUnexplainedReleaseGateFailures(jobs, [], history.runs[0]), 1);
  assert.equal(isExecutedReleaseGateJob(jobs[0]), false);
  await assert.rejects(readReleaseGateHistory(process.cwd(), { ...client, tagSource: async () => 'b'.repeat(40) }, runs, 10), /tag changed source/);
});

test('partial, missing and expired attempt artifacts count unexplained without crashing trusted history or qualifying success', async () => {
  const run = { id: 50, head_sha: source, head_repository: { full_name: environment.GITHUB_REPOSITORY } };
  const jobs = [1, 2].map(sample => ({ id: 60 + sample, name: `candidate-startup-${sample}`, run_attempt: 9,
    conclusion: 'failure', started_at: '2026-10-14T10:00:00Z' }));
  const artifacts = [1, 2].map(sample => ({ id: 70 + sample, name: `DevRyan-startup-attempt-9-candidate-${sample}`, expired: sample === 2 }));
  const client = { pages: async route => route === '/releases' ? [{ ...release(), draft: false }]
    : route.includes('/jobs') ? jobs : artifacts,
  readGateArtifact: async () => { throw Error('Missing post-rename I/O witness'); } };
  const history = await readReleaseGateHistory(process.cwd(), client, [run], 99);
  const receipts = await readReleaseGateReceipts(process.cwd(), client, run.id);
  assert.deepEqual(receipts, []);
  const failures = countUnexplainedReleaseGateFailures(jobs, receipts, history.runs[0]);
  assert.equal(failures, 2);
  assert.throws(() => assertRollingGateFailures([{ ...history.runs[0], unexplainedGateFailures: failures }]), /Two unexplained/);
  assert.throws(() => assertPriorGateAttempts(jobs, receipts, { source, dmgSha256: 'b'.repeat(64) }), /original receipt/);
});

test('receipt artifact names preserve arbitrary workflow attempt correlation and cannot substitute another sample', async () => {
  const proof = { protocol: 'devryan.release-startup-smoke/1', runID: '50', runAttempt: 9, rehearsal: true, sample: 1 };
  const artifact = { id: 71, name: 'DevRyan-startup-attempt-9-candidate-1', expired: false };
  const client = { pages: async () => [artifact], readGateArtifact: async () => proof };
  assert.deepEqual(await readReleaseGateReceipts(process.cwd(), client, 50), [proof]);
  for (const change of [{ runAttempt: 1 }, { runID: '51' }, { sample: 2 }, { rehearsal: false }, { protocol: 'legacy' }])
    assert.deepEqual(await readReleaseGateReceipts(process.cwd(), { ...client, readGateArtifact: async () => ({ ...proof, ...change }) }, 50), []);
  assert.deepEqual(await readReleaseGateReceipts(process.cwd(), { ...client, pages: async () => [{ ...artifact, expired: true }] }, 50), []);
});

test('admitted but unexecuted versions retain source fences without evicting older unexplained gate failures', async () => {
  const runs = Array.from({ length: 12 }, (_, index) => ({ id: 30 - index, head_sha: source,
    head_repository: { full_name: environment.GITHUB_REPOSITORY } }));
  const admissionJob = { name: 'create-release', conclusion: 'success', steps: [{ name: 'Admit immutable release source before heavy work', conclusion: 'success' }] };
  const client = { pages: async route => {
    if (route === '/releases') return [];
    const id = Number(route.match(/runs\/(\d+)/)[1]);
    return route.includes('/jobs') ? [admissionJob, { id: id + 100, name: 'final-dmg-smoke', run_attempt: 1,
      conclusion: id > 20 ? 'skipped' : 'failure' }] : [{ id, name: 'DevRyan-release-admission', expired: false }];
  }, readAdmissionProof: async (_artifact, run) => ({ source, version: `2.0.${run.id}`, scope }) };
  const history = await readReleaseGateHistory(process.cwd(), client, runs, 99);
  assert.equal(history.runs.length, 12, 'Source identity survives even when qualification did not execute');
  const selected = selectRollingReleaseGateRuns(history.runs);
  assert.deepEqual(selected.map(run => run.id), [20, 19]);
  const counted = selected.map(run => ({ ...run, unexplainedGateFailures: countUnexplainedReleaseGateFailures(history.jobsByRun.get(run.id), [], run) }));
  assert.throws(() => assertRollingGateFailures(counted), /Two unexplained/);
  assert.throws(() => assertReleaseSourceHistory(history.runs, history.jobsByRun, { source: 'b'.repeat(40), version: '2.0.30' }), /retagged/);
});

test('only exact public updater discovery can finalize version, digest, size and download URL after promotion', async t => {
  const { directory, digest, bytes } = await fixture(t);
  const expected = { version, name, sha256: digest, size: bytes.length,
    url: `https://github.com/1H-Team/DevRyan/releases/download/v${version}/${name}` };
  const payload = { ...release(), draft: false, assets: [{ name, state: 'uploaded', digest: `sha256:${digest}`, size: bytes.length, browser_download_url: expected.url }] };
  assert.deepEqual(await assertPublishedUpdaterDiscovery(payload, { version }, expected), expected);
  for (const change of ['version', 'digest', 'size', 'url', 'draft']) {
    const changed = structuredClone(payload);
    if (change === 'version') { changed.tag_name = 'v2.0.11'; changed.html_url = 'https://github.com/1H-Team/DevRyan/releases/tag/v2.0.11'; }
    if (change === 'digest') changed.assets[0].digest = `sha256:${'f'.repeat(64)}`;
    if (change === 'size') changed.assets[0].size++;
    if (change === 'url') changed.assets[0].browser_download_url = 'https://example.invalid/untrusted.dmg';
    if (change === 'draft') changed.draft = true;
    await assert.rejects(assertPublishedUpdaterDiscovery(changed, { version }, expected));
    const f = clientFixture(), request = f.client.request;
    f.client.request = (route, options) => route === '/releases/latest' ? changed : request(route, options);
    let finalProof = false;
    await assert.rejects(finalizeRelease({ identity: { source, version, scope, releaseID: 9 }, directory,
      deploymentVerified: true, environment, updaterDiscovery: { attempts: 1 }, client: f.client }).then(() => { finalProof = true; }));
    assert.equal(f.getRelease().draft, false, 'Failure is checked against actual post-promotion metadata');
    assert.equal(finalProof, false, 'Failed updater discovery cannot return a finalization receipt');
  }
});


test('queued cancellation excludes only explicit unexecuted proof; steps, runners and original receipts prove execution', () => {
  const queued = { id: 114763651264, run_attempt: 2, name: 'qualify-release-startup', status: 'completed', conclusion: 'cancelled',
    started_at: '2026-10-14T10:00:00Z', completed_at: '2026-10-14T10:00:01Z', steps: [], runner_id: null, runner_name: null, runner_group_id: null };
  assert.equal(isExecutedReleaseGateJob(queued), false);
  assert.equal(isExecutedReleaseGateJob({ ...queued, runner_id: 83 }), true);
  assert.equal(isExecutedReleaseGateJob({ ...queued, started_at: null, runner_id: 83 }), true, 'Assigned runner is execution proof even with a missing start timestamp');
  assert.equal(isExecutedReleaseGateJob({ ...queued, steps: [{ name: 'Set up job', conclusion: 'failure' }] }), true);
  const missingRunner = { ...queued }; delete missingRunner.runner_id;
  assert.equal(isExecutedReleaseGateJob(missingRunner), true, 'Missing fields cannot prove unexecuted');
  const original = { jobID: queued.id, runAttempt: 2 };
  assert.equal(isExecutedReleaseGateJob(queued, [original]), true, 'Original receipt proves execution despite sparse API fields');
  assert.equal(countUnexplainedReleaseGateFailures([queued], [original], { id: 10 }), 1, 'Partial executed failure is unexplained');
});

test('trusted legacy dispatch source metadata classifies actual branch shapes and bounds jobs to ten executed versions', async () => {
  const runs = Array.from({ length: 30 }, (_, index) => ({ id: index === 0 ? 38368340216 : 38368340216 - index,
    head_sha: (30 - index).toString(16).padStart(40, '0'), head_branch: index % 2 ? 'scratch/release-review' : 'release/startup',
    path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_repository: { full_name: environment.GITHUB_REPOSITORY } }));
  // A much older retry of an included version still needs its original failure inventory.
  runs.push({ ...runs[0], id: 36401954709 });
  const requests = [];
  const client = { sourceVersion: async commit => `2.0.${parseInt(commit, 16)}`,
    pages: async route => {
      requests.push(route); if (route === '/releases' || route.endsWith('/artifacts')) return [];
      return [{ id: 42, run_attempt: 1, name: 'qualify-release-startup', conclusion: 'failure', runner_id: 7 }];
    } };
  const history = await readReleaseGateHistory(process.cwd(), client, runs, 51);
  assert.equal(history.complete, true); assert.equal(history.runs.length, 11);
  assert.equal(requests.filter(route => route.includes('/jobs')).length, 11, 'No jobs request for versions outside the required window');
  assert.ok(history.runs.some(run => run.id === 36401954709));
  assert.equal(countUnexplainedReleaseGateFailures(history.jobsByRun.get(runs[0].id), [], history.runs[0]), 1);
  for (const change of [{ path: '.github/workflows/other.yml' }, { event: 'pull_request' }, { head_repository: { full_name: 'other/repository' } }])
    await assert.rejects(readReleaseGateHistory(process.cwd(), client, [{ ...runs[0], ...change }], 51));
});

test('stable tag pushes take their version from the trusted ref without a package metadata read', async () => {
  const sourceReads = [];
  const runs = [
    { id: 30, head_sha: 'c'.repeat(40), head_branch: 'v2.0.12', event: 'push' },
    { id: 20, head_sha: 'b'.repeat(40), head_branch: 'v2.0.12', event: 'push' },
    { id: 10, head_sha: 'a'.repeat(40), head_branch: 'scratch/v2.0.9-sample-2', event: 'workflow_dispatch' },
  ].map(run => ({ ...run, path: '.github/workflows/release.yml', head_repository: { full_name: environment.GITHUB_REPOSITORY } }));
  const client = { sourceVersion: async commit => { sourceReads.push(commit); return '2.0.9'; },
    pages: async route => (route === '/releases' || route.endsWith('/artifacts') ? []
      : [{ id: 42, run_attempt: 1, name: 'final-dmg-smoke', conclusion: 'success', runner_id: 7 }]) };
  const history = await readReleaseGateHistory(process.cwd(), client, runs, 51);
  assert.deepEqual(sourceReads, ['a'.repeat(40)], 'Only dispatches read package metadata');
  assert.deepEqual(history.runs.map(run => run.releaseVersion), ['2.0.12', '2.0.12', '2.0.9']);
  // A conflicting retained admission proof still fails closed.
  const conflicting = { ...client, pages: async route => (route.endsWith('/artifacts') ? [{ id: 9, name: 'DevRyan-release-admission', expired: false }] : client.pages(route)),
    readAdmissionProof: async (_artifact, run) => ({ source: run.head_sha, version: '2.0.11', scope: 'desktop-macos-arm64' }) };
  await assert.rejects(readReleaseGateHistory(process.cwd(), conflicting, runs.slice(0, 1), 51), /Historical admission identities conflict/);
});

test('history pagination and immutable source reads have finite budgets and report incomplete exhaustion', async () => {
  let requests = 0;
  const client = githubReleaseClient(environment, async () => { requests++; return { ok: true, json: async () => ({ workflow_runs: Array.from({ length: 100 }, () => ({})) }) }; });
  await assert.rejects(client.pages('/actions/workflows/release.yml/runs', 'workflow_runs'), { code: 'release_history_incomplete', complete: false, requestCount: 10 });
  assert.equal(requests, 10);
  let sourceRequests = 0;
  const sourceClient = githubReleaseClient(environment, async url => {
    sourceRequests++; assert.ok(url.endsWith(`/contents/package.json?ref=${source}`));
    return { ok: true, json: async () => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ version })).toString('base64') }) };
  });
  assert.equal(await sourceClient.sourceVersion(source), version); assert.equal(await sourceClient.sourceVersion(source), version);
  assert.equal(sourceRequests, 1); assert.equal(sourceClient.requestCount, 1);
  const budgetClient = githubReleaseClient(environment, async () => ({ ok: true, json: async () => ({}) }));
  for (let read = 0; read < 900; read++) await budgetClient.request('/synthetic-history');
  await assert.rejects(budgetClient.request('/synthetic-history'), { code: 'release_history_incomplete', complete: false, requestCount: 900 });
  const artifact = { id: 8, name: 'DevRyan-startup-attempt-1-candidate-1', expired: false };
  budgetClient.pages = async () => [artifact];
  await assert.rejects(readReleaseGateReceipts(process.cwd(), budgetClient, 50), { code: 'release_history_incomplete', complete: false, requestCount: 900 });
  let reads = 0;
  const controller = new AbortController();
  const setupClient = githubReleaseClient(environment, async (_url, options) => {
    reads++; controller.abort(Error('setup expired')); options.signal.throwIfAborted();
  }, { signal: controller.signal });
  await assert.rejects(setupClient.pages('/synthetic-history', 'jobs'), /setup expired/);
  await assert.rejects(setupClient.request('/synthetic-history'), /setup expired/);
  assert.equal(reads, 1, 'A paginated setup read cannot reset the caller deadline');
});

test('an actual partial-only ZIP cannot qualify or excuse its failed executed job', async t => {
  const { directory } = await fixture(t), partial = path.join(directory, 'candidate-startup-1.json.partial');
  await fs.writeFile(partial, JSON.stringify({ protocol: 'devryan.release-startup-smoke/1', outcome: 'failed' }));
  const zip = path.join(directory, 'partial.zip'); execFileSync('zip', ['-q', zip, path.basename(partial)], { cwd: directory });
  const artifact = { id: 88, name: 'DevRyan-startup-attempt-1-candidate-1', expired: false };
  const client = { pages: async () => [artifact] };
  const archiveBytes = await fs.readFile(zip);
  client.readGateArtifact = entry => readArtifactReceipt(process.cwd(), entry, { archiveBytes, receiptIo: true });
  const receipts = await readReleaseGateReceipts(process.cwd(), client, 50);
  assert.deepEqual(receipts, []);
  const jobs = [{ id: 42, name: 'candidate-startup-1', run_attempt: 1, conclusion: 'failure', runner_id: 7 }];
  assert.equal(countUnexplainedReleaseGateFailures(jobs, receipts, { id: 50, head_sha: source, releaseVersion: version }), 1);
  assert.throws(() => assertPriorGateAttempts(jobs, receipts, { source, dmgSha256: 'a'.repeat(64) }), /original receipt/);
});

test('bounded actual updater parser retries feed lag and retains original finalization before discovery', async t => {
  const { directory } = await fixture(t), f = clientFixture(), request = f.client.request;
  let discoveryReads = 0, retained;
  f.client.request = (route, options) => route === '/releases/latest' && ++discoveryReads <= 2 ? { ...release(), draft: false, tag_name: 'v2.0.9' } : request(route, options);
  const result = await finalizeRelease({ identity: { source, version, scope, releaseID: 9 }, directory,
    deploymentVerified: true, environment, client: f.client,
    retainFinalization: proof => { retained = proof; assert.equal(discoveryReads, 0); }, updaterDiscovery: { wait: async () => {} } });
  assert.equal(result.status, 'published'); assert.equal(discoveryReads, 3); assert.equal(retained.updaterDiscovery, 'pending');
  assert.equal(f.writes.filter(row => row.method === 'PATCH').length, 1); assert.equal(f.writes.filter(row => row.url).length, 1);
  let reads = 0;
  await assert.rejects(waitPublishedUpdaterDiscovery({ request: async () => { reads++; return release(); } },
    { version, releaseID: 9 }, {}, { wait: async () => {} }));
  assert.equal(reads, 6, 'Read-only feed retry stops at its fixed bound');
});

test('older published no-op verifies original release ID and bytes while allowing a legitimately newer latest', async t => {
  const { directory } = await fixture(t), f = clientFixture(), identity = { source, version, scope, releaseID: 9 };
  await finalizeRelease({ identity, directory, deploymentVerified: true, environment, client: f.client, updaterDiscovery: { attempts: 1 } });
  const request = f.client.request, writes = f.writes.length;
  f.client.request = (route, options) => route === '/releases/latest' ? { ...release(), id: 10, draft: false, tag_name: 'v2.0.11' } : request(route, options);
  await verifyPublishedFinalization(f.getRelease(), identity, f.client);
  assert.equal(f.writes.length, writes);
  await assert.rejects(verifyPublishedFinalization(f.getRelease(), { ...identity, releaseID: 10 }, f.client), /ID changed/);
  f.client.request = (route, options) => route === '/releases/latest' ? { ...release(), id: 10, draft: false } : request(route, options);
  await assert.rejects(verifyPublishedFinalization(f.getRelease(), identity, f.client), /Latest release ID/);
});


test('retained pending discovery proof recovers an original post-promotion failure without another public write', async t => {
  const { directory } = await fixture(t), f = clientFixture(), identity = { source, version, scope, releaseID: 9 };
  const request = f.client.request, pages = f.client.pages;
  let pending;
  f.client.request = (route, options) => route === '/releases/latest' ? { ...release(), id: 8, draft: false } : request(route, options);
  await assert.rejects(finalizeRelease({ identity, directory, deploymentVerified: true, environment, client: f.client,
    retainFinalization: result => { pending = { protocol: 'devryan.release-finalization/1', identity, ...result }; }, updaterDiscovery: { attempts: 1 } }));
  assert.equal(f.getRelease().draft, false); assert.equal(pending.updaterDiscovery, 'pending');
  f.client.readFinalizationProof = async () => pending;
  let latestReads = 0;
  f.client.request = async (route, options) => {
    if (route === '/releases/latest' && ++latestReads < 3) return { ...release(), id: 8, draft: false, tag_name: 'v2.0.9' };
    const value = await request(route, options);
    return route.includes('/attempts/') ? { ...value, conclusion: 'failure' } : value;
  };
  f.client.pages = async route => route.endsWith('/jobs') ? [{ name: 'finalize-release', conclusion: 'failure', steps: [
    { name: 'Deploy and verify Supabase configuration and migrations', conclusion: 'success' }, { name: 'Publish release', conclusion: 'failure' }] }] : pages(route);
  const writes = f.writes.length;
  await verifyPublishedFinalization(f.getRelease(), identity, f.client, { updaterDiscovery: { wait: async () => {} } });
  assert.equal(latestReads, 3, 'Recovery uses the same bounded read-only discovery retries');
  assert.equal(f.writes.length, writes);
  pending.finalized.source = 'b'.repeat(40);
  await assert.rejects(verifyPublishedFinalization(f.getRelease(), identity, f.client));
});
