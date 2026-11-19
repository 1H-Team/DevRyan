// Self-test of the client engine conformance harness (docs/TESTING.md):
// the codec against its tracked cross-language vectors in Node and in Bun and
// on values tests hand the engine; the strict container reader and writer;
// the tools on fixed inputs (selfchecks.mjs); the recorder on the
// harness-owned toy modules, twice, complete and byte-equal to the tracked
// corpus, with exactly the fixtures' cases unrecordable; the change-set check
// and the census of the toy corpus (census.mjs); the stray-timer toy recorded
// with another wait, byte-equal to its tracked recording; pass-set parity on the toys;
// and a fixed sample of the planted differences, one of each tool
// (mutants.mjs PER_PUSH_SAMPLE), each reported by its own check. Every other
// planted difference runs in the full suite only (planted.full.test.mjs).
// Its subjects are the harness's own toys only: no product test runs here
// (harmlessness on the product suite is parity.mjs, run on demand), and
// nothing depends on how long anything takes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createCodecContext, decode, encode, encodeText, stringifyTree } from './codec.mjs';
import { createContainerWriter, readContainer } from './container.mjs';
import { PER_PUSH_SAMPLE, PLANTED, runPlanted } from './mutants.mjs';
import { passSetParity } from './parity.mjs';
import { HARNESS_DIR, REPOSITORY_ROOT, TOY_EXPECTED, TOY_FILES, TOY_UNRECORDABLE, compareWithExpected, createScratch, formatDifference, formatIncomplete, recordOnce, recordToys } from './record.mjs';
import { toolChecks } from './selfchecks.mjs';
import { checkChangeSets, loadCensus, mergeExports, runCensus } from './census.mjs';
import { familyChecks } from './familychecks.mjs';
import { loadPortMap } from './port-map.mjs';
import { compareRecordings } from './stability.mjs';
import { checkVectors } from './vectors.mjs';

// The toy corpus: its cases, the fixtures TOY_UNRECORDABLE lists and the unrecordable cases they make (one per family line).
const TOY_CASES = 116;
const TOY_FIXTURES = 28;
const TOY_UNRECORDABLE_CASES = 32;
const toyFiles = () => TOY_FILES.map((name) => `scripts/client-conformance/toy/${name}`);
// Two recordings of the toy corpus, made once and shared by the tests that judge them (corpus, census, family command).
let shared = null;
let sharedScratch = null;
let sharedStatus = 'failed';
after(() => sharedScratch?.finish(sharedStatus));
const toyRecordings = () => {
  if (!shared) {
    sharedScratch = createScratch('client-conformance-self-test');
    const dir = sharedScratch.dir;
    shared = (async () => [await recordToys({ workDir: path.join(dir, 'toys-1') }), await recordToys({ workDir: path.join(dir, 'toys-2') })])();
  }
  return shared;
};
const scratchFor = (t, owner) => {
  const scratch = createScratch(owner);
  let status = 'failed';
  t.after(() => scratch.finish(status));
  return { dir: scratch.dir, pass: () => { status = 'passed'; } };
};

// The tests are independent but for the shared toy recordings (one promise), and most of their time is spent
// waiting on bun processes: they run at once.
describe('client conformance self-test', { concurrency: true }, () => {
  test('codec vectors match the tracked file, in Node and in Bun', () => {
    assert.deepEqual(checkVectors(), []);
    const bun = spawnSync('bun', [path.join(HARNESS_DIR, 'vectors.mjs'), '--check'], { encoding: 'utf8' });
    assert.equal(bun.status, 0, `${bun.stdout}${bun.stderr}`);
    assert.match(bun.stdout, /vectors match \(Bun /);
  });

  test('the codec keeps what JSON loses, what thrown values carry, and never calls a getter', () => {
    let reads = 0;
    const shared = { id: 'shared' };
    const value = { hidden: new Set(['b', 'a']), order: new Map([[2, 'two'], [1, 'one']]), left: shared, right: shared, zero: -0, gone: undefined, empty: null };
    Object.defineProperty(value, 'lazy', { get() { reads += 1; return 1; }, enumerable: true });
    const context = createCodecContext();
    const text = encodeText(value, context);
    assert.equal(reads, 0);
    assert.ok(context.flags.has('accessor'));
    const back = decode(JSON.parse(text), createCodecContext());
    assert.deepEqual([...back.hidden], ['b', 'a']);
    assert.deepEqual([...back.order.keys()], [2, 1]);
    assert.equal(back.left, back.right);
    assert.ok(Object.is(back.zero, -0));
    assert.ok('gone' in back && back.gone === undefined);
    assert.equal(back.empty, null);
    const cycle = { name: 'c' };
    cycle.self = cycle;
    const restored = decode(encode(cycle));
    assert.equal(restored.self, restored);
    assert.equal(stringifyTree(encode(restored)), stringifyTree(encode(cycle)));
    // Integer-like keys come first in ascending order, as the engine gives them.
    assert.equal(encodeText({ b: 1, 10: 2, a: 3, 2: 4 }), '{"2":4,"10":2,"b":1,"a":3}');
    // What code can observe about an abort: the default reason's name and the timeout's.
    const abort = encode(AbortSignal.abort());
    assert.equal(abort.reason.error.name, 'AbortError');
    assert.equal(encode(new DOMException('late', 'TimeoutError')).error.name, 'TimeoutError');
    assert.notEqual(encodeText(new DOMException('x', 'AbortError')), encodeText(new DOMException('x', 'TimeoutError')));
    // A tree that is not canonical is refused.
    for (const tree of [{ $dr: 'escape', value: { a: 1 } }, { $dr: 'number', value: '1' }, { $dr: 'undefined', extra: 1 }, { $dr: 'map', entries: [], className: 'Map' }]) {
      assert.throws(() => decode(tree), /client-conformance codec/, JSON.stringify(tree));
    }
  });

  test('a container reads back what it wrote, and the strict reader refuses anything else', () => {
    const writer = createContainerWriter({ codec: 3, testFile: 'a.toy.mjs', family: 'toy' });
    const slot = writer.refTree(encode({ x: [1, 2] }));
    writer.addCase({ id: '=0123456789abcdef', steps: [{ n: 1, input: { kind: 'call', args: slot }, effects: [] }] });
    const text = writer.toText();
    assert.ok(text.endsWith('\n') && !text.includes('\r'));
    const read = readContainer(text);
    assert.deepEqual(read.resolve(read.cases[0].steps[0].input.args), { x: [1, 2] });
    assert.throws(() => readContainer(text.replace('[1,2]', '[1,3]')), /does not match its content/);
    assert.throws(() => readContainer(text.replace('"kind":"call"', '"kind" : "call"')), /not canonical/);
  });

  test('the tools report what fixed inputs must make them report', async () => {
    assert.deepEqual(await toolChecks(), []);
  });

  test('the recorder reproduces the toy corpus completely and byte for byte, twice', async () => {
    const recordings = await toyRecordings();
    for (const recording of recordings) assert.deepEqual(recording.incomplete.map(formatIncomplete), [], 'complete, and the fixtures are unrecordable exactly as listed');
    const result = compareRecordings(recordings.map((recording) => recording.containers));
    assert.deepEqual([...result.unstable, ...result.incomplete], [], 'the two recordings are byte-equal');
    assert.equal(result.cases, TOY_CASES);
    // Each listed fixture case is unrecordable in every family container it reaches (a port fixture in each family the port belongs to).
    const fixtures = Object.values(TOY_UNRECORDABLE).reduce((sum, list) => sum + list.length, 0);
    assert.equal(fixtures, TOY_FIXTURES);
    assert.deepEqual(recordings[0].outcomes, { recorded: TOY_CASES - TOY_UNRECORDABLE_CASES, unrecordable: TOY_UNRECORDABLE_CASES, inconclusive: 0 }, 'only the fixtures are unrecordable');
    const differences = compareWithExpected(recordings[0].containers);
    assert.deepEqual(differences.map(formatDifference), [], 'the recording equals toy/expected (after a deliberate recorder change: record.mjs --toys --update)');
    const expected = readdirSync(TOY_EXPECTED).filter((name) => name.endsWith('.ndjson')).sort();
    assert.deepEqual(recordings[0].containers.map((container) => container.name).sort(), expected);
    for (const container of recordings[0].containers) assert.equal(container.text, readFileSync(path.join(TOY_EXPECTED, container.name), 'utf8'), `${container.name} is byte-equal`);
    sharedStatus = 'passed';
  });

  test('every change set matches its drafts, and the census of the toy corpus is complete', async () => {
    const [recording] = await toyRecordings();
    assert.deepEqual(recording.incomplete.map(formatIncomplete), []);
    const portMap = loadPortMap(path.join(HARNESS_DIR, 'toy/port-map.json'), { root: REPOSITORY_ROOT });
    const changeSets = checkChangeSets(recording.containers, portMap);
    assert.deepEqual([...changeSets.failures, ...changeSets.unverifiable], []);
    assert.ok(changeSets.checked >= 17, `${changeSets.checked} change sets checked`);
    const merged = mergeExports(recording.raws);
    assert.deepEqual(merged.problems, []);
    const census = runCensus({ portMap, census: loadCensus(path.join(HARNESS_DIR, 'toy/census.json')), containers: recording.containers, moduleExports: merged.exports, readSource: (file) => readFileSync(file, 'utf8') });
    assert.deepEqual([...census.failures, ...census.problems], []);
    assert.deepEqual(census.families['toy-reducer'].events, { total: 6, exercised: 6, waived: 0, failed: 0, types: census.families['toy-reducer'].events.types });
  });

  test('the family command (the product recording command, set up for the toys) judges, counts and exits as documented', async (t) => {
    // No product file is read here: the toy map and census, and a fixture tree for the discover run, stand in for the product.
    const scratch = scratchFor(t, 'client-conformance-self-test');
    assert.deepEqual(await familyChecks({ recordings: await toyRecordings(), workDir: scratch.dir }), []);
    scratch.pass();
  });

  test('timers a test leaves behind never move a later case\'s clock: the stray toy recorded with another wait equals toy/expected', async (t) => {
    // toy/expected holds the stray toy recorded with its default wait (the strays fire before the second test reads
    // the clock); here they fire after it. Each case's clock is its own, so the bytes are the same.
    const scratch = scratchFor(t, 'client-conformance-self-test');
    const file = 'scripts/client-conformance/toy/toy-stray.toy.mjs';
    const recording = await recordOnce({ files: [file], cwd: REPOSITORY_ROOT, portMap: path.join(HARNESS_DIR, 'toy/port-map.json'), families: [], workDir: scratch.dir, env: { TOY_STRAY_WAIT_MS: '0' } });
    assert.deepEqual(recording.incomplete.map(formatIncomplete), []);
    assert.equal(recording.containers.length, 2);
    assert.deepEqual(compareWithExpected(recording.containers, TOY_EXPECTED, { testFiles: [file] }).map(formatDifference), []);
    scratch.pass();
  });

  test('pass-set parity holds on the toys', async (t) => {
    const scratch = scratchFor(t, 'client-conformance-self-test');
    const toys = await passSetParity({ targets: toyFiles(), cwd: REPOSITORY_ROOT, portMap: path.join(HARNESS_DIR, 'toy/port-map.json'), workDir: path.join(scratch.dir, 'toys'), parallel: 1 });
    // One worker: what the runner prints is then in one order on every machine, so this test cannot turn on scheduling.
    assert.deepEqual([...toys.differences, ...toys.incomplete], []);
    assert.equal(toys.runs[0].recordedPassed, 103);
    assert.equal(toys.runs[0].baselinePassed, 103);
    scratch.pass();
  });

  test('a planted difference of each tool is reported by its own check', async (t) => {
    // The fixed sample: one of each tool PLANTED has; the full suite's planted test runs all the others.
    const scratch = scratchFor(t, 'client-conformance-self-test');
    const tools = [...new Set(PLANTED.map((mutant) => mutant.tool))].sort();
    const sample = PLANTED.filter((mutant) => PER_PUSH_SAMPLE.includes(mutant.name));
    assert.equal(sample.length, PER_PUSH_SAMPLE.length, 'every sample name is a planted difference');
    assert.deepEqual(sample.map((mutant) => mutant.tool).sort(), tools, 'the sample holds exactly one planted difference of each tool');
    const results = await runPlanted(scratch.dir, { concurrency: 4, only: PER_PUSH_SAMPLE, recordings: await toyRecordings() });
    assert.equal(results.length, PER_PUSH_SAMPLE.length);
    for (const { mutant, differences, caught, error } of results) {
      assert.equal(error, undefined, `${mutant.name}: ${error}`);
      assert.ok(differences.length > 0, `${mutant.name}: no check reported it`);
      assert.ok(caught, `${mutant.name} must be reported by ${mutant.tool} at ${JSON.stringify(mutant.expect, (_key, value) => (value instanceof RegExp ? String(value) : value))}; got ${JSON.stringify(differences.slice(0, 4))}`);
    }
    scratch.pass();
  });
});
