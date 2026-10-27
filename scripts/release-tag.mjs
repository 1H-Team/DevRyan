#!/usr/bin/env node
// Gated release tagging: `bun run release:tag` (docs/RELEASE_PIPELINE.md, "Releasing a version").
//
// A release tag is pushed only once the commit is already proven: the working
// tree is clean, the canonical main CI passed at the commit (requireTrustedCI),
// a dry run of release.yml at the commit passed packaging, qualification and
// simulation, visual and installed-app checks with its DMG still retained, and preflight passes in a
// clean checkout. Then it pushes the tag, and nothing else: main is already
// pushed (its CI proves it). The tag run adopts the dry run's DMG through build
// reuse (scripts/release-candidate.mjs), verifying it against the dry run's
// manifest, so the published bytes are the ones the dry run checked.
//
//   bun run release:tag              check, then push vX.Y.Z (package.json's version) at HEAD
//   bun run release:tag -- --check   check only; print the push command
//   bun run release:tag -- --move    move an unpublished version's tag to HEAD (a code fix)
//
// GitHub is only read (GITHUB_TOKEN, GH_TOKEN or `gh auth token`).
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CANONICAL_RELEASE_REPOSITORY } from './release-artifacts.mjs';
import { githubClient } from './release-github.mjs';
import { findGreenDryRun } from './release-candidate.mjs';
import { githubToken, preflightInCleanCheckout } from './release-preflight.mjs';
import { admit, releaseVersion, requireTrustedCI } from './release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

/** `origin` must be the canonical repository, so the tag reaches the repository whose CI and dry run were checked. */
export const isCanonicalRemote = url => new RegExp(`^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)${CANONICAL_RELEASE_REPOSITORY}(?:\\.git)?/?$`).test(url.trim());

export async function releaseTag({ repositoryRoot = root, environment = process.env, fetchImpl = fetch, run = execute, log = console.log,
  check = false, move = false, cleanPreflight = options => preflightInCleanCheckout(options) } = {}) {
  const git = (...args) => run('git', args, { cwd: repositoryRoot, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).then(result => result.stdout.trim());
  const version = await releaseVersion(repositoryRoot, {});
  const tag = `v${version}`;
  const source = await git('rev-parse', 'HEAD');
  const changes = await git('status', '--porcelain');
  if (changes) throw new Error(`The working tree has uncommitted changes; ${tag} would name ${source} without them. Commit or remove them first:\n${changes}`);
  const origin = await git('remote', 'get-url', 'origin');
  if (!isCanonicalRemote(origin)) throw new Error(`origin is ${origin}, not github.com/${CANONICAL_RELEASE_REPOSITORY}`);
  const local = await git('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`).catch(() => '');
  if (local && local !== source && !move) throw new Error(`A local ${tag} points at ${local}, not HEAD ${source}; delete it (git tag -d ${tag}) or pass --move for a code fix`);

  const token = await githubToken(environment, run);
  if (!token) throw new Error('release:tag reads GitHub: set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`');
  const env = { GITHUB_REPOSITORY: CANONICAL_RELEASE_REPOSITORY, GITHUB_SHA: source, GITHUB_TOKEN: token, GITHUB_REF: `refs/tags/${tag}` };
  const admission = await admit({ repositoryRoot, environment: env, fetchImpl, log, tagPushed: false, move });
  await requireTrustedCI({ environment: env, fetchImpl, log });
  // A dry-run environment: this client can never write.
  const client = githubClient({ token, fetchImpl, repository: CANONICAL_RELEASE_REPOSITORY, environment: { RELEASE_DRY_RUN: 'true' } });
  const dryRun = await findGreenDryRun({ client, source, repository: CANONICAL_RELEASE_REPOSITORY });
  if (!dryRun) {
    throw new Error(`No green dry run at ${source}: run \`gh workflow run release.yml --ref main\` and wait until preflight, packaging, upgrade-check, simulate-release and visual-qa pass, then rerun release:tag`);
  }
  log(`Dry run ${dryRun.id} at ${source} passed simulation and visual gates; the tag run adopts its DMG.`);
  const status = await cleanPreflight({ repositoryRoot, args: ['--local-only'], environment: { ...environment, GITHUB_SHA: source } });
  if (status !== 0) throw new Error(`Release preflight failed at ${source}; fix it before tagging ${tag}`);

  if (admission.tagged) {
    log(`${tag} already points at ${source}; nothing to push. Follow it with: bun run release:status ${tag}`);
    return { version, tag, source, dryRunId: String(dryRun.id), pushed: false };
  }
  const refspec = admission.movedFrom ? `+refs/tags/${tag}` : `refs/tags/${tag}`;
  const command = `git tag ${admission.movedFrom ? '-f ' : ''}${tag} ${source} && git push origin ${refspec}`;
  if (check) {
    log(`All release:tag checks passed for ${tag} at ${source}. Push with: ${command}`);
    return { version, tag, source, dryRunId: String(dryRun.id), pushed: false, command };
  }
  if (local !== source) await git('tag', ...(local ? ['-f'] : []), tag, source);
  await git('push', 'origin', refspec);
  log(`Pushed ${tag} at ${source}${admission.movedFrom ? ` (moved from ${admission.movedFrom})` : ''}. Follow it with: bun run release:status ${tag}`);
  return { version, tag, source, dryRunId: String(dryRun.id), pushed: true, command };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--move'].includes(arg))) {
    console.error('Usage: release-tag.mjs [--check] [--move]');
    process.exit(2);
  }
  releaseTag({ check: args.includes('--check'), move: args.includes('--move') }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
