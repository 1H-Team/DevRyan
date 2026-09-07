import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import simpleGit from 'simple-git';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { readGitOperationState } from './operation-state.js';
import { getStatus, getConflictDetails, rebase, continueRebase, abortRebase, push } from './service.js';
import { registerGitRoutes } from './routes.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async (linked = true, { secondConflict = false, clean = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'devryan-rebase-'));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = simpleGit(repo, { unsafe: { allowUnsafeHooksPath: true } });
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.invalid');
  await git.addConfig('core.hooksPath', join(root, 'no-hooks'));
  await writeFile(join(repo, 'file'), 'base\n');
  if (secondConflict) await writeFile(join(repo, 'second'), 'base\n');
  await git.add('.'); await git.commit('base');
  const directory = linked ? join(root, 'worktree') : repo;
  if (linked) await git.raw(['worktree', 'add', '-b', 'Dev', directory]);
  else await git.checkoutLocalBranch('Dev');
  const work = simpleGit(directory);
  await writeFile(join(directory, 'file'), 'dev\n');
  await work.add('.'); await work.commit('dev');
  if (secondConflict) {
    await writeFile(join(directory, 'second'), 'dev second\n');
    await work.add('.'); await work.commit('dev second');
  }
  if (!linked) await git.checkout('main');
  await writeFile(join(repo, clean ? 'unrelated' : 'file'), 'main\n');
  if (secondConflict) await writeFile(join(repo, 'second'), 'main second\n');
  await git.add('.'); await git.commit('main');
  if (!linked) await git.checkout('Dev');
  return { root, repo, directory, git: work };
};

for (const linked of [false, true]) {
  for (const backend of ['merge', 'apply']) {
    it(`detects and recovers ${backend} rebase in ${linked ? 'linked' : 'ordinary'} checkout`, async () => {
      const { directory, git } = await fixture(linked);
      await expect(git.raw(['rebase', `--${backend}`, 'main'])).rejects.toThrow();
      expect(await getStatus(directory)).toMatchObject({ headState: 'detached', rebaseInProgress: { headName: 'Dev' } });
      expect(await getConflictDetails(directory)).toMatchObject({ operation: 'rebase', unmergedFiles: ['file'] });
      const app = express(); app.use(express.json()); registerGitRoutes(app);
      for (const action of ['push', 'pull']) {
        const result = await request(app).post(`/api/git/${action}`).query({ directory }).send({}).expect(409);
        expect(result.body.code).toBe('GIT_REBASE_IN_PROGRESS');
      }
      await writeFile(join(directory, 'file'), 'main and dev\n');
      await git.add('file');
      expect(await continueRebase(directory)).toEqual({ success: true, conflict: false });
      expect(await readGitOperationState(git)).toMatchObject({ branch: 'Dev', headState: 'branch', rebaseInProgress: null });
    });
  }
}

it('abort restores the attached branch; detached HEAD has its own error', async () => {
  const { directory, git } = await fixture();
  expect(await rebase(directory, { onto: 'main' })).toMatchObject({ conflict: true });
  await abortRebase(directory);
  expect(await getStatus(directory)).toMatchObject({ headState: 'branch', rebaseInProgress: null });
  await git.checkout(['--detach']);
  await expect(push(directory)).rejects.toMatchObject({ statusCode: 409, code: 'GIT_DETACHED_HEAD' });
});

it('keeps the operation visible when optional metadata is missing', async () => {
  const { git } = await fixture();
  const gitDir = (await git.raw(['rev-parse', '--absolute-git-dir'])).trim();
  await mkdir(join(gitDir, 'rebase-merge'));
  expect(await readGitOperationState(git)).toMatchObject({ rebaseInProgress: { headName: '', onto: '' }, attentionReason: 'rebase' });
});

it('does not claim completion or skip when continuation fails', async () => {
  const { directory, git } = await fixture();
  await rebase(directory, { onto: 'main' });
  const before = await git.revparse(['HEAD']);
  expect(await continueRebase(directory)).toMatchObject({ conflict: true });
  expect(await git.revparse(['HEAD'])).toBe(before);
  expect((await readGitOperationState(git)).rebaseInProgress).not.toBeNull();
});

it('pushes normally to a bare remote after successful recovery', async () => {
  const { root, directory, git } = await fixture();
  await rebase(directory, { onto: 'main' });
  await writeFile(join(directory, 'file'), 'resolved\n'); await git.add('file');
  await continueRebase(directory);
  const remote = join(root, 'remote'); await mkdir(remote); await simpleGit(remote).init(true);
  await git.addRemote('origin', remote);
  expect(await push(directory, { remote: 'origin', branch: 'Dev' })).toMatchObject({ success: true });
  expect((await simpleGit(remote).revparse(['refs/heads/Dev'])).trim()).toBe((await git.revparse(['HEAD'])).trim());
});


it('returns the next conflict rather than completion during a multi-commit rebase', async () => {
  const { directory, git } = await fixture(true, { secondConflict: true });
  await rebase(directory, { onto: 'main' });
  await writeFile(join(directory, 'file'), 'both first\n'); await git.add('file');
  expect(await continueRebase(directory)).toMatchObject({ success: false, conflict: true, conflictFiles: ['second'] });
  expect((await getStatus(directory)).rebaseInProgress).not.toBeNull();
  await writeFile(join(directory, 'second'), 'both second\n'); await git.add('second');
  expect(await continueRebase(directory)).toMatchObject({ success: true, conflict: false });
});

it('propagates a nothing-to-commit error without silently skipping the patch', async () => {
  const { root, directory, git } = await fixture();
  await rebase(directory, { onto: 'main' });
  const before = await git.revparse(['HEAD']);
  await writeFile(join(directory, 'file'), 'keep this resolution\n'); await git.add('file');
  const hookDir = join(root, 'no-hooks'); await mkdir(hookDir);
  const hook = join(hookDir, 'prepare-commit-msg');
  await writeFile(hook, '#!/bin/sh\necho "nothing to commit: simulated hook failure" >&2\nexit 1\n');
  await chmod(hook, 0o755);
  await expect(continueRebase(directory)).rejects.toThrow('nothing to commit');
  expect(await git.revparse(['HEAD'])).toBe(before);
  expect((await readGitOperationState(git)).rebaseInProgress).not.toBeNull();
  expect(await git.diff(['--cached'])).toContain('keep this resolution');
});

it('finishes a conflict-free rebase attached to its original branch', async () => {
  const { directory } = await fixture(true, { clean: true });
  expect(await rebase(directory, { onto: 'main' })).toEqual({ success: true, conflict: false });
  expect(await getStatus(directory)).toMatchObject({ current: 'Dev', headState: 'branch', rebaseInProgress: null });
});
