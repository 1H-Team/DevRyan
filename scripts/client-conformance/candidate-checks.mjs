// The candidate comparer's self-test checks (package C0g): each a named check
// over the toys, run by the comparer's self-test and, for every planted fault
// in the comparer, against the planted copy, which must fail the check the
// plant names. Its subjects are the harness's toys only: no product module or
// test is named here.
//
// The pure checks run on what one replay of the toys by the TypeScript engine
// produced (`capture`: each judged case with the engine's protocol-5 answer,
// and the two runs as the replayer reported them) and need no process:
// - the views and the freedoms: the exact answers reproduce under the views
//   (`views-equal-on-exact-pairs`); the reshaped answers reproduce under the
//   candidate rules and not under the exact ones (`reshaped-reproduced`,
//   `reshaped-is-not-exact`); each freedom is needed by its own transform and
//   not by the other one's (`freedom-group-needed`, `freedom-clock-needed`);
//   renamed identity numbers, call numbers and timer ids, and reversed
//   protocol members, need no freedom (`names-are-structure`); the groups the
//   comparer cuts, a later input held in one delivery among them, are the
//   engine's (`groups-cut`); the freedoms and the contract are the ones
//   written down (`freedoms-pinned`);
// - just outside each freedom (OUTSIDE_CHECKS): a planted engine answer that
//   differs there is `different`, by the check named; four are synthetic
//   (`b1-case`: a fixed case with a test call held between a port call and its
//   immediate answer, the C0g review's B1; a repeated effect; a pending timer;
//   a clock read twice with two values in one step of a group whose other
//   steps are clock-uniform);
// - every compared part (FIELD_CHECKS): an answer changed in that part alone
//   is `different`, by that part's check (an opening or a group left out, a
//   nested input's opening moved, an effect in a group the recording does not
//   have, a pending timer's group among them: the C0g review 2's S1);
// - the recording: a container of another recording version is refused
//   (`recording-version-refused`), and the order the comparer lays a
//   recording out in agrees with the recorder's own call and timer counters
//   on every recorded toy case (`layout-order-counters`);
// - the judgement (`judge-*`) and the census (`census-*`) on the toy runs
//   changed in one thing each, by exit code and by named failure.
// The captured cases are taken in id order (the capture holds them in the
// replayer's completion order), so every check picks the same cases in every
// run.
// The command checks (`command-*`) run the command as processes: the
// TypeScript and the reshaped engine on the toys (exit 0), the reshaped one
// under the exact rules and a planted one (exit 1), the cheating engines on a
// recording directory (exit 1), a recording that did not pass its own checks,
// one read in part (exit 3) and a usage error (exit 64). The self-test runs
// PER_PUSH_COMMANDS per push, the rest in the full suite.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_DIR, REPOSITORY_ROOT } from './record.mjs';

const load = (harnessDir, name) => import(pathToFileURL(path.join(harnessDir, name)).href);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = (value) => JSON.parse(JSON.stringify(value));
const UNDEFINED = Object.freeze({ $dr: 'undefined' });

/** A tree changed in one place: `undefined` where it was anything else, else null. */
const perturb = (tree) => (tree !== null && typeof tree === 'object' && tree.$dr === 'undefined' ? 'changed' : clone(UNDEFINED));

/** The least the toys must give each check, so a check never passes on nothing (pinned). */
export const MINIMUMS = Object.freeze({ pairs: 150, reshapedNotExact: 40, groupOnly: 10, clockOnly: 10 });

/**
 * Replays the toys with the TypeScript engine (the toy corpus and a recording
 * of the replayer's toys, `recording`), keeping every judged case with the
 * engine's end answer. Resolves `{ pairs, runs, containers }`: `pairs` the
 * cases the exact rules reproduce, `{ label, kase, replayed, unordered }`
 * each; `runs` as the command's toy run holds them (planned, result, port
 * map); `containers` the recording's (`{ name, text }`).
 */
export async function capture({ harnessDir = HARNESS_DIR, root = REPOSITORY_ROOT, recording }) {
  const [replay, record, portMapModule, engineModule, candidateCompare] = await Promise.all(['replay.mjs', 'record.mjs', 'port-map.mjs', 'engine.mjs', 'candidate-compare.mjs'].map((name) => load(harnessDir, name)));
  const toyMap = portMapModule.loadPortMap(record.TOY_PORT_MAP, { root });
  const replayMap = portMapModule.loadPortMap(replay.REPLAY_PORT_MAP, { root });
  const corpus = replay.planContainers(replay.readContainerDir(record.TOY_EXPECTED), toyMap);
  const mine = replay.planContainers(recording.containers.map((item) => ({ name: item.name, text: item.text })), replayMap);
  const pairs = [];
  const capturing = (label) => (kase, replayed, options) => {
    const judged = candidateCompare.compareCandidate(kase, replayed, { ...options, rules: 'exact' });
    if (!judged.differences.length) pairs.push({ label, kase, replayed, unordered: options.unordered });
    return judged;
  };
  const engine = engineModule.typescriptEngine({ cwd: root });
  const [first, second] = await Promise.all([
    replay.replayPlanned(corpus, { engine, compare: capturing('toy corpus') }),
    replay.replayPlanned(mine, { engine, compare: capturing('replayer toys') }),
  ]);
  const runs = [
    { label: 'toy corpus', planned: corpus, result: first, portMap: toyMap },
    { label: 'replayer toys', planned: mine, result: second, portMap: replayMap, expected: replay.REPLAY_FIXTURES },
  ];
  return { pairs, runs, containers: recording.containers.map((item) => ({ name: item.name, text: item.text })) };
}

/**
 * What the reshaped engine learns from the replayer's requests, rebuilt from
 * a recorded case as the replayer sends it (replay-compare.mjs, the module
 * `rc`): per step in the engine's numbering, its input's kind and arrival,
 * whether it was held or nested, its env; and each step's `now`.
 */
export function deliveryContext(kase, rc) {
  const holds = rc.groupHolds(kase.steps);
  const layout = rc.caseLayout(kase.steps);
  const steps = kase.steps.map((step, index) => ({
    kind: step.input.kind, together: step.input.together === true, immediate: step.input.immediate, hold: holds.has(index), nested: step.input.during !== undefined,
    env: step.input.during === undefined ? rc.envOf({ effects: rc.stepSequence(layout, index) }) : [],
  }));
  return { steps, nows: kase.steps.map((step) => step.input.now) };
}

/**
 * The C0g review's B1, as a fixed case (no toy has its shape): a call makes a
 * port call whose answer is a promise and, after it returned, another port
 * call; the test then makes a call of its own, held in the same delivery
 * (it came before the first call's immediate answer, which settles in that
 * call's drain) but delivered once the engine ran out; then the answer
 * settles. Groups: the first call; the test's later call with the answer.
 * Returns `{ kase, replayed }`: the recorded case and the answer a right
 * engine gives (protocol 5).
 */
export function b1Case() {
  const args = [];
  const steps = [
    { n: 1, input: { kind: 'call', entry: 'start', args, now: 0 }, effects: [{ kind: 'port', port: 'fetch', call: 1, args: ['/a'], answer: { $dr: 'promise' } }, { kind: 'port', port: 'log', call: 2, args: ['started'], answer: { $dr: 'undefined' } }], returnedAt: 1, returns: { $dr: 'undefined' }, after: [] },
    { n: 2, input: { kind: 'call', entry: 'cleanup', args, now: 0 }, effects: [{ kind: 'port', port: 'unsubscribe', call: 3, args: [], answer: { $dr: 'undefined' } }], returnedAt: 1, returns: { $dr: 'undefined' }, after: [] },
    { n: 3, input: { kind: 'settle', port: 'fetch', call: 1, outcome: 'fulfilled', value: 'ok', immediate: 0, now: 0 }, effects: [{ kind: 'port', port: 'log', call: 4, args: ['answered'], answer: { $dr: 'undefined' } }] },
  ];
  const kase = { id: 'b1 fixed case', steps, entry: { state: null }, end: { state: null, pending: [] } };
  const replayed = {
    steps: [
      { n: 1, input: { kind: 'call', entry: 'start', args, now: 0 }, group: 1, openedAt: 0, returnedAt: 1, returns: { $dr: 'undefined' }, after: [] },
      { n: 2, input: { kind: 'call', entry: 'cleanup', args, now: 0 }, group: 2, openedAt: 0, returnedAt: 1, returns: { $dr: 'undefined' }, after: [] },
      { n: 3, input: { kind: 'settle', port: 'fetch', call: 1, outcome: 'fulfilled', value: 'ok', now: 0 }, group: 2, openedAt: 1 },
    ],
    groups: [{ effects: clone(steps[0].effects) }, { effects: [...clone(steps[1].effects), ...clone(steps[2].effects)] }],
    pending: [], halt: null, outside: [], bindFailures: [],
  };
  return { kase, replayed };
}

const has = (result, check, kind) => result.differences.some((item) => item.check === check && (kind === undefined || (Array.isArray(kind) ? kind.includes(item.kind) : item.kind === kind)));
const first = (result) => (result.differences[0] ? `${result.differences[0].check}/${result.differences[0].kind} at ${result.differences[0].path}` : 'reproduced');

/** The planted engines just outside a freedom, with the check (and kinds) every case they apply to must be different by. */
export const OUTSIDE_CHECKS = Object.freeze([
  { name: 'outside-group-leak', check: 'effects' },
  { name: 'outside-async-past-later-input', check: 'effects', synthetic: 'b1' },
  { name: 'outside-sync-to-async', check: 'effects', kind: ['return-position', 'missing', 'extra', 'order'] },
  { name: 'outside-sync-across-members', check: 'effects' },
  { name: 'outside-async-reordered', check: 'effects', kind: 'order' },
  { name: 'outside-continuation-duplicated', check: 'effects', kind: 'extra' },
  { name: 'outside-repeat-dropped', check: 'effects', kind: 'missing', synthetic: 'repeat' },
  { name: 'outside-draw-dropped', check: 'effects', kind: 'missing' },
  { name: 'outside-clock-time-shifted', check: null, kind: 'time-oracle' },
  { name: 'outside-pending-across-group', check: 'pending-timers', synthetic: 'pending' },
  { name: 'outside-clock-varying-dropped', check: 'effects', synthetic: 'clock' },
  // Package C0i's fix round: the engine-message freedom frees an engine-written message, nothing else of an error.
  { name: 'outside-engine-error-class', check: null, synthetic: 'engine-message' },
  { name: 'outside-engine-error-missing', check: null, synthetic: 'engine-message' },
  { name: 'outside-engine-error-extra', check: null, synthetic: 'engine-message' },
  { name: 'outside-product-message', check: null, synthetic: 'engine-message' },
  // The engine-difference freedom frees a step a rule names, nothing else.
  { name: 'outside-engine-difference-not-named', check: 'result', synthetic: 'engine-difference' },
  { name: 'outside-engine-difference-other-step', check: 'result', synthetic: 'engine-difference' },
]);

/**
 * A fixed message-order case (no toy family sorts messages): one step per list given, each
 * sortMessagesChronologically of it, recorded as returning `recorded[i]` and answered by the engine as `replayed[i]`.
 */
function sortCase(lists, recorded, replayed) {
  const step = (args, returns, n) => ({ n, input: { kind: 'call', entry: 'sortMessagesChronologically', args: [args], now: 1 }, effects: [], returnedAt: 0, returns });
  const kase = { id: 'fixed sort', steps: lists.map((list, at) => step(list, recorded[at], at + 1)), end: { pending: [] } };
  const answer = { steps: lists.map((list, at) => ({ ...step(list, replayed[at], at + 1), effects: undefined, group: at + 1, openedAt: 0 })), groups: lists.map(() => ({ effects: [] })), pending: [], halt: null, outside: [], bindFailures: [] };
  return { kase, answer: { ...answer, steps: answer.steps.map(({ effects: _effects, ...rest }) => rest) } };
}
const INCONSISTENT = [{ id: 'a', time: { created: 1 } }, { time: { created: 1 } }];
const CONSISTENT = [{ id: 'a', time: { created: 1 } }, { id: 'b', time: { created: 1 } }];

/** A JavaScriptCore message and a candidate's own for one engine-written TypeError (the engine-message checks). */
const ENGINE_TEXT = "null is not an object (evaluating 'text.trim')";
const CANDIDATE_TEXT = 'client-engine: null has no member trim';
const errorOf = (tree) => (tree !== null && typeof tree === 'object' && tree.$dr === 'id' ? tree.value : tree);
const withError = (tree, change) => { const copy = clone(tree); change(errorOf(copy)); return copy; };
/**
 * The captured pairs with a thrown error (the toys' `label` of `toy-relay`, a
 * TypeError its module builds), each as `{ pair, index }`, the step that threw.
 */
const throwingPairs = (pairs) => pairs.flatMap((pair) => pair.kase.steps.map((step, index) => ({ pair, index, step })).filter(({ step, index }) => errorOf(step.throws)?.$dr === 'class' && errorOf(step.throws).error && errorOf(pair.replayed.steps[index]?.throws)?.$dr === 'class'));
/** The pair with that step's error made an engine-written one: the recording's JavaScriptCore text, the candidate's own. */
const engineMade = ({ pair, index }) => {
  const kase = { ...pair.kase, steps: pair.kase.steps.map((step, at) => (at === index ? { ...step, throws: withError(step.throws, (error) => { error.error = { name: 'TypeError', message: ENGINE_TEXT }; error.name = 'TypeError'; }) } : step)) };
  const replayed = { ...pair.replayed, steps: pair.replayed.steps.map((step, at) => (at === index ? { ...step, throws: withError(step.throws, (error) => { error.error = { name: 'TypeError', message: CANDIDATE_TEXT }; error.name = 'TypeError'; }) } : step)) };
  return { kase, replayed };
};
/** The planted answers just outside the engine-message freedom, from an engine-made pair. */
const ENGINE_MESSAGE_PLANTS = Object.freeze({
  'outside-engine-error-class': ({ kase, replayed }, index) => ({ kase, replayed: { ...replayed, steps: replayed.steps.map((step, at) => (at === index ? { ...step, throws: withError(step.throws, (error) => { error.name = 'RangeError'; error.error = { ...error.error, name: 'RangeError' }; }) } : step)) } }),
  'outside-engine-error-missing': ({ kase, replayed }, index) => ({ kase, replayed: { ...replayed, steps: replayed.steps.map((step, at) => (at === index ? { ...without(step, 'throws'), returns: { $dr: 'undefined' } } : step)) } }),
  'outside-engine-error-extra': ({ kase, replayed }, index) => {
    const other = replayed.steps.findIndex((step, at) => at !== index && step.returns !== undefined);
    if (other < 0) return null;
    return { kase, replayed: { ...replayed, steps: replayed.steps.map((step, at) => (at === other ? { ...without(step, 'returns'), throws: clone(replayed.steps[index].throws) } : step)) } };
  },
});

/** The answer with the first effect of any group that `test` picks changed by `change` (null when none, or when `change` declines). */
function changeEffect(replayed, test, change) {
  for (const [group, entry] of (replayed.groups ?? []).entries()) {
    for (const [position, item] of (entry.effects ?? []).entries()) {
      if (!test(item)) continue;
      const changed = change(item);
      if (!changed) continue;
      const groups = replayed.groups.map((other, at) => (at === group ? { ...other, effects: other.effects.map((effect, index) => (index === position ? changed : effect)) } : other));
      return { ...replayed, groups };
    }
  }
  return null;
}
function changeStep(replayed, change) {
  for (const [index, step] of replayed.steps.entries()) {
    const changed = change(step, index);
    if (changed) { const steps = [...replayed.steps]; steps[index] = changed; return { ...replayed, steps }; }
  }
  return null;
}
const syncStep = (step) => Number.isInteger(step.openedAt) && Number.isInteger(step.returnedAt);
const without = (object, key) => { const { [key]: _gone, ...rest } = object; return rest; };
/** The captured cases in a fixed order (label, then case id): the capture's own is the replayer's completion order. */
const inIdOrder = (pairs) => [...pairs].sort((a, b) => { const left = `${a.label}\0${a.kase.id}`; const right = `${b.label}\0${b.kase.id}`; return left < right ? -1 : left > right ? 1 : 0; });

/**
 * An answer changed in one compared part, with the check that must report
 * it: what a comparer that drops the part would pass.
 */
export const FIELD_CHECKS = Object.freeze([
  { name: 'compared-returns', check: 'result', change: (replayed) => changeStep(replayed, (step) => own(step, 'returns') && { ...step, returns: perturb(step.returns) }) },
  { name: 'compared-throws', check: 'result', change: (replayed) => changeStep(replayed, (step) => own(step, 'throws') && { ...step, throws: perturb(step.throws) }) },
  { name: 'compared-after', check: 'after', change: (replayed) => changeStep(replayed, (step) => own(step, 'after') && { ...step, after: perturb(step.after) }) },
  { name: 'compared-change-set', check: 'change-set', change: (replayed) => changeStep(replayed, (step) => own(step, 'changes') && Array.isArray(step.changes) && { ...step, changes: [...step.changes, ['planted']] }) },
  { name: 'compared-state', check: 'state', change: (replayed) => changeStep(replayed, (step) => own(step, 'state') && { ...step, state: perturb(step.state) }) },
  { name: 'compared-state-changes', check: 'state-changes', change: (replayed) => changeStep(replayed, (step) => own(step, 'stateChanges') && Array.isArray(step.stateChanges) && { ...step, stateChanges: [...step.stateChanges, ['planted']] }) },
  { name: 'compared-entry-state', check: 'entry-state', change: (replayed) => (replayed.entry !== undefined ? { ...replayed, entry: perturb(replayed.entry) } : null) },
  { name: 'compared-end-state', check: 'end-state', change: (replayed) => (replayed.end !== undefined ? { ...replayed, end: perturb(replayed.end) } : null) },
  { name: 'compared-pending-timers', check: 'pending-timers', change: (replayed) => (Array.isArray(replayed.pending) && replayed.pending.length ? { ...replayed, pending: replayed.pending.slice(1) } : null) },
  { name: 'compared-pending-delay', check: 'pending-timers', change: (replayed) => (Array.isArray(replayed.pending) && replayed.pending.length ? { ...replayed, pending: [{ ...replayed.pending[0], delay: perturb(replayed.pending[0].delay) }, ...replayed.pending.slice(1)] } : null) },
  { name: 'compared-identity', check: null, kind: 'identity', change: (replayed) => breakIdentity(replayed) },
  { name: 'compared-outside', check: 'outside', change: (replayed) => ({ ...replayed, outside: [...(replayed.outside ?? []), { what: 'planted effect while no step was open' }] }) },
  // The last step of a group of several left out, with the effects it opened last before (an engine that stopped
  // reporting it): one step fewer, which the group's other members do not hide.
  { name: 'compared-step-count', check: 'step-count', change: (replayed) => {
    const last = replayed.steps.at(-1);
    const members = replayed.steps.filter((step) => step.group === last?.group);
    if (!last || members.length < 2 || !Number.isInteger(last.openedAt) || last.input?.kind === 'settle' || last.group !== replayed.groups.length) return null;
    const groups = replayed.groups.map((group, at) => (at === last.group - 1 ? { ...group, effects: group.effects.slice(0, last.openedAt) } : group));
    return { ...replayed, steps: replayed.steps.slice(0, -1), groups };
  } },
  { name: 'compared-halt', check: 'halt', change: (replayed) => (replayed.steps.length ? { ...replayed, halt: { step: replayed.steps.at(-1).n ?? replayed.steps.length, check: 'unanswered', detail: 'planted halt' } } : null) },
  { name: 'compared-input', check: 'input', change: (replayed) => changeStep(replayed, (step) => own(step.input, 'args') && { ...step, input: { ...step.input, args: perturb(step.input.args) } }) },
  { name: 'compared-group', check: 'groups', change: (replayed) => changeStep(replayed, (step) => Number.isInteger(step.group) && replayed.groups.length > 1 && { ...step, group: step.group === 1 ? 2 : step.group - 1 }) },
  // The effects: every member and payload of each kind compared (the C0g review's S1 named the ones no check pinned).
  { name: 'compared-effect-member', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => own(item, 'args'), (item) => ({ ...item, args: perturb(item.args) })) },
  { name: 'compared-port-answer', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => item.kind === 'port' && own(item, 'answer'), (item) => ({ ...item, answer: perturb(item.answer) })) },
  { name: 'compared-notify-state', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => item.kind === 'notify', (item) => ({ ...item, state: perturb(item.state) })) },
  { name: 'compared-notify-previous', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => item.kind === 'notify', (item) => ({ ...item, previous: perturb(item.previous) })) },
  { name: 'compared-timer-delay', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => item.kind === 'timer.set', (item) => ({ ...item, delay: perturb(item.delay) })) },
  { name: 'compared-timer-repeat', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => item.kind === 'timer.set', (item) => ({ ...item, repeat: !item.repeat })) },
  { name: 'compared-read-value', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => item.kind === 'read', (item) => ({ ...item, value: perturb(item.value) })) },
  { name: 'compared-settled-value', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => item.kind === 'settled', (item) => ({ ...item, value: perturb(item.value) })) },
  { name: 'compared-settled-outcome', check: 'effects', change: (replayed) => changeEffect(replayed, (item) => item.kind === 'settled', (item) => ({ ...item, outcome: item.outcome === 'fulfilled' ? 'rejected' : 'fulfilled' })) },
  { name: 'compared-sync-order', check: 'effects', kind: 'order', change: (replayed) => {
    const name = (item) => `${item.kind} ${item.port ?? ''} ${item.source ?? ''}`;
    for (const step of replayed.steps) {
      if (!syncStep(step)) continue;
      const effects = replayed.groups[step.group - 1]?.effects ?? [];
      for (let at = step.openedAt; at + 1 < step.returnedAt; at += 1) {
        if (name(effects[at]) === name(effects[at + 1]) || effects[at].kind === 'clock' || effects[at + 1].kind === 'clock') continue;
        const swapped = effects.map((item, position) => (position === at ? effects[at + 1] : position === at + 1 ? effects[at] : item));
        return { ...replayed, groups: replayed.groups.map((group, index) => (index === step.group - 1 ? { ...group, effects: swapped } : group)) };
      }
    }
    return null;
  } },
  // A step's synchronous part opened one effect late, or returned one early (an effect that is no clock read, which the
  // clock freedom would leave uncounted).
  { name: 'compared-open-position', check: 'effects', kind: 'open-position', change: (replayed) => changeStep(replayed, (step) => syncStep(step) && step.returnedAt > step.openedAt && replayed.groups[step.group - 1].effects[step.openedAt]?.kind !== 'clock' && { ...step, openedAt: step.openedAt + 1 }) },
  { name: 'compared-return-position', check: 'effects', kind: 'return-position', change: (replayed) => changeStep(replayed, (step) => syncStep(step) && step.returnedAt > step.openedAt && replayed.groups[step.group - 1].effects[step.returnedAt - 1]?.kind !== 'clock' && { ...step, returnedAt: step.returnedAt - 1 }) },
  // The protocol-5 members a comparer could stop pinning without any check above failing (the C0g review 2's S1):
  // an opening that is not a settled answer's left out, a step's group left out, a nested input's opening moved by one
  // effect that is no clock read (only a settled answer's opening is free), an effect in a group the recording does
  // not have, a pending timer named by another group.
  { name: 'compared-open-position-omitted', check: 'effects', kind: 'open-position', change: (replayed, kase) => changeStep(replayed, (step, index) => Number.isInteger(step.openedAt) && kase.steps[index]?.input?.kind !== 'settle' && without(step, 'openedAt')) },
  { name: 'compared-group-omitted', check: 'groups', change: (replayed) => changeStep(replayed, (step) => Number.isInteger(step.group) && without(step, 'group')) },
  { name: 'compared-nested-open-position', check: 'effects', kind: 'open-position', change: (replayed, kase) => changeStep(replayed, (step, index) => {
    if (kase.steps[index]?.input?.during === undefined || !syncStep(step)) return null;
    const effects = replayed.groups[step.group - 1]?.effects ?? [];
    if (step.returnedAt > step.openedAt && effects[step.openedAt] && effects[step.openedAt].kind !== 'clock') return { ...step, openedAt: step.openedAt + 1 };
    if (step.openedAt > 0 && effects[step.openedAt - 1].kind !== 'clock') return { ...step, openedAt: step.openedAt - 1 };
    return null;
  }) },
  { name: 'compared-extra-group', check: 'effects', kind: 'extra', change: (replayed) => ({ ...replayed, groups: [...replayed.groups, { effects: [{ kind: 'port', port: 'planted', args: [], answer: clone(UNDEFINED) }] }] }) },
  { name: 'compared-pending-group', check: 'pending-timers', change: (replayed) => (Array.isArray(replayed.pending) && replayed.pending.length && Number.isInteger(replayed.pending[0].group) ? { ...replayed, pending: [{ ...replayed.pending[0], group: replayed.pending[0].group + 1 }, ...replayed.pending.slice(1)] } : null) },
]);

/** The first `ref` node of the answer's trees renumbered to a number no position has: the same content, another object. */
function breakIdentity(replayed) {
  const text = JSON.stringify({ steps: replayed.steps, groups: replayed.groups });
  const match = /\{"\$dr":"ref","n":(\d+)\}/.exec(text);
  if (!match) return null;
  const changed = JSON.parse(`${text.slice(0, match.index)}{"$dr":"ref","n":987654}${text.slice(match.index + match[0].length)}`);
  return { ...replayed, steps: changed.steps, groups: changed.groups };
}

/** The pure checks: `[[name, problem or null]]`, the planted copy's modules loaded from `harnessDir`; `only` names a subset. */
export async function candidateChecks({ harnessDir = HARNESS_DIR, captured, only = null }) {
  const [compareModule, censusModule, commandModule, reshapeModule, replayCompare, replayModule] = await Promise.all(['candidate-compare.mjs', 'candidate-census.mjs', 'candidate.mjs', 'reshape.mjs', 'replay-compare.mjs', 'replay.mjs'].map((name) => load(harnessDir, name)));
  const { compareCandidate, compareUnderFreedoms, CONTRACT, FREEDOMS } = compareModule;
  const checks = [];
  const wanted = (name) => only === null || only.includes(name);
  const add = (name, run) => { if (wanted(name)) { try { checks.push([name, run()]); } catch (error) { checks.push([name, `threw: ${error.stack ?? error}`]); } } };
  const pairs = inIdOrder(captured.pairs);
  const contextOf = (kase) => deliveryContext(kase, replayCompare);
  const judge = (pair, replayed) => compareCandidate(pair.kase, replayed, { unordered: pair.unordered, rules: 'candidate' });
  const reshaped = (pair, transforms) => reshapeModule.reshape(clone(pair.replayed), { ...contextOf(pair.kase), ...(transforms ? { transforms } : {}) });

  add('freedoms-pinned', () => {
    const names = FREEDOMS.map((item) => item.name);
    if (JSON.stringify(names) !== JSON.stringify(['group', 'clock', 'engine-message', 'engine-difference'])) return `the freedoms are ${names.join(', ')}; pinned group, clock, engine-message, engine-difference`;
    const listed = FREEDOMS.flatMap((item) => item.outside);
    const known = OUTSIDE_CHECKS.map((item) => item.name);
    const missing = listed.filter((name) => !known.includes(name));
    if (missing.length || known.some((name) => !listed.includes(name))) return `the freedoms name outside checks ${listed.join(', ')}; the checks are ${known.join(', ')}`;
    if (FREEDOMS.some((item) => !item.why || !item.what)) return 'a freedom without its reason';
    if (CONTRACT.length !== 4 || !/order of observables is exact/.test(CONTRACT[0]) || !/attributed to is free/.test(CONTRACT[1]) || !/Nothing crosses a group boundary/.test(CONTRACT[2]) || !/every read of a source returned one value/.test(CONTRACT[3])) return 'the contract is not the four sentences';
    return null;
  });
  add('pairs-enough', () => (pairs.length >= MINIMUMS.pairs ? null : `${pairs.length} reproduced toy cases captured, at least ${MINIMUMS.pairs} needed`));
  add('views-equal-on-exact-pairs', () => {
    const bad = pairs.filter((pair) => compareUnderFreedoms(pair.kase, pair.replayed, { unordered: pair.unordered }).differences.length);
    return bad.length ? `${bad.length} exact pairs differ under the views, first ${bad[0].kase.id}: ${first(compareUnderFreedoms(bad[0].kase, bad[0].replayed, { unordered: bad[0].unordered }))}` : null;
  });
  add('groups-cut', () => {
    // Fixed input: 1 makes call 1 (a promise); 2 is a test call held in the same delivery but not together (delivered
    // once the engine ran out: a group of its own); 3 is call 1's immediate answer (with 2); 4 arrived together with 3;
    // 5 is nested in 4's port call 2 and makes call 3; 6 is held for 7, an immediate answer of call 3, which an earlier
    // delivery made (so the engine holds its promise already and gives the answer once it ran out: a group of its own).
    const effect = (call) => ({ kind: 'port', port: 'p', call, args: [], answer: { $dr: 'promise' } });
    const steps = [
      { n: 1, input: { kind: 'call' }, effects: [effect(1)] }, { n: 2, input: { kind: 'call' }, effects: [] }, { n: 3, input: { kind: 'settle', call: 1, immediate: 0 }, effects: [] },
      { n: 4, input: { kind: 'call', together: true }, effects: [effect(2)] }, { n: 5, input: { kind: 'call', during: 4, duringCall: 2 }, effects: [effect(3)] }, { n: 6, input: { kind: 'call' }, effects: [] },
      { n: 7, input: { kind: 'settle', call: 3, immediate: 0 }, effects: [] },
    ];
    const got = JSON.stringify(replayCompare.caseGroups(steps).groups);
    if (got !== JSON.stringify([[0], [1, 2, 3, 4], [5], [6]])) return `fixed steps cut into ${got}`;
    // The engine's own groups (each step's `group` in the TypeScript answers) are the comparer's.
    for (const pair of pairs) {
      const mine = replayCompare.caseGroups(pair.kase.steps).groupOf.map((at) => at + 1);
      const engine = pair.replayed.steps.map((step) => step.group);
      if (JSON.stringify(mine) !== JSON.stringify(engine)) return `${pair.kase.id}: the comparer cuts ${JSON.stringify(mine)}, the engine made ${JSON.stringify(engine)}`;
    }
    const { kase, replayed } = b1Case();
    const result = compareCandidate(kase, replayed, { rules: 'exact' });
    return result.differences.length ? `the fixed B1 case as a right engine answers it differs: ${first(result)}` : null;
  });
  add('reshaped-reproduced', () => {
    const bad = pairs.map((pair) => [pair, judge(pair, reshaped(pair))]).filter(([, result]) => result.differences.length);
    return bad.length ? `${bad.length} reshaped answers differ, first ${bad[0][0].kase.id}: ${first(bad[0][1])}` : null;
  });
  add('reshaped-is-not-exact', () => {
    const count = pairs.filter((pair) => compareCandidate(pair.kase, reshaped(pair), { unordered: pair.unordered, rules: 'exact' }).differences.length).length;
    return count >= MINIMUMS.reshapedNotExact ? null : `the exact rules tell ${count} reshaped answers from the recording, at least ${MINIMUMS.reshapedNotExact} expected: the reshaped engine is too like the TypeScript one to prove anything`;
  });
  for (const [name, transforms, needed, other, minimum] of [
    ['freedom-group-needed', { group: true, clock: false, names: true }, 'group', 'clock', MINIMUMS.groupOnly],
    ['freedom-clock-needed', { group: false, clock: true, names: true }, 'clock', 'group', MINIMUMS.clockOnly],
  ]) {
    add(name, () => {
      let needs = 0;
      for (const pair of pairs) {
        const answer = reshaped(pair, transforms);
        const both = judge(pair, answer);
        if (both.differences.length) return `${pair.kase.id}: the ${needed} transform alone differs under the candidate rules: ${first(both)}`;
        const without = compareUnderFreedoms(pair.kase, answer, { unordered: pair.unordered, freedoms: [other] });
        if (without.differences.length) needs += 1;
      }
      return needs >= minimum ? null : `the ${needed} transform alone needs the ${needed} freedom in ${needs} cases, at least ${minimum} expected`;
    });
  }
  add('freedoms-reported', () => {
    // A case only a freedom reproduces says which (never silent): the reshaped answers need both, each somewhere.
    const used = { group: 0, clock: 0, 'engine-message': 0, 'engine-difference': 0 };
    for (const pair of pairs) for (const name of judge(pair, reshaped(pair)).freedoms) used[name] += 1;
    return used.group >= MINIMUMS.groupOnly && used.clock >= MINIMUMS.clockOnly ? null : `the reshaped answers report freedoms ${JSON.stringify(used)}`;
  });
  add('names-are-structure', () => {
    for (const pair of pairs) {
      const answer = reshaped(pair, { group: false, clock: false, names: true });
      const result = compareCandidate(pair.kase, answer, { unordered: pair.unordered, rules: 'exact' });
      if (result.differences.length) return `${pair.kase.id}: renamed identity, call and timer numbers differ under the exact rules: ${first(result)}`;
    }
    return null;
  });
  for (const outside of OUTSIDE_CHECKS) {
    add(outside.name, () => {
      let applied = 0;
      let named = 0;
      const verify = (pair, answer, kase = pair.kase) => {
        const result = compareCandidate(kase, answer, { unordered: pair.unordered, rules: 'candidate' });
        if (!result.differences.length) return `${pair.kase.id}: reproduced`;
        if (has(result, outside.check ?? result.differences[0].check, outside.kind)) named += 1;
        else return `${pair.kase.id}: different by ${first(result)}, not by ${outside.check}${outside.kind ? `/${[].concat(outside.kind).join('|')}` : ''}`;
        return null;
      };
      if (outside.synthetic === 'b1') {
        // The fixed B1 case (no toy has its shape; the product sample has four, in the full suite), and every toy case
        // the plant has a place in, if any.
        const { kase, replayed } = b1Case();
        const context = deliveryContext(kase, replayCompare);
        const control = compareCandidate(kase, reshapeModule.reshape(clone(replayed), context), {});
        if (control.differences.length) return `the fixed B1 case reshaped differs: ${first(control)}`;
        const answer = reshapeModule.OUTSIDE[outside.name](reshapeModule.reshape(clone(replayed), context), context);
        if (!answer) return 'the fixed B1 case gives the plant no place';
        applied += 1;
        const problem = verify({ kase, unordered: [] }, answer, kase);
        if (problem) return problem;
        for (const pair of pairs) {
          const found = reshapeModule.OUTSIDE[outside.name](reshaped(pair), contextOf(pair.kase));
          if (!found) continue;
          applied += 1;
          const again = verify(pair, found);
          if (again) return again;
        }
      } else if (outside.synthetic === 'repeat') {
        // An effect made twice in a row in the recording and by the engine (no toy makes one twice; the product does),
        // which a plant then makes once: kinds that carry no answer and nest no input, so both sides lay it alike.
        for (const pair of pairs) {
          const layout = replayCompare.caseLayout(pair.kase.steps);
          const answer = pair.replayed;
          let found = null;
          for (let group = 1; group <= answer.groups.length && !found; group += 1) {
            for (const position of reshapeModule.continuationPositions(answer, group)) if (['notify', 'timer.set', 'timer.clear', 'settled', 'set'].includes(answer.groups[group - 1].effects[position]?.kind)) { found = { group, position }; break; }
          }
          if (!found) continue;
          const item = answer.groups[found.group - 1].effects[found.position];
          const index = layout.place.findIndex((places, at) => layout.groupOf[at] === found.group - 1 && places.includes(found.position));
          const local = layout.place[index].indexOf(found.position);
          const steps = pair.kase.steps.map((step, at) => (at === index ? { ...step, effects: [...step.effects.slice(0, local + 1), step.effects[local], ...step.effects.slice(local + 1)] } : step));
          const kase = { ...pair.kase, steps };
          const echoed = reshapeModule.copyAnswer(answer);
          reshapeModule.insertEffect(echoed, found.group, found.position + 1, clone(item), { glued: true });
          const control = compareCandidate(kase, echoed, { unordered: pair.unordered });
          if (control.differences.length) return `${pair.kase.id}: the control with an effect made twice differs: ${first(control)}`;
          const plant = reshapeModule.OUTSIDE[outside.name](echoed, contextOf(kase));
          if (!plant) continue;
          applied += 1;
          const problem = verify(pair, plant, kase);
          if (problem) return problem;
          if (applied >= 10) break;
        }
      } else if (outside.synthetic === 'clock') {
        // A group of two or more steps, each clock-uniform as recorded, in which one step now reads each of its clock
        // reads twice with two values (a stub; the recording and a right engine alike): the freedom holds only where
        // EVERY step of the group is uniform (CONTRACT's fourth sentence), so it does not hold here, and a candidate
        // that drops the group's clock reads differs. The group's other steps stay uniform, so a comparer that frees
        // a group where any one step is uniform (the C0g review 2's S4) passes it. Fixed cases (id order), no timing.
        for (const pair of pairs) {
          const layout = replayCompare.caseLayout(pair.kase.steps);
          const free = compareModule.clockFreeGroups(layout, pair.kase.steps);
          const reads = (index) => pair.kase.steps[index].effects.some((item) => item.kind === 'clock');
          const group = layout.groups.findIndex((members, at) => members.length > 1 && free.has(at + 1) && members.some(reads));
          if (group < 0) continue;
          const index = layout.groups[group].find(reads);
          const varied = (item) => ({ ...item, value: typeof item.value === 'number' ? item.value + 1 : item.value });
          // The recording: each clock read of that step followed by another of its source with another value.
          const steps = pair.kase.steps.map((step, at) => {
            if (at !== index) return step;
            const effects = step.effects.flatMap((item) => (item.kind === 'clock' ? [item, varied(item)] : [item]));
            return { ...step, effects, ...(Number.isInteger(step.returnedAt) ? { returnedAt: step.returnedAt + step.effects.slice(0, step.returnedAt).filter((item) => item.kind === 'clock').length } : {}) };
          });
          const kase = { ...pair.kase, steps };
          // The engine's answer alike: that step's clock reads (their positions in the group, an exact pair's) each followed by the other one.
          const echoed = reshapeModule.copyAnswer(pair.replayed);
          const positions = pair.kase.steps[index].effects.map((item, at) => (item.kind === 'clock' ? layout.place[index][at] : -1)).filter((position) => position >= 0).sort((a, b) => b - a);
          for (const position of positions) reshapeModule.insertEffect(echoed, group + 1, position + 1, varied(echoed.groups[group].effects[position]), { glued: true });
          const control = compareCandidate(kase, echoed, { unordered: pair.unordered });
          if (control.differences.length) return `${pair.kase.id}: the varying control differs: ${first(control)}`;
          if (compareModule.clockFreeGroups(replayCompare.caseLayout(kase.steps), kase.steps).has(group + 1)) return `${pair.kase.id}: group ${group + 1}, one of whose steps read a clock with two values, is still clock-free`;
          const dropped = reshapeModule.copyAnswer(echoed);
          for (let position = dropped.groups[group].effects.length - 1; position >= 0; position -= 1) if (dropped.groups[group].effects[position].kind === 'clock') reshapeModule.removeEffect(dropped, group + 1, position);
          applied += 1;
          const problem = verify(pair, dropped, kase);
          if (problem) return problem;
          if (applied >= 10) break;
        }
      } else if (outside.synthetic === 'engine-message') {
        // The toys' thrown errors are their modules' own (`label`'s TypeError): made engine-written here, on both
        // sides alike, the recording with JavaScriptCore's text and the candidate with its own (a right candidate,
        // the control); each plant then changes what the freedom does not free. `outside-product-message` keeps the
        // module's own error and changes its text, which is compared.
        for (const found of throwingPairs(pairs)) {
          const { pair, index } = found;
          let planted;
          if (outside.name === 'outside-product-message') {
            planted = { kase: pair.kase, replayed: { ...pair.replayed, steps: pair.replayed.steps.map((step, at) => (at === index ? { ...step, throws: withError(step.throws, (error) => { error.error = { ...error.error, message: `${error.error.message} (planted)` }; }) } : step)) } };
          } else {
            const made = engineMade(found);
            const control = compareCandidate(made.kase, made.replayed, { unordered: pair.unordered });
            if (control.differences.length) return `${pair.kase.id}: the engine-made control differs: ${first(control)}`;
            planted = ENGINE_MESSAGE_PLANTS[outside.name](made, index);
          }
          if (!planted) continue;
          applied += 1;
          const problem = verify(pair, planted.replayed, planted.kase);
          if (problem) return problem;
        }
      } else if (outside.synthetic === 'engine-difference') {
        // Fixed cases: a step no rule names (all ids strings) answered otherwise, or a later step after a named one.
        const { kase, answer } = outside.name === 'outside-engine-difference-not-named'
          ? sortCase([CONSISTENT], [['x']], [['y']])
          : sortCase([INCONSISTENT, CONSISTENT], [['x'], ['z']], [['y'], ['w']]);
        applied += 1;
        const result = compareCandidate(kase, answer, { family: 'message-order' });
        if (!result.differences.length) return 'reproduced';
        if (has(result, outside.check)) named += 1;
        else return `different by ${first(result)}, not by ${outside.check}`;
      } else if (outside.synthetic === 'pending') {
        // A timer pending at the end set in the first of two groups (a second, empty group appended where the toys have none).
        for (const pair of pairs) {
          if (!(pair.kase.end?.pending ?? []).length) continue;
          const n = Math.max(...pair.kase.steps.map((step) => step.n)) + 1;
          const now = pair.kase.steps.at(-1).input.now;
          const kase = { ...pair.kase, steps: [...pair.kase.steps, { n, input: { kind: 'call', entry: 'planted', args: [], now }, effects: [], returnedAt: 0 }] };
          const echoed = { ...pair.replayed, steps: [...pair.replayed.steps, { n, input: { kind: 'call', entry: 'planted', args: [], now }, group: pair.replayed.groups.length + 1, openedAt: 0, returnedAt: 0 }], groups: [...pair.replayed.groups, { effects: [] }] };
          const control = compareCandidate(kase, echoed, { unordered: pair.unordered });
          if (control.differences.length) return `${pair.kase.id}: the control with a second group differs: ${first(control)}`;
          const answer = reshapeModule.OUTSIDE[outside.name](echoed, contextOf(kase));
          if (!answer) continue;
          applied += 1;
          const problem = verify(pair, answer, kase);
          if (problem) return problem;
        }
      } else {
        for (const pair of pairs) {
          const answer = reshapeModule.OUTSIDE[outside.name](reshaped(pair), contextOf(pair.kase));
          if (!answer) continue;
          applied += 1;
          const problem = verify(pair, answer);
          if (problem) return problem;
        }
      }
      if (!applied) return 'the toys give it no place: it proves nothing';
      return named ? null : `no case reported ${outside.check ?? ''}/${[].concat(outside.kind ?? '*').join('|')}`;
    });
  }
  add('freedom-engine-message-needed', () => {
    // An engine-written error whose text is the candidate's own: reproduced under the candidate rules, by that freedom
    // alone (reported), different under the exact rules; the same answer with the module's own error is different.
    const found = throwingPairs(pairs);
    if (!found.length) return 'no toy case throws: it proves nothing';
    for (const item of found) {
      const { kase, replayed } = engineMade(item);
      const candidate = compareCandidate(kase, replayed, { unordered: item.pair.unordered, rules: 'candidate' });
      if (candidate.differences.length) return `${item.pair.kase.id}: an engine-written message the candidate writes its own way differs: ${first(candidate)}`;
      if (JSON.stringify(candidate.freedoms) !== JSON.stringify(['engine-message'])) return `${item.pair.kase.id}: freedoms used ${candidate.freedoms.join(', ')}, expected engine-message`;
      if (!compareCandidate(kase, replayed, { unordered: item.pair.unordered, rules: 'exact' }).differences.length) return `${item.pair.kase.id}: the exact rules reproduce another message`;
      const own = { ...item.pair.replayed, steps: item.pair.replayed.steps.map((step, at) => (at === item.index ? { ...step, throws: withError(step.throws, (error) => { error.error = { ...error.error, message: CANDIDATE_TEXT }; }) } : step)) };
      if (!compareCandidate(item.pair.kase, own, { unordered: item.pair.unordered, rules: 'candidate' }).differences.length) return `${item.pair.kase.id}: the module's own message, changed, is reproduced`;
    }
    return null;
  });
  add('engine-error-shapes', () => {
    // Fixed messages: each engine's own are engine-written, a module's are not, and the class and members are read.
    const node = (name, message, value = {}) => ({ $dr: 'class', name, error: { name, message }, value });
    const cases = [
      [node('TypeError', "null is not an object (evaluating 'diff.additions')"), 'javascriptcore', true],
      [node('TypeError', "undefined is not an object (evaluating 'state.part[message.id]')"), 'javascriptcore', true],
      [node('TypeError', 'Attempted to assign to readonly property.'), 'javascriptcore', true],
      [node('TypeError', "Cannot read properties of null (reading 'additions')"), 'v8', true],
      [node('TypeError', "Cannot read properties of null (reading 'additions')"), 'javascriptcore', false],
      [node('TypeError', 'label needs text, got object'), 'javascriptcore', false],
      [node('Error', "null is not an object (evaluating 'x.y')"), 'javascriptcore', false],
      [node('TypeError', "null is not an object (evaluating 'x.y')", { extra: 1 }), 'javascriptcore', false],
      [{ $dr: 'id', n: 1, value: node('RangeError', 'Invalid array length') }, 'v8', true],
    ];
    for (const [tree, engine, wanted] of cases) if (compareModule.isEngineError(tree, engine) !== wanted) return `${JSON.stringify(tree)} under ${engine}: ${!wanted}, expected ${wanted}`;
    return null;
  });
  add('engine-messages-not-built', () => {
    // The scanner finds a native error built with an engine's text, in each way a module writes one, and not a module's
    // own text; the command makes such a recording inconclusive for a candidate (candidate.mjs engineMessagesBuilt).
    const found = compareModule.builtEngineMessages("new TypeError('x is not a function'); throw RangeError(\"Invalid array length\"); new TypeError(`${a} is not iterable`); new TypeError(`label needs text, got ${typeof text}`); new Error('null is not an object')");
    const got = found.map((item) => `${item.className}:${item.message}`);
    const wanted = ['TypeError:x is not a function', 'RangeError:Invalid array length', 'TypeError:x is not iterable'];
    if (JSON.stringify(got) !== JSON.stringify(wanted)) return `found ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`;
    const planted = commandModule.engineMessagesBuilt({ families: [{ module: new URL(import.meta.url).pathname }] });
    return planted.length ? null : 'a module that builds engine-shaped messages (this file) gives no problem';
  });
  add('engine-difference-rules', () => {
    // Each rule names the recorded calls it must and no other; the candidate rules then free that step's results only.
    const named = (family, entry, args) => compareModule.engineDifferenceOf(family, { input: { kind: 'call', entry, args } });
    const records = (ids) => [{}, 's1', ids.map((id) => ({ info: id === undefined ? { role: 'user' } : { id, role: 'user' }, parts: [] }))];
    const cases = [
      [named('message-order', 'sortMessagesChronologically', [INCONSISTENT]), 'sort-inconsistent-comparator'],
      [named('message-order', 'sortMessagesChronologically', [CONSISTENT]), null],
      [named('message-order', 'sortMessagesChronologically', [[{ id: 'a' }, null]]), 'sort-inconsistent-comparator'],
      [named('message-order', 'findMessageIndex', [INCONSISTENT, 'a']), null],
      [named('materialization', 'materializeSessionSnapshots', records(['m1', undefined])), 'sort-inconsistent-comparator'],
      [named('materialization', 'materializeSessionSnapshots', records(['m1', 'm2'])), null],
      [named('session-diff-stats', 'parseSessionDiffCount', [`0x${'f'.repeat(14)}`]), 'string-to-number-radix-rounding'],
      [named('session-diff-stats', 'parseSessionDiffCount', [` 0b${'1'.repeat(54)} `]), 'string-to-number-radix-rounding'],
      [named('session-diff-stats', 'parseSessionDiffCount', [`0x${'f'.repeat(13)}`]), null],
      [named('session-diff-stats', 'parseSessionDiffCount', [`0x000${'f'.repeat(13)}`]), null],
      [named('session-diff-stats', 'parseSessionDiffCount', ['9'.repeat(40)]), null],
      [named('tool-status', 'normalizeToolStatus', [`0x${'f'.repeat(20)}`]), null],
    ];
    for (const [index, [got, wanted]] of cases.entries()) if (got !== wanted) return `case ${index}: ${got}, expected ${wanted}`;
    const { kase, answer } = sortCase([INCONSISTENT], [['x']], [['y']]);
    const freed = compareCandidate(kase, answer, { family: 'message-order' });
    if (freed.differences.length || JSON.stringify(freed.freedoms) !== JSON.stringify(['engine-difference'])) return `a named step answered otherwise: ${first(freed)}, freedoms ${freed.freedoms.join(', ')}`;
    if (!compareCandidate(kase, answer, { family: 'message-order', rules: 'exact' }).differences.length) return 'the exact rules free a named step';
    if (!compareCandidate(kase, answer, { family: 'tool-status' }).differences.length) return 'a rule applied to a family it does not name';
    return null;
  });
  add('freedom-settle-opening', () => {
    // Where a settled answer opened is free (the group freedom), and the exact rules see it.
    let applied = 0;
    for (const pair of pairs) {
      const answer = changeStep(clone(pair.replayed), (step) => step.input?.kind === 'settle' && Number.isInteger(step.openedAt) && pair.replayed.groups[step.group - 1]?.effects.length > step.openedAt && { ...step, openedAt: pair.replayed.groups[step.group - 1].effects.length });
      if (!answer) continue;
      applied += 1;
      if (judge(pair, answer).differences.length) return `${pair.kase.id}: a settled answer opened elsewhere differs under the candidate rules: ${first(judge(pair, answer))}`;
      if (!compareCandidate(pair.kase, answer, { unordered: pair.unordered, rules: 'exact' }).differences.length) return `${pair.kase.id}: the exact rules do not see a settled answer opened elsewhere`;
    }
    return applied ? null : 'no toy case has a settled answer with effects after it opened';
  });
  add('recording-version-refused', () => {
    // The version read is the recorder's (pinned here from its source, which only Bun can load), and a container of
    // another recording is refused by name, not read by rules it was not made by.
    const source = readFileSync(path.join(harnessDir, 'recorder.mjs'), 'utf8');
    const recorded = Number(/^export const RECORDING_VERSION = (\d+);$/m.exec(source)?.[1]);
    if (recorded !== replayModule.RECORDING) return `the recorder writes recording ${recorded}, the replayer reads ${replayModule.RECORDING}`;
    // A container of the recording of the replayer's toys (a planted copy has no tracked toy corpus of its own).
    const run = captured.runs[1];
    const [container] = captured.containers ?? [];
    if (!container || !run) return 'no toy container to read';
    const plain = replayModule.planContainers([container], run.portMap);
    if (plain.problems.length || plain.containers.length !== 1) return `the toy container is not read: ${JSON.stringify(plain.problems).slice(0, 300)}`;
    const newline = container.text.indexOf('\n');
    const header = JSON.parse(container.text.slice(0, newline));
    for (const other of [replayModule.RECORDING - 1, replayModule.RECORDING + 1]) {
      const text = `${JSON.stringify({ ...header, recording: other })}${container.text.slice(newline)}`;
      const planned = replayModule.planContainers([{ name: container.name, text }], run.portMap);
      if (planned.containers.length || !planned.problems.some((item) => item.check === 'header' && item.detail.includes(`recording ${other},`))) return `a container of recording ${other} is read: ${JSON.stringify(planned.problems).slice(0, 300)}`;
    }
    return null;
  });
  add('layout-order-counters', () => {
    // Every recorded toy case (judged or not), in both runs: the laid-out order agrees with the recorder's counters.
    const totals = { cases: 0, calls: 0, timers: 0, settles: 0 };
    for (const run of captured.runs) {
      for (const container of run.planned.containers) {
        for (const { record } of container.cases) {
          if (record.outcome !== 'recorded' || !Array.isArray(record.steps) || !record.steps.length) continue;
          const found = replayCompare.layoutCounterCheck(record.steps);
          if (found.violations.length) return `${record.id}: ${found.violations[0]}`;
          totals.cases += 1;
          for (const key of ['calls', 'timers', 'settles']) totals[key] += found[key];
        }
      }
    }
    return totals.calls && totals.timers && totals.settles ? null : `the toys give the counters too little to check: ${JSON.stringify(totals)}`;
  });
  for (const field of FIELD_CHECKS) {
    add(field.name, () => {
      let applied = 0;
      for (const pair of pairs) {
        const answer = field.change(clone(pair.replayed), pair.kase);
        if (!answer) continue;
        applied += 1;
        const result = judge(pair, answer);
        if (!result.differences.length) return `${pair.kase.id}: reproduced`;
        if (!has(result, field.check ?? result.differences[0].check, field.kind)) return `${pair.kase.id}: different by ${first(result)}, not by ${field.check ?? '*'}/${field.kind ?? '*'}`;
      }
      return applied ? null : 'no toy case has the part: it proves nothing';
    });
  }
  for (const [name, problem] of judgeChecks(captured, { censusModule, commandModule })) if (wanted(name)) checks.push([name, problem]);
  if (wanted('judge-repeat-runs')) checks.push(['judge-repeat-runs', await repeatCheck(captured, commandModule)]);
  return checks;
}

/** `--repeat=N` replays N times and a case judged two ways is unstable (the C0g review's m-repeat-runs-once): on a stub replay. */
async function repeatCheck(captured, commandModule) {
  try {
    const [run] = captured.runs;
    let calls = 0;
    const replay = async () => {
      calls += 1;
      const result = copyRun(run).result;
      if (calls === 3) { const item = result.cases.find((kase) => kase.outcome === 'reproduced'); item.modes.file = { ...item.modes.file, outcome: 'different', differences: [{ check: 'effects', kind: 'order', step: 1, path: '/steps/0/effects/0' }] }; }
      return result;
    };
    const { repeats } = await commandModule.replayRepeated(run.planned, { engine: null, rules: 'candidate', modes: ['file', 'isolated'], repeat: 3, replay });
    if (calls !== 3) return `--repeat=3 replayed ${calls} times`;
    return repeats.length === 1 && /run 3/.test(repeats[0]) ? null : `the third run's other judgement is not reported unstable: ${JSON.stringify(repeats).slice(0, 300)}`;
  } catch (error) {
    return `threw: ${error.stack ?? error}`;
  }
}

/** A run of the capture with its result and records copied, so a check can change one thing. */
function copyRun(run) {
  return {
    ...run,
    result: { ...run.result, problems: [...run.result.problems], cases: run.result.cases.map((kase) => ({ ...kase, modes: Object.fromEntries(Object.entries(kase.modes).map(([mode, entry]) => [mode, { ...entry, differences: [...(entry.differences ?? [])] }])) })) },
    planned: { ...run.planned, containers: run.planned.containers.map((container) => ({ ...container, cases: container.cases.map((item) => ({ ...item, record: { ...item.record } })) })) },
  };
}

/** The judgement and the census on the captured toy runs, each changed in one thing: `[[name, problem or null]]`. */
export function judgeChecks(captured, { censusModule, commandModule }) {
  const { EXIT } = censusModule;
  const out = [];
  const base = () => {
    const runs = captured.runs.map(copyRun);
    return { runs, recordingCensus: clone(commandModule.toyRecordingCensus()), contract: clone(censusModule.loadContract(commandModule.TOY_CONTRACT)) };
  };
  const run = (name, edit, expect) => {
    try {
      const setup = base();
      const extra = edit(setup) ?? {};
      const judged = commandModule.judgeRuns(setup.runs, { recordingCensus: setup.recordingCensus, contract: setup.contract, problems: extra.problems ?? [], partial: extra.partial === true, ...(extra.modes ? { modes: extra.modes } : {}) });
      out.push([name, expect(judged)]);
    } catch (error) {
      out.push([name, `threw: ${error.stack ?? error}`]);
    }
  };
  const lines = (judged) => [...judged.inconclusive, ...judged.unstable, ...judged.failures];
  const code = (wanted, line) => (judged) => (judged.code !== wanted ? `exit ${judged.code}, expected ${wanted}; ${lines(judged).slice(0, 2).join(' | ').slice(0, 400)}` : line && !lines(judged).some((text) => line.test(text)) ? `exit ${wanted} but no line matches ${line}` : null);
  const casesOf = (runs, predicate) => runs.flatMap((item) => item.result.cases.map((kase, index) => ({ run: item, kase, index }))).filter(predicate);
  const recordOf = (item) => { let at = 0; for (const container of item.run.planned.containers) for (const entry of container.cases) { if (at === item.index) return entry.record; at += 1; } return null; };
  const reproducedCase = (runs) => casesOf(runs, ({ kase }) => kase.outcome === 'reproduced')[0];
  const differ = (kase, difference) => { kase.outcome = 'different'; kase.modes.file = { ...kase.modes.file, outcome: 'different', differences: [difference] }; };
  run('judge-control', () => null, code(EXIT.pass));
  run('judge-difference', ({ runs }) => { differ(reproducedCase(runs).kase, { check: 'effects', kind: 'value', step: 1, path: '/steps/0/effects/0', expected: 'a', actual: 'b' }); }, code(EXIT.fail, /^different /));
  run('judge-inconclusive-case', ({ runs }) => { const item = reproducedCase(runs); item.kase.outcome = 'inconclusive'; item.kase.modes.file = { ...item.kase.modes.file, outcome: 'inconclusive', detail: 'planted: the engine was lost' }; }, code(EXIT.inconclusive, /planted: the engine was lost/));
  run('judge-mode-missing', ({ runs }) => { const item = reproducedCase(runs); delete item.kase.modes.isolated; item.kase.outcome = 'inconclusive'; }, code(EXIT.inconclusive, /not run in every mode/));
  run('judge-unrecordable-unwaived', ({ recordingCensus }) => { recordingCensus.unrecordable = []; }, code(EXIT.inconclusive, /unrecordable .*no unrecordable waiver names/));
  run('judge-unrecordable-by-name', ({ recordingCensus }) => { const waiver = recordingCensus.unrecordable.find((item) => item.flag === 'accessor'); waiver.test = 'another test of the same file'; }, code(EXIT.inconclusive, /accessor\), and no unrecordable waiver/));
  // A case waived for one of its flags only: its second flag, which no waiver names, leaves it unjudged and unwaived.
  run('judge-unrecordable-every-flag', ({ runs }) => { const item = casesOf(runs, ({ kase }) => kase.outcome === 'unrecordable').find((entry) => JSON.stringify(recordOf(entry)?.flags) === '["accessor"]'); recordOf(item).flags = ['accessor', 'opaque']; }, code(EXIT.inconclusive, /accessor, opaque\), and no unrecordable waiver names/));
  // A case unrecordable with no flag at all: every flag is covered vacuously, so it must be refused by name (S4).
  run('judge-unrecordable-flagless', ({ runs }) => { const item = casesOf(runs, ({ kase }) => kase.outcome === 'unrecordable').find((entry) => JSON.stringify(recordOf(entry)?.flags) === '["accessor"]'); recordOf(item).flags = []; }, code(EXIT.inconclusive, /unrecordable with no flag/));
  run('judge-real-transport-alone', ({ runs }) => { const item = casesOf(runs, ({ kase }) => kase.outcome === 'unrecordable').find((entry) => (recordOf(entry)?.flags ?? []).includes('real-transport')); const record = recordOf(item); record.flags = [...record.flags, 'opaque']; }, code(EXIT.inconclusive, /real-transport case must carry that flag alone/));
  run('judge-real-transport-without-steps', ({ runs }) => { const item = casesOf(runs, ({ kase }) => kase.outcome === 'unrecordable').find((entry) => (recordOf(entry)?.flags ?? []).includes('real-transport')); const record = recordOf(item); record.steps = [{ n: 1, input: { kind: 'call', entry: 'planted' }, effects: [] }]; }, code(EXIT.inconclusive, /real-transport case must carry that flag alone and no steps/));
  run('judge-not-replayable-unwaived', ({ contract: given }) => { given.unjudged = given.unjudged.filter((item) => item.family !== 'toy-timers'); }, code(EXIT.inconclusive, /toy-timers: not replayable/));
  // A not-replayable waiver names its tests: one of another test leaves the case unwaived (S4).
  run('judge-not-replayable-by-test', ({ contract: given }) => { const waiver = given.unjudged.find((item) => item.tests); waiver.tests = ['another test of the same file']; }, code(EXIT.inconclusive, /toy-sched: not replayable/));
  run('judge-unjudged-stale', ({ contract: given }) => { given.unjudged.push({ family: 'toy-reducer', outcome: 'not-replayable', tests: ['no such test'], reason: 'planted' }); }, code(EXIT.fail, /candidate-waiver-stale: the unjudged waiver of toy-reducer/));
  run('judge-unstable-unwaived', ({ runs }) => { const item = reproducedCase(runs); item.kase.outcome = 'no-reference'; recordOf(item).outcome = 'unstable'; }, code(EXIT.unstable, /recorded unstable/));
  // A case recorded unstable that a waiver names is waived: no unstable or inconclusive line (the pins see the case lost).
  run('judge-unstable-waived', ({ runs, recordingCensus }) => { const item = reproducedCase(runs); item.kase.outcome = 'no-reference'; const record = recordOf(item); record.outcome = 'unstable'; recordingCensus.unstable = [{ file: record.id.slice(0, record.id.search(/[: ]/)), reason: 'planted' }]; }, (judged) => (judged.unstable.length || judged.inconclusive.length ? `exit ${judged.code}: ${[...judged.unstable, ...judged.inconclusive].slice(0, 2).join(' | ').slice(0, 300)}` : null));
  run('judge-recorded-inconclusive', ({ runs }) => { const item = reproducedCase(runs); item.kase.outcome = 'no-reference'; recordOf(item).outcome = 'inconclusive'; }, code(EXIT.inconclusive, /recorded inconclusive/));
  run('judge-precedence-inconclusive', ({ runs }) => { const [a, b] = casesOf(runs, ({ kase }) => kase.outcome === 'reproduced'); a.kase.outcome = 'no-reference'; recordOf(a).outcome = 'unstable'; differ(b.kase, { check: 'result', kind: 'value', step: 1, path: '/', expected: 'a', actual: 'b' }); return { problems: ['planted problem'] }; }, code(EXIT.inconclusive));
  run('judge-precedence-unstable', ({ runs }) => { const [a, b] = casesOf(runs, ({ kase }) => kase.outcome === 'reproduced'); a.kase.outcome = 'no-reference'; recordOf(a).outcome = 'unstable'; differ(b.kase, { check: 'result', kind: 'value', step: 1, path: '/', expected: 'a', actual: 'b' }); }, code(EXIT.unstable));
  run('judge-nothing-judged', ({ runs }) => { for (const item of casesOf(runs, ({ kase }) => kase.outcome === 'reproduced' || kase.outcome === 'different')) { item.kase.outcome = 'unrecordable'; } }, code(EXIT.inconclusive, /nothing was replayed/));
  run('judge-family-without-judged-case', ({ runs }) => { runs[0].requireFamilies = ['toy-gate']; }, code(EXIT.inconclusive, /family toy-gate has no judged case/));
  run('judge-fixture-reproduced', ({ runs }) => { const item = casesOf(runs, ({ kase }) => kase.outcome === 'different')[0]; item.kase.outcome = 'reproduced'; item.kase.modes.isolated = { ...item.kase.modes.isolated, outcome: 'reproduced', differences: [] }; }, code(EXIT.fail, /fixture .* must differ/));
  run('judge-problem', () => ({ problems: ['manifest: the recording exited 1'] }), code(EXIT.inconclusive, /the recording exited 1/));
  run('judge-repeat', ({ runs }) => { const again = copyRun(runs[0]).result; const item = again.cases.find((kase) => kase.outcome === 'reproduced'); item.modes.file = { ...item.modes.file, outcome: 'different', differences: [{ check: 'effects', kind: 'order', step: 2, path: '/steps/1/effects/0' }] }; runs[0].repeats = censusModule.repeatDifferences([runs[0].result, again]); }, code(EXIT.unstable, /run 1 judged it reproduced/));
  // Different in both runs, by different first differences: unstable too (S4).
  run('judge-repeat-other-difference', ({ runs }) => {
    const item = runs[0].result.cases.find((kase) => kase.outcome === 'reproduced');
    const again = copyRun(runs[0]).result;
    const other = again.cases[runs[0].result.cases.indexOf(item)];
    differ(item, { check: 'effects', kind: 'order', step: 2, path: '/steps/1/effects/0' });
    differ(other, { check: 'result', kind: 'value', step: 3, path: '/steps/2/returns' });
    runs[0].repeats = censusModule.repeatDifferences([runs[0].result, again]);
  }, code(EXIT.unstable, /run 1 judged it different effects\/order/));
  // A run that skipped part of the judgement (part of a recording, some modes only) is never a pass: not asked for, it
  // is inconclusive by a line naming what it skipped; asked for, it judges what it holds and, where that passes, exits
  // inconclusive all the same, naming what it skipped (S2 of the C0g reviews), so no exit code takes it for a pass.
  const partialPass = (pattern) => (judged) => (judged.code !== EXIT.inconclusive || lines(judged).length ? `exit ${judged.code}, expected ${EXIT.inconclusive} with no line: ${lines(judged).slice(0, 2).join(' | ').slice(0, 300)}` : judged.partial.some((line) => pattern.test(line)) ? null : `no skipped part matches ${pattern}: ${JSON.stringify(judged.partial)}`);
  run('judge-partial-unasked', ({ runs }) => { runs[0].complete = false; runs[0].scope = ['toy-reducer']; }, code(EXIT.inconclusive, /^partial: toy corpus holds part of a recording only/));
  run('judge-partial-asked', ({ runs }) => { runs[0].complete = false; runs[0].scope = ['toy-reducer']; return { partial: true }; }, partialPass(/families toy-reducer/));
  run('judge-partial-asked-difference', ({ runs }) => { runs[0].complete = false; runs[0].scope = ['toy-reducer']; differ(reproducedCase(runs).kase, { check: 'effects', kind: 'value', step: 1, path: '/steps/0/effects/0', expected: 'a', actual: 'b' }); return { partial: true }; }, code(EXIT.fail, /^different /));
  run('judge-modes-partial', () => ({ modes: ['file'] }), code(EXIT.inconclusive, /^partial: toy corpus judged in mode file only, not isolated/));
  run('judge-modes-partial-asked', () => ({ modes: ['isolated'], partial: true }), partialPass(/replayer toys judged in mode isolated only, not file/));
  // A family the engine refused as not ported (package C0i): out of the judgement, and the run partial, never 0.
  const notPorted = (runs, family) => { for (const item of casesOf(runs, ({ kase }) => kase.family === family && kase.outcome === 'reproduced')) { item.kase.outcome = 'not-ported'; item.kase.modes = { file: { outcome: 'not-ported', differences: [], detail: 'planted: not implemented' }, isolated: { outcome: 'not-ported', differences: [], detail: 'planted: not implemented' } }; } };
  run('judge-not-ported-unasked', ({ runs }) => { notPorted(runs, 'toy-reducer'); }, code(EXIT.inconclusive, /^partial: toy corpus: the engine does not implement families toy-reducer/));
  run('judge-not-ported-asked', ({ runs }) => { notPorted(runs, 'toy-reducer'); return { partial: true }; }, partialPass(/the engine does not implement families toy-reducer/));
  // Refused in file order only and reproduced alone (the C0i review's B1): inconclusive, asked for as partial or not.
  const notPortedFileOnly = (runs, family) => { for (const item of casesOf(runs, ({ kase }) => kase.family === family && kase.outcome === 'reproduced')) item.kase.modes = { ...item.kase.modes, file: { outcome: 'not-ported', differences: [], detail: 'planted: refused in file order only' } }; };
  run('judge-not-ported-one-mode', ({ runs }) => { notPortedFileOnly(runs, 'toy-reducer'); return { partial: true }; }, code(EXIT.inconclusive, /not ported in this mode only/));
  run('judge-not-ported-difference', ({ runs }) => { notPorted(runs, 'toy-reducer'); differ(casesOf(runs, ({ kase }) => kase.family !== 'toy-reducer' && kase.outcome === 'reproduced')[0].kase, { check: 'effects', kind: 'value', step: 1, path: '/steps/0/effects/0', expected: 'a', actual: 'b' }); return { partial: true }; }, code(EXIT.fail, /^different /));
  // The census.
  const censusCode = (check, pattern) => (judged) => (judged.code !== EXIT.fail ? `exit ${judged.code}, expected ${EXIT.fail}` : judged.census.failures.some((item) => item.check === check && (!pattern || pattern.test(item.detail))) ? null : `no ${check} failure${pattern ? ` matching ${pattern}` : ''}: ${judged.census.failures.map((item) => item.check).join(', ')}`);
  run('census-item-unjudged', ({ contract: given }) => { given.items = given.items.filter((item) => item.family !== 'toy-timers'); }, censusCode('candidate-item-unjudged', /createDebouncer of toy-timers/));
  run('census-waiver-judged', ({ contract: given }) => { given.items.push({ family: 'toy-reducer', kind: 'export', name: 'applyEvent', reason: 'planted' }); }, censusCode('candidate-waiver-judged', /applyEvent of toy-reducer/));
  // A waiver names the kind of its item: a port named like a judged export waives nothing and is stale (C0g review M7).
  run('census-waiver-kind', ({ contract: given }) => { given.items.push({ family: 'toy-reducer', kind: 'port', name: 'applyEvent', reason: 'planted' }); }, censusCode('candidate-waiver-stale', /port applyEvent of toy-reducer/));
  run('census-waiver-stale', ({ contract: given }) => { given.items.push({ family: 'toy-reducer', kind: 'export', name: 'noSuchExport', reason: 'planted' }); }, censusCode('candidate-waiver-stale', /noSuchExport/));
  run('census-waiver-unknown-family', ({ contract: given }) => { given.items.push({ family: 'no-such-family', kind: 'family', reason: 'planted' }); }, censusCode('candidate-waiver-stale', /no-such-family/));
  run('census-family-waiver-stale', ({ contract: given }) => { given.items.push({ family: 'toy-flow', kind: 'family', reason: 'planted' }); }, censusCode('candidate-waiver-stale', /family toy-flow/));
  run('census-unrecordable-is-not-judged', ({ runs }) => {
    // The only reproduced cases that call toy-flow's entry re-marked unrecordable: the export is exercised by none the candidate reproduced.
    for (const item of casesOf(runs, ({ kase }) => kase.family === 'toy-flow' && kase.outcome === 'reproduced')) { item.kase.outcome = 'unrecordable'; const record = recordOf(item); record.outcome = 'unrecordable'; record.flags = ['outside-chain']; }
    runs[0].requireFamilies = [];
  }, (judged) => (judged.census.failures.some((item) => item.check === 'candidate-item-unjudged' && /of toy-flow/.test(item.detail)) ? null : `no unjudged toy-flow item: ${judged.census.failures.map((item) => item.detail).join(' | ').slice(0, 300)}`));
  // A case the candidate differs on judges nothing of what it exercises (C0g review M7: not only by the exit code).
  run('census-different-is-not-judged', ({ runs }) => {
    for (const item of casesOf(runs, ({ kase }) => kase.family === 'toy-flow' && kase.outcome === 'reproduced')) differ(item.kase, { check: 'effects', kind: 'value', step: 1, path: '/', expected: 'a', actual: 'b' });
  }, (judged) => (judged.census.failures.some((item) => item.check === 'candidate-item-unjudged' && /createFlow of toy-flow/.test(item.detail)) ? null : `no unjudged createFlow: ${judged.census.failures.map((item) => item.check).join(', ')}`));
  run('census-recording-waiver-needs-unexercised', ({ contract: given, recordingCensus }) => {
    // A recording census waiver stands for an item no recorded case exercises; createDebouncer is recorded (in cases not
    // replayable), so with the contract's waiver gone, a recording census waiver of it does not cover it.
    given.items = given.items.filter((item) => item.family !== 'toy-timers');
    recordingCensus.exports.push({ family: 'toy-timers', export: 'createDebouncer', reason: 'planted' });
  }, censusCode('candidate-item-unjudged', /createDebouncer of toy-timers/));
  run('census-universe-item-unexercised', ({ runs }) => { runs[0].universe = { 'toy-reducer': { exports: ['applyEvent', 'createState', 'neverCalled'], ports: [], events: [] } }; }, censusCode('candidate-item-unjudged', /neverCalled of toy-reducer/));
  // The pins (the contract's `judged`): an item or cases that lost their judgement, a judged item not pinned, a stale pin.
  run('census-judged-lost', ({ contract: given }) => { given.judged['toy-reducer'].exports.push('neverJudged'); }, censusCode('candidate-judged-lost', /export neverJudged of toy-reducer/));
  run('census-judged-cases-lost', ({ contract: given }) => { given.judged['toy-reducer'].cases += 1; }, censusCode('candidate-judged-lost', /cases lost their judgement/));
  run('census-judged-unpinned', ({ contract: given }) => { given.judged['toy-reducer'].exports = given.judged['toy-reducer'].exports.filter((name) => name !== 'createState'); }, censusCode('candidate-judged-unpinned', /export createState of toy-reducer is judged and not pinned/));
  run('census-judged-family-unpinned', ({ contract: given }) => { delete given.judged['toy-flow']; }, censusCode('candidate-judged-unpinned', /toy-flow has 7 judged cases/));
  run('census-judged-pin-stale', ({ contract: given }) => { given.judged['no-such-family'] = { cases: 0, exports: [], ports: [], events: [] }; }, censusCode('candidate-waiver-stale', /pins no-such-family/));
  run('census-counts', () => null, (judged) => {
    for (const item of captured.runs) {
      for (const family of item.portMap.families) {
        const row = judged.census.families[family.name];
        const reproduced = item.result.cases.filter((kase) => kase.family === family.name && kase.outcome === 'reproduced').length;
        if (!row || row.cases.judged !== reproduced) return `${family.name}: the census counts ${row?.cases.judged} judged cases, the replayer reproduced ${reproduced}`;
        const unrecordable = item.result.cases.filter((kase) => kase.family === family.name && kase.outcome === 'unrecordable').length;
        if (unrecordable && !Object.keys(row.cases.unrecordable).length) return `${family.name}: ${unrecordable} unrecordable cases, none counted by flag`;
      }
    }
    return null;
  });
  out.push(...directoryChecks(commandModule));
  return out;
}

/**
 * A recording directory's judgement as candidate.mjs assembleFrom makes it,
 * on fixed readings (S2, S3 of the C0g review): complete only with no scope
 * and no chosen families; the manifest's verdict, its items for every family
 * it lists, and the families with a recorded case required.
 */
function directoryChecks(commandModule) {
  const manifest = (change = {}) => ({ scope: null, families: { a: {}, b: {} }, verdict: { code: 0, failures: 0, inconclusive: 0, unstable: 0 }, items: { a: { exports: [], ports: [], events: [] }, b: { exports: [], ports: [], events: [] } }, ...change });
  const reading = (change) => ({ problems: [], manifest: manifest(change), requireFamilies: ['a', 'b'] });
  const cases = [
    ['directory-complete', () => commandModule.assembleFrom({ recording: reading() }), (got) => got.complete === true && got.problems.length === 0 && JSON.stringify(got.requireFamilies) === '["a","b"]'],
    ['directory-scope-is-partial', () => commandModule.assembleFrom({ recording: reading({ scope: ['a'] }) }), (got) => got.complete === false],
    ['directory-families-is-partial', () => commandModule.assembleFrom({ recording: reading(), families: ['a'] }), (got) => got.complete === false],
    ['directory-verdict-required', () => commandModule.assembleFrom({ recording: reading({ verdict: { code: 1, failures: 1, inconclusive: 0, unstable: 0 } }) }), (got) => got.problems.some((line) => /the recording exited 1/.test(line))],
    ['directory-items-required', () => commandModule.assembleFrom({ recording: reading({ items: undefined }) }), (got) => got.problems.some((line) => /has no census items/.test(line))],
    ['directory-items-every-family', () => commandModule.assembleFrom({ recording: reading({ items: { a: { exports: [], ports: [], events: [] } } }) }), (got) => got.problems.some((line) => /no census items for family b/.test(line))],
    ['directory-families-required', () => commandModule.assembleFrom({ recording: { ...reading(), requireFamilies: ['b'] }, requireAlso: ['c'] }), (got) => JSON.stringify(got.requireFamilies) === '["b","c"]'],
  ];
  return cases.map(([name, make, ok]) => { try { const got = make(); return [name, ok(got) ? null : `assembled ${JSON.stringify(got).slice(0, 300)}`]; } catch (error) { return [name, `threw: ${error.stack ?? error}`]; } });
}

const COMMAND_DEADLINE_MS = 240000;
const OUTPUT_LIMIT = 200000;
/** The command as a process: resolves `{ code, said }` (its last output lines, bounded), named and killed at its deadline. */
function runCommand(harnessDir, args, { cwd = REPOSITORY_ROOT, limit = COMMAND_DEADLINE_MS, name }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(harnessDir, 'candidate.mjs'), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    const keep = (chunk) => { output = (output + chunk).slice(-OUTPUT_LIMIT); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    let kill = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
      kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 15000);
    }, limit);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (kill) clearTimeout(kill);
      const said = output.split('\n').filter(Boolean);
      resolve(timedOut ? { code: null, said: [`${name}: the candidate command did not end within ${limit} ms and was stopped`, ...said] } : { code, said });
    });
  });
}

/** The command checks the per-push self-test runs: one of each exit code it can reach cheaply (the rest run in the full suite). */
export const PER_PUSH_COMMANDS = Object.freeze(['command-typescript-toys', 'command-usage']);

/**
 * The command checks: `[[name, problem or null]]`. `recording` is a recording
 * of the replayer's toys, written into `workDir` as a directory with its
 * manifest for the directory runs.
 */
export async function commandChecks({ harnessDir = HARNESS_DIR, workDir, recording, only = null, except = [] }) {
  const [manifest, portMapModule, censusModule, containerModule] = await Promise.all(['manifest.mjs', 'port-map.mjs', 'candidate-census.mjs', 'container.mjs'].map((name) => load(harnessDir, name)));
  const { EXIT } = censusModule;
  const portMapFile = path.join(harnessDir, 'toy', 'replay', 'replay-port-map.json');
  const portMap = portMapModule.loadPortMap(portMapFile, { root: REPOSITORY_ROOT });
  const fake = path.join(harnessDir, 'toy', 'replay', 'fake-engine.mjs');
  const reshapedEngine = path.join(harnessDir, 'reshaped-engine.mjs');
  mkdirSync(workDir, { recursive: true });
  const containers = recording.containers.map((item) => ({ name: item.name, text: item.text }));
  // A census and a contract of the replayer's toys: they need no waiver but their fixtures' (unrecordable by name), and
  // the contract pins what the TypeScript engine judges of them.
  const censusFile = path.join(workDir, 'census.json');
  writeFileSync(censusFile, `${JSON.stringify({ version: 1, note: 'the replayer toys', unrecordable: [
    { file: 'scripts/client-conformance/toy/replay/toy-store.toy.mjs', tests: ['a module no family maps moves the state between the test\'s own calls (unrecordable: state-moved)', 'a module no family maps writes the module state, with no notification, between the test\'s own calls (unrecordable: state-moved)'], flag: 'state-moved', reason: 'fixture' },
    { file: 'scripts/client-conformance/toy/replay/toy-store.toy.mjs', test: 'a module no family maps writes a box the family handed out, through the family\'s own reference (unrecordable: handed-out-touched)', flag: 'handed-out-touched', reason: 'fixture' },
  ] })}\n`);
  const toyContract = censusModule.loadContract(path.join(harnessDir, 'toy', 'candidate-census.json'));
  const contractFile = path.join(workDir, 'contract.json');
  const pins = Object.fromEntries(portMap.families.map((family) => [family.name, toyContract.judged[family.name]]).filter(([, pin]) => pin));
  // File order only: the replayer's hidden-state fixture differs alone, by design, so its family judges one case more.
  if (pins['toy-relay']) pins['toy-relay'] = { ...pins['toy-relay'], cases: pins['toy-relay'].cases + 1 };
  writeFileSync(contractFile, `${JSON.stringify({ version: censusModule.CONTRACT_VERSION, judged: pins, items: [], unjudged: [] })}\n`);
  // The items of each family, as a family command would write them: the exports its cases call and the map's ports.
  const items = {};
  for (const family of portMap.families) {
    const exports = new Set();
    for (const item of containers.filter((container) => container.name.includes(`.${family.name}.`))) {
      for (const record of containerModule.readContainer(item.text).cases) for (const step of record.steps ?? []) if (typeof step.input?.entry === 'string') exports.add(step.input.entry.split('#')[0].split('.')[0]);
    }
    const ports = [];
    for (const [, target] of portMap.modules) for (const [, port] of target.ports) if (port.families.includes(family.name)) ports.push(port.name);
    items[family.name] = { exports: [...exports].sort(), ports: [...new Set(ports)].sort(), events: [] };
  }
  const directory = (name, verdict, { list = containers, scope = null, families = portMap.families.map((family) => family.name), withItems = items } = {}) => {
    const dir = path.join(workDir, name);
    mkdirSync(dir, { recursive: true });
    for (const item of list) writeFileSync(path.join(dir, item.name), item.text);
    manifest.writeManifest(dir, list, { portMap: portMap.digest, families, scope, ...(verdict ? { verdict, items: withItems } : {}) });
    return dir;
  };
  const passed = { code: 0, failures: 0, inconclusive: 0, unstable: 0 };
  const intact = directory('intact', passed);
  const failed = directory('failed', { code: 1, failures: 1, inconclusive: 0, unstable: 0 });
  const old = directory('no-verdict', null);
  const firstFamily = portMap.families[0].name;
  const scoped = directory('scoped', passed, { list: containers.filter((item) => item.name.includes(`.${firstFamily}.`)), scope: [firstFamily], families: [firstFamily], withItems: { [firstFamily]: items[firstFamily] } });
  const itemsPartial = directory('items-partial', passed, { withItems: { [firstFamily]: items[firstFamily] } });
  // File order only (the replayer's hidden-state fixture differs alone, by design, and a directory has no fixtures):
  // a partial run, asked for as one unless `asked` is false. Its judged part passing exits 3, never 0 (S2).
  const dirArgs = (dir, { asked = true } = {}) => [`--from=${dir}`, `--port-map=${portMapFile}`, `--census=${censusFile}`, `--contract=${contractFile}`, `--cwd=${REPOSITORY_ROOT}`, '--modes=file', ...(asked ? ['--partial'] : [])];
  const engine = (file, args) => [`--engine=${file}`, `--engine-args=${args.join(',')}`];
  const cases = [
    ['command-typescript-toys', ['--toys'], EXIT.pass, /candidate \(candidate rules\): .*exit 0$/],
    ['command-usage', ['--toys', '--rules=lenient'], EXIT.usage, /--rules takes/],
    ['command-reshaped-toys', ['--toys', ...engine(reshapedEngine, ['reshaped'])], EXIT.pass, /freedoms used .*group/],
    ['command-reshaped-exact', ['--toys', '--rules=exact', ...engine(reshapedEngine, ['reshaped'])], EXIT.fail, /^different: different /],
    ['command-outside-engine', ['--toys', ...engine(reshapedEngine, ['outside-sync-to-async'])], EXIT.fail, /effects\/return-position/],
    // File order only, asked for: its last line names the mode left out (the C0g review 2's S2; unasked, judge-modes-partial).
    ['command-directory', dirArgs(intact), EXIT.inconclusive, /^candidate \(candidate rules, partial pass \(asked for with --partial\), not a complete pass: intact judged in mode file only, not isolated\): .*; exit 3$/],
    ['command-echo', [...dirArgs(intact), ...engine(fake, ['echo'])], EXIT.fail, /^different: different /],
    ['command-lag', [...dirArgs(intact), ...engine(fake, ['lag', intact])], EXIT.fail, /^different: different /],
    ['command-lookup', [...dirArgs(intact), ...engine(fake, ['lookup', intact])], EXIT.fail, /^different: different /],
    ['command-recording-failed', dirArgs(failed), EXIT.inconclusive, /the recording exited 1/],
    ['command-recording-without-verdict', dirArgs(old), EXIT.inconclusive, /has no verdict/],
    // A directory that holds part of a recording (its manifest names a scope), and one asked for so (S2).
    ['command-partial-directory', dirArgs(scoped, { asked: false }), EXIT.inconclusive, /^inconclusive: partial: .*holds part of a recording only/],
    ['command-partial-asked', dirArgs(scoped), EXIT.inconclusive, /^candidate \(candidate rules, partial pass \(asked for with --partial\), not a complete pass: .*holds part of a recording only.*; exit 3$/],
    ['command-families-partial', [...dirArgs(intact, { asked: false }), `--families=${firstFamily}`], EXIT.inconclusive, /^inconclusive: partial: .*families /],
    ['command-items-partial', dirArgs(itemsPartial), EXIT.inconclusive, /no census items for family/],
    // --repeat replays the engine again: the TypeScript engine judges every case alike (exit 0, no unstable case).
    ['command-repeat', [...dirArgs(intact), '--repeat=2'], EXIT.inconclusive, /0 unstable, 0 inconclusive problems; exit 3$/],
    // An engine that refuses a family as not ported (package C0i): a partial run, asked for or not, never exit 0.
    ['command-not-ported-asked', ['--toys', '--partial', ...engine(reshapedEngine, ['not-ported:toy-reducer'])], EXIT.inconclusive, /^candidate \(candidate rules, partial pass \(asked for with --partial\), not a complete pass: toy corpus: the engine does not implement families toy-reducer \(\d+ cases not ported, not judged\)\): .*[1-9]\d* not ported; .*exit 3$/],
    ['command-not-ported-unasked', ['--toys', ...engine(reshapedEngine, ['not-ported:toy-reducer'])], EXIT.inconclusive, /^inconclusive: partial: toy corpus: the engine does not implement families toy-reducer/],
    // The C0i review's B1 engines: some units of every family refused, the same cases computed in the others. Asked for
    // as partial or not, inconclusive, with the problem named (never a pass of the units it chose to run).
    ['command-not-ported-file-units', ['--toys', '--partial', ...engine(reshapedEngine, ['not-ported-file-units'])], EXIT.inconclusive, /not-ported-partly: the engine refused family /],
    ['command-not-ported-first-unit', ['--toys', ...engine(reshapedEngine, ['not-ported-first-unit'])], EXIT.inconclusive, /not-ported-partly: the engine refused family /],
  ].filter(([name]) => (only === null || only.includes(name)) && !except.includes(name));
  // At most four heavy children at once (each starts an engine).
  const results = [];
  for (let at = 0; at < cases.length; at += 4) {
    results.push(...await Promise.all(cases.slice(at, at + 4).map(async ([name, args, wanted, line]) => {
      const { code, said } = await runCommand(harnessDir, args, { name });
      const problems = [];
      if (code !== wanted) problems.push(`exit ${code}, expected ${wanted}`);
      if (line && !said.some((text) => line.test(text))) problems.push(`no line matches ${line}`);
      return [name, problems.length ? `${problems.join('; ')}; said ${JSON.stringify(said.filter((text) => /^(different|inconclusive|unstable)/.test(text)).slice(0, 2).map((text) => text.slice(0, 300)))}; last ${JSON.stringify(said.at(-1)?.slice(0, 300))}` : null];
    })));
  }
  return results;
}
