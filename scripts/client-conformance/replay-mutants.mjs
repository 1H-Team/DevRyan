// The replayer's self-test and its planted differences (package C0d; design
// file 29 §4.5, §4.6). Its subjects are the harness's toys only: no product
// module or test is named here, so no product edit selects a test of it.
//
// The self-test (`replaySelfTest`) has five parts, each a named check:
// - `closure`: the toy closure (replay.mjs toyClosure) in both modes, with its
//   counts pinned per outcome, its fixture caught, and every judged case's
//   steps compared (the steps counted here from the containers, not taken
//   from the replayer's report);
// - `compare`: the comparison (replay-compare.mjs) on fixed inputs: pairs of
//   codec trees that differ in one thing only (-0, NaN, a Map's or a Set's
//   order, a hole against `undefined`, identity across steps, a member's
//   presence, an error's class or message, ...; design §4.5 item 18), each
//   reported by its own check and kind, and the codec limits NOT_COMPARED
//   names shown to be real;
// - `judge`: the judgement (replay.mjs judgeReplay) on fixed results: exit 0,
//   1 and 3 where each is due, a run with nothing judged, a family with no
//   judged case, a fixture not replayed, problems;
// - `engines`: the closure command (replay.mjs main) on a recording directory
//   of the replayer's toy family against engines that are wrong on purpose
//   (toy/replay/fake-engine.mjs): three that try to pass without running
//   anything (exit 1), one that dies, one that hangs, one of another protocol
//   (exit 3); damaged directories (a container cut short, one missing, one
//   added, a case re-marked, no manifest, every case unrecordable: exit 3);
//   and the TypeScript engine on the intact directory (exit 0). Exit codes are
//   asserted, not only the lines printed;
// - `toy-mutants`: planted differences in copies of the toy modules
//   (TOY_MUTANTS, loaded by the engine in place of the module, never written
//   over it), each reported by its own check and kind.
// Planted differences in the replayer itself (REPLAYER_PLANTS) are built in a
// copy of this directory (mutants.mjs buildMutant); each must make the copy's
// self-test fail at the part it names.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMutant } from './mutants.mjs';
import { scratchParent } from '../qa/run-root.mjs';
import { HARNESS_DIR, REPOSITORY_ROOT, SCRATCH_OWNER_FILE } from './record.mjs';

/** What the toy closure must count: per run (the tracked corpus, the replayer's own toys) and outcome. */
export const TOY_CLOSURE_COUNTS = Object.freeze({
  corpus: { cases: 116, reproduced: 29, different: 0, inconclusive: 0, unrecordable: 32, 'no-reference': 0, 'not-replayable': 55 },
  own: { cases: 9, reproduced: 8, different: 1, inconclusive: 0, unrecordable: 0, 'no-reference': 0, 'not-replayable': 0 },
});
/** Families the toy closure must report as not replayable yet, by name. */
export const TOY_NOT_REPLAYABLE = Object.freeze(['toy-clock', 'toy-flow', 'toy-gate', 'toy-guard', 'toy-sched', 'toy-timers', 'toy-transport']);
/** What a replay must leave uncompared, by `what` (replay-compare.mjs NOT_COMPARED): a change to the list is a decision, so it is pinned. */
export const NOT_COMPARED_PINNED = Object.freeze(9);

const toy = (name) => `toy/${name}`;
const replayToy = 'toy/replay/toy-relay.mjs';
/**
 * Planted differences in copies of the toy modules: `file` (relative to this
 * directory) is loaded with `anchor` (once) replaced; `expect` is the check
 * and kind that must report it in some case, in file order; `contained`, the
 * number of cases that must differ and none inconclusive (the rest of the
 * unit still judged).
 */
export const TOY_MUTANTS = Object.freeze([
  { name: 'toy-key-moved', file: toy('toy-reducer.mjs'), anchor: '{ id: event.id, title: event.title, messages: [] }', replacement: '{ id: event.id, messages: [], title: event.title }', expect: { check: 'after', kind: 'key-order' } },
  { name: 'toy-undefined-as-null', file: toy('toy-reducer.mjs'), anchor: '{ id: event.id, title: event.title, messages: [] }', replacement: '{ id: event.id, title: event.title ?? null, messages: [] }', expect: { check: 'after', kind: 'undefined-null' } },
  { name: 'toy-clones-one-field-too-many', file: toy('toy-reducer.mjs'), anchor: '      draft.order = [...draft.order, event.id];\n', replacement: '      draft.order = [...draft.order, event.id];\n      draft.hidden = new Set(draft.hidden);\n', expect: { check: 'change-set' } },
  { name: 'toy-mutates-in-place', file: toy('toy-reducer.mjs'), anchor: '      draft.order = [...draft.order, event.id];\n', replacement: '      draft.order.push(event.id);\n', expect: { check: 'change-set' } },
  { name: 'toy-set-sorted', file: toy('toy-reducer.mjs'), anchor: "case 'message.hidden': draft.hidden.add(event.id); break;", replacement: "case 'message.hidden': { const all = [...draft.hidden, event.id].sort(); draft.hidden.clear(); for (const id of all) draft.hidden.add(id); break; }", expect: { check: 'after', kind: 'value' } },
  { name: 'toy-effects-reordered', file: replayToy, anchor: "  const a = log('first', first);\n  const b = log('second', second);\n", replacement: "  const b = log('second', second);\n  const a = log('first', first);\n", expect: { check: 'effects', kind: 'value' } },
  { name: 'toy-extra-port-call', file: replayToy, anchor: "  const b = log('second', second);\n", replacement: "  const b = log('second', second);\n  log('third', second);\n", expect: { check: 'halt', kind: 'unanswered' } },
  { name: 'toy-alias-broken', file: replayToy, anchor: 'return { left: tag, right: tag, event };', replacement: 'return { left: tag, right: { ...tag }, event };', expect: { check: 'result', kind: 'identity' } },
  { name: 'toy-argument-copied', file: replayToy, anchor: 'return { left: tag, right: tag, event };', replacement: 'return { left: tag, right: tag, event: { ...event } };', expect: { check: 'result', kind: 'identity' } },
  { name: 'toy-lone-surrogate-replaced', file: replayToy, anchor: 'return { text: text.trim(), units: text.length };', replacement: "return { text: text.trim().replace(/[\\uD800-\\uDFFF]/g, '\\uFFFD'), units: text.length };", expect: { check: 'result', kind: 'value' } },
  { name: 'toy-units-off-by-one', file: replayToy, anchor: 'return { text: text.trim(), units: text.length };', replacement: 'return { text: text.trim(), units: text.length - 1 };', expect: { check: 'result', kind: 'value' } },
  { name: 'toy-thrown-class-changed', file: replayToy, anchor: 'throw new TypeError(`label needs text', replacement: 'throw new RangeError(`label needs text', expect: { check: 'result', kind: 'value' } },
  { name: 'toy-time-not-supplied', file: replayToy, anchor: '{ at: Date.now(), id: crypto.randomUUID() }', replacement: '{ at: Date.now() + 1, id: crypto.randomUUID() }', expect: { check: 'after', kind: 'time-oracle' } },
  { name: 'toy-clock-read-after-draw', file: replayToy, anchor: '{ at: Date.now(), id: crypto.randomUUID() }', replacement: '(() => { const id = crypto.randomUUID(); return { at: Date.now(), id }; })()', expect: { check: 'halt', kind: 'effect-order' } },
  { name: 'toy-draws-reordered', file: replayToy, anchor: '  const first = crypto.randomUUID();\n  const second = crypto.randomUUID();\n', replacement: '  const second = crypto.randomUUID();\n  const first = crypto.randomUUID();\n', expect: { check: 'result', kind: 'draw-oracle' } },
  { name: 'toy-microtask-effect-on-a-timer', file: replayToy, anchor: "  Promise.resolve().then(() => log('relay', String(items.length)));\n", replacement: "  setTimeout(() => log('relay', String(items.length)), 0);\n", expect: { check: 'effects', kind: 'value' } },
  { name: 'toy-hidden-counter-off-by-one', file: replayToy, anchor: '  calls += 1;\n', replacement: '  calls += 2;\n', expect: { check: 'result', kind: 'value' } },
  { name: 'toy-clock-source-changed', file: toy('toy-clock.mjs'), anchor: 'return [Date.now(), new Date().getTime(), performance.now()];', replacement: 'return [Date.now(), Date.now(), performance.now()];', expect: { check: 'halt', kind: 'unanswered' } },
  // C0d fix: a rejection the module leaves unhandled, and an error a job it scheduled throws, are the case's (`outside`), and the unit lives on.
  { name: 'toy-unhandled-rejection', file: replayToy, anchor: "  return 'queued';\n", replacement: "  Promise.reject(new Error('planted rejection'));\n  return 'queued';\n", expect: { check: 'outside' }, contained: 1 },
  { name: 'toy-throw-in-a-later-job', file: replayToy, anchor: "  return 'queued';\n", replacement: "  setImmediate(() => setImmediate(() => setImmediate(() => { throw new Error('planted throw'); })));\n  return 'queued';\n", expect: { check: 'outside' }, contained: 1 },
]);
/** The toy mutants the per-push self-test runs (the rest run in the full suite): one of each kind of check. */
export const TOY_MUTANT_SAMPLE = Object.freeze(['toy-key-moved', 'toy-undefined-as-null', 'toy-clones-one-field-too-many', 'toy-effects-reordered', 'toy-clock-read-after-draw', 'toy-alias-broken', 'toy-time-not-supplied', 'toy-draws-reordered', 'toy-throw-in-a-later-job']);

const RC = 'replay-compare.mjs';
const RP = 'replay.mjs';
const ET = 'engine-ts.mjs';
const EN = 'engine.mjs';
const MF = 'manifest.mjs';
const JUDGE_CODE = '  const code = inconclusive.length ? EXIT.inconclusive : failures.length ? EXIT.fail : EXIT.pass;\n  return { code, failures, inconclusive, fixtures };';
/**
 * Planted differences in the replayer: each must make the copy's self-test
 * fail at `fails` (`closure`, `compare`, `judge`, `engines`, or
 * `toy-mutants:<name>`). `origin` says whose: the package's own (C0d), the
 * review's (C0d review, its 21) or this fix round's (C0d fix).
 */
export const REPLAYER_PLANTS = Object.freeze([
  { name: 'replayer-change-set-not-compared', origin: 'C0d', file: RC, anchor: "['after', 'after'], ['changes', 'change-set']]", replacement: "['after', 'after']]", fails: 'toy-mutants:toy-clones-one-field-too-many' },
  { name: 'replayer-step-delivered-before-quiescence', origin: 'C0d', file: ET, anchor: '    const quiet = await quiesce();\n', replacement: '    const quiet = true;\n', fails: 'closure' },
  { name: 'replayer-identity-not-kept-on-rebuild', origin: 'C0d', file: ET, anchor: '        if (known !== undefined) { local.set(node.n, known); reconcile(known, node.value); return known; }\n', replacement: '', fails: 'closure' },
  { name: 'replayer-prefix-accepted', origin: 'C0d', file: RC, anchor: '  if (expectedSteps.length !== actualSteps.length) {\n', replacement: '  if (actualSteps.length > expectedSteps.length) {\n', fails: 'compare' },
  { name: 'replayer-not-replayable-counted-reproduced', origin: 'C0d', file: RP, anchor: ": verdict.outcome !== 'recorded' ? 'no-reference' : 'not-replayable');", replacement: ": verdict.outcome !== 'recorded' ? 'no-reference' : 'reproduced');", fails: 'closure' },
  { name: 'replayer-unanswered-port-answered-undefined', origin: 'C0d', file: ET, anchor: "    return halt(later ? 'effect-order' : 'unanswered',", replacement: "    if (!later) return { kind, port: name, answer: { $dr: 'undefined' } };\n    return halt(later ? 'effect-order' : 'unanswered',", fails: 'toy-mutants:toy-extra-port-call' },
  { name: 'replayer-key-order-masked', origin: 'C0d', file: RC, anchor: "  const leftKeys = Object.keys(left);\n  const rightKeys = Object.keys(right);\n", replacement: "  const leftKeys = Object.keys(left).sort();\n  const rightKeys = Object.keys(right).sort();\n", fails: 'toy-mutants:toy-key-moved' },
  { name: 'replayer-undefined-equals-null', origin: 'C0d', file: RC, anchor: "  if (left === right) return null;\n  const type = kindName(left);", replacement: "  if (left === right || (tagOf(left) === 'undefined' && right === null)) return null;\n  const type = kindName(left);", fails: 'toy-mutants:toy-undefined-as-null' },
  { name: 'replayer-identity-ignored', origin: 'C0d', file: RC, anchor: '    return known === right && other === left;\n', replacement: '    return true;\n', fails: 'toy-mutants:toy-argument-copied' },
  { name: 'replayer-env-in-any-order', origin: 'C0d', file: ET, anchor: "    const unordered = kind === 'port' && unit.unordered.has(name);\n", replacement: '    const unordered = true;\n', fails: 'toy-mutants:toy-clock-read-after-draw' },
  { name: 'replayer-alone-shares-the-file-instance', origin: 'C0d', file: RP, anchor: "    if (modes.includes('isolated')) for (const item of items) if (item.verdict.judge) units.push({ id: (unitId += 1), container, mode: 'isolated', items: [item] });\n",
    replacement: "    if (modes.includes('isolated') && items.some((item) => item.verdict.judge)) units.push({ id: (unitId += 1), container, mode: 'isolated', items: items.filter((item) => item.verdict.judge) });\n", fails: 'closure' },
  { name: 'replayer-halt-ignored', origin: 'C0d', file: RC, anchor: '    if (replayed.halt && replayed.halt.step === step) found.unshift(', replacement: '    if (false) found.unshift(', fails: 'toy-mutants:toy-extra-port-call' },
  { name: 'replayer-time-oracle-off', origin: 'C0d', file: RC, anchor: '  if (expectedNumber !== null && supplied.times.has(expectedNumber) && !supplied.times.has(numberOf(actual))) {', replacement: '  if (false) {', fails: 'toy-mutants:toy-time-not-supplied' },
  // The review's 21 (C0d review, "Planted replayer bugs"; anchors moved with the code where it changed).
  { name: 'review-effect-args-not-compared', origin: 'C0d review', file: RC, anchor: '        const keys = Object.keys(l.effects[at]);\n        const otherKeys = Object.keys(r.effects[at]);\n', replacement: "        const keys = Object.keys(l.effects[at]).filter((key) => key !== 'args');\n        const otherKeys = Object.keys(r.effects[at]).filter((key) => key !== 'args');\n", fails: 'compare' },
  { name: 'review-after-not-compared', origin: 'C0d review', file: RC, anchor: "['returns', 'result'], ['throws', 'result'], ['after', 'after'], ['changes', 'change-set']]", replacement: "['returns', 'result'], ['throws', 'result'], ['changes', 'change-set']]", fails: 'compare' },
  { name: 'review-outside-not-compared', origin: 'C0d review', file: RC, anchor: '  if ((replayed.outside ?? []).length) {', replacement: '  if (false) {', fails: 'compare' },
  { name: 'review-engine-made-objects-not-bound', origin: 'C0d review', file: ET, anchor: '      if (!kase.bound.has(request.n)) kase.bound.set(request.n, found);\n', replacement: '', fails: 'closure' },
  { name: 'review-quiescence-one-microtask', origin: 'C0d review', file: ET, anchor: '      await new RealPromise((resolve) => { realSetImmediate(resolve); });\n      rounds += 1;\n      quiet = activity === before ? quiet + 1 : 0;', replacement: '      await null;\n      rounds += 1;\n      quiet = activity === before ? quiet + 1 : 0;', fails: 'closure' },
  { name: 'review-unrecordable-counted-reproduced', origin: 'C0d review', file: RP, anchor: "(verdict.judge ? null : verdict.outcome === 'unrecordable' ? 'unrecordable' :", replacement: "(verdict.judge ? null : verdict.outcome === 'unrecordable' ? 'reproduced' :", fails: 'closure' },
  { name: 'review-port-answer-from-last-call', origin: 'C0d review', file: ET, anchor: '    if (next && matches(next)) { step.envNext += 1; return next; }\n', replacement: '    if (next && matches(next)) { step.envNext += 1; return items.findLast(matches) ?? next; }\n', fails: 'closure' },
  { name: 'review-clock-served-one-late', origin: 'C0d review', file: ET, anchor: "    const item = take('clock', source);\n    const value = valueOf(item.value);\n    effect({ kind: 'clock', source, value: snap(value) });\n    return value;", replacement: "    const item = take('clock', source);\n    const value = valueOf(item.value);\n    effect({ kind: 'clock', source, value: snap(value) });\n    const late = globalThis.__lateClock ?? value;\n    globalThis.__lateClock = value;\n    return late;", fails: 'closure' },
  { name: 'review-engine-loss-counted-reproduced', origin: 'C0d review', file: RP, anchor: "      lost = `the engine failed on ${kase.id}: ${error.message}`;\n      if (item.verdict.judge) results.get(item.key)[mode] = { outcome: 'inconclusive',", replacement: "      lost = `the engine failed on ${kase.id}: ${error.message}`;\n      if (item.verdict.judge) results.get(item.key)[mode] = { outcome: 'reproduced',", fails: 'engines' },
  { name: 'review-difference-exits-0', origin: 'C0d review', file: RP, anchor: JUDGE_CODE, replacement: JUDGE_CODE.replace('failures.length ? EXIT.fail', 'failures.length ? EXIT.pass'), fails: 'judge' },
  { name: 'review-inconclusive-exits-0', origin: 'C0d review', file: RP, anchor: JUDGE_CODE, replacement: JUDGE_CODE.replace('inconclusive.length ? EXIT.inconclusive', 'inconclusive.length ? EXIT.pass'), fails: 'judge' },
  { name: 'review-nothing-replayed-passes', origin: 'C0d review', file: RP, anchor: '  if (requireJudged && !result.cases.some(', replacement: '  if (false && !result.cases.some(', fails: 'judge' },
  { name: 'review-family-without-judged-case-passes', origin: 'C0d review', file: RP, anchor: '  for (const family of requireFamilies) {\n', replacement: '  for (const family of []) {\n', fails: 'judge' },
  { name: 'review-tagged-numbers-equal', origin: 'C0d review', file: RC, anchor: "    case 'symbol': return data(['n']);\n    default: return data([]);", replacement: "    case 'symbol': return data(['n']);\n    case 'number': return null;\n    default: return data([]);", fails: 'compare' },
  { name: 'review-map-order-masked', origin: 'C0d review', file: RC, anchor: "    case 'map': return data(['entries']) ?? compareList(left.entries, right.entries, judge, `${where}/entries`, entryPair);", replacement: "    case 'map': { const by = (list) => [...list].sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1)); return data(['entries']) ?? compareList(by(left.entries), by(right.entries), judge, `${where}/entries`, entryPair); }", fails: 'compare' },
  { name: 'review-holes-masked', origin: 'C0d review', file: RC, anchor: '  const leftTag = tagOf(left);\n  const rightTag = tagOf(right);\n  if (leftTag !== rightTag) {', replacement: "  const leftTag = tagOf(left);\n  const rightTag = tagOf(right);\n  if (leftTag === 'hole' || rightTag === 'hole') return null;\n  if (leftTag !== rightTag) {", fails: 'compare' },
  { name: 'review-identity-judge-per-step', origin: 'C0d review', file: RC, anchor: '    const value = (leftSlot, rightSlot, path) => compareValues(left.trees[leftSlot], right.trees[rightSlot], judge, path);', replacement: '    const stepJudge = createIdentityJudge();\n    const value = (leftSlot, rightSlot, path) => compareValues(left.trees[leftSlot], right.trees[rightSlot], stepJudge, path);', fails: 'compare' },
  { name: 'review-thrown-class-name-not-compared', origin: 'C0d review', file: RC, anchor: "      const found = data(['value', 'primitive', 'cause', 'errors']);", replacement: "      const found = data(['value', 'primitive', 'cause', 'errors', 'name', 'error']);", fails: 'compare' },
  { name: 'review-deadline-never-fires', origin: 'C0d review', file: EN, anchor: '    const timer = setTimeout(() => {\n      pending.delete(id);', replacement: '    const timer = setTimeout(() => {\n      return;\n      pending.delete(id);', fails: 'engines' },
  { name: 'review-unhandled-rejection-not-outside', origin: 'C0d review', file: ET, anchor: "    process.on('unhandledRejection', (reason) => { noteOutside(`unhandled rejection: ${String(reason?.message ?? reason)}`); });", replacement: "    process.on('unhandledRejection', () => {});", fails: 'toy-mutants:toy-unhandled-rejection' },
  { name: 'review-container-problems-dropped', origin: 'C0d review', file: RP, anchor: "    try { reader = readContainer(text); } catch (error) { problems.push({ check: 'container', container: name, detail: error.message }); continue; }", replacement: '    try { reader = readContainer(text); } catch { continue; }', fails: 'engines' },
  // This fix round's: the case id handed to the engine, the manifest, errors in later jobs, what is noted between cases, the line reader.
  { name: 'fix-case-id-sent', origin: 'C0d fix', file: RP, anchor: "      const begun = await engine.request({ op: 'case', unit: id }, { what: label('the case') });", replacement: "      const begun = await engine.request({ op: 'case', unit: id, case: kase.id }, { what: label('the case') });", fails: 'engines' },
  { name: 'fix-manifest-ignored', origin: 'C0d fix', file: RP, anchor: "  const { problems, manifest } = checkManifest(readManifestText(directory), list, { portMap: portMap.digest });", replacement: '  const { manifest } = checkManifest(readManifestText(directory), list, { portMap: portMap.digest }); const problems = [];', fails: 'engines' },
  { name: 'fix-manifest-digest-unchecked', origin: 'C0d fix', file: MF, anchor: '    if (digestOf(text) !== entry.digest) {', replacement: '    if (false) {', fails: 'engines' },
  { name: 'fix-job-errors-charged-to-no-case', origin: 'C0d fix', file: ET, anchor: '          try { run(); } catch (error) { uncaught(error, origin); } finally { jobOrigin = before; }', replacement: '          try { run(); } catch { /* dropped */ } finally { jobOrigin = before; }', fails: 'toy-mutants:toy-throw-in-a-later-job' },
  { name: 'fix-protocol-unchecked', origin: 'C0d fix', file: RP, anchor: '    if (hello.protocol !== PROTOCOL) throw', replacement: '    if (false) throw', fails: 'engines' },
]);
/** The replayer plants the per-push self-test runs: those its cheap parts (compare, judge) catch, and one each of the closure and the engines. */
export const REPLAYER_PLANT_SAMPLE = Object.freeze([
  'replayer-identity-not-kept-on-rebuild', 'replayer-prefix-accepted',
  'review-effect-args-not-compared', 'review-after-not-compared', 'review-outside-not-compared', 'review-difference-exits-0', 'review-inconclusive-exits-0', 'review-nothing-replayed-passes', 'review-family-without-judged-case-passes',
  'review-tagged-numbers-equal', 'review-map-order-masked', 'review-holes-masked', 'review-identity-judge-per-step', 'review-thrown-class-name-not-compared', 'review-engine-loss-counted-reproduced', 'fix-case-id-sent',
]);

/** The number of steps of every case of `containers`, counted from the recording itself. */
function recordedSteps(containers, readContainer) {
  const steps = new Map();
  for (const { text } of containers) for (const record of readContainer(text).cases) steps.set(record.id, record.steps.length);
  return steps;
}

/**
 * Pairs of codec trees that differ in one thing only, each with the check and
 * kind that must report it when the first is recorded and the second
 * replayed as a step's return value (design §4.5 item 18). Made with the
 * codec itself (`encode`), so a pair is what a recording and a replay hold.
 */
export function comparisonVectors({ encode }) {
  const holed = [1, 2];
  delete holed[0];
  const withCause = (cause) => new Error('m', { cause });
  const withMember = (() => { const error = new TypeError('m'); error.code = 'E1'; return error; })();
  const pair = (name, recorded, replayed, kind, check = 'result') => ({ name, recorded: encode(recorded), replayed: encode(replayed), check, kind });
  return [
    pair('negative-zero', -0, 0, 'value'),
    pair('negative-zero-in-a-member', { total: -0 }, { total: 0 }, 'value'),
    pair('nan-against-infinity', Number.NaN, Number.POSITIVE_INFINITY, 'value'),
    pair('infinity-signs', Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 'value'),
    pair('nan-against-null', Number.NaN, null, 'value'),
    pair('map-order', new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]]), 'value'),
    pair('set-order', new Set(['a', 'b']), new Set(['b', 'a']), 'value'),
    pair('hole-against-undefined', holed, [undefined, 2], 'value'),
    pair('hole-against-absent-end', [1, 2], [1], 'value'),
    pair('member-present-undefined', { a: 1, b: undefined }, { a: 1 }, 'members'),
    pair('member-extra', { a: 1 }, { a: 1, extra: true }, 'members'),
    pair('key-order', { a: 1, b: 2 }, { b: 2, a: 1 }, 'key-order'),
    pair('undefined-against-null', undefined, null, 'undefined-null'),
    pair('error-class', new TypeError('m'), new RangeError('m'), 'value'),
    pair('error-message', new TypeError('m'), new TypeError('n'), 'value'),
    pair('error-own-member', withMember, new TypeError('m'), 'members'),
    pair('error-cause', withCause(1), withCause(2), 'value'),
    pair('typed-array-type', new Int8Array([1, 2]), new Uint8Array([1, 2]), 'value'),
    pair('typed-array-content', new Int16Array([1, 2]), new Int16Array([1, 3]), 'value'),
    pair('bigint-against-number', 1n, 1, 'value'),
    pair('date-value', new Date(7000), new Date(7001), 'value'),
    pair('lone-surrogate-replaced', 'a\uD800', 'a�', 'value'),
    pair('string-utf16-units', 'é', 'é', 'value'),
  ];
}

/** The comparison on fixed inputs: each `[name, problem or null]`. */
export function compareChecks(compare, codec) {
  const { compareReplayed, NOT_COMPARED } = compare;
  const step = (n, extra = {}) => ({ n, input: { kind: 'call', entry: 'f', args: [{ $dr: 'id', n: 1, value: { a: 1 } }], now: 5 }, effects: [], returns: { $dr: 'id', n: 1, value: { a: 1 } }, after: [{ $dr: 'id', n: 1, value: { a: 1 } }], ...extra });
  const recorded = { steps: [step(1), step(2, { input: { kind: 'call', entry: 'f', args: [{ $dr: 'id', n: 1, value: { a: 1 } }], now: 5 } })] };
  const same = { steps: recorded.steps, halt: null, outside: [] };
  const checks = [];
  const reports = (left, right, check, kind) => {
    const { differences } = compareReplayed(left, right);
    const hit = differences.some((item) => item.check === check && (kind === undefined || item.kind === kind));
    return hit ? null : `expected ${check}${kind ? `/${kind}` : ''}, got ${JSON.stringify(differences.slice(0, 2).map(({ raw: _raw, ...rest }) => rest))}`;
  };
  const expectOne = (name, replayed, check, kind) => checks.push([name, reports(recorded, replayed, check, kind)]);
  checks.push(['compare-reproduced', compareReplayed(recorded, same).differences.length === 0 ? null : 'an identical replay differs']);
  expectOne('compare-prefix', { steps: recorded.steps.slice(0, 1), halt: null, outside: [] }, 'step-count');
  expectOne('compare-extra-step', { steps: [...recorded.steps, step(3)], halt: null, outside: [] }, 'step-count');
  expectOne('compare-no-steps', { steps: [], halt: null, outside: [] }, 'step-count');
  expectOne('compare-halt', { steps: recorded.steps.slice(0, 1), halt: { step: 1, check: 'unanswered', detail: 'x' }, outside: [] }, 'halt', 'unanswered');
  expectOne('compare-outside', { steps: recorded.steps, halt: null, outside: [{ what: 'clock Date.now' }] }, 'outside');
  expectOne('compare-copy-for-the-same-object', { steps: [step(1, { returns: { a: 1 } }), recorded.steps[1]], halt: null, outside: [] }, 'result', 'identity');
  expectOne('compare-members', { steps: [step(1, { returns: { $dr: 'id', n: 1, value: { a: 1, b: 2 } } }), recorded.steps[1]], halt: null, outside: [] }, 'result', 'members');
  expectOne('compare-after', { steps: [step(1, { after: [{ $dr: 'id', n: 1, value: { a: 2 } }] }), recorded.steps[1]], halt: null, outside: [] }, 'after', 'value');
  const ordered = { steps: [step(1, { returns: { b: 1, a: 2 } })] };
  checks.push(['compare-key-order-kind', reports(ordered, { steps: [step(1, { returns: { a: 2, b: 1 } })], halt: null, outside: [] }, 'result', 'key-order')]);
  const undef = { steps: [step(1, { returns: { $dr: 'undefined' } })] };
  checks.push(['compare-undefined-null', reports(undef, { steps: [step(1, { returns: null })], halt: null, outside: [] }, 'result', 'undefined-null')]);
  const timed = { steps: [step(1, { effects: [{ kind: 'clock', source: 'Date.now', value: 7 }], returns: 7 })] };
  checks.push(['compare-time-oracle', reports(timed, { steps: [step(1, { effects: [{ kind: 'clock', source: 'Date.now', value: 7 }], returns: 8 })], halt: null, outside: [] }, 'result', 'time-oracle')]);
  const effects = { steps: [step(1, { effects: [{ kind: 'port', port: 'p', call: 1, args: [], answer: 1 }, { kind: 'port', port: 'q', call: 2, args: [], answer: 2 }] })] };
  checks.push(['compare-effect-order', reports(effects, { steps: [step(1, { effects: [{ kind: 'port', port: 'q', call: 1, args: [], answer: 2 }, { kind: 'port', port: 'p', call: 2, args: [], answer: 1 }] })], halt: null, outside: [] }, 'effects', 'order')]);
  const argued = { steps: [step(1, { effects: [{ kind: 'port', port: 'p', call: 1, args: ['a'], answer: 1 }] })] };
  checks.push(['compare-effect-args', reports(argued, { steps: [step(1, { effects: [{ kind: 'port', port: 'p', call: 1, args: ['b'], answer: 1 }] })], halt: null, outside: [] }, 'effects', 'value')]);
  checks.push(['compare-site-not-compared', compareReplayed({ steps: [step(1, { effects: [{ kind: 'draw', source: 'Math.random', value: 0.5, site: 'a.mjs:1' }] })] }, { steps: [step(1, { effects: [{ kind: 'draw', source: 'Math.random', value: 0.5 }] })], halt: null, outside: [] }).differences.length === 0 ? null : 'a draw site was compared']);
  // Identity across steps: the recording hands step 2 the object step 1 returned; the replay hands it another one with
  // the same content. Only a judge that spans the case sees it.
  const across = (later) => ({ steps: [
    { n: 1, input: { kind: 'call', entry: 'f', args: [], now: 5 }, effects: [], returns: { $dr: 'id', n: 1, value: { a: 1 } }, after: [{ $dr: 'id', n: 2, value: { a: 1 } }] },
    { n: 2, input: { kind: 'call', entry: 'g', args: [{ $dr: 'ref', n: later }], now: 5 }, effects: [], returns: { $dr: 'undefined' }, after: [{ $dr: 'ref', n: later }] },
  ] });
  checks.push(['compare-identity-across-steps', reports(across(1), { ...across(2), halt: null, outside: [] }, 'input', 'identity')]);
  checks.push(['compare-identity-across-steps-reproduced', compareReplayed(across(1), { ...across(1), halt: null, outside: [] }).differences.length === 0 ? null : 'the same object across steps differs']);
  // Design §4.5 item 18: pairs that differ in one thing only, each by its own rule.
  for (const vector of comparisonVectors(codec)) {
    const left = { steps: [step(1, { returns: vector.recorded })] };
    const right = { steps: [step(1, { returns: vector.replayed })], halt: null, outside: [] };
    checks.push([`vector-${vector.name}`, JSON.stringify(vector.recorded) === JSON.stringify(vector.replayed) ? 'the codec wrote both sides alike: the pair is no vector' : reports(left, right, vector.check, vector.kind)]);
    checks.push([`vector-${vector.name}-reproduced`, compareReplayed(left, { steps: left.steps, halt: null, outside: [] }).differences.length === 0 ? null : 'a value differs from itself']);
  }
  // What is not compared is pinned, and its codec limits are real: a frozen object and a non-enumerable member are written as the plain object.
  checks.push(['not-compared-pinned', NOT_COMPARED.length === NOT_COMPARED_PINNED && NOT_COMPARED.every((item) => item.what && item.why) ? null : `NOT_COMPARED lists ${NOT_COMPARED.length} items, pinned ${NOT_COMPARED_PINNED}`]);
  const hidden = { a: 1 };
  Object.defineProperty(hidden, 'h', { value: 1, enumerable: false });
  const plain = JSON.stringify(codec.encode({ a: 1 }));
  checks.push(['not-compared-frozen', JSON.stringify(codec.encode(Object.freeze({ a: 1 }))) === plain ? null : 'the codec now writes frozenness: compare it and take it off NOT_COMPARED']);
  checks.push(['not-compared-non-enumerable', JSON.stringify(codec.encode(hidden)) === plain ? null : 'the codec now writes non-enumerable members: compare them and take them off NOT_COMPARED']);
  return checks;
}

/** The judgement on fixed results: each `[name, problem or null]`. `replay` is replay.mjs, `EXIT` record.mjs's. */
export function judgeChecks({ judgeReplay }, EXIT) {
  const entry = (outcome, differences = []) => ({ outcome, differences, stepsCompared: outcome === 'reproduced' ? 1 : 0, steps: 1, detail: outcome === 'inconclusive' ? 'the engine did not answer' : null });
  const difference = { check: 'result', kind: 'value', step: 1, path: '/steps/0/returns', expected: '1', actual: '2' };
  const kase = (id, family, outcome, modes) => ({ container: 'c.ndjson', family, id, outcome, modes, reason: null, later: null });
  const both = (outcome, differences) => ({ file: entry(outcome, differences), isolated: entry(outcome, differences) });
  const reproduced = kase('a', 'f', 'reproduced', both('reproduced'));
  const result = (cases, problems = []) => ({ cases, problems });
  const checks = [];
  const expect = (name, verdict, code, line) => {
    const problems = [];
    if (verdict.code !== code) problems.push(`exit ${verdict.code}, expected ${code}`);
    if (line && ![...verdict.failures, ...verdict.inconclusive].some((text) => line.test(text))) problems.push(`no line matches ${line}: ${JSON.stringify([...verdict.failures, ...verdict.inconclusive].slice(0, 2))}`);
    checks.push([name, problems.length ? problems.join('; ') : null]);
  };
  expect('judge-pass', judgeReplay(result([reproduced])), EXIT.pass);
  expect('judge-difference-exits-1', judgeReplay(result([reproduced, kase('b', 'f', 'different', { file: entry('reproduced'), isolated: entry('different', [difference]) })])), EXIT.fail, /^different b /);
  expect('judge-inconclusive-exits-3', judgeReplay(result([reproduced, kase('b', 'f', 'inconclusive', both('inconclusive'))])), EXIT.inconclusive, /^b \(file\): the engine did not answer/);
  expect('judge-inconclusive-over-difference', judgeReplay(result([kase('b', 'f', 'different', both('different', [difference])), kase('c', 'f', 'inconclusive', both('inconclusive'))])), EXIT.inconclusive);
  expect('judge-a-mode-not-run', judgeReplay(result([reproduced, kase('b', 'f', 'inconclusive', { file: entry('reproduced') })])), EXIT.inconclusive, /b: not run in every mode/);
  expect('judge-problem-exits-3', judgeReplay(result([reproduced], [{ check: 'container', container: 'c.ndjson', detail: 'cut short' }])), EXIT.inconclusive, /^container c\.ndjson: cut short/);
  expect('judge-nothing-judged', judgeReplay(result([kase('u', 'f', 'unrecordable', {})])), EXIT.inconclusive, /nothing was replayed/);
  expect('judge-empty-run', judgeReplay(result([])), EXIT.inconclusive, /nothing was replayed/);
  expect('judge-family-without-judged-case', judgeReplay(result([reproduced, kase('u', 'g', 'unrecordable', {})]), { requireFamilies: ['f', 'g'] }), EXIT.inconclusive, /family g has no judged case/);
  const fixture = [{ case: /^x$/, mode: 'isolated', check: 'result', step: 1 }];
  expect('judge-fixture-caught', judgeReplay(result([reproduced, kase('x', 'f', 'different', { file: entry('reproduced'), isolated: entry('different', [difference]) })]), { expected: fixture }), EXIT.pass);
  expect('judge-fixture-reproduced', judgeReplay(result([reproduced, kase('x', 'f', 'reproduced', both('reproduced'))]), { expected: fixture }), EXIT.fail, /fixture x \(isolated\) must differ/);
  expect('judge-fixture-not-replayed', judgeReplay(result([reproduced]), { expected: fixture }), EXIT.inconclusive, /was not replayed/);
  return checks;
}

// Every run of the closure command here ends within this, or the check fails naming what did not end; the run against
// the engine that hangs, whose own deadline is 2 s, within the second.
const COMMAND_DEADLINE_MS = 180000;
const HANG_GUARD_MS = 30000;

/**
 * The closure command (replay.mjs main) on a recording directory of the
 * replayer's toy family, against wrong engines and damaged directories: each
 * `[name, problem or null]`. Runs the `replay.mjs` of `harnessDir` (a planted
 * copy's own) as a process, with its manifest.mjs and its fake engine.
 */
export async function engineChecks({ harnessDir, root, workDir, own, EXIT }) {
  const load = (name) => import(pathToFileURL(path.join(harnessDir, name)).href);
  const [manifest, container] = await Promise.all([load('manifest.mjs'), load('container.mjs')]);
  const { loadPortMap } = await load('port-map.mjs');
  const portMapFile = path.join(harnessDir, 'toy', 'replay', 'replay-port-map.json');
  const portMap = loadPortMap(portMapFile, { root });
  const fake = path.join(harnessDir, 'toy', 'replay', 'fake-engine.mjs');
  const containers = own.containers.map((item) => ({ name: item.name, text: item.text }));
  const lines = (text) => text.split('\n').slice(0, -1);
  const join = (list) => `${list.join('\n')}\n`;
  // Re-marks the cases of a container (or only its first, `one`) with another outcome.
  const remark = (text, outcome, { one = false } = {}) => join(lines(text).map((line, index) => { if (index < 2 || (one && index > 2)) return line; const record = JSON.parse(line); record.case.outcome = outcome; record.case.reason = 'planted'; return JSON.stringify(record); }));
  // A directory as the family command writes it (containers and manifest), then changed by `edit` after the manifest when `late`.
  const directory = (name, { edit = (list) => list, late = (list) => list, noManifest = false } = {}) => {
    const dir = path.join(workDir, name);
    mkdirSync(dir, { recursive: true });
    const listed = edit(containers.map((item) => ({ ...item })));
    if (!noManifest) manifest.writeManifest(dir, listed, { portMap: portMap.digest, families: ['toy-relay'], scope: null });
    for (const item of late(listed)) writeFileSync(path.join(dir, item.name), item.text);
    return dir;
  };
  // Each run is the command itself, a process of its own (its exit code is what is judged); one that outlives its
  // guard is stopped (SIGTERM, which stops its engine; then SIGKILL to its group) and fails the check by name.
  const command = path.join(harnessDir, 'replay.mjs');
  const run = (name, dir, extra, limit = COMMAND_DEADLINE_MS) => new Promise((resolve) => {
    const child = spawn(process.execPath, [command, `--from=${dir}`, `--port-map=${portMapFile}`, `--cwd=${root}`, '--modes=file', ...extra], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let timedOut = false;
    let kill = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 15000);
    }, limit);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (kill) clearTimeout(kill);
      const said = output.split('\n').filter(Boolean);
      resolve(timedOut ? { code: null, said: [`${name}: the closure command did not end within ${limit} ms`, ...said] } : { code, said });
    });
  });
  const intact = directory('intact');
  const withEngine = (mode, args = []) => [`--engine=${fake}`, `--engine-args=${[mode, ...args].join(',')}`];
  const first = containers[0];
  const cases = [
    // The TypeScript engine on the intact directory: the control (file order; the fixture case differs only alone).
    ['engine-typescript-reproduces', intact, [], EXIT.pass, null],
    ['engine-echo', intact, withEngine('echo'), EXIT.fail, /^different: /],
    ['engine-lag', intact, withEngine('lag', [intact]), EXIT.fail, /^different: /],
    ['engine-lookup-by-case-id', intact, withEngine('lookup', [intact]), EXIT.fail, /^different: /],
    // A case the engine died on is inconclusive, never reproduced: the summary counts none reproduced (echo answers differ).
    ['engine-lost', intact, withEngine('crash'), EXIT.inconclusive, /^inconclusive: .*engine fake-engine\.mjs (exited|has exited)/, undefined, /: 0 reproduced \(file\)/],
    ['engine-deadline', intact, [...withEngine('hang'), '--deadline-ms=2000'], EXIT.inconclusive, /^inconclusive: .*did not answer .* within 2000 ms/, HANG_GUARD_MS],
    ['engine-protocol', intact, withEngine('protocol-1'), EXIT.inconclusive, /^inconclusive: engine: .*speaks protocol 1/],
    ['container-cut-short', directory('cut-short', { edit: (list) => list.map((item, index) => (index === 0 ? { ...item, text: item.text.slice(0, Math.floor(item.text.length * 0.6)) } : item)) }), [], EXIT.inconclusive, /^inconclusive: container /],
    ['manifest-missing-container', directory('missing', { late: (list) => list.slice(1) }), [], EXIT.inconclusive, /^inconclusive: manifest .*is listed but missing/],
    ['manifest-extra-container', directory('extra', { late: (list) => [...list, { name: `extra.${first.name}`, text: first.text }] }), [], EXIT.inconclusive, /^inconclusive: manifest .*is not in the recording's manifest/],
    ['manifest-case-re-marked', directory('re-marked', { late: (list) => list.map((item, index) => (index === 0 ? { ...item, text: remark(item.text, 'unrecordable', { one: true }) } : item)) }), [], EXIT.inconclusive, /^inconclusive: manifest .*digest differs.*cases by outcome are/],
    ['manifest-absent', directory('absent', { noManifest: true }), [], EXIT.inconclusive, /^inconclusive: manifest: the directory has no /],
    ['family-without-judged-case', directory('all-unrecordable', { edit: (list) => list.map((item) => ({ ...item, text: remark(item.text, 'unrecordable') })) }), ['--families=toy-relay'], EXIT.inconclusive, /family toy-relay has no judged case/],
  ];
  // Every damaged directory is still readable as containers, but one: the cut-short one must be refused by the reader.
  let unreadable = 0;
  for (const item of containers) { try { container.readContainer(item.text.slice(0, Math.floor(item.text.length * 0.6))); } catch { unreadable += 1; } }
  const checks = [['engines-cut-short-is-unreadable', unreadable >= 1 ? null : 'a container cut short is still readable: the fixture tests nothing']];
  const results = await Promise.all(cases.map(async ([name, dir, extra, code, line, limit, summary]) => {
    const { code: got, said } = await run(name, dir, extra, limit);
    const problems = [];
    if (got !== code) problems.push(`exit ${got}, expected ${code}`);
    if (line && !said.some((text) => line.test(text))) problems.push(`no line matches ${line}`);
    if (summary && !said.some((text) => / containers, \d+ cases: /.test(text) && summary.test(text))) problems.push(`the summary does not match ${summary}`);
    return [name, problems.length ? `${problems.join('; ')}; said ${JSON.stringify(said.filter((text) => /^(different|inconclusive)/.test(text)).slice(0, 2).map((text) => text.slice(0, 300)))}; last ${JSON.stringify(said.at(-1)?.slice(0, 300))}` : null];
  }));
  return [...checks, ...results];
}

// --------------------------------------------------------------- interrupted tools (the self-tests' helper)

/**
 * Every process below `pid` (ps), as [pid, executable]. The executable is the
 * first word of the full command line, not the short command name: on Linux a
 * recent Node reports that name as its main thread's, not as `node`.
 */
export function processesBelow(pid) {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='], { encoding: 'utf8' }).stdout.split('\n').map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 3);
  const below = [];
  const walk = (parent) => { for (const [child, ppid, ...command] of listed) if (Number(ppid) === parent) { below.push([Number(child), command[0]]); walk(Number(child)); } };
  walk(pid);
  return below;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what, probe, { deadlineMs, gone }) => {
  const started = Date.now();
  for (;;) {
    const found = probe();
    if (found) return found;
    if (gone()) throw new Error(`the tool exited before ${what}`);
    if (Date.now() - started > deadlineMs) throw new Error(`${what} did not happen within ${deadlineMs} ms`);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
};

/**
 * Starts a tool, waits until it owns a run root and a process whose command
 * matches `below` runs below it (a tool that waits on it: a test or an engine
 * that hangs, so the moment does not depend on speed), sends `signal`, and
 * resolves what it left: its exit code, whether the root is still there, and
 * which of the processes seen below it still run.
 */
export async function interruptTool(args, signal, { below = /bun$/, cwd = REPOSITORY_ROOT, ownsRoot = true } = {}) {
  const parent = scratchParent('client-conformance');
  const child = spawn(process.execPath, args, { cwd, stdio: 'ignore' });
  let exited = false;
  const closed = new Promise((resolve) => { child.once('close', (code, by) => { exited = true; resolve({ code, by }); }); });
  const options = { deadlineMs: 120000, gone: () => exited };
  try {
    const root = !ownsRoot ? null : await until(`a run root owned by ${path.basename(args[0])}`, () => (existsSync(parent) ? readdirSync(parent).map((name) => path.join(parent, name)).find((dir) => { try { return readFileSync(path.join(dir, SCRATCH_OWNER_FILE), 'utf8').trim() === String(child.pid); } catch { return false; } }) : undefined), options);
    const seen = await until(`a process matching ${below} below ${path.basename(args[0])}`, () => { const listed = processesBelow(child.pid); return listed.some(([, command]) => below.test(command)) ? listed : undefined; }, options);
    child.kill(signal);
    let timer;
    const ended = await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 120000); })]);
    clearTimeout(timer);
    if (!ended) throw new Error(`${path.basename(args[0])} did not exit within 120000 ms of ${signal}`);
    return { code: ended.code, rootLeft: root !== null && existsSync(root), running: seen.filter(([pid]) => alive(pid)) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

const ALL_PARTS = Object.freeze(['closure', 'compare', 'judge', 'engines', 'toy-mutants']);
/**
 * The replayer's self-test, run by the copy in `harnessDir` (the repository's
 * own by default): `{ failures: [{ part, detail }] }`. `parts` limits it to
 * some of ALL_PARTS; `mutants` names the toy mutants run.
 */
export async function replaySelfTest({ workDir, harnessDir = HARNESS_DIR, root = REPOSITORY_ROOT, parts = ALL_PARTS, mutants = TOY_MUTANTS.map((mutant) => mutant.name), recording }) {
  const load = (name) => import(pathToFileURL(path.join(harnessDir, name)).href);
  const [replay, compare, container, record, codec] = await Promise.all([load('replay.mjs'), load('replay-compare.mjs'), load('container.mjs'), load('record.mjs'), load('codec.mjs')]);
  const failures = [];
  // Only the parts that replay need the toy recording.
  const needsRecording = parts.some((part) => ['closure', 'engines', 'toy-mutants'].includes(part));
  const own = needsRecording ? (recording ?? await replay.recordReplayToys({ workDir: path.join(workDir, 'record'), harnessDir, root })) : null;
  if (own?.incomplete.length) failures.push({ part: 'closure', detail: `the replayer's toys did not record cleanly: ${JSON.stringify(own.incomplete.slice(0, 2))}` });
  if (parts.includes('closure')) {
    const closure = await replay.toyClosure({ workDir, harnessDir, root, recording: own, expectedDir: path.join(HARNESS_DIR, 'toy', 'expected') });
    if (closure.code !== record.EXIT.pass) failures.push({ part: 'closure', detail: `toy closure exited ${closure.code}: ${[...closure.verdicts.flatMap((verdict) => [...verdict.inconclusive, ...verdict.failures])].slice(0, 3).join(' | ')}` });
    const runs = { corpus: closure.results[0], own: closure.results[1] };
    const containers = { corpus: replay.readContainerDir(path.join(HARNESS_DIR, 'toy', 'expected')), own: own.containers.map((item) => ({ name: item.name, text: item.text })) };
    for (const [name, result] of Object.entries(runs)) {
      const counts = { cases: result.cases.length };
      for (const outcome of ['reproduced', 'different', 'inconclusive', 'unrecordable', 'no-reference', 'not-replayable']) counts[outcome] = result.cases.filter((kase) => kase.outcome === outcome).length;
      if (JSON.stringify(counts) !== JSON.stringify(TOY_CLOSURE_COUNTS[name])) failures.push({ part: 'closure', detail: `${name}: counted ${JSON.stringify(counts)}, pinned ${JSON.stringify(TOY_CLOSURE_COUNTS[name])}` });
      // Every step of every judged case must have been judged: counted from the containers, not from the replayer.
      const steps = recordedSteps(containers[name], container.readContainer);
      const judged = result.cases.filter((kase) => ['reproduced', 'different'].includes(kase.outcome));
      for (const mode of replay.MODES) {
        for (const kase of judged) {
          const entry = kase.modes[mode];
          if (!entry || entry.steps !== steps.get(kase.id)) failures.push({ part: 'closure', detail: `${name} (${mode}) ${kase.id}: recorded ${steps.get(kase.id)} steps, the replayer took ${entry?.steps}` });
          else if (entry.outcome === 'reproduced' && entry.stepsCompared !== entry.steps) failures.push({ part: 'closure', detail: `${name} (${mode}) ${kase.id}: reproduced with ${entry.stepsCompared} of ${entry.steps} steps compared` });
        }
      }
      const notYet = [...new Set(result.cases.filter((kase) => kase.outcome === 'not-replayable').map((kase) => kase.family))].sort();
      if (name === 'corpus' && JSON.stringify(notYet) !== JSON.stringify(TOY_NOT_REPLAYABLE)) failures.push({ part: 'closure', detail: `families not replayable yet: ${notYet.join(', ')}; pinned ${TOY_NOT_REPLAYABLE.join(', ')}` });
      if (result.cases.some((kase) => kase.outcome === 'not-replayable' && !kase.later)) failures.push({ part: 'closure', detail: `${name}: a case not replayable yet names no later package` });
    }
  }
  if (parts.includes('compare')) for (const [name, problem] of compareChecks(compare, codec)) if (problem) failures.push({ part: 'compare', detail: `${name}: ${problem}` });
  if (parts.includes('judge')) for (const [name, problem] of judgeChecks(replay, record.EXIT)) if (problem) failures.push({ part: 'judge', detail: `${name}: ${problem}` });
  if (parts.includes('engines')) {
    const checks = await engineChecks({ harnessDir, root, workDir: path.join(workDir, 'engines'), own, EXIT: record.EXIT });
    for (const [name, problem] of checks) if (problem) failures.push({ part: 'engines', detail: `${name}: ${problem}` });
  }
  if (parts.includes('toy-mutants')) {
    const list = TOY_MUTANTS.filter((mutant) => mutants.includes(mutant.name));
    const results = await Promise.all(list.map(async (mutant) => {
      const file = realpathSync(path.join(harnessDir, mutant.file));
      const source = readFileSync(file, 'utf8');
      const occurrences = source.split(mutant.anchor).length - 1;
      if (occurrences !== 1) return { mutant, problem: `its anchor occurs ${occurrences} times in ${mutant.file}` };
      const plants = [{ module: file, source: source.replace(mutant.anchor, () => mutant.replacement) }];
      const closure = await replay.toyClosure({ workDir: path.join(workDir, mutant.name), harnessDir, root, recording: own, modes: ['file'], plants, expectedDir: path.join(HARNESS_DIR, 'toy', 'expected') });
      const cases = closure.results.flatMap((result) => result.cases);
      const differing = cases.filter((kase) => kase.modes.file?.outcome === 'different');
      const hit = differing.some((kase) => kase.modes.file.differences.some((item) => item.check === mutant.expect.check && (mutant.expect.kind === undefined || item.kind === mutant.expect.kind)));
      const seen = differing.map((kase) => kase.modes.file.differences.map((item) => `${item.check}/${item.kind}`).join(',')).slice(0, 3);
      if (!hit) return { mutant, problem: `not reported by ${mutant.expect.check}/${mutant.expect.kind ?? '*'}; the differing cases report ${JSON.stringify(seen)}` };
      // Contained: only the cases the mutant reaches differ, and the rest of the unit is still judged.
      const lost = cases.filter((kase) => kase.outcome === 'inconclusive').length;
      if (mutant.contained !== undefined && (differing.length !== mutant.contained || lost !== 0)) return { mutant, problem: `not contained: ${differing.length} cases differ (expected ${mutant.contained}), ${lost} inconclusive` };
      return { mutant, problem: null };
    }));
    for (const { mutant, problem } of results) if (problem) failures.push({ part: `toy-mutants:${mutant.name}`, detail: problem });
  }
  return { failures };
}

/**
 * Runs each replayer plant (all, or `only`) in a copy of this directory,
 * `parallel` at a time: resolves `[{ plant, caught, failures, error? }]`,
 * caught when the copy's self-test fails at the part the plant names.
 */
export async function runReplayerPlants(given, { only = null, parallel = 4 } = {}) {
  mkdirSync(given, { recursive: true });
  const scratch = realpathSync(given);
  const list = REPLAYER_PLANTS.filter((plant) => !only || only.includes(plant.name));
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, list.length)) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      const plant = list[index];
      try {
        const { root, harnessDir } = buildMutant(plant, scratch);
        const toyMutant = plant.fails.startsWith('toy-mutants:') ? plant.fails.slice('toy-mutants:'.length) : null;
        const parts = toyMutant ? ['toy-mutants'] : [plant.fails];
        const { failures } = await replaySelfTest({ workDir: path.join(scratch, `${plant.name}-work`), harnessDir, root, parts, mutants: toyMutant ? [toyMutant] : [] });
        results[index] = { plant, caught: failures.some((failure) => failure.part === plant.fails), failures };
      } catch (error) {
        results[index] = { plant, caught: false, failures: [], error: String(error?.stack ?? error) };
      }
    }
  }));
  return results;
}
