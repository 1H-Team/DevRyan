// The comparer of the client engine conformance harness for an engine that is
// not the TypeScript one (package C0g; design file 29 §4.1, §4.2, §6): the
// rules a candidate engine (a Rust runner, C0i) is judged by against the
// recordings. Pure functions over resolved codec trees: no engine, no file, no
// clock.
//
// Engine protocol 5 (engine.mjs) has the engine report, per group, one ordered
// sequence of everything it made (`groups[g].effects`: port calls, reads,
// clock reads, draws, timers set and cleared, store notifications, answers
// settled, members written), and per step only what is the step's own: its
// group, where in that sequence it opened and returned, what it returned or
// threw, the arguments after it, its change set and state. A group runs from a
// delivery to the quiescence of what that delivery set in motion
// (replay-compare.mjs caseGroups); it never holds a later input the
// TypeScript engine is given only once it ran out.
//
// The contract (CONTRACT below, docs/TESTING.md): within a group, the order of
// observables is exact; which step of the group an observable is attributed
// to is free; nothing crosses a group boundary; clock reads are free only
// where every read of a source returned one value.
//
// The base rule stays the replayer's exact comparison (replay-compare.mjs
// compareReplayed: codec trees compared exactly, effects as an ordered list,
// identity as structure, the change set, the states, the pending timers),
// applied to two views of the case, the recorded one and the replayed one,
// each made by the same function from its own side: per group, the group's
// whole sequence on its first step, and per step its group, its results, and
// where it opened and returned in its group's sequence. The view takes away
// exactly what FREEDOMS names, and nothing else. The exact rules
// (compareExact) compare the steps the recorder's way and then this view with
// no freedom, so a case they reproduce is reproduced here too, and a
// candidate can never move a case out of `different` except through a freedom
// that is written down, with its reason, and pinned by a difference just
// outside it that still fails (the comparer's self-test, its OUTSIDE checks).
//
// What is a name, not a value, the exact rules already compare as structure
// and stays so here (NAMES): object identity numbers, port call numbers,
// timer ids, and the member order of the protocol's own objects (a step, an
// effect, a group), which are no codec values.
import { attribute, caseLayout, compareExact, compareReplayed, pendingByGroup } from './replay-compare.mjs';

export const COMPARE_VERSION = 2;
/** The two rule sets: `exact` (the TypeScript closure's) and `candidate` (exact, with FREEDOMS). */
export const RULE_SETS = Object.freeze(['exact', 'candidate']);

/** The contract a candidate engine is judged by, in four sentences (docs/TESTING.md repeats them). */
export const CONTRACT = Object.freeze([
  'Within a group, the order of observables is exact.',
  'Which step of the group an observable is attributed to is free.',
  'Nothing crosses a group boundary.',
  'Clock reads are free only where every read of a source returned one value.',
]);

/**
 * What a non-JavaScript engine is free in, each with why no observer of the
 * engine can tell, and the differences just outside it that still fail (each
 * pinned by a check of that name in the comparer's self-test).
 */
export const FREEDOMS = Object.freeze([
  {
    name: 'group',
    what: 'inside one group, which step an effect is attributed to: the engine reports the group\'s effects as one sequence and no attribution, and a settled answer\'s opening position (where the first reaction of its promise ran, an accident of the engine\'s own promise jobs) is not compared. Everything else of the group is: its whole sequence in order, every step\'s group, and where each step with a synchronous part (a call, `new`, `get`, a callback or a timer, nested or not) opened and returned in that sequence',
    why: 'a group is what one delivery set in motion before the engine ran out: no input of the protocol and no observer of the engine comes between its members except at the positions compared (a step\'s synchronous part opens and returns where the test called it), so which step a continuation belongs to is microtask order (the recorder forwards an earlier member\'s continuations to the later member that opened after them, C0f review S6), which a sans-IO engine that emits one ordered list of effects per delivery does not have; the order itself is observable by the ports and is compared exactly',
    outside: ['outside-group-leak', 'outside-async-past-later-input', 'outside-sync-to-async', 'outside-sync-across-members', 'outside-async-reordered', 'outside-continuation-duplicated', 'outside-repeat-dropped', 'outside-pending-across-group'],
  },
  {
    name: 'clock',
    what: 'clock reads (`clock` effects: Date.now, new Date, Date() and performance.now) are not compared as effects (how many, where, of which source) in a group each of whose steps had every read of each source return one value (the step\'s own time); a step\'s opening and return positions then count the group\'s other effects. Every time the engine stores, returns or hands a port is still compared exactly, and a value difference that is a time the steps supplied is named `time-oracle`',
    why: 'under the nominal clock a read changes nothing and every read of a source in a group returns the same value, so its count and position are unobservable except through the values derived from it, which are compared; a Rust module is handed the step\'s `now` and never reads a clock (the engine protocol\'s ENGINE_ACCIDENTS). Where one source returned two values in one step (a stub the test installed), which read got which value is behaviour, so the clock reads of that step\'s group are compared exactly',
    outside: ['outside-clock-time-shifted', 'outside-clock-varying-dropped', 'outside-draw-dropped'],
  },
]);

/** What the exact rules already compare as names (structure), never as numbers or text. */
export const NAMES = Object.freeze([
  { what: 'object identity numbers (`id`/`ref` n)', how: 'paired position by position across the case (replay-compare.mjs createIdentityJudge): which positions hold the same object is compared' },
  { what: 'port call numbers (`call` of a port or new effect) and timer ids (`id` of timer.set and timer.clear)', how: 'each side\'s own counts, compared as pairings across the case' },
  { what: 'the member order of a step, an effect, a group and the end answer', how: 'protocol objects, not codec values: compared member by member, never by their order (codec trees keep theirs)' },
]);

const isClock = (item) => item?.kind === 'clock';
const canonical = (tree) => JSON.stringify(tree);

/**
 * The groups (numbers, 1-based) of a recorded case where the clock freedom
 * holds: in each step of the group, every clock read of each source returned
 * one value (a step's own time; steps of one group may have been given
 * different times).
 */
export function clockFreeGroups(layout, steps) {
  const uniform = (step) => {
    const seen = new Map();
    for (const item of step.effects ?? []) {
      if (!isClock(item)) continue;
      const value = canonical(item.value);
      const known = seen.get(item.source);
      if (known === undefined) seen.set(item.source, value);
      else if (known !== value) return false;
    }
    return true;
  };
  const free = new Set();
  layout.groups.forEach((members, at) => { if (members.every((index) => uniform(steps[index]))) free.add(at + 1); });
  return free;
}

/** A position in a sequence counted without the clock reads before it. */
const recount = (sequence, position) => (Number.isInteger(position) ? position - sequence.slice(0, position).filter(isClock).length : position);

/**
 * The candidate's view of one side of a case: `side` is the recorded case
 * (`kind: 'recorded'`) or a protocol-5 answer read by the replayer
 * (`replayed`); the cutting comes from the recorded case (`layout`), so both
 * sides are cut alike. Per group: its sequence (the recording's, laid out by
 * caseLayout; the engine's `groups`) on the recorded group's first step, the
 * clock reads taken out where the freedom holds; per step: its group, its
 * opening position (not for a settled answer under the group freedom) and its
 * return position in its own group's sequence, recounted the same way. Groups
 * from `exactFrom` on (a halt, a step the engine did not report) are
 * compared step by step as the exact rules put them (`attribute`), so the
 * step that is missing or halted is what differs. Pending timers are named by
 * their group.
 */
export function candidateView(recorded, side, kind, { freedoms = ['group', 'clock'], layout = caseLayout(recorded.steps), exactFrom = Infinity } = {}) {
  const clockFree = freedoms.includes('clock') ? clockFreeGroups(layout, recorded.steps) : new Set();
  const settleFree = freedoms.includes('group');
  const steps = kind === 'recorded' ? recorded.steps : (Array.isArray(side.steps) ? side.steps : []);
  const sequences = kind === 'recorded' ? layout.sequences : (Array.isArray(side.groups) ? side.groups : []).map((group) => (Array.isArray(group?.effects) ? group.effects : []));
  const stepped = kind === 'recorded' ? recorded.steps : attribute(side, recorded).steps;
  const sequenceOf = (group) => sequences[group - 1] ?? [];
  const first = new Map(layout.groups.map((list, at) => [list[0], at + 1])); // recorded first step of a group -> its number
  const view = steps.map((step, index) => {
    if (!step || typeof step !== 'object') return step;
    const recordedGroup = index < layout.groupOf.length ? layout.groupOf[index] + 1 : undefined;
    const group = kind === 'recorded' ? recordedGroup : step.group;
    const { openedAt: given, returnedAt: returned, effects: _effects, group: _group, ...rest } = step;
    const openedAt = kind === 'recorded' ? layout.openedAt[index] : given;
    const returnedAt = kind === 'recorded' ? layout.returnedAt[index] : returned;
    const out = { ...rest, ...(group !== undefined ? { group } : {}) };
    if (recordedGroup === undefined || recordedGroup >= exactFrom) {
      // Compared the recorder's way: the step's own effects and its return among them.
      const own = stepped[index]?.effects ?? [];
      const free = recordedGroup !== undefined && clockFree.has(recordedGroup);
      out.effects = free ? own.filter((item) => !isClock(item)) : [...own];
      const local = stepped[index]?.returnedAt;
      if (Number.isInteger(local)) out.returnedAt = free ? local - own.slice(0, local).filter(isClock).length : local;
      return out;
    }
    const free = clockFree.has(recordedGroup);
    const sequence = sequenceOf(recordedGroup);
    out.effects = first.has(index) ? (free ? sequence.filter((item) => !isClock(item)) : [...sequence]) : [];
    // Positions are in the step's own group's sequence (the side's), recounted alike.
    const mine = sequenceOf(group);
    const position = (value) => (free && Number.isInteger(value) ? recount(mine, value) : value);
    const settled = recorded.steps[index]?.input?.kind === 'settle';
    if (openedAt !== undefined && !(settled && settleFree)) out.openedAt = position(openedAt);
    if (returnedAt !== undefined) out.returnedAt = position(returnedAt);
    return out;
  });
  // A sequence the engine made for a group the recording does not have is compared too (on the last step).
  if (kind !== 'recorded' && sequences.length > layout.sequences.length && view.length) {
    const last = view[view.length - 1];
    view[view.length - 1] = { ...last, effects: [...(last.effects ?? []), ...sequences.slice(layout.sequences.length).flat()] };
  }
  if (kind === 'recorded') {
    const pending = pendingByGroup(side.end?.pending, recorded.steps, layout.groupOf);
    return { ...side, steps: view, end: side.end ? { ...side.end, ...(side.end.pending ? { pending } : {}) } : side.end };
  }
  return { ...side, steps: view };
}

const numberOf = (node) => (typeof node === 'number' ? node : node !== null && typeof node === 'object' && node.$dr === 'number' ? Number(node.value) : null);

/** The times the recorded case supplied up to and including the step at `index` (its nows and its clock values). */
function suppliedTimes(recorded, index) {
  const times = new Set();
  if (recorded.entry?.state !== null && recorded.entry?.state !== undefined && typeof recorded.entry.now === 'number') times.add(recorded.entry.now);
  recorded.steps.slice(0, index + 1).forEach((step) => {
    times.add(step.input.now);
    for (const item of step.effects) if (item.kind === 'clock') { const time = numberOf(item.value); if (time !== null) times.add(time); }
  });
  return times;
}

/**
 * The exact comparison of the two views (`freedoms`, both by default; none is
 * the exact rules' order check). Returns `{ differences, stepsCompared }`. A
 * value difference that is a time the recorded steps supplied up to the end
 * of its group, where the engine has another, is `time-oracle` (the views
 * hold no clock reads where the freedom holds, so the times are taken from
 * the recorded case itself).
 */
export function compareUnderFreedoms(recorded, replayed, { unordered = [], freedoms = ['group', 'clock'] } = {}) {
  const layout = caseLayout(recorded.steps);
  const indexOfStep = new Map(recorded.steps.map((step, index) => [step.n, index]));
  const present = Math.min(recorded.steps.length, (replayed.steps ?? []).length);
  let exactFrom = present < recorded.steps.length ? layout.groupOf[present] + 1 : Infinity;
  const halted = replayed.halt ? indexOfStep.get(replayed.halt.step) : undefined;
  if (halted !== undefined) exactFrom = Math.min(exactFrom, layout.groupOf[halted] + 1);
  const options = { freedoms, layout, exactFrom };
  const result = compareReplayed(candidateView(recorded, recorded, 'recorded', options), candidateView(recorded, replayed, 'replayed', options), { unordered });
  const lastOfGroup = (index) => Math.max(...layout.groups[layout.groupOf[index]]);
  const differences = result.differences.map((item) => {
    if (item.kind !== 'value' || !Array.isArray(item.raw)) return item;
    const [expected, actual] = item.raw;
    const time = numberOf(expected);
    // The entry state (step 0) has the entry's time only; the end state and pending timers every time of the case.
    const at = indexOfStep.get(item.step);
    const index = item.step === 0 ? -1 : at === undefined ? recorded.steps.length - 1 : lastOfGroup(at);
    const times = suppliedTimes(recorded, index);
    if (time !== null && times.has(time) && !times.has(numberOf(actual))) return { ...item, kind: 'time-oracle', detail: `the engine has ${item.actual}, which is no time supplied up to here; the recording has the supplied ${time}` };
    return item;
  });
  return { differences, stepsCompared: result.stepsCompared };
}

/** The exact rules' order check: the view with no freedom (every group's sequence, every step's positions). */
const exactOrder = (recorded, replayed, { unordered = [] } = {}) => compareUnderFreedoms(recorded, replayed, { unordered, freedoms: [] });

/**
 * Compares a replayed case (a protocol-5 answer) with the recorded one under
 * `rules`: `exact` is replay-compare.mjs compareExact (the steps the
 * recorder's way, then the order with no freedom); `candidate` the views with
 * both freedoms. Returns `{ differences, stepsCompared, rules, exact,
 * freedoms }`: `exact` the number of differences the exact rules find,
 * `freedoms` the freedoms without which this case would differ (empty when
 * the exact rules reproduce it; reported, never silent).
 */
export function compareCandidate(recorded, replayed, { unordered = [], rules = 'candidate' } = {}) {
  const exact = compareExact(recorded, replayed, { unordered, exactOrder });
  if (rules === 'exact') return { ...exact, rules, exact: exact.differences.length, freedoms: [] };
  // A case the exact rules reproduce is reproduced: the views of what the exact rules found equal are equal, and the
  // freedoms only take the same parts out of both (the self-test pins it on every exact pair of the toys).
  if (!exact.differences.length) return { differences: [], stepsCompared: exact.stepsCompared, rules, exact: 0, freedoms: [] };
  const result = compareUnderFreedoms(recorded, replayed, { unordered });
  // Which freedom the case needed: each alone, else both (reported with the case, never silent). A case only the
  // recorder's attribution tells apart needs the group freedom (attribution is no part of the candidate rules).
  let freedoms = [];
  if (!result.differences.length) {
    const needs = (name) => compareUnderFreedoms(recorded, replayed, { unordered, freedoms: ['group', 'clock'].filter((other) => other !== name) }).differences.length > 0;
    freedoms = ['group', 'clock'].filter(needs);
    if (!freedoms.length) freedoms = ['group'];
  }
  return { differences: result.differences, stepsCompared: result.stepsCompared, rules, exact: exact.differences.length, freedoms };
}

/** The first difference of a case's differences, as one line: its check and kind, the step and the path. */
export const firstDifference = (differences) => {
  const first = differences[0];
  if (!first) return null;
  return { check: first.check, kind: first.kind ?? null, step: first.step ?? null, path: first.path, expected: first.expected, actual: first.actual };
};
