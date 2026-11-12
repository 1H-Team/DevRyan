// Checks of the harness's own tools against fixed inputs (no bun run): the
// comparer, the strict container reader, the parity and stability judges,
// the container builder's completeness and naming rules, and the vector
// checker. Each check names what it proves; `toolChecks()` returns the ones
// that fail. A planted difference in a tool must make its own
// check fail. Everything is imported from this directory, so a copy of the
// harness checks its own tools.
import { createCodecContext, emitSlots, encode, hashText, snapshot, stringifyTree } from './codec.mjs';
import * as codec from './codec.mjs';
import { compareContainers } from './compare.mjs';
import { createContainerWriter, pathStem, readContainer } from './container.mjs';
import { judgeParity } from './parity.mjs';
import { buildContainers, judgeToyProblems, parseOptions, plainDifferences } from './record.mjs';
import { checkStability, compareRecordings, stabilityExit } from './stability.mjs';
import { checkVectors } from './vectors.mjs';

const slot = (writer, value) => writer.refTree(encode(value));
/** A container text with the cases `make(writer)` returns. */
function container(make, header = {}) {
  const writer = createContainerWriter({ codec: codec.CODEC_VERSION, testFile: 'a.toy.mjs', family: 'toy', ...header });
  for (const record of make(writer)) writer.addCase(record);
  return writer.toText();
}
const baseCase = (writer, id, { entry = { a: 1, b: 2 }, end = { done: true }, input = 1, context = [] } = {}) => ({
  id, digest: '00000000', kind: 'test', file: 'a.toy.mjs', line: 1, describe: [], name: id, ordinal: 1, family: 'toy', status: 'passed', outcome: 'recorded', flags: [], reason: null, seed: '0',
  entry: { now: 0, state: slot(writer, entry) }, steps: [{ n: 1, input: { kind: 'call', entry: 'f', args: slot(writer, [input]), now: 0 }, effects: [] }], end: { now: 0, state: slot(writer, end) },
  context: context.map((value) => ({ kind: 'port', port: 'fetch', call: 't1', args: slot(writer, value), origin: 'test' })),
});
const twoCases = (options = {}) => (writer) => [baseCase(writer, 'one', options.one), baseCase(writer, 'two', options.two)];
const hasCheck = (differences, check, where = () => true) => differences.some((difference) => difference.check === check && where(difference));

const junitTest = (file, line, name, status = 'passed', assertions = 1) => ({ file, line, describe: [], name, status, assertions });
const rawOf = (file, cases, { errors = [], families = ['toy'], flags = [], unplaced = 0, modules = null } = {}) => ({
  version: 3, recording: 2, file, bun: 'x', layers: [], portMap: null, modules, epoch: 0, errors, unplaced,
  values: { [hashText('1')]: '1' },
  cases: cases.map((kind, index) => ({ kind, ...(kind === 'test' || kind === 'concurrent' ? { ordinal: index + 1 } : { hooks: index }), seed: '0', entryNow: 0, endNow: 0, flags: kind === 'concurrent' ? ['concurrent'] : flags, families: Object.fromEntries(families.map((family) => [family, { entryState: null, steps: [{ n: 1, input: { kind: 'call', entry: 'f', args: `=${hashText('1')}`, now: 0 }, effects: [] }], endState: null, context: [] }])), contextRecords: 0 }))
    .map((entry) => (entry.kind === 'concurrent' ? { ...entry, kind: 'test' } : entry)),
});

/** [name, () => true when the tool behaves]: every check of the tools. */
export const TOOL_CHECKS = Object.freeze([
  ['compare-context', () => hasCheck(compareContainers(container(twoCases()), container(twoCases({ two: { context: [['x']] } }))), 'context')],
  ['compare-key-order', () => hasCheck(compareContainers(container(twoCases()), container(twoCases({ one: { entry: { b: 2, a: 1 } } }))), 'state', (entry) => entry.path.includes('{keys}'))],
  ['compare-end-state', () => hasCheck(compareContainers(container(twoCases()), container(twoCases({ two: { end: { done: false } } }))), 'state', (entry) => entry.path.startsWith('/end'))],
  ['compare-negative-zero', () => hasCheck(compareContainers(container(twoCases({ one: { input: 0 } })), container(twoCases({ one: { input: -0 } }))), 'input')],
  ['compare-undefined-null', () => hasCheck(compareContainers(container(twoCases({ one: { input: undefined } })), container(twoCases({ one: { input: null } }))), 'input')],
  ['compare-case-order', () => hasCheck(compareContainers(container(twoCases()), container((writer) => twoCases()(writer).reverse())), 'case-order')],
  ['compare-value-table-order', () => {
    const text = container(twoCases());
    const lines = text.split('\n');
    const table = JSON.parse(lines[1]).values;
    const reversed = Object.keys(table).reverse().map((hash) => `${JSON.stringify(hash)}:${stringifyTree(table[hash])}`).join(',');
    return hasCheck(compareContainers(text, [lines[0], `{"values":{${reversed}}}`, ...lines.slice(2)].join('\n')), 'value-table');
  }],
  ['compare-bytes', () => {
    const text = container(twoCases());
    const lines = text.split('\n');
    const record = JSON.parse(lines[2]);
    const { id, ...rest } = record.case;
    // The same case with its members in another order: no value differs, the bytes do.
    return compareContainers(text, [lines[0], lines[1], JSON.stringify({ case: { ...rest, id } }), ...lines.slice(3)].join('\n')).length > 0;
  }],
  ['container-hash', () => {
    const text = container(twoCases());
    try { readContainer(text.replace('{"a":1,"b":2}', '{"a":1,"b":3}')); return false; } catch (error) { return /does not match/.test(error.message); }
  }],
  ['container-canonical', () => {
    const text = container(twoCases());
    try { readContainer(text.replace('"kind":"call"', '"kind": "call"')); return false; } catch (error) { return /canonical/.test(error.message); }
  }],
  ['path-stem-injective', () => {
    const paths = ['a/b.test.ts', 'a~b.test.ts', 'a%7Eb.test.ts', 'a/b.test.js', 'A/b.test.ts', 'a b.test.ts', 'a_b.test.ts'];
    return new Set(paths.map(pathStem)).size === paths.length;
  }],
  ['parity-outcome', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't', 'failed')], raws: [rawOf('a.test.ts', ['test'])] }).differences, 'outcome')],
  ['parity-assertions', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't', 'passed', 2)], recorded: [junitTest('a.test.ts', 1, 't', 'passed', 1)], raws: [rawOf('a.test.ts', ['test'])] }).differences, 'assertions')],
  ['parity-output', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])], baselineOutput: 'line\n', recordedOutput: 'other\n' }).differences, 'output')],
  // A duration the recorder changes is a difference unless two plain runs already disagreed on that line.
  ['parity-output-unmasked', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])], baselineOutput: 'retry in 500ms\nbackoff 2s\n', secondBaselineOutput: 'retry in 500ms\nbackoff 2s\n', recordedOutput: 'retry in 1000ms\nbackoff 2s\n' }).differences, 'output')],
  // The runner's own per-test time and group markers are not test output; a time inside a result line's name is.
  ['parity-output-runner-timing', () => {
    const judged = judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])],
      baselineOutput: '::group::a.test.ts\n(pass) t [0.04ms]\n::endgroup::\n', secondBaselineOutput: '(pass) t [0.04ms]\n', recordedOutput: '(pass) t [1.25s]\n::endgroup::\n::endgroup::\n' });
    return judged.differences.length === 0;
  }],
  ['parity-output-result-name', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])],
    baselineOutput: '(pass) waits 500ms [0.04ms]\n', secondBaselineOutput: '(pass) waits 500ms [0.04ms]\n', recordedOutput: '(pass) waits 900ms [0.04ms]\n' }).differences, 'output')],
  ['parity-output-learned', () => {
    const judged = judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])], baselineOutput: 'took 3 ms\nsame\n', secondBaselineOutput: 'took 5 ms\nsame\n', recordedOutput: 'took 9 ms\nsame\n' });
    return judged.differences.length === 0 && judged.masked === 2;
  }],
  ['parity-no-recording', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [] }).incomplete, 'no-recording')],
  ['parity-recorder-errors', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'], { errors: ['boom'] })] }).incomplete, 'recorder-error')],
  ['parity-lost-file', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])], expectedFiles: ['a.test.ts', 'b.test.ts'] }).incomplete, 'lost-file')],
  ['parity-empty', () => hasCheck(judgeParity({ baseline: [], recorded: [], raws: [] }).incomplete, 'no-tests')],
  ['parity-count', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't'), junitTest('a.test.ts', 2, 'u')], recorded: [junitTest('a.test.ts', 1, 't'), junitTest('a.test.ts', 2, 'u')], raws: [rawOf('a.test.ts', ['test'])] }).incomplete, 'count')],
  ['stability-detail', () => {
    const left = container(twoCases());
    const right = container(twoCases({ two: { input: 2 } }));
    return compareRecordings([[{ name: 'c', text: left }], [{ name: 'c', text: right }]]).unstable.some((entry) => entry.case === 'two' && entry.check === 'input' && entry.step === 1);
  }],
  ['stability-order', () => hasCheck(compareRecordings([[{ name: 'c', text: container(twoCases()) }], [{ name: 'c', text: container((writer) => twoCases()(writer).reverse()) }]]).unstable, 'case-order')],
  ['stability-empty', () => hasCheck(compareRecordings([[], []]).incomplete, 'empty')],
  // A recording that exited 0 with containers but is itself incomplete makes the stability run inconclusive.
  ['stability-recording-incomplete', async () => {
    const text = container(twoCases());
    const result = await checkStability({ runs: 2, workDir: '/nonexistent', recordRun: async () => ({ status: 0, output: '', incomplete: [{ check: 'family', detail: 'family other recorded no case' }], containers: [{ name: 'c', text }] }) });
    return hasCheck(result.incomplete, 'family') && result.unstable.length === 0 && stabilityExit(result) === 3;
  }],
  ['stability-bun-exit', async () => {
    const text = container(twoCases());
    const result = await checkStability({ runs: 2, workDir: '/nonexistent', recordRun: async () => ({ status: 1, output: 'crashed', incomplete: [], containers: [{ name: 'c', text }] }) });
    return hasCheck(result.incomplete, 'bun-exit');
  }],
  ['record-count', () => hasCheck(buildContainers({ raws: [rawOf('a.test.ts', ['test', 'test'])], junit: [junitTest('a.test.ts', 1, 't'), junitTest('a.test.ts', 2, 'u'), junitTest('a.test.ts', 3, 'v')] }).incomplete, 'count')],
  ['record-skipped', () => {
    const built = buildContainers({ raws: [rawOf('a.test.ts', ['hooks', 'test', 'test'])], junit: [junitTest('a.test.ts', 1, 't'), junitTest('a.test.ts', 2, 'skipped', 'skipped'), junitTest('a.test.ts', 3, 'v')] });
    const ids = built.containers.flatMap((entry) => readContainer(entry.text).cases.map((record) => record.id));
    return built.incomplete.length === 0 && ids.join('|') === 'a.test.ts #hooks:0/toy|a.test.ts:1 t #1/toy|a.test.ts:3 v #1/toy';
  }],
  ['record-empty', () => hasCheck(buildContainers({ raws: [rawOf('a.test.ts', ['test'], { families: [] })], junit: [junitTest('a.test.ts', 1, 't')] }).incomplete, 'empty')
    && hasCheck(buildContainers({ raws: [], junit: [] }).incomplete, 'empty')],
  ['record-family', () => hasCheck(buildContainers({ raws: [rawOf('a.test.ts', ['test'])], junit: [junitTest('a.test.ts', 1, 't')], families: ['toy', 'other'] }).incomplete, 'family', (entry) => entry.detail.includes('other'))],
  ['record-lost-file', () => {
    const { incomplete } = buildContainers({ raws: [rawOf('a.test.ts', ['test'])], junit: [junitTest('a.test.ts', 1, 't')], expectedFiles: ['a.test.ts', 'b.test.ts'] });
    return hasCheck(incomplete, 'no-recording', (entry) => entry.file === 'b.test.ts') && hasCheck(incomplete, 'no-tests', (entry) => entry.file === 'b.test.ts');
  }],
  ['record-recorder-error', () => hasCheck(buildContainers({ raws: [rawOf('a.test.ts', ['test'], { errors: ['boom'] })], junit: [junitTest('a.test.ts', 1, 't')] }).incomplete, 'recorder-error')],
  ['record-duplicate', () => hasCheck(buildContainers({ raws: [rawOf('x/A.test.ts', ['test']), rawOf('x/a.test.ts', ['test'])], junit: [junitTest('x/A.test.ts', 1, 't'), junitTest('x/a.test.ts', 1, 't')] }).incomplete, 'duplicate')],
  ['record-failed', () => {
    const built = buildContainers({ raws: [rawOf('a.test.ts', ['test'])], junit: [junitTest('a.test.ts', 1, 't', 'failed')] });
    return hasCheck(built.incomplete, 'failed') && readContainer(built.containers[0].text).cases[0].outcome === 'inconclusive';
  }],
  ['record-unrecordable', () => {
    const built = buildContainers({ raws: [rawOf('a.test.ts', ['test'], { flags: ['released'] })], junit: [junitTest('a.test.ts', 1, 't')] });
    return hasCheck(built.incomplete, 'unrecordable', (entry) => entry.name === 't' && entry.flags.join() === 'released') && built.outcomes.unrecordable === 1;
  }],
  ['record-unplaced', () => hasCheck(buildContainers({ raws: [rawOf('a.test.ts', ['test'], { unplaced: 2 })], junit: [junitTest('a.test.ts', 1, 't')] }).incomplete, 'unplaced')],
  // A test that fails without the recorder and passes with it (an unhandled rejection the recorder observed) is no reference.
  ['record-plain-differs', () => hasCheck(plainDifferences([junitTest('a.test.ts', 1, 't', 'failed')], [junitTest('a.test.ts', 1, 't')]), 'plain-differs')
    && plainDifferences([junitTest('a.test.ts', 1, 't')], [junitTest('a.test.ts', 1, 't')]).length === 0],
  ['record-header', () => {
    const built = buildContainers({ raws: [rawOf('a.test.ts', ['test'], { modules: { toy: 'sha256:m' } })], junit: [junitTest('a.test.ts', 1, 't')] });
    const { header } = readContainer(built.containers[0].text);
    return header.recording === 2 && header.modulesDigest === 'sha256:m';
  }],
  ['toy-unrecordable-expected', () => {
    const missing = judgeToyProblems([], ['toy-concurrent.toy.mjs']).incomplete;
    const other = judgeToyProblems([{ check: 'unrecordable', file: 'scripts/client-conformance/toy/toy-reducer.toy.mjs', name: 'x', flags: ['accessor'], detail: '' }], ['toy-reducer.toy.mjs']).incomplete;
    const extraFlag = judgeToyProblems([{ check: 'unrecordable', file: 'scripts/client-conformance/toy/toy-concurrent.toy.mjs', name: 'concurrent test 1 of the file (cannot be named)', flags: ['concurrent', 'released'], detail: '' }], ['toy-concurrent.toy.mjs']).incomplete;
    return hasCheck(missing, 'unrecordable-expected') && hasCheck(other, 'unrecordable') && hasCheck(extraFlag, 'unrecordable');
  }],
  ['cli-unknown-option', () => {
    const spec = { flags: ['check', 'update'], values: ['port-map'] };
    return parseOptions(['--chek'], spec).error !== null && parseOptions(['--portmap=x'], spec).error !== null && parseOptions(['--check=1'], spec).error !== null
      && parseOptions(['--check', '--port-map=x', 'file'], spec).error === null;
  }],
  ['record-concurrent-unnamed', () => {
    const built = buildContainers({ raws: [rawOf('a.test.ts', ['concurrent', 'concurrent'])], junit: [junitTest('a.test.ts', 2, 'second'), junitTest('a.test.ts', 1, 'first')] });
    const cases = readContainer(built.containers[0].text).cases;
    return cases.every((record) => record.id.includes('#concurrent:') && record.outcome === 'unrecordable' && record.line === null);
  }],
  ['vectors-bytes', () => checkVectors({ codec: { ...codec, encode: (value, context) => { const tree = codec.encode(value, context); return Array.isArray(tree) ? [...tree].reverse() : tree; } } }).some((failure) => failure.check === 'vectors')],
  ['vectors-round-trip', () => {
    // A decoder that loses an object's last member: generation still matches, the round trip must not.
    const lossy = { ...codec, decode: (tree, context) => { const value = codec.decode(tree, context); if (value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) { const keys = Object.keys(value); if (keys.length > 1) delete value[keys.at(-1)]; } return value; } };
    return checkVectors({ codec: lossy }).some((failure) => failure.check === 'round-trip');
  }],
  ['codec-identity-scope', () => {
    const argument = { k: 1 };
    const sameContext = createCodecContext();
    const same = emitSlots([snapshot([argument], sameContext), snapshot(argument, sameContext)]);
    const copyContext = createCodecContext();
    const copy = emitSlots([snapshot([argument], copyContext), snapshot({ ...argument }, copyContext)]);
    return stringifyTree(same) === '[[{"$dr":"id","n":1,"value":{"k":1}}],{"$dr":"id","n":1,"value":{"k":1}}]' && stringifyTree(copy) === '[[{"k":1}],{"k":1}]';
  }],
]);

/** Runs every tool check; returns the failing ones as `{ check, detail }`. */
export async function toolChecks(names) {
  const failures = [];
  for (const [name, run] of TOOL_CHECKS) {
    if (names && !names.includes(name)) continue;
    try {
      if (!(await run())) failures.push({ check: name, detail: 'the tool did not report what the fixed input must make it report' });
    } catch (error) {
      failures.push({ check: name, detail: `threw: ${error.message}` });
    }
  }
  return failures;
}
