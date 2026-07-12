import assert from 'node:assert/strict';
import test from 'node:test';

import { finishQuitAfterCleanup } from '../quit-cleanup.mjs';

test('waits for owned-resource cleanup before requesting normal quit', async () => {
  let resolveCleanup;
  let timeoutCallback;
  const calls = [];
  const cleanup = new Promise((resolve) => {
    resolveCleanup = resolve;
  });

  const operation = finishQuitAfterCleanup({
    cleanupOwnedResources: () => {
      calls.push('cleanup');
      return cleanup;
    },
    requestQuit: () => calls.push('quit'),
    forceExit: () => calls.push('force-exit'),
    scheduleTimeout: (callback, delayMs) => {
      calls.push(['schedule', delayMs]);
      timeoutCallback = callback;
      return 17;
    },
    cancelTimeout: (timer) => calls.push(['cancel', timer]),
    timeoutMs: 10_000,
  });

  await Promise.resolve();
  assert.deepEqual(calls, [['schedule', 10_000], 'cleanup']);
  assert.equal(typeof timeoutCallback, 'function');

  resolveCleanup();
  await operation;
  assert.deepEqual(calls, [
    ['schedule', 10_000],
    'cleanup',
    ['cancel', 17],
    'quit',
  ]);
});

test('uses the bounded force-exit path when cleanup does not settle', async () => {
  let timeoutCallback;
  const calls = [];

  const operation = finishQuitAfterCleanup({
    cleanupOwnedResources: () => new Promise(() => {}),
    requestQuit: () => calls.push('quit'),
    forceExit: () => calls.push('force-exit'),
    scheduleTimeout: (callback) => {
      timeoutCallback = callback;
      return 18;
    },
    cancelTimeout: (timer) => calls.push(['cancel', timer]),
    timeoutMs: 10_000,
  });

  await Promise.resolve();
  timeoutCallback();
  await operation;
  assert.deepEqual(calls, ['force-exit']);
});

test('reports cleanup failure and still requests normal quit', async () => {
  const errors = [];
  const calls = [];

  await finishQuitAfterCleanup({
    cleanupOwnedResources: async () => {
      throw new Error('cleanup failed');
    },
    requestQuit: () => calls.push('quit'),
    forceExit: () => calls.push('force-exit'),
    onCleanupError: (error) => errors.push(error),
    scheduleTimeout: () => 19,
    cancelTimeout: (timer) => calls.push(['cancel', timer]),
    timeoutMs: 10_000,
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /cleanup failed/);
  assert.deepEqual(calls, [['cancel', 19], 'quit']);
});
