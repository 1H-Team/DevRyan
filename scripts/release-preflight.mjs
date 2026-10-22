#!/usr/bin/env node
// Release preflight: every check that can fail a release before anything is
// built, in one report. The `preflight` job runs it on every release run;
// locally `bun run release:preflight` runs the same checks (`--local-only`
// skips the ones that need GitHub).
//
//   versions, CHANGELOG, frozen lockfile    the commit is releasable
//   shipped discovery fixtures              the vendored updater copies are what their tags shipped
//   publication state, latest ordering      admit (scripts/release.mjs): same-version state and ledger
//   build reuse                             a retained DMG from an earlier run at this SHA
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY } from '../packages/electron/release-assets.mjs';
import { admit, checkVersions, findReleases, readLedger, releaseNotes, releaseVersion } from './release.mjs';
import { githubClient } from './release-github.mjs';
import { findReusableCandidate } from './release-candidate.mjs';
import { releaseState, shippedDiscoveryFixtureProblems } from './release-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

async function githubToken(environment, run) {
  if (environment.GITHUB_TOKEN || environment.GH_TOKEN) return environment.GITHUB_TOKEN || environment.GH_TOKEN;
  return (await run('gh', ['auth', 'token'], { timeout: 10_000 }).catch(() => ({ stdout: '' }))).stdout.trim();
}

export async function preflight({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, run = execute, log = console.log, localOnly = false } = {}) {
  const results = [];
  const check = async (name, operation) => {
    try {
      const detail = await operation();
      results.push({ name, passed: true, detail });
      log(`[preflight] pass ${name}${detail ? `: ${detail}` : ''}`);
      return detail;
    } catch (error) {
      results.push({ name, passed: false, detail: error.message });
      log(`[preflight] FAIL ${name}: ${error.message}`);
      return undefined;
    }
  };
  const version = await releaseVersion(repositoryRoot, environment);
  const source = environment.GITHUB_SHA || (await run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const env = { ...environment, GITHUB_SHA: source, GITHUB_REPOSITORY: environment.GITHUB_REPOSITORY || RELEASE_REPOSITORY };
  const output = { version, release_id: '', published: 'false', candidate_run_id: '', reuse_run_id: '' };
  await check('version files and bun.lock', () => checkVersions({ repositoryRoot, log: () => {} }).then(() => version));
  await check('CHANGELOG section', async () => `${releaseNotes(await fs.readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8'), version).length} characters of notes`);
  await check('frozen lockfile', async () => {
    await run('bun', ['install', '--frozen-lockfile', '--dry-run'], { cwd: repositoryRoot, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DEVRYAN_SKIP_INSTALL_PREPARE: '1' } });
    return 'bun install --frozen-lockfile --dry-run';
  });
  await check('shipped discovery fixtures', async () => {
    const problems = await shippedDiscoveryFixtureProblems({ tagBlob: async (tag, file) =>
      (await run('git', ['rev-parse', `${tag}:${file}`], { cwd: repositoryRoot }).catch(() => ({ stdout: '' }))).stdout.trim() || null });
    if (problems.length) throw new Error(`${problems.join('; ')} (fetch tags, or re-copy the shipped files)`);
    return 'identical to their release tags';
  });
  if (!localOnly) {
    const token = await githubToken(environment, run);
    if (!token) throw new Error('GitHub checks need GITHUB_TOKEN, GH_TOKEN or `gh auth login`; use --local-only to skip them');
    const client = githubClient({ token, fetchImpl, repository: env.GITHUB_REPOSITORY, environment: env });
    const admission = await check('publication state and latest ordering', async () => {
      if (env.RELEASE_DRY_RUN !== 'true') {
        const result = await admit({ repositoryRoot, environment: env, fetchImpl, log: () => {} });
        Object.assign(output, { release_id: result.releaseId, published: String(result.published === true), candidate_run_id: result.candidateRunId ?? '' });
        return result.published ? `v${version} is published; verify-published reruns only` : `v${version} is unpublished`;
      }
      // A dry run reports what a tag push would decide without failing on it.
      const ledger = await readLedger(client, version);
      const state = releaseState({ version, releases: await findReleases(client, `v${version}`), ledger, source });
      return `dry run: a tag push would ${state.action === 'refuse' ? `be refused (${state.message})` : state.action}`;
    });
    if (output.published !== 'true' && admission !== undefined) {
      await check('build reuse', async () => {
        output.reuse_run_id = await findReusableCandidate({ environment: env, client });
        return output.reuse_run_id ? `reusing the DMG built by run ${output.reuse_run_id}` : 'no retained DMG at this SHA; packaging builds it';
      });
    }
  }
  const failed = results.filter(result => !result.passed);
  if (environment.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(environment.GITHUB_STEP_SUMMARY, `### Release preflight v${version}\n\n${results.map(result => `- ${result.passed ? 'pass' : '**FAIL**'} ${result.name}: ${result.detail ?? ''}`).join('\n')}\n`);
  }
  if (failed.length) throw new Error(`Release preflight failed: ${failed.map(result => result.name).join(', ')}`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--local-only')) {
    console.error('Usage: release-preflight.mjs [--local-only]');
    process.exit(2);
  }
  try {
    const output = await preflight({ localOnly: args.includes('--local-only') });
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
