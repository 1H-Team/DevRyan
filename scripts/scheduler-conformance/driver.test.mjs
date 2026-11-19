// Self-test of the scripted driver and its scenarios (design file 30,
// package O0b). Its subjects are the real scheduler driven by the driver:
// a subset of the scenario corpus recorded twice under the recorder and once
// with the paranoid drain, its traces read against what each scenario states
// (scenario-facts.mjs) and their step markers against their events, the
// stated facts of every scenario and crash point in one bun run, the
// quiescence probe (§8.2 Q1) on a subset, and the planted driver bugs. Every bun run uses one worker; nothing checked
// depends on how long anything takes (all time is virtual). All bun work
// starts at once and each test awaits its part.
//
//   node --import=./scripts/test-isolation-preload.mjs --test scripts/scheduler-conformance/driver.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { encodeLedgerSnapshot } from '../../packages/orchestration-runtime/codec.js';
import { decode } from '../client-conformance/codec.mjs';
import { caseEvents, compareCases, judgeCorpus, recordCorpus, SCENARIO_ENV, traceFactProblems, traceFacts } from './drive.mjs';
import { createScratch, HARNESS_DIR, REPOSITORY_ROOT } from './record.mjs';
import { compareFacts, FACT_KEYS } from './scenario-facts.mjs';
import { corpusTests, SCENARIOS } from './scenarios.mjs';
import { EPOCH, EXIT, readContainer, sha256 } from './trace.mjs';

// Crash points: the first and the last save in both modes, and two between.
const CRASH_POINTS = [[1, 'durable'], [1, 'torn'], [3, 'durable'], [5, 'torn'], [7, 'durable'], [7, 'torn']];
const SUBSET = ['F1-fanout-8', 'F4-failures-and-submits', 'F5-slow-save', 'F7-restart-recovery', 'wait-timeout-and-abort', ...CRASH_POINTS.map(([index, mode]) => `submit-complete crash at save ${index} ${mode}`)];
const PROBED = ['F1-fanout-8', 'F5-slow-save', 'F7-restart-recovery', 'wait-timeout-and-abort', 'submit-complete', 'cancel-two'];
// What the scenarios declare as their number of saves (their crash points); the probe measures it.
const DECLARED_SAVES = { 'F1-fanout-8': 17, 'submit-complete': 7 };

const scratch = createScratch('scheduler-conformance-driver-self-test');
let failed = false;
after(() => { scratch.finish(failed ? 'failed' : 'passed'); });
const guarded = (name, body) => test(name, async () => { try { await body(); } catch (error) { failed = true; throw error; } });

/** Runs a bun script of this folder and parses the one JSON line it prints last. */
const bunJson = (script, args = []) => new Promise((resolve, reject) => {
  const child = spawn('bun', [path.join(HARNESS_DIR, script), ...args], { cwd: REPOSITORY_ROOT, env: { ...process.env, ...SCENARIO_ENV, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('error', reject);
  child.on('close', (status) => {
    try { resolve({ status, ...JSON.parse(out.trim().split('\n').pop()) }); } catch (error) { reject(new Error(`${script} printed no result (exit ${status}): ${error.message}\n${out.slice(-2000)}\n${err.slice(-2000)}`)); }
  });
});

// Everything that runs bun starts now; the tests below await their part.
const corpus = recordCorpus({ names: SUBSET, runs: 2, workDir: path.join(scratch.dir, 'corpus') });
const mutants = bunJson('driver-mutants.mjs');
const stated = bunJson('scenario-facts.mjs');
const probe = bunJson('quiescence-probe.mjs', [`--scenarios=${PROBED.join(',')}`]);
for (const pending of [corpus, mutants, probe, stated]) pending.catch(() => {});

const readings = new WeakMap();
const casesOf = (recording) => {
  if (!readings.has(recording)) readings.set(recording, recording.containers.flatMap((container) => {
    const read = readContainer(container.text);
    return read.cases.map((record) => ({ record, resolve: read.resolve }));
  }));
  return readings.get(recording);
};
const caseNamed = (recording, name) => casesOf(recording).find((entry) => entry.record.name === name) ?? assert.fail(`no case ${name}`);

guarded('the subset is complete, recorded twice byte-equal, the same under the paranoid drain, and every group opens with a step marker', async () => {
  const recorded = await corpus;
  const judged = judgeCorpus(recorded);
  assert.deepEqual({ plainFailed: judged.plainFailed, differences: judged.differences, incomplete: judged.incomplete, unstable: judged.unstable, drainDiffers: judged.drainDiffers }, { plainFailed: [], differences: [], incomplete: [], unstable: [], drainDiffers: [] });
  assert.equal(judged.code, EXIT.pass);
  assert.deepEqual(judged.cases.map((entry) => entry.name).sort(), [...SUBSET].sort());
  const [first, second] = recorded.recordings;
  assert.equal(first.containers[0].text, second.containers[0].text);
  assert.equal(first.containers[0].text, recorded.paranoid.containers[0].text);
  for (const { record } of casesOf(first)) {
    const markers = caseEvents(record).filter((event) => event.kind === 'step');
    assert.deepEqual(markers.map((event) => event.step), markers.map((_, index) => index + 1), record.name);
    for (const marker of markers) assert.equal(marker.dir, 'in');
    for (const marker of markers) assert.equal(Number.isFinite(marker.now) && marker.now >= EPOCH, true);
    // The construction comes before every marker of its own instance.
    for (const construction of record.constructions) {
      const own = construction.events.filter((event) => event.kind === 'step');
      if (own.length) assert.equal(construction.events[0].kind, 'call', `${record.name}: construction ${construction.n} opens with its own call`);
    }
  }
});

guarded('F1 at 8: every start in one step, in submit order, after the initialize save and 2N admission saves; every submit returns starting', async () => {
  const { record, resolve } = caseNamed((await corpus).recordings[0], 'F1-fanout-8');
  const facts = traceFacts(record, resolve);
  assert.equal(facts.launches.length, 8);
  assert.equal(new Set(facts.launches.map((launch) => launch.step)).size, 1);
  assert.equal(facts.savesBeforeFirstLaunch, 1 + 2 * 8);
  const events = caseEvents(record);
  const submits = events.filter((event) => event.kind === 'call' && event.member === 'submit').map((event) => event.call);
  const settled = new Map(events.filter((event) => event.kind === 'settle').map((event) => [event.call, resolve(event.value)]));
  const returned = submits.map((call) => settled.get(call));
  assert.deepEqual(returned.map((task) => task.status), Array(8).fill('starting'));
  assert.deepEqual(facts.launches.map((launch) => launch.taskId), returned.map((task) => task.taskId));
  // The eight submits are one group: one marker, eight inputs.
  assert.deepEqual(events.filter((event) => event.kind === 'step' && event.inputs.length === 8).map((event) => event.inputs[0].label), ['call submit']);
  // Each start is called before its submit settles.
  const lastStart = Math.max(...events.filter((event) => event.kind === 'port' && event.name === 'executor.start').map((event) => event.at));
  const firstSettle = Math.min(...events.filter((event) => event.kind === 'settle' && submits.includes(event.call)).map((event) => event.at));
  assert.equal(lastStart < firstSettle, true);
});

guarded('F7: after the restart, recovery reconciles one task per step in queue order; the queued tasks and the submits made during it launch only after the last reconcile', async () => {
  const { record, resolve } = caseNamed((await corpus).recordings[0], 'F7-restart-recovery');
  assert.equal(record.constructions.length, 2);
  const facts = traceFacts(record, resolve);
  const recovery = facts.reconciles.filter((entry) => entry.construction === 2).slice(0, 10);
  assert.equal(recovery.length, 10);
  for (let index = 1; index < recovery.length; index += 1) assert.equal(recovery[index].step > recovery[index - 1].step, true, 'one reconcile at a time');
  const restartedStarts = facts.launches.filter((launch) => launch.construction === 2 && launch.port === 'executor.start');
  const bulk = restartedStarts.filter((launch) => launch.step > recovery.at(-1).step);
  assert.equal(bulk.length, 20 + 5);
  // The first instance launched nothing: it died inside the pump's admission loop, after the tenth admission save.
  const admitted = facts.launches.filter((launch) => launch.construction === 1).map((launch) => launch.taskId);
  assert.deepEqual(admitted, []);
  const loadAnswer = caseEvents(record).find((event) => event.construction === 2 && event.kind === 'answer' && event.outcome === 'resolve');
  const loaded = decode(resolve(loadAnswer.value));
  const starting = loaded.tasks.filter((task) => task.status === 'starting').sort((a, b) => a.sequence - b.sequence).map((task) => task.taskId);
  assert.equal(starting.length, 10);
  assert.equal(loaded.tasks.filter((task) => task.status === 'queued').length, 20);
  assert.deepEqual(recovery.map((entry) => entry.taskId), starting);
});

guarded('crash points: the fresh instance loads the bytes of save k when the write landed (durable) and of save k-1 when it did not (torn), nothing for a torn first save, at the first, middle and last save', async () => {
  const recording = (await corpus).recordings[0];
  for (const [index, mode] of CRASH_POINTS) {
    const name = `submit-complete crash at save ${index} ${mode}`;
    const wanted = mode === 'durable' ? index : index - 1;
    const { record, resolve } = caseNamed(recording, name);
    assert.equal(record.constructions.length, 2, name);
    const saves = record.constructions[0].events.filter((event) => event.kind === 'port' && event.name === 'persistence.save');
    assert.equal(saves.length, index, `${name}: the crashed instance made exactly ${index} saves`);
    const saveAnswers = record.constructions[0].events.filter((event) => event.kind === 'answer' && saves.some((save) => save.port === event.port) && event.outcome === 'resolve');
    assert.equal(saveAnswers.length, index - 1, `${name}: save ${index} never settled`);
    const load = record.constructions[1].events.find((event) => event.kind === 'port' && event.name === 'persistence.load');
    const answer = record.constructions[1].events.find((event) => event.kind === 'answer' && event.port === load.port && event.outcome === 'resolve');
    const loaded = decode(resolve(answer.value));
    if (wanted === 0) assert.equal(loaded, null, `${name}: nothing was on disk`);
    else assert.equal(sha256(encodeLedgerSnapshot(loaded)), saves[wanted - 1].ledger, name);
    // Nothing after the crashing save: no port call of the crashed instance follows it.
    const last = record.constructions[0].events.filter((event) => event.kind === 'port' && event.name !== 'publishEvent').at(-1);
    assert.equal(last.port, saves[index - 1].port, `${name}: the crashing save is the crashed instance's last port call`);
  }
});

guarded('every scenario states its facts, and every recorded case matches them (steps and their times, groups in delivery order, launches) with step markers that list exactly the inputs delivered, numbered as recorded, at the time every clock read gave', async () => {
  for (const scenario of SCENARIOS) assert.deepEqual(compareFacts(scenario.facts, scenario.facts), [], `${scenario.name} states every fact`);
  assert.deepEqual(compareFacts(null, {}), ['the scenario states no facts']);
  const recording = (await corpus).recordings[0];
  assert.deepEqual(traceFactProblems(recording, corpusTests()), []);
  // A marker lists the inputs of a mixed group as they were delivered: F4's eight answers, then its eight submits.
  const { record } = caseNamed(recording, 'F4-failures-and-submits');
  const mixed = caseEvents(record).find((event) => event.kind === 'step' && event.inputs.length === 16 && event.inputs[0].kind === 'answer');
  assert.deepEqual(mixed.inputs.map((item) => item.kind), [...Array(8).fill('answer'), ...Array(8).fill('call')]);
  assert.deepEqual(mixed.inputs.slice(0, 8).map((item) => item.by), Array(8).fill('hold'));
});

guarded('the stated facts of every scenario and crash point hold exactly (one bun run of each)', async () => {
  const result = await stated;
  assert.deepEqual(result.problems, []);
  assert.equal(result.status, 0);
  assert.equal(result.cases, corpusTests().length);
  assert.equal(FACT_KEYS.length, 9);
});

guarded('a changed event is unstable with its first differing event named, and a drain-dependent case is never accepted', async () => {
  const recorded = await corpus;
  const [first] = recorded.recordings;
  // The same recording with one step marker's time moved: one case changes, at that event.
  const text = first.containers[0].text;
  const at = text.indexOf('"kind":"step","step":2,"now":');
  assert.notEqual(at, -1);
  const changed = `${text.slice(0, at)}"kind":"step","step":2,"now":1${text.slice(at + '"kind":"step","step":2,"now":'.length)}`;
  const fake = { ...first, run: 2, containers: [{ ...first.containers[0], text: changed }] };
  const found = compareCases(first, fake);
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /^first differing event #\d+ \(at \d+\): .*"kind":"step","step":2,"now":17\d+.* then .*"now":1\d+/);
  assert.equal(judgeCorpus({ ...recorded, recordings: [first, fake] }).code, EXIT.inconclusive);
  const drain = judgeCorpus({ ...recorded, paranoid: { ...fake, incomplete: [] } });
  assert.equal(drain.drainDiffers.length, 1);
  assert.equal(drain.code, EXIT.inconclusive);
});

guarded('Q1: one setImmediate boundary is a sound quiescence point here; scenarios are deterministic and drain-independent; where it is not sound the driver says so', async () => {
  const result = await probe;
  assert.deepEqual(result.problems, []);
  assert.equal(result.status, 0);
  assert.deepEqual(result.controls, {
    'host I/O, waited for': 'stray-activity', 'host I/O': 'stray-activity', 'a captured timer, waited for': 'stray-activity', 'a captured timer': 'stray-activity',
    'a captured 30 ms timer': 'stray-activity', 'a MessageChannel': 'stray-activity', 'a million microtasks': 'passed',
    'real setTimeout': 'real-timer', 'real setImmediate': 'real-timer', 'drain of one microtask': 'quiescence-confirmed',
  });
  // Every drain took its mode's turns: the paranoid comparison is not vacuous.
  for (const [name, entry] of Object.entries(result.scenarios)) assert.deepEqual(entry.drains, { one: ['1/0'], paranoid: ['17/2'] }, name);
  assert.deepEqual(Object.keys(result.scenarios).sort(), [...PROBED].sort());
  for (const [name, saves] of Object.entries(DECLARED_SAVES)) assert.equal(result.scenarios[name].saves, saves, `${name} declares ${saves} saves`);
  // A fixed number of microtask turns is no quiescence point: the depth a scenario needs grows with its groups.
  assert.equal(result.scenarios['F1-fanout-8'].microtaskDepth > result.scenarios['submit-complete'].microtaskDepth, true);
});

guarded('every planted driver bug is reported by its own check, and an unchanged copy passes every probe', async () => {
  const result = await mutants;
  assert.deepEqual(result.problems, []);
  assert.equal(result.status, 0);
  const caught = Object.fromEntries(result.results.filter((entry) => entry.check).map((entry) => [entry.name, Object.values(entry.reported).filter((value) => value === entry.check).length > 0]));
  assert.deepEqual(Object.keys(caught).sort(), ['answers-between-same-instant-timers', 'group-split', 'group-split-microtask', 'quiescence-too-early', 'settle-newest-first', 'step-without-drain', 'timer-early', 'timer-late']);
  assert.equal(Object.values(caught).every(Boolean), true);
  assert.deepEqual(new Set(result.results.filter((entry) => entry.check).map((entry) => entry.check)), new Set(['settle-order', 'timer-time', 'input-before-drain', 'group-atomic', 'quiescence-confirmed']));
});
