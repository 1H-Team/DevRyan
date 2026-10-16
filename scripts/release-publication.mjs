// The existing release finalizer is the sole stable-release asset writer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, RELEASE_VERSION_PATTERN, releaseAssetDownloadUrl } from '../packages/electron/release-assets.mjs';
import { assertReleaseWritesAllowed, hash } from './release-artifacts.mjs';
import { describeDirectoryAssets, verifyReleaseAssets } from './verify-release-assets.mjs';

const marker = /<!-- devryan-release-admission (\{[^\n]*\}) -->/g;
const sha = /^[a-f0-9]{40}$/;
const assertStableReleaseWritesAllowed = environment => {
  assertReleaseWritesAllowed(environment);
  assert.ok([undefined, 'false'].includes(environment.RELEASE_BOT_INPUTS_ONLY), 'Bot input preparation prohibits application release writes');
};
export function readReleaseAdmission(release) {
  const matches = [...(release?.body ?? '').matchAll(marker)];
  assert.equal(matches.length, 1, 'Release must retain its original source admission');
  const admitted = JSON.parse(matches[0][1]);
  assert.equal(admitted.protocol, 'devryan.release-admission/1');
  assert.ok(sha.test(admitted.source));
  assert.ok(RELEASE_VERSION_PATTERN.test(admitted.version));
  assert.ok(['desktop-macos-arm64', 'full'].includes(admitted.scope));
  assert.match(String(admitted.run), /^[1-9][0-9]*$/);
  assert.equal(release.tag_name, `v${admitted.version}`);
  assert.equal(release.target_commitish, admitted.source);
  return admitted;
}
const admissionBody = (body, admitted) => `${body.replace(marker, '').trim()}\n\n<!-- devryan-release-admission ${JSON.stringify(admitted)} -->`;
export function assertAdmittedRelease(release, { source, version, scope, releaseID }, { draft = true } = {}) {
  const admitted = readReleaseAdmission(release);
  assert.equal(admitted.source, source, 'A release version cannot be reused for another source');
  assert.equal(admitted.version, version); assert.equal(admitted.scope, scope);
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  if (releaseID !== undefined && releaseID !== null) assert.equal(release.id, Number(releaseID), 'Admitted release ID changed');
  assert.equal(release.prerelease, false);
  if (draft) assert.equal(release.draft, true, 'Published release writes are forbidden');
  return admitted;
}
export function githubReleaseClient(environment = process.env, fetchImpl = fetch, { signal: invocationSignal, maximumRequests = 900 } = {}) {
  assert.equal(environment.GITHUB_REPOSITORY, RELEASE_REPOSITORY);
  assert.ok(environment.GITHUB_TOKEN, 'GitHub verification token required');
  assert.ok(Number.isSafeInteger(maximumRequests) && maximumRequests >= 1 && maximumRequests <= 900);
  const api = `https://api.github.com/repos/${RELEASE_REPOSITORY}`;
  const headers = { Authorization: `Bearer ${environment.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  let requestCount = 0, lastRequest;
  const incomplete = message => Object.assign(Error(message), { code: 'release_history_incomplete', complete: false, requestCount });
  const countRequest = () => {
    if (requestCount >= maximumRequests) throw incomplete('Release admission API request budget exhausted; history incomplete');
    requestCount++;
  };
  const request = async (route, { method = 'GET', body, notFound = false, signal } = {}) => {
    invocationSignal?.throwIfAborted();
    countRequest();
    lastRequest = route;
    if (method !== 'GET') assertStableReleaseWritesAllowed(environment);
    const response = await fetchImpl(api + route, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.any([invocationSignal, signal, AbortSignal.timeout(30_000)].filter(Boolean)) });
    if (notFound && response.status === 404) return null;
    assert.ok(response.ok, `GitHub release request failed (${response.status})`);
    return response.json();
  };
  const pages = async (route, key) => {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const result = await request(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = key ? result[key] : result;
      assert.ok(Array.isArray(rows), 'Complete GitHub inventory required'); all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw incomplete('Release history pagination limit reached; history incomplete');
  };
  const tagSource = async (version, { optional = false } = {}) => {
    const ref = await request(`/git/ref/tags/v${version}`, { notFound: optional });
    if (!ref) return null;
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
      assert.ok(sha.test(object.sha)); object = (await request(`/git/tags/${object.sha}`)).object;
    }
    assert.equal(object?.type, 'commit'); assert.ok(sha.test(object.sha)); return object.sha;
  };
  const frozenTag = async (version, source, options) => {
    const current = await tagSource(version, options);
    if (!current) return false;
    assert.equal(current, source, 'Release tag moved from admitted source'); return true;
  };
  const versions = new Map();
  const sourceVersion = async source => {
    assert.ok(sha.test(source));
    if (!versions.has(source)) {
      if (versions.size >= 600) throw incomplete('Release history source identity limit reached; history incomplete');
      const file = await request(`/contents/package.json?ref=${source}`);
      assert.equal(file.type, 'file'); assert.equal(file.encoding, 'base64');
      const version = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')).version;
      assert.ok(RELEASE_VERSION_PATTERN.test(version), 'Historical source has no stable version');
      versions.set(source, version);
    }
    return versions.get(source);
  };
  const artifactReceipt = (root, artifact, options) => {
    assert.equal(artifact.expired, false, 'Original release evidence expired');
    countRequest();
    lastRequest = `/actions/artifacts/${artifact.id}/zip`;
    return readArtifactReceipt(root, artifact, options);
  };
  return { request, pages, tagSource, frozenTag, sourceVersion, readArtifactReceipt: artifactReceipt, headers, fetchImpl,
    get requestCount() { return requestCount; }, get lastRequest() { return lastRequest; } };
}
const exec = promisify(execFile);
/** GET-only local diagnostics use gh's existing owner without reading credentials. */
export function githubReleaseHistoryClient(environment = process.env) {
  return githubReleaseClient({ ...environment, GITHUB_TOKEN: 'local-gh-read-only' }, async (url, options) => {
    assert.equal(options.method, 'GET', 'History diagnostics prohibit release writers');
    const { stdout } = await exec('gh', ['api', '--method', 'GET', url], { signal: options.signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, json: async () => JSON.parse(stdout) };
  }, { maximumRequests: 120 });
}
export async function readArtifactReceipt(root, artifact, { receiptIo = false, member = '*.json', archiveBytes } = {}) {
  assert.equal(artifact.expired, false, 'Original release evidence expired');
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  const parent = path.join(root, '.cache/release-admission'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'receipts-'));
  try {
    const archive = archiveBytes ?? (await exec('gh', ['api', `repos/${RELEASE_REPOSITORY}/actions/artifacts/${artifact.id}/zip`], { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'buffer' })).stdout;
    const file = path.join(directory, `${artifact.id}.zip`); await fs.writeFile(file, archive, { mode: 0o600, flag: 'wx' });
    const bytes = (await exec('unzip', ['-p', file, member], { maxBuffer: member === 'admission.json' ? 1024 * 1024 : 64 * 1024 })).stdout;
    const receipt = JSON.parse(bytes);
    if (receiptIo) {
      const witness = (await exec('unzip', ['-p', file, '*.receipt-io'], { maxBuffer: 64 * 1024 })).stdout;
      const observation = (await exec('unzip', ['-p', file, '*.receipt-observation'], { maxBuffer: 64 * 1024 })).stdout;
      const { finalizeReleaseSmokeIoReceipt } = await import('./qa/release-startup-smoke-contract.mjs');
      return finalizeReleaseSmokeIoReceipt(bytes, witness, observation);
    }
    return receipt;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
export async function readReleaseGateReceipts(root, client, runID) {
  if (client.readGateReceipts) return client.readGateReceipts(runID);
  const artifacts = await client.pages(`/actions/runs/${runID}/artifacts`, 'artifacts');
  const receipts = [];
  for (const artifact of artifacts.filter(row => /^DevRyan-startup-attempt-[1-9][0-9]*-(?:candidate-[1-3]|final)$/.test(row.name))) {
    try {
      assert.equal(artifact.expired, false, 'Original release evidence expired');
      const receipt = client.readGateArtifact ? await client.readGateArtifact(artifact) : await (client.readArtifactReceipt ?? readArtifactReceipt)(root, artifact, { receiptIo: true });
      assert.equal(receipt.protocol, 'devryan.release-startup-smoke/1'); assert.equal(receipt.runID, String(runID));
      assert.equal(artifact.name, `DevRyan-startup-attempt-${receipt.runAttempt}-${receipt.rehearsal ? `candidate-${receipt.sample}` : 'final'}`);
      receipts.push(receipt);
    } catch (error) {
      if (error.code === 'release_history_incomplete') throw error;
      // Missing or malformed evidence cannot excuse a failed job or qualify a successful one.
    }
  }
  return receipts;
}
async function readFinalizationProof(client, proof) {
  const artifacts = (await client.pages(`/actions/runs/${proof.run}/artifacts`, 'artifacts'))
    .filter(row => row.name === `DevRyan-release-finalization-${proof.attempt}`);
  assert.equal(artifacts.length, 1, 'Original immutable finalization artifact required');
  return (client.readArtifactReceipt ?? readArtifactReceipt)(fileURLToPath(new URL('../', import.meta.url)), artifacts[0]);
}
export function assertReleaseSourceHistory(runs, jobsByRun, { source, version }) {
  for (const run of runs.filter(row => row.releaseVersion === version)) {
    if ((jobsByRun.get(run.id) ?? []).some(job => job.name === 'create-release' && job.steps?.some(step =>
      step.name === 'Admit immutable release source before heavy work' && step.conclusion === 'success'))) {
      assert.equal(run.head_sha, source, 'A previously admitted version cannot be retagged after its draft is removed');
    }
  }
}

/** Read-only admission for deployment/npm/publication, repeated by the writer. */
export async function verifyReleasePrepublish({ receiptPath, identityPath, limitsPath, directory, identity, runID, runAttempt }) {
  const { readReleaseSmokeReceipt, assertReleaseSmokeReceipt, REHEARSAL_PHASE_SECONDS } = await import('./qa/release-startup-smoke-contract.mjs');
  const [receipt, qualified, limits, assets] = await Promise.all([
    readReleaseSmokeReceipt(receiptPath), fs.readFile(identityPath, 'utf8').then(JSON.parse),
    fs.readFile(limitsPath, 'utf8').then(JSON.parse), describeDirectoryAssets(directory),
  ]);
  assert.deepEqual(Object.keys(qualified).sort(), ['sourceCommit', 'version', 'dmgSha256', 'manifestSha256', 'appSha256'].sort());
  assert.equal(qualified.sourceCommit, identity.source); assert.equal(qualified.version, identity.version);
  assert.equal(qualified.dmgSha256, identity.dmgSha256);
  assertReleaseSmokeReceipt(receipt, { ...qualified, rehearsal: false });
  assert.equal(receipt.sample, 0); assert.equal(receipt.runID, String(runID));
  assert.equal(receipt.runAttempt, Number(runAttempt));
  assert.deepEqual(Object.keys(limits).sort(), Object.keys(REHEARSAL_PHASE_SECONDS).sort());
  assert.ok(Object.values(limits).every(value => Number.isSafeInteger(value) && value >= 10));
  assert.ok(limits.firstReady >= 30 && limits.reopen >= 30);
  assert.ok(Object.values(limits).reduce((sum, value) => sum + value, 0) <= 570, 'Qualified phases exceed absolute budget');
  for (const [name, seconds] of Object.entries(limits)) assert.equal(receipt.phases[name].limitSeconds, seconds, 'Smoke changed its qualified phase budget');
  assert.deepEqual(verifyReleaseAssets(assets, { version: identity.version, scope: identity.scope,
    digests: new Map([[`DevRyan-${identity.version}-arm64.dmg`, identity.dmgSha256],
      ...(identity.webSha256 ? [[`DevRyan-web-${identity.version}.tgz`, identity.webSha256]] : [])]) }), []);
  return receipt;
}
const gateJob = name => /^(?:candidate-startup-[123]|candidate-upgrade-rollback|final-dmg-smoke|qualify-release-startup)(?: |$)/.test(name);
export const isExecutedReleaseGateJob = (job, receipts = []) => gateJob(job.name) && job.conclusion !== 'skipped'
  && (receipts.some(receipt => receipt.jobID === job.id && receipt.runAttempt === job.run_attempt)
    || Number.isSafeInteger(job.runner_id) && job.runner_id > 0
    || !(Array.isArray(job.steps) && job.steps.length === 0
      && (job.started_at === null || (Object.hasOwn(job, 'runner_id') && [null, 0].includes(job.runner_id)))));
/** Re-run-failed-jobs copies successful siblings, retaining the original physical execution fields. */
export function releaseGateExecutions(jobs) {
  return jobs.filter((job, index) => !(job.conclusion === 'success' && jobs.some((original, originalIndex) =>
    originalIndex !== index && original.name === job.name && original.conclusion === 'success'
    && original.run_attempt < job.run_attempt && Number.isSafeInteger(job.runner_id) && job.runner_id > 0
    && original.runner_id === job.runner_id && typeof job.started_at === 'string' && typeof job.completed_at === 'string'
    && original.started_at === job.started_at && original.completed_at === job.completed_at
    && Array.isArray(job.steps) && job.steps.length > 0 && JSON.stringify(original.steps) === JSON.stringify(job.steps))));
}
/** Artifact provenance supplies the frozen version; dispatch branch names do not. */
export async function readReleaseGateHistory(root, client, allRuns, currentRunID, intended = {}) {
  assert.ok(Array.isArray(allRuns), 'Complete release workflow history required');
  const candidates = [], jobsByRun = new Map(), identities = new Map(), sourceVersions = new Map();
  const remember = (id, source, version) => {
    assert.ok(Number.isSafeInteger(id) && id > 0 && sha.test(source) && RELEASE_VERSION_PATTERN.test(version), 'Historical frozen stable identity required');
    const previous = identities.get(id), identity = { source, version };
    if (previous) assert.deepEqual(previous, identity, 'Historical admission identities conflict');
    identities.set(id, identity);
  };
  // Admission markers resolve old published/draft cohorts without relying on
  // their expiring CI payload. Ambiguous sources still need the run proof.
  for (const release of await client.pages('/releases')) {
    if (![...(release.body ?? '').matchAll(marker)].length) continue;
    const admission = readReleaseAdmission(release);
    const versions = sourceVersions.get(admission.source) ?? new Set();
    versions.add(admission.version); sourceVersions.set(admission.source, versions);
  }
  let eligible = allRuns.filter(row => row.id !== Number(currentRunID));
  // Exact workflow/event/source metadata classifies legacy dispatches without
  // inventing a successful gate or downloading every historical job inventory.
  if (client.sourceVersion) {
    for (const run of eligible) {
      assert.equal(run.path, '.github/workflows/release.yml', 'Historical release workflow changed');
      assert.equal(run.head_repository?.full_name, RELEASE_REPOSITORY, 'Historical release repository changed');
      assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'Historical release event unavailable');
      // GitHub's push ref names the stable version that tag released; reading
      // package metadata for each of hundreds of re-cut tag commits exhausts
      // the request budget. Admission proofs still must agree with it.
      const tagged = run.event === 'push' && /^v\d+\.\d+\.\d+$/.test(run.head_branch ?? '') ? run.head_branch.slice(1) : null;
      const version = tagged ?? await client.sourceVersion(run.head_sha);
      remember(run.id, run.head_sha, version);
    }
  }
  const selectedVersions = new Set();
  let jobInventories = 0;
  for (const run of eligible) {
    const known = identities.get(run.id);
    if (client.sourceVersion && selectedVersions.size >= 10 && !selectedVersions.has(known.version)
      && known.version !== intended.version && run.head_sha !== intended.source) continue;
    assert.ok(++jobInventories <= 650, 'Release history jobs limit reached; history incomplete');
    const jobs = await client.pages(`/actions/runs/${run.id}/jobs?filter=all`, 'jobs');
    assert.ok(Array.isArray(jobs), 'Complete historical job inventory required');
    jobsByRun.set(run.id, jobs);
    const admitted = jobs.some(job => job.name === 'create-release' && job.steps?.some(step =>
      step.name === 'Admit immutable release source before heavy work' && step.conclusion === 'success'));
    let executed = jobs.some(job => isExecutedReleaseGateJob(job));
    if (!executed && jobs.some(job => gateJob(job.name) && job.conclusion !== 'skipped')) {
      const receipts = await readReleaseGateReceipts(root, client, run.id);
      executed = jobs.some(job => isExecutedReleaseGateJob(job, receipts));
    }
    if (!admitted && !executed) continue;
    if (known && executed && selectedVersions.size < 10) selectedVersions.add(known.version);
    assert.equal(run.head_repository?.full_name, RELEASE_REPOSITORY, 'Historical release repository changed');
    const artifacts = await client.pages(`/actions/runs/${run.id}/artifacts`, 'artifacts');
    const admissions = artifacts.filter(row => row.name === 'DevRyan-release-admission');
    assert.ok(admissions.length <= 1, 'One immutable historical admission required');
    const retained = admissions.length === 1 && admissions[0].expired === false;
    if (retained) {
      const proof = client.readAdmissionProof ? await client.readAdmissionProof(admissions[0], run)
        : await (client.readArtifactReceipt ?? readArtifactReceipt)(root, admissions[0], { member: 'admission.json' });
      assert.equal(proof.source, run.head_sha, 'Historical admission belongs to another source');
      assert.ok(['desktop-macos-arm64', 'full'].includes(proof.scope));
      remember(run.id, proof.source, proof.version);
      // A compact immutable identity inventory carries unpublished pre-tag
      // versions past an old attempt's retention. It contains no failure pardon.
      if (proof.history !== undefined) {
        assert.ok(Array.isArray(proof.history), 'Historical identity inventory required');
        for (const cohort of proof.history) {
          assert.ok(Array.isArray(cohort.runs), 'Historical identity run IDs required');
          for (const id of cohort.runs) remember(id, cohort.source, cohort.version);
        }
      }
    }
    candidates.push({ run, retained, admissions, executed });
  }
  const runs = [];
  for (const { run, admissions, executed } of candidates) {
    let identity = identities.get(run.id);
    if (!identity) {
      const versions = sourceVersions.get(run.head_sha);
      if (versions?.size === 1) identity = { source: run.head_sha, version: [...versions][0] };
    }
    if (!identity && !admissions.length) {
      const receipts = await readReleaseGateReceipts(root, client, run.id);
      if (receipts.length) {
        for (const proof of receipts) assert.equal(proof.sourceCommit, run.head_sha, 'Historical receipt belongs to another source');
        assert.equal(new Set(receipts.map(proof => proof.version)).size, 1, 'Historical release versions conflict');
        identity = { source: run.head_sha, version: receipts[0].version };
      } else if (run.event === 'push' && /^v\d+\.\d+\.\d+$/.test(run.head_branch ?? '')) {
        const version = run.head_branch.slice(1);
        assert.equal(await client.tagSource(version), run.head_sha, 'Historical release tag changed source');
        identity = { source: run.head_sha, version };
      }
    }
    assert.ok(identity, 'Historical release identity proof unavailable or expired');
    assert.equal(identity.source, run.head_sha, 'Historical inventory belongs to another source');
    remember(run.id, identity.source, identity.version);
    runs.push({ ...run, releaseVersion: identity.version, gateExecuted: executed });
  }
  // Trusted identity is retained independently. Missing attempt evidence stays
  // unexplained; candidate qualification still requires every original receipt.
  const cohorts = new Map();
  for (const run of runs) {
    const key = `${run.releaseVersion}:${run.head_sha}`;
    const cohort = cohorts.get(key) ?? { version: run.releaseVersion, source: run.head_sha, runs: [] };
    cohort.runs.push(run.id); cohorts.set(key, cohort);
  }
  return { runs, jobsByRun, inventory: [...cohorts.values()], complete: true, requestCount: client.requestCount ?? null };
}
export function assertPriorGateAttempts(jobs, receipts, identity) {
  for (const job of jobs.filter(job => isExecutedReleaseGateJob(job, receipts) && ['failure', 'timed_out', 'cancelled'].includes(job.conclusion))) {
    const matches = receipts.filter(row => row.jobID === job.id && row.runAttempt === job.run_attempt);
    assert.equal(matches.length, 1, 'Every earlier product or evidence failure requires its original receipt');
    const receipt = matches[0];
    assert.ok(receipt && receipt.sourceCommit === identity.source && receipt.dmgSha256 === identity.dmgSha256
      && (identity.version === undefined || receipt.version === identity.version)
      && (identity.runID === undefined || receipt.runID === String(identity.runID)) && receipt.outcome === 'failed'
      && receipt.failureClass === 'pre_app_gui_unavailable' && receipt.appStarted === false
      && receipt.fixtureAttempts === 0 && receipt.safeCleanup === true && Array.isArray(receipt.cleanupErrors) && receipt.cleanupErrors.length === 0,
    'An earlier product, evidence or cleanup failure requires investigation and a source correction');
  }
}
/** Rolling history excludes this run; its earlier attempts still fence work. */
export async function assertCurrentReleaseGateAttempt({ root, client, identity, currentRunID, currentRunAttempt }) {
  const attempt = Number(currentRunAttempt);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1, 'Current release attempt required');
  if (attempt === 1) return;
  const jobs = await client.pages(`/actions/runs/${currentRunID}/jobs?filter=all`, 'jobs');
  for (const job of jobs.filter(job => isExecutedReleaseGateJob(job))) assert.ok(Number.isSafeInteger(job.run_attempt) && job.run_attempt >= 1, 'Complete current-run attempt inventory required');
  const receipts = await readReleaseGateReceipts(root, client, currentRunID);
  const failed = jobs.filter(job => isExecutedReleaseGateJob(job, receipts) && job.run_attempt < attempt && ['failure', 'timed_out', 'cancelled'].includes(job.conclusion));
  const artifacts = await client.pages(`/actions/runs/${currentRunID}/artifacts`, 'artifacts');
  const refuseRestart = () => { throw Object.assign(Error('Release admission and candidate bytes are already retained. Rerun only failed gate jobs; whole-workflow retries are unsupported.'),
    { code: 'release_retry_failed_gate_jobs_only' }); };
  if (!failed.length) {
    if (artifacts.some(row => ['DevRyan-release-admission', 'DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-packaging'].includes(row.name))) refuseRestart();
    return;
  }
  for (const name of ['DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-packaging']) {
    const matches = artifacts.filter(row => row.name === name);
    assert.equal(matches.length, 1, 'Current-run retained candidate identity required');
    assert.equal(matches[0].expired, false, 'Current-run retained candidate expired; rebuilding is forbidden');
  }
  const artifact = artifacts.find(row => row.name === 'DevRyan-macos-arm64-packaging');
  const metadata = client.readCandidateProof ? await client.readCandidateProof(artifact)
    : await (client.readArtifactReceipt ?? readArtifactReceipt)(root, artifact, { member: 'candidate.json' });
  assert.equal(metadata.protocol, 'devryan.release-candidate/1');
  assert.equal(metadata.sourceCommit, identity.source); assert.equal(metadata.version, identity.version);
  assert.equal(metadata.lockfile, identity.lockfile); assert.match(metadata.dmgSha256 ?? '', /^[a-f0-9]{64}$/);
  assertPriorGateAttempts(failed, receipts, { source: identity.source, dmgSha256: metadata.dmgSha256 });
  const run = { id: Number(currentRunID), head_sha: identity.source, releaseVersion: identity.version };
  for (const job of failed) assert.ok(isExplainedReleaseGuiFailure(job, receipts, run), 'Current-run product, evidence or cleanup failures cannot retry');
  // The first admission/build artifacts are immutable. Re-running this owner
  // means the successful admission job was selected too; rebuilding/re-uploading
  // would either conflict or replace the measured candidate. Retry only gates.
  refuseRestart();
}
/** A verified published no-op may reuse this run's immutable admission file. */
export async function hasRetainedRunAdmission({ root, client, admission, runID }) {
  const artifacts = await client.pages(`/actions/runs/${runID}/artifacts`, 'artifacts');
  const matches = artifacts.filter(row => row.name === 'DevRyan-release-admission');
  assert.ok(matches.length <= 1, 'One immutable run admission required');
  if (!matches.length) return false;
  assert.equal(matches[0].expired, false, 'Original run admission expired');
  const proof = client.readAdmissionProof ? await client.readAdmissionProof(matches[0], { id: Number(runID), head_sha: admission.source })
    : await (client.readArtifactReceipt ?? readArtifactReceipt)(root, matches[0], { member: 'admission.json' });
  for (const key of ['source', 'version', 'scope', 'releaseID']) assert.equal(proof[key], admission[key], 'Original run admission changed');
  return true;
}
export function selectRollingReleaseGateRuns(runs) {
  assert.ok(Array.isArray(runs), 'Complete release workflow history required');
  const executed = runs.filter(run => run.gateExecuted !== false);
  const versions = new Set();
  for (const run of executed) {
    assert.ok(RELEASE_VERSION_PATTERN.test(run.releaseVersion ?? ''), 'Admitted historical version required');
    versions.add(run.releaseVersion);
    if (versions.size === 10) break;
  }
  // Include older failed attempts even when a later successful/no-op run of
  // that same version is its newest entry. Never truncate before grouping.
  return executed.filter(run => versions.has(run.releaseVersion));
}
export function rollingReleaseGateFailureCount(runs) {
  const stable = selectRollingReleaseGateRuns(runs);
  return stable.reduce((sum, row) => {
    const failures = row.unexplainedGateFailures ?? (row.unexplainedGateFailure === true ? 1 : 0);
    assert.ok(Number.isSafeInteger(failures) && failures >= 0, 'Historical gate failure count required');
    return sum + failures;
  }, 0);
}
export function assertRollingGateFailures(runs) {
  assert.ok(rollingReleaseGateFailureCount(runs) < 2,
    'Two unexplained gate failures in ten releases block the next tag');
}
export function isExplainedReleaseGuiFailure(job, receipts, run) {
  const matches = receipts.filter(row => row.jobID === job.id && row.runAttempt === job.run_attempt);
  if (matches.length !== 1) return false;
  const row = matches[0];
  return row.runID === String(run.id) && row.sourceCommit === run.head_sha && row.version === run.releaseVersion
    && /^[a-f0-9]{64}$/.test(row.dmgSha256 ?? '') && row.outcome === 'failed'
    && row.failureClass === 'pre_app_gui_unavailable' && row.appStarted === false
    && row.fixtureAttempts === 0 && row.safeCleanup === true && Array.isArray(row.cleanupErrors) && row.cleanupErrors.length === 0;
}
export function countUnexplainedReleaseGateFailures(jobs, receipts, run) {
  return jobs.filter(job => isExecutedReleaseGateJob(job, receipts) && ['failure', 'timed_out', 'cancelled'].includes(job.conclusion)
    && !isExplainedReleaseGuiFailure(job, receipts, run)).length;
}

/** Existing candidate resolver: one exact-source owner for ordinary and repaired admission. */
export async function resolveQualifiedReleaseCandidate({ root, client, identity, currentRunID, candidateRunID, after, candidateCompletion = false }) {
  const { freezeReleaseSmokeBudget } = await import('./qa/release-startup-smoke-contract.mjs');
  const { assertReleaseUpgradeRollbackReceipt } = await import('./qa/release-startup-upgrade-rollback.mjs');
  for (const run of await client.pages(`/actions/workflows/release.yml/runs?head_sha=${identity.source}`, 'workflow_runs')) {
    if (candidateRunID && String(run.id) !== String(candidateRunID)) continue;
    if ((candidateCompletion ? !['in_progress', 'completed'].includes(run.status) : run.status !== 'completed' || run.conclusion !== 'success' || run.id === Number(currentRunID)) || run.head_sha !== identity.source
      || run.head_repository?.full_name !== RELEASE_REPOSITORY || run.event !== 'workflow_dispatch') continue;
    if (after !== undefined) {
      assert.ok(Number.isFinite(after), 'Failure chronology proof required');
      if (!(Date.parse(run.created_at) > after)) continue;
    }
    const jobs = releaseGateExecutions(await client.pages(`/actions/runs/${run.id}/jobs?filter=all`, 'jobs'));
    const samples = [1, 2, 3].map(sample => jobs.filter(job => job.name === `candidate-startup-${sample}` && job.conclusion === 'success')
      .sort((left, right) => right.run_attempt - left.run_attempt)[0]);
    if (!samples.every(Boolean) || !jobs.some(job => job.name === 'candidate-upgrade-rollback' && job.conclusion === 'success')) continue;
    const artifacts = await client.pages(`/actions/runs/${run.id}/artifacts`, 'artifacts');
    assertRetainedCandidateArtifacts(artifacts, samples);
    const receipts = await readReleaseGateReceipts(root, client, run.id);
    const green = samples.map((job, index) => {
      const matches = receipts.filter(receipt => receipt.jobID === job.id && receipt.runAttempt === job.run_attempt && receipt.sample === index + 1
        && receipt.runID === String(run.id) && receipt.rehearsal === true);
      assert.equal(matches.length, 1, 'Three exact candidate job/attempt receipts required'); return matches[0];
    });
    const { admitReleaseSmokeAttempt } = await import('./qa/release-startup-smoke.mjs');
    for (const receipt of green) {
      const admitted = admitReleaseSmokeAttempt({ ...receipt }, jobs, receipts);
      assert.equal(receipt.runnerID, admitted.runnerID, 'Candidate hosted runner identity changed');
      assert.equal(receipt.qualificationAttempt, admitted.qualificationAttempt, 'Candidate qualification sequence changed');
    }
    const limits = freezeReleaseSmokeBudget(green, { sourceCommit: identity.source, version: identity.version });
    const metadataArtifact = artifacts.find(row => row.name === 'DevRyan-macos-arm64-packaging');
    const metadata = client.readCandidateProof ? await client.readCandidateProof(metadataArtifact, run)
      : await (client.readArtifactReceipt ?? readArtifactReceipt)(root, metadataArtifact, { member: 'candidate.json' });
    assert.equal(metadata.protocol, 'devryan.release-candidate/1');
    assert.equal(metadata.sourceCommit, identity.source); assert.equal(metadata.version, identity.version);
    assert.equal(metadata.lockfile, identity.lockfile);
    assert.equal(metadata.dmgSha256, green[0].dmgSha256, 'Candidate metadata and measured installer differ');
    assertPriorGateAttempts(jobs, receipts, { source: identity.source, dmgSha256: metadata.dmgSha256 });
    const upgradeArtifact = artifacts.find(row => row.name === 'DevRyan-upgrade-rollback');
    const upgrade = client.readUpgradeProof ? await client.readUpgradeProof(upgradeArtifact, run)
      : await (client.readArtifactReceipt ?? readArtifactReceipt)(root, upgradeArtifact, { member: 'upgrade-rollback.json' });
    assertReleaseUpgradeRollbackReceipt(upgrade, metadata);
    assert.equal(upgrade.manifestSha256, green[0].manifestSha256, 'Upgrade and startup used different candidate manifests');
    return { run, samples, limits };
  }
  throw Error('Three green rehearsals of the exact intended tag SHA after any unresolved gate failures are required');
}

export async function requireReleaseGateWriteAdmission({ root, client, runs, candidate, identity, currentRunID }) {
  if (candidate || rollingReleaseGateFailureCount(runs) < 2) return null;
  const failed = selectRollingReleaseGateRuns(runs).filter(run => run.unexplainedGateFailures > 0 || run.unexplainedGateFailure === true);
  assert.ok(failed.every(run => Number.isFinite(run.unexplainedGateCompletedAt)), 'Failure chronology proof required');
  return resolveQualifiedReleaseCandidate({ root, client, identity, currentRunID, after: Math.max(...failed.map(run => run.unexplainedGateCompletedAt)) });
}
export async function admitRelease({ source, version, scope, notes = '', candidate = false, environment = process.env, client = githubReleaseClient(environment) }) {
  assert.ok(sha.test(source)); assert.ok(RELEASE_VERSION_PATTERN.test(version));
  assert.ok(['desktop-macos-arm64', 'full'].includes(scope));
  if (candidate) assert.ok(environment.RELEASE_CANDIDATE === 'true' && environment.RELEASE_DRY_RUN === 'true', 'Candidate admission must be read only');
  const direct = await client.request(`/releases/tags/v${version}`, { notFound: true });
  const matching = direct ? [direct] : (await client.pages('/releases')).filter(row => row.tag_name === `v${version}`);
  assert.ok(matching.length <= 1, 'Duplicate release identities for one version');
  const found = matching[0];
  await client.frozenTag(version, source, { optional: candidate });
  if (found?.draft === false) {
    await verifyPublishedFinalization(found, { source, version, scope }, client);
    return { source, version, scope, releaseID: found.id, candidate, publishedNoop: true };
  }
  if (found) assertAdmittedRelease(found, { source, version, scope });
  if (candidate || environment.RELEASE_DRY_RUN === 'true') return { source, version, scope, releaseID: found?.id ?? null, candidate };
  assertStableReleaseWritesAllowed(environment);
  if (found) return { source, version, scope, releaseID: found.id, candidate: false };
  const admitted = { protocol: 'devryan.release-admission/1', source, version, scope, run: Number(environment.GITHUB_RUN_ID) };
  assert.match(String(admitted.run), /^[1-9][0-9]*$/);
  const created = await client.request('/releases', { method: 'POST', body: { tag_name: `v${version}`, target_commitish: source,
    name: `DevRyan v${version}`, draft: true, prerelease: false, body: admissionBody(notes, admitted) } });
  assertAdmittedRelease(created, { source, version, scope });
  return { source, version, scope, releaseID: created.id, candidate: false };
}
export async function verifyPublishedFinalization(release, identity, client, { updaterDiscovery } = {}) {
  const admission = assertAdmittedRelease(release, identity, { draft: false });
  assert.equal(release.draft, false);
  const proof = admission.finalized;
  assert.equal(proof?.releaseID, release.id); assert.equal(proof?.source, identity.source);
  assert.equal(proof?.deployment, 'verified'); assert.match(String(proof?.run), /^[1-9][0-9]*$/);
  assert.match(String(proof?.attempt), /^[1-9][0-9]*$/);
  const run = await client.request(`/actions/runs/${proof.run}/attempts/${proof.attempt}`);
  assert.equal(run.head_sha, identity.source); assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.head_repository?.full_name, RELEASE_REPOSITORY);
  assert.ok(['success', 'failure'].includes(run.conclusion));
  const jobs = await client.pages(`/actions/runs/${proof.run}/attempts/${proof.attempt}/jobs`, 'jobs');
  const retained = client.readFinalizationProof ? await client.readFinalizationProof(proof) : await readFinalizationProof(client, proof);
  const discoveryPending = retained?.updaterDiscovery === 'pending';
  const finalize = jobs.filter(job => job.name === 'finalize-release' && (job.conclusion === 'success' || discoveryPending && job.conclusion === 'failure'));
  assert.equal(finalize.length, 1);
  for (const name of ['Deploy and verify Supabase configuration and migrations', 'Publish release']) {
    assert.equal(finalize[0].steps.filter(step => step.name === name && (step.conclusion === 'success'
      || discoveryPending && name === 'Publish release' && step.conclusion === 'failure')).length, 1,
      'Published no-op requires original deployment and finalization proof');
  }
  assert.ok(run.conclusion === 'success' || discoveryPending, 'Original successful finalization or retained pending discovery required');
  assert.equal(retained.protocol, 'devryan.release-finalization/1'); assert.equal(retained.status, 'published');
  assert.deepEqual(retained.identity, { source: identity.source, version: identity.version, scope: identity.scope, releaseID: release.id });
  assert.deepEqual(retained.finalized, proof, 'Published marker differs from original release ID, deployment and asset proof');
  const assets = await client.pages(`/releases/${release.id}/assets`);
  assert.deepEqual(verifyReleaseAssets(assets, { version: identity.version, scope: identity.scope, digests: new Map(Object.entries(proof.digests)) }), []);
  await assertPublishedUpdaterDiscovery({ ...release, assets }, identity, proof.updater);
  if (discoveryPending) {
    await waitPublishedUpdaterDiscovery(client, { ...identity, releaseID: release.id }, proof.updater, { ...updaterDiscovery, allowNewer: true });
    return proof;
  }
  const latest = await client.request('/releases/latest');
  if (!isNewerPublishedRelease(latest, { ...identity, releaseID: release.id })) {
    assert.equal(latest.id, release.id, 'Latest release ID changed'); await assertPublishedUpdaterDiscovery(latest, identity, proof.updater);
  }
  return proof;
}
function isNewerPublishedRelease(latest, identity) {
  const parts = value => value.replace(/^v/, '').split('.').map(Number);
  assert.equal(latest.draft, false); assert.equal(latest.prerelease, false);
  assert.ok(Number.isSafeInteger(latest.id) && latest.id > 0, 'Latest release identity required');
  const newer = RELEASE_VERSION_PATTERN.test((latest.tag_name ?? '').replace(/^v/, ''))
    && parts(latest.tag_name).some((value, index, values) => value > parts(identity.version)[index]
      && values.slice(0, index).every((prior, priorIndex) => prior === parts(identity.version)[priorIndex]));
  if (newer) assert.notEqual(latest.id, identity.releaseID, 'A newer release must have another original release ID');
  return newer;
}
export async function assertPublishedUpdaterDiscovery(payload, identity, expected) {
  const { discoverDesktopUpdate } = await import('../packages/electron/desktop-updater.mjs');
  const update = discoverDesktopUpdate(payload, { currentVersion: '0.0.0', platform: 'darwin', arch: 'arm64' });
  assert.ok(update, 'Published updater discovery required');
  const proof = { version: update.version, name: update.name, sha256: update.sha256, size: update.size, url: update.url };
  assert.equal(proof.version, identity.version, 'Updater discovered another release');
  assert.deepEqual(proof, expected, 'Updater discovery differs from admitted installer bytes');
  return proof;
}
export async function finalizeRelease({ identity, directory, deploymentVerified = false, environment = process.env, client = githubReleaseClient(environment), beforePromote, retainFinalization, updaterDiscovery }) {
  assert.ok(Number.isSafeInteger(identity.releaseID) && identity.releaseID > 0, 'Admitted release ID required');
  assert.ok(sha.test(identity.source));
  assert.match(environment.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  const staged = await describeDirectoryAssets(directory);
  const digests = new Map(staged.map(row => [row.name, row.digest?.slice(7)]));
  const verify = assets => assert.deepEqual(verifyReleaseAssets(assets, { version: identity.version, scope: identity.scope, digests }), []);
  verify(staged);
  await client.frozenTag(identity.version, identity.source);
  let release = await client.request(`/releases/${identity.releaseID}`);
  const assets = () => client.pages(`/releases/${identity.releaseID}/assets`);
  if (!release.draft) { const proof = await verifyPublishedFinalization(release, identity, client);
    assert.deepEqual(proof.digests, Object.fromEntries(digests), 'Published bytes differ from original finalization');
    verify(await assets()); return { status: 'published-noop' }; }
  assertAdmittedRelease(release, identity);
  if (environment.RELEASE_DRY_RUN === 'true' || environment.RELEASE_CANDIDATE === 'true') return { status: 'read-only-verified' };
  assertStableReleaseWritesAllowed(environment);
  for (const local of staged) {
    await client.frozenTag(identity.version, identity.source);
    release = await client.request(`/releases/${identity.releaseID}`); assertAdmittedRelease(release, identity);
    const current = await assets();
    assert.ok(current.every(row => digests.has(row.name)), 'Unexpected draft assets');
    assert.equal(new Set(current.map(row => row.name)).size, current.length);
    for (const asset of current) assert.ok(asset.state === 'uploaded' && asset.digest === `sha256:${digests.get(asset.name)}`
      && asset.size === staged.find(row => row.name === asset.name).size, 'Conflicting asset bytes cannot be replaced');
    if (current.some(row => row.name === local.name)) continue;
    const bytes = await fs.readFile(path.join(directory, local.name));
    assert.equal(hash(bytes), local.digest.slice(7), 'Held release bytes changed before upload');
    const rechecked = (await describeDirectoryAssets(directory)).find(row => row.name === local.name);
    assert.deepEqual(rechecked, local, 'Staged release bytes changed before upload');
    assertStableReleaseWritesAllowed(environment);
    const response = await client.fetchImpl(`https://uploads.github.com/repos/${RELEASE_REPOSITORY}/releases/${identity.releaseID}/assets?name=${encodeURIComponent(local.name)}`,
      { method: 'POST', headers: { ...client.headers, 'content-type': 'application/octet-stream' }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(600_000) });
    assert.ok(response.ok, `Release asset upload failed (${response.status})`);
  }
  verify(await assets());
  await beforePromote?.();
  assert.equal(deploymentVerified, true, 'Verified deployment required before promotion');
  await client.frozenTag(identity.version, identity.source);
  release = await client.request(`/releases/${identity.releaseID}`);
  const admission = assertAdmittedRelease(release, identity);
  verify(await assets());
  const dmg = staged.find(row => row.name === `DevRyan-${identity.version}-arm64.dmg`);
  const updater = { version: identity.version, name: dmg.name, sha256: dmg.digest.slice(7), size: dmg.size,
    url: releaseAssetDownloadUrl('macos-arm64', identity.version) };
  const finalized = { run: Number(environment.GITHUB_RUN_ID), attempt: Number(environment.GITHUB_RUN_ATTEMPT), releaseID: release.id, source: identity.source, deployment: 'verified', digests: Object.fromEntries(digests), updater };
  assert.match(String(finalized.run), /^[1-9][0-9]*$/);
  await client.request(`/releases/${release.id}`, { method: 'PATCH', body: { body: admissionBody(release.body, { ...admission, finalized }), draft: false } });
  await client.frozenTag(identity.version, identity.source);
  release = await client.request(`/releases/${release.id}`);
  assertAdmittedRelease(release, identity, { draft: false }); assert.equal(release.draft, false); verify(await assets());
  const result = { status: 'published', finalized };
  await retainFinalization?.({ ...result, updaterDiscovery: 'pending' });
  await waitPublishedUpdaterDiscovery(client, identity, updater, updaterDiscovery);
  return result;
}

export function assertRetainedCandidateArtifacts(artifacts, samples) {
  const names = ['DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-packaging', 'DevRyan-upgrade-rollback',
    ...samples.map((job, index) => `DevRyan-startup-attempt-${job.run_attempt}-candidate-${index + 1}`)];
  for (const name of names) {
    const matches = artifacts.filter(row => row.name === name);
    assert.equal(matches.length, 1, 'Exact retained candidate artifacts required; rebuilding is forbidden');
    assert.equal(matches[0].expired, false, 'Candidate artifact expired; rebuilding is forbidden');
  }
}

/** Only read-only discovery retries after promotion; original publication proof survives feed lag. */
export async function waitPublishedUpdaterDiscovery(client, identity, expected, { attempts = 6, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => performance.now(), allowNewer = false } = {}) {
  assert.ok(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 6);
  const deadline = now() + 30_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const remaining = deadline - now();
      assert.ok(remaining > 0, 'Updater discovery interval expired');
      const payload = await client.request('/releases/latest', { signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))) });
      if (allowNewer && isNewerPublishedRelease(payload, identity)) return expected;
      assert.equal(payload.id, identity.releaseID, 'Latest release ID changed');
      return await assertPublishedUpdaterDiscovery(payload, identity, expected);
    } catch (error) {
      if (attempt === attempts || now() + 2_000 >= deadline) throw error;
      await wait(2_000);
    }
  }
}
