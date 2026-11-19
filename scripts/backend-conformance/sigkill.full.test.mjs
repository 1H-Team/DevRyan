// SIGKILL of the harness, many times (BH2 fix; full suite and CI only, by its
// name): the driver run is killed while a request is in flight (or, on the
// real group host, between two requests), while the arm is frozen for a
// snapshot, and while a restarted arm is frozen; on the fake candidate and on
// the real group host. Each time: with the keeper alone, no arm group and no
// keeper is left; with the keeper killed as well, the frozen arm stays stopped
// until the next run's sweep, which kills it and removes the run. The fast
// self-test does each case once; this file repeats them.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createBackendRun } from './run-scratch.mjs';
import { sigkillOnce } from './toy/sigkill-run.mjs';

const DEADLINE = { timeout: 1_500_000 };
const REPEATS = { fake: 8, reference: 3 };
const BATCH = 6;

async function repeated(t, arm) {
  const run = createBackendRun({ owner: 'backend-conformance-sigkill', signals: 'exit' });
  let status = 'failed';
  t.after(() => { try { run.finish(status); } catch { /* finished */ } });
  const cases = [];
  for (let repeat = 0; repeat < REPEATS[arm]; repeat += 1) for (const mode of ['hang', 'frozen', 'restart']) for (const keeperToo of [false, true]) cases.push({ mode, keeperToo, repeat });
  const results = [];
  for (let index = 0; index < cases.length; index += BATCH) {
    results.push(...await Promise.all(cases.slice(index, index + BATCH).map((entry, offset) => sigkillOnce({ ...entry, arm, parent: run.makeDirectory(`parent-${index + offset}`) }))));
  }
  for (const result of results) {
    const where = `${arm} ${result.mode}${result.keeperToo ? ' (keeper killed too)' : ''}: ${result.describe}`;
    if (result.mode !== 'hang') assert.equal(result.frozenAtKill, true, `${where}: frozen when killed`);
    if (!result.keeperToo) assert.equal(result.groupGoneAlone, true, where);
    if (result.keeperToo && result.mode !== 'hang') assert.equal(result.frozenAfterKill, true, `${where}: still stopped without the keeper`);
    assert.deepEqual([result.groupsAfterSweep, result.runAfterSweep, result.keepersAlive], [[], false, []], where);
  }
  t.diagnostic(`${arm}: ${results.length} SIGKILLs, every arm group and keeper gone`);
  status = 'passed';
}

describe('SIGKILL of the harness leaves no arm and no keeper', { concurrency: true, ...DEADLINE }, () => {
  test('the fake candidate, every kill point, with and without the keeper', DEADLINE, (t) => repeated(t, 'fake'));
  test('the real group host, every kill point, with and without the keeper', DEADLINE, (t) => repeated(t, 'reference'));
});
