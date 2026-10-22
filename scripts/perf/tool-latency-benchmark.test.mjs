import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { parseToolLatencyArgs, summarize } from './tool-latency-benchmark.mjs';

test('parses tool-latency options and rejects invalid counts or unknown flags', () => {
  const options = parseToolLatencyArgs(['--runtime', 'lib', '--files', '10', '--seed-calls', '0', '--reads', '3', '--parallel', '4', '--count-git', '--out', 'r.json', '--keep']);
  assert.equal(options.runtime, path.resolve('lib'));
  assert.deepEqual([options.files, options.seedCalls, options.reads, options.parallel], [10, 0, 3, 4]);
  assert.equal(options.countGit, true);
  assert.equal(options.keep, true);
  assert.equal(options.out, path.resolve('r.json'));
  assert.throws(() => parseToolLatencyArgs(['--parallel', '0']), /--parallel/);
  assert.throws(() => parseToolLatencyArgs(['--reads', '1.5']), /--reads/);
  assert.throws(() => parseToolLatencyArgs(['--files']), /requires a value/);
  assert.throws(() => parseToolLatencyArgs(['--bogus']), /Unknown option/);
});

test('summarizes finite samples by percentile', () => {
  assert.deepEqual(summarize([]), { count: 0, p50: null, p90: null, max: null });
  assert.deepEqual(summarize([5, 1, 3, Number.NaN, 2, 4]), { count: 5, p50: 3, p90: 5, max: 5 });
});
