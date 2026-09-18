import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeMemoryMonitor } from '../runtime-memory-monitor.mjs';

test('bounds periodic samples, reports pressure transitions, and excludes unexpected data', () => {
  let time = 0, used = 20, stopped = false; const records = [];
  const monitor = createRuntimeMemoryMonitor({ log: r => records.push(r), role: 'fixture', version: 'test',
    now: () => time, readMemory: () => ({ heapUsed: used, heapLimit: 100, rss: 200 }),
    getWork: () => ({ active: 2, queued: 1, responseBytes: 7, prompt: 'must not appear', token: 'must not appear' }),
    schedule: () => 1, cancel: () => { stopped = true; } });
  monitor.sample(); assert.equal(records.length, 1);
  used = 85; monitor.sample(); assert.equal(records.at(-1).pressure, true);
  used = 75; monitor.sample(); assert.equal(records.length, 2);
  used = 65; monitor.sample(); assert.equal(records.at(-1).pressure, false);
  time += 60000; monitor.sample(); assert.equal(records.length, 4);
  assert.equal(records[0].active, 2); assert.equal('prompt' in records[0], false); assert.equal('token' in records[0], false);
  monitor.stop(); assert.equal(stopped, true);
});

test('an unavailable diagnostic sink cannot crash startup or its interval', () => {
  let poll;
  const monitor = createRuntimeMemoryMonitor({ log: () => { throw new Error('sink unavailable'); },
    schedule: callback => { poll = callback; }, cancel: () => {}, now: () => 0 });
  assert.doesNotThrow(() => poll());
  monitor.stop();
});
