// The closure check on a fixed sample (design file 30 §4.3, package O0c), in
// the full suite and CI: the whole scenario corpus and three of the
// scheduler's own test files, each recorded twice and replayed against a
// second copy of the package; and the census over the sample's recordings,
// manifests and verdicts (package O0e): inconclusive, since a sample is not
// the whole corpus, with nothing failing and every launch situation the
// oracles need judged. The sample is what a small CI runner can afford on
// every push (about twenty CPU-seconds).
//
// Not here since O0e fix round 1: the planted differences and replayer bugs
// against this sample (about six times the rest of this file's cost). The
// per-push replayer self-test catches every one of them on its own smaller
// recording; what only this sample showed (every plant against the whole
// scenario corpus and three real test files, and a settlement delivered late
// differing on a real recording) is the whole-corpus run's, by hand: the
// closure tool or the census tool with --plants, when the scheduler or this
// harness changes (docs/TESTING.md).
//
// Every child process is bounded: a recording or replay that does not finish
// is killed and named in the failure.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { censusLines, closureResults, CONTRACT_FILE, loadContract, loadWaivers, productSurface, runCensus, WAIVER_FILE, wholeCorpus } from './census.mjs';
import { runClosure, SAMPLE_TESTS } from './closure.mjs';
import { createScratch } from './record.mjs';
import { readManifestText } from './recording-manifest.mjs';
import { defaultPlantWorkers } from './replay-mutants.mjs';
import { EXIT } from './trace.mjs';

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

test('the census of the sample: inconclusive (not the whole corpus), nothing failing, every launch situation judged', async () => {
  assert.ok(closure, 'the closure ran');
  const { contract, problems } = loadContract(CONTRACT_FILE);
  assert.deepEqual(problems, []);
  const { waivers, problems: waiverProblems } = loadWaivers(WAIVER_FILE);
  const report = runCensus({
    contract, waivers, waiverProblems, surface: await productSurface(contract), results: closureResults(closure.judged), expected: await wholeCorpus(), closureCode: closure.judged.code,
    manifests: new Map(Object.entries(closure.directories).map(([source, directory]) => [source, readManifestText(directory)])),
    containers: Object.entries(closure.containers).flatMap(([source, files]) => files.map((file) => ({ source, file }))),
  });
  for (const line of censusLines(report, { waivers }).slice(-3)) console.log(line);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.problems.map((problem) => problem.check), ['corpus-incomplete']);
  assert.equal(report.code, EXIT.inconclusive);
  assert.equal(report.cases.judged, closure.judged.counts.reproduced + closure.judged.counts.partial);
  const unjudged = report.items.filter((item) => item.kind === 'launch' && item.judged === 0).map((item) => item.name);
  assert.deepEqual(unjudged, [], 'the sample is the launch path: every launch situation of the contract has a judged case');
  passed += 1;
});
