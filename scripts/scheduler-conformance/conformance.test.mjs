// Self-test of the scheduler recorder (design file 30, package O0a). Its
// subjects are the harness's toy (toy/) and one product file for pass-set
// parity; every bun run uses one worker, and nothing it checks depends on how
// long anything takes (the toy fires racing timers itself, and at most one
// recorder timer is pending at a time). All bun work starts at once, the
// planted copies a few at a time, and each test awaits its part.
//
//   node --import=./scripts/test-isolation-preload.mjs --test scripts/scheduler-conformance/conformance.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { MANAGED_TASK_ID_PREFIX, MANAGED_WAVE_ID_PREFIX } from '../../packages/orchestration-runtime/codec-primitives.js';
import { CORPUS_CHECKS, findings, runToyChecks, TOY_CHECKS } from './checks.mjs';
import { buildMutant, MUTANTS, TOOL_CHECKS } from './mutants.mjs';
import { judgeOutput, parityExit, schedulerParity } from './parity.mjs';
import { createScratch, HARNESS_DIR, judgeRecording, PACKAGE_DIR, recordFiles, REPOSITORY_ROOT } from './record.mjs';
import { checkProvenance, EXIT, hiddenInputLines, importClosure, loadTarget, readContainer } from './trace.mjs';
import { checkVectors } from './vectors.mjs';

const TOY_DIR = path.join(HARNESS_DIR, 'toy');
const TOY_TARGET = path.join(TOY_DIR, 'target.json');
const toyFile = (name) => `./${path.relative(REPOSITORY_ROOT, path.join(TOY_DIR, name))}`;
const CORPORA = Object.freeze({
  toy: { files: [toyFile('toy-scheduler.toy.mjs')], env: { DEVRYAN_SCHEDULER_CONFORMANCE_TARGET: TOY_TARGET } },
  fixtures: { files: [toyFile('toy-fixtures.toy.mjs'), toyFile('toy-empty.toy.mjs')], env: { DEVRYAN_SCHEDULER_CONFORMANCE_TARGET: TOY_TARGET } },
  refused: { files: [toyFile('toy-refused.toy.mjs')], env: { DEVRYAN_SCHEDULER_CONFORMANCE_TARGET: path.join(TOY_DIR, 'target-refused.json') } },
});
const PLANTED_AT_ONCE = 10;

const scratch = createScratch('scheduler-conformance-self-test');
let failed = false;
after(() => { scratch.finish(failed ? 'failed' : 'passed'); });
const workDir = (name) => path.join(scratch.dir, name);
const guarded = (name, body) => test(name, async () => { try { await body(); } catch (error) { failed = true; throw error; } });
const record = (corpus, options) => recordFiles({ ...CORPORA[corpus], cwd: REPOSITORY_ROOT, parallel: 1, ...options });

// Everything that runs bun starts now; the tests below await their part.
const toy = record('toy', { runs: 2, workDir: workDir('toy') });
const fixtures = record('fixtures', { runs: 2, workDir: workDir('fixtures') });
const refused = record('refused', { runs: 1, workDir: workDir('refused') });
const parity = schedulerParity({ files: ['./scheduler.admission.test.js'], cwd: PACKAGE_DIR, workDir: workDir('parity'), parallel: 1 });
/** Runs `jobs` (functions returning promises) at most `limit` at a time, results in order. */
async function pool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const index = next++; results[index] = await jobs[index](); } };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}
const planted = pool(MUTANTS.map((mutant) => async () => {
  const copy = buildMutant({ harnessDir: HARNESS_DIR, runDir: workDir('mutants'), mutant });
  if (mutant.kind === 'tool') return { mutant, copy };
  const recordings = {};
  for (const corpus of mutant.corpora) {
    const recorded = await record(corpus, { runs: 1, workDir: workDir(`mutant-${mutant.name}-${corpus}`), recorder: path.join(copy, 'recorder.mjs'), plainRun: false });
    recordings[corpus] = recorded.recordings[0];
  }
  return { mutant, copy, recordings };
}), PLANTED_AT_ONCE);
// A rejection is reported by the test that awaits it, not as an unhandled one first.
for (const pending of [toy, fixtures, refused, parity, planted]) pending.catch(() => {});

guarded('codec vectors: ManagedOrchestrationError and DOMException keep name, message and code, in Node and in Bun', () => {
  assert.deepEqual(checkVectors(), []);
  const bun = spawnSync('bun', [path.join(HARNESS_DIR, 'vectors.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(bun.status, 0, `${bun.stdout}${bun.stderr}`);
});

guarded('target specs: every hidden input is named, unreached or accepted; the default persistence the recorder supplies is the scheduler\'s, by anchor', () => {
  for (const spec of [path.join(HARNESS_DIR, 'target.json'), TOY_TARGET]) {
    const target = loadTarget(spec);
    const gaps = hiddenInputLines(target, importClosure(target.module)).filter((line) => !line.site && !line.reason);
    assert.deepEqual(gaps.map((line) => `${path.basename(line.file)}:${line.line} ${line.text}`), [], `${path.basename(path.dirname(spec))}/${path.basename(spec)}`);
    assert.equal(target.defaultPersistence.length > 0, true);
  }
  const real = loadTarget(path.join(HARNESS_DIR, 'target.json'));
  assert.deepEqual(real.defaults, { createTaskId: MANAGED_TASK_ID_PREFIX, createLeaseToken: 'dvr_lease_', createWaveId: MANAGED_WAVE_ID_PREFIX });
  assert.equal(importClosure(real.module).length > 10, true);
  assert.deepEqual([real.savedState.export, real.savedState.port], ['encodeLedgerSnapshot', 'persistence.save']);
  // A default persistence that changed shape (here: a load that answers something else) fails the spec loudly.
  const directory = workDir('changed-default');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'm.mjs'), 'const createDefaultPersistence = () => ({ async load() { return {}; }, async save() {} });\n');
  writeFileSync(path.join(directory, 'spec.json'), JSON.stringify({ module: 'm.mjs', defaultPersistence: ['async load() { return null; }'] }));
  assert.throws(() => loadTarget(path.join(directory, 'spec.json')), /default persistence text .* occurs 0 times in m\.mjs/);
});

guarded('the toy is recorded twice byte-equal and complete, with provenance that holds, and every named check holds', async () => {
  const result = await toy;
  const judged = judgeRecording(result);
  assert.deepEqual({ differences: judged.differences, incomplete: judged.incomplete, unstable: judged.unstable }, { differences: [], incomplete: [], unstable: [] });
  assert.equal(judged.code, EXIT.pass);
  const [first, second] = result.recordings;
  assert.equal(first.containers.length, 1);
  assert.equal(first.containers[0].text, second.containers[0].text);
  const { header, cases } = readContainer(first.containers[0].text);
  assert.match(header.recorder, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(header.modules), ['scripts/scheduler-conformance/toy/toy-scheduler.mjs']);
  assert.equal(checkProvenance(header, { root: REPOSITORY_ROOT, harnessDir: HARNESS_DIR }), null);
  assert.equal(typeof header.bun, 'string');
  assert.equal(cases.length, 20);
  const results = runToyChecks(first.containers);
  assert.deepEqual(Object.entries(results).filter(([, finding]) => finding !== null), []);
  assert.deepEqual(Object.keys(results), Object.keys(TOY_CHECKS));
  assert.equal(CORPUS_CHECKS['recorder-digest']({ toy: first }), null);
  // The one noted case keeps its outcome and is listed as information.
  assert.deepEqual(first.info.map((entry) => entry.note), ['mutated-by-receiver']);
});

guarded('fixtures: effects after the recording was written, code handed to the test, an unwrapped function (a class instance\'s method included), a mutated input, a handed-out value that crosses back in changed, and overlapping tests are unrecordable; a file that builds no scheduler exits 2', async () => {
  const result = await fixtures;
  const judged = judgeRecording(result);
  assert.equal(judged.code, EXIT.inconclusive);
  assert.deepEqual(judged.differences, []);
  assert.equal(CORPUS_CHECKS.fixtures({ fixtures: result.recordings[0] }), null);
});

guarded('refused: hidden reads at an unnamed line, in tail position and in listeners (in the test, in a later test that builds none, in the hooks, after the recording was written, through the direct helper) are recorder errors, a test\'s own call of the direct helper is not, and a Date.now() spin fails loudly', async () => {
  const result = await refused;
  assert.equal(CORPUS_CHECKS.refused({ refused: result.recordings[0] }), null);
  const judged = judgeRecording(result);
  assert.equal(judged.code, EXIT.fail);
  assert.deepEqual(judged.differences.map((entry) => entry.detail.replace(/^.*:\d+ /, '')), ['spins on Date.now() waiting for time to pass #1: passed without the recorder, failed with it; the recording is no reference']);
});

guarded('parity output: the runner\'s own times are left out, a random identifier only when plain runs vary on it, any other line counts', () => {
  const plain = 'x.test.js:\n(pass) a [1.00ms]\n  ownerID: "dvr_save_8256a1"\nRan 1 test across 1 file. [1.00s]\n';
  const again = 'x.test.js:\n(pass) a [2.00ms]\n  ownerID: "dvr_save_b07c3e"\nRan 1 test across 1 file. [1.00s]\n';
  assert.equal(judgeOutput({ baselineOutput: plain, secondBaselineOutput: again, recordedOutput: 'x.test.js:\n(pass) a [9.00ms]\n  ownerID: "dvr_save_44fe09"\nRan 1 test across 1 file. [3.50s]\n' }).difference, null);
  assert.notEqual(judgeOutput({ baselineOutput: plain, secondBaselineOutput: plain, recordedOutput: 'x.test.js:\n(pass) a [1.00ms]\n  ownerID: "dvr_save_44fe09"\nRan 1 test across 1 file. [1.00s]\n' }).difference, null);
  assert.notEqual(judgeOutput({ baselineOutput: plain, secondBaselineOutput: again, recordedOutput: `${plain}retry in 500ms\n` }).difference, null);
});

guarded('pass-set parity holds on scheduler.admission.test.js', async () => {
  const result = await parity;
  assert.deepEqual({ differences: result.differences, incomplete: result.incomplete }, { differences: [], incomplete: [] });
  assert.equal(parityExit(result), EXIT.pass);
  assert.equal(result.runs[0].tests > 10, true);
});

guarded('every planted recorder bug is reported by its own check, and an unchanged copy passes them all', async () => {
  const runs = await planted;
  const baseline = (await toy).recordings[0].containers;
  const context = (name) => ({ containers: baseline, scratch: workDir(`tool-${name}`), root: REPOSITORY_ROOT, harnessDir: HARNESS_DIR });
  const missed = [];
  for (const { mutant, copy, recordings } of runs) {
    if (mutant.kind === 'tool') {
      if (await TOOL_CHECKS[mutant.check](copy, context(mutant.name)) === null) missed.push(`${mutant.name} was not reported by ${mutant.check}`);
      continue;
    }
    const results = findings(recordings);
    if (mutant.check === null) {
      assert.deepEqual(Object.entries(results).filter(([, finding]) => finding !== null), [], 'the unchanged copy fails a check');
      assert.deepEqual(Object.keys(results).filter((name) => name !== 'toy-complete').sort(), [...Object.keys(TOY_CHECKS), ...Object.keys(CORPUS_CHECKS)].sort());
      for (const [name, check] of Object.entries(TOOL_CHECKS)) assert.equal(await check(copy, context(`unchanged-${name}`)), null, `the unchanged copy fails tool check ${name}`);
    } else if (!results[mutant.check]) missed.push(`${mutant.name} was not reported by ${mutant.check}`);
  }
  assert.deepEqual(missed, []);
  // Every check that a planted bug names exists, and every named check is some planted bug's.
  const named = new Set([...Object.keys(TOY_CHECKS), ...Object.keys(CORPUS_CHECKS), ...Object.keys(TOOL_CHECKS), 'provenance']);
  assert.deepEqual(MUTANTS.filter((mutant) => mutant.check !== null && !named.has(mutant.check)).map((mutant) => mutant.name), []);
  const used = new Set(MUTANTS.map((mutant) => mutant.check));
  assert.deepEqual([...Object.keys(TOOL_CHECKS), ...Object.keys(CORPUS_CHECKS)].filter((name) => !used.has(name)), []);
});
