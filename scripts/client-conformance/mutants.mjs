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
//   census      the change-set check and the census (census.mjs) on a recording of the whole toy set, by check and name
//   family      the family command's own checks (familychecks.mjs) on two shared toy recordings, by name
// `origin` says where the planted difference comes from: the builder's nine,
// the review's 38 (C0ab review S7, by its category), the ones that pin the
// review fixes, the second review's ten not already planted, the ones that
// pin the second review's fixes, the third review's eleven, and the ones that
// pin the third review's fixes, those of package C0c (`origin: 'C0c: ...'`), its
// fix rounds (`'C0c fix ...'`, `'C0c second fix ...'`) and its second review's
// missed ones (`'C0c review 2, ...'`). A corpus result also carries the toy
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
    anchor: 'const readNow = (kase = caseOf(storeNow())) => (fakeTimersOn() ? apply(RealDateNow, RealDate, []) : kase.clock.now);', replacement: 'const readNow = () => apply(RealDateNow, RealDate, []);' },
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
    anchor: '        advance(timed.clock, setAt + span * fires);', replacement: '        advance(timed.clock, setAt + span * fires + 1);' },
  { name: 'clock-not-noted', toys: ['toy-clock.toy.mjs'], origin: 'review: clock, clock not noted', file: R, tool: 'corpus', expect: { case: toyCase('new Date() and Date.now() read the same clock'), check: 'effects', step: 1 },
    anchor: "    if (origin === 'engine') record({ kind: 'clock', source, value: ref(value) }, store);", replacement: "    if (false) record({ kind: 'clock', source, value: ref(value) }, store);" },
  { name: 'clock-performance-origin', toys: ['toy-clock.toy.mjs'], origin: 'review: clock, performance origin', file: R, tool: 'corpus', expect: { case: toyCase('new Date() and Date.now() read the same clock'), check: 'effects', step: 1 },
    anchor: 'export const PERFORMANCE_ORIGIN = 1000;', replacement: 'export const PERFORMANCE_ORIGIN = 0;' },
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
    anchor: ": `t${(caseOf(store).testCalls += 1)}`, args: ref(listOf(args)) }), null);", replacement: ': (familyRecord(\'toy-transport\').portCalls += 1), args: ref(listOf(args)) }), null);' },
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
    anchor: "  realModuleOf(mock)('bun:test', () => ({ ...bunTest, spyOn, setSystemTime, ...ownedTestApi() }));", replacement: "  realModuleOf(mock)('bun:test', () => ({ ...bunTest, spyOn: bunTest.spyOn, setSystemTime, ...ownedTestApi() }));" },
  { name: 'globals-rearm-off', toys: ['toy-unrecordable.toy.mjs'], origin: 'review: globals, re-arm off', file: R, tool: 'corpus', expect: { case: toyCase('that data property is re-armed at the next test boundary'), check: 'flags' },
    anchor: 'const rearmGlobals = () => { apply(MapForEach, controls,', replacement: 'const rearmGlobals = () => { if (true) return; apply(MapForEach, controls,' },
  { name: 'globals-setsystemtime-ignored', toys: ['toy-clock.toy.mjs'], origin: 'review: globals, setSystemTime ignored', file: R, tool: 'parity', expect: { test: toyCase('setSystemTime and jest.setSystemTime set the clock') },
    anchor: '      clock.overrideSetAt = value;\n      clock.now = value;', replacement: '      clock.overrideSetAt = value;' },
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
    anchor: "  return record.kind === 'test' || ownKeys(families).length > 0 || record.out.contextRecords > 0 || flags.length > 0;", replacement: "  return record.kind === 'test';" },
  { name: 'fix-s3-crossing-ignored', toys: ['toy-flow.toy.mjs'], origin: 'fix S3: a port that is another family\'s entry is recorded', file: R, tool: 'corpus', expect: { case: toyCase('a port that is another family\'s entry is a port call'), check: 'effects', step: 2 },
    anchor: '    if (store.family === family || !crossing || !apply(SetHas, crossing.families, [store.family])) return invoke(args); // inlined', replacement: '    return invoke(args);' },
  { name: 'fix-s4-most-recent-step', toys: ['toy-flow.toy.mjs'], origin: 'fix S4: effects belong to the input that caused them', file: R, tool: 'corpus', expect: { case: toyCase('a microtask continuation belongs to its own call'), check: 'effects', step: 2 },
    anchor: "  if (origin === 'engine') return place(stepOf(store), store.case, effect);", replacement: "  if (origin === 'engine') { const steps = familyRecord(store.family, store.case).steps; return place(steps[steps.length - 1], store.case, effect); }" },
  { name: 'fix-s4-no-during', toys: ['toy-flow.toy.mjs'], origin: 'fix S4: a re-entrant input is marked during its step', file: R, tool: 'corpus', expect: { case: toyCase('a callback a port invokes re-entrantly'), check: 'input', step: 3 },
    anchor: '  if (caller && caller.kind === \'engine\' && caller.case === owner && caller.family === family) step.input.during = caller.step.n;', replacement: '' },
  { name: 'fix-s5-date-now-stub-unrecorded', toys: ['toy-clock.toy.mjs'], origin: 'fix S5: a Date.now stub\'s answers are recorded', file: R, tool: 'corpus', expect: { case: toyCase('a Date.now the test assigns answers'), check: 'effects', step: 1 },
    anchor: "  return stubWrapper(value, 'Date.now', 'clock');", replacement: '  return value;' },
  { name: 'fix-s5-fake-timers-ignored', toys: ['toy-clock.toy.mjs'], origin: 'fix S5: fake timers move the clock as without the recorder', file: R, tool: 'parity', expect: { test: toyCase('fake timers advance the clock as they do without the recorder') },
    anchor: 'const readNow = (kase = caseOf(storeNow())) => (fakeTimersOn() ? apply(RealDateNow, RealDate, []) : kase.clock.now);', replacement: 'const readNow = (kase = caseOf(storeNow())) => kase.clock.now;' },
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
    anchor: "    return callEntry(family, HANDED_OUT_GET, label, descriptor.get, object, [], undefined, null);", replacement: '    return reflectGet(object, key);' },
  { name: 'fix3-b1-port-calls-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'fix 3 B1: a family\'s port called outside a chain is flagged', file: R, tool: 'corpus', expect: { case: toyCase('engine code deep inside returned data'), check: 'flags' },
    anchor: '    if (!engine && families) flagOutside(families, name);', replacement: '' },
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

  // ------------------------------------------------------------ package C0c: change sets, census, caller rule, slices, iterators
  { name: 'c0c-change-set-wrong', origin: 'C0c: a wrong change set', file: R, tool: 'census', expect: { check: 'change-set', name: /toy-reducer/ },
    anchor: '    if (before) step.changes = ref(changedPaths(before, args[draft]), kase);', replacement: '    if (before) step.changes = ref(changedPaths(before, args[draft]).slice(1), kase);' },
  { name: 'c0c-change-set-dropped', origin: 'C0c: a draft step without its change set', file: R, tool: 'census', expect: { check: 'draft-recorded', name: /toy-reducer/ },
    anchor: '    if (before) step.changes = ref(changedPaths(before, args[draft]), kase);', replacement: '' },
  { name: 'c0c-truncated-state', origin: 'C0c: a truncated state (the draft recorded one level deep)', file: R, tool: 'census', expect: { check: 'change-set', name: /toy-reducer/ },
    anchor: "  const input = { kind: spec.input ?? (newTarget !== undefined ? 'new' : 'call'), entry: label, args: ref(listOf(args), kase) };",
    replacement: "  const shallow = (value) => (value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, member]) => [key, member && typeof member === 'object' ? {} : member])) : value);\n  const input = { kind: spec.input ?? (newTarget !== undefined ? 'new' : 'call'), entry: label, args: ref(listOf(args).map((arg, index) => (index === spec.draft ? shallow(arg) : arg)), kase) };" },
  { name: 'c0c-export-missing', origin: 'C0c: an export no test exercises and no waiver names', file: 'toy/toy-reducer.mjs', tool: 'census', expect: { check: 'census-export', name: /toy-reducer#resetState/ },
    anchor: 'export function createState() {', replacement: 'export function resetState() { return null; }\n\nexport function createState() {' },
  { name: 'c0c-census-export-lost', origin: 'C0c: the census loses an export of a module', file: R, tool: 'census', expect: { check: 'census-exports-scanned', name: /toy-reducer/ },
    anchor: '        apply(MapSet, scannedModules, [file, [...exports].sort()]);', replacement: "        apply(MapSet, scannedModules, [file, [...exports, 'lostExport'].sort()]);" },
  { name: 'c0c-waiver-exercised', origin: 'C0c: a waived export that is in fact exercised', file: 'toy/census.json', tool: 'census', expect: { check: 'waiver-exercised', name: /toy-reducer#applyEvent/ },
    anchor: '  "exports": [\n', replacement: '  "exports": [\n    { "family": "toy-reducer", "export": "applyEvent", "reason": "planted" },\n' },
  { name: 'c0c-waiver-stale', origin: 'C0c: a waiver of an export that does not exist', file: 'toy/census.json', tool: 'census', expect: { check: 'waiver-stale', name: /toy-reducer#removedExport/ },
    anchor: '  "exports": [\n', replacement: '  "exports": [\n    { "family": "toy-reducer", "export": "removedExport", "reason": "planted" },\n' },
  { name: 'c0c-event-unexercised', origin: 'C0c: an event type the reducer handles that no recorded case delivers', file: 'toy/toy-reducer.mjs', tool: 'census', expect: { check: 'census-event', name: /session\.renamed/ },
    anchor: "    case 'probe':", replacement: "    case 'session.renamed': return false;\n    case 'probe':" },
  { name: 'c0c-port-unexercised', origin: 'C0c: a port of the map that no recorded case calls', file: 'toy/port-map.json', tool: 'census', expect: { check: 'census-port', name: /toy-guard\.mjs#deferred/ },
    anchor: '"ports": [{ "module": "toy-guard.mjs", "exports": ["guard"] }]', replacement: '"ports": [{ "module": "toy-guard.mjs", "exports": ["guard", "deferred"] }]' },
  { name: 'c0c-unrecordable-partial-waiver', origin: 'C0c: a case waived although one of its flags is not', file: 'census.mjs', tool: 'tools', expect: { check: 'census-unrecordable-partial' },
    anchor: '    if (covering.every((index) => index >= 0)) {', replacement: '    if (covering.some((index) => index >= 0)) {' },
  { name: 'c0c-unstable-waiver-any-family', origin: 'C0c: an unstable waiver of one family waives another', file: 'census.mjs', tool: 'tools', expect: { check: 'census-unstable-waiver' },
    anchor: '(!item.family || item.family === family));', replacement: 'true);' },
  { name: 'c0c-exclusion-never-stale', origin: 'C0c: an exclusion of a file that no longer exists passes', file: 'census.mjs', tool: 'tools', expect: { check: 'census-exclusions' },
    anchor: 'const stale = census.excludedFiles.filter((item) => !all.includes(item.file))', replacement: 'const stale = census.excludedFiles.filter(() => false)' },
  { name: 'c0c-family-waiver-exercised', origin: 'C0c: a family waived as untested that records cases', file: 'toy/census.json', tool: 'census', expect: { check: 'waiver-exercised', name: /toy-reducer#\(family\)/ },
    anchor: '  "exports": [\n', replacement: '  "families": [{ "family": "toy-reducer", "reason": "planted" }],\n  "exports": [\n' },
  { name: 'c0c-passthrough-store-off', toys: ['toy-host.toy.mjs'], origin: 'C0c: what a passed-through call does is taken for engine code outside a chain', file: R, tool: 'corpus', expect: { case: toyCase('passed through, not a step'), check: 'flags' },
    anchor: "  const store = { kind: 'passthrough', case: current, active: true };\n  try { return als.run(store, run); } finally { store.active = false; }", replacement: '  return run();' },
  { name: 'c0c-no-frame-recorded', toys: ['toy-host.toy.mjs'], origin: 'C0c: a call with no frame (an engine continuation\'s tail call) is taken for the test\'s', file: R, tool: 'corpus', expect: { case: toyCase('passed through, not a step'), check: 'step-count' },
    anchor: '    if (caller === null ? spec.handedOut !== true : !caller.test) return passThrough(', replacement: '    if (caller !== null && !caller.test) return passThrough(' },
  { name: 'c0c-caller-rule-off', toys: ['toy-host.toy.mjs'], origin: 'C0c: an entry an unmapped engine module calls is recorded as the test\'s', file: R, tool: 'corpus', expect: { case: toyCase('passed through, not a step'), check: 'step-count' },
    anchor: "return passThrough(family, label, caller, origin === 'passthrough', () => invoke(args));", replacement: '{}' },
  { name: 'c0c-slices-off', toys: ['toy-host.toy.mjs'], origin: 'C0c: large values stored whole, not as slices', file: 'container.mjs', tool: 'tools-corpus', expect: { container: /toy-host\.toy\.mjs\.toy-reducer/, check: 'value-table' },
    anchor: 'export const SLICE_MIN = 1024;', replacement: 'export const SLICE_MIN = 1e15;' },
  { name: 'c0c-slices-unexpanded', origin: 'C0c: the reader hands out a tree with its slices in place', file: 'container.mjs', tool: 'tools', expect: { check: 'container-slices' },
    anchor: '    return expand(values.get(slot.slice(1)), (hash) => values.get(hash));', replacement: '    return values.get(slot.slice(1));' },
  { name: 'c0c-outside-flag-case-wide', toys: ['toy-unrecordable.toy.mjs'], origin: 'C0c: a port used outside a chain flags every family of the case', file: R, tool: 'corpus', expect: { case: toyCase('flags only the families it is a port of'), check: 'flags' },
    anchor: "    if (record && !(test && lineOnly)) record.flags.add('outside-chain');\n    else if (test) flagFamily(name, 'port-no-line');", replacement: "    current.flags.add('outside-chain');" },
  { name: 'c0c-unmapped-port-flagged', toys: ['toy-host.toy.mjs'], origin: 'C0c: a port an unmapped engine module uses is flagged as a family\'s', file: R, tool: 'corpus', expect: { container: /toy-host\.toy\.mjs\.toy-gate/, case: toyCase('passed through, not a step'), check: 'flags' },
    anchor: '  if (!test && (passing || own === undefined)) { notePassedPort(port, file, passing); return; }', replacement: '  if (passing) { notePassedPort(port, file, passing); return; }' },
  { name: 'c0c-iterator-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'C0c: an iterator the engine is handed is written as an empty object', file: C, tool: 'corpus', expect: { case: toyCase('an iterator the engine is handed'), check: 'flags' },
    anchor: "    if (!wrapped && apply(isPrototypeOf, IteratorPrototype, [item])) context.flags.add('iterator');", replacement: '' },
  // ------------------------------------------------------------ the C0c fix round (review C0c: B1, S1 to S7, M1 to M3; the reviewer's ten re-planted)
  { name: 'fix-c0c-b1-store-inherited', toys: ['toy-unrecordable.toy.mjs'], origin: 'C0c fix B1: a pass-through store holds only for its call\'s synchronous extent', file: R, tool: 'corpus', expect: { case: toyCase('engine code a passed-through call puts on a timer'), check: 'unrecordable-expected' },
    anchor: "  return store !== undefined && store.kind === 'passthrough' && store.active !== true ? undefined : store;", replacement: '  return store;' },
  { name: 'fix-c0c-b1-store-decides', toys: ['toy-callers.toy.mjs'], origin: 'C0c fix B1: inside a pass-through call the caller frame still decides', file: R, tool: 'corpus', expect: { case: toyCase('runs at once is the test'), check: 'result' },
    anchor: "  if (origin === 'test' || origin === 'passthrough') {\n    const caller", replacement: "  if (origin === 'passthrough') return passThrough(family, label, { file: null, test: false }, true, () => invoke(args));\n  if (origin === 'test' || origin === 'passthrough') {\n    const caller" },
  { name: 'r01-tests-dir-not-test-code', origin: 'C0c fix, review r01: a helper under __tests__ is test code', file: 'port-map.mjs', toys: ['toy-callers.toy.mjs'], tool: 'corpus', expect: { case: toyCase('helpers under __tests__'), check: 'result' },
    anchor: '(?:test|tests|__tests__|__mocks__)', replacement: '(?:test|tests|__mocks__)' },
  { name: 'r02-underscore-test-not-test-code', origin: 'C0c fix, review r02: a helper named name_test is test code', file: 'port-map.mjs', toys: ['toy-callers.toy.mjs'], tool: 'corpus', expect: { case: toyCase('helpers under __tests__'), check: 'result' },
    anchor: '[._](?:test|spec)', replacement: '[.](?:test|spec)' },
  { name: 'r03-unmapped-not-counted', origin: 'C0c fix, review r03: every passed-through call is counted and shown', file: R, tool: 'family', expect: { check: 'family-passed-totals' },
    anchor: '    bump(unmapped, family, name);\n    bump(callers, callerName(caller?.file ?? null), key);\n    passed.calls += 1;', replacement: '' },
  { name: 'fix-c0c-nested-uncounted', origin: 'C0c fix S1: a call inside a pass-through call is counted too', file: R, tool: 'family', expect: { check: 'family-passed-totals' },
    anchor: '    if (nested) passed.nested += 1;', replacement: '' },
  { name: 'fix-c0c-no-frame-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'C0c fix S1: a call with no frame flags its case', file: R, tool: 'corpus', expect: { case: toyCase('an entry the test hands to a promise'), check: 'unrecordable-expected' },
    anchor: "      if (!apply(SetHas, NO_FRAME_ALLOWED, [key])) flagFamily(family, 'no-frame');", replacement: '' },
  { name: 'fix-c0c-no-frame-allowance-ignored', toys: ['toy-host.toy.mjs'], origin: 'C0c fix S1: a no-frame call the census names with its engine site is passed through', file: R, tool: 'corpus', expect: { case: toyCase('passed through, not a step'), check: 'flags' },
    anchor: 'const NO_FRAME_ALLOWED = new RealSet(String(', replacement: 'const NO_FRAME_ALLOWED = new RealSet([]) || new RealSet(String(' },
  { name: 'fix-c0c-handed-out-no-frame-dropped', toys: ['toy-gate.toy.mjs'], origin: 'C0c fix S1: a thenable the test awaits is an input although no frame shows it', file: R, tool: 'corpus', expect: { case: toyCase('a getter the test reads and a thenable'), check: 'flags' },
    anchor: 'caller === null ? spec.handedOut !== true : !caller.test', replacement: 'caller === null || !caller.test' },
  { name: 'r06-ports-without-line-dropped', toys: ['toy-unrecordable.toy.mjs'], origin: 'C0c fix, review r06: a port test code uses where its family has no line flags a line', file: R, tool: 'corpus', expect: { case: toyCase('whose frame a tail call removed'), check: 'unrecordable-expected' },
    anchor: "    else if (test) flagFamily(name, 'port-no-line');", replacement: '' },
  { name: 'fix-c0c-outside-no-line', toys: ['toy-unrecordable.toy.mjs'], origin: 'C0c fix S2: engine code on the stack with no chain gives its family a line', file: R, tool: 'corpus', expect: { case: toyCase('reads the clock where no family has a line'), check: 'unrecordable-expected' },
    anchor: '  for (const name of found) familyRecord(name);', replacement: '' },
  { name: 'fix-c0c-flagged-without-line-ignored', origin: 'C0c fix S2: a flagged case no family line carries is a problem', file: 'record.mjs', tool: 'tools', expect: { check: 'record-flagged-without-line' },
    anchor: '      if (lost.length && Object.keys(recorded.families).length === 0) {', replacement: '      if (false) {' },
  { name: 'r09-slice-escape-value', origin: 'C0c fix, review r09: an escape node\'s own object is never a slice', file: 'container.mjs', tool: 'tools', expect: { check: 'container-slice-escape-many' },
    anchor: "      const escaped = node.$dr === 'escape';", replacement: '      const escaped = false;' },
  { name: 'fix-c0c-proto-dropped', origin: 'C0c fix S3: an own __proto__ member survives slices', file: 'container.mjs', tool: 'tools', expect: { check: 'container-proto-member' },
    anchor: "  if (key === '__proto__') Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });\n  else object[key] = value;", replacement: '  object[key] = value;' },
  { name: 'fix-c0c-resolve-shared', origin: 'C0c fix: resolve() never hands out one object for two places', file: 'container.mjs', tool: 'tools', expect: { check: 'container-resolve-independent' },
    anchor: '    if (!escapedValue && isSlice(node)) return walk(lookup(node.hash), false);', replacement: '    if (!escapedValue && isSlice(node)) { const memo = (globalThis.__plantedMemo ??= new Map()); if (!memo.has(node.hash)) memo.set(node.hash, walk(lookup(node.hash), false)); return memo.get(node.hash); }' },
  { name: 'r25-changeset-checker-length-only', origin: 'C0c fix, review r25 (S6): a change-set checker that compares lengths only', file: 'census.mjs', tool: 'tools', expect: { check: 'census-change-set-same-length' },
    anchor: '    if (actual.length !== expected.length || actual.some((item, at) => item !== expected[at])) {', replacement: '    if (actual.length !== expected.length) {' },
  { name: 'fix-c0c-change-set-same-length', origin: 'C0c fix S6: a change set of the right length with a wrong path', file: R, tool: 'census', expect: { check: 'change-set', name: /toy-reducer/ },
    anchor: '    if (before) step.changes = ref(changedPaths(before, args[draft]), kase);', replacement: "    if (before) step.changes = ref(changedPaths(before, args[draft]).map((where) => [...where.slice(0, -1), 'planted']), kase);" },
  { name: 'r16-data-exports-pass', origin: 'C0c fix, review r16: a data export no waiver names fails the census', file: 'census.mjs', tool: 'tools', expect: { check: 'census-data-export' },
    anchor: '      if (name === family.state) { summary.exports.state += 1; continue; }', replacement: "      if (name === family.state || kind === 'data') { summary.exports.state += 1; continue; }" },
  { name: 'fix-c0c-census-unscoped', origin: 'C0c fix S7: a census of chosen test files judges only what they show', file: 'census.mjs', tool: 'tools', expect: { check: 'census-scope' },
    anchor: '      if (!complete) { summary.exports.unjudged = ', replacement: '      if (false) { summary.exports.unjudged = ' },
  { name: 'fix-c0c-event-if-unseen', origin: 'C0c fix M3: an `if (event.type === ...)` before the switch is an event type', file: 'toy/toy-reducer.mjs', tool: 'census', expect: { check: 'census-event', name: /session\.archived/ },
    anchor: '  switch (event.type) {', replacement: "  if (event.type === 'session.archived') return false;\n  switch (event.type) {" },
  { name: 'fix-c0c-event-comparisons-ignored', origin: 'C0c fix M3: the census reads comparisons with a literal', file: 'census.mjs', tool: 'tools', expect: { check: 'census-events-seen' },
    anchor: '    for (const found of body.matchAll(pattern)) { accounted += 1; types.add(found[2]); }', replacement: '    for (const found of body.matchAll(pattern)) { accounted += 1; }' },
  { name: 'fix-c0c-waiver-any-test', origin: 'C0c fix M1: an unrecordable waiver covers the test it names only', file: 'census.mjs', tool: 'tools', expect: { check: 'census-unrecordable-test' },
    anchor: 'testsOf(waiver).includes(entry.name) && ', replacement: '' },
  { name: 'fix-c0c-waiver-flag-base-name', origin: 'C0c fix M1: an unrecordable waiver covers its exact flag only', file: 'census.mjs', tool: 'tools', expect: { check: 'census-unrecordable-test' },
    anchor: 'waiver.file === entry.file && waiver.flag === flag && ', replacement: "waiver.file === entry.file && (waiver.flag === flag || waiver.flag === flag.split(':')[0]) && " },
  { name: 'fix-c0c-classifier-off', origin: 'C0c fix S1: an unclassified caller is found', file: 'census.mjs', tool: 'tools', expect: { check: 'census-callers-unclassified' },
    anchor: '      if (!file.startsWith(scope) || isTestPath(file) || reachable.has(file)) continue;', replacement: '      continue;' },
  { name: 'r22-product-failures-pass', origin: 'C0c fix, review r22 (S7): the command exits 1 on a failed check', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-exit-precedence' },
    anchor: ': failures.length ? EXIT.fail : EXIT.pass;', replacement: ': EXIT.pass;' },
  { name: 'r23-product-census-problems-dropped', origin: 'C0c fix, review r23 (S7): census problems make the run inconclusive', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-census-problems' },
    anchor: '  incomplete.push(...merged.problems, ...censusResult.problems);', replacement: '' },
  { name: 'fix-c0c-command-classify-off', origin: 'C0c fix S1: the command makes an unclassified caller inconclusive', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-unclassified-caller' },
    anchor: '  incomplete.push(...unclassifiedCallers(passed, { scope: setup.scope, reachable: setup.reachable() }));', replacement: '' },
  { name: 'fix-c0c-targets-not-partial', origin: 'C0c fix S7: chosen test files make a partial census that can pass', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-targets-scope' },
    anchor: '  const complete = targets.length === 0;', replacement: '  const complete = true;' },
  { name: 'fix-c0c-families-unscoped', origin: 'C0c fix S7: --families scopes every judgement', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-families-scope' },
    anchor: '  const scope = families && families.length ? families : null;', replacement: '  const scope = null;' },
  { name: 'fix-c0c-required-unfiltered', origin: 'C0c fix S7: a family waived as a whole need not record a case', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-required' },
    anchor: '  const required = (scope ?? all).filter((name) => !census.families.some((item) => item.family === name));', replacement: '  const required = scope ?? all;' },
  { name: 'fix-c0c-unstable-unmarked', origin: 'C0c fix M2: an unstable case is marked in the written container', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-out' },
    anchor: "      writer.addCase({ ...record, outcome: 'unstable',", replacement: '      writer.addCase({ ...record, outcome: record.outcome,' },
  { name: 'fix-c0c-broken-census-throws', origin: 'C0c fix S7: a broken census file is a usage error', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-usage' },
    anchor: '  } catch (failure) { error(failure.message); return EXIT.usage; }', replacement: '  } catch (failure) { throw failure; }' },
  { name: 'fix-c0c-discovery-off', origin: 'C0c fix S4: the discover run keeps only tests whose test code calls a family', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-discovery' },
    anchor: '  const loading = found.files.filter((item) => item.loaded.some((file) => modules.has(file)) && (item.testCalls + item.noFrame > 0 || named.has(item.file))).map((item) => item.file);', replacement: '  const loading = found.files.filter((item) => item.loaded.some((file) => modules.has(file))).map((item) => item.file);' },
  { name: 'fix-c0c-discover-layer-blind', origin: 'C0c fix S4: the discover layer counts the calls test code makes', file: R, tool: 'family', expect: { check: 'family-discovery' },
    anchor: '            if (!first) report.noFrame += 1; else if (isTestCode(first[0])) report.testCalls += 1;\n', replacement: '            if (!first) return; else if (isTestCode(first[0])) return;\n' },
  // ------------------------------------------- the C0c second review's three missed, and the second fix round's own
  { name: 'c0c-r2-n07b-discovery-drops-no-frame', origin: 'C0c review 2, n07b: discovery keeps a test whose only family use has no frame', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-discovery' },
    anchor: '  const loading = found.files.filter(', replacement: '  for (const item of found.files) item.noFrame = 0;\n  const loading = found.files.filter(' },
  { name: 'c0c-r2-n08b-discover-layer-noframe-uncounted', origin: 'C0c review 2, n08b: the discover layer counts calls with no frame', file: R, tool: 'family', expect: { check: 'family-discovery' },
    anchor: '  const report = { file: TEST_FILE, loaded: [], testCalls: 0, noFrame: 0, callers: {} };', replacement: '  const report = { file: TEST_FILE, loaded: [], testCalls: 0, set noFrame(v) {}, get noFrame() { return 0; }, callers: {} };' },
  { name: 'c0c-r2-n11-no-frame-allowance-never-stale', origin: 'C0c review 2, n11: a no-frame allowance no call matched is stale', file: 'census.mjs', tool: 'tools', expect: { check: 'census-no-frame-stale' },
    anchor: '  return census.noFrame.filter((item) => !(passed.noFrame[`${item.family}#${item.export}`] > 0))', replacement: '  return census.noFrame.filter(() => false)' },
  { name: 'c0c-fix2-n1-discovery-keeps-unclassified', origin: 'C0c second fix N1: discovery keeps a test that reaches a family only through test support code under another name', file: 'family-run.mjs', tool: 'family', expect: { check: 'family-discovery' },
    anchor: '(item.testCalls + item.noFrame > 0 || named.has(item.file))', replacement: 'item.testCalls + item.noFrame > 0' },
  { name: 'c0c-fix2-n1-discover-layer-callers-uncounted', origin: 'C0c second fix N1: the discover layer counts the calls of every other caller file', file: R, tool: 'family', expect: { check: 'family-discovery' },
    anchor: '              const row = (report.callers[relative(first[0])] ??= {});', replacement: '              const row = {};' },
  { name: 'c0c-fix2-n3-test-function-unflagged', toys: ['toy-unrecordable.toy.mjs'], origin: 'C0c second fix N3: a test function an entry is handed that no injected port declares flags its family', file: R, tool: 'corpus', expect: { case: toyCase('a test callback an entry runs'), check: 'unrecordable-expected' },
    anchor: "  if (!portEffect && guard('entry', () => opaqueTestFunction(spec, args), false)) familyRecord(family, kase).flags.add('test-function');", replacement: '' },
  // C0c2: the per-case clock
  { name: 'c0c2-stray-moves-current-clock', toys: ['toy-stray.toy.mjs'], origin: 'C0c2 clock: a timer an earlier case left moves the clock of the case it fires in, not its own', file: R, tool: 'corpus', expect: { case: toyCase('a test that leaves timers behind'), check: 'input', step: 2 },
    anchor: '        advance(timed.clock, setAt + span * fires);', replacement: '        advance(current.clock, setAt + span * fires);' },
  { name: 'c0c2-clock-not-inherited', toys: ['toy-stray.toy.mjs'], origin: 'C0c2 clock: a case opens on a fresh clock, not on the clock the previous case closed with or its slot', file: R, tool: 'corpus', expect: { case: toyCase('the strays have fired'), check: 'state' },
    anchor: '  const clock = openClock(previous, casesOpened);', replacement: '  const clock = openClock(null, casesOpened);' },
  { name: 'c0c2-clock-no-slot', toys: ['toy-stray.toy.mjs'], origin: 'C0c2 clock: a case opens at the previous case\'s closing time, not in its own slot', file: R, tool: 'corpus', expect: { case: toyCase('the next test opens in its own slot'), check: 'state' },
    anchor: '  clock.now = Math.max(clock.now, EPOCH + index * CASE_SPAN_MS);', replacement: '' },
  { name: 'c0c2-clock-runs-backward', toys: ['toy-stray.toy.mjs'], origin: 'C0c2 clock: a case opens in its slot even when the previous case got later', file: R, tool: 'corpus', expect: { case: toyCase('the test after it opens where it ended'), check: 'state' },
    anchor: '  clock.now = Math.max(clock.now, EPOCH + index * CASE_SPAN_MS);', replacement: '  clock.now = EPOCH + index * CASE_SPAN_MS;' },
  { name: 'c0c2-stray-test-timer-in-current-context', toys: ['toy-stray.toy.mjs'], origin: 'C0c2 clock: a test timer that fires after its test ended is context of the case it fires in', file: R, tool: 'corpus', expect: { case: toyCase('a test that leaves timers behind'), check: 'context' },
    anchor: "owner.context.push(owner.endNow !== null ? { kind: 'timer.fire', id, origin: 'test', late: true } : { kind: 'timer.fire', id, origin: 'test' })", replacement: "current.context.push({ kind: 'timer.fire', id, origin: owner === current ? 'test' : `test:${owner.label}` })" },
  // C0c2: the mock-module layer
  { name: 'c0c2-mocked-call-recorded', toys: ['toy-mocked.toy.mjs'], origin: 'C0c2 mock-module: a mocked export called with no engine chain is copied into the case context again', file: R, tool: 'corpus', expect: { case: toyCase('a mocked export the test calls itself records nothing'), check: 'context' },
    anchor: '    if (!engine && mocked) { checkOutside(); return invoke(args); }', replacement: '' },
  { name: 'c0c2-mocked-call-skipped-in-chain', toys: ['toy-mocked.toy.mjs'], origin: 'C0c2 mock-module: a mocked export called inside an engine chain records nothing either', file: R, tool: 'corpus', expect: { case: toyCase('a mocked export the test calls itself records nothing'), check: 'flags' },
    anchor: '    if (!engine && mocked) { checkOutside(); return invoke(args); }', replacement: '    if (mocked) { checkOutside(); return invoke(args); }' },
  // C0c2 review: the reviewer's planted differences (C0c2-review.md), on the code as it is now; R8 is left out (equivalent, see C0c2.md)
  { name: "c0c2-r1-slot-plus-one", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R1: the slot is k+1", file: R, tool: 'corpus', expect: { case: toyCase("a test that leaves timers behind"), check: 'state' },
    anchor: "clock.now = Math.max(clock.now, EPOCH + index * CASE_SPAN_MS);", replacement: "clock.now = Math.max(clock.now, EPOCH + (index + 1) * CASE_SPAN_MS);" },
  { name: "c0c2-r2-performance-no-slot", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R2: performance has no slot", file: R, tool: 'corpus', expect: { case: toyCase("a later test reads its own clock while the strays fire"), check: 'effects' },
    anchor: "clock.performance = Math.max(clock.performance, PERFORMANCE_ORIGIN + index * CASE_SPAN_MS);", replacement: "" },
  { name: "c0c2-r3-performance-runs-backward", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R3: performance runs backward to its slot", file: R, tool: 'corpus', expect: { case: toyCase("the test after it opens where it ended"), check: 'effects' },
    anchor: "clock.performance = Math.max(clock.performance, PERFORMANCE_ORIGIN + index * CASE_SPAN_MS);", replacement: "clock.performance = PERFORMANCE_ORIGIN + index * CASE_SPAN_MS;" },
  { name: "c0c2-r4-override-not-kept", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R4: a standing setSystemTime is not kept into the next case", file: R, tool: 'corpus', expect: { case: toyCase("the next test opens at the time that stands"), check: 'effects', step: 1 },
    anchor: "if (clock.beforeOverride !== null) return clock;", replacement: "" },
  { name: "c0c2-r5-clock-shared", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R5: the clock is shared, not copied, when a case opens", file: R, tool: 'corpus', expect: { case: toyCase("a test that leaves timers behind"), check: 'input' },
    anchor: "(from ? { ...from } :", replacement: "(from ? from :" },
  { name: "c0c2-r6-timer-moves-current", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R6: a timer moves the current case's clock, not that of the case that set it", file: R, tool: 'corpus', expect: { case: toyCase("a test that leaves timers behind"), check: 'input', step: 4 },
    anchor: "    const timed = caseOf(store);", replacement: "    const timed = current;" },
  { name: "c0c2-r7-set-time-from-current", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R7: a timer takes its set time from the current case", file: R, tool: 'corpus', expect: { case: toyCase("a test that leaves timers behind"), check: 'input', step: 4 },
    anchor: "const setAt = timed.clock.now;", replacement: "const setAt = current.clock.now;" },
  { name: "c0c2-r9-late-test-timer-to-current", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R9: a late test-timer firing filed in the current case's context", file: R, tool: 'corpus', expect: { case: toyCase("a test that leaves timers behind"), check: 'context' },
    anchor: "owner.context.push(owner.endNow", replacement: "current.context.push(owner.endNow" },
  { name: "c0c2-r10-mocked-outside-no-detector", toys: ['toy-mocked-outside.toy.mjs'], origin: "C0c2 review R10: a mocked call with no chain skips the outside-chain detector", file: R, tool: 'corpus', expect: { case: toyCase("family code that calls a mocked export with no chain"), check: 'unrecordable-expected' },
    anchor: "if (!engine && mocked) { checkOutside(); return invoke(args); }", replacement: "if (!engine && mocked) { return invoke(args); }" },
  { name: "c0c2-r10b-mocked-outside-no-detector", toys: ['toy-mocked-outside.toy.mjs'], origin: "C0c2 review R10b: the same, as a line before", file: R, tool: 'corpus', expect: { case: toyCase("family code that calls a mocked export with no chain"), check: 'unrecordable-expected' },
    anchor: "    if (!engine && mocked) { checkOutside(); return invoke(args); }", replacement: "    if (!engine && mocked) return invoke(args);\n    if (!engine && mocked) { checkOutside(); return invoke(args); }" },
  { name: "c0c2-r11-mocked-half-recorded", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R11: a mocked call with no chain half recorded", file: R, tool: 'corpus', expect: { case: toyCase("a mocked export the test calls itself records nothing"), check: 'context' },
    anchor: "if (!engine && mocked) { checkOutside(); return invoke(args); }", replacement: "if (!engine && mocked) { checkOutside(); guard('port', () => current.context.push({ kind: 'port', port: name, call: `t${(current.testCalls += 1)}` })); return invoke(args); }" },
  { name: "c0c2-r12-mocked-fn-method-unmarked", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R12: mocked not passed on to a mocked function's methods", file: R, tool: 'corpus', expect: { case: toyCase("the engine's call of a mocked object's method"), check: 'context' },
    anchor: "{ thisArg: fnTarget, families, wrapAnswers, mocked }", replacement: "{ thisArg: fnTarget, families, wrapAnswers }" },
  { name: "c0c2-r13-mocked-object-method-unmarked", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R13: mocked not passed on to a mocked object's methods", file: R, tool: 'corpus', expect: { case: toyCase("the engine's call of a mocked object's method"), check: 'context' },
    anchor: "{ thisArg: object, families, wrapAnswers, mocked }", replacement: "{ thisArg: object, families, wrapAnswers }" },
  { name: "c0c2-r14-mocked-nested-unmarked", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R14: mocked not passed on to nested port objects", file: R, tool: 'corpus', expect: { case: toyCase("the engine's call of a mocked object's method"), check: 'context' },
    anchor: "value, { families, wrapAnswers, mocked })", replacement: "value, { families, wrapAnswers })" },
  { name: "c0c2-r15-mocked-method-dropped-in-chain", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R15: the engine's call of a mocked object's method dropped inside a chain", file: R, tool: 'corpus', expect: { case: toyCase("the engine's call of a mocked object's method"), check: 'flags' },
    anchor: "if (!engine && mocked) { checkOutside(); return invoke(args); }", replacement: "if ((!engine || thisArg !== undefined) && mocked) { checkOutside(); return invoke(args); }" },
  { name: "c0c2-r15b-mocked-method-dropped-in-chain", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R15b: the same, as a line before", file: R, tool: 'corpus', expect: { case: toyCase("the engine's call of a mocked object's method"), check: 'effects', step: 1 },
    anchor: "    if (!engine && mocked) { checkOutside(); return invoke(args); }", replacement: "    if (engine && mocked && thisArg !== undefined) return invoke(args);\n    if (!engine && mocked) { checkOutside(); return invoke(args); }" },
  { name: "c0c2-r16-hooks-cases-not-numbered", toys: ['toy-stray.toy.mjs'], origin: "C0c2 review R16: hooks cases get no slot number", file: R, tool: 'corpus', expect: { case: toyCase("a later test reads its own clock while the strays fire"), check: 'state' },
    anchor: "casesOpened += 1;", replacement: "if (ordinal !== null || casesOpened === 0) casesOpened += 1;" },
  { name: "c0c2-r17-mocked-object-export-unmarked", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R17: a mocked object export not marked mocked", file: R, tool: 'corpus', expect: { case: toyCase("a mocked export the test calls itself records nothing"), check: 'context' },
    anchor: "portObject(`${name}#${key}`, value, { mocked: true })", replacement: "portObject(`${name}#${key}`, value)" },
  { name: "c0c2-r18-mocked-new-outside-unmarked", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R18: a mocked new with no chain recorded again", file: R, tool: 'corpus', expect: { case: toyCase("the engine's call of a mocked object's method"), check: 'context' },
    anchor: "if (!engine && mocked) { checkOutside(); return invoke(args); }", replacement: "if (!engine && mocked && !isNew) { checkOutside(); return invoke(args); }" },
  { name: "c0c2-r18b-mocked-new-outside-recorded", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R18b: a mocked new with no chain recorded", file: R, tool: 'corpus', expect: { case: toyCase("the engine's call of a mocked object's method"), check: 'context' },
    anchor: "    if (!engine && mocked) { checkOutside(); return invoke(args); }", replacement: "    if (!engine && mocked && isNew) guard('port', () => record({ kind: 'new', port: name, call: `t${(current.testCalls += 1)}`, args: ref(listOf(args)) }, store));\n    if (!engine && mocked) { checkOutside(); return invoke(args); }" },
  { name: "c0c2-r19-mocked-answer-dropped", toys: ['toy-mocked.toy.mjs'], origin: "C0c2 review R19: a mocked call inside a chain loses its answer", file: R, tool: 'corpus', expect: { case: toyCase("a mocked export the test calls itself records nothing"), check: 'effects', step: 2 },
    anchor: "    guard('port', () => { effect.answer = ref(result); });", replacement: "    guard('port', () => { if (!mocked) effect.answer = ref(result); });" },
  { name: "c0c2-test-timer-callback-unowned", toys: ['toy-unowned.toy.mjs'], origin: "C0c2 clock fix: a test timer's callback runs with no test store, so a timer it sets is the current case's", file: R, tool: 'corpus', expect: { case: toyCase("a timer set from the callback of a timer taken for this case"), check: 'flags' },
    anchor: "runIn(origin === 'test' ? testStore(owner) : store,", replacement: "runIn(store," },
  { name: "c0c2-test-bodies-unowned", toys: ['toy-stray.toy.mjs'], origin: "C0c2 clock fix: test bodies run with no test store, so a job they leave sets its timer on the current case", file: R, tool: 'corpus', expect: { case: toyCase("a test that leaves an I/O job behind"), check: 'context' },
    anchor: "spyOn, setSystemTime, ...ownedTestApi() }", replacement: "spyOn, setSystemTime }" },
  { name: "c0c2-unowned-timer-unflagged", toys: ['toy-unowned.toy.mjs'], origin: "C0c2 clock fix: a timer with no known case moves the clock unflagged", file: R, tool: 'corpus', expect: { case: toyCase("a timer set by a job with no known case"), check: 'unrecordable-expected' },
    anchor: "        if (unowned && counted && timed.kind === 'test' && setAt + span * fires > timed.clock.now) guard('timer.fire', () => timed.flags.add('timer-owner-unknown'));\n", replacement: "" },
  { name: "c0c2-late-test-call-to-current", toys: ['toy-stray.toy.mjs'], origin: "C0c2 clock fix: an entry called by test code of an earlier case lands in the current case", file: R, tool: 'corpus', expect: { case: toyCase("a test that leaves timers behind"), check: 'step-count' },
    anchor: "  const kase = caseOf(portEffect || origin === 'test' ? store : null);", replacement: "  const kase = caseOf(portEffect ? store : null);" },
]);

/**
 * The planted differences the per-push self-test runs (conformance.test.mjs):
 * one of each tool, the cheapest that tool has. Every other one runs in the
 * full suite only (planted.full.test.mjs); the two together run every planted
 * difference, and the per-push test checks that this sample names one of each
 * tool in PLANTED.
 */
export const PER_PUSH_SAMPLE = Object.freeze(['codec-sorts-set', 'globals-setsystemtime-ignored', 'c0c-fix2-n3-test-function-unflagged', 'recorder-unseeded-random',
  'c0c-r2-n11-no-frame-allowance-never-stale', 'container-cases-reordered', 'c0c-waiver-stale', 'fix-c0c-command-classify-off']);

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

// Two recordings of the toy corpus by the repository's own recorder, made once per run of the planted differences
// and shared: the family command's planted differences are in the command, not in the recorder.
// A caller that already holds two such recordings hands them in (`recordings`), and they are used instead.
const toyRecordingsBy = new Map(); // parent -> Promise of [recording, recording]
function sharedToyRecordings(parent, recordings) {
  if (recordings) return Promise.resolve(recordings);
  if (!toyRecordingsBy.has(parent)) toyRecordingsBy.set(parent, (async () => [await recordToys({ workDir: path.join(parent, 'family-toys-1') }), await recordToys({ workDir: path.join(parent, 'family-toys-2') })])());
  return toyRecordingsBy.get(parent);
}

/**
 * The change-set check and the census of a copy, on a recording of the whole
 * toy set made by the copy's own recorder: `{ check, name, detail }` for each
 * failure and problem (`name` is `<container> <case>` for a change set).
 */
export async function censusDifferences({ harnessDir, root, workDir, load }) {
  const [record, census, portMapModule] = await Promise.all([load('record.mjs'), load('census.mjs'), load('port-map.mjs')]);
  const recording = await record.recordToys({ workDir, harnessDir, root });
  const portMap = portMapModule.loadPortMap(path.join(harnessDir, 'toy/port-map.json'), { root });
  const changeSets = census.checkChangeSets(recording.containers, portMap);
  const merged = census.mergeExports(recording.raws);
  const result = census.runCensus({ portMap, census: census.loadCensus(path.join(harnessDir, 'toy/census.json')), containers: recording.containers, moduleExports: merged.exports, readSource: (file) => readFileSync(file, 'utf8') });
  const named = (entry) => ({ ...entry, name: entry.container ? `${entry.container} ${entry.case}` : `${entry.family}${entry.name ? `#${entry.name}` : ''} ${entry.detail}` });
  return [...changeSets.failures, ...merged.problems, ...result.failures, ...result.problems].map(named);
}

/**
 * Runs the mutant's tool on its copy; returns the differences that tool
 * reports. `recordings`: two recordings of the toy corpus by this directory's
 * recorder, for the family command's checks (made here when not given).
 */
export async function runMutant(mutant, parent, { recordings: given } = {}) {
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
  if (mutant.tool === 'family') {
    // The command's checks on toy recordings: shared ones made by the repository's recorder, or the copy's own when the
    // planted difference is in its recorder; the end-to-end discover run only for the planted differences it is for.
    const checks = await load('familychecks.mjs');
    const names = checks.FAMILY_CHECKS.map(([name]) => name).filter((name) => name !== 'family-discovery' || mutant.expect.check === name);
    const own = mutant.file === R && mutant.expect.check !== 'family-discovery' ? await load('record.mjs') : null;
    const recordings = own ? [await own.recordToys({ workDir: path.join(workDir, 'toys-1'), harnessDir, root }), await own.recordToys({ workDir: path.join(workDir, 'toys-2'), harnessDir, root })] : await sharedToyRecordings(parent, given);
    return checks.familyChecks({ recordings, workDir, names });
  }
  if (mutant.tool === 'census') return censusDifferences({ harnessDir, root, workDir, load });
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
import { readFileSync } from 'node:fs';
const toyDir = '/scripts/client-conformance/toy/';
const base = Bun.main.slice(0, Bun.main.lastIndexOf(toyDir));
globalThis[Symbol.for('devryan.client-conformance.config')] = {
  DEVRYAN_CONFORMANCE_BASE: base,
  DEVRYAN_CONFORMANCE_OUT: base + '-work/raw',
  DEVRYAN_CONFORMANCE_PORT_MAP: base + toyDir + 'port-map.json',
  // The no-frame calls the copy's toy census names with their engine site (record.mjs noFrameAllowed).
  DEVRYAN_CONFORMANCE_NO_FRAME: (JSON.parse(readFileSync(base + toyDir + 'census.json', 'utf8')).noFrame ?? []).map((item) => item.family + '#' + item.export).join(','),
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
    if (mutant.tool === 'tools' || mutant.tool === 'family') return difference.check === expected.check;
    if (mutant.tool === 'census') return difference.check === expected.check && expected.name.test(String(difference.name));
    if (expected.container && !(typeof difference.container === 'string' && expected.container.test(difference.container))) return false;
    if (expected.case && !(typeof difference.case === 'string' && expected.case.test(difference.case))) return false;
    return difference.check === expected.check && (expected.step === undefined || difference.step === expected.step);
  });
}

/**
 * Runs every mutant; resolves `[{ mutant, differences, caught, error? }]` in
 * list order. Corpus and stability mutants record together in one bun process
 * (`concurrency` workers); the others run `concurrency` at a time beside it.
 * `only` limits the run to those names; `recordings` hands in two toy
 * recordings for the family command's checks (runMutant).
 */
export async function runPlanted(scratch, { concurrency = 6, only, recordings } = {}) {
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
      await settle(mutant, runMutant(mutant, parent, { recordings }));
    }
  };
  await Promise.all([batch, ...Array.from({ length: Math.min(concurrency, alone.length) }, worker)]);
  return results;
}
