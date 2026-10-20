import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeFinalDmgSmoke } from './release-final-dmg-smoke.mjs';

test('a qualified immutable DMG smoke requires prerequisites, ready UI, screenshot and physical shutdown', () => {
  const complete = { prerequisites: true, ready: true, composer: true, toolRoundTrip: true, screenshot: true, stopped: true };
  assert.deepEqual(gradeFinalDmgSmoke(complete), { passed: true, failures: [] });
  for (const key of Object.keys(complete)) assert.deepEqual(gradeFinalDmgSmoke({ ...complete, [key]: false }), { passed: false, failures: [key] });
});
