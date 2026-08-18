import { describe, expect, it, vi } from 'vitest';

import {
  INDEX_LOCK_RETRY_ATTEMPTS,
  withIndexLockRetry,
  withIndexLockRetryResult,
} from './index-lock-retry.js';

const lockError = () => new Error(
  "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
);
const lockResult = () => ({
  success: false,
  exitCode: 128,
  stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
});

describe('withIndexLockRetry', () => {
  it('retries a contended operation until it succeeds', async () => {
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw lockError();
      return 'staged';
    });

    const sleep = vi.fn(async () => {});
    await expect(withIndexLockRetry(operation, { sleep })).resolves.toBe('staged');
    expect(calls).toBe(3);
  });

  it('backs off exponentially between attempts', async () => {
    const delays = [];
    const operation = vi.fn(async () => { throw lockError(); });

    await expect(
      withIndexLockRetry(operation, { sleep: async (ms) => { delays.push(ms); } }),
    ).rejects.toThrow(/index\.lock/);

    expect(delays).toEqual([60, 120, 240]);
  });

  it('gives up after the attempt limit and surfaces the original error', async () => {
    const operation = vi.fn(async () => { throw lockError(); });

    await expect(
      withIndexLockRetry(operation, { sleep: async () => {} }),
    ).rejects.toThrow(/Unable to create/);
    expect(operation).toHaveBeenCalledTimes(INDEX_LOCK_RETRY_ATTEMPTS);
  });

  it('does not retry unrelated git failures', async () => {
    const operation = vi.fn(async () => {
      throw new Error("error: pathspec 'nope' did not match any file(s) known to git");
    });

    await expect(
      withIndexLockRetry(operation, { sleep: async () => {} }),
    ).rejects.toThrow(/pathspec/);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('withIndexLockRetryResult', () => {
  it('retries result-style failures caused by the index lock', async () => {
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      return calls < 2 ? lockResult() : { success: true, stdout: 'ok' };
    });

    await expect(
      withIndexLockRetryResult(operation, { sleep: async () => {} }),
    ).resolves.toMatchObject({ success: true });
    expect(calls).toBe(2);
  });

  it('returns non-lock failures without retrying', async () => {
    const operation = vi.fn(async () => ({
      success: false,
      exitCode: 1,
      stderr: 'error: unknown revision',
    }));

    await expect(
      withIndexLockRetryResult(operation, { sleep: async () => {} }),
    ).resolves.toMatchObject({ success: false });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
