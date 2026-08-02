import path from 'node:path';
import { rm, stat } from 'node:fs/promises';

export const WORKTREE_INDEX_LOCK_RETRY_LIMIT = 1;
export const WORKTREE_INDEX_LOCK_RETRY_DELAY_MS = 100;

export const waitForWorktreeLock = (delayMs = WORKTREE_INDEX_LOCK_RETRY_DELAY_MS) => (
  new Promise((resolve) => setTimeout(resolve, delayMs))
);

const gitErrorText = (error) => [error?.stderr, error?.stdout, error?.message]
  .map((value) => String(value || '').trim())
  .filter(Boolean)
  .join('\n');

export const isIndexLockError = (error) => {
  const text = gitErrorText(error);
  return /index\.lock/i.test(text)
    && /(file exists|unable to create|another git process|could not lock)/i.test(text);
};

export const resolveWorktreeLockPath = async (directory, runGitCommandOrThrow) => {
  const result = await runGitCommandOrThrow(
    directory,
    ['rev-parse', '--git-path', 'index.lock'],
    'Failed to resolve worktree index lock',
  );
  const resolved = String(result?.stdout || '').trim();
  if (!resolved) {
    throw new Error('Git returned an empty worktree index lock path');
  }
  return path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(directory, resolved);
};

export const readFileIdentity = async (filePath) => {
  try {
    const value = await stat(filePath);
    return {
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeMs: value.mtimeMs,
      ctimeMs: value.ctimeMs,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const hasSameFileIdentity = (left, right) => (
  left !== null
  && right !== null
  && left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.mtimeMs === right.mtimeMs
  && left.ctimeMs === right.ctimeMs
);

export const populateWorktreeWithLockRecovery = async (directory, {
  runGitCommandOrThrow,
  wait = waitForWorktreeLock,
  readIdentity = readFileIdentity,
  removeLock = (lockPath) => rm(lockPath, { force: true }),
  retryLimit = WORKTREE_INDEX_LOCK_RETRY_LIMIT,
} = {}) => {
  if (typeof runGitCommandOrThrow !== 'function') {
    throw new TypeError('runGitCommandOrThrow is required');
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await runGitCommandOrThrow(
        directory,
        ['reset', '--hard'],
        'Failed to populate worktree',
      );
      return;
    } catch (error) {
      if (!isIndexLockError(error) || attempt >= retryLimit) throw error;

      const lockPath = await resolveWorktreeLockPath(directory, runGitCommandOrThrow);
      const before = await readIdentity(lockPath);
      await wait(WORKTREE_INDEX_LOCK_RETRY_DELAY_MS);
      const after = await readIdentity(lockPath);

      if (after && !hasSameFileIdentity(before, after)) {
        throw error;
      }
      if (after) {
        await removeLock(lockPath);
      }
    }
  }
};
