import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createModuleEntryLoader, routeStartupRetry } from '../startup-retry.mjs';

const mainSource = await fs.readFile(new URL('../main.mjs', import.meta.url), 'utf8');

test('a failed module evaluation is cached, so an in-process re-import never re-runs its bootstrap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-startup-retry-'));
  try {
    const entry = path.join(root, 'entry.mjs');
    await fs.writeFile(entry, `if (process.env.DEVRYAN_TEST_ENTRY_FAILS === '1') throw Object.assign(new Error('bootstrap'), { code: 'fixture_bootstrap_failed' });
export const started = true;
`);
    process.env.DEVRYAN_TEST_ENTRY_FAILS = '1';
    const loader = createModuleEntryLoader(() => import(pathToFileURL(entry).href));
    const first = await loader.load().catch((error) => error);
    assert.equal(first.code, 'fixture_bootstrap_failed');
    // The condition is corrected before Retry, but the module record keeps its error.
    delete process.env.DEVRYAN_TEST_ENTRY_FAILS;
    const second = await loader.load().catch((error) => error);
    assert.equal(second, first);
    assert.equal(loader.requiresRelaunch(), true);
  } finally {
    delete process.env.DEVRYAN_TEST_ENTRY_FAILS;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a successfully evaluated entry keeps Retry in process', async () => {
  const loader = createModuleEntryLoader(async () => ({ startWebUiServer: () => 'started' }));
  assert.equal(loader.requiresRelaunch(), false);
  const module = await loader.load();
  assert.equal(module.startWebUiServer(), 'started');
  assert.equal(loader.requiresRelaunch(), false);
});

test('Retry relaunches after a cached entry failure and retries in process otherwise', () => {
  const calls = [];
  const relaunch = () => calls.push('relaunch');
  const retryInProcess = () => { calls.push('in_process'); return Promise.resolve(); };

  assert.equal(routeStartupRetry({ requiresRelaunch: () => true, relaunch, retryInProcess }), 'relaunch');
  assert.deepEqual(calls, ['relaunch']);

  calls.length = 0;
  assert.equal(routeStartupRetry({ requiresRelaunch: () => false, relaunch, retryInProcess }), 'in_process');
  assert.deepEqual(calls, ['in_process']);
});

test('main routes the startup Retry action and the server entry import through the relaunch-aware loader', () => {
  assert.match(mainSource, /createModuleEntryLoader\(\s*\(\)\s*=>\s*import\('@openchamber\/web\/server\/index\.js'\)\s*\)/);
  assert.doesNotMatch(mainSource, /await import\('@openchamber\/web\/server\/index\.js'\)/,
    'a direct import bypasses the cached-failure detection');
  const retryBranch = mainSource.match(/if \(startupAction === 'retry-startup'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.match(retryBranch, /routeStartupRetry\(/);
  assert.match(retryBranch, /performConfirmedQuit\(\{ restart: true \}\)/);
  assert.doesNotMatch(retryBranch, /^\s*void startDesktopRuntime\(\);/m);
});
