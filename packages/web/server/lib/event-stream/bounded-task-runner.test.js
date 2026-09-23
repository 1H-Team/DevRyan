import { describe, expect, it } from 'vitest';
import { createBoundedTaskRunner } from './bounded-task-runner.js';

describe('bounded background task runner', () => {
  it('bounds concurrency and drops the oldest queued work without blocking callers', async () => {
    const releases = [];
    const started = [];
    const drops = [];
    const runner = createBoundedTaskRunner({ concurrency: 2, maxQueued: 3, onDrop: (count) => drops.push(count) });
    for (let index = 0; index < 8; index += 1) {
      runner.run(() => new Promise((resolve) => { started.push(index); releases.push(resolve); }));
    }
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(runner.stats()).toEqual({ active: 2, queued: 3, dropped: 3 });
    expect(drops).toEqual([1, 2, 3]);
    while (releases.length) { releases.shift()(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    expect(started).toEqual([0, 1, 5, 6, 7]);
    expect(runner.stats()).toMatchObject({ active: 0, queued: 0, dropped: 3 });
  });

  it('isolates task failures', async () => {
    const errors = [];
    const runner = createBoundedTaskRunner({ concurrency: 1, onError: (error) => errors.push(error.message) });
    let ran = false;
    runner.run(async () => { throw new Error('boom'); });
    runner.run(async () => { ran = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(errors).toEqual(['boom']);
    expect(ran).toBe(true);
  });
});
