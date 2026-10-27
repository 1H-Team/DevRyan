#!/usr/bin/env node
// Read-only release status: `bun run release:status vX.Y.Z`.
//
// Prints the same-version state (scripts/release-state.mjs), the ledger tag,
// the release with its draft and asset, the retained release artifacts, the
// main CI and release runs at the tag's commit, and the single correct next
// action (rerun failed jobs, rerun CI, rerun post-publish-verify, push or move
// the tag, or bump the version). It never writes: it uses GITHUB_TOKEN,
// GH_TOKEN or `gh auth token` only to read (drafts are visible only to a
// writer's token), and runs anonymously without one.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, releaseAssetName } from '../packages/electron/release-assets.mjs';
import { githubClient } from './release-github.mjs';
import { ledgerTagName, parseReleaseMarker, releaseState } from './release-state.mjs';
import { readLedger } from './release-verify-public.mjs';

const execute = promisify(execFile);
/** The first release with a ledger; earlier published versions legitimately have none. */
export const FIRST_LEDGER_VERSION = '2.1.10';

const compare = (left, right) => {
  for (let index = 0; index < 3; index++) {
    const delta = Number(left.split('.')[index]) - Number(right.split('.')[index]);
    if (delta) return Math.sign(delta);
  }
  return 0;
};
const nextPatch = version => version.replace(/\d+$/, patch => String(Number(patch) + 1));

async function tagCommit(client, tag) {
  const ref = await client.request('GET', `/git/ref/tags/${tag}`, { allowNotFound: true });
  if (!ref) return null;
  return ref.object.type === 'tag' ? (await client.request('GET', `/git/tags/${ref.object.sha}`)).object.sha : ref.object.sha;
}

/** Everything the next action depends on, read from GitHub. */
export async function collectReleaseFacts({ version, client, authenticated }) {
  const tag = `v${version}`;
  const sha = await tagCommit(client, tag);
  const releases = (await client.paginate('/releases')).filter(row => row.tag_name === tag);
  const ledger = await readLedger(client, version);
  const latest = (await client.request('GET', '/releases/latest', { allowNotFound: true }))?.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1] ?? null;
  const facts = { version, tag, sha, releases, ledger, latest, authenticated, ci: null, run: null, jobs: [], artifacts: [], writer: null };
  facts.state = releaseState({ version, releases, ledger, source: sha ?? '0'.repeat(40) });
  if (!sha) return facts;
  const ciRuns = (await client.request('GET', `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`)).workflow_runs ?? [];
  facts.ci = ciRuns.filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push').sort((a, b) => b.id - a.id)[0] ?? null;
  const releaseRuns = (await client.paginate(`/actions/workflows/release.yml/runs?head_sha=${sha}&event=push`, { key: 'workflow_runs' }))
    .filter(run => run.head_sha === sha && run.head_branch === tag && run.event === 'push').sort((a, b) => b.id - a.id);
  facts.run = releaseRuns[0] ?? null;
  if (facts.run) {
    facts.jobs = await client.paginate(`/actions/runs/${facts.run.id}/jobs?filter=latest`, { key: 'jobs' });
    facts.artifacts = (await client.request('GET', `/actions/runs/${facts.run.id}/artifacts?per_page=100`)).artifacts ?? [];
  }
  if (facts.state.action === 'verify-published' && !ledger && compare(version, FIRST_LEDGER_VERSION) >= 0) {
    const marker = parseReleaseMarker(facts.state.release.body);
    const original = marker?.version === version && marker.source === sha ? releaseRuns.find(run => String(run.id) === marker.runId) : undefined;
    if (original) {
      // A whole-workflow rerun skips publication; retain the original writer across attempts.
      const jobs = await client.paginate(`/actions/runs/${original.id}/jobs?filter=all`, { key: 'jobs' });
      const writer = jobs.filter(row => row.name === 'release' && row.status === 'completed' && row.conclusion !== 'skipped')
        .sort((left, right) => right.id - left.id)[0];
      facts.writer = { run: original, job: writer ?? null };
    }
  }
  return facts;
}

const job = (facts, name) => facts.jobs.find(row => row.name === name);
const failedJob = row => row && row.status === 'completed' && ['failure', 'cancelled', 'timed_out'].includes(row.conclusion);

/** The single correct next action for these facts. */
export function nextAction(facts) {
  const { version, tag, state, ledger, latest, run, ci } = facts;
  const bump = reason => ({ action: 'bump-version', reason, command: `node scripts/bump-version.mjs ${nextPatch(version)}` });
  if (state.action === 'refuse') return bump(state.message);
  if (state.action === 'verify-published') {
    const verify = [job(facts, 'verify-published'), job(facts, 'post-publish-verify')].find(row => row && row.conclusion !== 'skipped');
    if (!ledger && compare(version, FIRST_LEDGER_VERSION) >= 0) {
      if (run && run.status !== 'completed') return { action: 'wait', reason: `${tag} is published; the release run is still recording or checking its ledger`, command: `gh run watch ${run.id}` };
      if (facts.writer?.run.status !== undefined && facts.writer.run.status !== 'completed') return { action: 'wait', reason: `${tag}'s original publication run is still active`, command: `gh run watch ${facts.writer.run.id}` };
      if (!facts.writer?.job) return { action: 'investigate', reason: `${tag} is published without its ledger; the original release writer could not be identified. A whole-workflow rerun cannot repair it`,
        command: `gh run list --workflow release.yml --branch ${tag}` };
      return { action: 'rerun-release', reason: `${tag} is published but ${ledgerTagName(version)} is missing; the release job only records it on a rerun`,
        command: `gh run rerun ${facts.writer.run.id} --job ${facts.writer.job.id}` };
    }
    if (run && verify && verify.status !== 'completed') return { action: 'wait', reason: `${verify.name} is running`, command: `gh run watch ${run.id}` };
    if (verify?.conclusion !== 'success') {
      return { action: 'rerun-post-publish-verify', reason: `${tag} is published${ledger ? ' (promotion and ledger recorded)' : ' (before the ledger existed)'}; verification is pending`,
        command: run && failedJob(verify) ? `gh run rerun ${run.id} --job ${verify.id}` : `node scripts/release-verify-public.mjs ${tag}`,
        alternative: run && failedJob(verify) ? `node scripts/release-verify-public.mjs ${tag}` : undefined };
    }
    const installed = job(facts, 'installed-public-upgrade-check');
    if (installed && installed.conclusion !== 'success') {
      if (installed.status !== 'completed') return { action: 'wait', reason: `${tag} is published; installed public upgrades are running`, command: `gh run watch ${run.id}` };
      return { action: failedJob(installed) ? 'rerun-installed-upgrades' : 'investigate',
        reason: `${tag} is published and discovery passed; installed public upgrade verification is ${installed.conclusion ?? 'pending'}`,
        command: failedJob(installed) ? `gh run rerun ${run.id} --job ${installed.id}` : `gh run view ${run.id}` };
    }
    return { action: 'done', reason: `${tag} is published${ledger ? ' and recorded in the ledger' : ' (before the ledger existed)'}${verify?.conclusion === 'success' ? '; post-publish verification passed' : ''}`,
      command: `node scripts/release-verify-public.mjs ${tag}` };
  }
  if (latest && compare(latest, version) > 0) return bump(`v${latest} is already latest; ${tag} can no longer be published`);
  // release:tag pushes the tag only after main CI and a dry run passed at the commit.
  if (!facts.sha) return { action: 'push-tag', reason: `${tag} does not exist`, command: 'bun run release:tag' };
  const ciFailed = ci?.status === 'completed' && ci.conclusion !== 'success';
  if (!run) {
    return { action: 'investigate', reason: `no release run exists for ${tag} at ${facts.sha.slice(0, 12)}; check that the tag push reached GitHub`,
      command: `gh run list --workflow release.yml --branch ${tag}` };
  }
  if (run.status !== 'completed') {
    if (ciFailed) return { action: 'rerun-ci', reason: `main CI run ${ci.id} at ${facts.sha.slice(0, 12)} is ${ci.conclusion}; the waiting trusted-ci job picks up the re-run`, command: `gh run rerun ${ci.id} --failed` };
    return { action: 'wait', reason: `release run ${run.id} is ${run.status}`, command: `gh run watch ${run.id}` };
  }
  if (run.conclusion === 'success') {
    return { action: 'investigate', reason: `release run ${run.id} succeeded but ${tag} is not published (${state.action})`, command: `gh run view ${run.id}` };
  }
  if (ciFailed) return { action: 'rerun-ci', reason: `main CI run ${ci.id} at ${facts.sha.slice(0, 12)} is ${ci.conclusion}; rerun it, then the release's failed jobs`, command: `gh run rerun ${ci.id} --failed`,
    then: `gh run rerun ${run.id} --failed` };
  const failed = facts.jobs.filter(failedJob).map(row => row.name);
  return { action: 'rerun-failed-jobs', reason: `release run ${run.id} ${run.conclusion}${failed.length ? ` in ${failed.join(', ')}` : ''}; a flaky or infrastructure failure reruns on the same version (move the tag only for a code fix)`,
    command: `gh run rerun ${run.id} --failed` };
}

export function formatStatus(facts, next) {
  const name = releaseAssetName('macos-arm64', facts.version);
  const lines = [`DevRyan ${facts.tag} release status (read-only${facts.authenticated ? '' : ', anonymous: drafts are not visible'})`];
  lines.push(`  tag          ${facts.sha ? `${facts.tag} -> ${facts.sha}` : 'missing'}`);
  lines.push(`  state        ${facts.state.action}${facts.state.reason ? ` (${facts.state.reason})` : ''}`);
  lines.push(`  ledger       ${facts.ledger ? `${ledgerTagName(facts.version)} sha256:${facts.ledger.sha256} ${facts.ledger.size} bytes, run ${facts.ledger.runId}/${facts.ledger.runAttempt}` : 'none'}`);
  lines.push(`  latest       ${facts.latest ? `v${facts.latest}` : 'none'}`);
  if (!facts.releases.length) lines.push('  release      none');
  for (const release of facts.releases) {
    const asset = release.assets?.find(row => row.name === name);
    lines.push(`  release      ${release.id} ${release.draft ? 'draft' : `published ${release.published_at ?? ''}`.trim()}${release.prerelease ? ' prerelease' : ''}, ${release.assets?.length ?? 0} asset(s); `
      + (asset ? `${asset.name} ${asset.state} ${asset.digest ?? 'no digest'} ${asset.size} bytes` : `no ${name}`));
  }
  lines.push(`  main CI      ${facts.ci ? `run ${facts.ci.id} ${facts.ci.status}/${facts.ci.conclusion ?? 'pending'}` : facts.sha ? 'no run at this commit' : '-'}`);
  lines.push(`  release run  ${facts.run ? `${facts.run.id} attempt ${facts.run.run_attempt ?? 1} ${facts.run.status}/${facts.run.conclusion ?? 'pending'}` : facts.sha ? 'none' : '-'}`);
  for (const row of facts.jobs) lines.push(`    ${row.name.padEnd(22)} ${row.status}/${row.conclusion ?? 'pending'}`);
  const retained = facts.artifacts.filter(row => !row.expired);
  lines.push(`  artifacts    ${retained.length ? retained.map(row => `${row.name}${row.expires_at ? ` (until ${row.expires_at.slice(0, 10)})` : ''}`).join(', ') : 'none retained'}`);
  lines.push('', `Next action: ${next.action} - ${next.reason}`, `  $ ${next.command}`);
  if (next.then) lines.push(`  then $ ${next.then}`);
  if (next.alternative) lines.push(`  or   $ ${next.alternative}`);
  return lines.join('\n');
}

async function readToken(environment, run) {
  if (environment.GITHUB_TOKEN || environment.GH_TOKEN) return environment.GITHUB_TOKEN || environment.GH_TOKEN;
  return (await run('gh', ['auth', 'token'], { timeout: 10_000 }).catch(() => ({ stdout: '' }))).stdout.trim();
}

export async function main({ argv = process.argv.slice(2), environment = process.env, fetchImpl = fetch, run = execute, log = console.log } = {}) {
  const [tag, ...rest] = argv;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || rest.length) throw Object.assign(new Error('Usage: release-status.mjs vX.Y.Z'), { usage: true });
  const token = await readToken(environment, run);
  // Dry-run environment: the client refuses every write whatever the token allows.
  const client = githubClient({ token, anonymous: !token, repository: environment.GITHUB_REPOSITORY || RELEASE_REPOSITORY, fetchImpl, environment: { RELEASE_DRY_RUN: 'true' } });
  const facts = await collectReleaseFacts({ version: tag.slice(1), client, authenticated: Boolean(token) });
  const next = nextAction(facts);
  log(formatStatus(facts, next));
  return { facts, next };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = error.usage ? 2 : 1; });
}
