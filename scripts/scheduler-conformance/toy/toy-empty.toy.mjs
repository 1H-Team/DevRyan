// A test file that loads the scheduler and builds none: recording it must be inconclusive (exit 2).
import { expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './toy-scheduler.mjs';

test('builds no scheduler', () => {
  expect(typeof createManagedTaskScheduler).toBe('function');
});
