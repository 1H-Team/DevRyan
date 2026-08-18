import { isIndexLockError } from './worktree-lock-recovery.js';

export const INDEX_LOCK_RETRY_ATTEMPTS = 4;
export const INDEX_LOCK_RETRY_BASE_DELAY_MS = 60;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a Git operation that failed only because another process held
 * `.git/index.lock`.
 *
 * Editors and agent runtimes (opencode, Cursor, the VS Code Git extension)
 * share the user's repository and take the index lock for a few milliseconds at
 * a time. Without this, a collision surfaces to the user as a raw
 * "Unable to create '<repo>/.git/index.lock': File exists" fatal even though
 * retrying immediately would have succeeded.
 *
 * The lock file is deliberately never deleted here: a live holder owns it, and
 * removing it would corrupt that process's write. Only worktree population
 * (see worktree-lock-recovery.js) removes a lock, and only after proving it is
 * stale via stat identity.
 */
export const withIndexLockRetry = async (operation, {
  attempts = INDEX_LOCK_RETRY_ATTEMPTS,
  baseDelayMs = INDEX_LOCK_RETRY_BASE_DELAY_MS,
  sleep = sleepFor,
  isRetryable = isIndexLockError,
} = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await sleep(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
};

/**
 * Same contention handling for callers that report failure via a result object
 * (`runGitCommand`) instead of throwing.
 */
export const withIndexLockRetryResult = async (operation, {
  attempts = INDEX_LOCK_RETRY_ATTEMPTS,
  baseDelayMs = INDEX_LOCK_RETRY_BASE_DELAY_MS,
  sleep = sleepFor,
} = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    const result = await operation();
    if (result?.success !== false) return result;
    if (attempt >= attempts || !isIndexLockError(result)) return result;
    await sleep(baseDelayMs * (2 ** (attempt - 1)));
  }
};
