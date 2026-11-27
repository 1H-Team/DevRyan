// The closure check on the pilot (BH4; full suite and CI only, by its name),
// within a full test's CPU budget: the write-lock scenario on the reference
// (R), a second reference on a fresh data root (R') and the JavaScript
// candidate adapter (J), every row passed; and a few planted differences
// (plants.mjs) behind the adapter, run as a candidate (C) against those
// recordings: the lost update, a PATH-resolved child and a request to a
// handed-out stub (each caught by its named rule), and a child started by
// absolute path that exits at once (under the named limit, never caught by a
// difference). The whole pilot with every plant is the command
// closure-plants.mjs (docs/TESTING.md).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { JS_CANDIDATE, runClosure } from './closure.mjs';
import { interruptTeardown, liveGroups } from './driver.mjs';
import { GROUPS } from './groups.mjs';
import { ALL_PLANTS, plantResult, plantedFiles } from './plants.mjs';
import { createBackendRun } from './run-scratch.mjs';
import { WRITE_LOCK } from './scenarios/magic-prompts.mjs';

const NAME = 'magic-prompts';
const GROUP = GROUPS[NAME];
const DEADLINE = { timeout: 1_200_000 };
const plant = (id) => ALL_PLANTS.find((entry) => entry.id === id);
// The GET plants, moved to the write lock's first step (the same change; its own scenario is the command's).
const onWriteLock = (id) => ({ ...plant(id), scenario: WRITE_LOCK.id, ...(plant(id).step ? { step: 'get-seeded' } : {}) });
const CHOSEN = [plant('lock-admits-two-writers'), onWriteLock('child-process-path'), onWriteLock('outbound-to-stub'), onWriteLock('child-process')];

describe('the closure check on the pilot\'s write lock', { concurrency: true, ...DEADLINE }, () => {
  let run;
  let base;
  before(async () => {
    run = createBackendRun({ owner: 'backend-conformance-closure', signals: 'exit' });
    base = await runClosure({ run, scenario: WRITE_LOCK, name: NAME, group: GROUP });
  }, DEADLINE);
  after(async () => {
    await interruptTeardown();
    assert.deepEqual(liveGroups(), []);
    try { run?.finish('passed'); } catch { /* finished */ }
  });

  test('R, R\' and J: every row passed; separate roots and HOMEs; the envelope only on J; J\'s concurrent results each a serialisation of R', () => {
    for (const row of base.rows) assert.equal(row.outcome, 'passed', `${row.id}: ${row.reason}\n${[...row.differences, ...row.inconclusive].join('\n')}`);
    const { recordings, comparisons } = base;
    for (const name of ['data-root', 'home']) {
      const values = Object.values(recordings).map((recording) => recording.values.arm.find((entry) => entry.name === name).value);
      assert.equal(new Set(values).size, values.length, values.join(', '));
    }
    for (const step of recordings.js.steps) for (const record of step.exchanges) if (record.response) assert.ok(record.response.request.headers.some(([header]) => header === 'X-DevRyan-Harness-Envelope'), step.id);
    for (const step of recordings.reference.steps) for (const record of step.exchanges) if (record.response) assert.ok(!record.response.request.headers.some(([header]) => /^x-devryan-harness/i.test(header)), step.id);
    for (const id of ['two-puts', 'put-and-delete']) assert.ok(comparisons.closure.steps.get(id).notes.some((note) => /equals the serialisation/.test(note)), id);
    // J was observed from outside (stubs, PATH shim, process group) on every exchange it was sent.
    assert.deepEqual(recordings.js.observation.seenBy, ['path-shim', 'stubs', 'process-group']);
    assert.ok(recordings.js.observation.exchanges > 0);
    // R takes the group's block coverage for the census, from the start and at every exchange; R' and J do not.
    assert.ok(recordings.reference.coverage.some((take) => take.phase === 'start') && recordings.reference.coverage.some((take) => take.seq > 0), 'R records block coverage');
    assert.deepEqual([recordings.second.coverage.length, recordings.js.coverage.length], [0, 0]);
    // Rule W's Date lag is measured on both references (their taps), never on J.
    for (const key of ['reference', 'second']) assert.ok(Number.isFinite(recordings[key].dateLagMs) && recordings[key].dateLag.timer >= 0, key);
    assert.equal(recordings.js.dateLagMs, 0);
  });

  test('planted differences: each caught by its named rule, or under the named limit', DEADLINE, async (t) => {
    const table = await Promise.all(CHOSEN.map(async (entry) => {
      const { handlers, compose } = plantedFiles(run, entry);
      const result = plantResult(entry, await runClosure({ run, scenario: WRITE_LOCK, name: NAME, group: GROUP, candidateCommand: [process.execPath, JS_CANDIDATE, '--group', NAME, '--handlers', handlers, ...(compose ? ['--compose', compose] : [])], candidateLabel: `planted-${entry.id}`, recordings: { reference: base.recordings.reference, second: base.recordings.second, js: base.recordings.js } }));
      return { entry, result, asExpected: entry.expect === 'caught' ? result.matches : result.outcome === 'escaped' };
    }));
    t.diagnostic(table.map(({ entry, result }) => `${result.outcome} ${entry.id} (expected ${entry.expect}): ${result.by ?? '-'}`).join('\n'));
    assert.deepEqual(table.filter((row) => !row.asExpected).map((row) => `${row.entry.id}: ${row.result.outcome} ${row.result.by}`), []);
  });
});
