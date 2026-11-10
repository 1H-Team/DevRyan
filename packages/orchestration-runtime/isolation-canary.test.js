// Isolation canary: proves this runner starts every test process with the
// private environment of scripts/test-isolation-guard.mjs. It resolves the
// home folder and the DevRyan and OpenCode roots the way product code does and
// requires each to lie inside the run's private root, never the real home.
import { expect, test } from 'bun:test';

import { canaryProblems, isolationCanary } from '../../scripts/test-isolation-guard.mjs';

test('the home folder and every DevRyan and OpenCode root resolve inside the private test root', async () => {
  const report = await isolationCanary();
  expect(canaryProblems(report)).toEqual([]);
  expect(report.gitIdentity).toBe('tests@devryan.invalid');
});
