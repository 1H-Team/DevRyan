// Self-test of the process candidate (process-candidate.mjs, process-run.mjs;
// plan package OR2), with no Rust: one recording of F1-fanout-1 (made here,
// never tracked) replayed against fake scheduler processes that speak the
// protocol (toy/process-fake.mjs). Checked: a process that refuses every case
// makes every case `not-ported`, never a pass, and the run exits 2, never 0; a
// process that speaks another protocol version, ends without an answer or
// answers with a line that is no JSON makes the case `different` by
// `candidate-process` and the run exits 1; and the run's judgement on fixed
// results (every case reproduced: 0; one refused: 2; one different: 1;
// nothing: 2). The Rust candidate's own run is the manual command in
// docs/TESTING.md (no CI lane builds it).
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withDeadline } from './bounded.mjs';
import { recordQuick } from './closure.mjs';
import { judgeProcessRun, runProcess } from './process-run.mjs';
import { createScratch } from './record.mjs';
import { prepareCopy } from './replay.mjs';
import { EXIT } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'toy', 'process-fake.mjs');
const TESTS = 3;
const DEADLINE_MS = 120_000;
const scratch = createScratch('scheduler-conformance-process-candidate-test');
let passed = 0;
let files;
let copyDir;

before(async () => {
  const recorded = await withDeadline(recordQuick({ workDir: path.join(scratch.dir, 'record'), scenarios: ['F1-fanout-1'] }), DEADLINE_MS, 'the recording of F1-fanout-1');
  assert.deepEqual(recorded.problems, []);
  files = recorded.scenarios;
  copyDir = prepareCopy(scratch.dir);
});
after(() => { scratch.finish(passed === TESTS ? 'passed' : 'failed'); });

const fakeRun = (mode) => withDeadline(runProcess({ files, copyDir, command: process.execPath, args: [FAKE, mode] }), DEADLINE_MS, `the replay against the fake process (${mode})`);

test('a process that refuses every case: every case not-ported, the run exit 2', async () => {
  const results = await fakeRun('refuse');
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'not-ported');
  assert.equal(results[0].check, 'not-ported');
  assert.match(results[0].detail, /the fake refuses every case/);
  const judged = judgeProcessRun(results);
  assert.equal(judged.code, EXIT.inconclusive);
  assert.deepEqual(judged.members, { initialize: { 'not-ported': 1 }, submit: { 'not-ported': 1 } });
  passed += 1;
});

test('a process that breaks the protocol: the case different by candidate-process, the run exit 1', async () => {
  for (const mode of ['version', 'exit', 'garbage']) {
    const results = await fakeRun(mode);
    assert.equal(results[0].outcome, 'different', mode);
    assert.equal(results[0].check, 'candidate-process', mode);
    assert.equal(judgeProcessRun(results).code, EXIT.fail, mode);
  }
  passed += 1;
});

test('the run\'s judgement: 0 only when every case was judged and none differs', () => {
  const result = (outcome) => ({ id: `case ${outcome}`, outcome, members: ['submit'] });
  assert.equal(judgeProcessRun([result('reproduced'), result('partial')]).code, EXIT.pass);
  assert.equal(judgeProcessRun([result('reproduced'), result('not-ported')]).code, EXIT.inconclusive);
  assert.equal(judgeProcessRun([result('reproduced'), result('inconclusive')]).code, EXIT.inconclusive);
  assert.equal(judgeProcessRun([result('reproduced'), result('not-ported'), result('different')]).code, EXIT.fail);
  assert.equal(judgeProcessRun([]).code, EXIT.inconclusive);
  assert.equal(judgeProcessRun([result('partial')]).code, EXIT.inconclusive);
  passed += 1;
});
