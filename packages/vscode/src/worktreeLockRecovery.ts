import * as path from 'node:path';
import { rm, stat } from 'node:fs/promises';

export const WORKTREE_INDEX_LOCK_RETRY_LIMIT = 1;
export const WORKTREE_INDEX_LOCK_RETRY_DELAY_MS = 100;

type GitCommandResult = { stdout?: string };
type RunGitCommandOrThrow = (
  directory: string,
  args: string[],
  fallbackMessage: string,
) => Promise<GitCommandResult>;

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export const waitForWorktreeLock = (delayMs = WORKTREE_INDEX_LOCK_RETRY_DELAY_MS): Promise<void> => (
  new Promise((resolve) => setTimeout(resolve, delayMs))
);

const gitErrorText = (error: unknown): string => {
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [value?.stderr, value?.stdout, value?.message]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
};

export const isIndexLockError = (error: unknown): boolean => {
  const text = gitErrorText(error);
  return /index\.lock/i.test(text)
    && /(file exists|unable to create|another git process|could not lock)/i.test(text);
};

export const resolveWorktreeLockPath = async (
  directory: string,
  runGitCommandOrThrow: RunGitCommandOrThrow,
): Promise<string> => {
  const result = await runGitCommandOrThrow(
    directory,
    ['rev-parse', '--git-path', 'index.lock'],
    'Failed to resolve worktree index lock',
  );
  const resolved = String(result.stdout || '').trim();
  if (!resolved) {
    throw new Error('Git returned an empty worktree index lock path');
  }
  return path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(directory, resolved);
};

export const readFileIdentity = async (filePath: string): Promise<FileIdentity | null> => {
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
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
};

const hasSameFileIdentity = (left: FileIdentity | null, right: FileIdentity | null): boolean => (
  left !== null
  && right !== null
  && left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.mtimeMs === right.mtimeMs
  && left.ctimeMs === right.ctimeMs
);

type RecoveryOptions = {
  runGitCommandOrThrow: RunGitCommandOrThrow;
  wait?: (delayMs: number) => Promise<void>;
  readIdentity?: (filePath: string) => Promise<FileIdentity | null>;
  removeLock?: (filePath: string) => Promise<void>;
  retryLimit?: number;
};

export const populateWorktreeWithLockRecovery = async (
  directory: string,
  {
    runGitCommandOrThrow,
    wait = waitForWorktreeLock,
    readIdentity = readFileIdentity,
    removeLock = (lockPath) => rm(lockPath, { force: true }),
    retryLimit = WORKTREE_INDEX_LOCK_RETRY_LIMIT,
  }: RecoveryOptions,
): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runGitCommandOrThrow(directory, ['reset', '--hard'], 'Failed to populate worktree');
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
