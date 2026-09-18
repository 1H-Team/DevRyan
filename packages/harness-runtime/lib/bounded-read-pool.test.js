import { expect, test } from 'bun:test';
import { createBoundedReadPool } from './bounded-read-pool.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('shares active reads and keeps one subscriber cancellation from aborting another', async () => {
  const pool = createBoundedReadPool({ concurrency: 1, maxQueued: 1 });
  const work = deferred(); let count = 0, signal;
  const firstAbort = new AbortController();
  const run = s => { count++; signal = s; return work.promise; };
  const first = pool.run('scope', run, firstAbort.signal).catch(e => e);
  const second = pool.run('scope', run);
  await Promise.resolve(); firstAbort.abort(); await first;
  expect(count).toBe(1); expect(signal.aborted).toBe(false);
  work.resolve('ok'); expect(await second).toBe('ok');
  expect(pool.snapshot()).toEqual({ active: 0, queued: 0, scopes: 0 });
  expect(await pool.run('scope', () => 'fresh')).toBe('fresh');
  await pool.drain();
});

test('bounds queued scopes and cancels abandoned queued work without running it', async () => {
  const pool = createBoundedReadPool({ concurrency: 1, maxQueued: 1 });
  const work = deferred(); const first = pool.run('one', () => work.promise);
  const abort = new AbortController(); let launched = false;
  const second = pool.run('two', () => { launched = true; }, abort.signal).catch(e => e);
  await expect(pool.run('three', () => {})).rejects.toMatchObject({ code: 'reconciliation_busy' });
  abort.abort(); await second; work.resolve(); await first; await pool.drain();
  expect(launched).toBe(false); expect(pool.snapshot().scopes).toBe(0);
});

test('last subscriber cancellation reaches active work and drain rejects new work', async () => {
  const pool = createBoundedReadPool(); const abort = new AbortController(); let stopped = false;
  const pending = pool.run('scope', signal => new Promise(resolve => signal.addEventListener('abort', () => { stopped = true; resolve(); })), abort.signal).catch(e => e);
  await Promise.resolve(); abort.abort(); await pending; await pool.drain();
  expect(stopped).toBe(true);
  await expect(pool.run('later', () => {})).rejects.toMatchObject({ code: 'reconciliation_busy' });
});
