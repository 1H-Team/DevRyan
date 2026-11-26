// The replayer's whole planted batch on the toys (docs/TESTING.md, package
// C0d): every planted difference in the toy modules outside the per-push
// sample, each reported by its own check, and every planted difference in the
// replayer itself outside the sample (the package's own, the review's 21, the
// fix round's, C0e's and the C0e review's 20), each failing the copy's
// self-test where it names, and by the check it names where it names one. Its name makes it a full-suite test (`validate:full`, `test:full`
// and CI's lanes run it; fast `validate` never does). The two files together
// run every planted difference of replay-mutants.mjs once, which this one
// checks. No product module or test runs here.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createScratch } from './record.mjs';
import { recordReplayToys } from './replay.mjs';
import { REPLAYER_PLANT_SAMPLE, REPLAYER_PLANTS, replaySelfTest, runReplayerPlants, TOY_MUTANT_SAMPLE, TOY_MUTANTS } from './replay-mutants.mjs';

test('every planted difference of the replayer outside the per-push sample is reported where it must be', { timeout: 20 * 60 * 1000 }, async (t) => {
  const scratch = createScratch('client-conformance-replay-planted');
  let status = 'failed';
  t.after(() => scratch.finish(status));
  const toyRest = TOY_MUTANTS.filter((mutant) => !TOY_MUTANT_SAMPLE.includes(mutant.name)).map((mutant) => mutant.name);
  const plantRest = REPLAYER_PLANTS.filter((plant) => !REPLAYER_PLANT_SAMPLE.includes(plant.name)).map((plant) => plant.name);
  assert.equal(toyRest.length + TOY_MUTANT_SAMPLE.length, TOY_MUTANTS.length, 'the sample and this batch run every toy mutant, each once');
  assert.equal(plantRest.length + REPLAYER_PLANT_SAMPLE.length, REPLAYER_PLANTS.length, 'the sample and this batch run every replayer plant, each once');
  assert.ok(TOY_MUTANTS.length >= 20);
  assert.equal(REPLAYER_PLANTS.filter((plant) => plant.origin === 'C0d').length, 13, 'the package\'s own 13');
  assert.equal(REPLAYER_PLANTS.filter((plant) => plant.origin === 'C0d review').length, 21, 'all 21 of the review');
  assert.equal(REPLAYER_PLANTS.filter((plant) => plant.origin === 'C0d fix').length, 5, 'the fix round\'s 5');
  assert.ok(REPLAYER_PLANTS.filter((plant) => plant.origin === 'C0e').length >= 12, 'package C0e\'s, at least 12');
  // The C0e review's 20, each caught by the check it names (runReplayerPlants matches `check` in the failure).
  assert.equal(REPLAYER_PLANTS.filter((plant) => plant.origin === 'C0e review' && typeof plant.check === 'string').length, 20, 'all 20 of the C0e review, each naming its check');
  assert.equal(REPLAYER_PLANTS.filter((plant) => plant.origin === 'C0f' && typeof plant.check === 'string').length, 9, 'package C0f\'s nine on the transport paths, each naming its check');
  assert.equal(REPLAYER_PLANTS.filter((plant) => plant.origin === 'C0f fix' && typeof plant.check === 'string').length, 4, 'the C0f fix round\'s four: an immediate answer a generation late or early, wrappers not unified, new calls not paired');
  const recording = await recordReplayToys({ workDir: path.join(scratch.dir, 'record') });
  assert.deepEqual(recording.incomplete, []);
  const { failures } = await replaySelfTest({ workDir: path.join(scratch.dir, 'toys'), parts: ['toy-mutants'], mutants: toyRest, recording });
  assert.deepEqual(failures, [], 'each toy mutant is reported by its own check');
  const results = await runReplayerPlants(path.join(scratch.dir, 'plants'), { only: plantRest });
  assert.equal(results.length, plantRest.length);
  for (const { plant, caught, failures: found, error } of results) {
    assert.equal(error, undefined, `${plant.name}: ${error}`);
    assert.ok(caught, `${plant.name} must fail the self-test at ${plant.fails}${plant.check ? ` by ${plant.check}` : ''}; it failed at ${JSON.stringify(found.slice(0, 3))}`);
  }
  status = 'passed';
});
