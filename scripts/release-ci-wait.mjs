import { githubClient } from './release-github.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Wait for the canonical main-push CI run at this exact SHA. A red result does
 * not end the wait: CI can be re-run (a new run_attempt of the same run, or a
 * newer run), so the newest run keeps being polled until it passes or the
 * deadline expires, and the log says what to re-run.
 */
export async function waitForTrustedCI({ environment = process.env, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), request, timeoutMs = 1_500_000, log = console.log } = {}) {
  if (environment.GITHUB_REPOSITORY !== '1H-Team/DevRyan' || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '')) throw new Error('Trusted CI requires canonical source identity');
  const deadline = now() + timeoutMs;
  const minutes = Math.round(timeoutMs / 60_000);
  const client = request ?? githubClient({ token: environment.GITHUB_TOKEN, environment,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(Math.max(1, deadline - now()))]) }) }).request;
  let red = null;
  while (now() < deadline) {
    const { workflow_runs: runs = [] } = await client('GET', `/actions/workflows/ci.yml/runs?head_sha=${environment.GITHUB_SHA}&event=push&branch=main&per_page=100`);
    const run = runs.filter(row => row.path === '.github/workflows/ci.yml' && row.head_sha === environment.GITHUB_SHA
      && row.head_branch === 'main' && row.event === 'push' && row.repository?.full_name === '1H-Team/DevRyan').sort((a, b) => b.id - a.id)[0];
    if (now() >= deadline) break;
    if (run?.status === 'completed' && run.conclusion === 'success') {
      log(`Canonical CI ${run.id} attempt ${run.run_attempt ?? 1} passed for ${environment.GITHUB_SHA}.`);
      return run;
    }
    if (run?.status === 'completed') {
      const seen = `${run.id}/${run.run_attempt ?? 1}`;
      if (red?.seen !== seen) {
        red = { seen, run };
        log(`Canonical CI ${run.id} attempt ${run.run_attempt ?? 1} concluded ${run.conclusion}. Re-run it (gh run rerun ${run.id} --failed${run.html_url ? `, ${run.html_url}` : ''}); this job keeps waiting until the ${minutes}-minute deadline.`);
      }
    } else if (red && run) {
      log(`Canonical CI ${run.id} attempt ${run.run_attempt ?? 1} is ${run.status}; waiting for the re-run.`);
      red = null;
    }
    await wait(Math.min(10_000, Math.max(0, deadline - now())));
  }
  if (red) {
    throw new Error(`Canonical CI ${red.run.id} attempt ${red.run.run_attempt ?? 1} ${red.run.conclusion} and was not re-run to success within ${minutes} minutes. Re-run CI (gh run rerun ${red.run.id} --failed), then re-run this release job; do not move the tag for a flaky test.`);
  }
  throw new Error(`Canonical CI registration/completion deadline expired after ${minutes} minutes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await waitForTrustedCI();
}
