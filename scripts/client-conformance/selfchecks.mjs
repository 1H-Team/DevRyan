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
import { applyExclusions, checkChangeSets, eventTypesOf, judgeUnrecordable, judgeUnstable, mergeExports, runCensus, staleNoFrame, unclassifiedCallers } from './census.mjs';

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
/** A container of one recorded case whose step mutates its draft (argument 0): `changes` is the change set it carries. */
function draftContainer(changes) {
  const draft = { a: { x: 1 }, b: { y: 2 } };
  const context = createCodecContext();
  const before = snapshot([draft], context);
  draft.b = { y: 3 };
  const after = snapshot([draft], context);
  const [beforeTree, afterTree, changesTree] = emitSlots([before, after, snapshot(changes, context)]);
  return container((writer) => {
    const record = baseCase(writer, 'one');
    record.steps = [{ n: 1, input: { kind: 'call', entry: 'f', args: writer.refTree(beforeTree), now: 0 }, effects: [], after: writer.refTree(afterTree), changes: writer.refTree(changesTree) }];
    return [record];
  });
}
const draftMap = { modules: new Map([['/m', { entries: new Map([['f', { family: 'toy', spec: { draft: 0 } }]]), ports: new Map(), families: ['toy'], all: null }]]) };
/** A census of family `toy` (module `m`: `f`, `g` and the data export `VALUE`) over the twoCases container, which calls `f`. */
function censusOf({ waivers = [], families = null, complete = true } = {}) {
  const portMap = { families: [{ name: 'toy', module: '/m', relModule: 'm' }], modules: new Map([['/m', { entries: new Map(), ports: new Map(), families: ['toy'], all: { family: 'toy', inline: new Set() } }]]) };
  const census = { events: [], exports: waivers, eventTypes: [], ports: [], families: [], unrecordable: [], excludedFiles: [], unstable: [], noFrame: [] };
  return runCensus({ portMap, census, containers: [{ name: 'c', text: container(twoCases()) }], moduleExports: { m: { VALUE: 'data', f: 'function', g: 'function' } }, readSource: () => '', families, complete });
}
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
  // A file's heading printed once or several times is the runner's scheduling; a file that printed in one run only is not.
  ['parity-output-file-heading', () => {
    const base = { baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])] };
    const repeated = judgeParity({ ...base, baselineOutput: 'src/a.test.ts:\n(pass) t\n', secondBaselineOutput: 'src/a.test.ts:\n(pass) t\n', recordedOutput: 'src/a.test.ts:\nsrc/a.test.ts:\n(pass) t\nsrc/a.test.ts:\n' });
    const missing = judgeParity({ ...base, baselineOutput: 'src/a.test.ts:\nsrc/b.test.ts:\n(pass) t\n', secondBaselineOutput: 'src/a.test.ts:\nsrc/b.test.ts:\n(pass) t\n', recordedOutput: 'src/a.test.ts:\n(pass) t\n' });
    return repeated.differences.length === 0 && hasCheck(missing.differences, 'output');
  }],
  ['parity-output-result-name', () => hasCheck(judgeParity({ baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])],
    baselineOutput: '(pass) waits 500ms [0.04ms]\n', secondBaselineOutput: '(pass) waits 500ms [0.04ms]\n', recordedOutput: '(pass) waits 900ms [0.04ms]\n' }).differences, 'output')],
  // The run's closing line: its counts are compared, its wall time is not (two plain runs can agree on it).
  ['parity-output-run-summary', () => {
    const base = { baseline: [junitTest('a.test.ts', 1, 't')], recorded: [junitTest('a.test.ts', 1, 't')], raws: [rawOf('a.test.ts', ['test'])] };
    const timed = judgeParity({ ...base, baselineOutput: '(pass) t\nRan 1 test across 1 file. [912.00ms]\n', secondBaselineOutput: '(pass) t\nRan 1 test across 1 file. [912.00ms]\n',
      recordedOutput: '(pass) t\nRan 1 test across 1 file. [1.91s]\n' });
    const counted = judgeParity({ ...base, baselineOutput: '(pass) t\nRan 2 tests across 1 file. [912.00ms]\n', secondBaselineOutput: '(pass) t\nRan 2 tests across 1 file. [912.00ms]\n',
      recordedOutput: '(pass) t\nRan 1 test across 1 file. [912.00ms]\n' });
    return timed.differences.length === 0 && hasCheck(counted.differences, 'output');
  }],
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
  ['record-flagged-without-line', () => {
    // A case flagged for engine code no step holds, with no family's line, is a problem, never dropped; a flag that loses nothing is not.
    const lost = buildContainers({ raws: [rawOf('a.test.ts', ['test', 'test'], { families: [] })].map((raw) => ({ ...raw, cases: raw.cases.map((entry, index) => ({ ...entry, flags: index === 0 ? ['outside-chain'] : ['global-defined:fetch'] })) })), junit: [junitTest('a.test.ts', 1, 't'), junitTest('a.test.ts', 2, 'u')] });
    const flagged = lost.incomplete.filter((entry) => entry.check === 'flagged-without-line');
    return flagged.length === 1 && flagged[0].case === 'a.test.ts:1 t #1';
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
  ['container-slices', () => {
    // A large value is stored as slices and resolves to the whole tree again; a small one stays whole.
    const big = { a: 'x'.repeat(3000), b: [{ c: 'y'.repeat(2000) }, { c: 'y'.repeat(2000) }], small: { d: 1 } };
    const writer = createContainerWriter({ codec: codec.CODEC_VERSION, testFile: 'a.toy.mjs', family: 'toy' });
    const record = baseCase(writer, 'one', { input: big });
    writer.addCase(record);
    const text = writer.toText();
    const read = readContainer(text);
    const resolved = read.resolve(read.cases[0].steps[0].input.args);
    // The two equal subtrees are one slice: the string, its object and the slot's own tree, at most.
    return text.includes('"$dr":"slice"') && stringifyTree(resolved) === stringifyTree(encode([big])) && read.values.size <= 6 && !stringifyTree(resolved).includes('"slice"');
  }],
  ['container-slice-escape-many', () => {
    // An escaped object (its own `$dr` member) large only through many small members: the object stays whole
    // inside its escape node, so it resolves to itself, never to a slice node in place of its members.
    const value = { $dr: 'mine' };
    for (let index = 0; index < 300; index += 1) value[`m${index}`] = index;
    const writer = createContainerWriter({ codec: codec.CODEC_VERSION, testFile: 'a.toy.mjs', family: 'toy' });
    writer.addCase(baseCase(writer, 'one', { input: value }));
    const read = readContainer(writer.toText());
    return stringifyTree(read.resolve(read.cases[0].steps[0].input.args)) === stringifyTree(encode([value]));
  }],
  ['container-proto-member', () => {
    // An own member named __proto__ survives slicing and resolving, small or large, object or string.
    const value = JSON.parse(`{"__proto__":{"p":"${'x'.repeat(1500)}"},"small":{"__proto__":5},"text":{"__proto__":"${'y'.repeat(1500)}"}}`);
    const writer = createContainerWriter({ codec: codec.CODEC_VERSION, testFile: 'a.toy.mjs', family: 'toy' });
    writer.addCase(baseCase(writer, 'one', { input: value }));
    const text = writer.toText();
    const read = readContainer(text);
    const resolved = read.resolve(read.cases[0].steps[0].input.args);
    return text.includes('"$dr":"slice"') && stringifyTree(resolved) === stringifyTree(encode([value])) && Object.hasOwn(resolved[0], '__proto__') && Object.getPrototypeOf(resolved[0]) === Object.prototype;
  }],
  ['container-resolve-independent', () => {
    // Two places that hold one slice, and two reads of one place, give trees of their own: changing one changes no other.
    const big = { text: 'z'.repeat(700), more: 'y'.repeat(700) };
    const writer = createContainerWriter({ codec: codec.CODEC_VERSION, testFile: 'a.toy.mjs', family: 'toy' });
    writer.addCase(baseCase(writer, 'one', { entry: { held: big }, input: big }));
    const read = readContainer(writer.toText());
    const [record] = read.cases;
    const first = read.resolve(record.steps[0].input.args);
    const again = read.resolve(record.steps[0].input.args);
    const state = read.resolve(record.entry.state);
    first[0].text = 'changed';
    return again[0].text === big.text && state.held.text === big.text && first[0] !== again[0];
  }],
  ['container-slice-escape', () => {
    // A user object whose own members look like a slice is data, inside an escape: never expanded.
    const value = { $dr: 'slice', hash: '0123456789abcdef', pad: 'p'.repeat(1500) };
    const writer = createContainerWriter({ codec: codec.CODEC_VERSION, testFile: 'a.toy.mjs', family: 'toy' });
    writer.addCase(baseCase(writer, 'one', { input: value }));
    const read = readContainer(writer.toText());
    return stringifyTree(read.resolve(read.cases[0].steps[0].input.args)) === stringifyTree(encode([value]));
  }],
  ['census-unrecordable-partial', () => {
    // A case is waived only when every one of its flags is; a waiver that matches nothing is stale.
    const census = { unrecordable: [{ file: 'a.test.ts', tests: ['one', 'two'], flag: 'outside-chain', reason: 'r' }, { file: 'b.test.ts', test: 'two', flag: 'accessor', reason: 'r' }] };
    const entries = [
      { check: 'unrecordable', file: 'a.test.ts', case: 'a.test.ts:1 one #1/reducer', name: 'one', flags: ['outside-chain'] },
      { check: 'unrecordable', file: 'a.test.ts', case: 'a.test.ts:2 two #1/reducer', name: 'two', flags: ['accessor', 'outside-chain'] },
    ];
    const judged = judgeUnrecordable(entries, census);
    return judged.waived.length === 1 && judged.remaining.length === 1 && judged.remaining[0].case.includes('two') && judged.stale.length === 2 && judged.stale.every((entry) => entry.check === 'waiver-stale');
  }],
  ['census-unrecordable-test', () => {
    // A waiver names its test and its exact flag: another test of the file, or another flag of the same name, is not covered;
    // a named test that matched no case is stale, and with chosen test files nothing is.
    const census = { unrecordable: [{ file: 'a.test.ts', tests: ['one', 'gone'], flag: 'global-defined', family: 'reducer', reason: 'r' }] };
    const entries = [
      { check: 'unrecordable', file: 'a.test.ts', case: 'a.test.ts:1 one #1/reducer', name: 'one', flags: ['global-defined'] },
      { check: 'unrecordable', file: 'a.test.ts', case: 'a.test.ts:2 two #1/reducer', name: 'two', flags: ['global-defined'] },
      { check: 'unrecordable', file: 'a.test.ts', case: 'a.test.ts:1 one #1/reducer', name: 'one', flags: ['global-defined:fetch'] },
      { check: 'unrecordable', file: 'a.test.ts', case: 'a.test.ts:1 one #1/optimistic', name: 'one', flags: ['global-defined'] },
    ];
    const judged = judgeUnrecordable(entries, census);
    const partial = judgeUnrecordable(entries, census, { complete: false });
    return judged.waived.length === 1 && judged.remaining.length === 3 && judged.stale.length === 1 && judged.stale[0].name.includes('gone') && partial.stale.length === 0;
  }],
  ['census-change-set-same-length', () => {
    // A change set of the right length with a wrong path is a failure, not only one of another length.
    const right = checkChangeSets([{ name: 'c', text: draftContainer([['b']]) }], draftMap);
    const wrong = checkChangeSets([{ name: 'c', text: draftContainer([['a']]) }], draftMap);
    return right.checked === 1 && right.failures.length === 0 && right.unverifiable.length === 0 && wrong.failures.some((entry) => entry.check === 'change-set');
  }],
  ['census-data-export', () => {
    // A data export no entry can exercise fails unless waived, as an export no test calls does.
    const { failures } = censusOf();
    const named = (name) => failures.some((entry) => entry.check === 'census-export' && entry.name === name);
    return named('VALUE') && named('g') && !named('f') && failures.length === 2;
  }],
  ['census-scope', () => {
    // Chosen test files: a waived export that is exercised still fails, nothing fails for being unexercised;
    // a family filter leaves the other families unjudged.
    const waiver = { family: 'toy', export: 'f', reason: 'r' };
    const partial = censusOf({ waivers: [waiver, { family: 'toy', export: 'gone', reason: 'r' }], complete: false });
    const other = censusOf({ families: ['other'] });
    const whole = censusOf({ waivers: [{ family: 'toy', export: 'gone', reason: 'r' }] });
    return partial.failures.length === 1 && partial.failures[0].check === 'waiver-exercised' && partial.problems.length === 0
      && other.failures.length === 0 && Object.keys(other.families).length === 0 && whole.failures.some((entry) => entry.check === 'waiver-stale');
  }],
  ['census-events-seen', () => {
    // Event types come from the switch on the event's type and from comparisons with a literal anywhere in the
    // entry (an if before the switch), not from a nested switch or a comment; a read the census cannot follow is said.
    const source = "export function apply(draft, event) {\n  if (event.type === 'early') return 1;\n  // case 'commented':\n  switch (event.type) {\n    case 'a': { switch (draft.kind) { case 'inner': break; } break; }\n    case \"b\": return 2;\n  }\n  return 'late' === event.type ? 3 : 0;\n}\n";
    const seen = eventTypesOf(source, 'apply', 1);
    const hidden = eventTypesOf(source.replace('? 3 : 0;', '? 3 : route(event, event.type);'), 'apply', 1);
    return seen.types.join() === 'a,b,early,late' && seen.unseen.length === 0 && hidden.unseen.length === 2;
  }],
  ['census-callers-unclassified', () => {
    // A passed-through caller under the scope that is no test code by the naming rule and that the product does not reach is a problem.
    const passed = { callers: { 'src/a.mjs': { 'f#x': 2 }, 'src/x.test.mjs': { 'f#x': 1 }, 'src/lib/__tests__/h.mjs': { 'f#x': 1 }, 'src/h_test.mjs': { 'f#x': 1 }, 'src/reached.mjs': { 'f#x': 5 }, 'other/b.mjs': { 'f#x': 1 }, '<no frame>': { 'f#x': 1 } }, portCallers: { 'src/p.mjs': { port: 1 } } };
    const problems = unclassifiedCallers(passed, { scope: 'src/', reachable: new Set(['src/reached.mjs']) });
    return problems.map((entry) => entry.file).join() === 'src/a.mjs,src/p.mjs' && problems.every((entry) => entry.check === 'caller-unclassified');
  }],
  ['census-no-frame-stale', () => {
    // A no-frame allowance that no call matched is stale on a whole run (it would waive any test's frameless call
    // of that export), and nothing is stale on a run of chosen files.
    const census = { noFrame: [{ family: 'f', export: 'x', reason: 'r' }, { family: 'f', export: 'gone', reason: 'r' }] };
    const passed = { noFrame: { 'f#x': 2, 'f#other': 1 } };
    const stale = staleNoFrame(passed, census);
    return stale.length === 1 && stale[0].check === 'waiver-stale' && stale[0].name === 'f#gone' && staleNoFrame(passed, census, { complete: false }).length === 0
      && staleNoFrame({ noFrame: { 'f#x': 1, 'f#gone': 1 } }, census).length === 0;
  }],
  ['census-unstable-waiver', () => {
    // An unstable case is waived only by a waiver of its file (and family, when named); one that matches nothing is stale.
    const census = { unstable: [{ file: 'a.test.ts', family: 'reducer', reason: 'r' }, { file: 'c.test.ts', reason: 'r' }] };
    const judged = judgeUnstable([{ case: 'a.test.ts:1 one #1/reducer', check: 'state' }, { case: 'a.test.ts:2 two #1/message-fetch', check: 'state' }, { case: 'b.test.ts:3 three #1/reducer', check: 'state' }], census);
    return judged.waived.length === 1 && judged.remaining.length === 2 && judged.stale.length === 1 && judged.stale[0].name === 'c.test.ts';
  }],
  ['census-exclusions', () => {
    const census = { excludedFiles: [{ file: 'a.test.ts', reason: 'r' }, { file: 'gone.test.ts', reason: 'r' }] };
    const result = applyExclusions(['a.test.ts', 'b.test.ts'], census);
    return result.files.length === 1 && result.files[0] === 'b.test.ts' && result.stale.length === 1 && result.stale[0].name === 'gone.test.ts';
  }],
  ['census-exports-scanned', () => {
    // The exports a module's namespace shows must be the ones its source declares, in every file.
    const raw = (exports, scanned) => ({ exports: { 'm.ts': exports }, scanned: { 'm.ts': scanned } });
    const agree = mergeExports([raw({ a: 'function', b: 'data' }, ['a', 'b'])]);
    const lost = mergeExports([raw({ a: 'function' }, ['a', 'b'])]);
    const differ = mergeExports([raw({ a: 'function' }, ['a']), raw({ a: 'data' }, ['a'])]);
    return agree.problems.length === 0 && lost.problems.some((item) => item.check === 'census-exports-scanned') && differ.problems.some((item) => item.check === 'census-exports-differ');
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
