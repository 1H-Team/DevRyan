// The whole planted-difference batch of the client engine conformance harness
// (docs/TESTING.md): every planted difference of mutants.mjs that the per-push
// self-test's fixed sample (PER_PUSH_SAMPLE) does not run, each reported by its
// own check. Its name makes it a full-suite test: `validate:full`, `test:full`
// and CI's lanes run it, fast `validate` never does (the selector's
// full-suite-only name rule, FULL_SUITE_ONLY). Its subjects are copies of this directory and the toys
// only: no product test runs here, and nothing depends on how long anything
// takes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PER_PUSH_SAMPLE, PLANTED, runPlanted } from './mutants.mjs';
import { createScratch } from './record.mjs';

test('every planted difference outside the per-push sample is reported by its own check', async (t) => {
  const scratch = createScratch('client-conformance-planted');
  let status = 'failed';
  t.after(() => scratch.finish(status));
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('review:')).length, 38, 'all 38 of the review are planted');
  assert.equal(PLANTED.filter((mutant) => mutant.origin === 'builder').length, 9);
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('review 2:')).length, 10, 'the second review\'s planted differences not already in the list');
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('review 3:')).length, 11, 'all 11 of the third review are planted');
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('C0c:')).length, 21, 'package C0c: change sets, census, caller rule, slices, iterators');
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('C0c fix')).length, 34, 'the C0c fix round, the reviewer\'s ten missed planted differences among them');
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('C0c review 2,')).length, 3, 'the C0c second review\'s three missed planted differences, re-planted');
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('C0c second fix')).length, 3, 'the C0c second fix round: discovery callers and test functions');
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('C0c2 ')).length, 32, 'package C0c2: the per-case clock and the mock-module layer');
  const rest = PLANTED.filter((mutant) => !PER_PUSH_SAMPLE.includes(mutant.name)).map((mutant) => mutant.name);
  assert.equal(rest.length + PER_PUSH_SAMPLE.length, PLANTED.length, 'the sample and this batch run every planted difference, each once');
  const results = await runPlanted(scratch.dir, { concurrency: 6, only: rest });
  assert.equal(results.length, rest.length);
  for (const { mutant, differences, caught, error } of results) {
    assert.equal(error, undefined, `${mutant.name}: ${error}`);
    assert.ok(differences.length > 0, `${mutant.name}: no check reported it`);
    assert.ok(caught, `${mutant.name} must be reported by ${mutant.tool} at ${JSON.stringify(mutant.expect, (_key, value) => (value instanceof RegExp ? String(value) : value))}; got ${JSON.stringify(differences.slice(0, 4))}`);
  }
  status = 'passed';
});
