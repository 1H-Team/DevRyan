// Self-test of the ledger dual-run harness: one small recording of a confined
// edit through the product host, replayed against the product's ledger worker
// (no difference allowed) and against two copies with one planted difference
// each (a stored record's JSON key order; file stamps cut to microseconds),
// each of which must be reported by the check that names it; plus the
// identifier protocol's site table and the comparer's strictness on values it
// used to let through. The full run is
// `node scripts/ledger-dual-run/dual-run-harness.mjs` (docs/TESTING.md).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { compareTraces, createDifferences, createMasker, lockProblems } from './dual-run-compare.mjs';
import { createWorkspace, dualRun } from './dual-run.mjs';
import { createIdentityMap } from './dual-run-identity.mjs';
import { MUTANTS, buildMutant, catching } from './dual-run-mutants.mjs';
import { PRODUCT_LIB } from './dual-run-runner.mjs';
import { scenarioNamed } from './dual-run-scenarios.mjs';

const { siteOf } = createRequire(import.meta.url)('./dual-run-ids.cjs');

test('every random identifier the ledger draws has a protocol site name', () => {
  for (const file of ['session-mutations.js', 'session-mutation-files.js', 'session-changes-store.js', 'session-changes-trees.js', 'session-changes-snapshot.js', 'atomic-file.js']) {
    const lines = readFileSync(path.join(PRODUCT_LIB, file), 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (!/randomUUID\(/.test(text) || /^import /.test(text)) return;
      assert.ok(siteOf(file, `${text}\n${lines[index + 1] ?? ''}`), `${file}:${index + 1} draws an identifier no protocol site names: ${text.trim()}`);
    });
  }
});

test('the comparer tells undefined from null and compares background callbacks', () => {
  const trace = (value, extra = []) => ({ entries: [{ dir: 'h2w', message: { type: 'call', id: 1, method: 'cancelLease' } }, { dir: 'w2h', message: { type: 'result', id: 1, failed: false, value, steps: [] } }], untied: extra });
  const recording = { calls: { c: { generation: 0, seamID: 1, method: 'cancelLease' } }, generations: [trace({ $dr: 'undefined' })] };
  const run = { calls: { c: { generation: 0, seamID: 1 } }, generations: [trace(null, [{ dir: 'w2h', message: { type: 'callback', id: 9, target: { observer: 'onMaterialize' }, args: [{ planted: true }] } }])] };
  const differences = createDifferences();
  compareTraces({ recording, run, identities: createIdentityMap(), maskers: { a: createMasker(), b: createMasker() }, differences });
  assert.ok(differences.list.some((difference) => difference.category === 'call' && /"a":"undefined","b":"null"/.test(JSON.stringify(difference.detail))), JSON.stringify(differences.list));
  assert.ok(differences.list.some((difference) => difference.category === 'journal' && /background observers and callbacks/.test(JSON.stringify(difference.detail))), JSON.stringify(differences.list));
});

test('a stored stamp is judged by the harness\'s own observation of the file', () => {
  const observations = [{ stamps: new Map([['1:100:5:1700000000123456789:1700000000123456789:33188', 'project/a.js'], ['1:101:5:1700000000000000001:1700000000000000001:33188', 'project/b.js']]),
    inodes: new Map([['1:100', 'project/a.js'], ['1:101', 'project/b.js']]) }];
  const masker = createMasker({ observations });
  assert.equal(masker.stampToken('1:100:5:1700000000123456789:1700000000123456789:33188'), '<stamp project/a.js@0>');
  assert.match(masker.stampToken('1:100:5:1700000000123456000:1700000000123456000:33188'), /^<stamp project\/a\.js@0 differs in mtime,ctime size 5 /);
  assert.match(masker.stampToken('1:101:5:1700000000123456789:1700000000123456789:33188'), /^<stamp project\/b\.js@0 differs in mtime,ctime size 5 /);
  // A stamp no observation accounts for keeps its run-independent values and is counted.
  assert.notEqual(masker.stampToken('1:999:5:1:1:33188'), masker.stampToken('1:998:6:1:1:33188'));
  assert.equal(masker.unaccounted.length, 4);
  assert.equal(masker.stampToken('1:100'), '<identity project/a.js@0>');
  // A freed inode number is reused at once on Linux: an identity stored beside the full stamp of its file belongs to
  // the observation that stamp names, not to the first, older file that held the number. Alone, or beside another
  // file's stamp, it is still judged by the first observation of its number.
  const reused = createMasker({ observations: [
    { stamps: new Map([['1:100:41:1700000000000000001:1700000000000000001:33188', 'ledger/git/refs/x']]), inodes: new Map([['1:100', 'ledger/git/refs/x']]) },
    { stamps: new Map([['1:100:5:1700000000000000009:1700000000000000009:33188', 'project/a.js'], ['1:101:5:1700000000000000009:1700000000000000009:33188', 'project/b.js']]),
      inodes: new Map([['1:100', 'project/a.js'], ['1:101', 'project/b.js']]) }] });
  const stored = { identity: '1:100', stamp: '1:100:5:1700000000000000009:1700000000000000009:33188' };
  assert.deepEqual(reused.value({ published: stored }), { published: { identity: '<identity project/a.js@1>', stamp: '<stamp project/a.js@1>' } });
  assert.equal(reused.text(JSON.stringify(stored)), '{"identity":"<identity project/a.js@1>","stamp":"<stamp project/a.js@1>"}');
  // A file record's `published` entry carries the stamp as `observation`, without the mode.
  const published = { identity: '1:100', observation: '1:100:5:1700000000000000009:1700000000000000009', size: 5, path: 'a.js' };
  assert.deepEqual(reused.value({ published }), { published: { identity: '<identity project/a.js@1>', observation: '<stamp project/a.js@1>', size: 5, path: 'a.js' } });
  assert.equal(reused.text(JSON.stringify(published)), '{"identity":"<identity project/a.js@1>","observation":"<stamp project/a.js@1>","size":5,"path":"a.js"}');
  assert.equal(reused.value({ published: { identity: '1:100' } }).published.identity, '<identity ledger/git/refs/x@0>');
  assert.deepEqual(reused.value({ published: { identity: '1:100', stamp: '1:101:5:1700000000000000009:1700000000000000009:33188' } }),
    { published: { identity: '<identity ledger/git/refs/x@0>', stamp: '<stamp project/b.js@1>' } });
  // The stamp beside it matches no observation (the file changed again before the harness looked): the record's own
  // path still names the file among those that held the number. Another path, or none, leaves it judged alone.
  const moved = { identity: '1:100', stamp: '1:100:5:1700000000000000777:1700000000000000777:33188', path: 'a.js' };
  assert.equal(reused.value({ published: moved }).published.identity, '<identity project/a.js@1>');
  assert.match(reused.value({ published: moved }).published.stamp, /^<stamp ledger\/git\/refs\/x@0 differs in /);
  assert.equal(reused.value({ published: { ...moved, path: 'c.js' } }).published.identity, '<identity ledger/git/refs/x@0>');
  assert.equal(reused.value({ published: { ...moved, path: 's.js' } }).published.identity, '<identity ledger/git/refs/x@0>');
  const timeline = createMasker({ timeline: [{ start: 1000, end: 1010 }, { start: 1012, end: 1020 }] });
  assert.equal(timeline.timeLabel(1005), '<time in window 0>');
  assert.equal(timeline.timeLabel(1011), '<time after window 0>');
  assert.equal(timeline.timeLabel(1015), '<time in window 1>');
  assert.equal(timeline.timeLabel(999), null);
  // Order and equality of the times one record stores in one window.
  assert.notEqual(timeline.text('{"createdAt":1001,"updatedAt":1009}'), timeline.text('{"createdAt":1009,"updatedAt":1001}'));
  assert.notEqual(timeline.text('{"createdAt":1003,"updatedAt":1003}'), timeline.text('{"createdAt":1003,"updatedAt":1004}'));
  assert.equal(timeline.text('{"createdAt":1001,"updatedAt":1009}'), timeline.text('{"createdAt":1002,"updatedAt":1008}'));
});

test('owner.lock bytes are held to the documented format', () => {
  const lock = (raw) => ({ raw });
  assert.deepEqual(lockProblems(lock(`{"ownerToken":"${'a'.repeat(32)}","pid":7,"createdAt":1700000000123}\n`), 7), []);
  assert.match(lockProblems(lock(`{"pid":7,"createdAt":1700000000,"ownerToken":"${'a'.repeat(32)}"}`), 7)[0], /do not follow the format/);
  assert.match(lockProblems(lock(`{"ownerToken":"${'a'.repeat(32)}","pid":8,"createdAt":1700000000123}\n`), 7)[0], /names pid 8/);
});

test('a JavaScript replay matches its recording, and planted differences are reported by their own checks', async (t) => {
  const workspace = createWorkspace({ owner: 'ledger-dual-run-self-test' });
  let status = 'failed';
  t.after(() => workspace.finish(status));
  const planted = ['json-key-order', 'stamp-microseconds'].map((name) => MUTANTS.find((entry) => entry.name === name));
  const plantLog = (mutant) => path.join(workspace.dir, `plant-${mutant.name}.log`);
  const outcome = await dualRun({ workspace, scenario: scenarioNamed('smoke'), implementations: [
    { name: 'js-worker', libDir: PRODUCT_LIB, endpoint: { kind: 'worker' } },
    ...await Promise.all(planted.map(async (mutant) => ({ name: mutant.name, libDir: await buildMutant(mutant, workspace.dir), endpoint: { kind: 'worker' }, env: { LEDGER_DUAL_RUN_PLANT_LOG: plantLog(mutant) } }))),
  ] });
  const [same, ...rows] = outcome.outcomes;
  assert.ok(Object.keys(outcome.recording.calls).length >= 8, 'the recording holds the edit\'s calls');
  assert.deepEqual(same.differences, [], 'JavaScript against JavaScript');
  assert.equal(same.outcome, 'passed');
  for (const [index, mutant] of planted.entries()) {
    assert.ok(existsSync(plantLog(mutant)), `${mutant.name}: the planted code ran`);
    assert.equal(rows[index].outcome, 'failed');
    assert.ok(catching(mutant, rows[index].differences), `${mutant.name} is reported by its own check: ${JSON.stringify(rows[index].differences.slice(0, 3))}`);
  }
  status = 'passed';
});
