import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { scratchParent } from '../qa/run-root.mjs';
import { gateCompactionLoad, latencySummary, parseCompactionLoadArgs, runCompactionLoad } from './ancestry-compaction-load.mjs';

test('parses load options and rejects invalid bounds or unknown flags', () => {
  const options = parseCompactionLoadArgs(['--runtime', 'lib', '--edits', '12', '--blocks', '16', '--seed', '3', '--baseline-calls', '4',
    '--label', 'base', '--out', 'r.json', '--max-p99-ms', '300', '--max-lateness-ms', '200', '--keep-artifacts']);
  assert.equal(options.runtime, path.resolve('lib'));
  assert.deepEqual([options.edits, options.blocks, options.seed, options.baselineCalls, options.maxP99Ms, options.maxLatenessMs, options.keep],
    [12, 16, 3, 4, 300, 200, true]);
  assert.deepEqual([options.out, options.label], [path.resolve('r.json'), 'base']);
  const defaults = parseCompactionLoadArgs([]);
  assert.deepEqual([defaults.edits, defaults.blocks, defaults.seed, defaults.baselineCalls, defaults.maxP99Ms, defaults.maxLatenessMs, defaults.keep],
    [70, 40, 0, 10, 250, 250, false]);
  for (const value of ['0', '501', '1.5']) assert.throws(() => parseCompactionLoadArgs(['--edits', value]), /--edits/);
  assert.throws(() => parseCompactionLoadArgs(['--baseline-calls', '0']), /--baseline-calls/);
  assert.throws(() => parseCompactionLoadArgs(['--max-p99-ms', '0']), /--max-p99-ms/);
  assert.throws(() => parseCompactionLoadArgs(['--out']), /requires a value/);
  assert.throws(() => parseCompactionLoadArgs(['--bogus']), /Unknown option/);
});

test('summaries use nearest-rank percentiles', () => {
  assert.deepEqual(latencySummary(Array.from({ length: 100 }, (_, index) => 100 - index)), { count: 100, p50: 50, p99: 99, max: 100 });
  assert.deepEqual(latencySummary([7, Number.NaN]), { count: 1, p50: 7, p99: 7, max: 7 });
  assert.deepEqual(latencySummary([]), { count: 0, p50: null, p99: null, max: null });
});

test('the gate bounds direct admission, its finish and lease cleanup, not confined begin or publish', () => {
  const kinds = (p99) => Object.fromEntries(['admitMs', 'finishDirectMs', 'beginMs', 'finishMs', 'cleanupMs'].map((kind) => [kind, { count: 3, p50: 1, p99, max: p99 }]));
  const passing = { during: kinds(100), latenessMs: { count: 9, p50: 1, p99: 5, max: 9 }, ancestry: { before: 10, after: 2, fenced: true }, textUnchanged: true };
  const bounds = { maxP99Ms: 250, maxLatenessMs: 250 };
  assert.deepEqual(gateCompactionLoad(passing, bounds), { passed: true, failures: [] });
  const slowConfined = { ...passing, during: { ...passing.during, beginMs: { count: 3, p50: 1, p99: 900, max: 900 }, finishMs: { count: 3, p50: 1, p99: 900, max: 900 } } };
  assert.equal(gateCompactionLoad(slowConfined, bounds).passed, true);
  const failing = { during: { ...kinds(300), cleanupMs: { count: 0, p50: null, p99: null, max: null } }, latenessMs: { count: 9, p50: 1, p99: 5, max: 400 },
    ancestry: { before: 10, after: 10, fenced: false }, textUnchanged: false };
  assert.deepEqual(gateCompactionLoad(failing, bounds).failures, ['no call completed during compaction', 'admitMs p99 300 ms > 250 ms',
    'finishDirectMs p99 300 ms > 250 ms', 'timer lateness 400 ms > 250 ms', 'ancestry not compacted (10 -> 10 entries)',
    'the compacted document projects different text']);
});

test('a short run compacts the planted closures, keeps the text and removes its scratch', { timeout: 120_000 }, async () => {
  // Other benchmarks share this parent and may run concurrently: look only at this run's own prefix.
  const parent = scratchParent('perf');
  const own = () => (fs.existsSync(parent) ? fs.readdirSync(parent) : []).filter((name) => name.startsWith('ancestry-compaction-'));
  const before = new Set(own());
  const report = await runCompactionLoad(parseCompactionLoadArgs(['--edits', '12', '--blocks', '8', '--baseline-calls', '2', '--label', 'test']));
  assert.equal(report.identity.source.label, 'test');
  assert.ok(report.ancestry.before >= 1024, `planted ${report.ancestry.before} entries`);
  assert.ok(report.ancestry.after < report.ancestry.before);
  assert.deepEqual([report.ancestry.fenced, report.ancestry.stamped, report.textUnchanged, report.ancestry.failures], [true, true, true, []]);
  for (const phase of ['alone', 'after']) assert.equal(report[phase].cleanupMs.count, 2);
  assert.ok(report.during.cleanupMs.count >= 1);
  assert.equal(report.loadAverage.start.length, 3);
  assert.deepEqual(own().filter((name) => !before.has(name)), []);
});
