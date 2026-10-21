import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhaseTimings } from './phase-timings.mjs';

test('qualification timings include awaited work, failure and synchronous cleanup', async () => {
  let time = 0; const logs = [];
  const timer = createPhaseTimings({ now: () => time, log: line => logs.push(line) });
  assert.equal(await timer.measure('baseline-download', async () => { time += 25; return 'verified'; }), 'verified');
  await assert.rejects(timer.measure('candidate', async () => { time += 50; throw new Error('private fixture data'); }));
  timer.measureSync('scratch-cleanup', () => { time += 70; });
  assert.deepEqual(timer.phases, [
    { phase: 'baseline-download', offsetMs: 0, durationMs: 25, passed: true },
    { phase: 'candidate', offsetMs: 25, durationMs: 50, passed: false },
    { phase: 'scratch-cleanup', offsetMs: 75, durationMs: 70, passed: true },
  ]);
  assert.ok(logs.every(line => !line.includes('private')));
});
