import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { finishQuitAfterCleanup } from '../quit-cleanup.mjs';

test('normal desktop restart relaunches only after cleanup, including the bounded fallback', async () => {
  for (const timedOut of [false, true]) {
    const calls = []; let timeout;
    const operation = finishQuitAfterCleanup({
      cleanupOwnedResources: () => { calls.push('cleanup'); return timedOut ? new Promise(() => {}) : undefined; },
      relaunch: () => calls.push('relaunch'), requestQuit: () => calls.push('quit'), forceExit: () => calls.push('exit'),
      scheduleTimeout: (callback) => { timeout = callback; return 1; }, cancelTimeout: () => {},
    });
    await Promise.resolve();
    assert.deepEqual(calls, ['cleanup']);
    if (timedOut) timeout();
    await operation;
    assert.deepEqual(calls, ['cleanup', 'relaunch', timedOut ? 'exit' : 'quit']);
  }
});

test('desktop restart uses bounded cleanup and stops the in-process server', () => {
  const source = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const restart = source.slice(source.indexOf("case 'desktop_restart':"), source.indexOf("case 'desktop_get_lan_address':"));
  assert.match(restart, /performConfirmedQuit\(\{ restart: true \}\)/);
  assert.doesNotMatch(restart, /app\.exit\(0\)/);
  const cleanup = source.slice(source.indexOf('const performConfirmedQuit'), source.indexOf('const requestQuitWithConfirmation'));
  assert.match(cleanup, /await Promise\.all\(\[\s+killSidecar\(\),/);
  assert.doesNotMatch(cleanup, /runtimeServiceClient|stopDesktopHostBroker/);
});

test('update cleanup lets only the updater request the eventual quit', async () => {
  const calls = [];
  const result = await finishQuitAfterCleanup({ owner: 'updater',
    cleanupOwnedResources: () => calls.push('owned'),
    requestQuit: () => calls.push('install'), forceExit: () => calls.push('exit'),
  });
  assert.equal(result, 'quit'); assert.deepEqual(calls, ['owned', 'install']);
});

test('update cleanup failure or timeout never quits or starts installation', async () => {
  for (const fail of [false, true]) {
    const calls = []; let timeout;
    const result = finishQuitAfterCleanup({ owner: 'updater',
      cleanupOwnedResources: () => fail ? Promise.reject(new Error('failure')) : new Promise(() => {}),
      requestQuit: () => calls.push('install'), forceExit: () => calls.push('exit'),
      onCleanupError: () => calls.push('error'),
      scheduleTimeout: (callback) => { timeout = callback; return 1; }, cancelTimeout: () => {},
    });
    await Promise.resolve(); if (!fail) timeout();
    assert.equal(await result, 'blocked'); assert.deepEqual(calls, ['error']);
  }
});

test('installation starts only after cleanup settled in time, never after a timeout', async () => {
  const calls = []; let timeout, finishCleanup;
  const late = finishQuitAfterCleanup({ owner: 'updater',
    cleanupOwnedResources: () => new Promise(resolve => { finishCleanup = resolve; }),
    afterCleanup: () => calls.push('launch-installer'),
    requestQuit: () => calls.push('install'), forceExit: () => calls.push('exit'),
    onCleanupError: error => calls.push(error.code),
    scheduleTimeout: (callback) => { timeout = callback; return 1; }, cancelTimeout: () => {},
  });
  await Promise.resolve(); timeout();
  assert.equal(await late, 'blocked');
  finishCleanup(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['update_cleanup_timeout'], 'a cleanup that outlived its timeout never launches the installer');

  const order = [];
  assert.equal(await finishQuitAfterCleanup({ owner: 'updater', cleanupOwnedResources: () => order.push('owned'),
    afterCleanup: async () => order.push('launch-installer'), requestQuit: () => order.push('install'), forceExit: () => order.push('exit') }), 'quit');
  assert.deepEqual(order, ['owned', 'launch-installer', 'install']);

  const refused = [];
  assert.equal(await finishQuitAfterCleanup({ owner: 'updater', cleanupOwnedResources: () => refused.push('owned'),
    afterCleanup: async () => { throw Object.assign(new Error('changed'), { code: 'update_intent_changed' }); },
    requestQuit: () => refused.push('install'), forceExit: () => refused.push('exit'), onCleanupError: error => refused.push(error.code) }), 'blocked');
  assert.deepEqual(refused, ['owned', 'update_intent_changed']);
});

test('the update restart and candidate rollback act only after cleanup settled in time', async () => {
  const main = await import('node:fs/promises').then(fs => fs.readFile(new URL('../main.mjs', import.meta.url), 'utf8'));
  assert.match(main, /cleanupOwnedResources: cleanupUpdateOwners, afterCleanup: \(\) => desktopDmgInstaller\.launchPrepared\(prepared\),/);
  assert.match(main, /cleanupOwnedResources: cleanupUpdateOwners, afterCleanup: \(\) => desktopDmgInstaller\.recordCandidateStopped\(true\),/);
  assert.doesNotMatch(main, /cleanupOwnedResources: async \(\) => \{ await cleanupUpdateOwners\(\);/);
});

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
