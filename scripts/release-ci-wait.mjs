import { githubClient } from './release.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function waitForTrustedCI({ environment = process.env, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), request, timeoutMs = 900_000, log = console.log } = {}) {
  if (environment.GITHUB_REPOSITORY !== '1H-Team/DevRyan' || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '')) throw new Error('Trusted CI requires canonical source identity');
  const deadline = now() + timeoutMs;
  const client = request ?? githubClient({ token: environment.GITHUB_TOKEN,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - now()))) }) }).request;
  while (now() < deadline) {
    const { workflow_runs: runs = [] } = await client('GET', `/actions/workflows/ci.yml/runs?head_sha=${environment.GITHUB_SHA}&event=push&branch=main&per_page=100`);
    const run = runs.filter(row => row.path === '.github/workflows/ci.yml' && row.head_sha === environment.GITHUB_SHA
      && row.head_branch === 'main' && row.event === 'push' && row.repository?.full_name === '1H-Team/DevRyan').sort((a, b) => b.id - a.id)[0];
    if (now() >= deadline) break;
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Canonical CI ${run.id} ${run.conclusion}`);
      log(`Canonical CI ${run.id} passed for ${environment.GITHUB_SHA}.`);
      return run;
    }
    await wait(Math.min(10_000, Math.max(0, deadline - now())));
  }
  throw new Error('Canonical CI registration/completion deadline expired after 15 minutes');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await waitForTrustedCI();
}
