#!/usr/bin/env node
// The coverage census of the scheduler conformance harness (design file 30
// §4.6, package O0e): what the recordings exercise, read from the recordings
// and the closure check's verdict on each case, against a contract that pins
// what must be covered.
//
//   node scripts/scheduler-conformance/census.mjs [--sample] [--plants] [--sources=tests,package,scenarios]
//     [--tests=<file,...>] [--containers=<source>=<dir>,...] [--workers=N] [--json=<file>] [--keep-artifacts]
//
// The command runs the closure check (it records each source twice, or reads
// the containers given, and replays every case against a copy of the package)
// and then the census over the same containers. `--sample` is the full suite's
// sample (three scheduler test files and the scenarios). `--plants` also runs
// every planted scheduler copy and replayer bug against the same recordings
// once the closure passed (the whole-corpus run of a scheduled lane: closure,
// plants and census in one command, one exit code).
//
// Grades. A case exercises an item (a public member, a control method, a port,
// an option the test gave, an input kind, a placement mark, a launch situation,
// a reviewer's gap) when its events show it. The case judges it when the
// closure reproduced the case, whole or up to its compared prefix (every event
// before the first busy input, a property of the recording: the trace
// format's `casePlacement`), with the comparer passing, and the item shows inside that
// prefix: for a member or a control method its result (the return, throw or
// settlement the scheduler gave), for every other item its first event. A
// member called inside the prefix whose result lies past it is `call-only`,
// counted apart and never judged. A case that shows an item only at or after
// its first busy input, or is not compared at all, only recorded it. A member
// or control method whose every compared answer, over the whole corpus, is a
// refusal (a throw or a rejection) or one and the same value given with
// nothing of the call's work between the call and its answer (no port call,
// timer, abort, settlement or other answer of its construction: only the
// clock, options and environment read) is `shallow`: its answers do not show
// that it does its work (a refusal at the door, or a constant, would give the
// same), so it is counted and printed apart and never judged.
//
// What fails (exit 1): an item of the contract with no judged case and no
// waiver, a shallow one among them; a waiver of an item some case judges, of nothing the contract lists,
// not in the baseline (the waiver list only shrinks), or whose stated class
// (unreached, past-busy, call-only, uncompared, shallow) the corpus does not bear out;
// a contract that is not the scheduler's (its members and control methods, as
// an instance it builds has them; its ports and options, as the source reads
// them; the event kinds the recorder writes; the placement marks of the trace
// format); anything the recordings show that the contract does not list; a
// closure failure. What is inconclusive (exit 2): an empty corpus, a corpus that
// is not the whole one (then nothing fails for being unexercised; a waiver an
// item exercises still fails), a source whose containers are not the ones its
// recording wrote (a manifest written at record time: a case missing, a file
// cut short or re-marked), cases with no closure verdict, a closure that was
// inconclusive. Exit 0 only for the whole corpus with nothing wrong; 64 for a
// usage error. The table follows the scheduler harness's (the trace format's EXIT):
// unstable recordings are inconclusive there, as here.
//
// Counted and printed, never failed: `option-varies` cases per read key (OD2:
// a case whose compared prefix reads one key with two values is inconclusive
// for a candidate that is not JavaScript), placement notes, the busy mark,
// statuses and transitions in saved states, error codes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareEvent, LAUNCH_PORTS, preparePlain, readTable, unitsOf } from './compare.mjs';
import { checkManifest, readManifestText } from './recording-manifest.mjs';
import { caseEvents, casePlacement, EPOCH, EXIT, isArrivedEvent, loadTarget, PLACES, readContainer } from './trace.mjs';

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACT_FILE = path.join(HARNESS_DIR, 'census.json');
export const WAIVER_FILE = path.join(HARNESS_DIR, 'census-waivers.json');
export const CENSUS_VERSION = 1;
export const KINDS = Object.freeze(['member', 'control', 'port', 'option', 'input', 'place', 'launch', 'gap']);
const LISTS = Object.freeze({ member: 'members', control: 'control', port: 'ports', option: 'options', input: 'inputs', place: 'places', launch: 'launch', gap: 'gaps' });
/** Kinds whose item is a call that the scheduler answers: judged by that answer, not by the call. */
const ANSWERED = new Set(['member', 'control']);

/**
 * The class of a waiver, which the census checks against the corpus (on the
 * whole corpus exactly; on a part of it only where the part already refutes
 * it), and what may close each class (`needs`).
 */
export const WAIVER_CLASSES = Object.freeze({
  unreached: { means: 'no case shows it', needs: ['test', 'scenario', 'server recording', 'none'] },
  'past-busy': { means: 'every compared case shows it only at or after its first busy input', needs: ['placed test', 'scenario'] },
  'call-only': { means: 'a compared prefix holds its call, none its result', needs: ['placed test', 'scenario'] },
  uncompared: { means: 'only cases the closure did not compare show it', needs: ['placed test', 'scenario'] },
  shallow: { means: 'every compared answer is a refusal or one value answered with nothing of its work between', needs: ['placed test', 'scenario'] },
});

/**
 * The waivers that may exist (`kind:name`): the waiver list only shrinks. A
 * waiver not named here fails `waiver-new`; one named here that is gone is fine.
 * Package O0e2 gave every other waived item a judged scenario and removed it
 * from this list (55 to 1), so a closed waiver cannot come back unreviewed.
 */
export const WAIVER_BASELINE = Object.freeze([
  'gap:fake-timers-case',
]);

/** Every named check of a census run: the failures (exit 1) and what is inconclusive (exit 2). */
export const CENSUS_CHECKS = Object.freeze({
  'census-member': 'a public member of the scheduler whose result no judged case compares',
  'census-control': 'a control method whose result no judged case compares',
  'census-port': 'a port (an option function or a method of an option object) that no judged case calls',
  'census-option': 'a constructor option that no judged case gives',
  'census-input': 'an input or output kind of the trace alphabet that no judged case holds',
  'census-place': 'a placement mark that no judged case holds inside its compared prefix',
  'census-launch': 'a launch situation the oracles need that no judged case shows',
  'census-gap': 'a code path a review found unreached that no judged case reaches',
  'census-shallow': 'a member or control method whose every compared answer is a refusal or one value answered with nothing of its work between (shallow), with no waiver',
  'waiver-exercised': 'a waiver of an item a judged case exercises: remove it (stale)',
  'waiver-unknown': 'a waiver of nothing the contract lists (stale)',
  'waiver-new': 'a waiver that is not in the baseline: the waiver list only shrinks',
  'waiver-invalid': 'a waiver without a kind, a name, a class, a fitting need or a reason, or one given twice',
  'waiver-class': 'a waiver whose stated class (unreached, past-busy, call-only, uncompared, shallow) the corpus does not bear out',
  'contract-invalid': 'the contract file is not well formed',
  'contract-members': 'the contract\'s members are not the members an instance of the scheduler has',
  'contract-control': 'the contract\'s control methods are not the methods of the control object the scheduler hands its executor',
  'contract-options': 'the contract\'s options are not the options the scheduler\'s source reads',
  'contract-ports': 'the contract\'s ports and option data are not the members of option objects and the function options the scheduler\'s source uses (or a data member is called, or the source reaches one the census cannot name)',
  'contract-inputs': 'the contract\'s event kinds are not the kinds the recorder writes',
  'contract-places': 'the contract\'s placement marks are not the trace format\'s marks that can lie inside a compared prefix',
  'contract-unknown': 'the recordings show a member, control method, port, option, input kind or place the contract does not list',
  'contract-predicates': 'a launch situation or gap the contract names that has no predicate here, or the reverse',
  'census-results': 'the closure\'s verdicts do not match the recorded cases (a case without a verdict, a verdict without a case, an id twice, a reproduction of a case with a busy input)',
  closure: 'the closure check failed',
  'empty-corpus': 'no case recorded a scheduler (inconclusive, never a pass)',
  'corpus-incomplete': 'the corpus is not the whole one: a source, a test file or a scenario case is missing (inconclusive; unexercised items are not judged)',
  'corpus-manifest': 'a source\'s containers are not the ones its recording wrote: no manifest, a container missing, added, cut short, changed (a case dropped or re-marked) or unreadable (inconclusive)',
  'no-surface': 'the census was given no product surface: the contract is not checked against the scheduler (inconclusive)',
  unreplayed: 'the census was given no closure verdicts: what the marks would judge is not shown to be compared (inconclusive)',
  'closure-inconclusive': 'the closure check was inconclusive',
});

// ------------------------------------------------------------------ case views

const LAUNCH = new Set(LAUNCH_PORTS);
const isLaunch = (event) => event.kind === 'port' && LAUNCH.has(event.head.name);
const errorCode = (value) => (value && typeof value === 'object' && typeof value.code === 'string' ? value.code : null);
const errorMessage = (value) => (value && typeof value === 'object' ? value.$error?.message ?? value.message ?? null : null);
const tasksOf = (state) => (state && typeof state === 'object' && Array.isArray(state.tasks) ? state.tasks.filter((task) => task && typeof task === 'object') : []);

/**
 * One case as the census reads it: its events in total order with plain
 * values, the end of its compared prefix, and the spans of its calls and port
 * calls (index of the call to the index where it settled, Infinity when it
 * never did in the case).
 */
export function caseView(record, resolve) {
  // The comparer's form of each event (head fields, values, plain values in one identity scope), with the recorded event beside it.
  const events = preparePlain(caseEvents(record).map((raw) => Object.assign(compareEvent(raw, resolve), { raw })));
  const limit = record.outcome === 'recorded' ? casePlacement(record).limit : 0;
  const calls = new Map(); // `${c}:${call}` -> { member | method, start, end, event }: member calls and control calls, which the scheduler answers alike
  const ports = new Map(); // `${c}:${port}` -> { name, start, end, event, answer }
  for (const [index, event] of events.entries()) {
    event.index = index;
    const { head } = event;
    if (event.kind === 'call') calls.set(`${event.c}:${head.call}`, { member: head.member, start: index, end: Infinity, event, value: null, outcome: null });
    else if (event.kind === 'control') calls.set(`${event.c}:${head.call}`, { member: null, method: head.method, start: index, end: Infinity, event, value: null, outcome: null });
    else if (event.kind === 'return' || event.kind === 'throw' || event.kind === 'settle') {
      const call = calls.get(`${event.c}:${head.call}`);
      if (call && !(event.kind === 'return' && head.promise)) { call.end = index; call.outcome = event.kind === 'settle' ? head.outcome : event.kind; call.value = event.kind === 'throw' ? event.p.error : event.p.value; call.settledAt = index; }
    } else if (event.kind === 'port') ports.set(`${event.c}:${head.port}`, { name: head.name, start: index, end: Infinity, event, answer: null, outcome: null });
    else if (event.kind === 'answer') {
      const port = ports.get(`${event.c}:${head.port}`);
      if (port && head.outcome !== 'promise') { port.end = index; port.outcome = head.outcome; port.answer = head.outcome === 'throw' ? event.p.error ?? event.p.value : event.p.value; port.answeredAt = index; }
    }
  }
  const list = [...calls.values()];
  return { record, events, limit, calls: list.filter((call) => call.member !== null), controls: list.filter((call) => call.member === null), ports: [...ports.values()] };
}

const portsNamed = (view, test) => view.ports.filter((port) => test(port.name));
const openAt = (span, index) => span.start < index && index < span.end;
const firstIndex = (indices) => indices.reduce((low, index) => (index >= 0 && index < low ? index : low), Infinity);
/** The loaded state of each construction (its persistence.load answer) with the index where it arrived. */
const loads = (view) => portsNamed(view, (name) => name === 'persistence.load').filter((port) => port.outcome === 'resolve' || port.outcome === 'return').map((port) => ({ c: port.event.c, index: port.answeredAt, state: port.answer }));

/**
 * Launch situations the oracles need (design §5's scenarios and §2.2's
 * places). Each returns the index of the event that completes the situation
 * in the case, or -1.
 */
export const LAUNCH_SITUATIONS = Object.freeze({
  'simultaneous-submits': {
    design: 'F1, F2: several submits in one input group, before any of them settled',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'submit').map((call) => (view.calls.some((other) => other !== call && other.member === 'submit' && other.event.c === call.event.c && openAt(other, call.start)) ? call.start : -1))),
  },
  'submit-while-launch-pending': {
    design: 'F3, F4: a submit while a launch the executor was given has not settled',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'submit').map((call) => (view.ports.some((port) => isLaunch(port.event) && port.event.c === call.event.c && openAt(port, call.start)) ? call.start : -1))),
  },
  'fan-out-8': {
    design: 'F1, F2: eight or more launches in one input group (no call, fire or step marker between them)',
    find: (view) => {
      const run = new Map();
      for (const event of view.events) {
        if (event.dir === 'in' && ['call', 'fire', 'step'].includes(event.kind)) run.clear();
        if (isLaunch(event)) { const count = (run.get(event.c) ?? 0) + 1; run.set(event.c, count); if (count >= 8) return event.index; }
      }
      return -1;
    },
  },
  'launch-behind-held-save': {
    design: 'F5: a save held while a submit arrives, then the launch that waited for it',
    find: (view) => firstIndex(portsNamed(view, (name) => name === 'persistence.save').map((save) => {
      if (!Number.isFinite(save.end)) return -1;
      const behind = view.calls.some((call) => call.member === 'submit' && call.event.c === save.event.c && openAt(save, call.start));
      if (!behind) return -1;
      const launch = view.events.find((event) => event.index > save.end && event.c === save.event.c && isLaunch(event));
      return launch ? launch.index : -1;
    })),
  },
  'save-rejected-then-launch': {
    design: 'F6: a save that fails, and a launch after it',
    find: (view) => firstIndex(portsNamed(view, (name) => name === 'persistence.save').filter((save) => save.outcome === 'reject' || save.outcome === 'throw').map((save) => {
      const launch = view.events.find((event) => event.index > save.end && event.c === save.event.c && isLaunch(event));
      return launch ? launch.index : -1;
    })),
  },
  'restart-recovery': {
    design: 'F7: a construction that loads active tasks and reconciles or observes them',
    find: (view) => firstIndex(loads(view).filter((load) => tasksOf(load.state).some((task) => task.status === 'starting' || task.status === 'running')).map((load) => {
      const port = view.ports.find((item) => item.event.c === load.c && item.start > load.index && (item.name === 'executor.reconcile' || item.name === 'executor.observe'));
      return port ? port.start : -1;
    })),
  },
  'launch-after-recovery': {
    design: 'F7: a launch after the recovery of loaded active tasks began',
    find: (view) => {
      const recovered = LAUNCH_SITUATIONS['restart-recovery'].find(view);
      if (!Number.isFinite(recovered) || recovered < 0) return -1;
      const c = view.events[recovered].c;
      const launch = view.events.find((event) => event.index > recovered && event.c === c && isLaunch(event));
      return launch ? launch.index : -1;
    },
  },
  'runtime-restart-deferred-launch': {
    design: 'F8: a launch while withRuntimeRestart has not settled (a deferred launch replayed at release)',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'withRuntimeRestart').map((call) => {
      const launch = view.events.find((event) => event.c === call.event.c && openAt(call, event.index) && isLaunch(event));
      return launch ? launch.index : -1;
    })),
  },
  'prerequisites-hold': {
    design: 'F9, §2.2 #2-3: a saved task held with waitingReason prerequisites',
    find: (view) => firstIndex(portsNamed(view, (name) => name === 'persistence.save').map((save) => (tasksOf(save.event.p.args?.[0]).some((task) => task.waitingReason?.kind === 'prerequisites') ? save.start : -1))),
  },
  'auto-resume-attempt': {
    design: 'F10: an automatic follow-up attempted through autoResume.attempt',
    find: (view) => firstIndex(portsNamed(view, (name) => name === 'autoResume.attempt').map((port) => port.start)),
  },
  'handoff-refusal': {
    design: 'F11, §2.2 #9: a submit refused while a handoff holds its group (handoff_in_progress)',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'submit' && errorCode(call.value) === 'handoff_in_progress' && (call.outcome === 'reject' || call.outcome === 'throw')).map((call) => call.settledAt)),
  },
  'cancel-during-launch': {
    design: '§2.2 #11: a cancelTask while a launch the executor was given has not settled',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'cancelTask').map((call) => (view.ports.some((port) => isLaunch(port.event) && port.event.c === call.event.c && openAt(port, call.start)) ? call.start : -1))),
  },
});

/**
 * Code paths the reviews found no recording reaches (O0c review 1 and 3, O0d
 * review, design §4.5's crash points): each a named gap with the event that
 * reaches it, so a tests-only package can close it and its waiver then fails.
 */
export const GAPS = Object.freeze({
  'reconcile-retry-pending': {
    source: 'O0c review, plant reconcile-retry-unguarded: scheduler.js `if (reconciliationRetryTimers.has(task.taskId)) return;`',
    find: (view) => {
      const pending = new Map();
      for (const event of view.events) {
        if (event.kind === 'fire') pending.clear();
        if (event.kind !== 'answer' || event.head.outcome !== 'resolve') continue;
        const port = view.ports.find((item) => item.answeredAt === event.index);
        if (port?.name !== 'executor.reconcile' || port.answer?.state !== 'transient') continue;
        const key = `${event.c}:${port.event.p.args?.[0]?.taskId}`;
        if (pending.has(key)) return event.index;
        pending.set(key, event.index);
      }
      return -1;
    },
  },
  'handoff-abort-timeout': {
    source: 'O0c review, plant handoff-abort-late: the handoff abort race times out (`Managed task abort exceeded …`)',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'confirmAgentHandoff').map((call) => {
      const abort = view.events.find((event) => event.c === call.event.c && openAt(call, event.index) && event.kind === 'abort' && event.dir === 'out' && String(errorMessage(event.p.reason) ?? '').startsWith('Managed task abort exceeded'));
      return abort ? abort.index : -1;
    })),
  },
  'restart-starting-with-deadline': {
    source: 'O0c review, plant deadline-lease-swapped: restart `scheduleTaskDeadline(task); scheduleStartingLease(task);` for a loaded starting task with timeoutAt',
    find: (view) => firstIndex(loads(view).map((load) => (tasksOf(load.state).some((task) => task.status === 'starting' && task.timeoutAt !== null && task.timeoutAt !== undefined) ? load.index : -1))),
  },
  'getTask-missing': {
    source: 'O0c fix, plant getTask-undefined: getTask of a task that does not exist (reached only by the awaiting shapes, no corpus source)',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'getTask' && call.outcome === 'return' && call.value === null).map((call) => call.settledAt)),
  },
  'initialize-after-shutdown': {
    source: 'O0c review, plant shutdown-code: initialize after shutdown rejects scheduler_shut_down (reached only by the awaiting shapes)',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'initialize' && errorCode(call.value) === 'scheduler_shut_down').map((call) => call.settledAt)),
  },
  'publish-failure': {
    source: 'O0c review, plant publish-warn-text: a publishEvent port that throws or rejects (reached only by the awaiting shapes)',
    find: (view) => firstIndex(portsNamed(view, (name) => name === 'publishEvent').filter((port) => port.outcome === 'throw' || port.outcome === 'reject').map((port) => port.answeredAt)),
  },
  'failed-mutation-timing': {
    source: 'O0c review, plant timing-callback-dropped: onMutationTiming for a mutation that failed (reached only by the awaiting shapes)',
    find: (view) => firstIndex(portsNamed(view, (name) => name === 'onMutationTiming').filter((port) => port.event.p.args?.[0]?.failed === true).map((port) => port.start)),
  },
  'fake-timers-case': {
    source: 'O0c review 3, B1: a case recorded under the test runner\'s fake timers (no package test uses them)',
    find: (view) => ((view.record.notes ?? []).includes('fake-timers') && view.events.length ? 0 : -1),
  },
  'publication-beside-launch': {
    source: 'O0d: an independence-table move that renumbers ports needs a publication next to a launch, which no recording has',
    // Adjacent units as the comparer forms them (a port call with its synchronous answer is one unit, every other event one).
    find: (view) => {
      const units = unitsOf(view.events).map((unit) => view.events[unit.start]);
      for (let index = 1; index < units.length; index += 1) {
        const [a, b] = [units[index - 1], units[index]];
        if ((isLaunch(a) && b.kind === 'port' && b.head.name === 'publishEvent') || (a.kind === 'port' && a.head.name === 'publishEvent' && isLaunch(b))) return b.index;
      }
      return -1;
    },
  },
  'restart-with-operator-stop': {
    source: 'design §4.5 crash point "with an operatorStop pending": a construction that loads a task whose operator stop is pending',
    find: (view) => firstIndex(loads(view).map((load) => (tasksOf(load.state).some((task) => task.operatorStop?.state === 'pending') ? load.index : -1))),
  },
  'restart-during-runtime-restart': {
    source: 'design §4.5 crash point "during withRuntimeRestart after replacementStarted": a later construction after one whose withRuntimeRestart never settled',
    find: (view) => firstIndex(view.calls.filter((call) => call.member === 'withRuntimeRestart' && !Number.isFinite(call.end)).map((call) => {
      const later = view.events.find((event) => event.c > call.event.c && event.kind === 'call' && event.head.call === 0);
      return later ? later.index : -1;
    })),
  },
});

/**
 * The items one case shows, each `kind:name` with `{ at, call }`: `at` the
 * index that judges it (for a member or a control method the first result the
 * scheduler gave one of its calls, Infinity when none came in the case; for
 * every other item its first event), `call` the index of its first event.
 */
export function caseItems(view) {
  const found = new Map();
  const note = (kind, name, at, call = at) => {
    const key = `${kind}:${name}`;
    const entry = found.get(key);
    if (!entry) { found.set(key, { at, call }); return; }
    if (at < entry.at) entry.at = at;
    if (call < entry.call) entry.call = call;
  };
  for (const event of view.events) {
    const { head } = event;
    note('input', `${event.dir} ${event.kind}`, event.index);
    // A busy input ends the compared prefix by definition: it is counted (info.busy), never an item.
    if (isArrivedEvent(event.raw) && typeof event.raw.place === 'string' && event.raw.place !== 'busy') note('place', event.raw.place, event.index);
    if (event.kind === 'port' && typeof head.name === 'string' && !/#\d+\./.test(head.name) && !/#\d+$/.test(head.name)) note('port', head.name, event.index);
    if (event.kind === 'read' && head.object === 'options' && head.op === undefined && typeof head.key === 'string' && !head.supplied && event.p.value !== undefined && event.p.value !== null) note('option', head.key, event.index);
  }
  // A call is judged by what the scheduler answered it with (its return, throw or settlement), not by the call.
  for (const call of view.calls) if (call.event.head.call > 0) note('member', call.member, call.end, call.start);
  for (const call of view.controls) note('control', call.method, call.end, call.start);
  for (const [name, situation] of Object.entries(LAUNCH_SITUATIONS)) { const index = situation.find(view); if (Number.isFinite(index) && index >= 0) note('launch', name, index); }
  for (const [name, gap] of Object.entries(GAPS)) { const index = gap.find(view); if (Number.isFinite(index) && index >= 0) note('gap', name, index); }
  return found;
}

/** The inputs a call may read between its call and its answer and still be answered with nothing of its work between. */
const BARE_READS = new Set(['read', 'clock', 'env']);
/**
 * How the answer of one call shows its work: `refusal` (a throw or a rejection), `bare` (nothing of the call's
 * construction between the call and its answer but what it read, other inputs of its group and promise returns),
 * or `deep` (a port call, a timer, an abort, a draw, another answer or settlement lies between).
 */
export function answerKind(view, call) {
  if (call.outcome === 'throw' || call.outcome === 'reject') return 'refusal';
  for (let index = call.start + 1; index < call.end; index += 1) {
    const event = view.events[index];
    if (event.c !== call.event.c || BARE_READS.has(event.kind)) continue;
    if (event.dir === 'in' && ['call', 'control', 'callback', 'step'].includes(event.kind)) continue;
    if (event.kind === 'return' && (event.head.promise || event.head.call === call.event.head.call)) continue;
    return 'deep';
  }
  return 'bare';
}
/** A bare answer's value as one comparable text (a value that cannot be written is its own). */
const valueKey = (value, index) => { try { return JSON.stringify(value, (key, item) => (item === undefined ? '$undefined' : item)) ?? '$undefined'; } catch { return `$unwritable ${index}`; } };

// ------------------------------------------------------------------ the contract

/** Reads and checks a contract file (`checkContract`). Returns `{ contract, problems }`. */
export function loadContract(file) {
  let contract = null;
  try { contract = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { return { contract: null, problems: [`${file}: ${error.message}`] }; }
  const problems = checkContract(contract, path.basename(file));
  if (contract && typeof contract.target === 'string') contract.targetFile = path.resolve(path.dirname(file), contract.target);
  return { contract, problems };
}

/**
 * Checks a parsed contract: its version, a target spec, every item list (and
 * `data`, the members of option objects that are data, never called) a list of
 * distinct names. Returns the problems.
 */
export function checkContract(contract, label = 'census.json') {
  const problems = [];
  if (contract?.version !== CENSUS_VERSION) problems.push(`${label}: version ${JSON.stringify(contract?.version)}, this census reads ${CENSUS_VERSION}`);
  if (typeof contract?.target !== 'string') problems.push(`${label}: no target spec`);
  for (const list of [...Object.values(LISTS), 'data']) {
    const names = contract?.[list];
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name)) { problems.push(`${label}: ${list} must be a list of names`); continue; }
    if (new Set(names).size !== names.length) problems.push(`${label}: ${list} names an item twice`);
  }
  return problems;
}

/** Reads a waiver file: `{ version, waivers: [{ kind, name, class, needs, reason }] }`. Returns `{ waivers, problems }`. */
export function loadWaivers(file) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { return { waivers: [], problems: [`${file}: ${error.message}`] }; }
  return checkWaivers(parsed);
}

/** Checks parsed waivers: each with a kind of KINDS, a name, a class of WAIVER_CLASSES, a need that class allows and a reason, none twice. */
export function checkWaivers(parsed) {
  const problems = [];
  if (parsed?.version !== CENSUS_VERSION || !Array.isArray(parsed?.waivers)) return { waivers: [], problems: ['the waiver file must be { "version": 1, "waivers": [...] }'] };
  const seen = new Set();
  const waivers = [];
  for (const [index, waiver] of parsed.waivers.entries()) {
    const label = `waiver ${index}`;
    if (!waiver || typeof waiver !== 'object' || !KINDS.includes(waiver.kind) || typeof waiver.name !== 'string' || !waiver.name) { problems.push(`${label}: a kind of ${KINDS.join(', ')} and a name are required`); continue; }
    const key = `${waiver.kind}:${waiver.name}`;
    if (typeof waiver.reason !== 'string' || !waiver.reason.trim()) { problems.push(`${label} (${key}): every waiver needs a reason`); continue; }
    const kind = WAIVER_CLASSES[waiver.class];
    if (!Object.hasOwn(WAIVER_CLASSES, waiver.class)) { problems.push(`${label} (${key}): a class of ${Object.keys(WAIVER_CLASSES).join(', ')} is required`); continue; }
    if (!kind.needs.includes(waiver.needs)) { problems.push(`${label} (${key}): class ${waiver.class} is closed by ${kind.needs.join(' or ')}, not ${JSON.stringify(waiver.needs)}`); continue; }
    if (waiver.class === 'call-only' && !ANSWERED.has(waiver.kind)) { problems.push(`${label} (${key}): only a member or a control method can be call-only`); continue; }
    if (waiver.class === 'shallow' && !ANSWERED.has(waiver.kind)) { problems.push(`${label} (${key}): only a member or a control method can be shallow`); continue; }
    if (seen.has(key)) { problems.push(`${label}: ${key} is waived twice`); continue; }
    seen.add(key);
    waivers.push({ ...waiver, key });
  }
  return { waivers, problems };
}

/** The scheduler's public members: the keys of one instance built with the smallest options it accepts. */
export async function moduleMembers(target) {
  const module = await import(pathToFileURL(target.module).href);
  const instance = module[target.export]({ executor: { start() {} } });
  return Object.keys(instance).sort();
}

/** A task the probe of the control object submits (the fields a scheduler's submit validates). */
const PROBE_TASK = Object.freeze({ idempotencyKey: 'census-probe', rootSessionId: 'ses_census_probe', parentTaskId: null, directory: '/census-probe', mode: 'orchestrator', providerId: 'census', modelId: 'probe', agent: 'explorer', variant: null, label: 'census probe', prompt: 'Probe the control object.', timeoutAt: null });
/** How many macrotask turns the probe waits for the executor's first launch (no clock: turns, not time). */
const PROBE_TURNS = 100;

/**
 * The methods of the control object the scheduler hands its executor: the
 * keys of the one an instance hands its first launch. The instance is built
 * with timers that never fire and a persistence in memory, submits one task,
 * and is left unreferenced (nothing it holds keeps the process alive). Null
 * when no launch came within PROBE_TURNS turns.
 */
export async function controlMembers(target) {
  const module = await import(pathToFileURL(target.module).href);
  let control = null;
  const instance = module[target.export]({
    executor: { start(task, handed) { control ??= handed; return new Promise(() => {}); } },
    persistence: { async load() { return null; }, async save() {} },
    logger: { warn() {}, error() {} },
    now: () => EPOCH, scheduleTimeout: () => ({}), cancelTimeout: () => {},
  });
  try { await instance.initialize?.(); await Promise.race([instance.submit(PROBE_TASK), Promise.resolve()]); } catch { /* a refusal shows as no control object */ }
  for (let turn = 0; turn < PROBE_TURNS && !control; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
  return control && typeof control === 'object' ? Object.keys(control).sort() : null;
}

/** The options the target module's source reads (`options.<key>` and `options?.<key>`), sorted. */
export function optionSurface(target) {
  const source = readFileSync(target.module, 'utf8');
  return [...new Set([...source.matchAll(/\boptions\??\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]))].sort();
}

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const MEMBER_KEY = '[A-Za-z_][\\w$]*';
const literal = (text) => text.replace(/[$.?]/g, (char) => `\\${char}`);
/** Source without its comments (a block comment, or a line comment not inside a URL or a string's first characters). */
export const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((line) => line.replace(/(^|[^:\\'"`])\/\/.*$/, '$1')).join('\n');

/**
 * The ports a source uses (design §4.6's port surface), read from the source:
 * - an option object (an option bound by `const <alias> = options.<key>…`)
 *   contributes `<key>.<member>` for every member the source names on it, and
 *   for every member it reaches by a computed name the census can resolve (a
 *   function `const f = (name, …)` that indexes it, called with string
 *   literals; an array of string literals iterated with that name); one it
 *   cannot resolve is listed in `unresolved`;
 * - a function option contributes `<key>` when the source calls it (directly,
 *   or through its alias) or checks it is a function.
 * `inputs` are the options the recorder serves as inputs of its own (the
 * clock, the timers, the identifier factories): never ports. Returns
 * `{ members: [{ name, called }], functions, unresolved }`; `called` is true
 * when the source calls the member or checks it is a function (a member that
 * is data must never be).
 */
export function scanPorts(source, { options, inputs = [] }) {
  const code = stripComments(source);
  const aliases = new Map(options.map((option) => [`options.${option}`, option]));
  for (const match of code.matchAll(new RegExp(`\\bconst (${IDENTIFIER}) = (?:typeof )?options\\??\\.(${IDENTIFIER})\\b`, 'g'))) if (options.includes(match[2])) aliases.set(match[1], match[2]);
  const lineOf = (index) => code.slice(0, index).split('\n').length;
  const members = new Map();
  const unresolved = [];
  for (const [alias, option] of aliases) {
    if (inputs.includes(option)) continue;
    const name = literal(alias).replace('options\\.', 'options\\??\\.');
    const add = (key, called) => { const entry = members.get(`${option}.${key}`) ?? { name: `${option}.${key}`, option, called: false }; entry.called ||= called; members.set(entry.name, entry); };
    for (const match of code.matchAll(new RegExp(`(?<![\\w$.'"\`/])${name}\\??\\.(${MEMBER_KEY})`, 'g'))) {
      const after = code.slice(match.index + match[0].length);
      const before = code.slice(Math.max(0, match.index - 7), match.index);
      add(match[1], /^\s*(?:\?\.)?\(/.test(after) || (/typeof\s$/.test(before) && /^\s*[!=]==?\s*'function'/.test(after)));
    }
    for (const match of code.matchAll(new RegExp(`(?<![\\w$.'"\`/])${name}(?:\\?\\.)?\\[(${IDENTIFIER})\\]`, 'g'))) {
      const window = code.slice(Math.max(0, match.index - 600), match.index);
      const index = literal(match[1]);
      const hook = [...window.matchAll(new RegExp(`const (${IDENTIFIER}) = (?:async )?\\(${index}\\b`, 'g'))].at(-1);
      let keys = hook ? [...code.matchAll(new RegExp(`\\b${literal(hook[1])}\\('(${MEMBER_KEY})'`, 'g'))].map((found) => found[1]) : [];
      if (!keys.length) {
        const list = [...window.matchAll(new RegExp(`\\[((?:\\s*'${MEMBER_KEY}'\\s*,?)+)\\]\\s*\\.\\s*(?:every|some|map|forEach|filter|find)\\(\\s*\\(?\\s*${index}\\b`, 'g'))].at(-1);
        keys = list ? [...list[1].matchAll(/'([^']+)'/g)].map((found) => found[1]) : [];
      }
      if (!keys.length) unresolved.push(`${alias}[${match[1]}] at line ${lineOf(match.index)}`);
      for (const key of keys) add(key, true);
    }
  }
  const objects = new Set([...members.values()].map((entry) => entry.option));
  const functions = options.filter((option) => {
    if (inputs.includes(option) || objects.has(option)) return false;
    const key = literal(option);
    if (new RegExp(`\\boptions\\??\\.${key}\\s*(?:\\?\\.)?\\(|typeof options\\??\\.${key}\\s*[!=]==?\\s*'function'`).test(code)) return true;
    return [...aliases].some(([alias, of]) => of === option && !alias.startsWith('options.') && new RegExp(`(?<![\\w$.'"\`])${literal(alias)}\\s*(?:\\?\\.)?\\(`).test(code));
  });
  return { members: [...members.values()].map(({ name, called }) => ({ name, called })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), functions: functions.sort(), unresolved };
}

/** The recorder's source (the event kinds it writes, the options it serves as its own inputs). */
const recorderSource = () => readFileSync(path.join(HARNESS_DIR, 'recorder.mjs'), 'utf8');
/** The event kinds the recorder writes (`in <kind>`, `out <kind>`): every `input(inst, '<kind>'` and `output(inst, '<kind>'` of its source. */
export const recordedKinds = (source = recorderSource()) => [...new Set([...source.matchAll(/\b(input|output)\(inst, '([a-z.]+)'/g)].map((match) => `${match[1] === 'input' ? 'in' : 'out'} ${match[2]}`))].sort();
/** The options the recorder serves as clock, timer or identifier inputs of its own (`supplied.set('<key>', ownWrapper|timers…)`), and the target's served identifier factories. */
export const recorderInputs = (target, source = recorderSource()) => [...new Set([...[...source.matchAll(/supplied\.set\('([A-Za-z_$][\w$]*)', (?:ownWrapper|timers\.)/g)].map((match) => match[1]), ...Object.keys(target.defaults ?? {})])].sort();

/**
 * What a contract is checked against, all from the product and the harness,
 * never from the contract: the members of an instance, the methods of the
 * control object it hands its executor, the options and ports its source
 * reads, the event kinds the recorder writes and the placement marks of the
 * trace format that can lie inside a compared prefix (every mark but busy).
 */
export async function productSurface(contract) {
  const target = loadTarget(contract.targetFile);
  const options = optionSurface(target);
  const ports = scanPorts(readFileSync(target.module, 'utf8'), { options, inputs: recorderInputs(target) });
  return { members: await moduleMembers(target), control: await controlMembers(target), options, ports, inputs: recordedKinds(), places: PLACES.filter((place) => place !== 'busy') };
}

// ------------------------------------------------------------------ the census

const sameSet = (a, b) => a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);
const difference = (a, b) => a.filter((item) => !b.includes(item));

/** A failure detail for a contract list against what the product has. */
const drift = (what, found, listed) => `${what}: not listed ${difference(found, listed).join(', ') || 'none'}; listed but not there ${difference(listed, found).join(', ') || 'none'}`;

/** The contract against the product surface (`productSurface`): each list against what the product and the harness have. */
function checkSurface(contract, surface, fail) {
  if (!sameSet(contract.members, surface.members)) fail('contract-members', '(members)', drift(`an instance has ${surface.members.length} members, the contract lists ${contract.members.length}`, surface.members, contract.members));
  if (!surface.control) fail('contract-control', '(control)', 'the probe built an instance and submitted a task, but no launch handed a control object within its turns: the control methods could not be listed');
  else if (!sameSet(contract.control, surface.control)) fail('contract-control', '(control)', drift(`the control object has ${surface.control.length} methods, the contract lists ${contract.control.length}`, surface.control, contract.control));
  if (!sameSet(contract.options, surface.options)) fail('contract-options', '(options)', drift(`the source reads ${surface.options.length} options, the contract lists ${contract.options.length}`, surface.options, contract.options));
  const scanned = [...surface.ports.members.map((member) => member.name), ...surface.ports.functions];
  const listed = [...contract.ports, ...contract.data];
  if (!sameSet(listed, scanned)) fail('contract-ports', '(ports)', drift(`the source uses ${scanned.length} option members and function options, the contract lists ${contract.ports.length} ports and ${contract.data.length} data members`, scanned, listed));
  for (const member of surface.ports.members) if (member.called && contract.data.includes(member.name)) fail('contract-ports', member.name, `the contract lists ${member.name} as data, but the source calls it or checks it is a function: it is a port`);
  for (const name of contract.ports) if (contract.data.includes(name)) fail('contract-ports', name, `${name} is listed as a port and as data`);
  for (const site of surface.ports.unresolved) fail('contract-ports', site, `the source reaches a member of an option object by a computed name the census cannot resolve (${site}): its ports cannot be listed`);
  if (!sameSet(contract.inputs, surface.inputs)) fail('contract-inputs', '(inputs)', drift(`the recorder writes ${surface.inputs.length} event kinds, the contract lists ${contract.inputs.length}`, surface.inputs, contract.inputs));
  if (!sameSet(contract.places, surface.places)) fail('contract-places', '(places)', drift(`the trace format has ${surface.places.length} marks a compared prefix can hold, the contract lists ${contract.places.length}`, surface.places, contract.places));
}

/** The class the corpus gives an item that no case judges, or that is shallow (WAIVER_CLASSES). */
const classOf = (item) => (item.shallow ? 'shallow' : item.cases === 0 ? 'unreached' : item.callOnly > 0 ? 'call-only' : item.pastBusy > 0 ? 'past-busy' : 'uncompared');
/** Whether a part of the corpus already refutes a waiver's class (each refutation holds on the whole corpus too). */
const refutes = (stated, item) => (stated === 'unreached' ? item.cases > 0 : stated === 'past-busy' || stated === 'uncompared' ? item.callOnly > 0 || (stated === 'uncompared' && item.pastBusy > 0) : false);

/**
 * The census of a corpus (pure but for reading container files). `containers`
 * are `{ source, file }` or `{ source, name, text, read? }` (`read` a read
 * container: `{ header, cases, resolve }`, used in place of parsing `text`);
 * `results` maps a case id to the closure's `{ outcome, verdict }` (null:
 * none given, inconclusive); `expected` lists `{ source, testFile, cases? }`,
 * the whole corpus (null: none, inconclusive); `manifests` maps each source of
 * `expected` to its manifest text, written when it was recorded (a source
 * without one is inconclusive); `surface` is `productSurface`'s answer;
 * `baseline` the waivers that may exist (`kind:name`). Returns `{ code,
 * failures, problems, items, varies, info, cases, complete }`.
 */
export function runCensus({ contract, waivers = [], waiverProblems = [], containers, results = null, expected = null, manifests = new Map(), surface, baseline = WAIVER_BASELINE, closureCode = EXIT.pass }) {
  const failures = [];
  const problems = [];
  const fail = (check, name, detail) => failures.push({ check, name, detail });
  const inconclusive = (check, detail) => problems.push({ check, detail });
  const items = new Map(); // `kind:name` -> { kind, name, cases, judged, callOnly, pastBusy, uncompared, recorded, example, answers?, shallow? }
  for (const kind of KINDS) for (const name of contract[LISTS[kind]]) items.set(`${kind}:${name}`, { kind, name, cases: 0, judged: 0, callOnly: 0, pastBusy: 0, uncompared: 0, recorded: 0, example: null, ...(ANSWERED.has(kind) ? { answers: { refusal: 0, bare: 0, deep: 0 }, shallow: false } : {}) });
  const bareValues = new Map(); // `kind:name` -> the texts of its bare answers
  const unknown = new Map(); // `kind:name` -> cases
  const varies = { cases: 0, compared: 0, whole: 0, keys: {} };
  const info = { notes: {}, busy: 0, statuses: {}, transitions: {}, errors: {}, outcomes: {} };
  const seenIds = new Set();
  const seenFiles = new Map(); // `${source}|${testFile}` -> case names
  const bySource = new Map(); // source -> [{ name, text }]
  const unreadable = []; // containers that cannot be read: damage, whatever the manifest says
  let recordedCases = 0;
  let judgedCases = 0;

  // The contract against the product.
  if (surface) checkSurface(contract, surface, fail);
  else inconclusive('no-surface', 'the census was given no product surface: the contract is not checked against the scheduler');
  // A toy's contract (`partial: true`) names only the situations and gaps its toy can show; the scheduler's names every one.
  for (const [list, table] of [['launch', LAUNCH_SITUATIONS], ['gaps', GAPS]]) {
    const named = contract[list];
    const coded = Object.keys(table);
    for (const name of difference(named, coded)) fail('contract-predicates', name, `the contract's ${list} names ${name}, which has no predicate`);
    if (contract.partial !== true) for (const name of difference(coded, named)) fail('contract-predicates', name, `${name} has a predicate the contract's ${list} does not name`);
  }

  // Every case.
  for (const container of containers) {
    const text = container.text ?? (container.file ? readFileSync(container.file, 'utf8') : undefined);
    if (!bySource.has(container.source)) bySource.set(container.source, []);
    bySource.get(container.source).push({ name: container.name ?? (container.file ? path.basename(container.file) : null), text });
    let read = container.read;
    if (!read) {
      try { read = readContainer(text); } catch (thrown) { unreadable.push(`${container.source} ${container.name ?? container.file}: ${thrown.message}`); continue; }
    }
    const fileKey = `${container.source}|${read.header.testFile}`;
    if (!seenFiles.has(fileKey)) seenFiles.set(fileKey, new Set());
    for (const record of read.cases) {
      seenFiles.get(fileKey).add(record.name);
      info.outcomes[record.outcome] = (info.outcomes[record.outcome] ?? 0) + 1;
      if (seenIds.has(record.id)) fail('census-results', record.id, `${record.id} is in the corpus twice`);
      seenIds.add(record.id);
      if (record.outcome !== 'recorded') continue;
      recordedCases += 1;
      for (const name of record.notes ?? []) info.notes[name] = (info.notes[name] ?? 0) + 1;
      const result = results ? results.get(record.id) : null;
      if (results && !result) fail('census-results', record.id, `${record.id} has no closure verdict`);
      const view = caseView(record, read.resolve);
      const { limit } = view;
      if (limit < view.events.length) info.busy += 1;
      const replayed = results ? Boolean(result) && ['reproduced', 'partial'].includes(result.outcome) && result.verdict === 'pass' : true;
      if (result && result.outcome === 'reproduced' && limit < view.events.length) fail('census-results', record.id, `${record.id} is reproduced by the closure but its compared prefix ends at ${limit} of ${view.events.length} events`);
      const judged = replayed && limit > 0;
      if (judged) judgedCases += 1;
      for (const [key, { at, call }] of caseItems(view)) {
        const item = items.get(key);
        if (!item) {
          const [kind] = key.split(':');
          if (kind !== 'launch' && kind !== 'gap') unknown.set(key, (unknown.get(key) ?? 0) + 1);
          continue;
        }
        item.cases += 1;
        if (judged && at < limit) { item.judged += 1; item.example ??= record.id; } else if (judged && call < limit) item.callOnly += 1;
        else if (judged) { item.pastBusy += 1; item.recorded += 1; } else { item.uncompared += 1; item.recorded += 1; }
      }
      // Every compared answer of a member or a control method, by how it shows the call's work.
      if (judged) {
        for (const [kind, list, field] of [['member', view.calls.filter((entry) => entry.event.head.call > 0), 'member'], ['control', view.controls, 'method']]) {
          for (const entry of list) {
            const key = `${kind}:${entry[field]}`;
            const item = items.get(key);
            if (!item || !(entry.end < limit)) continue;
            const how = answerKind(view, entry);
            item.answers[how] += 1;
            if (how === 'bare') { if (!bareValues.has(key)) bareValues.set(key, new Set()); bareValues.get(key).add(valueKey(entry.value, entry.end)); }
          }
        }
      }
      // OD2: a compared prefix that reads one key with two values.
      if (judged) {
        varies.compared += 1;
        const table = readTable(view.events.slice(0, limit));
        if (table.varies.size) varies.cases += 1;
        for (const key of new Set([...table.varies].map((entry) => entry.split('|').slice(1).join('|')))) varies.keys[key] = (varies.keys[key] ?? 0) + 1;
        if (readTable(view.events).varies.size) varies.whole += 1;
      }
      // Information: statuses and transitions in saved states, error codes.
      const last = new Map();
      for (const port of view.ports) {
        if (port.name !== 'persistence.save') continue;
        for (const task of tasksOf(port.event.p.args?.[0])) {
          if (typeof task.status !== 'string') continue;
          info.statuses[task.status] = (info.statuses[task.status] ?? 0) + 1;
          const before = last.get(`${port.event.c}:${task.taskId}`);
          if (before && before !== task.status) info.transitions[`${before}->${task.status}`] = (info.transitions[`${before}->${task.status}`] ?? 0) + 1;
          last.set(`${port.event.c}:${task.taskId}`, task.status);
        }
      }
      for (const call of view.calls) { const code = errorCode(call.value); if (code && (call.outcome === 'reject' || call.outcome === 'throw')) info.errors[code] = (info.errors[code] ?? 0) + 1; }
    }
  }
  if (results) for (const id of results.keys()) if (!seenIds.has(id)) fail('census-results', id, `the closure judged ${id}, which no container holds`);

  // The recordings against the contract.
  for (const [key, count] of unknown) fail('contract-unknown', key, `${count} case(s) show ${key.replace(':', ' ')}, which the contract does not list`);

  // Completeness.
  if (recordedCases === 0) inconclusive('empty-corpus', `no case recorded a scheduler (${seenIds.size} cases in ${seenFiles.size} containers)`);
  if (!results) inconclusive('unreplayed', 'no closure verdicts were given: judged here means inside a compared prefix by the marks alone');
  const missing = [];
  if (!expected) missing.push('no whole corpus was named');
  else {
    for (const entry of expected) {
      const names = seenFiles.get(`${entry.source}|${entry.testFile}`);
      if (!names) { missing.push(`${entry.source} ${entry.testFile}`); continue; }
      for (const name of entry.cases ?? []) if (!names.has(name)) missing.push(`${entry.source} ${entry.testFile} case ${name}`);
    }
  }
  if (missing.length) inconclusive('corpus-incomplete', `${missing.length} part(s) of the whole corpus missing: ${missing.slice(0, 6).join('; ')}${missing.length > 6 ? '; …' : ''}`);
  // Each source of the whole corpus that is here (a container or a manifest; one with neither is missing above): its containers are exactly the ones its recording wrote.
  const damaged = [...unreadable];
  if (expected) for (const source of [...new Set(expected.map((entry) => entry.source))].sort()) if (bySource.has(source) || manifests.has(source)) damaged.push(...checkManifest(manifests.get(source) ?? null, source, bySource.get(source) ?? []));
  if (damaged.length) inconclusive('corpus-manifest', `${damaged.length} problem(s) with the containers against their recording's manifest: ${damaged.slice(0, 6).join('; ')}${damaged.length > 6 ? '; …' : ''}`);
  const complete = missing.length === 0 && damaged.length === 0 && recordedCases > 0;

  // Shallow: judged, but every compared answer a refusal or one bare value.
  for (const [key, item] of items) if (item.answers) item.shallow = item.judged > 0 && item.answers.deep === 0 && (bareValues.get(key)?.size ?? 0) <= 1;

  // Waivers.
  for (const problem of waiverProblems) fail('waiver-invalid', '(waivers)', problem);
  const waived = new Map(waivers.map((waiver) => [waiver.key, waiver]));
  for (const waiver of waivers) {
    const item = items.get(waiver.key);
    if (baseline && !baseline.includes(waiver.key)) fail('waiver-new', waiver.key, `${waiver.key} is waived but not in the baseline: the waiver list only shrinks; give the item a judged case instead`);
    if (!item) { fail('waiver-unknown', waiver.key, `${waiver.key} is waived, but the contract lists no such ${waiver.kind}: remove the waiver`); continue; }
    if (item.judged > 0 && !item.shallow) { fail('waiver-exercised', waiver.key, `${waiver.key} is waived ("${waiver.reason}") but ${item.judged} judged case(s) exercise it (first ${item.example}): remove the waiver`); continue; }
    const counts = `${item.cases} case(s), ${item.callOnly} call-only, ${item.pastBusy} past a busy input, ${item.uncompared} uncompared`;
    if (complete ? classOf(item) !== waiver.class : refutes(waiver.class, item)) fail('waiver-class', waiver.key, `${waiver.key} is waived as ${waiver.class} (${WAIVER_CLASSES[waiver.class]?.means}), but the corpus shows ${counts}${complete ? `: it is ${classOf(item)}` : ''}`);
  }
  // Items with no judged case, and shallow ones: failures on the whole corpus only.
  const unjudged = [...items.values()].filter((item) => (item.judged === 0 || item.shallow) && !waived.has(`${item.kind}:${item.name}`));
  if (complete) {
    for (const item of unjudged) {
      if (item.shallow) fail('census-shallow', `${item.kind}:${item.name}`, `${item.kind} ${item.name} is shallow: its ${item.judged} judged case(s) answer only ${item.answers.refusal} refusal(s) and ${item.answers.bare} bare answer(s) of one value, nothing that shows its work, and it has no waiver`);
      else fail(`census-${item.kind}`, `${item.kind}:${item.name}`, `${item.kind} ${item.name} has no judged case (${item.cases} case(s) show it: ${item.callOnly} call-only, ${item.pastBusy} past a busy input, ${item.uncompared} uncompared; class ${classOf(item)}) and no waiver`);
    }
  }

  if (closureCode === EXIT.fail) fail('closure', '(closure)', 'the closure check failed: see its problems');
  else if (closureCode !== EXIT.pass) inconclusive('closure-inconclusive', `the closure check exited ${closureCode}`);
  const code = failures.length ? EXIT.fail : problems.length ? EXIT.inconclusive : EXIT.pass;
  return { code, failures, problems, items: [...items.values()], unjudged: unjudged.map((item) => `${item.kind}:${item.name}`), varies, info, complete, cases: { all: seenIds.size, recorded: recordedCases, judged: judgedCases } };
}

/**
 * The census as printed lines: per kind its items, then the counts, the
 * problems and the last line, which holds every count and the verdict. With
 * `plants` (`{ copies, replayer, problems }`) the last line also holds the
 * plants', and the verdict and `code` are the command's (census and plants).
 */
export function censusLines(report, { waivers = [], plants = null, code = report.code } = {}) {
  const lines = [];
  const waived = new Map(waivers.map((waiver) => [waiver.key, waiver]));
  for (const kind of KINDS) {
    const list = report.items.filter((item) => item.kind === kind);
    const judged = list.filter((item) => item.judged > 0 && !item.shallow).length;
    const shallow = list.filter((item) => item.shallow).length;
    const callOnly = list.filter((item) => item.judged === 0 && item.callOnly > 0).length;
    lines.push(`${kind} (${judged} of ${list.length} judged${ANSWERED.has(kind) ? `, ${shallow} shallow, ${callOnly} call-only` : ''}):`);
    for (const item of list) {
      const waiver = waived.get(`${item.kind}:${item.name}`);
      const answers = item.answers ? `; answers ${item.answers.deep} deep, ${item.answers.bare} bare, ${item.answers.refusal} refusals` : '';
      const verdict = item.judged && !item.shallow ? '' : waiver ? ` (waived ${waiver.class}, needs ${waiver.needs}: ${waiver.reason})` : item.shallow ? ' (SHALLOW)' : ' (NOT JUDGED)';
      lines.push(`  ${item.name}: ${item.cases} cases, ${item.judged} judged, ${ANSWERED.has(kind) ? `${item.callOnly} call-only, ` : ''}${item.pastBusy} past busy, ${item.uncompared} uncompared${answers}${verdict}`);
    }
  }
  lines.push(`option-varies: ${report.varies.cases} of ${report.varies.compared} judged cases read a key with two values in their compared prefix (${report.varies.whole} counting events past a busy input)${Object.keys(report.varies.keys).length ? `; by key ${JSON.stringify(report.varies.keys)}` : ''}`);
  lines.push(`busy mark: ${report.info.busy} cases compared only up to a busy input; notes ${JSON.stringify(report.info.notes)}`);
  lines.push(`statuses saved ${JSON.stringify(report.info.statuses)}; transitions ${JSON.stringify(report.info.transitions)}`);
  lines.push(`error codes ${JSON.stringify(report.info.errors)}`);
  for (const failure of report.failures) lines.push(`FAILED (${failure.check}) ${failure.name}: ${failure.detail}`);
  for (const problem of report.problems) lines.push(`inconclusive (${problem.check}): ${problem.detail}`);
  const judgedItems = report.items.filter((item) => item.judged > 0 && !item.shallow).length;
  const shallowItems = report.items.filter((item) => item.shallow).length;
  const callOnly = report.items.filter((item) => item.judged === 0 && item.callOnly > 0).length;
  const verdict = code === EXIT.pass ? 'complete' : code === EXIT.fail ? 'FAILED' : 'INCONCLUSIVE';
  const planted = !plants ? '' : plants.notRun ? '; plants not run' : `; plants: ${plants.copies} planted copies, ${plants.replayer} planted replayer bugs, ${plants.problems} problems`;
  lines.push(`scheduler census ${verdict}: ${report.cases.all} cases, ${report.cases.recorded} recorded, ${report.cases.judged} judged; items ${judgedItems} of ${report.items.length} judged, ${shallowItems} shallow, ${callOnly} call-only, ${waivers.length} waived, ${report.unjudged.length} unjudged without a waiver; option-varies ${report.varies.cases}; ${report.failures.length} failures, ${report.problems.length} inconclusive${planted}; exit ${code}`);
  return lines;
}

// ------------------------------------------------------------------ the command

const USAGE = 'usage: census.mjs [--sample] [--plants] [--sources=tests,package,scenarios] [--tests=<file,...>] [--containers=<source>=<dir>,...] [--workers=N] [--json=<file>] [--keep-artifacts]';

/** The whole corpus: every source's every file, and every scenario case of the corpus. */
export async function wholeCorpus() {
  const { packageTestFiles } = await import('./closure.mjs');
  const { schedulerTestFiles } = await import('./record.mjs');
  const { corpusTests } = await import('./scenarios.mjs');
  const rel = (file) => `packages/orchestration-runtime/${file.replace(/^\.\//, '')}`;
  return [
    ...schedulerTestFiles().map((file) => ({ source: 'tests', testFile: rel(file) })),
    ...packageTestFiles().map((file) => ({ source: 'package', testFile: rel(file) })),
    { source: 'scenarios', testFile: 'scripts/scheduler-conformance/scenarios.corpus.mjs', cases: corpusTests().map((entry) => entry.name) },
  ];
}

/** The closure's verdicts as the census reads them: case id to `{ outcome, verdict }`. */
export const closureResults = (judged) => new Map(judged.cases.map((entry) => [entry.id, { outcome: entry.outcome, verdict: entry.compare?.verdict ?? null }]));

async function main(argv) {
  const { parseOptions } = await import('../client-conformance/record.mjs');
  const parsed = parseOptions(argv, { flags: ['keep-artifacts', 'sample', 'plants'], values: ['sources', 'tests', 'containers', 'workers', 'json'] });
  if (parsed.error || parsed.positionals.length) { console.error(`${parsed.error ?? 'no positional arguments'}\n${USAGE}`); return EXIT.usage; }
  const { options } = parsed;
  const closure = await import('./closure.mjs');
  const { createScratch } = await import('./record.mjs');
  const sources = options.sources ? options.sources.split(',') : options.sample ? ['tests', 'scenarios'] : [...closure.SOURCES];
  if (sources.some((source) => !closure.SOURCES.includes(source))) { console.error(`--sources: one of ${closure.SOURCES.join(', ')}\n${USAGE}`); return EXIT.usage; }
  const tests = options.tests ? options.tests.split(',') : options.sample ? [...closure.SAMPLE_TESTS] : null;
  const given = new Map();
  for (const item of options.containers ? options.containers.split(',') : []) {
    const [source, directory] = item.split('=');
    if (!closure.SOURCES.includes(source) || !directory || !existsSync(directory)) { console.error(`--containers: <source>=<existing dir>\n${USAGE}`); return EXIT.usage; }
    given.set(source, path.resolve(directory));
  }
  const workers = Number(options.workers ?? 4);
  if (!Number.isInteger(workers) || workers < 1) { console.error(`--workers must be a positive integer\n${USAGE}`); return EXIT.usage; }
  if (options.plants && !sources.includes('scenarios')) { console.error(`--plants needs the scenarios source\n${USAGE}`); return EXIT.usage; }
  const { contract, problems: contractProblems } = loadContract(CONTRACT_FILE);
  if (contractProblems.length) { for (const problem of contractProblems) console.log(`FAILED (contract-invalid): ${problem}`); return EXIT.fail; }
  const { waivers, problems: waiverProblems } = loadWaivers(WAIVER_FILE);
  const scratch = createScratch('scheduler-conformance-census');
  let status = 'failed';
  try {
    const started = Date.now();
    const { judged, containers, directories } = await closure.runClosure({ sources, given, names: tests ? { tests } : {}, workers, workDir: scratch.dir });
    for (const problem of judged.problems) console.log(`closure ${problem.kind === 'fail' ? 'FAILED' : 'inconclusive'} (${problem.check})${problem.source ? ` ${problem.source}` : ''}: ${problem.detail}`);
    console.log(`closure: ${closure.CASE_OUTCOMES.map((outcome) => `${judged.counts[outcome]} ${outcome}`).join(', ')}; exit ${judged.code}`);
    const report = runCensus({
      contract, waivers, waiverProblems, surface: await productSurface(contract), results: closureResults(judged), expected: await wholeCorpus(), closureCode: judged.code,
      manifests: new Map(Object.entries(directories).map(([source, directory]) => [source, readManifestText(directory)])),
      containers: Object.entries(containers).flatMap(([source, files]) => files.map((file) => ({ source, file }))),
    });
    const lines = censusLines(report, { waivers });
    for (const line of lines.slice(0, -1)) console.log(line);
    let code = report.code;
    // The planted copies and replayer bugs against the same recordings, only once the closure passed (as the closure tool does).
    let plants = null;
    if (options.plants && judged.code === EXIT.pass) {
      const run = await closure.runPlants({ scenarios: containers.scenarios[0], tests: [...(containers.tests ?? []), ...(containers.package ?? [])], workDir: scratch.dir, workers: options.workers ? workers : null });
      const found = closure.judgePlants(run, { lateOnReal: sources.includes('tests') });
      for (const line of found.lines) console.log(line);
      for (const problem of found.problems) console.log(`FAILED (plants): ${problem}`);
      plants = { copies: run.plants?.length ?? 0, replayer: run.replayer?.length ?? 0, problems: found.problems.length, list: found.problems };
      if (found.problems.length) code = EXIT.fail;
    } else if (options.plants) { console.log(`scheduler plants not run: the closure exited ${judged.code}`); plants = { notRun: true, list: [] }; }
    // The time before the last line: the last line holds every count and the one verdict (design §4.8).
    console.log(`(${Math.round((Date.now() - started) / 1000)} s)`);
    console.log(censusLines(report, { waivers, plants, code }).at(-1));
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code, closure: { code: judged.code, counts: judged.counts }, plants: plants && { problems: plants.list }, failures: report.failures, problems: report.problems, items: report.items, varies: report.varies, info: report.info, cases: report.cases, complete: report.complete }, null, 2)}\n`);
    status = code === EXIT.pass ? 'passed' : 'failed';
    return code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
