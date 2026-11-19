// Self-test of the replayer and the closure check (design file 30 §4.3,
// §4.7, §4.8, package O0c). One recording of the starting-lease and the
// admission test files, of the awaiting shapes (shapes.toy.mjs) and of five
// scenarios (made here, never tracked),
// replayed against a second copy of the scheduler package in the run root;
// the planted differences of replay-mutants.mjs, each reported `different` by
// its own check on its own source and judged exit 1; the planted replayer
// bugs; the closure judgement and its exit codes on fixed inputs, damaged
// containers among them; the copy's provenance; the replay decoder against
// the codec; a recording interrupted by SIGINT and by SIGTERM leaves nothing
// running and no scratch. Nothing here depends on how long anything takes
// (every wait has a deadline, which only bounds a hang).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCodecContext, emitSlots, snapshot, stringifyTree } from '../client-conformance/codec.mjs';
import { judgeClosure, recordedMarks, recordQuick, replayFile } from './closure.mjs';
import { createScratch, descendants, REPOSITORY_ROOT, SCRATCH_OWNER_FILE, scratchParentDir } from './record.mjs';
import { COPY_PLANTS, REPLAYER_PLANTS } from './replay-mutants.mjs';
import { copyProvenance, loadCopy, prepareCopy } from './replay.mjs';
import { decodeValue } from './replay-values.mjs';
import { caseEvents, EXIT, readContainer } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = ['F1-fanout-8', 'submit-complete', 'cancel-abort-timeout', 'F7-restart-recovery', 'F8-deferred-launches'];
// Paths from the package directory, where bun runs the test files.
const SHAPES = '../../scripts/scheduler-conformance/shapes.toy.mjs';
const TEST_FILES = ['./scheduler.lease.test.js', './scheduler.admission.test.js', SHAPES];
const TESTS = 9;
const scratch = createScratch('scheduler-conformance-replay-test');
let passed = 0;
let recorded;
let copyDir;
let replays;
let plants;

const bunJson = (args) => new Promise((resolve) => {
  const child = spawn('bun', args, { cwd: REPOSITORY_ROOT, env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ error: `exit ${code}: ${err.trim().split('\n').slice(-5).join(' | ')}` }); } });
});

before(async () => {
  recorded = await recordQuick({ workDir: path.join(scratch.dir, 'record'), tests: TEST_FILES, scenarios: SCENARIOS });
  copyDir = prepareCopy(scratch.dir);
  const tests = recorded.tests;
  const [scenarios] = recorded.scenarios;
  const replayDir = path.join(scratch.dir, 'replays');
  mkdirSync(replayDir, { recursive: true });
  // All bun work at once: the replays and the planted differences.
  [replays, plants] = await Promise.all([
    Promise.all([...tests, scenarios].map((file) => replayFile(file, { copyDir, workDir: replayDir }))),
    bunJson([path.join(HERE, 'replay-mutants.mjs'), `--scenarios=${scenarios}`, `--tests=${tests.join(',')}`, `--root=${scratch.dir}`]),
  ]);
});

after(() => { scratch.finish(passed === TESTS ? 'passed' : 'failed'); });

test('the recording replayed here is complete', () => {
  assert.deepEqual(recorded.problems, []);
  assert.equal(recorded.tests.length, TEST_FILES.length);
  assert.equal(recorded.scenarios.length, 1);
  passed += 1;
});

test('the closure check reproduces every scenario whole and classifies every case of the test files by the recording\'s marks', () => {
  const tests = replays.slice(0, -1);
  const scenarios = replays.at(-1);
  for (const replay of replays) assert.equal(replay.error, undefined, replay.error);
  const judged = judgeClosure([{ source: 'tests', recording: null, replays: tests }, { source: 'scenarios', recording: null, replays: [scenarios] }]);
  assert.equal(judged.code, EXIT.pass, JSON.stringify(judged.problems));
  assert.deepEqual(judged.table.scenarios, { reproduced: SCENARIOS.length, partial: 0, crossed: 0, unrecordable: 0, empty: 0, different: 0 });
  // The test files: cases reproduce whole, others are compared up to their first busy input, nothing differs.
  const results = tests.flatMap((replay) => replay.results);
  assert.ok(judged.table.tests.reproduced >= 1 && judged.table.tests.partial >= 1, JSON.stringify(judged.table.tests));
  assert.equal(judged.table.tests.different, 0);
  for (const result of results) {
    const marks = tests.flatMap((replay) => replay.recorded.cases).find((mark) => mark.id === result.id);
    if (result.outcome === 'reproduced') assert.deepEqual([result.produced, result.prefix], [marks.events, marks.events], result.id);
    if (result.outcome === 'partial') {
      assert.ok(marks.limit > 0 && marks.limit < marks.events && result.produced === marks.limit, result.id);
      assert.match(result.detail, /is marked "busy": the recorder could not show where it arrived/);
    }
  }
  // Every arrived input of a whole case is placed; the partial cases' first busy input is where they stop.
  for (const container of [...tests, scenarios].flatMap((replay) => replay.containers)) assert.deepEqual(container.provenance, { same: true, problems: [] });
  const lines = Object.keys(judged.byFile).sort();
  assert.deepEqual(lines, ['packages/orchestration-runtime/scheduler.admission.test.js', 'packages/orchestration-runtime/scheduler.lease.test.js', 'scripts/scheduler-conformance/scenarios.corpus.mjs', 'scripts/scheduler-conformance/shapes.toy.mjs']);
  assert.ok(judged.byFile['packages/orchestration-runtime/scheduler.lease.test.js'].compared > 0);
  passed += 1;
});

// The mark of each probe call (getTask with the shape's name) of shapes.toy.mjs: a call is placed in a settlement's
// continuation only when a reaction that very settlement queued made it (O0c review 2, B1').
const SHAPE_MARKS = {
  direct: 'settle@initialize', again: 'settle@initialize', kept0: 'with@flush', kept1: 'busy', kept2: 'busy', kept3: 'busy', kept19: 'busy',
  awaited: 'settle@flush', delivery: 'settle@flush', fake: 'busy', wrapped: 'settle@flush', 'after-wrapper': 'busy', then: 'settle@flush', 'then-then': 'busy', all: 'busy', beside: 'busy', first: 'busy', second: 'with@getTask',
};
test('each way of awaiting a member gets its mark, and the review\'s sweep is placed only with no microtask between', () => {
  const file = recorded.tests.find((name) => name.endsWith('shapes.toy.mjs.ndjson'));
  const { cases, resolve } = readContainer(readFileSync(file, 'utf8'));
  const found = {};
  for (const record of cases) {
    const list = caseEvents(record);
    const calls = new Map(list.filter((event) => event.dir === 'in' && event.kind === 'call').map((event) => [`${event.c}:${event.call}`, event.member]));
    for (const event of list) {
      if (event.dir !== 'in' || event.kind !== 'call' || event.member !== 'getTask') continue;
      const shape = /dvr_task_([\w-]+)/.exec(JSON.stringify(resolve(event.args)))?.[1];
      found[shape] = `${event.place}${event.after !== undefined ? `@${calls.get(`${event.c}:${event.after}`)}` : ''}`;
    }
  }
  assert.deepEqual(found, SHAPE_MARKS);
  passed += 1;
});

test('every planted difference in the copy is reported different by its own check on its own source, and judged exit 1', () => {
  assert.equal(plants.error, undefined, plants.error);
  assert.deepEqual([plants.unchanged.reproduced, plants.unchanged.failing, plants.unchanged.code], [plants.unchanged.cases, null, EXIT.pass]);
  assert.deepEqual(plants.plants.map((entry) => entry.name), COPY_PLANTS.map((plant) => plant.name));
  for (const entry of plants.plants) {
    assert.ok(entry.caught, `${entry.name}: want ${entry.check}, found ${JSON.stringify(entry.found)} (judged exit ${entry.code})`);
    assert.deepEqual([entry.outcome, entry.found.check, entry.code], ['different', entry.check, EXIT.fail], entry.name);
    assert.ok(entry.found.at > 0 && entry.found.expected && entry.found.detail, `${entry.name} shows no first differing event`);
  }
  // Each final check, and the timer delay, has a plant only it reports.
  for (const check of ['ledger', 'mutated', 'case-bytes']) assert.ok(plants.plants.some((entry) => entry.check === check && entry.caught), check);
  assert.ok(plants.plants.some((entry) => entry.name === 'lease-delay-plus1' && entry.found.expected.startsWith('out timer.set')));
  // The review's escapes are caught on the test recordings too.
  for (const name of ['extra-save-after-submit', 'extra-publish-after-submit', 'deadline-delay-minus1']) assert.equal(plants.plants.find((entry) => entry.name === name).on, 'tests');
  // A flush that settles one, two or three microtasks later is different on a case whose compared prefix holds an input placed `settle`.
  for (const n of [1, 2, 3]) assert.ok(plants.plants.find((entry) => entry.name === `flush-settles-later-${n}`)?.caught, `flush-settles-later-${n}`);
  passed += 1;
});

test('every planted replayer bug is reported by its own check (the review\'s among them)', () => {
  assert.deepEqual(plants.replayer.map((entry) => entry.name), REPLAYER_PLANTS.map((plant) => plant.name));
  for (const entry of plants.replayer) assert.ok(entry.caught, `${entry.name}: want ${entry.check}, found ${JSON.stringify(entry.found)}`);
  // Where a `settle` input is delivered (O0c review 3, S1): one microtask early, one late and two late are each
  // `different` on the delivery case, whose probe the delivery copy answers differently in each of those jobs, while
  // the unchanged replayer reproduces every case against that copy.
  assert.equal(plants.delivery?.error, undefined, plants.delivery?.error);
  assert.deepEqual([plants.delivery.different, plants.delivery.failing, plants.delivery.delivery?.outcome], [0, null, 'reproduced']);
  for (const name of ['settle-delivered-early', 'settle-delivered-late-1', 'settle-delivered-late-2']) {
    const entry = plants.replayer.find((item) => item.name === name);
    assert.deepEqual([entry?.caught, entry?.found?.check, /awaited, then a call the settlement's own continuation makes/.test(entry?.found?.case ?? '')], [true, 'value', true], name);
  }
  passed += 1;
});

test('the closure judgement and its exit codes, and damaged containers', () => {
  const result = (fields) => ({ id: 'f.test.js:1 a #1', file: 'f.test.js', testFile: 'f.test.js', events: 3, recordedEvents: 3, produced: 3, prefix: 3, ...fields });
  const mark = (fields) => ({ id: 'f.test.js:1 a #1', outcome: 'recorded', events: 3, limit: 3, ...fields });
  const recordedOf = (marks) => ({ end: { cases: marks.length, events: marks.reduce((sum, item) => sum + item.events, 0) }, cases: marks });
  const run = (pairs, { source = 'tests', recording = null, provenance = { same: true, problems: [] }, options } = {}) => judgeClosure([{ source, recording, replays: [{ file: 'f.ndjson', recorded: recordedOf(pairs.map(([, item]) => item)), containers: [{ testFile: 'f.test.js', provenance }], results: pairs.map(([item]) => item) }] }], options);
  const checks = (judged) => judged.problems.map((problem) => problem.check);
  const whole = [result({ outcome: 'reproduced' }), mark()];
  assert.equal(run([whole]).code, EXIT.pass);
  assert.equal(run([whole, [result({ outcome: 'partial', produced: 2, prefix: 2, detail: 'busy' }), mark({ limit: 2 })], [result({ outcome: 'crossed', prefix: 0, detail: 'busy' }), mark({ limit: 0 })], [result({ outcome: 'unrecordable', reason: 'recording: accessor' }), mark({ outcome: 'unrecordable' })], [result({ outcome: 'empty', reason: 'no scheduler', events: 0 }), mark({ outcome: 'empty' })]]).code, EXIT.pass);
  assert.equal(run([whole, [result({ outcome: 'different', check: 'order', detail: 'x' }), mark()]]).code, EXIT.fail);
  // A scenario must be reproduced whole.
  assert.equal(run([whole, [result({ outcome: 'partial', produced: 2, prefix: 2, detail: 'busy' }), mark({ limit: 2 })]], { source: 'scenarios' }).code, EXIT.fail);
  assert.deepEqual(checks(run([[result({ outcome: 'reproduced', produced: 2 }), mark()]])), ['reproduced-complete']);
  assert.deepEqual(checks(run([whole, [result({ outcome: 'partial', produced: 2, prefix: 2 }), mark({ limit: 2 })]])), ['unnamed']);
  // The outcome must agree with the recording's marks: a difference reported crossed, a partial case reported whole.
  assert.deepEqual(checks(run([whole, [result({ outcome: 'crossed', detail: 'busy' }), mark()]])), ['crossed-mark']);
  assert.deepEqual(checks(run([whole, [result({ outcome: 'reproduced', produced: 3 }), mark({ limit: 2 })]])), ['crossed-mark']);
  assert.deepEqual(checks(run([whole, [result({ outcome: 'partial', produced: 3, prefix: 3, detail: 'busy' }), mark()]])), ['crossed-mark']);
  // Unrecordable only where the recording says so: a recorded case a replay calls unrecordable fails, whatever its reason.
  assert.deepEqual(checks(run([whole, [result({ outcome: 'unrecordable', reason: 'microtasks-inside-port' }), mark()]])), ['unrecordable-mark']);
  assert.deepEqual(checks(run([whole, [result({ outcome: 'unrecordable', reason: 'unplaceable' }), mark({ limit: 2 })]])), ['unrecordable-mark']);
  // Counts: a case whose recorded count differs, a case the replay did not report.
  assert.deepEqual(checks(run([[result({ outcome: 'reproduced', recordedEvents: 2 }), mark()]])), ['event-count']);
  assert.deepEqual(checks(judgeClosure([{ source: 'tests', recording: null, replays: [{ file: 'f.ndjson', recorded: recordedOf([mark(), mark({ id: 'f.test.js:2 b #1' })]), containers: [], results: [result({ outcome: 'reproduced' })] }] }])), ['case-missing']);
  assert.equal(run([[result({ outcome: 'crossed', prefix: 0, detail: 'x' }), mark({ limit: 0 })]]).code, EXIT.inconclusive, 'a run that reproduced nothing');
  assert.equal(run([whole], { provenance: { same: false, problems: ['packages/orchestration-runtime/scheduler.js differs from the recorded module'] } }).code, EXIT.inconclusive);
  assert.equal(run([whole], { provenance: { same: false, problems: ['packages/orchestration-runtime/scheduler.js differs from the recorded module'] }, options: { expectCopyDiffers: ['packages/orchestration-runtime/scheduler.js'] } }).code, EXIT.pass, 'a planted copy differs as expected');
  assert.equal(run([whole], { recording: { code: EXIT.inconclusive, incomplete: [{ check: 'unstable', detail: 'x' }], unstable: [], differences: [] } }).code, EXIT.inconclusive);
  assert.equal(judgeClosure([{ source: 'tests', recording: null, replays: [{ file: 'f.ndjson', recorded: recordedOf([mark()]), error: 'exit 1' }] }]).code, EXIT.fail);
  // An empty source: no container, or containers with no case.
  assert.deepEqual(checks(judgeClosure([{ source: 'tests', recording: null, replays: [{ file: 'f.ndjson', recorded: recordedOf([mark()]), containers: [], results: [result({ outcome: 'reproduced' })] }] }, { source: 'scenarios', recording: null, replays: [] }])), ['empty-source']);
  // Damaged containers, read by the judgement itself: a lost case line, a case cut short, a file cut short.
  const lease = recorded.tests.find((file) => file.endsWith('scheduler.lease.test.js.ndjson'));
  const lines = readFileSync(lease, 'utf8').split('\n');
  const damaged = path.join(scratch.dir, 'damaged');
  mkdirSync(damaged, { recursive: true });
  const write = (name, text) => { const file = path.join(damaged, name); writeFileSync(file, text); return file; };
  const lastCase = JSON.parse(lines.at(-3));
  const shortened = { case: { ...lastCase.case, constructions: lastCase.case.constructions.map((construction) => ({ ...construction, events: construction.events.slice(0, -2) })) } };
  const files = {
    dropped: write('dropped.ndjson', [...lines.slice(0, -3), ...lines.slice(-2)].join('\n')),
    truncated: write('truncated.ndjson', [...lines.slice(0, -3), JSON.stringify(shortened), ...lines.slice(-2)].join('\n')),
    cut: write('cut.ndjson', `${lines.slice(0, -2).join('\n')}\n`),
  };
  for (const [name, file] of Object.entries(files)) {
    const marks = recordedMarks(file);
    assert.match(marks.error ?? '', /end line|says \d+ events|value table/, name);
    assert.deepEqual(checks(judgeClosure([{ source: 'tests', recording: null, replays: [{ file, recorded: marks, containers: [], results: [] }] }])).slice(0, 1), ['container-integrity'], name);
  }
  passed += 1;
});

test('the copy is the recorded code, loaded from the run root, and a planted copy says which module differs', async () => {
  const copy = await loadCopy(copyDir);
  const header = readContainer(readFileSync(recorded.scenarios[0], 'utf8')).header;
  assert.deepEqual(copyProvenance(header, copy), { same: true, problems: [] });
  assert.ok(!copy.dir.startsWith(REPOSITORY_ROOT) && copy.outside.length === 0 && Object.keys(copy.modules).length === Object.keys(header.modules).length);
  const plant = COPY_PLANTS[0];
  const planted = await loadCopy(prepareCopy(scratch.dir, { name: 'copy-provenance', replace: [plant] }));
  assert.deepEqual(copyProvenance(header, planted).problems, ['packages/orchestration-runtime/scheduler.js differs from the recorded module']);
  assert.throws(() => prepareCopy(scratch.dir, { name: 'copy-twice', replace: [{ file: 'scheduler.js', anchor: 'const ', with: 'let ' }] }), /occurs \d+ times/);
  rmSync(path.join(scratch.dir, 'copy-twice'), { recursive: true, force: true });
  assert.ok(existsSync(path.join(copy.dir, 'scheduler.js')));
  passed += 1;
});

test('the replay decoder rebuilds what the codec wrote, with identity across values and the copy\'s classes', () => {
  class ManagedOrchestrationError extends Error { constructor(message, code) { super(message); this.name = 'ManagedOrchestrationError'; this.code = code; } }
  const shared = { kept: [1, 2] };
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const sparse = [1, 2, 3];
  delete sparse[1];
  const values = [
    { shared, again: shared, map: new Map([['k', shared], [{ key: 1 }, -0]]), set: new Set([1, 'two', shared]) },
    [new Date(1700000000000), /a+/gi, 10n, Number.NaN, undefined, null, Symbol.for('registered'), sparse, new Uint8Array([1, 2, 3]), Object.create(null)],
    { error: new ManagedOrchestrationError('refused', 'managed_refused'), type: new TypeError('bad'), dom: new DOMException('stop', 'AbortError'), cyclic },
    { $dr: 'escaped', shared },
  ];
  const context = createCodecContext();
  const trees = emitSlots(values.map((value) => snapshot(value, context)));
  const bindings = new Map();
  const decodeContext = createCodecContext();
  const copyClass = (name) => (name === 'ManagedOrchestrationError' ? ManagedOrchestrationError.prototype : null);
  const decoded = trees.map((tree) => decodeValue(tree, { codec: decodeContext, bindings, copyClass, materialize: () => { throw new Error('no stand-ins here'); } }));
  const again = createCodecContext();
  assert.deepEqual(emitSlots(decoded.map((value) => snapshot(value, again))).map(stringifyTree), trees.map(stringifyTree));
  assert.equal(decoded[0].shared, decoded[3].shared, 'an object in two values is one object');
  assert.equal(decoded[2].cyclic.self, decoded[2].cyclic);
  assert.ok(decoded[2].error instanceof ManagedOrchestrationError && decoded[2].error.code === 'managed_refused');
  // Stand-ins for what the trace names, by where they are; a signal the recording lists there is the host's own.
  const port = { $dr: 'port', name: 'executor' };
  const seen = [];
  const controller = new AbortController();
  const value = decodeValue([{ executor: port, now: { $dr: 'function', name: 'now' }, signal: { $dr: 'abortsignal', aborted: false, reason: { $dr: 'undefined' } } }], {
    codec: createCodecContext(), bindings: new Map(),
    materialize: (leaf, at) => { seen.push([leaf.$dr, leaf.name, at]); return { stood: leaf.name }; },
    signalAt: (at, make) => (at.join('.') === '0.signal' ? { signal: controller.signal, made: make } : null),
  });
  assert.deepEqual(seen, [['port', 'executor', [0, 'executor']], ['function', 'now', [0, 'now']]]);
  assert.equal(value[0].signal, controller.signal);
  passed += 1;
});

/** Starts a tool, interrupts it with `signal` once it has a run root and a bun process of its own, and reports what it left. */
async function interrupted(script, args, signal) {
  const child = spawn(process.execPath, [path.join(HERE, script), ...args], { cwd: REPOSITORY_ROOT, env: { ...process.env, DEVRYAN_KEEP_ARTIFACTS: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => { child.on('exit', (code, name) => resolve(code ?? name)); });
  const ownRoot = () => {
    if (!existsSync(scratchParentDir())) return null;
    for (const name of readdirSync(scratchParentDir())) {
      const owner = path.join(scratchParentDir(), name, SCRATCH_OWNER_FILE);
      try { if (Number(readFileSync(owner, 'utf8')) === child.pid) return path.join(scratchParentDir(), name); } catch { /* not this one */ }
    }
    return null;
  };
  // A hang guard, never a duration the result depends on: the tool is interrupted as soon as it records.
  const deadline = Date.now() + 120_000;
  let root = null;
  let seen = [];
  while (Date.now() < deadline && child.exitCode === null) {
    root ??= ownRoot();
    const running = descendants(child.pid);
    const bun = running.filter((pid) => /\bbun\b/.test(spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout));
    if (root && bun.length) { seen = running; break; }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  assert.ok(root && seen.length, `${script} never started recording: ${stderr.slice(-400)}`);
  child.kill(signal);
  // A hang guard as well, cleared on every path: a pending timer would keep this process alive to its end.
  let guard;
  const code = await Promise.race([exited, new Promise((resolve) => { guard = setTimeout(() => resolve('timeout'), 60_000); })]).finally(() => { clearTimeout(guard); });
  if (code === 'timeout') child.kill('SIGKILL');
  const left = seen.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  return { code, root, rootLeft: existsSync(root), left, stderr };
}

test('a recording interrupted by SIGINT or SIGTERM stops every process it started and leaves no scratch', async () => {
  const bySigint = await interrupted('record.mjs', ['./scheduler.lease.test.js'], 'SIGINT');
  assert.deepEqual({ code: bySigint.code, rootLeft: bySigint.rootLeft, left: bySigint.left }, { code: 130, rootLeft: false, left: [] }, bySigint.stderr.slice(-400));
  const bySigterm = await interrupted('closure.mjs', ['--sources=tests'], 'SIGTERM');
  assert.deepEqual({ code: bySigterm.code, rootLeft: bySigterm.rootLeft, left: bySigterm.left }, { code: 143, rootLeft: false, left: [] }, bySigterm.stderr.slice(-400));
  passed += 1;
});
