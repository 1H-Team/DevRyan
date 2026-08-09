import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { populateWorktreeWithLockRecovery } from './worktree-lock-recovery.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devryan-worktree-lock-'));
  tempDirs.push(directory);
  const lockPath = join(directory, 'index.lock');
  await writeFile(lockPath, 'stale');
  return { directory, lockPath };
};

const lockError = () => new Error("fatal: Unable to create 'index.lock': File exists.");
const indexWriteError = () => new Error('fatal: Could not write new index file.');

it('removes an unchanged stale lock and retries population once', async () => {
  const { directory, lockPath } = await createFixture();
  let resetCalls = 0;
  const runGitCommandOrThrow = vi.fn(async (_cwd, args) => {
    if (args[0] === 'rev-parse') return { stdout: `${lockPath}\n` };
    resetCalls += 1;
    if (resetCalls === 1) throw lockError();
    return { stdout: '' };
  });

  await populateWorktreeWithLockRecovery(directory, {
    runGitCommandOrThrow,
    wait: async () => {},
  });

  expect(resetCalls).toBe(2);
  await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves a lock whose identity changes while recovery waits', async () => {
  const { directory, lockPath } = await createFixture();
  const expected = lockError();
  const runGitCommandOrThrow = vi.fn(async (_cwd, args) => {
    if (args[0] === 'rev-parse') return { stdout: lockPath };
    throw expected;
  });

  await expect(populateWorktreeWithLockRecovery(directory, {
    runGitCommandOrThrow,
    wait: async () => {
      await rm(lockPath);
      await writeFile(lockPath, 'replacement lock');
    },
  })).rejects.toBe(expected);

  await expect(readFile(lockPath, 'utf8')).resolves.toBe('replacement lock');
});

it('surfaces non-lock errors without attempting recovery', async () => {
  const { directory } = await createFixture();
  const expected = new Error('fatal: invalid object name');
  const runGitCommandOrThrow = vi.fn(async () => {
    throw expected;
  });

  await expect(populateWorktreeWithLockRecovery(directory, {
    runGitCommandOrThrow,
    wait: async () => {},
  })).rejects.toBe(expected);
  expect(runGitCommandOrThrow).toHaveBeenCalledTimes(1);
});

it('retries a transient index finalization failure even when Git removed the lock', async () => {
  const { directory, lockPath } = await createFixture();
  await rm(lockPath);
  let resetCalls = 0;
  const runGitCommandOrThrow = vi.fn(async (_cwd, args) => {
    if (args[0] === 'rev-parse') return { stdout: `${lockPath}\n` };
    resetCalls += 1;
    if (resetCalls === 1) throw indexWriteError();
    return { stdout: '' };
  });

  await populateWorktreeWithLockRecovery(directory, {
    runGitCommandOrThrow,
    wait: async () => {},
  });

  expect(resetCalls).toBe(2);
  expect(runGitCommandOrThrow).toHaveBeenCalledWith(
    directory,
    ['rev-parse', '--git-path', 'index.lock'],
    'Failed to resolve worktree index lock',
  );
});
