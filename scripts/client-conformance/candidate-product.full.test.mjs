// The candidate comparer on a sample of the product's recordings (package C0g;
// full suite only: `validate:full`, `test:full` and CI's lanes run it, fast
// `validate` never does). It records eight product test files whose cases hold
// what the freedoms are about (delivery groups whose members' continuations
// the recorder forwards, immediate answers, clock reads of both sources,
// draws, timers pending at a case's end, a stateful family's notifications),
// for eight families they reach (a partial run, asked for as one, so a pass
// of what it judged exits 3, never 0, and names what it skipped), and
// requires: the order the comparer lays every recorded case of the sample
// out in agrees with the recorder's own call and timer counters (the C0g
// review 2's cross-check); the TypeScript engine reproduces every recorded
// case under the candidate rules, as the closure
// does under the exact ones; the reshaped engine (a process: it runs the
// TypeScript engine as its child and gives its answers another shape)
// reproduces every case under the candidate rules, needing both freedoms,
// while the exact rules tell it from the recording; and every planted engine
// just outside a freedom is different, applied to the TypeScript engine's own
// answers (among them the C0g review's B1: an effect moved past a later test
// call held in the same delivery, which the sample's event-pipeline cases
// give a place). The whole product corpus is the documented manual command
// (`candidate.mjs --product`, docs/TESTING.md). It runs the product's tests,
// so a product edit can fail it: a finding for the harness owners.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { deliveryContext, OUTSIDE_CHECKS } from './candidate-checks.mjs';
import { candidateFrom, PRODUCT_CONTRACT } from './candidate.mjs';
import { compareCandidate } from './candidate-compare.mjs';
import { EXIT } from './candidate-census.mjs';
import { recordFamilies } from './family-run.mjs';
import { PRODUCT_CENSUS, PRODUCT_PORT_MAP, PRODUCT_SETUP, UI_DIR } from './product.mjs';
import { readContainer } from './container.mjs';
import { createScratch, HARNESS_DIR } from './record.mjs';
import { readContainerDir } from './replay.mjs';
import * as replayCompare from './replay-compare.mjs';
import { OUTSIDE, reshape } from './reshape.mjs';

/** The sample: product test files (relative to packages/ui) and the families they are recorded for. */
export const SAMPLE_FILES = Object.freeze([
  'src/sync/event-pipeline.test.ts',
  'src/sync/bootstrap-global.test.ts',
  'src/sync/child-store.status-subscription.test.ts',
  'src/sync/session-creation.test.ts',
  'src/sync/abort-retry-guard.test.ts',
  'src/sync/selection-store.test.ts',
  'src/sync/bootstrap-session-list.test.ts',
  'src/sync/__tests__/event-reducer.test.ts',
]);
export const SAMPLE_FAMILIES = Object.freeze(['abort-guard', 'bootstrap', 'child-store', 'directory-bootstrap-request', 'event-pipeline', 'reducer', 'selection-store', 'session-creation']);

test('the candidate comparer on a sample of the product: the TypeScript and the reshaped engine reproduce it, the exact rules and the planted engines do not', { timeout: 20 * 60 * 1000 }, async (t) => {
  const scratch = createScratch('client-conformance-candidate-product');
  let status = 'failed';
  t.after(() => scratch.finish(status));
  const out = path.join(scratch.dir, 'containers');
  const recorded = await recordFamilies({ setup: PRODUCT_SETUP, targets: [...SAMPLE_FILES], runs: 2, families: [...SAMPLE_FAMILIES], workDir: path.join(scratch.dir, 'record'), out, parallel: PRODUCT_SETUP.parallel });
  assert.equal(recorded.code, EXIT.pass, `the sample records cleanly: ${JSON.stringify([...recorded.report.incomplete, ...recorded.report.failures].slice(0, 3))}`);
  const setup = { directory: out, portMapFile: PRODUCT_PORT_MAP, censusFile: PRODUCT_CENSUS, contractFile: PRODUCT_CONTRACT, cwd: UI_DIR, families: [...SAMPLE_FAMILIES], modes: ['file', 'isolated'], partial: true };
  // Every family the sample records a case of must have a judged case (the manifest's families with a recorded case).
  assert.deepEqual(Object.entries(recorded.report.families).filter(([, row]) => row.outcomes.recorded > 0).map(([name]) => name).sort(), [...SAMPLE_FAMILIES]);

  // The order the comparer lays a recorded case out in (caseLayout), held against the recorder's own counters: along
  // it every call number and timer id rises and every settle opens after its call, in every recorded case.
  const counted = { cases: 0, calls: 0, timers: 0, settles: 0 };
  for (const { text } of readContainerDir(out)) {
    for (const record of readContainer(text).cases) {
      if (record.outcome !== 'recorded' || !Array.isArray(record.steps) || !record.steps.length) continue;
      const found = replayCompare.layoutCounterCheck(record.steps);
      assert.deepEqual(found.violations, [], record.id);
      counted.cases += 1;
      for (const key of ['calls', 'timers', 'settles']) counted[key] += found[key];
    }
  }
  assert.ok(counted.cases >= 60 && counted.calls > 0 && counted.timers > 0 && counted.settles > 0, `the counters checked ${JSON.stringify(counted)}`);

  // A partial run asked for: its judged part passing exits 3, with no inconclusive line and what it skipped named.
  const partialPass = (outcome, label) => {
    assert.equal(outcome.code, EXIT.inconclusive, `${label}: ${[...outcome.inconclusive, ...outcome.unstable, ...outcome.failures].slice(0, 3).join('\n')}`);
    assert.deepEqual([...outcome.inconclusive, ...outcome.unstable, ...outcome.failures], [], label);
    assert.ok(outcome.partial.some((line) => /holds part of a recording only \(families /.test(line)), `${label}: ${JSON.stringify(outcome.partial)}`);
  };
  // The TypeScript engine, keeping each reproduced case with its answer for the planted engines below.
  const pairs = [];
  const typescript = await candidateFrom({ ...setup, capture: (kase, replayed, options) => { pairs.push({ kase, replayed, unordered: options.unordered }); } });
  partialPass(typescript, 'the TypeScript engine');
  const reproduced = typescript.runs[0].result.cases.filter((kase) => kase.outcome === 'reproduced').length;
  assert.ok(reproduced >= 60, `${reproduced} sample cases reproduced`);

  // The reshaped engine, a process of its own.
  const reshaped = await candidateFrom({ ...setup, engine: { name: 'reshaped', command: process.execPath, args: [path.join(HARNESS_DIR, 'reshaped-engine.mjs'), 'reshaped'], cwd: UI_DIR } });
  partialPass(reshaped, 'the reshaped engine');
  const used = { group: 0, clock: 0 };
  for (const kase of reshaped.runs[0].result.cases) for (const entry of Object.values(kase.modes)) for (const name of entry.freedoms ?? []) used[name] += 1;
  assert.ok(used.group > 0 && used.clock > 0, `the reshaped engine needs both freedoms on the sample: ${JSON.stringify(used)}`);

  // Offline, on the TypeScript engine's own answers: the reshaped answer differs by the exact rules, and each planted
  // engine just outside a freedom differs by the candidate ones wherever it applies.
  const contextOf = (kase) => deliveryContext(kase, replayCompare);
  let exactDiffers = 0;
  for (const pair of pairs) {
    const answer = reshape(structuredClone(pair.replayed), contextOf(pair.kase));
    assert.deepEqual(compareCandidate(pair.kase, answer, { unordered: pair.unordered }).differences, [], pair.kase.id);
    if (compareCandidate(pair.kase, answer, { unordered: pair.unordered, rules: 'exact' }).differences.length) exactDiffers += 1;
  }
  assert.ok(exactDiffers >= 20, `the exact rules tell ${exactDiffers} reshaped answers from the recording`);
  const applies = {};
  for (const outside of OUTSIDE_CHECKS.filter((item) => !item.synthetic || item.synthetic === 'b1')) {
    let applied = 0;
    for (const pair of pairs) {
      const context = contextOf(pair.kase);
      const answer = OUTSIDE[outside.name](reshape(structuredClone(pair.replayed), context), context);
      if (!answer) continue;
      applied += 1;
      const result = compareCandidate(pair.kase, answer, { unordered: pair.unordered });
      assert.ok(result.differences.length, `${outside.name} reproduces ${pair.kase.id}`);
      if (outside.check) assert.ok(result.differences.some((item) => item.check === outside.check), `${outside.name} on ${pair.kase.id}: ${result.differences[0].check}`);
    }
    assert.ok(applied > 0, `${outside.name} applies to no sample case`);
    applies[outside.name] = applied;
  }
  // B1 of the C0g review: the sample's event-pipeline cases with a test call held between a port call and its
  // immediate answer (the review found such moves reproduced in 10 case-modes of 4 cases of the whole product).
  assert.ok(applies['outside-async-past-later-input'] >= 4, `outside-async-past-later-input applies to ${applies['outside-async-past-later-input']} sample case-modes`);
  status = 'passed';
});
