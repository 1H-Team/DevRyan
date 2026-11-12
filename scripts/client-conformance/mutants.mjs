// Planted differences of the client conformance harness (design file 29
// §4.5, the codec, recorder and tool ones). Each is an exact anchored
// replacement in a copy of this directory inside the run root, never in the
// repository, and each must be reported by its own named check at its own
// location:
//   vectors     the codec vectors (vectors.mjs), at the named vector
//   parity      pass-set parity on the toy tests, naming the test
//   corpus      the toy corpus comparison (compare.mjs), at the container, case, check and step
//   stability   two recordings of the toys compared, at the case and check
//   tools       the tools' own checks on fixed inputs (selfchecks.mjs), by name
// `origin` says where the planted difference comes from: the builder's nine,
// the review's 38 (C0ab review S7, by its category), the ones that pin the
// review fixes, the second review's ten not already planted, the ones that
// pin the second review's fixes, the third review's eleven, and the ones that
// pin the third review's fixes. A corpus result also carries the toy
// recording's own problems, so an expected unplaced count that is not met is
// reported (`unplaced-expected`).
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildContainers, compareWithExpected, HARNESS_DIR, judgeToyProblems, readRaws, recordToys, REPOSITORY_ROOT, runBunTests, TOY_FILES, TOY_TESTS } from './record.mjs';
import { passSetParity } from './parity.mjs';
import { compareRecordings } from './stability.mjs';

// What the copied tools import from outside their directory: the run-root lifecycle, the worker count and the isolation guard.
const SUPPORT = ['qa/run-root.mjs', 'test-runner-utils.mjs', 'test-isolation-guard.mjs', 'test-isolation-preload.mjs', 'test-isolation-check.mjs'];
const C = 'codec.mjs';
const R = 'recorder.mjs';
// What a recorder-only copy holds: the recorder, the modules it imports, and the toys.
const RECORDER_FILES = [R, C, 'container.mjs', 'port-map.mjs', 'toy'];
const toyCase = (name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export const PLANTED = Object.freeze([
  // ------------------------------------------------------------ the builder's nine
  { name: 'codec-sorts-set', origin: 'builder', file: C, tool: 'vectors', expect: { vector: 'set-insertion-order' },
    anchor: '      apply(SetForEach, item, [(entry) => { values.push(build(entry)); }]);\n', replacement: '      apply(SetForEach, item, [(entry) => { values.push(build(entry)); }]);\n      values.sort();\n' },
  { name: 'codec-drops-negative-zero', origin: 'builder', file: C, tool: 'vectors', expect: { vector: 'negative-zero' },
    anchor: "  if (value === 0 && 1 / value < 0) return { [TAG]: 'number', value: '-0' };\n", replacement: '' },
  { name: 'codec-undefined-as-null', origin: 'builder', file: C, tool: 'vectors', expect: { vector: 'undefined-vs-null' },
    anchor: "    if (item === undefined) return { [TAG]: 'undefined' };", replacement: '    if (item === undefined) return null;' },
  { name: 'codec-loses-aliasing', origin: 'builder', file: C, tool: 'vectors', expect: { vector: 'aliasing-shared' },
    anchor: '    if (existing) { existing.seen += 1; return existing; }', replacement: '    if (existing && existing.body === null) { existing.seen += 1; return existing; }' },
  { name: 'recorder-calls-getter', toys: ['toy-unrecordable.toy.mjs'], origin: 'builder', file: C, tool: 'parity', expect: { test: toyCase('reads an accessor exactly once') },
    anchor: '        const slot = accessorSlot(descriptor);', replacement: "        const slot = typeof descriptor.get === 'function' ? build(apply(descriptor.get, object, [])) : accessorSlot(descriptor);" },
  { name: 'recorder-misses-assigned-global', toys: ['toy-timers.toy.mjs'], origin: 'builder', file: R, tool: 'corpus', expect: { case: toyCase('a timer trap the test assigns is still recorded'), check: 'effects', step: 2 },
    anchor: '    set(value) {\n      assign(value);', replacement: '    set(value) {\n      raw = value; wrapped = value;' },
  { name: 'recorder-wrong-step', toys: ['toy-timers.toy.mjs'], origin: 'builder', file: R, tool: 'corpus', expect: { case: toyCase('a pushed item flushes after the delay'), check: 'effects', step: 1 },
    anchor: "  if (origin === 'engine') return place(stepOf(store), store.case, effect);", replacement: "  if (origin === 'engine') return place(familyRecord(store.family, store.case).steps[0], store.case, effect);" },
  { name: 'recorder-reads-real-clock', toys: ['toy-reducer.toy.mjs'], origin: 'builder', file: R, tool: 'stability', expect: { case: toyCase('adds a message with a clock time'), check: 'input', step: 1 },
    anchor: 'const readNow = () => (fakeTimersOn() ? apply(RealDateNow, RealDate, []) : virtualNow);', replacement: 'const readNow = () => apply(RealDateNow, RealDate, []);' },
  { name: 'recorder-unseeded-random', toys: ['toy-reducer.toy.mjs'], origin: 'builder', file: R, tool: 'stability', expect: { case: toyCase('adds a message with a clock time and a random id'), check: 'effects' },
    anchor: 'const drawFloat = () => { const random = streamNow(); return ((random() >>> 5) * TWO_26 + (random() >>> 6)) / TWO_53; };', replacement: "const drawFloat = () => createHash('sha256').update(String(process.hrtime.bigint())).digest().readUInt32LE(0) / 4294967296;" },

  // ------------------------------------------------------------ the review's 38: codec
  { name: 'codec-symbol-ordinals', origin: 'review: codec, symbol ordinals', file: C, tool: 'vectors', expect: { vector: 'symbols' },
    anchor: '      if (ordinal === undefined) { ordinal = symbols.size + 1;', replacement: '      if (ordinal === undefined) { ordinal = 1;' },
  { name: 'codec-map-order', origin: 'review: codec, Map order', file: C, tool: 'vectors', expect: { vector: 'map-insertion-order' },
    anchor: '      apply(MapForEach, item, [(entry, key) => { entries.push([build(key), build(entry)]); }]);', replacement: '      apply(MapForEach, item, [(entry, key) => { entries.unshift([build(key), build(entry)]); }]);' },
  { name: 'codec-error-cause', origin: 'review: codec, error cause', file: C, tool: 'vectors', expect: { vector: 'errors' },
    anchor: "        cause: cause && hasOwn(cause, 'value') ? build(cause.value) : undefined,", replacement: '        cause: undefined,' },
  { name: 'codec-holes', origin: 'review: codec, holes', file: C, tool: 'vectors', expect: { vector: 'holes' },
    anchor: "        if (index > next) items.push({ [TAG]: 'hole', n: index - next });", replacement: '' },
  { name: 'codec-escape', origin: 'review: codec, $dr escape', file: C, tool: 'vectors', expect: { vector: 'dollar-tag-escape' },
    anchor: "hasOwn(out, TAG) ? { [TAG]: 'escape', value: out } : out;", replacement: 'out;' },
  { name: 'codec-error-message', origin: 'review: codec, error message', file: C, tool: 'vectors', expect: { vector: 'errors' },
    anchor: "message: typeof message === 'string' ? message : String(message) },", replacement: "message: '' }," },
  { name: 'codec-key-order', origin: 'review: codec, key order', file: C, tool: 'vectors', expect: { vector: 'integer-like-key-order' },
    anchor: '    for (const key of ownKeys(object)) {\n      if (skip?.(key)) continue;', replacement: '    for (const key of ownKeys(object).reverse()) {\n      if (skip?.(key)) continue;' },
  // container
  { name: 'container-reader-hash', origin: 'review: container, reader hash check', file: 'container.mjs', tool: 'tools', expect: { check: 'container-hash' },
    anchor: '    if (hashText(stringifyTree(tree)) !== hash) throw', replacement: '    if (false) throw' },
  { name: 'container-value-table-reordered', toys: ['toy-reducer.toy.mjs'], origin: 'review: container, value table reordered', file: 'container.mjs', tool: 'tools-corpus', expect: { container: /toy-reducer\.toy\.mjs\.toy-reducer/, check: 'value-table' },
    anchor: '`{"values":{${ordered.map(', replacement: '`{"values":{${ordered.reverse().map(' },
  { name: 'container-cases-reordered', toys: ['toy-reducer.toy.mjs'], origin: 'review: container, cases reordered', file: 'container.mjs', tool: 'tools-corpus', expect: { container: /toy-reducer\.toy\.mjs\.toy-reducer/, check: 'case-order' },
    anchor: '    addCase(record) { cases.push(record); },', replacement: '    addCase(record) { cases.unshift(record); },' },
  // clock
  { name: 'clock-advance-plus-one', toys: ['toy-timers.toy.mjs'], origin: 'review: clock, +1 advance', file: R, tool: 'corpus', expect: { case: toyCase('a pushed item flushes after the delay'), check: 'input', step: 4 },
    anchor: '      if (layers.has(\'clock\')) advance(setAt + span * fires);', replacement: "      if (layers.has('clock')) advance(setAt + span * fires + 1);" },
  { name: 'clock-not-noted', toys: ['toy-clock.toy.mjs'], origin: 'review: clock, clock not noted', file: R, tool: 'corpus', expect: { case: toyCase('new Date() and Date.now() read the same clock'), check: 'effects', step: 1 },
    anchor: "    if (origin === 'engine') record({ kind: 'clock', source, value: ref(value) }, store);", replacement: "    if (false) record({ kind: 'clock', source, value: ref(value) }, store);" },
  { name: 'clock-performance-origin', toys: ['toy-clock.toy.mjs'], origin: 'review: clock, performance origin', file: R, tool: 'corpus', expect: { case: toyCase('new Date() and Date.now() read the same clock'), check: 'effects', step: 1 },
    anchor: 'let virtualPerformance = PERFORMANCE_ORIGIN;', replacement: 'let virtualPerformance = 0;' },
  { name: 'clock-new-date-real', toys: ['toy-clock.toy.mjs'], origin: 'review: clock, new Date() returns real time', file: R, tool: 'stability', expect: { case: toyCase('new Date() and Date.now() read the same clock'), check: 'effects', step: 1 },
    anchor: "    if (args.length === 0 && layers.has('clock')) { const value = readNow();", replacement: "    if (args.length === 0 && layers.has('clock')) { const value = apply(RealDateNow, RealDate, []);" },
  // random
  { name: 'random-draws-unrecorded', toys: ['toy-reducer.toy.mjs'], origin: 'review: random, draws unrecorded', file: R, tool: 'corpus', expect: { case: toyCase('adds a message with a clock time and a random id'), check: 'effects', step: 3 },
    anchor: "  guard('draw', () => noteDraw('Math.random', value));", replacement: '' },
  { name: 'random-uuid-unrecorded', toys: ['toy-transport.toy.mjs'], origin: 'review: random, randomUUID unrecorded', file: R, tool: 'corpus', expect: { case: toyCase('socket messages reach onEvent with a log tag'), check: 'effects', step: 1 },
    anchor: "  guard('draw', () => noteDraw('crypto.randomUUID', value));", replacement: '' },
  { name: 'random-seed-per-file', toys: ['toy-reducer.toy.mjs'], origin: 'review: random, seed per file instead of per test', file: R, tool: 'corpus', expect: { case: toyCase('creates a session and keeps untouched branches shared'), check: 'seed' },
    anchor: "update(`${TEST_FILE}#${ordinal !== null ? ordinal : label}`)", replacement: 'update(`${TEST_FILE}`)' },
  // attribution
  { name: 'attribution-test-call-numbering', toys: ['toy-transport.toy.mjs'], origin: 'review: attribution, test call numbering', file: R, tool: 'corpus', expect: { case: toyCase('load answers through fetch and the response body'), check: 'effects' },
    anchor: ": `t${(current.testCalls += 1)}`, args: ref(listOf(args)) }), null);", replacement: ': (familyRecord(\'toy-transport\').portCalls += 1), args: ref(listOf(args)) }), null);' },
  { name: 'attribution-settle-step', toys: ['toy-flow.toy.mjs'], origin: 'review: attribution, settle step', file: R, tool: 'corpus', expect: { case: toyCase('an answer belongs to the call that waited for it'), check: 'flags' },
    anchor: "  const step = openStep(chain.family, { kind: 'settle', port: name, call, outcome, value: ref(value, chain.case) }, null, chain.case);\n  if (step) chain.step = step;", replacement: '' },
  { name: 'attribution-callback-step', toys: ['toy-transport.toy.mjs'], origin: 'review: attribution, callback step', file: R, tool: 'corpus', expect: { case: toyCase('socket messages reach onEvent with a log tag'), check: 'flags' },
    anchor: "      if (origin === 'engine' || origin === 'harness') return apply(target, thisArg, args);\n      const kase = caseOf(store);", replacement: "      if (true) return apply(target, thisArg, args);\n      const kase = caseOf(store);" },
  { name: 'attribution-port-code-effects', toys: ['toy-clock.toy.mjs'], origin: 'review: attribution, effects recorded from port code', file: R, tool: 'corpus', expect: { case: toyCase('a stub that itself sets a timer records only what the engine did'), check: 'context' },
    anchor: "    const counted = origin !== 'port';", replacement: '    const counted = true;' },
  // change set, state, naming
  { name: 'changeset-maps-skipped', toys: ['toy-reducer.toy.mjs'], origin: 'review: change set, Maps skipped', file: R, tool: 'corpus', expect: { case: toyCase('keeps Set and Map insertion order and -0'), check: 'changes' },
    anchor: "      apply(MapForEach, value, [(entry, key) => walk(entry, [...where, { map: key }])]);", replacement: '' },
  { name: 'state-not-snapshotted', toys: ['toy-timers.toy.mjs'], origin: 'review: state, not snapshotted', file: R, tool: 'corpus', expect: { case: toyCase('a pushed item flushes after the delay'), check: 'state' },
    anchor: '    if (!family.state || !apply(MapHas, loadedFamilies, [family.name])) continue;', replacement: '    if (true) continue;' },
  { name: 'naming-describe-dropped', toys: ['toy-reducer.toy.mjs'], origin: 'review: naming, describe dropped', file: 'junit.mjs', tool: 'tools-corpus', expect: { container: /toy-reducer\.toy\.mjs\.toy-reducer/, check: 'case-set' },
    anchor: 'describe: suites.slice(1).map((suite) => suite.name),', replacement: 'describe: [],' },
  { name: 'naming-skipped-counted', origin: 'review: naming, skipped tests counted', file: 'record.mjs', tool: 'tools', expect: { check: 'record-skipped' },
    anchor: "    const ran = (byFile.get(raw.file) ?? []).filter((test) => test.status !== 'skipped');", replacement: '    const ran = byFile.get(raw.file) ?? [];' },
  { name: 'naming-count-check-off', origin: 'review: naming, naming count check off', file: 'record.mjs', tool: 'tools', expect: { check: 'record-count' },
    anchor: '    if (ran.length !== tests.length) {', replacement: '    if (false) {' },
  // tools
  { name: 'parity-failed-equals-passed', origin: 'review: tools, parity "failed equals passed"', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-outcome' },
    anchor: "    if ((leftStatus === 'passed') !== (rightStatus === 'passed') || leftStatus !== rightStatus)", replacement: '    if (false)' },
  { name: 'stability-text-only', origin: 'review: tools, stability text-only', file: 'stability.mjs', tool: 'tools', expect: { check: 'stability-detail' },
    anchor: '      const found = compareContainers(container.text, other.text);', replacement: '      const found = [];' },
  { name: 'parity-no-recording-off', origin: 'review: parity, "no recording" check off', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-no-recording' },
    anchor: "    if (!raw) { incomplete.push({ run, check: 'no-recording', file,", replacement: "    if (!raw) { continue; incomplete.push({ run, check: 'no-recording', file," },
  { name: 'parity-recorder-errors-ignored', origin: 'review: parity, recorder errors ignored', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-recorder-errors' },
    anchor: "  for (const raw of raws) for (const error of raw.errors) incomplete.push(", replacement: '  for (const raw of []) for (const error of raw.errors) incomplete.push(' },
  { name: 'stability-bun-exit-ignored', origin: 'review: stability, bun exit status ignored', file: 'stability.mjs', tool: 'tools', expect: { check: 'stability-bun-exit' },
    anchor: "    if (recording.status !== 0 && !(recording.incomplete", replacement: "    if (false && !(recording.incomplete" },
  // globals layer
  { name: 'globals-spyon-wrapper-off', toys: ['toy-clock.toy.mjs'], origin: 'review: globals, spyOn wrapper off', file: R, tool: 'parity', expect: { test: toyCase('spyOn(Date, now) answers through the recorder and restores') },
    anchor: "  realModuleOf(mock)('bun:test', () => ({ ...bunTest, spyOn, setSystemTime }));", replacement: "  realModuleOf(mock)('bun:test', () => ({ ...bunTest, spyOn: bunTest.spyOn, setSystemTime }));" },
  { name: 'globals-rearm-off', toys: ['toy-unrecordable.toy.mjs'], origin: 'review: globals, re-arm off', file: R, tool: 'corpus', expect: { case: toyCase('that data property is re-armed at the next test boundary'), check: 'flags' },
    anchor: 'const rearmGlobals = () => { apply(MapForEach, controls,', replacement: 'const rearmGlobals = () => { if (true) return; apply(MapForEach, controls,' },
  { name: 'globals-setsystemtime-ignored', toys: ['toy-clock.toy.mjs'], origin: 'review: globals, setSystemTime ignored', file: R, tool: 'parity', expect: { test: toyCase('setSystemTime and jest.setSystemTime set the clock') },
    anchor: '      overrideSetAt = value;\n      virtualNow = value;', replacement: '      overrideSetAt = value;' },
  // compare and vectors
  { name: 'compare-context-masked', origin: 'review: compare, context masked', file: 'compare.mjs', tool: 'tools', expect: { check: 'compare-context' },
    anchor: "  const found = firstDifference(expected.context, actual.context, resolveExpected, resolveActual, '/context');", replacement: '  const found = null;' },
  { name: 'compare-key-order-masked', origin: 'review: compare, key order masked', file: 'compare.mjs', tool: 'tools', expect: { check: 'compare-key-order' },
    anchor: '  const expectedKeys = Object.keys(expected);\n  const actualKeys = Object.keys(actual);', replacement: '  const expectedKeys = Object.keys(expected).sort();\n  const actualKeys = Object.keys(actual).sort();' },
  { name: 'compare-end-masked', origin: 'review: compare, end state masked', file: 'compare.mjs', tool: 'tools', expect: { check: 'compare-end-state' },
    anchor: "  const end = firstDifference(expected.end, actual.end, resolveExpected, resolveActual, '/end');", replacement: '  const end = null;' },
  { name: 'vectors-round-trip-off', origin: 'review: vectors, round-trip check off', file: 'vectors.mjs', tool: 'tools', expect: { check: 'vectors-round-trip' },
    anchor: "      if (written !== line) failures.push({ name, check: 'round-trip',", replacement: "      if (false) failures.push({ name, check: 'round-trip'," },

  // ------------------------------------------------------------ the review fixes
  { name: 'fix-b1-empty-run-passes', origin: 'fix B1: an empty recording is inconclusive', file: 'record.mjs', tool: 'tools', expect: { check: 'record-empty' },
    anchor: "  if (raws.length > 0 && cases === 0) incomplete.push(", replacement: '  if (false) incomplete.push(' },
  { name: 'fix-b1-missing-family-passes', origin: 'fix B1: a family without a case is inconclusive', file: 'record.mjs', tool: 'tools', expect: { check: 'record-family' },
    anchor: "    if (!containers.some((container) => container.family === family)) incomplete.push(", replacement: '    if (false) incomplete.push(' },
  { name: 'fix-b2-domexception-name-lost', origin: 'fix B2: a DOMException keeps name, message and code', file: C, tool: 'vectors', expect: { vector: 'domexceptions' },
    anchor: "        error: { name: apply(domName, item, []), message: apply(domMessage, item, []), code: apply(domCode, item, []) },", replacement: "        error: { name: '', message: '' }," },
  { name: 'fix-b3-identity-per-slot', origin: 'fix B3: one identity scope spans a case line', file: C, tool: 'vectors', expect: { vector: 'identity-returns-argument' },
    anchor: '      if (apply(MapGet, totals, [slot.token]) > 1) {', replacement: '      if (slot.seen > 1) {' },
  { name: 'fix-b4-stem-collides', origin: 'fix B4: container names are unique by construction', file: 'container.mjs', tool: 'tools', expect: { check: 'path-stem-injective' },
    anchor: "    if (char === '/') out += '~';", replacement: "    if (char === '/' || char === '~') out += '~';" },
  { name: 'fix-s2-prelude-dropped', toys: ['toy-hooks.toy.mjs'], origin: 'fix S2: module load and beforeAll calls are written', file: R, tool: 'corpus', expect: { container: /toy-hooks\.toy\.mjs\.toy-timers/, check: 'case-set' },
    anchor: "  return record.kind === 'test' || ownKeys(families).length > 0 || record.out.contextRecords > 0;", replacement: "  return record.kind === 'test';" },
  { name: 'fix-s3-crossing-ignored', toys: ['toy-flow.toy.mjs'], origin: 'fix S3: a port that is another family\'s entry is recorded', file: R, tool: 'corpus', expect: { case: toyCase('a port that is another family\'s entry is a port call'), check: 'effects', step: 2 },
    anchor: '    if (store.family === family || !crossing || !apply(SetHas, crossing.families, [store.family])) return invoke(args); // inlined', replacement: '    return invoke(args);' },
  { name: 'fix-s4-most-recent-step', toys: ['toy-flow.toy.mjs'], origin: 'fix S4: effects belong to the input that caused them', file: R, tool: 'corpus', expect: { case: toyCase('a microtask continuation belongs to its own call'), check: 'effects', step: 2 },
    anchor: "  if (origin === 'engine') return place(stepOf(store), store.case, effect);", replacement: "  if (origin === 'engine') { const steps = familyRecord(store.family, store.case).steps; return place(steps[steps.length - 1], store.case, effect); }" },
  { name: 'fix-s4-no-during', toys: ['toy-flow.toy.mjs'], origin: 'fix S4: a re-entrant input is marked during its step', file: R, tool: 'corpus', expect: { case: toyCase('a callback a port invokes re-entrantly'), check: 'input', step: 3 },
    anchor: '  if (caller && caller.kind === \'engine\' && caller.case === owner && caller.family === family) step.input.during = caller.step.n;', replacement: '' },
  { name: 'fix-s5-date-now-stub-unrecorded', toys: ['toy-clock.toy.mjs'], origin: 'fix S5: a Date.now stub\'s answers are recorded', file: R, tool: 'corpus', expect: { case: toyCase('a Date.now the test assigns answers'), check: 'effects', step: 1 },
    anchor: "  return stubWrapper(value, 'Date.now', 'clock');", replacement: '  return value;' },
  { name: 'fix-s5-fake-timers-ignored', toys: ['toy-clock.toy.mjs'], origin: 'fix S5: fake timers move the clock as without the recorder', file: R, tool: 'parity', expect: { test: toyCase('fake timers advance the clock as they do without the recorder') },
    anchor: 'const readNow = () => (fakeTimersOn() ? apply(RealDateNow, RealDate, []) : virtualNow);', replacement: 'const readNow = () => virtualNow;' },
  { name: 'fix-s6-concurrent-unflagged', toys: ['toy-concurrent.toy.mjs'], origin: 'fix S6: overlapping tests are unrecordable', file: R, tool: 'corpus', expect: { container: /toy-concurrent\.toy\.mjs\.toy-reducer/, check: 'case-set' },
    anchor: "    if (overlap) current.flags.add('concurrent');\n    closeCase();", replacement: '    closeCase();' },
  { name: 'fix-s8-reads-unrecorded', toys: ['toy-clock.toy.mjs'], origin: 'fix S8: data reads on port objects are inputs', file: R, tool: 'corpus', expect: { case: toyCase('reads of navigator are inputs'), check: 'effects', step: 1 },
    anchor: "        if (origin === 'engine' && (!families || apply(SetHas, families, [store.family]))) guard('port.read',", replacement: "        if (false) guard('port.read'," },

  // ------------------------------------------------------------ the second review's (C0ab review 2)
  { name: 'stability-problems-ignored', origin: 'review 2: S2, a stability recording\'s own incompleteness dropped', file: 'stability.mjs', tool: 'tools', expect: { check: 'stability-recording-incomplete' },
    anchor: '    for (const entry of recording.incomplete ?? []) incomplete.push({ ...entry, detail: `recording ${run}: ${entry.detail}` });', replacement: '' },
  { name: 'codec-identity-three-sights', origin: 'review 2: identity needing 3 sights', file: C, tool: 'vectors', expect: { vector: 'identity-returns-copy' },
    anchor: '      if (apply(MapGet, totals, [slot.token]) > 1) {', replacement: '      if (apply(MapGet, totals, [slot.token]) > 2) {' },
  { name: 'codec-identity-token-per-slot', origin: 'review 2: identity token per slot', file: C, tool: 'vectors', expect: { vector: 'identity-returns-argument' },
    anchor: '  if (token === undefined) { token = {}; apply(WeakMapSet, context.tokens, [item, token]); }', replacement: '  token = {}; apply(WeakMapSet, context.tokens, [item, token]);' },
  { name: 'attribution-settle-no-move', toys: ['toy-flow.toy.mjs'], origin: 'review 2: settle not moving the chain', file: R, tool: 'corpus', expect: { case: toyCase('an answer belongs to the call that waited for it'), check: 'flags' },
    anchor: '  if (step) chain.step = step;', replacement: '' },
  { name: 'attribution-reentrance-off', toys: ['toy-flow.toy.mjs'], origin: 'review 2: re-entrance off', file: R, tool: 'corpus', expect: { case: toyCase('a callback a port invokes re-entrantly'), check: 'input', step: 3 },
    anchor: "const reentrant = (opener) => opener?.kind === 'port' && opener.active === true;", replacement: 'const reentrant = () => false;' },
  { name: 'clock-stub-answers-unrecorded', toys: ['toy-clock.toy.mjs'], origin: 'review 2: clock stub answers unrecorded', file: R, tool: 'corpus', expect: { case: toyCase('a Date.now the test assigns answers'), check: 'effects', step: 1 },
    anchor: "    if (kind === 'clock') noteClock(source, answer, store);", replacement: "    if (kind === 'clock') {}" },
  { name: 'naming-failed-not-inconclusive', origin: 'review 2: failed test not inconclusive', file: 'record.mjs', tool: 'tools', expect: { check: 'record-failed' },
    anchor: "const caseOutcome = (flags, status) => (flags.length ? 'unrecordable' : status === 'failed' ? 'inconclusive' : 'recorded');", replacement: "const caseOutcome = (flags) => (flags.length ? 'unrecordable' : 'recorded');" },
  { name: 'parity-output-check-off', origin: 'review 2: parity output check off', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output' },
    anchor: "  if (printed.length) differences.push({ run, check: 'output',", replacement: "  if (false) differences.push({ run, check: 'output'," },
  { name: 'codec-domexception-code-dropped', origin: 'review 2: DOMException code dropped', file: C, tool: 'vectors', expect: { vector: 'domexceptions' },
    anchor: 'code: apply(domCode, item, []) },', replacement: 'code: 0 },' },
  { name: 'attribution-during-numbered-wrong', toys: ['toy-flow.toy.mjs'], origin: 'review 2: `during` numbered wrong', file: R, tool: 'corpus', expect: { case: toyCase('a callback a port invokes re-entrantly'), check: 'input', step: 3 },
    anchor: 'step.input.during = caller.step.n;', replacement: 'step.input.during = caller.step.n + 1;' },

  // ------------------------------------------------------------ the second review's fixes
  { name: 'fix2-b1-windows-off', toys: ['toy-gate.toy.mjs'], origin: 'fix B1: a continuation belongs to the input that released it', file: R, tool: 'corpus', expect: { case: toyCase('a waiter wakes in the step of the signal'), check: 'effects', step: 1 },
    anchor: 'function windowStart(window, generation) {\n  if (window.done) return;', replacement: 'function windowStart(window, generation) {\n  if (true) return;' },
  { name: 'fix2-b1-module-does-not-wait', toys: ['toy-gate.toy.mjs'], origin: 'fix B1: a module whose wait never waits records differently', file: 'toy/toy-gate.mjs', tool: 'corpus', expect: { case: toyCase('a waiter wakes in the step of the signal'), check: 'effects', step: 1 },
    anchor: "  const value = await gateFor(key).promise;\n  log('woke', `${key}:${value}`);", replacement: "  const value = 1;\n  log('woke', `${key}:${value}`);" },
  { name: 'fix2-b1-one-generation', toys: ['toy-gate.toy.mjs'], origin: 'fix B1: a window follows every generation the release queued', file: R, tool: 'corpus', expect: { case: toyCase('many promise generations from its gate'), check: 'effects', step: 1 },
    anchor: '  if (generation - window.lastActive >= SILENT_GENERATIONS) { window.done = true; noteExpired(window); return; }', replacement: '  if (true) { window.done = true; return; }' },
  { name: 'fix2-b1-late-registration-off', toys: ['toy-gate.toy.mjs'], origin: 'fix B1: a reaction registered after the release joins it', file: R, tool: 'corpus', expect: { case: toyCase('many promise generations from its gate'), check: 'effects', step: 1 },
    anchor: '      return tag ? inWindow(tag, () => apply(target, thisArg, args)) : apply(target, thisArg, args);', replacement: '      return apply(target, thisArg, args);' },
  { name: 'fix2-b1-released-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'fix B1: a continuation test code released is unrecordable', file: R, tool: 'corpus', expect: { case: toyCase('a promise the test resolves releases no input'), check: 'flags' },
    anchor: "    } else if (seq <= window.openSeq) { store.case.flags.add('released'); placed = true; }", replacement: '    }' },
  { name: 'fix2-b2-late-dropped', toys: ['toy-gate.toy.mjs'], origin: 'fix B2: effects after a test ended stay in its case', file: R, tool: 'corpus', expect: { case: toyCase('fires after its test ended'), check: 'effects', step: 1 },
    anchor: '  if (written) { noteUnplaced(input.kind); return null; }', replacement: '  if (written || owner !== current) return null;' },
  { name: 'fix2-b2-late-unmarked', toys: ['toy-gate.toy.mjs'], origin: 'fix B2: an input after the test ended is marked late', file: R, tool: 'corpus', expect: { case: toyCase('fires after its test ended'), check: 'effects', step: 3 },
    anchor: '  if (owner.endNow !== null) step.late = true;', replacement: '' },
  { name: 'fix2-b2-unplaced-ignored', origin: 'fix B2: an effect that could not be placed is inconclusive', file: 'record.mjs', tool: 'tools', expect: { check: 'record-unplaced' },
    anchor: '    if (raw.unplaced) incomplete.push(', replacement: '    if (false) incomplete.push(' },
  { name: 'fix2-s1-definitions-unobserved', toys: ['toy-unrecordable.toy.mjs'], origin: 'fix S1: a global defined and restored inside a test is flagged', file: R, tool: 'corpus', expect: { case: toyCase('a fetch defined and restored inside one test'), check: 'flags' },
    anchor: "  guard('defineProperty', () => observeDefinitions());", replacement: '' },
  { name: 'fix2-s1-standing-accessor-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'fix S1: an accessor a test left standing flags the next case', file: R, tool: 'corpus', expect: { case: toyCase('the accessor stands in the next test'), check: 'flags' },
    anchor: "    if (overlap) current.flags.add('concurrent');\n    checkGlobals(current);", replacement: "    if (overlap) current.flags.add('concurrent');" },
  { name: 'fix2-s3-unrecordable-passes', origin: 'fix S3: an unrecordable case makes the recording inconclusive', file: 'record.mjs', tool: 'tools', expect: { check: 'record-unrecordable' },
    anchor: "        if (outcome === 'unrecordable') incomplete.push(", replacement: '        if (false) incomplete.push(' },
  { name: 'fix2-s3-fixtures-unchecked', origin: 'fix S3: the fixtures must come out unrecordable exactly as listed', file: 'record.mjs', tool: 'tools', expect: { check: 'toy-unrecordable-expected' },
    anchor: '  for (const item of wanted) if (!item.seen) remaining.push(', replacement: '  for (const item of []) if (!item.seen) remaining.push(' },
  { name: 'fix2-s4-mask-by-pattern', origin: 'fix S4: output is masked only where plain runs differ', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output-unmasked' },
    anchor: "    .map((line) => line.trimEnd().replace(RESULT_LINE, '$1'))", replacement: "    .map((line) => line.replace(/\\b\\d+(?:\\.\\d+)? ?(?:ms|s)\\b/g, '<time>').trimEnd().replace(RESULT_LINE, '$1'))" },
  { name: 'ci-runner-timing-kept', origin: 'the runner\'s own per-test time and group markers are not test output', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output-runner-timing' },
    anchor: "    .map((line) => line.trimEnd().replace(RESULT_LINE, '$1'))", replacement: '    .map((line) => line.trimEnd())' },
  { name: 'ci-file-heading-counted', origin: 'a file heading repeated by the runner\'s scheduling is not a difference', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output-file-heading' },
    anchor: "    .filter((line) => { if (!FILE_HEADING.test(line)) return true; if (headings.has(line)) return false; headings.add(line); return true; });", replacement: '    ;' },
  { name: 'ci-file-heading-dropped', origin: 'a file that printed in one run only is still a difference', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output-file-heading' },
    anchor: "    .filter((line) => { if (!FILE_HEADING.test(line)) return true; if (headings.has(line)) return false; headings.add(line); return true; });", replacement: '    .filter((line) => !FILE_HEADING.test(line));' },
  { name: 'ci-run-summary-time-kept', origin: 'the wall time on the runner\'s closing line is not test output', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output-run-summary' },
    anchor: "    .map((line) => line.replace(RUN_SUMMARY, '$1'))", replacement: '    .map((line) => line)' },
  { name: 'ci-run-summary-dropped', origin: 'the counts on the runner\'s closing line are still compared', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output-run-summary' },
    anchor: "    .map((line) => line.replace(RUN_SUMMARY, '$1'))", replacement: '    .filter((line) => !RUN_SUMMARY.test(line))' },
  { name: 'ci-result-name-masked', origin: 'a time inside a test\'s name is still compared', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output-result-name' },
    anchor: "const RESULT_LINE = /^(\\((?:pass|fail|skip|todo)\\) .*) \\[[0-9]+(?:\\.[0-9]+)?(?:ms|s)\\]$/;", replacement: "const RESULT_LINE = /^(\\((?:pass|fail|skip|todo)\\) ).*$/;" },
  { name: 'fix2-s4-everything-varies', origin: 'fix S4: only lines two plain runs disagree on are learned', file: 'parity.mjs', tool: 'tools', expect: { check: 'parity-output-unmasked' },
    anchor: '  return new Set(multisetDifference(outputLines(firstPlain), outputLines(secondPlain)).map(([line]) => lineShape(line)));', replacement: '  return new Set([...outputLines(firstPlain), ...outputLines(secondPlain)].map(lineShape));' },
  { name: 'fix2-s5-modules-digest-dropped', origin: 'fix S5: the header names the recording semantics and the modules recorded', file: 'record.mjs', tool: 'tools', expect: { check: 'record-header' },
    anchor: 'modulesDigest: raw.modules?.[family] ?? null,', replacement: 'modulesDigest: null,' },
  { name: 'fix2-m2-unknown-option-accepted', origin: 'fix M2/M3: an unknown option is a usage error', file: 'record.mjs', tool: 'tools', expect: { check: 'cli-unknown-option' },
    anchor: '    return { options, positionals, error: `unknown option ${arg}` };', replacement: '    continue;' },

  // ------------------------------------------------------------ the third review's (C0ab review 3, all 11)
  { name: 'r3-silent-4', toys: ['toy-gate.toy.mjs'], origin: 'review 3: a window ends after 4 silent generations', file: R, tool: 'corpus', expect: { case: toyCase('many promise generations from its gate'), check: 'flags' },
    anchor: 'export const SILENT_GENERATIONS = 64;', replacement: 'export const SILENT_GENERATIONS = 4;' },
  { name: 'r3-test-resolve-no-window', toys: ['toy-unrecordable.toy.mjs'], origin: 'review 3: a promise test code resolves opens no window', file: R, tool: 'corpus', expect: { case: toyCase('a promise the test resolves releases no input'), check: 'flags' },
    anchor: "  if (origin === 'harness' || stepSeq === 0) return null;", replacement: "  if (origin === 'harness' || origin === 'test' || stepSeq === 0) return null;" },
  { name: 'r3-late-timer-to-current', toys: ['toy-gate.toy.mjs'], origin: 'review 3: a late timer opens its step in the current case', file: R, tool: 'corpus', expect: { case: toyCase('fires after its test ended'), check: 'step-count' },
    anchor: "guard('timer.fire', () => openStep(store.family, { kind: 'timer', id }, opener, store.case), null)", replacement: "guard('timer.fire', () => openStep(store.family, { kind: 'timer', id }, opener, current), null)" },
  { name: 'r3-oldest-window', toys: ['toy-gate.toy.mjs'], origin: 'review 3: the oldest active window wins', file: R, tool: 'corpus', expect: { case: toyCase('a release inside another release window'), check: 'effects', step: 3 },
    anchor: '  for (const entry of activeWindows) if (!window || entry.id > window.id) window = entry;', replacement: '  for (const entry of activeWindows) if (!window || entry.id < window.id) window = entry;' },
  { name: 'r3-window-never-closes', toys: ['toy-gate.toy.mjs'], origin: 'review 3: windows never leave the active list', file: R, tool: 'corpus', expect: { case: toyCase('a control that yields twice before acting'), check: 'effects', step: 1 },
    anchor: '  if (index >= 0) activeWindows.splice(index, 1);', replacement: '' },
  { name: 'r3-withresolvers-raw', toys: ['toy-gate.toy.mjs'], origin: 'review 3: Promise.withResolvers hands out the raw resolve', file: R, tool: 'corpus', expect: { case: toyCase('a gate made by Promise.withResolvers'), check: 'effects', step: 1 },
    anchor: '      made.resolve = pair.resolve;\n', replacement: '' },
  { name: 'r3-late-effect-unmarked', toys: ['toy-unrecordable.toy.mjs'], origin: 'review 3: an effect after the test ended, in a step opened before, is not marked late', file: R, tool: 'corpus', expect: { case: toyCase('a waiter the next test releases stays in its own case'), check: 'effects', step: 1 },
    anchor: '  if (owner.endNow !== null && step.late !== true) effect.late = true;', replacement: '' },
  { name: 'r3-unplaced-uncounted', toys: ['toy-unplaced.toy.mjs'], origin: 'review 3: an effect after the recording was written is not counted', file: R, tool: 'corpus', expect: { check: 'unplaced-expected' },
    anchor: 'function noteUnplaced(kind) {\n  unplaced += 1;', replacement: 'function noteUnplaced(kind) {\n  return;' },
  { name: 'r3-effect-owner-current', toys: ['toy-unrecordable.toy.mjs'], origin: 'review 3: an engine effect is placed with the current case as owner', file: R, tool: 'corpus', expect: { case: toyCase('a waiter the next test releases stays in its own case'), check: 'effects', step: 1 },
    anchor: "  if (origin === 'engine') return place(stepOf(store), store.case, effect);", replacement: "  if (origin === 'engine') return place(stepOf(store), current, effect);" },
  { name: 'r3-cross-family-moved', toys: ['toy-unrecordable.toy.mjs'], origin: 'review 3: a window moves chains of any family or case', file: R, tool: 'corpus', expect: { case: toyCase('a waiter another family releases'), check: 'flags' },
    anchor: '    if (window.step !== null && window.case === store.case && window.family === store.family) {', replacement: '    if (window.step !== null) {' },
  { name: 'r3-backward-move', toys: ['toy-gate.toy.mjs'], origin: 'review 3: a window may move a chain backward', file: R, tool: 'corpus', expect: { case: toyCase('a release inside another release window'), check: 'effects', step: 3 },
    anchor: '      if (seq < stepNumber(window.step)) store.step = window.step;', replacement: '      store.step = window.step;' },

  // ------------------------------------------------------------ the third review's fixes
  { name: 'fix3-b1-results-raw', toys: ['toy-gate.toy.mjs'], origin: 'fix 3 B1: engine code an entry returns is handed out wrapped', file: R, tool: 'corpus', expect: { case: toyCase('a closure an entry returns'), check: 'flags' },
    anchor: '  if (typeof value === \'object\' && (isPromise(value) || !(whole || carriesCode(value)))) return value;', replacement: '  if (!whole) return value;' },
  { name: 'fix3-b1-generator-raw', toys: ['toy-gate.toy.mjs'], origin: 'fix 3 B1: an iterator\'s next is an input', file: R, tool: 'corpus', expect: { case: toyCase('an async iterator an entry returns'), check: 'flags' },
    anchor: 'const GENERATOR_HOLDERS = new RealSet([GeneratorPrototype, AsyncGeneratorPrototype]);', replacement: 'const GENERATOR_HOLDERS = new RealSet([]);' },
  { name: 'fix3-b1-getters-raw', toys: ['toy-gate.toy.mjs'], origin: 'fix 3 B1: a getter the test reads is an input', file: R, tool: 'corpus', expect: { case: toyCase('a getter the test reads'), check: 'flags' },
    anchor: "    return callEntry(family, { input: 'get' }, label, descriptor.get, object, [], undefined, null);", replacement: '    return reflectGet(object, key);' },
  { name: 'fix3-b1-port-calls-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'fix 3 B1: a family\'s port called outside a chain is flagged', file: R, tool: 'corpus', expect: { case: toyCase('engine code deep inside returned data'), check: 'flags' },
    anchor: '    if (!engine && families) flagOutside();', replacement: '' },
  { name: 'fix3-b1-unwrappable-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'fix 3 B1: engine code that cannot be wrapped is flagged', file: R, tool: 'corpus', expect: { case: toyCase('a member of a frozen object'), check: 'flags' },
    anchor: "current.flags.add('unwrappable');", replacement: '{}' },
  { name: 'fix3-s1-expiry-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'fix 3 S1: a chain that wakes after its window expired is flagged', file: R, tool: 'corpus', expect: { case: toyCase('more than 64 silent generations'), check: 'flags' },
    anchor: '  if (!placed) checkExpired(store, seq);', replacement: '' },
  { name: 'fix3-s2-port-release-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'fix 3 S2: a promise port code resolves opens a window', file: R, tool: 'corpus', expect: { case: toyCase('a promise a port resolves on its own'), check: 'flags' },
    anchor: "  if (origin === 'harness' || stepSeq === 0) return null;", replacement: "  if (origin === 'harness' || origin === 'port' || stepSeq === 0) return null;" },
  { name: 'fix3-s3-injected-answers-raw', toys: ['toy-gate.toy.mjs'], origin: 'fix 3 S3: an injected port may wrap its answers', file: R, tool: 'corpus', expect: { case: toyCase('a stream a port answers'), check: 'input', step: 2 },
    anchor: '    const options = { wrapAnswers: item.wrapAnswers === true };', replacement: '    const options = { wrapAnswers: false };' },
  { name: 'fix3-s3-answer-members-raw', toys: ['toy-gate.toy.mjs'], origin: 'fix 3 S3: a wrapped answer whose member has behaviour is a port object', file: R, tool: 'corpus', expect: { case: toyCase('a stream a port answers'), check: 'input', step: 2 },
    anchor: '      if (wrapAnswers) return apply(PromiseThen, result, [(value) => (answerLike(value) ?', replacement: '      if (wrapAnswers) return apply(PromiseThen, result, [(value) => (portLike(value) ?' },
  { name: 'fix3-s5-plain-unchecked', origin: 'fix 3 S5: a recording is gated on the plain pass set', file: 'record.mjs', tool: 'tools', expect: { check: 'record-plain-differs' },
    anchor: '    if (!before || before.status !== test.status) differences.push(', replacement: '    if (false) differences.push(' },
]);

/**
 * Copies this directory to `<parent>/<name>/scripts/client-conformance` (with
 * the scripts its tools import) and applies the mutant's replacement; the
 * anchor must occur exactly once. A mutant without an anchor is an unchanged
 * copy (the batch's control). Returns `{ root, harnessDir }`.
 */
export function buildMutant(mutant, parent, { recorderOnly = false } = {}) {
  const root = path.join(parent, mutant.name);
  const harnessDir = path.join(root, 'scripts/client-conformance');
  // The tracked recordings stay out: every comparison reads the repository's own toy/expected.
  const expected = path.join(HARNESS_DIR, 'toy', 'expected');
  const filter = (source) => source !== expected;
  if (recorderOnly) {
    // A copy only recorded from (the batch): the recorder, what it imports, and the toys.
    if (!RECORDER_FILES.includes(mutant.file ?? RECORDER_FILES[0]) && !String(mutant.file).startsWith('toy/')) throw new Error(`planted difference ${mutant.name}: ${mutant.file} is not in a recorder-only copy`);
    for (const name of RECORDER_FILES) cpSync(path.join(HARNESS_DIR, name), path.join(harnessDir, name), { recursive: true, filter });
  } else {
    cpSync(HARNESS_DIR, harnessDir, { recursive: true, filter });
    mkdirSync(path.join(root, 'scripts/qa'), { recursive: true });
    for (const name of SUPPORT) cpSync(path.join(REPOSITORY_ROOT, 'scripts', name), path.join(root, 'scripts', name));
  }
  if (mutant.anchor === undefined) return { root, harnessDir };
  const file = path.join(harnessDir, mutant.file);
  const source = readFileSync(file, 'utf8');
  const occurrences = source.split(mutant.anchor).length - 1;
  if (occurrences !== 1) throw new Error(`planted difference ${mutant.name}: its anchor occurs ${occurrences} times in ${mutant.file}`);
  writeFileSync(file, source.replace(mutant.anchor, () => mutant.replacement));
  return { root, harnessDir };
}

const toyPath = (name) => `scripts/client-conformance/toy/${name}`;
/** What a corpus run reports: the comparison with toy/expected, and what made the recording incomplete (an unplaced effect the fixtures must have included). */
const corpusDifferences = (recording, testFiles, compare = compareWithExpected) => [...compare(recording.containers, path.join(HARNESS_DIR, 'toy/expected'), { testFiles }), ...recording.incomplete];

// The plain runs of parity on unchanged toy files are the same for every planted difference that leaves the
// toys alone: they are made once per set of toy files, from the repository's own copy, and shared.
const plainRuns = new Map(); // toy list -> Promise of { first, second }
function sharedPlainRuns(toys, parent) {
  const key = toys.join(',');
  if (!plainRuns.has(key)) {
    const workDir = path.join(parent, `plain-${plainRuns.size + 1}`);
    const files = toys.map(toyPath);
    const run = (name) => runBunTests({ files, cwd: REPOSITORY_ROOT, junitFile: path.join(workDir, `${name}.xml`), parallel: toys.length });
    plainRuns.set(key, (async () => ({ first: await run('baseline'), second: await run('baseline-b') }))());
  }
  return plainRuns.get(key);
}

/** Runs the mutant's tool on its copy; returns the differences that tool reports. */
export async function runMutant(mutant, parent) {
  const { root, harnessDir } = buildMutant(mutant, parent);
  const workDir = path.join(parent, `${mutant.name}-work`);
  const toys = mutant.toys ?? TOY_TESTS;
  const testFiles = toys.map(toyPath);
  const load = (name) => import(pathToFileURL(path.join(harnessDir, name)).href);
  if (mutant.tool === 'vectors') {
    const [codec, vectors] = await Promise.all([load('codec.mjs'), load('vectors.mjs')]);
    return vectors.checkVectors({ codec, file: path.join(harnessDir, 'vectors.ndjson') });
  }
  if (mutant.tool === 'tools') return (await load('selfchecks.mjs')).toolChecks();
  if (mutant.tool === 'parity') {
    const plain = mutant.file.startsWith('toy/') ? undefined : await sharedPlainRuns(toys, parent);
    const result = await passSetParity({ targets: testFiles, cwd: root, root, recorder: path.join(harnessDir, 'recorder.mjs'), portMap: path.join(harnessDir, 'toy/port-map.json'), workDir, parallel: toys.length, plain });
    return [...result.differences, ...result.incomplete];
  }
  if (mutant.tool === 'corpus' || mutant.tool === 'tools-corpus') {
    // A recording made by this copy's own tools when the planted difference is in one of them.
    const record = mutant.tool === 'tools-corpus' ? await load('record.mjs') : { recordToys, compareWithExpected };
    const recording = await record.recordToys({ workDir, harnessDir, root, toys });
    return corpusDifferences(recording, testFiles, record.compareWithExpected);
  }
  const first = await recordToys({ workDir: path.join(workDir, '1'), harnessDir, root, toys });
  const second = await recordToys({ workDir: path.join(workDir, '2'), harnessDir, root, toys });
  return compareRecordings([first.containers, second.containers]).unstable;
}

// One bun process records the toys of many planted copies (corpus and stability), one test file per copy
// at a time: bun's parallel workers give every test file a realm of its own, and this preload, run in each,
// points the recorder of the copy the test file belongs to at that copy.
const BATCH_PRELOAD = `// The preload of a batch of planted copies (written by the client conformance self-test).
const toyDir = '/scripts/client-conformance/toy/';
const base = Bun.main.slice(0, Bun.main.lastIndexOf(toyDir));
globalThis[Symbol.for('devryan.client-conformance.config')] = {
  DEVRYAN_CONFORMANCE_BASE: base,
  DEVRYAN_CONFORMANCE_OUT: base + '-work/raw',
  DEVRYAN_CONFORMANCE_PORT_MAP: base + toyDir + 'port-map.json',
};
await import(base + '/scripts/client-conformance/' + 'recorder' + '.mjs');
`;

/**
 * Records `units` (`{ name, root, toys }`, each a planted copy under
 * `parent`) in one bun process; resolves each unit's `{ containers,
 * incomplete }`, or null when its recording is missing (it is then rerun alone).
 */
async function recordBatch(units, parent, parallel) {
  const preload = path.join(parent, 'batch-preload.mjs');
  writeFileSync(preload, BATCH_PRELOAD);
  for (const unit of units) mkdirSync(`${unit.root}-work/raw`, { recursive: true });
  const files = units.flatMap((unit) => unit.toys.map((toy) => path.join(unit.root, toyPath(toy))));
  const run = await runBunTests({ files, cwd: parent, preload: [preload], junitFile: path.join(parent, 'batch-junit.xml'), parallel, root: parent });
  return units.map((unit) => {
    const prefix = `${unit.name}/`;
    const junit = run.junit.filter((test) => test.file.startsWith(prefix)).map((test) => ({ ...test, file: test.file.slice(prefix.length) }));
    const raws = readRaws(`${unit.root}-work/raw`);
    if (run.junitError || raws.length < unit.toys.length) return null;
    const built = buildContainers({ raws, junit, root: unit.root, expectedFiles: unit.toys.map(toyPath), families: [] });
    return { containers: built.containers, incomplete: judgeToyProblems(built.incomplete, unit.toys).incomplete };
  });
}

/**
 * Runs the corpus and stability mutants together, one recording (two for
 * stability) per copy, in one bun process. An unchanged copy of the whole
 * toy set records beside them: unless it equals toy/expected, nothing the
 * batch reports is trusted, and every batched mutant fails with the reason.
 */
async function runBatched(mutants, parent, parallel) {
  const control = { name: 'batch-control', tool: 'corpus', toys: TOY_FILES };
  const units = [{ mutant: control, name: control.name, toys: TOY_FILES, root: buildMutant(control, parent, { recorderOnly: true }).root }];
  for (const mutant of mutants) {
    const toys = mutant.toys ?? TOY_TESTS;
    const copies = mutant.tool === 'stability' ? [mutant.name, `${mutant.name}-again`] : [mutant.name];
    for (const name of copies) units.push({ mutant, name, toys, root: buildMutant({ ...mutant, name }, parent, { recorderOnly: true }).root });
  }
  const recorded = await recordBatch(units, parent, parallel);
  const controlled = recorded[0] === null ? ['the control copy was not recorded'] : corpusDifferences(recorded[0], TOY_FILES.map(toyPath)).map((entry) => JSON.stringify(entry).slice(0, 300));
  if (controlled.length) throw new Error(`the batch's unchanged copy differs from toy/expected, so the batch proves nothing: ${controlled.slice(0, 3).join('; ')}`);
  return Promise.all(mutants.map(async (mutant) => {
    const mine = recorded.filter((_entry, index) => units[index].mutant === mutant);
    if (mine.some((entry) => entry === null)) return { mutant, differences: await runMutant(mutant, path.join(parent, 'alone')) };
    const toys = mutant.toys ?? TOY_TESTS;
    if (mutant.tool === 'stability') return { mutant, differences: compareRecordings(mine.map((entry) => entry.containers)).unstable };
    return { mutant, differences: corpusDifferences(mine[0], toys.map(toyPath)) };
  }));
}

/** Whether `differences` (of the mutant's tool) hold the one the mutant must cause. */
export function caught(mutant, differences) {
  const expected = mutant.expect;
  return differences.some((difference) => {
    if (expected.vector) return difference.name === expected.vector && difference.check === 'vectors';
    if (expected.test) return typeof difference.test === 'string' && expected.test.test(difference.test) && difference.check === (expected.check ?? 'outcome');
    if (mutant.tool === 'tools') return difference.check === expected.check;
    if (expected.container && !(typeof difference.container === 'string' && expected.container.test(difference.container))) return false;
    if (expected.case && !(typeof difference.case === 'string' && expected.case.test(difference.case))) return false;
    return difference.check === expected.check && (expected.step === undefined || difference.step === expected.step);
  });
}

/**
 * Runs every mutant; resolves `[{ mutant, differences, caught, error? }]` in
 * list order. Corpus and stability mutants record together in one bun process
 * (`concurrency` workers); the others run `concurrency` at a time beside it.
 */
export async function runPlanted(scratch, { concurrency = 6, only } = {}) {
  const parent = realpathSync(scratch);
  const list = only ? PLANTED.filter((mutant) => only.includes(mutant.name)) : PLANTED;
  const results = new Array(list.length);
  const settle = (mutant, run) => run.then(
    (differences) => { results[list.indexOf(mutant)] = { mutant, differences, caught: caught(mutant, differences) }; },
    (error) => { results[list.indexOf(mutant)] = { mutant, differences: [], caught: false, error: String(error?.stack ?? error) }; },
  );
  const batched = list.filter((mutant) => mutant.tool === 'corpus' || mutant.tool === 'stability');
  const alone = list.filter((mutant) => !batched.includes(mutant));
  const batch = batched.length === 0 ? Promise.resolve() : runBatched(batched, parent, concurrency).then(
    (done) => Promise.all(done.map(({ mutant, differences }) => settle(mutant, Promise.resolve(differences)))),
    (error) => Promise.all(batched.map((mutant) => settle(mutant, Promise.reject(error)))),
  );
  let next = 0;
  const worker = async () => {
    while (next < alone.length) {
      const mutant = alone[next++];
      await settle(mutant, runMutant(mutant, parent));
    }
  };
  await Promise.all([batch, ...Array.from({ length: Math.min(concurrency, alone.length) }, worker)]);
  return results;
}
