// The candidate comparer's whole planted batch and its remaining command
// checks on the toys (docs/TESTING.md, package C0g): every planted fault of
// candidate-plants.mjs outside the per-push sample (the package's own, the
// C0g review's, the fix round's), each failing the check it names beside an
// unchanged copy that fails none; and every command check outside the
// per-push pair as processes (the reshaped engine passes and fails the exact
// rules, a planted engine and the cheating engines fail, a recording that did
// not pass its own checks, one read in part, one with items of some families
// only are inconclusive; a partial run asked for, of part of a recording or
// in file order only, exits 3 with `partial pass` and what it skipped on its
// last line, never 0; `--repeat` runs).
// Its name makes it a full-suite test (`validate:full`, `test:full` and CI's
// lanes run it; fast `validate` never does). The two files together run every
// planted fault once, which this one checks, and every one of the review's 39
// is planted, retired with its reason, or a family command plant. No product
// module or test runs here.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { capture, commandChecks, PER_PUSH_COMMANDS } from './candidate-checks.mjs';
import { CANDIDATE_PLANTS, CANDIDATE_RETIRED, PER_PUSH_PLANTS, REVIEW_PLANTS, runCandidatePlants } from './candidate-plants.mjs';
import { PLANTED } from './mutants.mjs';
import { createScratch } from './record.mjs';
import { recordReplayToys } from './replay.mjs';

test('every planted fault of the candidate comparer outside the per-push sample fails the check it names, and every command check outside it holds', { timeout: 20 * 60 * 1000 }, async (t) => {
  const scratch = createScratch('client-conformance-candidate-planted');
  let status = 'failed';
  t.after(() => scratch.finish(status));
  const rest = CANDIDATE_PLANTS.filter((plant) => !PER_PUSH_PLANTS.includes(plant.name)).map((plant) => plant.name);
  assert.equal(rest.length + PER_PUSH_PLANTS.length, CANDIDATE_PLANTS.length, 'the sample and this batch run every plant, each once');
  assert.equal(CANDIDATE_PLANTS.filter((plant) => plant.origin === 'C0g').length, 40, 'the package\'s own');
  assert.equal(CANDIDATE_PLANTS.filter((plant) => plant.origin === 'C0g fix').length, 12, 'the fix round\'s');
  assert.deepEqual(CANDIDATE_PLANTS.filter((plant) => plant.origin === 'C0g review 2').map((plant) => plant.name), ['n-nested-positions-free', 'n-opening-compared-only-if-both', 'n-extra-engine-groups-ignored', 'n-group-compared-only-if-both', 'n-clock-free-if-any-step-uniform', 'n-pending-group-not-compared'], 'the second review\'s six (its S1)');
  assert.equal(CANDIDATE_PLANTS.filter((plant) => plant.origin === 'C0g fix 2').length, 3, 'the second fix round\'s');
  const accounted = new Set([...CANDIDATE_PLANTS.filter((plant) => plant.origin === 'C0g review').map((plant) => plant.name), ...CANDIDATE_RETIRED.map((item) => item.name)]);
  const familyPlants = PLANTED.filter((mutant) => mutant.origin.startsWith('C0g fix:')).length;
  assert.equal(REVIEW_PLANTS.length, 39, 'the review planted 39');
  assert.deepEqual(REVIEW_PLANTS.filter((name) => !accounted.has(name) && !['i-census-items-lose-an-export', 'i-manifest-verdict-always-0'].includes(name)), [], 'each of the review\'s is planted or retired with its reason');
  assert.equal(familyPlants, 2, 'the review\'s two family command plants are mutants.mjs\'s');
  assert.ok(CANDIDATE_RETIRED.every((item) => item.why.trim()));
  const recording = await recordReplayToys({ workDir: path.join(scratch.dir, 'record') });
  assert.deepEqual(recording.incomplete, []);
  const captured = await capture({ recording });
  const { control, plants } = await runCandidatePlants(path.join(scratch.dir, 'plants'), { captured, recording, only: rest });
  assert.deepEqual(control.filter(([, problem]) => problem), [], 'the unchanged copy passes every check a plant names');
  assert.equal(plants.length, rest.length);
  assert.deepEqual(plants.filter((entry) => !entry.caught).map((entry) => `${entry.plant.name} (${entry.plant.check})${entry.error ? `: ${entry.error.slice(0, 300)}` : ''}`), []);
  const others = await commandChecks({ workDir: path.join(scratch.dir, 'commands'), recording, except: [...PER_PUSH_COMMANDS] });
  assert.ok(others.length >= 14, `${others.length} command checks`);
  assert.deepEqual(others.filter(([, problem]) => problem), []);
  status = 'passed';
});
