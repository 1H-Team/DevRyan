import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { parseLedgerBenchmarkArgs, summarize } from './ledger-benchmark.mjs';
import { phaseTotals, parseProcessSample } from './ledger-profile-worker.mjs';

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

test('profile bounds and companion opt-in are explicit', () => {
  const options = parseLedgerBenchmarkArgs(['--profile', '--companion', '--timeout-ms', '60000']);
  assert.equal(options.profile, true);
  assert.equal(options.companion, true);
  assert.equal(options.timeoutMs, 60000);
  assert.throws(() => parseLedgerBenchmarkArgs(['--companion']), /requires --profile/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--profile', '--companion', '--runtime', 'another-runtime']), /alternate --runtime/);
  for (const timeout of ['0', '999', '900001', 'oops']) assert.throws(() => parseLedgerBenchmarkArgs(['--timeout-ms', timeout]), /--timeout-ms/);
});

test('phase summaries avoid counting repeated slow events and preserve nested phase overlap', () => {
  assert.deepEqual(phaseTotals([
    { phase: 'ledger_commit', state: 'completed', elapsedMs: 3000 },
    { phase: 'admission', steps: 'preparation:1/5000,ledger_commit:2/3000,queue_wait:2/0' },
    { phase: 'admission', steps: 'ledger_commit:1/30,garbage' },
  ]), { preparation: { count: 1, elapsedMs: 5000 }, ledger_commit: { count: 3, elapsedMs: 3030 }, queue_wait: { count: 2, elapsedMs: 0 } });
});

test('companion process samples label missing data and parse minutes, hours and days', () => {
  assert.deepEqual(parseProcessSample(' 2048 00:01.25\n'), { rssMiB: 2, cpuMs: 1250 });
  assert.deepEqual(parseProcessSample('1024 01:02:03'), { rssMiB: 1, cpuMs: 3723000 });
  assert.deepEqual(parseProcessSample('1024 2-01:02:03'), { rssMiB: 1, cpuMs: 176523000 });
  assert.equal(parseProcessSample(''), null);
});

test('summarizes finite samples with an even-count median', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { count: 4, min: 1, p50: 2.5, max: 4 });
  assert.deepEqual(summarize([5, null, Number.NaN]), { count: 1, min: 5, p50: 5, max: 5 });
  assert.deepEqual(summarize([]), { count: 0, min: null, p50: null, max: null });
});
