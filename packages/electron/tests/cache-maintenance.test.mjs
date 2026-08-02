import assert from 'node:assert/strict';
import test from 'node:test';

import { clearElectronRuntimeCaches, getElectronRuntimeCacheInfo } from '../cache-maintenance.mjs';

test('Electron cache maintenance reports the current cache size', async () => {
  const result = await getElectronRuntimeCacheInfo({
    defaultSession: {
      getCacheSize: async () => 12_345.9,
    },
  });

  assert.deepEqual(result, { sizeBytes: 12_345 });
});

test('Electron cache maintenance sums the app and browser partition cache sizes', async () => {
  const result = await getElectronRuntimeCacheInfo({
    defaultSession: {
      getCacheSize: async () => 1_000.7,
    },
    browserSession: {
      getCacheSize: async () => 2_500.4,
    },
  });

  assert.deepEqual(result, { sizeBytes: 3_500 });
});

test('Electron cache maintenance counts a shared session only once', async () => {
  let reads = 0;
  const sharedSession = {
    getCacheSize: async () => {
      reads += 1;
      return 900;
    },
  };

  const result = await getElectronRuntimeCacheInfo({
    defaultSession: sharedSession,
    browserSession: sharedSession,
  });

  assert.deepEqual(result, { sizeBytes: 900 });
  assert.equal(reads, 1);
});

test('Electron cache maintenance rejects invalid cache sizes', async () => {
  await assert.rejects(
    getElectronRuntimeCacheInfo({
      defaultSession: {
        getCacheSize: async () => Number.NaN,
      },
    }),
    /invalid cache size/,
  );
});

test('Electron cache maintenance clears HTTP and code caches without storage data', async () => {
  const calls = [];
  const defaultSession = {
    clearCache: async () => {
      calls.push('clearCache');
    },
    clearCodeCaches: async (options) => {
      calls.push(['clearCodeCaches', options]);
    },
    clearStorageData: async () => {
      calls.push('clearStorageData');
    },
  };

  const result = await clearElectronRuntimeCaches({
    defaultSession,
    log: { warn: () => calls.push('warn') },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    'clearCache',
    ['clearCodeCaches', { urls: [] }],
  ]);
});

test('Electron cache maintenance clears the browser partition alongside the app session', async () => {
  const calls = [];
  const makeSession = (name) => ({
    clearCache: async () => {
      calls.push(`${name}:clearCache`);
    },
    clearCodeCaches: async (options) => {
      calls.push([`${name}:clearCodeCaches`, options]);
    },
    clearStorageData: async () => {
      calls.push(`${name}:clearStorageData`);
    },
  });

  const result = await clearElectronRuntimeCaches({
    defaultSession: makeSession('app'),
    browserSession: makeSession('browser'),
    log: { warn: () => calls.push('warn') },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    'app:clearCache',
    ['app:clearCodeCaches', { urls: [] }],
    'browser:clearCache',
    ['browser:clearCodeCaches', { urls: [] }],
  ]);
});

test('Electron cache maintenance keeps clearing the app session when the browser partition fails', async () => {
  const calls = [];
  const warnings = [];

  const result = await clearElectronRuntimeCaches({
    defaultSession: {
      clearCache: async () => {
        calls.push('app:clearCache');
      },
      clearCodeCaches: async () => {
        calls.push('app:clearCodeCaches');
      },
    },
    browserSession: {
      clearCache: async () => {
        throw new Error('partition locked');
      },
      clearCodeCaches: async () => {
        calls.push('browser:clearCodeCaches');
      },
    },
    log: { warn: (...args) => warnings.push(args) },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /partition locked/);
  assert.deepEqual(calls, ['app:clearCache', 'app:clearCodeCaches', 'browser:clearCodeCaches']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /browser HTTP cache/);
});

test('Electron cache maintenance reports cache failures without throwing', async () => {
  const warnings = [];
  const result = await clearElectronRuntimeCaches({
    defaultSession: {
      clearCache: async () => {
        throw new Error('disk busy');
      },
      clearCodeCaches: async () => {},
    },
    log: { warn: (...args) => warnings.push(args) },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /disk busy/);
  assert.equal(warnings.length, 1);
});
