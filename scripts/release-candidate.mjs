import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { githubClient } from './release.mjs';

export const CANDIDATE_ARTIFACT = 'DevRyan-macos-arm64-release';
export const CANDIDATE_IDENTITY_ARTIFACT = 'DevRyan-macos-arm64-candidate-identity';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

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

export async function waitForCandidate({ environment = process.env, request, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 900_000 } = {}) {
  const identity = candidateIdentity(environment);
  const deadline = now() + timeoutMs;
  const client = request ?? githubClient({ token: environment.GITHUB_TOKEN ?? environment.GH_TOKEN,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - now()))) }) }).request;
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
      const producerAttempt = String(producer.run_attempt);
      if (!/^\d+$/.test(producerAttempt) || Number(producerAttempt) > Number(identity.attempt)) throw new Error('Invalid producer attempt');
      return { artifact, identity: { ...identity, attempt: producerAttempt } };
    }
    await wait(Math.min(5000, Math.max(0, deadline - now())));
  }
  throw new Error('Candidate producer deadline expired after 15 minutes');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2]);
  const metadata = await describeCandidate(directory, candidateIdentity());
  await fs.writeFile(path.join(directory, 'candidate.json'), `${JSON.stringify(metadata)}\n`);
}
