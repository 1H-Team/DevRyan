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

test('checkpoints Bots and stops dispatcher/index work before general cleanup', async () => {
  const calls = [];

  await finishQuitAfterCleanup({
    checkpointBotRuns: async () => calls.push('checkpoint-bots'),
    stopBotDispatcher: async () => calls.push('stop-dispatcher'),
    stopBotIndexerRequests: async () => calls.push('stop-indexer'),
    cleanupOwnedResources: async () => calls.push('cleanup-owned'),
    requestQuit: () => calls.push('quit'),
    forceExit: () => calls.push('force-exit'),
    scheduleTimeout: () => 20,
    cancelTimeout: (timer) => calls.push(['cancel', timer]),
  });

  assert.deepEqual(calls, [
    'checkpoint-bots',
    'stop-dispatcher',
    'stop-indexer',
    'cleanup-owned',
    ['cancel', 20],
    'quit',
  ]);
});

test('continues remaining Bot cleanup stages after one stage fails', async () => {
  const calls = [];
  const errors = [];

  await finishQuitAfterCleanup({
    checkpointBotRuns: async () => {
      calls.push('checkpoint-bots');
      throw new Error('checkpoint failed');
    },
    stopBotDispatcher: async () => calls.push('stop-dispatcher'),
    stopBotIndexerRequests: async () => calls.push('stop-indexer'),
    cleanupOwnedResources: async () => calls.push('cleanup-owned'),
    requestQuit: () => calls.push('quit'),
    forceExit: () => calls.push('force-exit'),
    onCleanupError: (error) => errors.push(error),
    scheduleTimeout: () => 21,
    cancelTimeout: () => undefined,
  });

  assert.deepEqual(calls, [
    'checkpoint-bots',
    'stop-dispatcher',
    'stop-indexer',
    'cleanup-owned',
    'quit',
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /checkpoint failed/);
});
