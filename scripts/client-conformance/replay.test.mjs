// Self-test of the replayer of the client engine conformance harness
// (docs/TESTING.md, package C0d): the toy closure in both modes (the tracked
// toy corpus and a fresh recording of the replayer's own toy family), its
// counts pinned and every judged step judged; the comparison on fixed inputs
// (design §4.5 item 18's vectors among them) and the judgement on fixed
// results, exit codes included; the closure command against engines that are
// wrong on purpose and on damaged recording directories, by exit code; a
// sample of the planted differences in the toy modules, one of each check
// (TOY_MUTANT_SAMPLE); the planted differences in the replayer itself that
// the cheap parts catch, and one each of the closure and the engines
// (REPLAYER_PLANT_SAMPLE); the engine protocol's refusals; and interrupted
// runs, which must stop what they started and leave no scratch. Everything
// else planted runs in the full suite only (replay-planted.full.test.mjs). Its
// subjects are the harness's toys only: no product module or test runs here,
// and nothing depends on how long anything takes (every wait has a deadline
// that names what did not answer).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ENGINE_ACCIDENTS, openEngine, PROTOCOL, typescriptEngine } from './engine.mjs';
import { createScratch, HARNESS_DIR, REPOSITORY_ROOT } from './record.mjs';
import { writeManifest } from './manifest.mjs';
import { loadPortMap } from './port-map.mjs';
import { recordReplayToys } from './replay.mjs';
import { interruptTool as interrupt, REPLAYER_PLANT_SAMPLE, REPLAYER_PLANTS, replaySelfTest, runReplayerPlants, TOY_MUTANT_SAMPLE, TOY_MUTANTS } from './replay-mutants.mjs';

// One recording of the replayer's toy family, shared by the tests that replay it.
let shared = null;
let sharedScratch = null;
let sharedStatus = 'failed';
after(() => sharedScratch?.finish(sharedStatus));
const ownRecording = () => {
  if (!shared) {
    sharedScratch = createScratch('client-conformance-replay-self-test');
    shared = recordReplayToys({ workDir: path.join(sharedScratch.dir, 'record') });
  }
  return shared;
};
const scratchFor = (t, owner) => {
  const scratch = createScratch(owner);
  let status = 'failed';
  t.after(() => scratch.finish(status));
  return { dir: scratch.dir, pass: () => { status = 'passed'; } };
};

describe('client conformance replayer self-test', { concurrency: true }, () => {
  test('the toy closure reproduces every judged case in file order and alone; the comparison and the judgement on fixed inputs', async (t) => {
    const { dir, pass } = scratchFor(t, 'client-conformance-replay-closure');
    const recording = await ownRecording();
    assert.deepEqual(recording.incomplete, [], 'the replayer\'s toy family records cleanly');
    const { failures } = await replaySelfTest({ workDir: dir, parts: ['closure', 'compare', 'judge'], mutants: [], recording });
    assert.deepEqual(failures, []);
    sharedStatus = 'passed';
    pass();
  });

  test('the closure command fails engines that do not run the module, engines that fail, and damaged recordings, by exit code', async (t) => {
    const { dir, pass } = scratchFor(t, 'client-conformance-replay-engines');
    const { failures } = await replaySelfTest({ workDir: dir, parts: ['engines'], mutants: [], recording: await ownRecording() });
    assert.deepEqual(failures, []);
    pass();
  });

  test('a sample of planted differences in the toy modules, one of each check, is each reported by its own check', async (t) => {
    const { dir, pass } = scratchFor(t, 'client-conformance-replay-toy-mutants');
    assert.equal(TOY_MUTANT_SAMPLE.length, new Set(TOY_MUTANT_SAMPLE).size);
    for (const name of TOY_MUTANT_SAMPLE) assert.ok(TOY_MUTANTS.some((mutant) => mutant.name === name), `${name} is a toy mutant`);
    const { failures } = await replaySelfTest({ workDir: dir, parts: ['toy-mutants'], mutants: TOY_MUTANT_SAMPLE, recording: await ownRecording() });
    assert.deepEqual(failures, []);
    pass();
  });

  test('planted differences in the replayer make its own self-test fail where each names', async (t) => {
    const { dir, pass } = scratchFor(t, 'client-conformance-replay-plants');
    assert.equal(REPLAYER_PLANT_SAMPLE.length, new Set(REPLAYER_PLANT_SAMPLE).size);
    for (const name of REPLAYER_PLANT_SAMPLE) assert.ok(REPLAYER_PLANTS.some((plant) => plant.name === name), `${name} is a replayer plant`);
    const results = await runReplayerPlants(dir, { only: REPLAYER_PLANT_SAMPLE });
    assert.equal(results.length, REPLAYER_PLANT_SAMPLE.length);
    for (const { plant, caught, failures, error } of results) {
      assert.equal(error, undefined, `${plant.name}: ${error}`);
      assert.ok(caught, `${plant.name} must fail the self-test at ${plant.fails}; it failed at ${JSON.stringify(failures.slice(0, 3))}`);
    }
    pass();
  });

  test('the engine answers the protocol, is told nothing that names a case, and refuses what it cannot place', async () => {
    assert.ok(ENGINE_ACCIDENTS.length >= 7 && ENGINE_ACCIDENTS.every((item) => item.what && item.instead));
    const engine = openEngine({ ...typescriptEngine({ cwd: REPOSITORY_ROOT }), deadlineMs: 120000 });
    try {
      const hello = await engine.request({ op: 'hello', protocol: PROTOCOL });
      assert.equal(hello.ok, true);
      assert.equal(hello.engine, 'typescript');
      assert.equal(hello.protocol, PROTOCOL);
      const unknown = await engine.request({ op: 'step', unit: 99, step: { input: { kind: 'call', entry: 'x', args: [], now: 0 }, env: [], bind: [] } });
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /unit 99 is not open/);
      const family = { name: 'toy-relay', module: path.join(HARNESS_DIR, 'toy/replay/toy-relay.mjs'), entries: [], injected: [], ports: [] };
      const opened = await engine.request({ op: 'open', unit: 1, family });
      assert.equal(opened.ok, true, opened.error);
      assert.ok(opened.exports.includes('tally'));
      assert.deepEqual((await engine.request({ op: 'case', unit: 1 })).between, []);
      // An entry the module does not export is never run: the case halts as unplaced (the replayer's inconclusive), at the engine's own step 1.
      const placed = await engine.request({ op: 'step', unit: 1, step: { input: { kind: 'call', entry: 'missing', args: [], now: 0 }, env: [], bind: [] } });
      assert.equal(placed.halted?.check, 'unplaced');
      assert.equal(placed.halted?.step, 1);
      assert.equal((await engine.request({ op: 'end', unit: 1 })).ok, true);
      // A call that reads the clock with no recorded answer halts the case: never a made-up time.
      assert.equal((await engine.request({ op: 'case', unit: 1 })).ok, true);
      const draft = { $dr: 'id', n: 1, value: { items: {}, count: 0 } };
      const unanswered = await engine.request({ op: 'step', unit: 1, step: { input: { kind: 'call', entry: 'stamp', args: [draft, 'a'], now: 0 }, env: [], bind: [] } });
      assert.equal(unanswered.halted?.check, 'unanswered');
      const ended = await engine.request({ op: 'end', unit: 1 });
      assert.equal(ended.ok, true);
      assert.equal(ended.replayed.halt.check, 'unanswered');
      // A long string travels once per case in the request's string table and is the engine's argument in full.
      assert.equal((await engine.request({ op: 'case', unit: 1 })).ok, true);
      const long = `${'x'.repeat(2000)} `;
      const shared = await engine.request({ op: 'step', unit: 1, step: { input: { kind: 'call', entry: 'label', args: [{ $dr: 'slice', s: 0 }], now: 0 }, env: [], bind: [], strings: [long] } });
      assert.equal(shared.halted, null);
      const labelled = await engine.request({ op: 'end', unit: 1 });
      const returned = labelled.replayed.steps[0].returns;
      assert.equal(labelled.replayed.strings[returned.text.s], long.trim());
      assert.equal(returned.units, long.length);
      assert.equal((await engine.request({ op: 'close', unit: 1 })).ok, true);
    } finally {
      await engine.stop();
    }
  });

  test('an interrupted tool stops the processes it started and removes its run root (SIGINT, SIGTERM, SIGHUP)', async (t) => {
    const { dir, pass } = scratchFor(t, 'client-conformance-replay-interrupts');
    const tool = (name) => path.join(HARNESS_DIR, name);
    // A test that waits, recorded by record.mjs (bun under the isolation guard), and a recording replayed against an
    // engine that hangs (replay-mutants.mjs engineChecks builds the same directory): each tool is stopped mid-run.
    const tests = path.join(dir, 'tests');
    mkdirSync(tests, { recursive: true });
    writeFileSync(path.join(tests, 'waits.test.mjs'), "import { test } from 'bun:test';\ntest('waits', () => new Promise(() => {}), 600000);\n");
    const recording = await ownRecording();
    const intact = path.join(dir, 'recording');
    mkdirSync(intact, { recursive: true });
    const portMapFile = path.join(HARNESS_DIR, 'toy', 'replay', 'replay-port-map.json');
    writeManifest(intact, recording.containers, { portMap: loadPortMap(portMapFile, { root: REPOSITORY_ROOT }).digest, families: ['toy-relay'], scope: null });
    for (const item of recording.containers) writeFileSync(path.join(intact, item.name), item.text);
    const record = (out) => [tool('record.mjs'), `--port-map=${path.join(HARNESS_DIR, 'toy', 'port-map.json')}`, `--cwd=${tests}`, `--out=${path.join(dir, out)}`, 'waits.test.mjs'];
    const runs = await Promise.all([
      interrupt(record('out-int'), 'SIGINT'),
      interrupt([tool('replay.mjs'), `--from=${intact}`, `--port-map=${portMapFile}`, `--engine=${tool('toy/replay/fake-engine.mjs')}`, '--engine-args=hang'], 'SIGTERM', { below: /node$/, ownsRoot: false }),
      interrupt(record('out-hup'), 'SIGHUP'),
    ]);
    assert.deepEqual(runs.map((run) => run.code), [130, 143, 129], 'the exit code of each signal');
    for (const run of runs) {
      assert.equal(run.rootLeft, false, 'the run root is removed');
      assert.deepEqual(run.running, [], 'no process the tool started still runs');
    }
    pass();
  });
});
