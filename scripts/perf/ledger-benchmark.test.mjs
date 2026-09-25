import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { parseLedgerBenchmarkArgs, summarize } from './ledger-benchmark.mjs';

test('parses benchmark options and rejects invalid counts or unknown flags', () => {
  const options = parseLedgerBenchmarkArgs(['--repo', 'a', '--runtime', 'b', '--iterations', '2', '--warm-calls', '4', '--prewarm', '--keep', '--out', 'r.json']);
  assert.equal(options.repo, path.resolve('a'));
  assert.equal(options.runtime, path.resolve('b'));
  assert.equal(options.iterations, 2);
  assert.equal(options.warmCalls, 4);
  assert.equal(options.prewarm, true);
  assert.equal(options.keep, true);
  assert.equal(options.out, path.resolve('r.json'));
  assert.throws(() => parseLedgerBenchmarkArgs(['--iterations', '0']), /--iterations/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--warm-calls', '1.5']), /--warm-calls/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--repo']), /requires a value/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--bogus']), /Unknown option/);
});

test('summarizes finite samples with an even-count median', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { count: 4, min: 1, p50: 2.5, max: 4 });
  assert.deepEqual(summarize([5, null, Number.NaN]), { count: 1, min: 5, p50: 5, max: 5 });
  assert.deepEqual(summarize([]), { count: 0, min: null, p50: null, max: null });
});
