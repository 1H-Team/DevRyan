// Self-test of the comparer against running code (design file 30 §4.4, §4.5,
// §5, package O0d). One recording (made here, never tracked) of the scenarios
// the planted candidates run on, and of every crash point of three scenarios
// (submit-complete; native-proof-shard, whose torn crash at save 9 falls
// between a native job proof shard write and the main commit; restart-mixed,
// several active tasks of mixed reconcile answers). Checked:
// - restart at every save point of the three scenarios: a fresh reference and
//   a fresh candidate load saved state k (or k - 1 when torn) and are compared
//   through initialize's recovery, every case reproduced with the comparer
//   passing, and the torn case is what it says it is (read from the recording);
// - every planted candidate (CANDIDATE_PLANTS) is reported different by its
//   own named rule or oracle and judged exit 1, against an unchanged control:
//   among them the design's cap, capacity hold and a recovery that never pumps,
//   each launch_delayed by name from the candidate's run past the first
//   difference, and a recovery reversed, in parallel or without its leases;
// - the two named relaxations through the replayer: OD2's read mode (off, free,
//   a copy that reads an option once more, one that reads a key no recording
//   read, a key read with two values) and the design's independence table (a
//   recording edited so one pair of independent lanes is in the other order).
// Every wait has a deadline, which only bounds a hang; each child's deadline
// stops that child only (bounded.mjs).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bunJson, replayBounded, withDeadline } from './bounded.mjs';
import { judgeClosure, recordedMarks, recordQuick } from './closure.mjs';
import { CANDIDATE_PLANTS } from './compare-mutants.mjs';
import { createScratch } from './record.mjs';
import { prepareCopy } from './replay.mjs';
import { corpusTests } from './scenarios.mjs';
import { caseEvents, EXIT, readContainer } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESTARTED = ['submit-complete', 'native-proof-shard', 'restart-mixed'];
const PLANTED = [...new Set(CANDIDATE_PLANTS.flatMap((plant) => plant.scenarios))];
const SCENARIOS = [...new Set([...PLANTED, ...RESTARTED, 'F10-auto-resume'])];
const NAMES = corpusTests().filter((entry) => SCENARIOS.includes(entry.scenario.name) && (!entry.crash || RESTARTED.includes(entry.scenario.name))).map((entry) => entry.name);
const TESTS = 4;
const scratch = createScratch('scheduler-conformance-candidates-test');
let passed = 0;
let recorded;
let replay;
let plants;
let modes;

// Overall deadlines (hang guards that fail naming what was running; nothing here depends on how long anything takes).
const DEADLINE_MS = 300_000;

before(async () => {
  recorded = await withDeadline(recordQuick({ workDir: path.join(scratch.dir, 'record'), scenarios: NAMES }), DEADLINE_MS, `the recording of ${NAMES.length} scenario cases (${SCENARIOS.join(', ')})`);
  const [container] = recorded.scenarios;
  const replayDir = path.join(scratch.dir, 'replays');
  mkdirSync(replayDir, { recursive: true });
  const copyDir = prepareCopy(scratch.dir);
  [replay, plants, modes] = await Promise.all([
    replayBounded(container, { copyDir, json: path.join(replayDir, 'replay.json'), deadlineMs: DEADLINE_MS, label: 'the replay of the restart scenarios against the unchanged copy' }),
    bunJson([path.join(HERE, 'compare-mutants.mjs'), `--scenarios=${container}`, `--root=${scratch.dir}`], { deadlineMs: DEADLINE_MS, label: `the planted candidates (${CANDIDATE_PLANTS.map((plant) => plant.name).join(', ')})` }),
    bunJson([path.join(HERE, 'compare-mutants.mjs'), `--scenarios=${container}`, `--root=${scratch.dir}`, '--modes=submit-complete,F1-fanout-8'], { deadlineMs: DEADLINE_MS, label: 'the read-mode and independence checks (submit-complete, F1-fanout-8, F10-auto-resume)' }),
  ]);
});

after(() => { scratch.finish(passed === TESTS ? 'passed' : 'failed'); });

test('restart at every save point of three scenarios: every crash point reproduced through recovery with the comparer passing', () => {
  assert.deepEqual(recorded.problems, []);
  assert.equal(replay.error, undefined, replay.error);
  const judged = judgeClosure([{ source: 'scenarios', recording: null, replays: [replay] }]);
  assert.equal(judged.code, EXIT.pass, JSON.stringify(judged.problems.slice(0, 3)));
  assert.equal(judged.table.scenarios.reproduced, NAMES.length);
  for (const name of RESTARTED) {
    const crashes = replay.results.filter((result) => result.id.includes(` ${name} crash at save `));
    const saves = corpusTests().filter((entry) => entry.scenario.name === name && entry.crash).length;
    assert.ok(saves >= 14 && crashes.length === saves, `${name}: ${crashes.length} crash points replayed of ${saves}`);
    for (const result of crashes) assert.deepEqual([result.outcome, result.compare?.verdict], ['reproduced', 'pass'], result.id);
  }
  // The torn case between a shard write and the main commit, read from the recording itself: the crashed instance's
  // proof shard write was answered before its ninth save, which never settled; the fresh one loads the eighth save
  // and the shard store holding that proof, and recovers through initialize.
  const { cases, resolve } = readContainer(readFileSync(recorded.scenarios[0], 'utf8'));
  const torn = cases.find((record) => record.id.includes(' native-proof-shard crash at save 9 torn '));
  const events = caseEvents(torn);
  const ofFirst = events.filter((event) => event.c === 1);
  const saves = ofFirst.filter((event) => event.kind === 'port' && event.name === 'persistence.save');
  const put = ofFirst.find((event) => event.kind === 'port' && event.name === 'persistence.putNativeJobProofShard');
  const putAnswered = ofFirst.find((event) => event.kind === 'answer' && event.port === put.port && event.outcome === 'resolve');
  assert.equal(saves.length, 9);
  assert.ok(putAnswered.at < saves[8].at, 'the shard write is answered before the ninth save');
  assert.equal(ofFirst.find((event) => event.kind === 'answer' && event.port === saves[8].port && event.outcome === 'resolve'), undefined, 'the ninth save never settles');
  const ofFresh = events.filter((event) => event.c === 2);
  const answerOf = (name) => { const call = ofFresh.find((event) => event.kind === 'port' && event.name === name); return resolve(ofFresh.find((event) => event.kind === 'answer' && event.port === call.port && event.outcome === 'resolve').value); };
  assert.equal(answerOf('persistence.loadNativeJobProofShards').length, 1);
  assert.equal(JSON.stringify(answerOf('persistence.load')), JSON.stringify(resolve(saves[7].args)[0]));
  assert.ok(ofFresh.some((event) => event.kind === 'call' && event.member === 'initialize'));
  // The judgement reads the same container itself.
  assert.equal(recordedMarks(recorded.scenarios[0]).cases.length, NAMES.length);
  passed += 1;
});

test('every planted candidate is reported different by its own named rule or oracle, and judged exit 1', () => {
  assert.equal(plants.error, undefined, plants.error);
  assert.deepEqual([plants.control.cases, plants.control.reproduced, plants.control.missing, plants.control.failing, plants.control.code], [PLANTED.length, PLANTED.length, [], null, EXIT.pass]);
  assert.deepEqual(plants.plants.map((entry) => entry.name), CANDIDATE_PLANTS.map((plant) => plant.name));
  for (const entry of plants.plants) {
    assert.ok(entry.caught, `${entry.name}: want ${entry.rule}, found ${JSON.stringify(entry.cases)}`);
    for (const item of entry.cases) assert.deepEqual([item.outcome, item.rules.includes(entry.rule)], ['different', true], entry.name);
  }
  // The owner's rule: a cap, a queue, a timer before a launch and a launch one tick late each fail as launch_delayed;
  // so do the design's cap at admission (M7), its capacity hold (M8) and a recovery that never pumps.
  const plant = (name) => plants.plants.find((entry) => entry.name === name);
  for (const name of ['concurrency-cap', 'launch-queue', 'timer-before-launch', 'launch-one-tick-late', 'admission-cap', 'admit-capacity-forced', 'recovery-no-pump']) assert.equal(plant(name).rule, 'launch_delayed');
  // Those three diverge before any launch (an admission save, a hold, a recovery): their launches are judged in the
  // candidate's run past the first difference, which reached the end of the compared part.
  for (const name of ['admission-cap', 'admit-capacity-forced', 'recovery-no-pump']) {
    for (const item of plant(name).cases) {
      assert.notEqual(item.rule, 'launch_delayed', `${name}: its first difference is not the launch`);
      assert.equal(item.observed?.complete, true, `${name}: ${JSON.stringify(item.observed)}`);
      assert.match(item.detail, /past the first difference/, name);
    }
  }
  assert.ok(plant('admit-capacity-forced').cases.every((item) => item.rules.includes('waiting-capacity')));
  // The restart sample tells a reversed, a parallel and a lease-less recovery apart, per push.
  for (const name of ['recovery-reversed', 'recovery-parallel', 'recovery-no-starting-lease']) assert.ok(plant(name).caught, name);
  // An earlier launch is a difference too, reported as one the owner would have to approve; a second launch of a
  // task is a defect, never that.
  assert.match(plant('launch-advanced').cases[0].detail, /owner's yes, not a defect/);
  assert.match(plant('duplicate-launch').cases[0].detail, /a second launch of the same task is a defect/);
  assert.ok(plant('duplicate-launch').cases.every((item) => !item.rules.includes('launch_advanced')));
  // A wrong value where the replay stopped inside a port call is named by its value rule (S2).
  assert.deepEqual([plant('time-not-from-now').cases[0].rule, plant('identifier-not-from-site').cases[0].rule, plant('recovery-reversed').cases[0].rule], ['times', 'identifiers', 'port-arguments']);
  passed += 1;
});

test('OD2 read mode through the replayer: exact by default, free reads by key, an extra read, a key read with two values', () => {
  assert.equal(modes.error, undefined, modes.error);
  for (const result of modes.readFree) {
    assert.deepEqual([result.outcome, result.verdict], ['reproduced', 'pass'], result.id);
    assert.ok(result.readMode.recorded > 0 && result.readMode.served === result.readMode.recorded, JSON.stringify(result.readMode));
  }
  // A copy that reads one option once more: different in exact order, accepted (and reported) with reads free.
  for (const result of modes.extraReadExact) assert.deepEqual([result.outcome, result.check], ['different', 'order'], result.id);
  for (const result of modes.extraReadFree) {
    assert.deepEqual([result.outcome, result.verdict], ['reproduced', 'pass'], result.id);
    assert.ok(result.readMode.served > result.readMode.recorded, JSON.stringify(result.readMode));
  }
  assert.deepEqual([modes.varies.outcome, modes.varies.check], ['inconclusive', 'option-varies']);
  // A copy that reads an option key no recording read: its value cannot be given, so inconclusive, never served.
  for (const result of modes.unreadFree) assert.deepEqual([result.outcome, result.check], ['inconclusive', 'option-unread'], result.id);
  passed += 1;
});

test('the design\'s independence table through the replayer: one pair in the other order passes only with it, the move reported by both', () => {
  const { independence } = modes;
  assert.equal(independence.error, undefined, independence.error);
  assert.deepEqual([independence.design.outcome, independence.design.verdict], ['reproduced', 'pass']);
  assert.deepEqual([independence.design.independence.replay, independence.design.independence.comparer], [1, 1]);
  assert.deepEqual(independence.design.independence.uses[0].lanes, ['publish', 'timer.set']);
  assert.match(independence.design.independence.uses[0].cite, /scheduler\.js:\d+/);
  // The shipped table is empty: strict total order.
  assert.deepEqual([independence.strict.outcome, independence.strict.check], ['different', 'order']);
  passed += 1;
});
