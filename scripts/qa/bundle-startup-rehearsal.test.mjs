import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultControlRoot, rehearseBundleStartup } from './bundle-startup-rehearsal.mjs';

test('a machine without an installed runtime bundle skips the rehearsal', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bundle-rehearsal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = [];
  assert.deepEqual(await rehearseBundleStartup({ controlRoot: root, log: line => lines.push(line) }), { status: 'skipped' });
  assert.match(lines[0], /skipped: no installed runtime bundle/);
});

test('the control root follows the runtime selector environment', () => {
  assert.equal(defaultControlRoot({ DEVRYAN_RUNTIME_BUNDLE_ROOT: '/x/bundles' }), '/x/bundles');
  assert.equal(defaultControlRoot({ XDG_STATE_HOME: '/state' }), path.join('/state', 'devryan', 'runtime-bundles'));
});
