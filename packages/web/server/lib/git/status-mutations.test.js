import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import simpleGit from 'simple-git';
import { applyHunk, getBackgroundStatus, getStatus, push } from './service.js';
import { boundedUntracked } from './status-details.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devryan-git-details-')); roots.push(root);
  const directory = join(root, 'work'); await mkdir(directory);
  const git = simpleGit(directory); await git.init(); await git.addConfig('user.name', 'Fixture'); await git.addConfig('user.email', 'fixture@example.invalid');
  await writeFile(join(directory, 'a b.txt'), 'one\ntwo\n'); await git.add('.'); await git.commit('initial');
  return { root, directory, git };
}

it('reports staged and working counts and invalidates same-length edits', async () => {
  const { directory, git } = await fixture();
  await writeFile(join(directory, 'a b.txt'), 'one\nstaged\n'); await git.add('a b.txt');
  await writeFile(join(directory, 'a b.txt'), 'one\nworking\n');
  const first = await getStatus(directory);
  expect(first.stagedStats['a b.txt']).toEqual({ insertions: 1, deletions: 1 });
  expect(first.unstagedStats['a b.txt']).toEqual({ insertions: 1, deletions: 1 });
  expect(first.diffStats['a b.txt']).toEqual({ insertions: 2, deletions: 2 });
  await writeFile(join(directory, 'a b.txt'), 'one\nchanged\n');
  const next = await getBackgroundStatus(directory, { mode: 'light' });
  expect(next.fileVersions['a b.txt']).not.toBe(first.fileVersions['a b.txt']);
  expect(next.diffStats).toBeUndefined();
});

it('rejects stale and multi-file hunks while supporting spaces in filenames', async () => {
  const { directory, git } = await fixture();
  await writeFile(join(directory, 'a b.txt'), 'one\nthree\n');
  const patch = await git.diff(['--', 'a b.txt']);
  const before = await readFile(join(directory, '.git', 'index'));
  await expect(applyHunk(directory, 'a b.txt', { action: 'stage', patch: patch + patch })).rejects.toMatchObject({ code: 'GIT_HUNK_STALE' });
  await writeFile(join(directory, 'a b.txt'), 'one\nfour\n');
  await expect(applyHunk(directory, 'a b.txt', { action: 'stage', patch })).rejects.toMatchObject({ code: 'GIT_HUNK_STALE' });
  expect(await readFile(join(directory, '.git', 'index'))).toEqual(before);
  await applyHunk(directory, 'a b.txt', { action: 'stage', patch: await git.diff(['--', 'a b.txt']) });
  expect((await git.status()).staged).toContain('a b.txt');
});

it('bounds and reports untracked enumeration without hiding tracked state', async () => {
  const { directory } = await fixture();
  await Promise.all(['a', 'b', 'c', 'd'].map((file) => writeFile(join(directory, file), '')));
  const result = await boundedUntracked({ binary: 'git', directory, env: process.env, limit: 2 });
  expect(result.names).toHaveLength(2); expect(result.truncated).toBe(true);
});

it('resolves pushRemote before pushDefault and returns actual porcelain refs', async () => {
  const { root, directory, git } = await fixture();
  for (const name of ['origin', 'preferred', 'branch-remote']) {
    const remote = join(root, name); await mkdir(remote); await simpleGit(remote).init(true); await git.addRemote(name, remote);
  }
  const branch = (await git.branch()).current;
  await git.addConfig('remote.pushDefault', 'preferred');
  await git.addConfig(`branch.${branch}.pushRemote`, 'branch-remote');
  const result = await push(directory);
  expect(result.pushed).toContainEqual(expect.objectContaining({ local: `refs/heads/${branch}`, remote: `refs/heads/${branch}` }));
  expect(await simpleGit(join(root, 'branch-remote')).raw(['rev-parse', `refs/heads/${branch}`])).toBe(await git.revparse('HEAD') + '\n');
  expect(await simpleGit(join(root, 'preferred')).raw(['show-ref']).catch(() => '')).toBe('');
  const explicit = await push(directory, { remote: 'origin', branch });
  expect(explicit.pushed).toHaveLength(1);
});
