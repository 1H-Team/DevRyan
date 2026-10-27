import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { parseToolLatencyArgs, summarize, runToolLatencyBenchmark } from './tool-latency-benchmark.mjs';

test('parses tool-latency options and rejects invalid counts or unknown flags', () => {
  const options = parseToolLatencyArgs(['--runtime', 'lib', '--files', '10', '--seed-calls', '0', '--reads', '3', '--parallel', '4', '--count-git', '--out', 'r.json', '--keep']);
  assert.equal(options.runtime, path.resolve('lib'));
  assert.deepEqual([options.files, options.seedCalls, options.reads, options.parallel], [10, 0, 3, 4]);
  assert.equal(options.countGit, true);
  assert.equal(options.keep, true);
  assert.equal(options.out, path.resolve('r.json'));
  assert.equal(options.writers, 1);
  assert.equal(options.host, false);
  assert.equal(parseToolLatencyArgs(['--host']).host, true);
  assert.equal(parseToolLatencyArgs(['--writers', '2']).writers, 2);
  assert.throws(() => parseToolLatencyArgs(['--writers', '9']), /--writers/);
  assert.throws(() => parseToolLatencyArgs(['--parallel', '0']), /--parallel/);
  assert.throws(() => parseToolLatencyArgs(['--reads', '1.5']), /--reads/);
  assert.throws(() => parseToolLatencyArgs(['--files']), /requires a value/);
  assert.throws(() => parseToolLatencyArgs(['--bogus']), /Unknown option/);
});

test('summarizes finite samples by percentile', () => {
  assert.deepEqual(summarize([]), { count: 0, p50: null, p90: null, max: null });
  assert.deepEqual(summarize([5, 1, 3, Number.NaN, 2, 4]), { count: 5, p50: 3, p90: 5, max: 5 });
});

test('pairs isolated edit phases and evidence-preserving scan counts with their call and wave', async () => {
  const report = await runToolLatencyBenchmark(parseToolLatencyArgs(['--files', '8', '--seed-calls', '0', '--reads', '0', '--bursts', '0', '--edits', '2', '--writers', '2']));
  assert.equal(report.samples.length, 4);
  assert.equal(new Set(report.samples.map(sample => sample.callID)).size, 4);
  for (const sample of report.samples) {
    assert.ok(sample.phases['edit.total'] >= sample.phases['edit.finish']);
    assert.equal(sample.units['finish.files'], 8);
    assert.equal(sample.units['finish.inspected'], 1);
    assert.equal(sample.units['finish.reused'], 7);
    assert.equal(sample.units['finish.touched'], 1);
    assert.ok(Number.isFinite(sample.steps['finish.materialize']));
    assert.equal(report.waves[sample.wave].wave, sample.wave);
  }
  assert.equal(report.phases['edit.finish'].count, 4);
});
