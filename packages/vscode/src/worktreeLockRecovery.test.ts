import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { populateWorktreeWithLockRecovery } from './worktreeLockRecovery';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devryan-vscode-worktree-lock-'));
  tempDirs.push(directory);
  const lockPath = join(directory, 'index.lock');
  await writeFile(lockPath, 'stale');
  return { directory, lockPath };
};

const lockError = () => new Error("fatal: Unable to create 'index.lock': File exists.");

it('removes an unchanged stale lock and retries population once', async () => {
  const { directory, lockPath } = await createFixture();
  let resetCalls = 0;
  const runGitCommandOrThrow = vi.fn(async (_cwd: string, args: string[]) => {
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
  const runGitCommandOrThrow = vi.fn(async (_cwd: string, args: string[]) => {
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
