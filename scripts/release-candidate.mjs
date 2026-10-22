import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { githubClient } from './release-github.mjs';
import { withMountedDmg } from './qa/mounted-dmg.mjs';

export const CANDIDATE_ARTIFACT = 'DevRyan-macos-arm64-release';
export const CANDIDATE_IDENTITY_ARTIFACT = 'DevRyan-macos-arm64-candidate-identity';
export const RELEASE_MANIFEST = 'release-manifest.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);

export function candidateIdentity(environment = process.env) {
  const { GITHUB_SHA: revision, GITHUB_RUN_ID: runID, GITHUB_RUN_ATTEMPT: attempt, VERSION: version } = environment;
  if (!/^[a-f0-9]{40}$/.test(revision ?? '') || !/^\d+$/.test(runID ?? '') || !/^\d+$/.test(attempt ?? '')
    || !/^\d+\.\d+\.\d+$/.test(version ?? '') || environment.GITHUB_REPOSITORY !== '1H-Team/DevRyan') throw new Error('Invalid candidate run identity');
  return { revision, runID, attempt, version };
}

export async function describeCandidate(directory, identity) {
  const name = `DevRyan-${identity.version}-arm64.dmg`;
  const bytes = await fs.readFile(path.join(directory, name));
  return { ...identity, name, size: bytes.length, sha256: sha256(bytes) };
}

export async function verifyCandidate(directory, identity) {
  const expected = await describeCandidate(directory, identity);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'candidate.json'), 'utf8'));
  if (Object.entries(expected).some(([key, value]) => metadata[key] !== value)) throw new Error('Candidate identity or digest mismatch');
  return path.join(directory, expected.name);
}

/** The identity fields of a packaged app's Info.plist (as JSON). */
export function appBundleIdentity(info) {
  const identity = { bundleId: info?.CFBundleIdentifier, shortVersion: info?.CFBundleShortVersionString, executable: info?.CFBundleExecutable };
  const missing = Object.entries(identity).filter(([, value]) => typeof value !== 'string' || !value).map(([key]) => key);
  if (missing.length) throw new Error(`Packaged Info.plist lacks ${missing.join(', ')}`);
  return identity;
}

const MANIFEST_KEYS = Object.freeze(['schema', 'version', 'sourceSha', 'runId', 'runAttempt', 'name', 'size', 'sha256',
  'bundleId', 'shortVersion', 'executable', 'arch', 'signingMode', 'runtimeManifestSha256']);

/**
 * The release manifest: what was built, from which source and run, and what the
 * packaged app claims to be. Deterministic: the same inputs give the same bytes.
 */
export function releaseManifest({ candidate, bundle, arch, signingMode, runtimeManifestSha256 }) {
  if (bundle.shortVersion !== candidate.version) throw new Error(`Packaged version ${bundle.shortVersion} does not match ${candidate.version}`);
  if (bundle.executable !== 'DevRyan') throw new Error(`Packaged executable is ${bundle.executable}, not DevRyan`);
  if (arch !== 'arm64') throw new Error(`Packaged architecture is ${arch}, not arm64`);
  if (!['adhoc', 'developer-id'].includes(signingMode)) throw new Error(`Unknown signing mode ${signingMode}`);
  if (!/^[a-f0-9]{64}$/.test(runtimeManifestSha256 ?? '') || !/^[a-f0-9]{64}$/.test(candidate.sha256 ?? '')) throw new Error('Manifest digests must be sha256 hex');
  return { schema: 1, version: candidate.version, sourceSha: candidate.revision, runId: candidate.runID, runAttempt: candidate.attempt,
    name: candidate.name, size: candidate.size, sha256: candidate.sha256, bundleId: bundle.bundleId, shortVersion: bundle.shortVersion,
    executable: bundle.executable, arch, signingMode, runtimeManifestSha256 };
}

export const serializeReleaseManifest = manifest => `${JSON.stringify(Object.fromEntries(MANIFEST_KEYS.map(key => [key, manifest[key]])), null, 2)}\n`;

/** A manifest file, checked for shape and for this version and source. */
export async function readReleaseManifest(file, { version, sourceSha } = {}) {
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  if (manifest?.schema !== 1 || Object.keys(manifest).sort().join() !== [...MANIFEST_KEYS].sort().join()
    || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size <= 0) throw new Error(`${file} is not a release manifest`);
  if (version && manifest.version !== version) throw new Error(`Release manifest is for ${manifest.version}, not ${version}`);
  if (sourceSha && manifest.sourceSha !== sourceSha) throw new Error(`Release manifest was built from ${manifest.sourceSha}, not ${sourceSha}`);
  return manifest;
}

/** Identity, signing, architecture and runtime manifest digest of the app at the DMG root (macOS). */
export async function inspectPackagedApp(app, { run = execute } = {}) {
  const info = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { timeout: 30_000 })).stdout);
  const bundle = appBundleIdentity(info);
  const signature = await run('/usr/bin/codesign', ['-dv', '--verbose=2', app], { timeout: 60_000 });
  const details = `${signature.stdout}\n${signature.stderr}`;
  const signingMode = /^Signature=adhoc$/m.test(details) ? 'adhoc' : /^Authority=Developer ID Application:/m.test(details) ? 'developer-id' : 'unknown';
  const arch = (await run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/MacOS', bundle.executable)], { timeout: 30_000 })).stdout.trim();
  const runtimeManifestSha256 = sha256(await fs.readFile(path.join(app, 'Contents/Resources/revert-runtime/darwin-arm64/native-bundle.json')));
  return { bundle, signingMode, arch, runtimeManifestSha256 };
}

async function writeCandidateFiles(directory, environment) {
  const candidate = await describeCandidate(directory, candidateIdentity(environment));
  await fs.writeFile(path.join(directory, 'candidate.json'), `${JSON.stringify(candidate)}\n`);
  const mount = await fs.mkdtemp(path.join(environment.RUNNER_TEMP || os.tmpdir(), 'devryan-candidate-mount-'));
  try {
    const app = await withMountedDmg(path.join(directory, candidate.name), mount, () => inspectPackagedApp(path.join(mount, 'DevRyan.app')));
    await fs.writeFile(path.join(directory, RELEASE_MANIFEST), serializeReleaseManifest(releaseManifest({ candidate, ...app })));
  } finally { await fs.rm(mount, { recursive: true, force: true }); }
}

/**
 * The newest release.yml run of this repository at this exact source whose
 * DMG and identity artifacts are still retained, or '' when the source has
 * never been packaged. Any event qualifies: the build depends only on the SHA.
 */
export async function findReusableCandidate({ environment = process.env, client } = {}) {
  const source = environment.GITHUB_SHA, repository = environment.GITHUB_REPOSITORY;
  if (!/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('Build reuse requires the exact source SHA');
  const github = client ?? githubClient({ token: environment.GITHUB_TOKEN ?? environment.GH_TOKEN, repository, environment });
  const runs = (await github.paginate(`/actions/workflows/release.yml/runs?head_sha=${source}`, { key: 'workflow_runs', maxPages: 5 }))
    .filter(run => run.path === '.github/workflows/release.yml' && run.head_sha === source && run.repository?.full_name === repository)
    .sort((left, right) => right.id - left.id);
  for (const run of runs) {
    const artifacts = await github.paginate(`/actions/runs/${run.id}/artifacts`, { key: 'artifacts', maxPages: 5 });
    const retained = name => artifacts.some(row => row.name === name && row.expired === false
      && String(row.workflow_run?.id) === String(run.id) && row.workflow_run?.head_sha === source);
    if (retained(CANDIDATE_ARTIFACT) && retained(CANDIDATE_IDENTITY_ARTIFACT)) return String(run.id);
  }
  return '';
}

/**
 * Adopt the DMG built by `producerRunId` at this source: verify its bytes
 * against the producer's own identity and manifest, then bind them to this
 * run (candidate.json gains `builtBy`; the manifest keeps the producer).
 */
export async function adoptCandidate(producerRunId, directory, { environment = process.env, download } = {}) {
  if (!/^\d+$/.test(producerRunId ?? '')) throw new Error('Producer run ID required');
  const identity = candidateIdentity(environment);
  await fs.mkdir(directory, { recursive: true });
  const fetchArtifact = download ?? (name => execute('gh', ['run', 'download', producerRunId, '--repo', environment.GITHUB_REPOSITORY, '--name', name, '--dir', directory], { timeout: 600_000 }));
  for (const name of [CANDIDATE_ARTIFACT, CANDIDATE_IDENTITY_ARTIFACT]) await fetchArtifact(name);
  const original = JSON.parse(await fs.readFile(path.join(directory, 'candidate.json'), 'utf8'));
  if (original.revision !== identity.revision || original.version !== identity.version || original.runID !== producerRunId) throw new Error('Reused candidate belongs to another source, version or run');
  await verifyCandidate(directory, { revision: original.revision, runID: original.runID, attempt: original.attempt, version: original.version });
  const manifest = await readReleaseManifest(path.join(directory, RELEASE_MANIFEST), { version: identity.version, sourceSha: identity.revision });
  if (manifest.sha256 !== original.sha256 || manifest.size !== original.size || manifest.runId !== original.runID) throw new Error('Reused manifest does not describe the reused DMG');
  const adopted = { ...await describeCandidate(directory, identity), builtBy: { runID: original.runID, attempt: original.attempt } };
  await fs.writeFile(path.join(directory, 'candidate.json'), `${JSON.stringify(adopted)}\n`);
  return adopted;
}

export async function waitForCandidate({ environment = process.env, request, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 900_000 } = {}) {
  const identity = candidateIdentity(environment);
  const deadline = now() + timeoutMs;
  const client = request ?? githubClient({ token: environment.GITHUB_TOKEN ?? environment.GH_TOKEN, environment,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(Math.max(1, deadline - now()))]) }) }).request;
  while (now() < deadline) {
    const run = await client('GET', `/actions/runs/${identity.runID}`);
    if (run.head_sha !== identity.revision || run.path !== '.github/workflows/release.yml'
      || run.repository?.full_name !== '1H-Team/DevRyan' || String(run.run_attempt) !== identity.attempt) throw new Error('Candidate producer identity changed');
    const jobs = [];
    for (let page = 1; now() < deadline; page++) {
      const response = await client('GET', `/actions/runs/${identity.runID}/jobs?filter=all&per_page=100&page=${page}`);
      jobs.push(...(response.jobs ?? []));
      if (jobs.length >= (response.total_count ?? jobs.length)) break;
    }
    const producer = jobs.filter(job => job.name === 'electron-package').sort((a, b) => b.id - a.id)[0];
    if (producer?.status === 'completed' && producer.conclusion !== 'success') throw new Error(`Candidate producer ${producer.conclusion}`);
    if (run.status === 'completed' && run.conclusion !== 'success') throw new Error(`Candidate run ${run.conclusion}`);
    const { artifacts = [] } = await client('GET', `/actions/runs/${identity.runID}/artifacts?per_page=100`);
    const artifact = artifacts.find(row => row.name === CANDIDATE_ARTIFACT && row.expired === false);
    const metadata = artifacts.find(row => row.name === CANDIDATE_IDENTITY_ARTIFACT && row.expired === false);
    // Wait for producer success so an uploaded artifact cannot bypass later checks.
    if (artifact && metadata && producer?.conclusion === 'success') {
      if ([artifact, metadata].some(row => String(row.workflow_run?.id) !== identity.runID || row.workflow_run?.head_sha !== identity.revision)) throw new Error('Candidate artifact belongs to another source/run');
      if (now() >= deadline) break;
      // GitHub copies successful jobs into retries with a new ID/attempt but unchanged execution times.
      const execution = producer.started_at && producer.completed_at
        ? jobs.filter(job => job.name === producer.name && job.conclusion === 'success'
          && job.started_at === producer.started_at && job.completed_at === producer.completed_at).sort((a, b) => a.id - b.id)[0]
        : producer;
      const producerAttempt = String(execution.run_attempt);
      if (!/^\d+$/.test(producerAttempt) || Number(producerAttempt) > Number(identity.attempt)) throw new Error('Invalid producer attempt');
      return { artifact, identity: { ...identity, attempt: producerAttempt } };
    }
    await wait(Math.min(5000, Math.max(0, deadline - now())));
  }
  throw new Error('Candidate producer deadline expired after 15 minutes');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'adopt') {
    const adopted = await adoptCandidate(args[0], path.resolve(args[1]));
    console.log(`Adopted ${adopted.name} (${adopted.size} bytes, sha256:${adopted.sha256}) built by run ${adopted.builtBy.runID} attempt ${adopted.builtBy.attempt}.`);
  } else if (command && !command.startsWith('-') && args.length === 0) {
    await writeCandidateFiles(path.resolve(command), process.env);
  } else {
    console.error('Usage: release-candidate.mjs <dist dir> | adopt <producer run ID> <dist dir>');
    process.exitCode = 2;
  }
}
