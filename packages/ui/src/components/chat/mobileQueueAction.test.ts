import { describe, expect, test } from 'bun:test';
import { preserveComposerFocus, runQueueActionOnce } from './mobileQueueAction';

describe('mobile queue action', () => {
  test('prevents the action button default so the composer retains focus', () => {
    let preventDefaultCalls = 0;

    preserveComposerFocus({
      preventDefault: () => {
        preventDefaultCalls += 1;
      },
    });

    expect(preventDefaultCalls).toBe(1);
  });

  test('runs only one queue action while a rapid tap is still in flight', async () => {
    const lock = { current: false };
    let runCount = 0;
    let resolveFirstRun: (() => void) | undefined;
    const firstRun = new Promise<void>((resolve) => {
      resolveFirstRun = resolve;
    });

    const firstTap = runQueueActionOnce(lock, async () => {
      runCount += 1;
      await firstRun;
    });
    const secondTap = runQueueActionOnce(lock, async () => {
      runCount += 1;
    });

    expect(runCount).toBe(1);
    expect(await secondTap).toBe(undefined);

    resolveFirstRun?.();
    await firstTap;

    await runQueueActionOnce(lock, async () => {
      runCount += 1;
    });
    expect(runCount).toBe(2);
  });
});
