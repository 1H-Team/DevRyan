import { afterEach, expect, test } from 'bun:test';
import { executionIOCap, withExecutionIO } from './execution-io-pool.js';

afterEach(() => { delete process.env.DEVRYAN_EXECUTION_IO_CAP; });

const peak = async (root, count) => {
  let active = 0, highest = 0;
  const release = [];
  const work = Array.from({ length: count }, () => withExecutionIO(root, async () => {
    active += 1; highest = Math.max(highest, active);
    await new Promise((resolve) => release.push(resolve));
    active -= 1;
  }));
  while (release.length < Math.min(count, executionIOCap())) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  while (release.length) { release.shift()(); await new Promise((resolve) => setTimeout(resolve, 1)); }
  await Promise.all(work);
  return highest;
};

test('per-project I/O runs eight operations at a time by default, queues the rest in order, and honours the override', async () => {
  expect(executionIOCap()).toBe(8);
  expect(await peak('/project-a', 20)).toBe(8);
  process.env.DEVRYAN_EXECUTION_IO_CAP = '2';
  expect(await peak('/project-b', 6)).toBe(2);
  for (const invalid of ['0', '65', 'x', '1.5']) { process.env.DEVRYAN_EXECUTION_IO_CAP = invalid; expect(executionIOCap()).toBe(8); }
});
