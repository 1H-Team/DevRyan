// Self-test of the client engine conformance harness (docs/TESTING.md):
// the codec against its tracked cross-language vectors in Node and in Bun and
// on values tests hand the engine; the strict container reader and writer;
// the tools on fixed inputs (selfchecks.mjs); the recorder on the
// harness-owned toy modules, twice, complete and byte-equal to the tracked
// corpus, with exactly the fixtures' cases unrecordable; pass-set parity on
// the toys; and every planted difference, each reported by its own check.
// Its subjects are the harness's own toys only: no product test runs here
// (harmlessness on the product suite is parity.mjs, run on demand), and
// nothing depends on how long anything takes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createCodecContext, decode, encode, encodeText, stringifyTree } from './codec.mjs';
import { createContainerWriter, readContainer } from './container.mjs';
import { PLANTED, runPlanted } from './mutants.mjs';
import { passSetParity } from './parity.mjs';
import { HARNESS_DIR, REPOSITORY_ROOT, TOY_EXPECTED, TOY_FILES, TOY_UNRECORDABLE, compareWithExpected, createScratch, formatDifference, formatIncomplete, recordToys } from './record.mjs';
import { toolChecks } from './selfchecks.mjs';
import { checkStability } from './stability.mjs';
import { checkVectors } from './vectors.mjs';

const toyFiles = () => TOY_FILES.map((name) => `scripts/client-conformance/toy/${name}`);
const scratchFor = (t, owner) => {
  const scratch = createScratch(owner);
  let status = 'failed';
  t.after(() => scratch.finish(status));
  return { dir: scratch.dir, pass: () => { status = 'passed'; } };
};

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

test('the recorder reproduces the toy corpus completely and byte for byte, twice', async (t) => {
  const scratch = scratchFor(t, 'client-conformance-self-test');
  const result = await checkStability({ runs: 2, workDir: scratch.dir, recordRun: (workDir) => recordToys({ workDir }) });
  assert.deepEqual(result.incomplete.map(formatIncomplete), [], 'complete, and the fixtures are unrecordable exactly as listed');
  assert.deepEqual(result.unstable, [], 'the two recordings are byte-equal');
  assert.equal(result.cases, 72);
  // Each listed fixture case is unrecordable in every family container it reaches (the cross-family one in two).
  const fixtures = Object.values(TOY_UNRECORDABLE).reduce((sum, list) => sum + list.length, 0);
  assert.equal(fixtures, 15);
  assert.deepEqual(result.outcomes, { recorded: 72 - 16, unrecordable: 16, inconclusive: 0 }, 'only the fixtures are unrecordable');
  const differences = compareWithExpected(result.recordings[0]);
  assert.deepEqual(differences.map(formatDifference), [], 'the recording equals toy/expected (after a deliberate recorder change: record.mjs --toys --update)');
  const expected = readdirSync(TOY_EXPECTED).filter((name) => name.endsWith('.ndjson')).sort();
  assert.deepEqual(result.recordings[0].map((container) => container.name).sort(), expected);
  for (const container of result.recordings[0]) assert.equal(container.text, readFileSync(path.join(TOY_EXPECTED, container.name), 'utf8'), `${container.name} is byte-equal`);
  scratch.pass();
});

test('pass-set parity holds on the toys', async (t) => {
  const scratch = scratchFor(t, 'client-conformance-self-test');
  const toys = await passSetParity({ targets: toyFiles(), cwd: REPOSITORY_ROOT, portMap: path.join(HARNESS_DIR, 'toy/port-map.json'), workDir: path.join(scratch.dir, 'toys'), parallel: TOY_FILES.length });
  assert.deepEqual([...toys.differences, ...toys.incomplete], []);
  assert.equal(toys.runs[0].recordedPassed, 68);
  assert.equal(toys.runs[0].baselinePassed, 68);
  scratch.pass();
});

test('each planted difference is reported by its own check', async (t) => {
  const scratch = scratchFor(t, 'client-conformance-self-test');
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('review:')).length, 38, 'all 38 of the review are planted');
  assert.equal(PLANTED.filter((mutant) => mutant.origin === 'builder').length, 9);
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('review 2:')).length, 10, 'the second review\'s planted differences not already in the list');
  assert.equal(PLANTED.filter((mutant) => mutant.origin.startsWith('review 3:')).length, 11, 'all 11 of the third review are planted');
  const results = await runPlanted(scratch.dir, { concurrency: 6 });
  for (const { mutant, differences, caught, error } of results) {
    assert.equal(error, undefined, `${mutant.name}: ${error}`);
    assert.ok(differences.length > 0, `${mutant.name}: no check reported it`);
    assert.ok(caught, `${mutant.name} must be reported by ${mutant.tool} at ${JSON.stringify(mutant.expect, (_key, value) => (value instanceof RegExp ? String(value) : value))}; got ${JSON.stringify(differences.slice(0, 4))}`);
  }
  scratch.pass();
});
