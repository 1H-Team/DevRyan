#!/usr/bin/env node
// Release preflight: every check that can fail a release before anything is
// built, in one report. The `preflight` job runs it on every release run;
// locally `bun run release:preflight` runs the same checks in a temporary clean
// worktree, as a fresh runner would (`--local-only` skips the ones that need
// GitHub; `--in-place` runs in this checkout). `bun run validate` runs
// `--local-only` whenever a version file, CHANGELOG.md or bun.lock changes.
//
//   versions, CHANGELOG, frozen lockfile    the commit is releasable (notes within the updater's 64 KiB)
//   shipped discovery fixtures              the vendored updater copies are what their tags shipped
//   publication state, latest ordering      admit (scripts/release.mjs): same-version state and ledger
//   build reuse                             a retained DMG from an earlier run at this SHA
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY } from '../packages/electron/release-assets.mjs';
import { createRunRoot, scratchParent } from './qa/run-root.mjs';
import { admit, checkVersions, findReleases, readLedger, releaseNotes, releaseVersion } from './release.mjs';
import { githubClient } from './release-github.mjs';
import { findReusableCandidate } from './release-candidate.mjs';
import { RELEASE_BODY_MAX_BYTES, formatReleaseMarker, releaseBody, releasePayloadProblems, releaseState, shippedDiscoveryFixtureProblems } from './release-state.mjs';

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
  await check('CHANGELOG section', async () => {
    const notes = releaseNotes(await fs.readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8'), version);
    // The body installed updaters read: the notes plus the marker comment stage appends.
    const problems = releasePayloadProblems({ body: releaseBody(notes, formatReleaseMarker({ version, sha256: '0'.repeat(64), size: 1, source: '0'.repeat(40), runId: '0', runAttempt: '0' })) });
    if (problems.length) throw new Error(problems.join('; '));
    return `${notes.length} characters of notes, within the ${RELEASE_BODY_MAX_BYTES}-byte updater budget`;
  });
  await check('frozen lockfile', async () => {
    await run('bun', ['install', '--frozen-lockfile', '--dry-run', '--ignore-scripts'], { cwd: repositoryRoot, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DEVRYAN_SKIP_INSTALL_PREPARE: '1' } });
    return 'bun install --frozen-lockfile --dry-run --ignore-scripts';
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

/**
 * Preflight as a fresh CI runner sees the commit: in a temporary `git worktree`
 * (OS temp dir) of this checkout as `git add -A` would commit it (snapshotted
 * through a private index, so the real index and the shared stash list are
 * untouched), with no node_modules or ignored files. A local node_modules once
 * hid a root postinstall that failed on the runner (v2.1.10). The worktree is
 * removed on success, failure and interruption.
 */
export async function preflightInCleanCheckout({ repositoryRoot = root, args = [], run = execute, environment = process.env,
  spawnPreflight = (cwd, argv, env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/release-preflight.mjs', '--in-place', ...argv], { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  }) } = {}) {
  const git = (gitArgs, options = {}) => run('git', gitArgs, { cwd: repositoryRoot, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  let checkout = null;
  const removeWorktree = () => {
    if (!checkout) return;
    // Only this run's worktree: never `git worktree prune`, which would touch other checkouts' records.
    // An interrupt removes it here, before the run root is deleted.
    try { execFileSync('git', ['worktree', 'remove', '--force', checkout], { cwd: repositoryRoot, stdio: 'ignore', timeout: 60_000 }); }
    catch { console.error(`[preflight] could not remove the temporary worktree ${checkout}; remove it with: git worktree remove --force ${checkout}`); }
    checkout = null;
  };
  const runRoot = createRunRoot({ parent: scratchParent('release-preflight'), owner: 'release-preflight', onInterrupt: removeWorktree });
  let status = 1;
  try {
    const snapshotEnv = { ...process.env, GIT_INDEX_FILE: path.join(runRoot.dir, 'index'), GIT_AUTHOR_NAME: 'release-preflight', GIT_AUTHOR_EMAIL: 'release-preflight@localhost',
      GIT_COMMITTER_NAME: 'release-preflight', GIT_COMMITTER_EMAIL: 'release-preflight@localhost' };
    await git(['read-tree', 'HEAD'], { env: snapshotEnv });
    await git(['add', '-A'], { env: snapshotEnv });
    const tree = (await git(['write-tree'], { env: snapshotEnv })).stdout.trim();
    const changed = tree !== (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const snapshot = changed ? (await git(['commit-tree', tree, '-p', head, '-m', 'release preflight snapshot'], { env: snapshotEnv })).stdout.trim() : head;
    const target = path.join(runRoot.dir, 'checkout');
    await git(['worktree', 'add', '--detach', '--quiet', target, snapshot]);
    checkout = target;
    console.log(`[preflight] clean checkout of HEAD ${head}${changed ? ' plus uncommitted changes' : ''} (no node_modules or ignored files)`);
    // GitHub checks name the real commit, never the local snapshot.
    status = await spawnPreflight(checkout, args, { ...environment, GITHUB_SHA: environment.GITHUB_SHA || head });
    return status;
  } finally {
    removeWorktree();
    runRoot.finish(status === 0 ? 'passed' : 'failed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--local-only', '--in-place'].includes(arg))) {
    console.error('Usage: release-preflight.mjs [--local-only] [--in-place]');
    process.exit(2);
  }
  // A CI checkout is already clean; locally the checks run in a temporary clean worktree.
  if (!args.includes('--in-place') && process.env.GITHUB_ACTIONS !== 'true') {
    process.exitCode = await preflightInCleanCheckout({ args: args.filter(arg => arg === '--local-only') }).catch(error => { console.error(error.message); return 1; });
  } else try {
    const output = await preflight({ localOnly: args.includes('--local-only') });
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
