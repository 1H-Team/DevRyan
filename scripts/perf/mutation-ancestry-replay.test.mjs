import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { ancestryCounts, createReplayFixture, decodeV1Rows, encodeV1Rows, parseMutationAncestryArgs, runReplay, summarizeReplay } from './mutation-ancestry-replay.mjs';

test('parses replay options and rejects invalid bounds or unknown flags', () => {
  const options = parseMutationAncestryArgs(['--runtime', 'lib', '--edits', '12', '--blocks', '16', '--seed', '3', '--label', 'base', '--out', 'r.json',
    '--max-apply-ms', '1000', '--max-pages-mib', '10']);
  assert.equal(options.runtime, path.resolve('lib'));
  assert.deepEqual([options.edits, options.blocks, options.seed, options.maxApplyMs, options.maxPagesMiB], [12, 16, 3, 1000, 10]);
  assert.equal(options.out, path.resolve('r.json'));
  assert.equal(options.label, 'base');
  const defaults = parseMutationAncestryArgs([]);
  assert.deepEqual([defaults.edits, defaults.blocks, defaults.seed, defaults.maxApplyMs, defaults.maxPagesMiB], [70, 40, 0, null, null]);
  for (const value of ['0', '501', '1.5']) assert.throws(() => parseMutationAncestryArgs(['--edits', value]), /--edits/);
  for (const value of ['7', '401']) assert.throws(() => parseMutationAncestryArgs(['--blocks', value]), /--blocks/);
  assert.throws(() => parseMutationAncestryArgs(['--max-apply-ms', '0']), /--max-apply-ms/);
  assert.throws(() => parseMutationAncestryArgs(['--out']), /requires a value/);
  assert.throws(() => parseMutationAncestryArgs(['--bogus']), /Unknown option/);
});

test('the fixture is deterministic and seed 0 reproduces the preliminary 56 315-byte file', () => {
  const first = createReplayFixture({ blocks: 40, seed: 0 });
  const second = createReplayFixture({ blocks: 40, seed: 0 });
  assert.equal(first.render().length, 56_315);
  assert.equal(first.render(), second.render());
  assert.notEqual(createReplayFixture({ blocks: 40, seed: 1 }).render(), first.render());
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((edit) => first.target(edit)), [5, 5, 6, 5, 5, 6]);
  const before = first.render();
  first.edit(1);
  assert.notEqual(first.render(), before);
});

test('v1 row replica repeats metadata per 32 KiB chunk, skips empty text and round-trips', () => {
  const run = { id: 'a', start: 10, text: 'x'.repeat(70_000), owner: 'op', deletedBy: ['op2'], replaces: [{ id: 'b', start: 0, length: 3 }] };
  const rows = encodeV1Rows([run, { ...run, id: 'empty', text: '' }]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.start), [10, 32_778, 65_546]);
  for (const row of rows) assert.deepEqual([row.id, row.owner, row.deletedBy, row.replaces], ['a', 'op', ['op2'], run.replaces]);
  assert.equal(decodeV1Rows(rows).map((row) => row.text).join(''), run.text);
});

test('summaries count ancestry and apply the optional gates', () => {
  assert.deepEqual(ancestryCounts([{ replaces: [1, 2] }, { replaces: [] }, { replaces: [3] }]), { runs: 3, replacesTotal: 3, replacesMax: 2 });
  const edits = [{ applyMs: 12, pageBytes: 1_048_576, replacesTotal: 4 }, { applyMs: 30, pageBytes: 3 * 1_048_576, replacesTotal: 9 }];
  const passed = summarizeReplay(edits, { maxApplyMs: 100, maxPagesMiB: 5 });
  assert.equal(passed.passed, true);
  assert.deepEqual([passed.maxApplyMs, passed.finalPagesMiB, passed.finalReplacesTotal], [30, 3, 9]);
  const failed = summarizeReplay(edits, { maxApplyMs: 20, maxPagesMiB: 2 });
  assert.equal(failed.passed, false);
  assert.equal(failed.failures.length, 2);
});

test('a short replay against the current runtime records identity and per-edit growth', async () => {
  const options = parseMutationAncestryArgs(['--edits', '3', '--blocks', '8']);
  const report = await runReplay(options);
  assert.equal(report.edits.length, 3);
  assert.ok(['v1-replica', 'runtime'].includes(report.encoding));
  assert.match(report.identity.runtime.moduleSha256, /^[a-f0-9]{64}$/);
  assert.match(report.identity.fixture.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.identity.fixture.blocks, 8);
  assert.ok(report.edits.every((row) => row.runs > 0 && row.pageBytes > 0 && row.applyMs >= 0));
  assert.equal(report.summary.passed, true);
});
