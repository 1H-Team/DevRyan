// The comparer of the scheduler conformance harness (design file 30 §4.4,
// §4.5, §5, package O0d). Pure: it takes the recorded events of one case (the
// reference) and the events a candidate produced against them (the replayer's
// `produced`, possibly cut at its first difference), and returns named
// findings. It never relaxes the replayer: exact equality with the recording
// stays the base rule, the replayer's own checks still decide `different`, and
// this file only names what differs and adds what exact equality cannot see.
//
// - RULES: the items of §4.4. The first difference of the two traces is
//   reported by the most specific rule (a save, a shard write, a log, a
//   mutation timing, an error, a time, an identifier, a returned value, a port
//   argument, else the event sequence). Two rules also hold on every output of
//   the candidate whether or not it equals the recording: `times` (every time
//   value is a `now` handed out at or before it, or a time an input carried,
//   plus a named constant of DELAYS; the report says which) and `identifiers`
//   (every identifier is a draw of its own named site, or one an input carried).
// - The only relaxations are the two named mechanisms, each reported on every
//   use: an independence table (pairs of lanes whose relative order the code
//   does not fix; within a lane order stays exact; it ships empty, see
//   INDEPENDENCE, and DESIGN_INDEPENDENCE holds the design's two cited entries)
//   and the read mode `reads: 'free'`
//   (OD2: for a candidate that is not the JavaScript scheduler, the count and
//   position of option reads are free where every read of that key in the case
//   returned one value; a case whose key changes value is `option-varies`,
//   inconclusive). The JavaScript closure runs with reads `exact`.
// - ORACLES, computed here from what crossed the ports, never from anything
//   the candidate says about itself: codec round trip of every save and shard
//   (reference codec), transitions between consecutive saved records
//   (reference `assertManagedTaskTransition`), the timer census, the
//   launch-latency oracle (§5: `launch_delayed`, `launch_advanced`) and
//   durability order. GLOBALS: the assertions of §5 on every case.
//
// Events here are `{ c, dir, kind, head, values, ledger }`: `head` the scalar
// fields the replayer compares (positions `at` and `seq` left out: the order
// of the list is the position), `values` the codec trees by field, `ledger`
// the recorded digest of a save (recorded events only). `fromRecorded` makes
// them from a container's case; the replayer makes the candidate's.
import { createHash } from 'node:crypto';
import { decodeLedgerSnapshot, encodeLedgerSnapshot } from '../../packages/orchestration-runtime/codec.js';
import { decodeManagedNativeJobProofShard, encodeManagedNativeJobProofShard } from '../../packages/orchestration-runtime/native-job-proof-store.js';
import { isManagedNativeJobTombstone } from '../../packages/orchestration-runtime/persistence.js';
import { assertManagedTaskTransition } from '../../packages/orchestration-runtime/transitions.js';
import { shape, shapeText, TAG } from './replay-values.mjs';
import { caseEvents } from './trace.mjs';

export const COMPARE_VERSION = 1;

/** The rules of §4.4, by the name a failure is reported under. */
export const RULES = Object.freeze({
  'event-sequence': 'every event at the recorded position in exact total order (kind, construction, member, port name, call, timer and port numbers); the independence table is the only relaxation',
  'port-arguments': 'every port call\'s arguments are codec-equal to the recording\'s (key order, undefined, aliasing); executor.start\'s task in full',
  'saved-state': 'every persistence.save comes where the recording has one, its state codec-equal and its bytes by the reference encodeLedgerSnapshot equal to the recording\'s digest (so the save count is exact: the sequence rule matches every event)',
  'shard-writes': 'every native job proof shard write or removal comes where the recording has one, its text byte-equal',
  times: 'every time value in an output is a now handed out at or before it, or a time an input carried, plus a named constant of the delay table (no window, no rank); the report says which it matched',
  identifiers: 'every identifier in an output is a draw of its named site (a hidden draw with its prefix) or one an input carried; draws follow each site\'s recorded order (each draw is an event the sequence rule compares, value included)',
  errors: 'every thrown or rejected error has the recording\'s class tag, name, code and message',
  'mutation-timing': 'onMutationTiming is called where the recording calls it, its failed flag and durations exact (nominal performance.now)',
  logs: 'every logger call comes where the recording has one, with the same message text and fields',
  'returned-values': 'every return and settlement value is codec-equal to the recording\'s',
  inputs: 'every input the candidate is given or asks for is the recording\'s (kind, site, key, value)',
  'option-reads': 'read mode free only: a read of a key the recording read once-valued is answered with that value; a key the recording never read cannot be answered (inconclusive)',
});

/** The independent oracles of §4.4 and the global assertions of §5. */
export const ORACLES = Object.freeze({
  'codec-round-trip': 'every saved state decodes with the reference decodeLedgerSnapshot and re-encodes to the same bytes; every shard text decodes and re-encodes to itself',
  transitions: 'for every task, each pair of consecutive saved records (the loaded record first) satisfies the reference assertManagedTaskTransition',
  'timer-census': 'every timer set is fired or cleared, or still pending at the end (reported); a settled shutdown leaves none live; at the first difference no timer the recording clears there is left live',
  'launch-latency': 'every launch of the compared part, judged independently of where the first event difference is, comes in the reference\'s step, at the reference\'s virtual time and at no greater event distance from the input that made it launchable, with no timer set before it that the reference did not set (launch_delayed, launch_advanced, launch_duplicated, launch_extra)',
  durability: 'no launch before a resolved save (or the loaded state) holds that task active (starting, or running for a recovery relaunch) with that lease token; no waiter resolves with a task state before a resolved save holds it',
  'waiting-capacity': 'no saved state holds a waitingReason of kind capacity or system_pressure',
  'waiting-prerequisites': 'a saved waitingReason of kind prerequisites appears only where the reference\'s save of the same number has it for that task',
  'admit-launch': 'no admitLaunch call unless the construction was given that hook',
  'active-count': 'at the end of each step the number of tasks starting or running in the latest save equals the reference\'s',
});
/**
 * The launch-latency oracle's findings (§5). Every launch of the compared part is judged, wherever the first event
 * difference is: in the candidate's compared events when it is there, else in its observed run past the first
 * difference (the replayer's ObserveHost: the recording's inputs delivered by identity, nothing compared), else unjudged
 * (info `launch-unjudged`, with the reason).
 */
export const LATENCY_FINDINGS = Object.freeze({
  launch_delayed: 'a launch later than the reference (a later step; in the same step a later virtual time; at the same time a longer event distance from the input that made it launchable, or more timers set between that input and the launch) or missing where the reference launches',
  launch_advanced: 'a launch earlier than the reference (an earlier step or time, a shorter distance, or one the reference makes only past the compared part, only after a restart, or never because its instance stopped at a crash point first): a change of dispatch timing that would need the owner\'s yes, not a defect',
  launch_duplicated: 'a launch of a task by a port the reference launches it through fewer times: a defect (design §2.2 place 17, a second launch of the same task)',
  launch_extra: 'a launch the reference never makes (no launch of that task through that port in that construction or a later one, and that construction was not stopped at a crash point): a defect',
});

/**
 * The independence table of the design (§4.4): pairs of lanes whose relative
 * order the code does not fix, each citing the scheduler lines that make the
 * two lanes independent. Adding one is a timing decision that needs the
 * owner's yes.
 */
export const DESIGN_INDEPENDENCE = Object.freeze([
  Object.freeze({
    lanes: Object.freeze(['publish', 'executor']),
    cite: 'scheduler.js:441-444 and :449-452 (publications chain on publicationTail, a promise chain of their own, never awaited by a launch) against :2087-2094 and :1760-1797 (launchTask runs in pump\'s finally inside the mutation lane); DOCUMENTATION.md "Durable mutations and event publication use separate serialized lanes"',
  }),
  Object.freeze({
    lanes: Object.freeze(['publish', 'timer.set']),
    cite: 'scheduler.js:441-444 (publicationTail) against the timer sites in the mutation lane (:571 stall watch, :2126 starting lease, :2142 deadline, :1956 admission retry): no timer delay reads publication state and no publication waits for a timer',
  }),
]);

/**
 * The table the comparer ships with: empty. The brief ships the design's
 * entries only if running code confirms them, and it does not (package O0d,
 * docs/TESTING.md): no recording varies the relative order of these lanes (the
 * recordings are byte-stable), a publication is never next to a launch in the
 * corpus, and a copy whose publication lane runs one or two microtasks later
 * moves its publications past the mutation lane's own clock and option reads,
 * which no entry covers (69 and 70 of 76 scenarios different with the entries
 * and without them alike; the entries used 0 times). DESIGN_INDEPENDENCE is
 * passed explicitly (`mode.independence`) where a test or an owner-approved
 * run wants it; every use is reported as `info`.
 */
export const INDEPENDENCE = Object.freeze([]);

/** The delay table of §2.1: the named constants a time may add to a handed-out now (scheduler.js, auto-resume-policy.js). */
export const DELAYS = Object.freeze({
  'admission retry default': 5_000,
  'admission retry min': 1_000,
  'admission retry max': 60_000,
  'prerequisites recheck': 1_000,
  'reconciliation retry': 1_000,
  'starting lease': 60_000,
  'native completion retry': 5_000,
  'run cleanup 1': 5_000,
  'run cleanup 2': 30_000,
  'run cleanup 3': 120_000,
  'run cleanup 4': 600_000,
  'auto-resume startup grace': 15_000,
  'auto-resume probe stagger': 60_000,
  'auto-resume re-arm': 1_000,
  'auto-resume catalog window': 90_000,
  'auto-resume backoff 1': 15 * 60_000,
  'auto-resume backoff 2': 30 * 60_000,
  'auto-resume backoff 3': 60 * 60_000,
  'auto-resume min delay': 5_000,
  'auto-resume reset jitter': 15_000,
  'auto-resume host retry': 60_000,
  'auto-resume max lineage': 6 * 60 * 60_000,
  'persistence stall': 300_000,
  'abort race': 5_000,
  'provider recovery continuation lease': 60_000,
  'implementation progress grace': 15 * 60_000,
  'implementation renew window': 10 * 60_000,
  'duplicate dispatch window': 10 * 60_000,
});

export const LAUNCH_PORTS = Object.freeze(['executor.start', 'executor.resume', 'executor.retryInPlace']);
const LAUNCH = new Set(LAUNCH_PORTS);
const WAITERS = new Set(['waitForTask', 'waitForAnyTask', 'waitForResultCommit', 'waitForResultAction', 'waitForDispatchBarrier']);
const HEAD_EXCLUDED = new Set(['at', 'seq', 'c', 'place', 'after', 'late', 'mutatedByReceiver', 'ledger']);
const SLOT = /^=[0-9a-f]{16}$/;
const isRef = (value) => value !== null && typeof value === 'object' && typeof value.slot === 'number';
/** Keys whose number is a point in time (a duration key ends in Ms and is not one). */
const TIME_KEY = /(?:At|^at|^since|^deadline|Deadline|Until|^due)$/;
/** Identifier keys and the draw sites (and hidden-draw prefixes) they come from. */
export const ID_SITES = Object.freeze({
  taskId: ['createTaskId'],
  priorTaskId: ['createTaskId'],
  followUpTaskId: ['createTaskId'],
  parentTaskId: ['createTaskId'],
  sourceTaskId: ['createTaskId'],
  leaseToken: ['createLeaseToken'],
  dispatchWaveId: ['createWaveId'],
  waveId: ['createWaveId'],
  ownerID: ['persistLocked'],
  requestId: ['cancelSingleTask', 'recordOperatorStop'],
});
const HIDDEN_PREFIX = Object.freeze({ persistLocked: 'dvr_save_', cancelSingleTask: 'stop_', recordOperatorStop: 'stop_' });
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

// ------------------------------------------------------------------ events

/** A recorded event as the comparer reads it: `resolve` turns a slot into its tree. */
export function compareEvent(event, resolve) {
  const head = {};
  const values = {};
  for (const [key, item] of Object.entries(event)) {
    if (HEAD_EXCLUDED.has(key)) continue;
    if (typeof item === 'string' && SLOT.test(item)) values[key] = resolve(item);
    else if (isRef(item)) values[key] = resolve(item);
    else head[key] = item;
  }
  return { c: event.c, dir: event.dir, kind: event.kind, head, values, ledger: typeof event.ledger === 'string' || (event.ledger && typeof event.ledger === 'object' && !('pending' in event.ledger)) ? event.ledger : null };
}

/** The reference events of a container case (trace.mjs `caseEvents` order). */
export const fromRecorded = (record, resolve) => caseEvents(record).map((event) => compareEvent(event, resolve));

/**
 * A codec tree as plain data: identity unwrapped (an object the tree shares is
 * one object again, a cycle stays a cycle), undefined kept, ports and functions
 * named, errors with their fields. `seen` carries identity across the trees of
 * one scope (a later tree may refer to an object of an earlier one).
 */
export function plain(tree, seen = new Map()) {
  const visit = (item) => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) {
      const out = [];
      for (const entry of item) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry[TAG] === 'hole') { out.length += entry.n; continue; }
        out.push(visit(entry));
      }
      return out;
    }
    switch (item[TAG]) {
      case undefined: { const out = {}; for (const key of Object.keys(item)) out[key] = visit(item[key]); return out; }
      case 'id': {
        if (seen.has(item.n)) return seen.get(item.n);
        // The container exists before its content, so a reference inside it to itself resolves.
        const body = item.value;
        const container = Array.isArray(body) ? [] : body && typeof body === 'object' && (body[TAG] === undefined || body[TAG] === 'escape' || body[TAG] === 'nullproto') ? {} : null;
        if (container === null) { const made = visit(body); seen.set(item.n, made); return made; }
        seen.set(item.n, container);
        const filled = visit(body);
        if (Array.isArray(container)) container.push(...filled); else Object.assign(container, filled);
        return container;
      }
      case 'ref': return seen.has(item.n) ? seen.get(item.n) : { $ref: item.n };
      case 'undefined': return undefined;
      case 'number': return item.value === '-0' ? -0 : Number(item.value);
      case 'escape': case 'nullproto': case 'symkeys': return visit(item.value);
      case 'array': return visit(item.items);
      case 'class': return { ...visit(item.value ?? {}), $class: item.name, ...(item.error ? { $error: item.error } : {}) };
      case 'port': return { $port: item.name };
      case 'function': return { $function: item.name };
      case 'map': return { $map: item.entries.map(([key, entry]) => [visit(key), visit(entry)]) };
      case 'set': return { $set: item.values.map(visit) };
      default: return { $leaf: item[TAG] };
    }
  };
  return visit(tree);
}

/** Every value field of every event as plain data, in one identity scope per trace (an object a later event shares is the earlier one). */
export function preparePlain(events) {
  const seen = new Map();
  for (const event of events) {
    if (event.p) continue;
    event.p = {};
    for (const key of Object.keys(event.values)) event.p[key] = plain(event.values[key], seen);
  }
  return events;
}
const P = (event, field) => (event.p && field in event.p ? event.p[field] : plain(event.values[field]));

const describe = (event) => (event ? `${event.dir} ${event.kind}${Object.entries(event.head).filter(([key]) => !['dir', 'kind', 'signals', 'inputs'].includes(key)).map(([key, value]) => ` ${key}=${JSON.stringify(value)}`).join('')} [construction ${event.c}]` : '(no event)');
const nameOf = (event) => event?.head?.name;
const isArrivedInput = (event) => event.dir === 'in' && (['call', 'control', 'callback', 'fire', 'abort', 'step'].includes(event.kind) || (event.kind === 'answer' && (event.head.outcome === 'resolve' || event.head.outcome === 'reject')));

// ------------------------------------------------------------------ lanes and units

/** The lane of an event for the independence table (null: dependent on everything). */
export function laneOf(event) {
  if (event.kind === 'port' && nameOf(event) === 'publishEvent') return 'publish';
  if (event.kind === 'port' && String(nameOf(event)).startsWith('executor.')) return 'executor';
  if (event.kind === 'timer.set') return 'timer.set';
  return null;
}

/** A port call and its immediate synchronous answer are one unit; every other event is a unit of its own. */
export function unitsOf(events) {
  const units = [];
  for (let index = 0; index < events.length;) {
    const event = events[index];
    const next = events[index + 1];
    const pair = event.kind === 'port' && next && next.c === event.c && next.dir === 'in' && next.kind === 'answer' && next.head.port === event.head.port && ['return', 'throw', 'promise'].includes(next.head.outcome);
    const end = pair ? index + 2 : index + 1;
    units.push({ start: index, end, lane: laneOf(event) });
    index = end;
  }
  return units;
}

const independentIn = (table) => {
  const pairs = new Set(table.flatMap((entry) => [`${entry.lanes[0]}|${entry.lanes[1]}`, `${entry.lanes[1]}|${entry.lanes[0]}`]));
  return (left, right) => left !== null && right !== null && left !== right && pairs.has(`${left}|${right}`);
};

// Port numbers are the candidate's own count of its port calls: under a reordering the recording's number of a call
// maps to the candidate's. Without one the map is the identity, entry by entry.
const PORT_FIELDS = { port: ['port'], answer: ['port'], control: ['of'], callback: ['of'] };
function mappedHead(event, map) {
  const fields = PORT_FIELDS[event.kind];
  const head = { ...event.head };
  if (event.kind !== 'port' && fields) for (const field of fields) if (typeof head[field] === 'number') head[field] = map.get(`${event.c}:${head[field]}`) ?? head[field];
  if (typeof head.during === 'number') head.during = map.get(`${event.c}:${head.during}`) ?? head.during;
  if (event.kind === 'step' && Array.isArray(head.inputs)) {
    head.inputs = head.inputs.map((item) => ({ ...item, ...(typeof item.port === 'number' ? { port: map.get(`${item.construction}:${item.port}`) ?? item.port } : {}), ...(typeof item.of === 'number' ? { of: map.get(`${item.construction}:${item.of}`) ?? item.of } : {}) }));
  }
  if (event.kind === 'port') delete head.port;
  return head;
}

// ------------------------------------------------------------------ values

/** The paths at which two plain values differ (leaf by leaf). */
function differingPaths(left, right, at = [], out = []) {
  if (out.length > 64) return out;
  if (Object.is(left, right)) return out;
  const object = (value) => value !== null && typeof value === 'object';
  if (object(left) && object(right) && Array.isArray(left) === Array.isArray(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) differingPaths(left[key], right[key], [...at, key], out);
    if (Object.keys(left).join('\u0000') !== Object.keys(right).join('\u0000') && !out.length) out.push([...at, '(key order)']);
    return out;
  }
  out.push(at);
  return out;
}
const lastKey = (trail) => [...trail].reverse().find((key) => typeof key === 'string' && !/^\d+$/.test(key));

/** The rule a value difference at `field` of the recorded event `event` belongs to, the most specific first. */
function valueRule(event, field, recordedTree, producedTree) {
  const name = nameOf(event);
  const paths = differingPaths(recordedTree, producedTree);
  const keys = paths.map(lastKey);
  if (paths.length && keys.every((key) => key && TIME_KEY.test(key))) return 'times';
  if (paths.length && keys.every((key) => key && ID_SITES[key])) return 'identifiers';
  if (event.kind === 'timer.set') return 'times';
  if (event.kind === 'draw') return 'identifiers';
  if (event.kind === 'throw' || (event.kind === 'settle' && event.head.outcome === 'reject')) return 'errors';
  if (event.kind === 'port') {
    if (name === 'persistence.save') return 'saved-state';
    if (name === 'persistence.putNativeJobProofShard' || name === 'persistence.removeNativeJobProofShard') return 'shard-writes';
    if (name === 'onMutationTiming') return 'mutation-timing';
    if (String(name).startsWith('logger.')) return 'logs';
    return 'port-arguments';
  }
  if (event.kind === 'return' || event.kind === 'settle') return 'returned-values';
  return field === 'value' && event.dir === 'in' ? 'inputs' : 'port-arguments';
}

/** The rule an order difference belongs to: a save, shard, log or timing call on either side names it. */
function orderRule(recorded, produced) {
  const names = [recorded, produced].filter(Boolean).filter((event) => event.kind === 'port').map(nameOf);
  if (names.includes('persistence.save')) return 'saved-state';
  if (names.some((name) => name === 'persistence.putNativeJobProofShard' || name === 'persistence.removeNativeJobProofShard')) return 'shard-writes';
  if (names.some((name) => String(name).startsWith('logger.'))) return 'logs';
  if (names.includes('onMutationTiming')) return 'mutation-timing';
  return 'event-sequence';
}

// ------------------------------------------------------------------ the sequence

/**
 * Matches the candidate's units to the recording's in exact total order, the
 * independence table aside. Returns `{ pairs, difference, uses, portMap }`:
 * `pairs` [recorded index, produced index] of every event matched, in the
 * candidate's order; `difference` the first finding (or null); `uses` every use
 * of the table.
 */
export function matchSequence(reference, candidate, { independence = [], complete = true } = {}) {
  const independent = independentIn(independence);
  const refUnits = unitsOf(reference);
  const candUnits = unitsOf(candidate);
  const matched = new Array(refUnits.length).fill(false);
  const map = new Map();
  const claimed = new Map();
  const pairs = [];
  const uses = [];
  let next = 0;
  const lastUnit = candUnits[candUnits.length - 1];
  const tryUnit = (ru, cu) => {
    // Heads first (order), then values; a port number maps recorded -> produced, one to one.
    let length = ru.end - ru.start;
    if (length !== cu.end - cu.start) {
      // The replay stopped inside this unit (a port call compared, its answer never asked for): what the candidate
      // produced of it is compared, so a wrong argument is named by its value rule, not as an order difference.
      if (complete || cu !== lastUnit || cu.end - cu.start > length) return { kind: 'head', at: 0 };
      length = cu.end - cu.start;
    }
    const added = [];
    for (let offset = 0; offset < length; offset += 1) {
      const r = reference[ru.start + offset];
      const p = candidate[cu.start + offset];
      if (r.c !== p.c || r.dir !== p.dir || r.kind !== p.kind) return { kind: 'head', at: offset };
      if (r.kind === 'port') {
        const key = `${r.c}:${r.head.port}`;
        const mine = map.get(key) ?? added.find(([k]) => k === key)?.[1];
        const owner = claimed.get(`${p.c}:${p.head.port}`);
        if ((mine !== undefined && mine !== p.head.port) || (mine === undefined && owner !== undefined && owner !== r.head.port)) return { kind: 'head', at: offset };
        if (mine === undefined) added.push([key, p.head.port]);
      }
      const view = new Map([...map, ...added]);
      const right = { ...p.head };
      if (p.kind === 'port') delete right.port;
      if (JSON.stringify(mappedHead(r, view)) !== JSON.stringify(right)) return { kind: 'head', at: offset };
    }
    for (let offset = 0; offset < length; offset += 1) {
      const r = reference[ru.start + offset];
      const p = candidate[cu.start + offset];
      for (const key of new Set([...Object.keys(r.values), ...Object.keys(p.values)])) {
        if (shapeText(r.values[key]) !== shapeText(p.values[key])) return { kind: 'value', at: offset, field: key };
      }
    }
    for (const [key, value] of added) { map.set(key, value); claimed.set(`${key.split(':')[0]}:${value}`, Number(key.split(':')[1])); }
    return null;
  };
  const record = (ru, cu) => { for (let offset = 0; offset < Math.min(ru.end - ru.start, cu.end - cu.start); offset += 1) pairs.push([ru.start + offset, cu.start + offset]); };
  const differenceAt = (ru, cu, found) => {
    const r = ru ? reference[ru.start + (found?.at ?? 0)] : null;
    const p = cu ? candidate[cu.start + (found?.at ?? 0)] : null;
    const at = cu ? cu.start + (found?.at ?? 0) + 1 : (ru ? ru.start + 1 : candidate.length + 1);
    if (found?.kind === 'value') {
      const rule = valueRule(r, found.field, P(r, found.field), P(p, found.field));
      const paths = differingPaths(P(r, found.field), P(p, found.field));
      let how = '';
      if (rule === 'times') {
        // Which now (or input time) and which named constant each side's value matched, or that it matched none.
        const leaf = (value, trail) => trail.reduce((item, key) => (item === null || item === undefined ? item : item[key]), value);
        const trail = paths[0] ?? [];
        const recordedValue = leaf(P(r, found.field), trail);
        const producedValue = leaf(P(p, found.field), trail);
        const delay = r.kind === 'timer.set';
        const explain = (events, index, value) => (typeof value === 'number' ? explainTime(events, index, r.c, value, { delay }) ?? 'no handed-out now or input time plus a named constant' : 'not a number');
        how = `; ${[found.field, ...trail].join('.')}: the candidate's ${producedValue} = ${explain(candidate, cu.start + found.at, producedValue)}, the recording's ${recordedValue} = ${explain(reference, ru.start + found.at, recordedValue)}`;
      }
      return { rule, kind: 'fail', at, expected: describe(r), got: describe(p), detail: `${describe(r)}: ${found.field} differs (${paths.slice(0, 3).map((path) => path.join('.') || '(value)').join(', ')})${how}` };
    }
    if (!p) return { rule: orderRule(r, null), kind: 'fail', at, expected: describe(r), got: null, detail: `the candidate, quiescent, produced nothing where the recording has ${describe(r)}` };
    if (!r) return { rule: orderRule(null, p), kind: 'fail', at, expected: null, got: describe(p), detail: `the candidate produced ${describe(p)} after the recording's last event` };
    return { rule: orderRule(r, p), kind: 'fail', at, expected: describe(r), got: describe(p), detail: `the candidate produced ${describe(p)} where the recording has ${describe(r)}` };
  };
  for (const cu of candUnits) {
    while (next < refUnits.length && matched[next]) next += 1;
    if (next >= refUnits.length) return { pairs, uses, portMap: map, difference: differenceAt(null, cu, null) };
    const first = tryUnit(refUnits[next], cu);
    if (first === null) { matched[next] = true; record(refUnits[next], cu); continue; }
    if (first.kind === 'value') return { pairs, uses, portMap: map, difference: differenceAt(refUnits[next], cu, first) };
    // An order difference: the table may let this unit pass the recorded units of an independent lane before it.
    let placed = false;
    if (cu.lane !== null && independence.length) {
      const skipped = [];
      for (let index = next; index < refUnits.length; index += 1) {
        if (matched[index]) continue;
        const ru = refUnits[index];
        if (index > next && ru.lane === cu.lane) {
          const found = tryUnit(ru, cu);
          if (found === null) {
            matched[index] = true;
            record(ru, cu);
            uses.push({ rule: 'independence', kind: 'info', at: cu.start + 1, lanes: [cu.lane, ...new Set(skipped.map((item) => item.lane))], detail: `${describe(candidate[cu.start])} comes before ${skipped.length} recorded event(s) of lane ${[...new Set(skipped.map((item) => item.lane))].join(', ')} (independence table)` });
            placed = true;
          } else if (found.kind === 'value') return { pairs, uses, portMap: map, difference: differenceAt(ru, cu, found) };
          break;
        }
        if (!independent(ru.lane, cu.lane)) break;
        skipped.push(ru);
      }
    }
    if (!placed) return { pairs, uses, portMap: map, difference: differenceAt(refUnits[next], cu, first) };
  }
  const left = refUnits.findIndex((unit, index) => !matched[index]);
  if (complete && left >= 0) return { pairs, uses, portMap: map, difference: differenceAt(refUnits[left], null, null) };
  return { pairs, uses, portMap: map, difference: null };
}

// ------------------------------------------------------------------ read mode (OD2)

const readKey = (event) => `${event.c}|${event.head.object}|${event.head.op ?? 'get'}|${typeof event.head.key === 'string' ? event.head.key : shapeText(event.values.key)}`;

/**
 * The read table of a case's recorded events: per key its one value, and the
 * keys whose value changes between reads (`option-varies`).
 */
export function readTable(events) {
  const table = new Map();
  const varies = new Set();
  for (const event of events) {
    if (event.dir !== 'in' || event.kind !== 'read') continue;
    const key = readKey(event);
    const value = `${JSON.stringify(event.head.found ?? null)}|${shapeText(event.values.value)}`;
    if (!table.has(key)) table.set(key, value);
    else if (table.get(key) !== value) varies.add(key);
  }
  return { table, varies };
}

// ------------------------------------------------------------------ the case

/**
 * Compares one case. `reference` the recorded events (all of them), `limit`
 * how many are compared (a partial case's prefix), `candidate` the produced
 * events, `complete` false when the candidate's trace was cut (the replayer
 * stopped at a difference: what it would have done next is unknown).
 * `mode.independence` the table (default INDEPENDENCE), `mode.reads` `exact`
 * (default) or `free`. `observed`, when the replay stopped at a difference:
 * `{ events, recOf, through, complete, stopped }`, the candidate's run past it
 * (the replayer's ObserveHost; `recOf[i]` the recorded index of the arrived input
 * that is its event i, `through` the last recorded index every input before
 * which was delivered and drained, `complete` every input of the compared part
 * delivered). It never decides the case (the case is already different, OD1);
 * the launch-latency oracle and the capacity and admitLaunch assertions read
 * it for what the cut trace cannot show. Returns `{ verdict: pass | fail |
 * inconclusive, findings, info }`.
 */
export function compareCase({ reference, candidate, limit = reference.length, complete = true, mode = {}, observed = null }) {
  const independence = mode.independence ?? INDEPENDENCE;
  const findings = [];
  const info = [];
  preparePlain(reference);
  preparePlain(candidate);
  let ref = reference.slice(0, limit);
  let cand = candidate;
  if ((mode.reads ?? 'exact') === 'free') {
    const recorded = readTable(ref);
    if (recorded.varies.size) {
      findings.push({ rule: 'option-varies', kind: 'inconclusive', detail: `read mode free: the recording reads ${[...recorded.varies].slice(0, 4).join(', ')} with more than one value; count and position of those reads are contract for this candidate, so the case is inconclusive` });
    }
    for (const event of cand) {
      if (event.dir !== 'in' || event.kind !== 'read') continue;
      const key = readKey(event);
      const value = `${JSON.stringify(event.head.found ?? null)}|${shapeText(event.values.value)}`;
      if (recorded.varies.has(key)) continue;
      if (!recorded.table.has(key)) findings.push({ rule: 'option-reads', kind: 'inconclusive', detail: `read mode free: the candidate read ${key}, which the recording never read` });
      else if (recorded.table.get(key) !== value) findings.push({ rule: 'option-reads', kind: 'fail', detail: `read mode free: the candidate's read of ${key} got another value than the recording's` });
    }
    const reads = ref.filter((event) => event.dir === 'in' && event.kind === 'read').length;
    info.push({ rule: 'read-mode', kind: 'info', detail: `read mode free: ${reads} recorded read(s) and ${cand.filter((event) => event.dir === 'in' && event.kind === 'read').length} candidate read(s) compared by key and value only` });
    ref = ref.filter((event) => !(event.dir === 'in' && event.kind === 'read'));
    cand = cand.filter((event) => !(event.dir === 'in' && event.kind === 'read'));
  }
  const sequence = matchSequence(ref, cand, { independence, complete });
  info.push(...sequence.uses.map((use) => ({ ...use, cite: independence.find((entry) => use.lanes.slice(1).every((lane) => entry.lanes.includes(lane) && entry.lanes.includes(use.lanes[0])))?.cite ?? null })));
  if (sequence.difference) findings.push(sequence.difference);
  // Saved bytes and save count of what was matched (the online comparison sees trees; this sees the bytes).
  for (const [r, p] of sequence.pairs) {
    const event = ref[r];
    if (event.kind !== 'port' || nameOf(event) !== 'persistence.save' || event.ledger === null) continue;
    const bytes = encodeOrError(P(cand[p], 'args')?.[0]);
    if (bytes.error !== undefined || JSON.stringify(sha256(bytes.text)) !== JSON.stringify(event.ledger)) {
      findings.push({ rule: 'saved-state', kind: 'fail', at: p + 1, expected: describe(event), detail: `${describe(event)}: the candidate's saved state ${bytes.error !== undefined ? `does not encode (${bytes.error})` : `encodes to ${sha256(bytes.text)}`}, the recording's digest is ${JSON.stringify(event.ledger)}` });
      break;
    }
  }
  // The save count needs no check of its own: the sequence rule matches every event, so a complete trace with no
  // difference has the recording's saves, one for one (an earlier count check here could never fail: O0d review M1).
  const context = analyse(cand);
  const refContext = analyse(ref);
  findings.push(...timesRule(cand), ...identifiersRule(cand));
  findings.push(...codecOracle(context), ...transitionsOracle(context), ...censusOracle(context, { complete, difference: sequence.difference, ref }));
  // Past the first difference the candidate's observed run (when the replayer made one) is read for what does not
  // depend on matching the recording: its launches, its capacity holds and admitLaunch calls.
  const seen = observed ? { ...observed, context: analyse(preparePlain(observed.events)) } : null;
  findings.push(...latencyOracle(refContext, context, { reachedTo: cand.length, complete, independence, observed: seen, all: reference, limit, info }));
  findings.push(...durabilityOracle(context), ...globalAssertions(refContext, context, { reference: ref, complete }));
  if (seen) findings.push(...observedAssertions(seen.context, { from: cand.length }));
  const fail = findings.some((finding) => finding.kind === 'fail');
  const inconclusive = findings.some((finding) => finding.kind === 'inconclusive');
  return { verdict: fail ? 'fail' : inconclusive ? 'inconclusive' : 'pass', findings, info: [...info, ...context.notes] };
}

function encodeOrError(state) {
  try { return { text: encodeLedgerSnapshot(state) }; } catch (error) { return { error: String(error?.message ?? error) }; }
}

// ------------------------------------------------------------------ one trace, read once

/**
 * What a trace shows, per construction, in order: saves (state, whether and
 * when resolved), loads, launches, timers, steps, clock values, inputs.
 */
export function analyse(events) {
  const saves = [];
  const savesByPort = new Map();
  const launches = [];
  const loads = [];
  const steps = [];
  const notes = [];
  const options = new Map(); // construction -> the options object handed to the factory (plain)
  const calls = new Map(); // `${c}:${call}` -> member
  // A step starts at a driver's step marker (its group follows it) or, in a recording without markers, at every
  // arrived input.
  let groupLeft = 0;
  for (const [index, event] of events.entries()) {
    if (isArrivedInput(event)) {
      if (event.kind === 'step') { steps.push({ index, marker: { step: event.head.step, now: event.head.now }, ordinal: steps.length + 1 }); groupLeft = event.head.inputs?.length ?? 0; }
      else if (groupLeft > 0) groupLeft -= 1;
      else steps.push({ index, marker: null, ordinal: steps.length + 1 });
    }
    if (event.dir === 'in' && event.kind === 'call') {
      calls.set(`${event.c}:${event.head.call}`, event.head.member);
      if (event.head.call === 0) options.set(event.c, P(event, 'args')?.[0] ?? null);
    }
    if (event.kind === 'port' && nameOf(event) === 'persistence.save') {
      const entry = { index, c: event.c, port: event.head.port, state: P(event, 'args')?.[0], resolvedAt: null, number: saves.filter((item) => item.c === event.c).length + 1 };
      saves.push(entry);
      savesByPort.set(`${event.c}:${event.head.port}`, entry);
    }
    if (event.dir === 'in' && event.kind === 'answer' && event.head.outcome === 'resolve') {
      const save = savesByPort.get(`${event.c}:${event.head.port}`);
      if (save) save.resolvedAt = index;
    }
    if (event.kind === 'port' && nameOf(event) === 'persistence.load') loads.push({ index, c: event.c, port: event.head.port });
    if (event.dir === 'in' && event.kind === 'answer' && event.head.outcome === 'resolve' && loads.some((load) => load.c === event.c && load.port === event.head.port)) {
      const load = loads.find((item) => item.c === event.c && item.port === event.head.port);
      load.state = P(event, 'value');
      load.resolvedAt = index;
    }
    if (event.kind === 'port' && LAUNCH.has(nameOf(event))) {
      const task = P(event, 'args')?.[0] ?? {};
      launches.push({ index, c: event.c, port: nameOf(event), taskId: task.taskId ?? null, leaseToken: task.leaseToken ?? null });
    }
  }
  return { events, saves, launches, loads, steps, notes, options, calls };
}

/** The step an event belongs to: the last arrived input at or before it (and its marker's step and time when there is one). */
function stepOf(context, index) {
  let found = null;
  for (const entry of context.steps) { if (entry.index > index) break; found = entry; }
  return found;
}
/** The last now handed out at or before `index` in construction `c` (option, nominal or real clock; not performance). */
function nowAt(events, index, c) {
  for (let at = index; at >= 0; at -= 1) {
    const event = events[at];
    if (event.c === c && event.dir === 'in' && event.kind === 'clock' && event.head.source !== 'performance') return P(event, 'value');
  }
  return null;
}
/** The last arrived input before `index`: the input that made what follows possible. */
function triggerOf(events, index) {
  for (let at = index - 1; at >= 0; at -= 1) if (isArrivedInput(events[at])) return at;
  return -1;
}

// ------------------------------------------------------------------ times and identifiers

const numericLeaves = (value, at = [], out = []) => {
  if (typeof value === 'number' && Number.isFinite(value)) { out.push({ path: at, value }); return out; }
  if (value === null || typeof value !== 'object') return out;
  for (const key of Object.keys(value)) numericLeaves(value[key], [...at, key], out);
  return out;
};
const stringLeaves = (value, at = [], out = []) => {
  if (typeof value === 'string') { out.push({ path: at, value }); return out; }
  if (value === null || typeof value !== 'object') return out;
  for (const key of Object.keys(value)) stringLeaves(value[key], [...at, key], out);
  return out;
};
const OUTPUT_KINDS = new Set(['port', 'return', 'settle', 'throw']);

/**
 * What a trace has handed out by a point, per construction: the nows (clock reads, not performance.now), the times
 * inputs carried (time-keyed numbers of calls, answers, loaded states), and the constants a time may add (the delay
 * table, numeric options ending in Ms). `observe` takes events in order; `derive` names how a value is made from
 * them, or null.
 */
function timeBasis() {
  const bases = new Map(); // construction -> Map(value -> description)
  const nows = new Map(); // construction -> list of now values
  const constants = new Map(Object.entries(DELAYS).map(([name, value]) => [value, name]));
  const optionConstants = new Map();
  const add = (c, value, text) => { if (!bases.has(c)) bases.set(c, new Map()); if (!bases.get(c).has(value)) bases.get(c).set(value, text); };
  const observe = (event, index) => {
    if (event.dir !== 'in') return;
    const c = event.c;
    if (event.kind === 'clock' && event.head.source !== 'performance') {
      const value = P(event, 'value');
      if (typeof value === 'number') { add(c, value, `now #${index + 1}`); nows.set(c, [...(nows.get(c) ?? []), value]); }
    } else if (event.kind === 'read' && event.head.object === 'options' && typeof event.head.key === 'string' && /Ms$/.test(event.head.key)) {
      const value = P(event, 'value');
      if (typeof value === 'number') optionConstants.set(value, `option ${event.head.key}`);
    } else {
      for (const field of Object.keys(event.values)) {
        for (const leaf of numericLeaves(P(event, field))) {
          const key = lastKey(leaf.path);
          if (key && TIME_KEY.test(key)) add(c, leaf.value, `input #${index + 1} ${[field, ...leaf.path].join('.')}`);
          else if (key && /Ms$/.test(key)) optionConstants.set(leaf.value, `input ${key}`);
        }
      }
    }
  };
  const derive = (c, value) => {
    const known = bases.get(c) ?? new Map();
    if (known.has(value)) return known.get(value);
    for (const [constant, name] of [...constants, ...optionConstants]) if (constant !== 0 && known.has(value - constant)) return `${known.get(value - constant)} + ${name}`;
    return null;
  };
  // A delay is a named constant, or a due time (derived as above) less the now it is armed at: max(0, due - now).
  const deriveDelay = (c, delay) => {
    const named = constants.get(delay) ?? optionConstants.get(delay);
    if (named) return named;
    for (const now of nows.get(c) ?? []) { const due = derive(c, delay + now); if (due !== null) return `(${due}) - now ${now}`; }
    return delay === 0 ? 'clamped at 0' : null;
  };
  return { observe, derive, deriveDelay };
}

/** How the time `value` of construction `c` derives from what `events` handed out before `upto`, or null. */
export function explainTime(events, upto, c, value, { delay = false } = {}) {
  const basis = timeBasis();
  for (let index = 0; index < upto && index < events.length; index += 1) basis.observe(events[index], index);
  return delay ? basis.deriveDelay(c, value) : basis.derive(c, value);
}

/** `times`: every time value of an output, derived from a handed-out now or an input's time plus a named constant. */
export function timesRule(events) {
  const findings = [];
  const basis = timeBasis();
  let checked = 0;
  for (const [index, event] of events.entries()) {
    basis.observe(event, index);
    if (event.dir === 'in') continue;
    if (!OUTPUT_KINDS.has(event.kind) && event.kind !== 'timer.set') continue;
    const c = event.c;
    if (event.kind === 'timer.set') {
      const delay = P(event, 'delay');
      if (typeof delay !== 'number' || !Number.isFinite(delay)) continue;
      checked += 1;
      if (basis.deriveDelay(c, delay) === null) findings.push({ rule: 'times', kind: 'fail', at: index + 1, detail: `${describe(event)}: delay ${delay} is no named constant and no due time (a handed-out now or an input's time plus a named constant) less a now` });
      continue;
    }
    if (event.kind === 'port' && nameOf(event) === 'onMutationTiming') continue;
    for (const field of Object.keys(event.values)) {
      for (const leaf of numericLeaves(P(event, field))) {
        const key = lastKey(leaf.path);
        if (!key || !TIME_KEY.test(key)) continue;
        checked += 1;
        if (basis.derive(c, leaf.value) === null) findings.push({ rule: 'times', kind: 'fail', at: index + 1, detail: `${describe(event)}: ${[field, ...leaf.path].join('.')} = ${leaf.value} is not a now handed out at or before it, nor an input's time, plus a named constant` });
      }
    }
  }
  return findings.slice(0, 8).concat(findings.length > 8 ? [{ ...findings[8], detail: `${findings[8].detail} (and ${findings.length - 9} more)` }] : []).map((finding) => ({ ...finding, checked }));
}

/**
 * `identifiers`: every identifier of an output is a draw of its own site or an input's. Each site's draw order is
 * the sequence rule's (every draw is an event compared with its value; an earlier per-site order check here could
 * never fail on its own: O0d review M1).
 */
export function identifiersRule(events) {
  const findings = [];
  const drawn = new Map(); // construction -> Map(value -> site)
  const given = new Map(); // construction -> Set(values seen in inputs)
  const remember = (map, c, value, site) => { if (!map.has(c)) map.set(c, new Map()); if (!map.get(c).has(value)) map.get(c).set(value, site); };
  for (const [index, event] of events.entries()) {
    const c = event.c;
    if (event.dir === 'in' && event.kind === 'draw') {
      const value = P(event, 'value');
      if (typeof value !== 'string') continue;
      remember(drawn, c, value, event.head.site);
      const prefix = HIDDEN_PREFIX[event.head.site];
      if (prefix) remember(drawn, c, `${prefix}${value.replaceAll('-', '')}`, event.head.site);
      continue;
    }
    if (event.dir === 'in') {
      if (!given.has(c)) given.set(c, new Set());
      for (const field of Object.keys(event.values)) for (const leaf of stringLeaves(P(event, field))) given.get(c).add(leaf.value);
      continue;
    }
    if (!OUTPUT_KINDS.has(event.kind)) continue;
    for (const field of Object.keys(event.values)) {
      for (const leaf of stringLeaves(P(event, field))) {
        const key = lastKey(leaf.path);
        const sites = key && leaf.path[leaf.path.length - 1] === key ? ID_SITES[key] : null;
        if (!sites) continue;
        const site = drawn.get(c)?.get(leaf.value);
        if (site !== undefined && !sites.includes(site)) findings.push({ rule: 'identifiers', kind: 'fail', at: index + 1, detail: `${describe(event)}: ${[field, ...leaf.path].join('.')} = ${leaf.value} is a draw of ${site}, not of ${sites.join(' or ')}` });
        else if (site === undefined && !given.get(c)?.has(leaf.value)) findings.push({ rule: 'identifiers', kind: 'fail', at: index + 1, detail: `${describe(event)}: ${[field, ...leaf.path].join('.')} = ${leaf.value} is no draw of ${sites.join(' or ')} and no input carried it` });
      }
    }
  }
  return findings.slice(0, 8);
}

// ------------------------------------------------------------------ oracles

function codecOracle(context) {
  const findings = [];
  for (const save of context.saves) {
    const first = encodeOrError(save.state);
    if (first.error !== undefined) { findings.push({ rule: 'codec-round-trip', kind: 'fail', at: save.index + 1, detail: `save ${save.number} of construction ${save.c} does not encode with the reference codec: ${first.error}` }); continue; }
    let again;
    try { again = encodeLedgerSnapshot(decodeLedgerSnapshot(JSON.parse(first.text))); } catch (error) { again = `(${String(error?.message ?? error)})`; }
    if (again !== first.text) findings.push({ rule: 'codec-round-trip', kind: 'fail', at: save.index + 1, detail: `save ${save.number} of construction ${save.c}: its reference bytes do not decode and re-encode to themselves` });
  }
  for (const [index, event] of context.events.entries()) {
    if (event.kind !== 'port' || nameOf(event) !== 'persistence.putNativeJobProofShard') continue;
    const [shard, text] = P(event, 'args') ?? [];
    let again;
    try { again = encodeManagedNativeJobProofShard(shard, decodeManagedNativeJobProofShard(JSON.parse(text), shard)); } catch (error) { again = `(${String(error?.message ?? error)})`; }
    if (again !== text) findings.push({ rule: 'codec-round-trip', kind: 'fail', at: index + 1, detail: `shard ${shard}: its text does not decode and re-encode to itself (${String(again).slice(0, 120)})` });
  }
  return findings;
}

function transitionsOracle(context) {
  const findings = [];
  const last = new Map(); // `${c}:${taskId}` -> the record of the latest resolved save (what is durable)
  // A loaded state continues the records of the save of this trace it equals (a restart after a crash point); a
  // state the test wrote itself starts the records afresh.
  const baseline = (c, state, index) => {
    const text = JSON.stringify(state);
    const source = [...context.saves].reverse().find((save) => save.index < index && JSON.stringify(save.state) === text);
    for (const task of source?.state?.tasks ?? []) last.set(`${c}:${task.taskId}`, task);
  };
  // Each proposed save is checked against what is durable; it becomes durable when its answer resolves (a rejected
  // or never settled save never landed: a torn write, a refused commit).
  const timeline = [
    ...context.loads.filter((load) => load.state).map((load) => ({ index: load.resolvedAt, load })),
    ...context.saves.map((save) => ({ index: save.index, check: save })),
    ...context.saves.filter((save) => save.resolvedAt !== null).map((save) => ({ index: save.resolvedAt, commit: save })),
  ].sort((a, b) => a.index - b.index);
  for (const item of timeline) {
    if (item.load) { baseline(item.load.c, item.load.state, item.index); continue; }
    if (item.commit) { for (const task of item.commit.state?.tasks ?? []) last.set(`${item.commit.c}:${task.taskId}`, task); continue; }
    const save = item.check;
    for (const task of save.state?.tasks ?? []) {
      const previous = last.get(`${save.c}:${task.taskId}`);
      if (!previous || JSON.stringify(previous) === JSON.stringify(task)) continue;
      // A native job tombstone is compaction's stand-in for a released record, not a transition of the task.
      if (isManagedNativeJobTombstone(task)) continue;
      // The scheduler makes a record by spreading the previous one, so an unchanged member is the same object; in data
      // across two saves it is an equal copy. Members equal by value are given the previous record's object (the
      // reference compares terminal records member by member with Object.is).
      const aligned = Object.fromEntries(Object.entries(task).map(([field, value]) => [field, JSON.stringify(value) === JSON.stringify(previous[field]) ? previous[field] : value]));
      try { assertManagedTaskTransition(previous, aligned); } catch (error) {
        const changed = [...new Set([...Object.keys(previous), ...Object.keys(task)])].filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(task[field]));
        findings.push({ rule: 'transitions', kind: 'fail', at: save.index + 1, detail: `save ${save.number} of construction ${save.c}: task ${task.taskId} ${previous.status} -> ${task.status} (changed ${changed.join(', ')}) is refused by the reference assertManagedTaskTransition (${String(error?.message ?? error)})` });
      }
    }
  }
  return findings.slice(0, 8);
}

function censusOracle(context, { complete, difference, ref }) {
  const findings = [];
  const live = new Map(); // `${c}:${id}` -> { index, delay }
  const shutdowns = []; // { c, call, index }
  const events = context.events;
  for (const [index, event] of events.entries()) {
    const c = event.c;
    if (event.kind === 'timer.set') live.set(`${c}:${event.head.timer}`, { index, delay: P(event, 'delay') });
    else if (event.kind === 'timer.clear' && event.head.timer !== null) live.delete(`${c}:${event.head.timer}`);
    else if (event.dir === 'in' && event.kind === 'fire') live.delete(`${c}:${event.head.timer}`);
    else if (event.dir === 'in' && event.kind === 'call' && event.head.member === 'shutdown') shutdowns.push({ c, call: event.head.call, index });
    else if (event.kind === 'settle' || event.kind === 'throw') {
      const shutdown = shutdowns.find((entry) => entry.c === c && entry.call === event.head.call && !entry.settled);
      if (!shutdown) continue;
      shutdown.settled = true;
      const left = [...live].filter(([key]) => key.startsWith(`${c}:`));
      if (left.length) findings.push({ rule: 'timer-census', kind: 'fail', at: index + 1, detail: `shutdown (call ${shutdown.call}) of construction ${c} settled with ${left.length} timer(s) still live: ${left.slice(0, 4).map(([key, item]) => `timer ${key.split(':')[1]} (delay ${item.delay}, set at #${item.index + 1})`).join(', ')}` });
    }
  }
  if (complete && !difference && live.size) context.notes.push({ rule: 'timer-census', kind: 'info', detail: `${live.size} timer(s) still pending when the case ends (no shutdown settled after them): ${[...live].slice(0, 4).map(([key, item]) => `construction ${key.split(':')[0]} timer ${key.split(':')[1]} (delay ${item.delay})`).join(', ')}` });
  // At the first difference: a timer the recording clears there that the candidate leaves live.
  if (difference && difference.at) {
    const position = difference.at - 1;
    const recorded = ref[position];
    if (recorded && recorded.kind === 'timer.clear' && recorded.head.timer !== null && live.has(`${recorded.c}:${recorded.head.timer}`)) {
      const produced = events[position];
      if (!produced || produced.kind !== 'timer.clear' || produced.head.timer !== recorded.head.timer) findings.push({ rule: 'timer-census', kind: 'fail', at: position + 1, detail: `timer ${recorded.head.timer} of construction ${recorded.c} (delay ${live.get(`${recorded.c}:${recorded.head.timer}`).delay}) is left live where the recording clears it` });
    }
  }
  return findings;
}

/** Every launch of a trace in order: `{ index, c, port, taskId, n }`, `n` its number for that task and port. */
const launchList = (events) => {
  const counts = new Map();
  const out = [];
  for (const [index, event] of events.entries()) {
    if (event.kind !== 'port' || !LAUNCH.has(nameOf(event))) continue;
    const task = P(event, 'args')?.[0] ?? {};
    const base = `${event.c}:${task.taskId ?? null}:${nameOf(event)}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    out.push({ index, c: event.c, port: nameOf(event), taskId: task.taskId ?? null, n, name: `${base}:${n}` });
  }
  return out;
};

/**
 * §5, the launch-latency oracle. Every launch the reference makes in the compared part is judged, independently of
 * where the first event difference is, by four facts: the step it is made in (the driver's step marker, or each
 * arrived input in a test recording), the virtual time (the last now handed out), the event distance from the input
 * that made it launchable (the last arrived input before it; units of a lane the table makes independent of the
 * executor lane are not counted, so a move the table allows is no change of launch timing) and the timers set in
 * between. The candidate's facts come from its compared events when the launch is among them, else from its
 * observed run past the first difference (`observed`; its steps are the recording's, read through `recOf`).
 * Later on any fact, a timer the reference did not set before it, or missing where the candidate's run reached
 * past it: `launch_delayed`, in addition to whatever else is reported. Earlier: `launch_advanced`. A launch the
 * reference does not make there: `launch_duplicated` (the reference makes fewer through that port),
 * `launch_advanced` (it makes it only past the compared part) or `launch_extra` (never). A launch neither trace
 * reaches is not judged; it is listed as information (`launch-unjudged`) with the reason.
 */
function latencyOracle(refContext, context, { reachedTo, complete, independence = [], observed = null, all = refContext.events, limit = refContext.events.length, info = [] }) {
  const findings = [];
  const independent = independentIn(independence);
  const positions = (events) => {
    const out = new Array(events.length + 1);
    let position = 0;
    for (const unit of unitsOf(events)) {
      const skip = independent(unit.lane, 'executor');
      for (let index = unit.start; index < unit.end; index += 1) { out[index] = position; if (!skip) position += 1; }
    }
    out[events.length] = position;
    return out;
  };
  const refAt = positions(refContext.events);
  const candAt = positions(context.events);
  const seenAt = observed ? positions(observed.context.events) : null;
  // The step of an event: a marker's own step number, else the ordinal of the reference's arrived input (for the
  // observed run, the recorded input it delivered, so a skipped input moves no step).
  const stepNumber = (ctx, index, recOf = null) => {
    const entry = stepOf(ctx, index);
    if (!entry) return 0;
    if (entry.marker) return entry.marker.step;
    if (!recOf) return entry.ordinal;
    const recorded = stepOf(refContext, recOf[entry.index] ?? -1);
    return recorded?.marker?.step ?? recorded?.ordinal ?? 0;
  };
  const facts = (ctx, at, launch, recOf = null) => {
    const trigger = triggerOf(ctx.events, launch.index);
    const timers = ctx.events.slice(trigger + 1, launch.index).filter((event) => event.kind === 'timer.set').map((event) => P(event, 'delay'));
    return { trigger, distance: at[launch.index] - (trigger < 0 ? 0 : at[trigger]), step: stepNumber(ctx, launch.index, recOf), time: nowAt(ctx.events, launch.index, launch.c), timers };
  };
  const text = (item, index) => `step ${item.step}, time ${item.time}, event ${index + 1}, distance ${item.distance}${item.timers.length ? `, timers before it ${item.timers.join(', ')}` : ''}`;
  const judge = (launch, want, got, have, where) => {
    // Step first, then virtual time, then distance (a distance from another step's input is no measure); a timer the
    // reference did not set is one more timer set between the input and the launch (another delay in its place is the
    // times rule's).
    const order = have.step - want.step || (have.time ?? 0) - (want.time ?? 0) || have.distance - want.distance;
    const timersAdded = have.timers.length > want.timers.length;
    const shown = `${launch.port} of ${launch.taskId} (construction ${launch.c}) ${where}: ${text(have, got.index)}; the reference: ${text(want, launch.index)}`;
    if (order > 0 || (order === 0 && timersAdded)) findings.push({ rule: 'launch_delayed', oracle: 'launch-latency', kind: 'fail', at: got.index + 1, detail: shown });
    else if (order < 0) findings.push({ rule: 'launch_advanced', oracle: 'launch-latency', kind: 'fail', needsOwner: true, at: got.index + 1, detail: `${shown}: earlier than the reference, a change of dispatch timing that would need the owner's yes, not a defect` });
  };
  const byName = (list) => new Map(list.map((launch) => [launch.name, launch]));
  const reference = launchList(refContext.events);
  const recorded = byName(launchList(all));
  const candidate = byName(launchList(context.events));
  const seen = observed ? byName(launchList(observed.context.events)) : new Map();
  const unjudged = [];
  for (const launch of reference) {
    const want = facts(refContext, refAt, launch);
    const got = candidate.get(launch.name);
    if (got) { judge(launch, want, got, facts(context, candAt, got), 'in the compared events'); continue; }
    if (reachedTo > launch.index || complete) {
      // The compared events reach past it and hold no such launch: the candidate did not make it where the reference did.
      const timers = context.events.slice(want.trigger + 1, Math.min(launch.index + 1, context.events.length)).filter((event) => event.kind === 'timer.set').map((event) => P(event, 'delay'));
      findings.push({ rule: 'launch_delayed', oracle: 'launch-latency', kind: 'fail', at: launch.index + 1, detail: `${launch.port} of ${launch.taskId} (construction ${launch.c}) is missing at event ${launch.index + 1} (${text(want, launch.index)})${timers.length > want.timers.length ? `; the candidate set ${timers.length - want.timers.length} more timer(s) before it (${timers.join(', ')})` : ''}` });
      continue;
    }
    const observedLaunch = seen.get(launch.name);
    if (observedLaunch) { judge(launch, want, observedLaunch, facts(observed.context, seenAt, observedLaunch, observed.recOf), 'past the first difference (observed)'); continue; }
    if (observed && (observed.complete || observed.through >= launch.index)) {
      findings.push({ rule: 'launch_delayed', oracle: 'launch-latency', kind: 'fail', at: launch.index + 1, detail: `${launch.port} of ${launch.taskId} (construction ${launch.c}) is never made past the first difference, where the reference makes it at ${text(want, launch.index)} (observed: every input before it delivered${observed.complete ? ', the whole compared part' : ''})` });
      continue;
    }
    unjudged.push(`${launch.port} of ${launch.taskId} at event ${launch.index + 1}`);
  }
  if (unjudged.length) info.push({ rule: 'launch-unjudged', kind: 'info', detail: `${unjudged.length} launch(es) of the compared part not judged: ${observed ? `the observed run stopped (${observed.stopped ?? 'before them'})` : 'no observed run past the first difference'}: ${unjudged.slice(0, 4).join(', ')}` });
  // Launches the reference does not make where the candidate makes them.
  const extra = (got, where) => {
    const inReference = reference.find((launch) => launch.name === got.name);
    if (inReference) return;
    const later = recorded.get(got.name);
    // The reference's launch of that task through that port in a later construction (a crashed instance's admitted
    // task, launched by the fresh one): the candidate launched it before the reference did.
    const afterRestart = [...recorded.values()].find((item) => item.taskId === got.taskId && item.port === got.port && item.c > got.c);
    // The reference's instance stopped at a crash point (a later construction follows it) before it made the launch.
    const stoppedFirst = !afterRestart && all.some((event) => event.c > got.c);
    const shown = `${got.port} of ${got.taskId} (construction ${got.c}, its launch ${got.n} through that port) at event ${got.index + 1} ${where}`;
    if (later && later.index >= limit) findings.push({ rule: 'launch_advanced', oracle: 'launch-latency', kind: 'fail', needsOwner: true, at: got.index + 1, detail: `${shown}; the reference makes it only past the compared part (event ${later.index + 1}): a change of dispatch timing that would need the owner's yes, not a defect` });
    else if (got.n > 1 && recorded.has(`${got.c}:${got.taskId}:${got.port}:${got.n - 1}`)) findings.push({ rule: 'launch_duplicated', oracle: 'launch-latency', kind: 'fail', at: got.index + 1, detail: `${shown}; the reference launches that task through ${got.port} ${got.n - 1} time(s) in that construction: a second launch of the same task is a defect` });
    else if (got.n === 1 && afterRestart) findings.push({ rule: 'launch_advanced', oracle: 'launch-latency', kind: 'fail', needsOwner: true, at: got.index + 1, detail: `${shown}; the reference launches it only in construction ${afterRestart.c} (event ${afterRestart.index + 1}): earlier than the reference, a change of dispatch timing that would need the owner's yes, not a defect` });
    else if (got.n === 1 && stoppedFirst) findings.push({ rule: 'launch_advanced', oracle: 'launch-latency', kind: 'fail', needsOwner: true, at: got.index + 1, detail: `${shown}; the reference's instance stopped at its crash point before making it: earlier than the reference, a change of dispatch timing that would need the owner's yes, not a defect` });
    else findings.push({ rule: 'launch_extra', oracle: 'launch-latency', kind: 'fail', at: got.index + 1, detail: `${shown}; the reference never makes it: a defect` });
  };
  for (const got of candidate.values()) extra(got, 'in the compared events');
  for (const got of seen.values()) if (got.index >= reachedTo && !candidate.has(got.name)) extra(got, 'past the first difference (observed)');
  return findings;
}

function durabilityOracle(context) {
  const findings = [];
  const durable = new Map(); // construction -> Set of `${taskId}|${status}|${leaseToken}`
  const tuple = (task) => `${task.taskId}|${task.status}|${task.leaseToken ?? null}|${task.finishedAt ?? null}`;
  const hold = (c, state) => { if (!durable.has(c)) durable.set(c, new Set()); for (const task of state?.tasks ?? []) { durable.get(c).add(tuple(task)); durable.get(c).add(`${task.taskId}|${task.status}|${task.leaseToken ?? null}`); } };
  const resolutions = [...context.saves.filter((save) => save.resolvedAt !== null).map((save) => ({ index: save.resolvedAt, c: save.c, state: save.state })), ...context.loads.filter((load) => load.state).map((load) => ({ index: load.resolvedAt, c: load.c, state: load.state }))].sort((a, b) => a.index - b.index);
  let next = 0;
  const advance = (index) => { while (next < resolutions.length && resolutions[next].index < index) { hold(resolutions[next].c, resolutions[next].state); next += 1; } };
  for (const [index, event] of context.events.entries()) {
    advance(index);
    if (event.kind === 'port' && LAUNCH.has(nameOf(event))) {
      const task = P(event, 'args')?.[0] ?? {};
      // A launch is durable once a resolved save (or the loaded state) holds the task active with that lease token:
      // starting (an admission), or running (recovery's relaunch of a task the crashed instance had accepted,
      // recoverTask's `relaunch` branch, which launches the current record without a new save: restart-mixed).
      const held = durable.get(event.c);
      if (!held?.has(`${task.taskId}|starting|${task.leaseToken ?? null}`) && !held?.has(`${task.taskId}|running|${task.leaseToken ?? null}`)) {
        findings.push({ rule: 'durability', kind: 'fail', at: index + 1, detail: `${nameOf(event)} of ${task.taskId} (lease ${task.leaseToken}) at event ${index + 1}: no resolved save before it holds that task starting or running with that lease token` });
      }
    }
    if (event.kind === 'settle' && event.head.outcome === 'resolve' && WAITERS.has(context.calls.get(`${event.c}:${event.head.call}`))) {
      const value = P(event, 'value');
      for (const task of tasksIn(value)) {
        if (!durable.get(event.c)?.has(tuple(task))) findings.push({ rule: 'durability', kind: 'fail', at: index + 1, detail: `${context.calls.get(`${event.c}:${event.head.call}`)} (call ${event.head.call}) resolves with task ${task.taskId} ${task.status} at event ${index + 1}, which no resolved save before it holds` });
      }
    }
  }
  return findings.slice(0, 8);
}
const tasksIn = (value) => {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(tasksIn);
  if (typeof value.taskId === 'string' && typeof value.status === 'string' && 'leaseToken' in value) return [value];
  return value.task ? tasksIn(value.task) : [];
};

/** Whether a construction was given the admitLaunch hook (missing or null is not given: the scheduler falls back with `??`). */
const hasAdmitHook = (given) => given?.admitLaunch !== undefined && given?.admitLaunch !== null;

function globalAssertions(refContext, context, { complete }) {
  const findings = [];
  for (const save of context.saves) {
    for (const task of save.state?.tasks ?? []) {
      const kind = task?.waitingReason?.kind;
      if (kind === 'capacity' || kind === 'system_pressure') {
        // Only the admitLaunch hook (design §2.2 place 1, inert in production) writes these; a state loaded with one keeps it.
        const hooked = hasAdmitHook(context.options.get(save.c));
        const carried = context.loads.some((load) => load.c === save.c && load.resolvedAt < save.index && (load.state?.tasks ?? []).some((item) => item.taskId === task.taskId && item.waitingReason?.kind === kind));
        if (hooked || carried) context.notes.push({ rule: 'waiting-capacity', kind: 'info', at: save.index + 1, detail: `save ${save.number} of construction ${save.c}: task ${task.taskId} held with waitingReason ${kind}, ${hooked ? 'the construction was given admitLaunch' : 'carried from the loaded state'}` });
        else findings.push({ rule: 'waiting-capacity', kind: 'fail', at: save.index + 1, detail: `save ${save.number} of construction ${save.c}: task ${task.taskId} is held with waitingReason ${kind} (no admitLaunch hook was given, no loaded state carried it)` });
      }
      if (kind === 'prerequisites') {
        const want = refContext.saves.find((item) => item.c === save.c && item.number === save.number);
        if (!want?.state?.tasks?.some((item) => item.taskId === task.taskId && item.waitingReason?.kind === 'prerequisites')) findings.push({ rule: 'waiting-prerequisites', kind: 'fail', at: save.index + 1, detail: `save ${save.number} of construction ${save.c}: task ${task.taskId} is held for prerequisites where the reference's save ${save.number} does not hold it` });
      }
    }
  }
  for (const [index, event] of context.events.entries()) {
    if (event.kind !== 'port' || nameOf(event) !== 'admitLaunch') continue;
    const given = context.options.get(event.c);
    if (!hasAdmitHook(given)) findings.push({ rule: 'admit-launch', kind: 'fail', at: index + 1, detail: `admitLaunch called at event ${index + 1} by construction ${event.c}, which was not given the hook` });
  }
  // Active tasks at the end of each step (the latest save of each construction made by then), steps both traces finished.
  const counts = (ctx) => {
    const out = [];
    for (const [ordinal, entry] of ctx.steps.entries()) {
      const end = ctx.steps[ordinal + 1]?.index ?? ctx.events.length;
      if (end > ctx.events.length) break;
      const latest = new Map();
      for (const save of ctx.saves) if (save.index < end) latest.set(save.c, save);
      let active = 0;
      for (const save of latest.values()) active += (save.state?.tasks ?? []).filter((task) => task.status === 'starting' || task.status === 'running').length;
      out.push({ index: entry.index, end, active, closed: ctx.steps[ordinal + 1] !== undefined || complete });
    }
    return out;
  };
  const want = counts(refContext);
  const got = counts(context);
  for (const [ordinal, entry] of got.entries()) {
    if (!entry.closed || !want[ordinal] || want[ordinal].index !== entry.index) continue;
    if (entry.end > context.events.length) continue;
    if (entry.active !== want[ordinal].active) { findings.push({ rule: 'active-count', kind: 'fail', at: entry.end, detail: `at the end of step ${ordinal + 1} (input #${entry.index + 1}) the candidate has ${entry.active} task(s) starting or running in its latest saves, the reference ${want[ordinal].active}` }); break; }
  }
  return findings;
}

/**
 * The assertions of §5 that need no reference, on the candidate's observed run past the first difference (events
 * from `from` on): no capacity or system-pressure hold and no admitLaunch call unless the construction was given the
 * hook (a hold carried by a loaded state is allowed, as on the compared events).
 */
function observedAssertions(context, { from = 0 } = {}) {
  const findings = [];
  for (const save of context.saves) {
    if (save.index < from) continue;
    for (const task of save.state?.tasks ?? []) {
      const kind = task?.waitingReason?.kind;
      if (kind !== 'capacity' && kind !== 'system_pressure') continue;
      const hooked = hasAdmitHook(context.options.get(save.c));
      const carried = context.loads.some((load) => load.c === save.c && load.resolvedAt < save.index && (load.state?.tasks ?? []).some((item) => item.taskId === task.taskId && item.waitingReason?.kind === kind));
      if (!hooked && !carried) { findings.push({ rule: 'waiting-capacity', kind: 'fail', at: save.index + 1, detail: `past the first difference (observed): save ${save.number} of construction ${save.c} holds task ${task.taskId} with waitingReason ${kind} (no admitLaunch hook was given, no loaded state carried it)` }); return findings; }
    }
  }
  for (const [index, event] of context.events.entries()) {
    if (index < from || event.kind !== 'port' || nameOf(event) !== 'admitLaunch') continue;
    const given = context.options.get(event.c);
    if (!hasAdmitHook(given)) { findings.push({ rule: 'admit-launch', kind: 'fail', at: index + 1, detail: `past the first difference (observed): admitLaunch called by construction ${event.c}, which was not given the hook` }); break; }
  }
  return findings;
}

/** Shape of a tree, for the vectors' own use. */
export const shapeOf = shape;
