import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { baselineStartupSources, withStartupBaselineSources } from './startup-repair-comparison.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const files = ['packages/electron/entry.mjs', 'packages/ui/src/stores/useConfigStore.ts', 'packages/web/server/lib/opencode/runtime-host/runtime-bundle-lifecycle.js'];
const originals = await Promise.all(files.map(file => fs.readFile(path.join(root, file))));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-startup-comparison-'));
  try {
    for (let index = 0; index < files.length; index++) {
      await fs.mkdir(path.dirname(path.join(directory, files[index])), { recursive: true });
      await fs.writeFile(path.join(directory, files[index]), originals[index]);
    }
    const captureIdentity = async () => {
      const entries = await Promise.all(files.map(async file => ({ file, sha256: digest(await fs.readFile(path.join(directory, file))) })));
      entries.sort((a, b) => a.file.localeCompare(b.file));
      return { entries, sha256: digest(JSON.stringify(entries)) };
    };
    await operation({ directory, captureIdentity });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('baseline disables window, request overlap and proof reuse while retaining correctness gates', () => {
  const [entry, config, lifecycle] = baselineStartupSources(...originals.map(bytes => bytes.toString('utf8')));
  assert.ok(entry.includes("await import('./main.mjs')"));
  assert.ok(entry.includes('configureEarlyStartup'));
  assert.ok(entry.includes('showEarlyStartupFailure'));
  assert.ok(!entry.includes('!await showEarlyStartupWindow'));
  assert.ok(config.includes('await providersReady;'));
  assert.ok(config.includes('get().loadAgents({ directory, providersReady, signal })'));
  assert.ok(config.includes('signal?.throwIfAborted();'));
  assert.ok(config.includes('get().providersLoadStatus === "error"'));
  assert.ok(lifecycle.includes("const original = await verifyLaunch(current.descriptor.launch,'bundle-source');"));
  assert.throws(() => baselineStartupSources(entry, config, lifecycle), /optimization changed/);
});

test('baseline construction restores exact original bytes even when building fails', async () => fixture(async ({ directory, captureIdentity }) => {
  await assert.rejects(withStartupBaselineSources({ root: directory, runDirectory: path.join(directory, 'run'), captureIdentity,
    operation: async () => { throw new Error('fixture package failure'); } }), /fixture package failure/);
  for (let index = 0; index < files.length; index++) assert.deepEqual(await fs.readFile(path.join(directory, files[index])), originals[index]);
}));

test('concurrent edits are preserved and original recovery bytes remain available', async () => fixture(async ({ directory, captureIdentity }) => {
  const changed = path.join(directory, files[0]);
  await assert.rejects(withStartupBaselineSources({ root: directory, runDirectory: path.join(directory, 'run'), captureIdentity,
    operation: async () => { await fs.writeFile(changed, 'human edit'); } }), /restoration conflict/);
  assert.equal(await fs.readFile(changed, 'utf8'), 'human edit');
  assert.deepEqual(await fs.readFile(path.join(directory, files[1])), originals[1]);
  assert.deepEqual(await fs.readFile(path.join(directory, 'run/sources/entry.mjs')), originals[0]);
}));

test('an actual performance-only baseline is recorded and removed before candidate packaging', async () => fixture(async ({ directory, captureIdentity }) => {
  const before = await captureIdentity();
  const result = await withStartupBaselineSources({ root: directory, runDirectory: path.join(directory, 'run'), captureIdentity,
    operation: async () => { assert.notEqual((await captureIdentity()).sha256, before.sha256); return '/fixture/baseline-evidence.json'; } });
  assert.equal(result.result, '/fixture/baseline-evidence.json');
  assert.deepEqual(result.source, before);
  assert.deepEqual(await captureIdentity(), before);
}));


test('fresh flat native artifacts preserve the existing packaged target layout', async () => {
  const { qaNativeRuntimeResource } = await import('./package-electron.mjs');
  assert.deepEqual(qaNativeRuntimeResource('/fixture/runtime'), { from: '/fixture/runtime',
    to: 'revert-runtime/darwin-arm64', filter: ['native-bundle.json', 'DevRyan-*', '!**/DevRyan-opencode*'] });
});
