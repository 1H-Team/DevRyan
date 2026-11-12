// Isolation canary: proves this runner starts every test process with the
// private environment of scripts/test-isolation-guard.mjs. It resolves the
// home folder and the DevRyan and OpenCode roots the way product code does and
// requires each to lie inside the run's private root, never the real home.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canaryProblems, isolationCanary } from '../../../scripts/test-isolation-guard.mjs';

test('the home folder and every DevRyan and OpenCode root resolve inside the private test root', async () => {
  const report = await isolationCanary();
  assert.deepEqual(canaryProblems(report), []);
  assert.equal(report.gitIdentity, 'tests@devryan.invalid');
});
