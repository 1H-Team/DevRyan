// The closure check on a fixed sample (design file 30 §4.3, package O0c), in
// the full suite and CI: the whole scenario corpus and three of the
// scheduler's own test files, each recorded twice and replayed against a
// second copy of the package; then every planted difference and replayer bug
// against that sample and the awaiting shapes. The sample is what a small CI
// runner can afford on every push. The whole corpus (all 21 scheduler test
// files, the package's other files, and the plants against all of it) is the
// closure tool run with --plants: minutes of many cores, run by hand when the
// scheduler or this harness changes (docs/TESTING.md).
//
// Every child process is bounded: a recording, replay or plant that does not
// finish is killed and named in the failure.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { judgePlants, runClosure, runPlants } from './closure.mjs';
import { createScratch } from './record.mjs';
import { defaultPlantWorkers } from './replay-mutants.mjs';
import { EXIT } from './trace.mjs';

/** The sampled test files: leases and admission (the launch path), and recovery (where a late settlement delivery shows on a real recording). */
const SAMPLE_TESTS = ['./scheduler.lease.test.js', './scheduler.admission.test.js', './scheduler.recovery.test.js'];
const CHILD_MS = 300_000;
const scratch = createScratch('scheduler-conformance-closure-full');
let passed = 0;
after(() => { scratch.finish(passed === 2 ? 'passed' : 'failed'); });

let closure;
test('every recording of the sample is reproduced or classified by its marks, nothing differs', { timeout: 900_000 }, async () => {
  closure = await runClosure({ sources: ['tests', 'scenarios'], names: { tests: SAMPLE_TESTS }, workers: defaultPlantWorkers(), workDir: scratch.dir, deadlineMs: CHILD_MS });
  const { judged } = closure;
  assert.equal(judged.code, EXIT.pass, JSON.stringify(judged.problems.slice(0, 5)));
  assert.equal(judged.counts.different, 0);
  // Every scenario whole; every test case reproduced whole or up to its first busy input, with the reason stated.
  assert.equal(judged.table.scenarios.reproduced, judged.cases.filter((entry) => entry.source === 'scenarios').length);
  assert.ok(judged.table.scenarios.reproduced > 0);
  assert.equal(closure.containers.tests.length, SAMPLE_TESTS.length);
  assert.ok(judged.table.tests.reproduced + judged.table.tests.partial > 0);
  for (const entry of judged.cases.filter((item) => ['partial', 'crossed', 'unrecordable'].includes(item.outcome))) assert.ok(entry.detail || entry.reason, entry.id);
  passed += 1;
});

test('every planted difference and replayer bug is reported by its own check on the sample', { timeout: 1_500_000 }, async () => {
  assert.ok(closure, 'the closure ran');
  const plants = await runPlants({ scenarios: closure.containers.scenarios[0], tests: closure.containers.tests, workDir: scratch.dir, deadlineMs: CHILD_MS });
  const found = judgePlants(plants);
  for (const line of found.lines) console.log(line);
  assert.deepEqual(found.problems, []);
  passed += 1;
});
