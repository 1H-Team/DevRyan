import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQa } from './run.mjs';

test('invalid runtime/scenario fails before launching processes or writing artifacts', async () => {
  await assert.rejects(runQa({ holdMs: -1 }), /inspection hold/);
  await assert.rejects(runQa({ holdMs: Infinity }), /inspection hold/);
  await assert.rejects(runQa({ runtime: 'unknown' }), /QA runtime/);
  await assert.rejects(runQa({ runtime: 'electron', scenario: 'mobile' }), /QA scenario/);
  await assert.rejects(runQa({ scenario: 'unknown' }), /QA scenario/);
});
