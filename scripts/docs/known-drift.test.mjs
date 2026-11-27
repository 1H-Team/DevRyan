import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareWithBaseline, formatBaseline, parseBaseline, pruneBaseline, readBaseline } from './known-drift.mjs';

const anchor = { check: 'anchor', doc: 'docs/a.md', token: '#gone' };
const env = { check: 'env', doc: 'docs/a.md', token: 'DEVRYAN_FIXTURE_DEAD' };
const exported = { check: 'export', doc: 'lib/DOCUMENTATION.md', token: 'a.js: removed' };

function baselineFile(t, contents) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devryan-docs-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'known-drift.json');
  writeFileSync(file, contents);
  return file;
}

test('formats one sorted, unique entry per line in check order', () => {
  assert.equal(formatBaseline([env, anchor, env, exported]), [
    '[',
    '  {"check":"anchor","doc":"docs/a.md","token":"#gone"},',
    '  {"check":"export","doc":"lib/DOCUMENTATION.md","token":"a.js: removed"},',
    '  {"check":"env","doc":"docs/a.md","token":"DEVRYAN_FIXTURE_DEAD"}',
    ']',
    '',
  ].join('\n'));
  assert.equal(formatBaseline([]), '[]\n');
});

test('rejects malformed entries and flags non-canonical files', t => {
  assert.throws(() => parseBaseline('{}'), /expected an array/);
  assert.throws(() => parseBaseline('[{"check":"anchor","doc":"a.md","token":"#x","line":3}]'), /invalid entry/);
  assert.throws(() => parseBaseline('[{"check":"links","doc":"a.md","token":"#x"}]'), /invalid entry/);
  assert.equal(readBaseline(baselineFile(t, formatBaseline([anchor, env]))).canonical, true);
  assert.equal(readBaseline(baselineFile(t, `[\n  ${JSON.stringify(env)},\n  ${JSON.stringify(anchor)}\n]\n`)).canonical, false);
});

test('new violations and vanished entries both fail; known ones are counted', () => {
  const { added, stale, counts } = compareWithBaseline([anchor, anchor, exported], [anchor, env]);
  assert.deepEqual(added, [exported]);
  assert.deepEqual(stale, [env]);
  assert.deepEqual(counts, { anchor: { known: 1, added: 0 }, 'bun-run': { known: 0, added: 0 }, export: { known: 0, added: 1 }, env: { known: 0, added: 0 } });
});

test('prune removes only stale entries and never adds current violations', t => {
  const file = baselineFile(t, formatBaseline([anchor, env]));
  const { entries } = readBaseline(file);
  const { stale } = compareWithBaseline([anchor, exported], entries);
  assert.deepEqual(pruneBaseline(file, entries, stale), [env]);
  assert.equal(readFileSync(file, 'utf8'), formatBaseline([anchor]));
});
