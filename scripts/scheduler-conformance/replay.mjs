// Replayer of the scheduler conformance harness (design file 30 §4.3, package
// O0c). It feeds a recorded case's inputs to a candidate (candidate.mjs: here
// a second copy of the scheduler package, loaded from the run root) and
// requires the candidate to produce exactly the recorded trace, in exactly
// the recorded total order: every output (port calls with their arguments,
// timer sets and clears, returns, throws, settlements, aborts it issues,
// saves and their ledger digests) and every input it asks for (option reads,
// clock values, identifier and hidden draws by named site, environment
// reads, port answers), event for event, value for value.
//
// Delivery. Every input that arrives on its own (a member call, a control or
// callback call, a timer fire, an abort, a promise answer's settlement, a
// step marker) carries the place the recorder could show it arrived at
// (recorder.mjs, "the rest rule"), and is delivered there, never by a search:
// - rest: when every event the recording places before it has been produced
//   and the candidate is quiescent (a drain ends with two setImmediate
//   boundaries in a row that show no activity; every port is the host's and
//   every timer the candidate's, so nothing but microtasks can be pending);
// - during: inside the port call the recording places it in, synchronously,
//   before the port answers;
// - group: with its step marker's group (`in step`, driver.mjs), in marker
//   order, in one macrotask, as the driver delivered them;
// - return: the port's promise is settled when the port returns;
// - with call k: right after call k's synchronous delivery returns, before any
//   microtask runs (the same synchronous run as that call's return);
// - settle after call k: in a reaction registered right after the candidate's
//   own observer of call k's promise (the continuation of a caller awaiting it).
// An input the candidate asks for is answered from the event at the cursor,
// which must be that input (same kind, object, key, site, port); identifiers
// are served from their site's queue, in the site's order.
//
// Busy inputs. The recorder marks `busy` an input it cannot show to have
// arrived at one of those places (the scheduler may have had work queued).
// Where a busy input arrived is not in the recording, so a case is compared
// strictly up to its first busy input (trace.mjs `casePlacement`, read from the
// recording alone, before the replay) and reported `partial` with that prefix,
// never as a reproduction of the whole case; a case whose first input is busy
// is `crossed`. Nothing the candidate does changes that classification: an
// event at the position of an input not yet delivered is `order`, different.
//
// Outcomes per case: reproduced (every event); partial (every event before its
// first busy input); crossed (its first input is busy: nothing compared);
// unrecordable (the recording's own flags, or a value the replay cannot place,
// named); empty (the test built no scheduler); different (a named check, with
// the first differing event); not-ported (a candidate other than the
// JavaScript scheduler refused what the case needs: not judged, never a pass).
//
// Comparison is exact. Each event is compared when it is produced (its kind,
// construction, numbers, names and every value, each value alone); at the end
// (of the whole case, or of the compared prefix) each save's ledger digest is
// recomputed with the reference encoder, every object that crossed must still
// hold what it held when it crossed, and the values are compared in one
// identity scope (which objects are one object across events: aliasing).
// Two event members are recording
// annotations about the test's side, never the scheduler's, and are left out
// of the comparison by name: `late` (the owning test had ended) and
// `mutatedByReceiver` (the test changed a value after receiving it).
//
//   bun scripts/scheduler-conformance/replay.mjs --copy=<package copy> --json=<out> <container>...
// replays every case of the containers against the copy (closure.mjs makes
// the copy and runs this; one container file per process keeps memory bounded).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCodecContext, emitSlots, snapshot, stringifyTree } from '../client-conformance/codec.mjs';
import { CANDIDATE_FILE, candidateAls, createJsCandidate, ReplayInputError } from './candidate.mjs';
import { compareCase, compareEvent, INDEPENDENCE, LAUNCH_PORTS, laneOf, plain } from './compare.mjs';
import { bindFrom, contentText, decodeValue, pathTo, shape, shapeText, TAG, treeDifference, Unplaceable } from './replay-values.mjs';
import { casePlacement, caseEvents, importClosure, isArrivedEvent, loadTarget, readContainer, sha256 } from './trace.mjs';

export { decodeValue } from './replay-values.mjs';

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(HARNESS_DIR, '../..');
export const PACKAGE_DIR = path.join(REPOSITORY_ROOT, 'packages/orchestration-runtime');
export const TARGET_SPEC = path.join(HARNESS_DIR, 'target.json');
const REPLAY_FILE = realpathSync(fileURLToPath(import.meta.url));

export const OUTCOMES = Object.freeze(['reproduced', 'partial', 'crossed', 'unrecordable', 'empty', 'different', 'inconclusive', 'not-ported']);
/**
 * How a case is compared (compare.mjs). `compare`: the comparer's rules and
 * oracles run on what was compared (default on); `reads`: `exact` (the
 * JavaScript closure's, default) or `free` (OD2's read mode for a candidate
 * that is not the JavaScript scheduler, reported on every use);
 * `independence`: the independence table (default compare.mjs INDEPENDENCE,
 * which ships empty: strict total order; DESIGN_INDEPENDENCE is the design's
 * two entries, for a run that is given them).
 */
export const DEFAULT_MODE = Object.freeze({ compare: true, reads: 'exact', independence: INDEPENDENCE });
/** The named checks of a replay: each difference is reported by one of them, with the first differing event. */
export const REPLAY_CHECKS = Object.freeze({
  order: 'at each position the candidate produces the event the recording has there: its kind, construction, numbers and names (and none where the recording has an input not yet delivered)',
  value: 'every value at an event equals the recording\'s, codec tree for codec tree',
  missing: 'the candidate, quiescent, produces the event the recording has next (an input placed in a settlement\'s continuation or at a port\'s return was delivered there)',
  extra: 'the candidate produces nothing after the recording\'s last event',
  input: 'every input the recording delivers can be delivered: a timer the candidate set, a port it called, a control it handed out',
  draw: 'an identifier is served from the queue of the site the candidate draws at, in that site\'s order',
  ledger: 'every save\'s state, encoded by the reference ledger encoder, has the recording\'s digest',
  'case-bytes': 'the values of the case (or of its compared prefix), emitted in one identity scope, equal the recording\'s with the same objects shared across events (aliasing)',
  mutated: 'no object that crossed the boundary has other content when the case ends',
  placement: 'every arrived input was delivered where its recorded place says: at confirmed quiescence, in its step marker\'s group, inside its port call, at its port\'s return, in its settlement\'s continuation',
  quiescence: 'the candidate reaches quiescence: a drain ends with two quiet event-loop turns',
  'hidden-site': 'every hidden read of the candidate is at a line the target spec names',
  'real-timer': 'the candidate sets no real timer (every timer is the candidate adapter\'s)',
  compare: 'the comparer (compare.mjs) finds no failure on what was compared: its rules, oracles and global assertions, each reported by its own name (`rule`)',
  'option-varies': 'read mode free only: the recording reads one option key with more than one value, so the count and position of its reads are contract (inconclusive)',
  'option-unread': 'read mode free only: the candidate reads an option key the recording never read, whose value the host cannot give (inconclusive)',
  'not-ported': 'a candidate that is not the JavaScript scheduler refused what the case needs (a member or path it does not reproduce): the case is not judged, never a pass (not-ported)',
  'candidate-process': 'a candidate in another process answers by its protocol, within its deadline, and does not end while the case runs',
});

/** An input that arrives on its own (the host delivers it), not one the candidate asks for. */
export const isArrived = isArrivedEvent;
// Recording annotations about the test's side, never compared; `place` and `after` say where an input arrived (the
// host delivers it there; the candidate never reports them).
const ANNOTATIONS = new Set(['late', 'mutatedByReceiver']);
const PLACEMENT_KEYS = new Set(['place', 'after']);
const SLOT = /^=[0-9a-f]{16}$/;
const isRef = (value) => value !== null && typeof value === 'object' && typeof value.slot === 'number';

class ReplayStop extends Error {
  constructor() { super('scheduler replay: the case stopped'); this.name = 'ReplayStop'; }
}

// ------------------------------------------------------------------ the copy

/**
 * Copies the package's production modules (every non-test `.js` file) and
 * the rest of the scheduler's import closure (a module of
 * another package it imports) into `<runRoot>/<name>/`, at their
 * repository-relative paths, and returns the copy's package directory.
 * `replace` plants differences: `{ file, anchor, with }`, the anchor must
 * occur exactly once in that file of the package.
 */
export function prepareCopy(runRoot, { name = 'copy', replace = [] } = {}) {
  const root = path.join(runRoot, name);
  // The repository the package really is in (the package may be reached through a link).
  const repository = path.resolve(realpathSync(PACKAGE_DIR), path.relative(PACKAGE_DIR, REPOSITORY_ROOT));
  const relativeToRepo = (file) => path.relative(repository, realpathSync(file));
  const files = new Set(importClosure(path.join(PACKAGE_DIR, 'scheduler.js')).map(relativeToRepo));
  for (const entry of readdirSync(PACKAGE_DIR)) {
    if (entry.endsWith('.js') && !entry.endsWith('.test.js')) files.add(relativeToRepo(path.join(PACKAGE_DIR, entry)));
  }
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(repository, file), path.join(root, file));
  }
  const dir = path.join(root, path.relative(REPOSITORY_ROOT, PACKAGE_DIR));
  for (const plant of replace) {
    const file = path.join(dir, plant.file);
    const text = readFileSync(file, 'utf8');
    const hits = text.split(plant.anchor).length - 1;
    if (hits !== 1) throw new Error(`scheduler replay: planted anchor occurs ${hits} times in ${plant.file}: ${plant.anchor.slice(0, 80)}`);
    writeFileSync(file, text.replace(plant.anchor, () => plant.with));
  }
  return realpathSync(dir);
}

/**
 * Loads a copy: its factory and exports, the hidden-read sites found in its
 * own files by the target spec's anchors, and its provenance (the digest of
 * every module of its import closure, by the package-relative name the
 * recording's header uses, and whether the closure stays inside the copy).
 */
export async function loadCopy(dir) {
  const real = realpathSync(dir);
  const spec = JSON.parse(readFileSync(TARGET_SPEC, 'utf8'));
  const specFile = path.join(real, '..', 'replay-target.json');
  writeFileSync(specFile, JSON.stringify({ ...spec, module: `./${path.basename(real)}/scheduler.js`, savedState: null }));
  const target = loadTarget(specFile);
  const closure = importClosure(path.join(real, 'scheduler.js'));
  // The copy's root: the package directory sits at its repository-relative path below it.
  const root = path.resolve(real, path.relative(PACKAGE_DIR, REPOSITORY_ROOT));
  const outside = closure.filter((file) => !file.startsWith(`${root}${path.sep}`));
  const modules = Object.fromEntries(closure.map((file) => [path.relative(root, file).split(path.sep).join('/'), sha256(readFileSync(file))]));
  const exports = await import(pathToFileURL(path.join(real, 'scheduler.js')).href);
  const factory = exports[target.export];
  if (typeof factory !== 'function') throw new TypeError(`scheduler replay: the copy has no ${target.export}`);
  const sites = {
    files: new Set(closure),
    byLine: new Map(target.sites.filter((entry) => entry.kind !== 'helper').map((entry) => [`${entry.file}:${entry.line}:${entry.kind}`, entry.site])),
    helpers: new Set(target.sites.filter((entry) => entry.kind === 'helper').map((entry) => `${entry.file}:${entry.line}`)),
    names: new Set(target.sites.map((entry) => `${entry.site}:${entry.kind}`)),
    env: new Set(target.env),
  };
  return { dir: real, root, factory, exports, sites, modules, outside, exportName: target.export };
}

/** The reference ledger encoder (the repository's own, never the copy's), as the recorder digests saves. */
export async function loadReference() {
  const target = loadTarget(TARGET_SPEC);
  if (!target.savedState) return null;
  const encode = (await import(pathToFileURL(target.savedState.file).href))[target.savedState.export];
  return { encode, port: target.savedState.port, arg: target.savedState.arg ?? 0 };
}

// ------------------------------------------------------------------ process hooks

// Hidden reads (randomUUID, performance.now, the target's environment variables) and aborts go to the case whose
// candidate chain is running (candidate.mjs `candidateAls`). Installed once per process.
const realRandomUUID = globalThis.crypto.randomUUID;
const realPerformanceNow = globalThis.performance.now;
const realSetImmediate = globalThis.setImmediate;
// Runs the microtask queue now (Bun only): the in-port experiment of `portAnswer`.
const drainMicrotasks = typeof Bun === 'undefined' ? null : (await import('bun:jsc')).drainMicrotasks;
let hooksInstalled = false;
const abortWriters = new WeakMap();
const FRAME = /\(?((?:\/|[A-Za-z]:\\)[^():?]+)(?:\?[^():]*)?:(\d+)(?::\d+)?\)?\s*$/;
const HARNESS_FILES = new Set([REPLAY_FILE, CANDIDATE_FILE]);

function stackFrames() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 32;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  const frames = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = FRAME.exec(line.trim());
    if (match) frames.push({ file: match[1], line: Number(match[2]) });
  }
  return frames;
}

/**
 * The site of a hidden read by the candidate's copy: the first frame below
 * the harness's own must be the copy's; helper lines pass the question to
 * their caller; a read whose product frame is gone (a default parameter, a
 * tail call) is named by the member being delivered (as the recorder names
 * it). Null when no site names it.
 */
function siteOf(kind, store) {
  const { sites } = store.candidate;
  const frames = stackFrames();
  let at = 0;
  for (; at < frames.length && HARNESS_FILES.has(frames[at].file); at += 1);
  const member = store.inst.delivering[store.inst.delivering.length - 1];
  const byMember = () => (typeof member === 'string' && sites.names.has(`${member}:${kind}`) ? member : null);
  if (at >= frames.length || !sites.files.has(frames[at].file)) return byMember();
  for (let index = at; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!sites.files.has(frame.file)) return HARNESS_FILES.has(frame.file) ? byMember() : null;
    if (sites.helpers.has(`${frame.file}:${frame.line}`)) continue;
    return sites.byLine.get(`${frame.file}:${frame.line}:${kind}`) ?? null;
  }
  return null;
}

function hidden(kind, fields, real) {
  const store = candidateAls.getStore();
  if (!store?.host) return real();
  const site = siteOf(kind, store);
  if (!site) return store.host.refuse('hidden-site', `a hidden ${kind} read by the copy at a line no site of the target spec names`);
  return store.host.ask(store.inst.n, kind, { ...fields(site) });
}

export function installReplayHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true, writable: true, enumerable: false,
    value: function randomUUID() { return hidden('draw', (site) => ({ site, source: 'hidden' }), () => Reflect.apply(realRandomUUID, globalThis.crypto, [])); },
  });
  Object.defineProperty(globalThis.performance, 'now', {
    configurable: true, writable: true, enumerable: true,
    value: function now() { return hidden('clock', (site) => ({ source: 'performance', site }), () => Reflect.apply(realPerformanceNow, globalThis.performance, [])); },
  });
  const realEnv = process.env;
  process.env = new Proxy(realEnv, {
    get(object, key) {
      const store = candidateAls.getStore();
      if (typeof key === 'string' && store?.host && store.candidate.sites.env.has(key)) return hidden('env', (site) => ({ site, name: key }), () => Reflect.get(object, key));
      return Reflect.get(object, key);
    },
  });
  // An abort through a controller is written before the signal dispatches (as the recorder writes it).
  const realAbort = AbortController.prototype.abort;
  const controllerSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, 'signal').get;
  const abortedState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
  const defaultAbort = (() => { const probe = new AbortController(); Reflect.apply(realAbort, probe, []); const reason = probe.signal.reason; return { message: reason.message, name: reason.name }; })();
  Object.defineProperty(AbortController.prototype, 'abort', {
    configurable: true, writable: true, enumerable: true,
    value: function abort(...args) {
      const signal = Reflect.apply(controllerSignal, this, []);
      const writers = abortWriters.get(signal);
      if (!writers || Reflect.apply(abortedState, signal, [])) return Reflect.apply(realAbort, this, args);
      const reason = args[0] === undefined ? new DOMException(defaultAbort.message, defaultAbort.name) : args[0];
      for (const write of writers) write(reason);
      return Reflect.apply(realAbort, this, [reason]);
    },
  });
  // The candidate's timers are the adapter's: a real one set while a case runs is reported.
  for (const name of ['setTimeout', 'setInterval']) {
    const real = globalThis[name];
    globalThis[name] = function (...args) {
      const store = candidateAls.getStore();
      if (store?.host) store.host.note('real-timer', `the candidate called ${name}`);
      return Reflect.apply(real, this, args);
    };
  }
  // An unhandled rejection while a case runs is counted on that case and reported with its result (`unhandledRejections`):
  // a test's own handlers are not in a replay, so it is information, not a difference. One after the case stopped is
  // the host's own stop unwinding the candidate.
  process.on('unhandledRejection', () => { if (liveHost && liveHost.live && !liveHost.stopped) liveHost.unhandled += 1; });
}
let liveHost = null;

const boundary = () => new Promise((resolve) => { realSetImmediate(resolve); });

// ------------------------------------------------------------------ one case

/**
 * Replays one recorded case. `record` is a case line of a container read by
 * `readContainer`, `resolve` its slot resolver, `header` the container's
 * header; `copy` a loaded copy (loadCopy), `reference` the reference ledger
 * encoder (loadReference). Returns `{ outcome, check?, detail?, at?, expected?,
 * got?, events, prefix, produced, delivered, busy?, unhandledRejections }`:
 * `events` the case's recorded events, `prefix` how many of them are compared
 * (all of them, or those before the first busy input; trace.mjs
 * `casePlacement`, read from the recording before anything runs), `produced`
 * how many the candidate produced and were compared.
 */
export async function replayCase({ record, resolve, header, copy, reference, makeCandidate = createJsCandidate, mode = DEFAULT_MODE }) {
  const base = { id: record.id, file: record.file, events: 0, prefix: 0, recordedEvents: record.events };
  if (record.outcome !== 'recorded') {
    if (record.outcome === 'empty') return { ...base, outcome: 'empty', reason: 'the test built no scheduler' };
    return { ...base, outcome: 'unrecordable', reason: record.flags.length ? `recording: ${record.flags.join(', ')}` : `recording: ${record.outcome}` };
  }
  const expected = caseEvents(record);
  base.events = expected.length;
  if (expected.some((event, index) => event.at !== index + 1)) return { ...base, outcome: 'different', check: 'order', detail: 'the recording\'s `at` order has a gap' };
  const { limit, busy } = casePlacement(record, expected);
  base.prefix = limit;
  const busyText = busy ? `${describe(busy, busy.c)} (#${limit + 1}) is marked ${JSON.stringify(busy.place ?? null)}: the recorder could not show where it arrived (the scheduler may have had work queued)` : null;
  if (limit === 0) return { ...base, outcome: 'crossed', busy: busyText, detail: `nothing compared: its first input ${busyText}` };
  // OD2 read mode (never the JavaScript closure's): the recorded reads leave the order and are served by key.
  let reads = null;
  let compared = limit;
  let replayed = expected;
  if (mode.reads === 'free') {
    reads = readsByKey(expected.slice(0, limit), resolve);
    if (reads.varies.length) return { ...base, outcome: 'inconclusive', check: 'option-varies', reason: 'option-varies', readMode: { recorded: reads.count, varies: reads.varies }, detail: `read mode free: the recording reads ${reads.varies.slice(0, 4).join(', ')} with more than one value` };
    compared -= expected.slice(0, limit).filter((event) => event.dir === 'in' && event.kind === 'read').length;
    replayed = renumber(expected.filter((event) => !(event.dir === 'in' && event.kind === 'read')));
  }
  const host = new Host({ expected: replayed, limit: compared, resolve, header, copy, reference, makeCandidate, mode, reads });
  try {
    const result = await host.run();
    if (result.outcome === 'partial') return { ...base, ...result, busy: busyText, detail: `compared ${limit} of ${expected.length} events: ${busyText}` };
    return { ...base, ...result };
  } finally { host.close(); }
}

/** The recorded reads of a compared prefix by key (object, op, key): their one value, and the keys read with more than one. */
function readsByKey(events, resolve) {
  const table = new Map();
  const varies = new Set();
  let count = 0;
  for (const event of events) {
    if (event.dir !== 'in' || event.kind !== 'read') continue;
    count += 1;
    const key = readKeyOf(event.c, event.object, event.op, typeof event.key === 'string' && !SLOT.test(event.key) ? event.key : `<${JSON.stringify(resolve(event.key))}>`);
    const text = `${JSON.stringify(event.found ?? null)}|${JSON.stringify(event.supplied ?? null)}|${'value' in event ? shapeText(resolve(event.value)) : '-'}`;
    if (!table.has(key)) table.set(key, { event, text });
    else if (table.get(key).text !== text) varies.add(key);
  }
  return { table, varies: [...varies], count };
}
const readKeyOf = (construction, object, op, key) => `${construction}|${object}|${op ?? 'get'}|${key}`;

/** `at` and the per-construction `seq` of a list of recorded events made positional again (after reads were taken out). */
function renumber(events) {
  const seq = new Map();
  return events.map((event, index) => { const next = (seq.get(event.c) ?? 0) + 1; seq.set(event.c, next); return { ...event, at: index + 1, seq: next }; });
}

class Host {
  constructor({ expected, limit = expected.length, resolve, header, copy, reference, makeCandidate, mode = DEFAULT_MODE, reads = null }) {
    this.options = { limit, resolve, header, copy, reference, makeCandidate, mode, reads };
    this.expected = expected;
    this.recorded = expected.slice(); // the recording's order, never moved (the comparer's reference)
    this.limit = limit;
    this.mode = mode;
    this.reads = reads;
    this.freeReads = 0;
    this.independenceUses = [];
    // Where the recording places the inputs that are delivered by a mechanism, not at quiescence: index -> how.
    this.placements = new Map();
    this.settledAt = new Map(); // `${construction}:${port}` -> index of the recording's settlement of that port's promise
    for (const [index, event] of expected.entries()) {
      if (event.kind === 'answer' && (event.outcome === 'resolve' || event.outcome === 'reject')) this.settledAt.set(`${event.c}:${event.port}`, index);
      if (index >= limit || !isArrived(event)) continue;
      if (event.place === 'return') this.placements.set(index, 'at-return');
      if (event.place === 'settle') this.placements.set(index, 'after-settle');
    }
    this.inPortMicrotasks = null;
    this.resolveTree = (ref) => resolve(ref);
    this.header = header;
    this.copy = copy;
    this.reference = reference;
    this.produced = [];
    this.snaps = [];
    this.slotValues = [];
    this.slotPlaces = []; // slot index -> [event index, field]
    this.names = new WeakMap();
    this.rawOf = new WeakMap();
    this.codec = createCodecContext({ names: this.names, unwrap: (item) => this.rawOf.get(item) });
    this.bindings = new Map(); // identity number of the recording -> the live object
    this.delivered = new Set(); // indices of expected arrived inputs the host delivered
    this.seq = new Map();
    this.portStack = new Map();
    this.signals = new Map(); // construction -> Map(signal -> number)
    this.inSignals = new Map(); // construction -> Map(number -> { signal, controller })
    this.draws = this.drawQueues();
    this.activity = 0;
    this.quietAt = -1;
    this.stopped = null;
    this.audit = [];
    this.unhandled = 0;
    this.live = true;
    liveHost = this;
    this.candidate = makeCandidate({ factory: copy.factory, host: this, names: this.names, rawOf: this.rawOf, clock: header.clock, sites: copy.sites, exportName: copy.exportName, savedState: reference ? { port: reference.port, arg: reference.arg } : null, exports: copy.exports });
  }

  close() {
    this.live = false;
    if (liveHost === this) liveHost = null;
    this.candidate.close?.();
  }

  /** Whether the recording places an input in the continuation of call `call`'s settlement (`returnedPromise` delivers it). */
  continuationPlaced(c, call) {
    const settle = this.expected.findIndex((event) => event.c === c && event.kind === 'settle' && event.call === call);
    return settle >= 0 && this.placements.get(settle + 1) === 'after-settle' && this.expected[settle + 1].after === call;
  }

  /**
   * A member's promise the candidate returned (candidate.mjs `run`, right after its own observer): when the
   * recording places the event after this call's settlement in a reaction that settlement queued (`settle`), the
   * host delivers it where the recorder's window put it. In the recording the caller's reactions were queued by the
   * recorder's own reaction to the settlement, behind every job already queued then; here a reaction registered
   * right after the candidate's observer (so it runs right after it) queues the delivery as a microtask, which is
   * behind the same jobs.
   */
  returnedPromise(c, call, promise) {
    const settle = this.expected.findIndex((event) => event.c === c && event.kind === 'settle' && event.call === call);
    if (settle < 0 || this.placements.get(settle + 1) !== 'after-settle' || this.expected[settle + 1].after !== call) return;
    const deliver = () => { if (this.stopped || !this.live) return; try { this.deliverAt(settle + 1, 'after-settle'); } catch (error) { if (!(error instanceof ReplayStop)) throw error; } };
    const queue = () => { queueMicrotask(deliver); };
    Promise.prototype.then.call(promise, queue, queue);
  }

  /**
   * What the timer the candidate is setting now returns as its handle, as the test's scheduleTimeout did: the
   * recorded `handle` of the timer.set at the cursor (`object` when the recording has none there; the produced
   * event then differs anyway).
   */
  timerHandle(c) {
    const want = this.expected[this.produced.length];
    return want && want.c === c && want.kind === 'timer.set' && want.handle === 'primitive' ? 'primitive' : 'object';
  }

  /** Identifiers per construction and site, in the order the recording drew them. */
  drawQueues() {
    const queues = new Map();
    for (const event of this.expected) {
      if (event.kind !== 'draw') continue;
      const key = `${event.c}:${event.site}`;
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push(event.value);
    }
    return queues;
  }

  // ---------------------------------------------------------------- stopping

  stop(result) {
    if (!this.stopped) this.stopped = { ...result, at: result.at ?? this.produced.length + 1, ...(process.env.DEVRYAN_REPLAY_DEBUG ? { stack: new Error().stack, audit: this.audit.slice(-12) } : {}) };
    throw new ReplayStop();
  }

  /** A finding that stops the case from inside the candidate. */
  refuse(check, detail) { return this.stop({ outcome: 'different', check, detail }); }

  note(check, detail) { if (!this.stopped) this.stopped = { outcome: 'different', check, detail, at: this.produced.length + 1 }; }

  // ---------------------------------------------------------------- what the candidate reports

  slot(construction, value, dir) {
    if (this.stopped || !this.live) throw new ReplayStop();
    let snap;
    try {
      snap = snapshot(value, this.codec);
    } catch (error) {
      snap = snapshot({ unencodable: String(error?.message ?? error) }, this.codec);
    }
    this.snaps.push(snap);
    this.slotValues.push(value !== null && (typeof value === 'object' || typeof value === 'function') ? value : null);
    const ref = { slot: this.snaps.length - 1 };
    let signals = null;
    for (const item of snap.nodes.keys()) {
      if (this.rawOf.get(item) !== undefined) continue;
      if (item !== null && typeof item === 'object' && Object.prototype.isPrototypeOf.call(AbortSignal.prototype, item)) (signals ??= []).push(item);
    }
    if (signals && dir) ref.signals = signals.map((signal) => ({ signal: this.watch(construction, signal, dir), at: pathTo(value, signal, this.rawOf) }));
    return ref;
  }

  /** A signal's number in its construction, watched on first sight (recorder.mjs `watch`). */
  watch(construction, signal, dir) {
    if (!this.signals.has(construction)) this.signals.set(construction, new Map());
    const numbers = this.signals.get(construction);
    let number = numbers.get(signal);
    if (number !== undefined) return number;
    number = numbers.size + 1;
    numbers.set(signal, number);
    if (!signal.aborted) {
      let done = false;
      const write = (reason) => {
        if (done || !this.live || this.stopped) return;
        done = true;
        try {
          if (dir === 'in') this.input(construction, 'abort', { signal: number, reason: this.slot(construction, reason, 'in') });
          else this.output(construction, 'abort', { signal: number, reason: this.slot(construction, reason, 'out') });
        } catch (error) { if (!(error instanceof ReplayStop)) throw error; }
      };
      const list = abortWriters.get(signal);
      if (list) list.push(write); else abortWriters.set(signal, [write]);
      signal.addEventListener('abort', () => { write(signal.reason); }, { once: true });
    }
    return number;
  }

  input(construction, kind, fields) {
    const stack = this.portStack.get(construction);
    const during = stack?.length ? stack[stack.length - 1] : undefined;
    return this.event(construction, 'in', kind, during === undefined ? fields : { ...fields, during });
  }

  output(construction, kind, fields) { return this.event(construction, 'out', kind, fields); }

  /** Records a produced event and compares it with the recording's event at its position. */
  event(construction, dir, kind, fields) {
    if (this.stopped || !this.live) throw new ReplayStop();
    const { index, entry } = this.record(construction, dir, kind, fields);
    this.compare(index);
    // The compared prefix ends here: the recording's next event is a busy input, whose position it does not hold.
    if (this.produced.length === this.limit && this.limit < this.expected.length) {
      this.stopped = { outcome: 'partial' };
      throw new ReplayStop();
    }
    return entry;
  }

  /** Records a produced event (its signals listed by field) without comparing it; `{ index, entry }`. */
  record(construction, dir, kind, fields) {
    this.activity += 1;
    const index = this.produced.length;
    const seq = (this.seq.get(construction) ?? 0) + 1;
    this.seq.set(construction, seq);
    const entry = { seq, at: index + 1, dir, kind };
    let signals;
    for (const key of Object.keys(fields)) {
      const item = fields[key];
      if (isRef(item) && item.signals) { signals = [...(signals ?? []), ...item.signals.map((found) => ({ ...found, in: key }))]; entry[key] = { slot: item.slot }; } else entry[key] = item;
    }
    if (signals) entry.signals = signals;
    this.produced.push({ c: construction, entry });
    for (const [key, item] of Object.entries(entry)) if (isRef(item)) this.slotPlaces[item.slot] = [index, key];
    return { index, entry };
  }

  /** The produced event `index` against the recording's (online: each value alone; identity is checked at the end). */
  compare(index) {
    const { c, entry } = this.produced[index];
    const want = this.expected[index];
    const shown = describe(entry, c);
    if (!want) this.stop({ outcome: 'different', check: 'extra', detail: `the candidate produced ${shown} after the recording's last event`, got: shown });
    if (isArrived(want) && !this.delivered.has(index)) {
      this.stop({ outcome: 'different', check: 'order', detail: `the candidate produced ${shown} where the recording delivers ${describe(want, want.c)} (placed ${want.place})`, expected: describe(want, want.c), got: shown });
    }
    const head = (event) => JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => !ANNOTATIONS.has(key) && !PLACEMENT_KEYS.has(key) && key !== 'c').map(([key, value]) => [key, isRef(value) || (typeof value === 'string' && SLOT.test(value)) ? '<value>' : key === 'ledger' ? '<ledger>' : value])));
    if (want.c !== c || head(want) !== head(entry)) {
      // The independence table, the only relaxation: the recording's unit of this lane moves before the units of
      // independent lanes ahead of it, and the comparison is made again (reported as a use).
      if (this.relax(index)) return this.compare(index);
      this.stop({ outcome: 'different', check: 'order', detail: `the candidate produced ${shown} where the recording has ${describe(want, want.c)}`, expected: describe(want, want.c), got: shown });
    }
    for (const [key, item] of Object.entries(entry)) {
      if (!isRef(item)) continue;
      const tree = emitSlots([this.snaps[item.slot]])[0];
      const recorded = this.resolveTree(want[key]);
      if (shapeText(tree) !== shapeText(recorded)) {
        this.stop({ outcome: 'different', check: entry.kind === 'draw' ? 'draw' : 'value', detail: `${describe(want, want.c)}: ${key} ${treeDifference(shape(recorded), shape(tree))}`, expected: describe(want, want.c), got: shown });
      }
      if (entry.dir === 'out') bindFrom(recorded, this.slotValues[item.slot] ?? undefined, this.bindings);
    }
  }

  /**
   * The independence table (compare.mjs INDEPENDENCE), online: the candidate produced at `index` an event of lane L
   * where the recording has an event of a lane the table makes independent of L. If the recording's next unit of
   * lane L (a port call with its synchronous answer, or a timer set) follows after only units of lanes independent
   * of L (no input, nothing else), that unit moves to `index`, ahead of them; the recording's positions and port
   * numbers are made those of the new order. Order within a lane is never changed. Returns whether it moved.
   */
  relax(index) {
    const table = this.mode.independence ?? [];
    if (!table.length) return false;
    const { c, entry } = this.produced[index];
    const lane = laneOf({ kind: entry.kind, head: entry });
    if (lane === null) return false;
    const independent = new Set(table.flatMap((item) => [`${item.lanes[0]}|${item.lanes[1]}`, `${item.lanes[1]}|${item.lanes[0]}`]));
    const unitEnd = (at) => {
      const event = this.expected[at];
      const next = this.expected[at + 1];
      return event.kind === 'port' && next && next.c === event.c && next.dir === 'in' && next.kind === 'answer' && next.port === event.port && ['return', 'throw', 'promise'].includes(next.outcome) ? at + 2 : at + 1;
    };
    const skipped = [];
    for (let at = index; at < this.limit;) {
      const event = this.expected[at];
      const end = unitEnd(at);
      const itsLane = laneOf({ kind: event.kind, head: event });
      if (at > index && itsLane === lane) {
        if (event.c !== c || event.dir !== entry.dir || event.kind !== entry.kind || event.name !== entry.name || end > this.limit) return false;
        const unit = this.expected.slice(at, end);
        const block = this.expected.slice(index, at);
        this.expected.splice(index, end - index, ...unit, ...block);
        this.renumberExpected();
        this.independenceUses.push({ rule: 'independence', kind: 'info', at: index + 1, lanes: [lane, ...new Set(skipped)], detail: `${describe(this.expected[index], c)} comes before ${block.length} recorded event(s) of lane ${[...new Set(skipped)].join(', ')} (independence table)` });
        return true;
      }
      if (itsLane === null || !independent.has(`${itsLane}|${lane}`) || isArrived(event)) return false;
      skipped.push(itsLane);
      at = end;
    }
    return false;
  }

  /** After a move: every recorded event's `at` and per-construction `seq` positional, and port numbers by order of call. */
  renumberExpected() {
    const seq = new Map();
    const ports = new Map(); // construction -> count
    const map = new Map(); // `${c}:${old}` -> new
    for (const [index, event] of this.expected.entries()) {
      const next = (seq.get(event.c) ?? 0) + 1;
      seq.set(event.c, next);
      let changed = event.at !== index + 1 || event.seq !== next ? { ...event, at: index + 1, seq: next } : event;
      if (event.kind === 'port') {
        const number = (ports.get(event.c) ?? 0) + 1;
        ports.set(event.c, number);
        if (number !== event.port) { map.set(`${event.c}:${event.port}`, number); changed = { ...changed, port: number }; }
      }
      this.expected[index] = changed;
    }
    if (!map.size) return;
    const to = (c, number) => (typeof number === 'number' ? map.get(`${c}:${number}`) ?? number : number);
    for (const [index, event] of this.expected.entries()) {
      const out = { ...event };
      if (event.kind === 'answer') out.port = to(event.c, event.port);
      if (event.kind === 'control' || event.kind === 'callback') out.of = to(event.c, event.of);
      if (event.during !== undefined) out.during = to(event.c, event.during);
      if (event.kind === 'step' && Array.isArray(event.inputs)) out.inputs = event.inputs.map((item) => ({ ...item, ...(item.port !== undefined ? { port: to(item.construction, item.port) } : {}), ...(item.of !== undefined ? { of: to(item.construction, item.of) } : {}) }));
      this.expected[index] = out;
    }
    this.settledAt = new Map();
    for (const [index, event] of this.expected.entries()) if (event.kind === 'answer' && (event.outcome === 'resolve' || event.outcome === 'reject')) this.settledAt.set(`${event.c}:${event.port}`, index);
  }

  // ---------------------------------------------------------------- inputs the candidate asks for

  nextIsRead(construction, object, key) {
    if (this.reads) return typeof key === 'string' && this.reads.table.has(readKeyOf(construction, object, undefined, key));
    const want = this.expected[this.produced.length];
    return Boolean(want && want.c === construction && want.dir === 'in' && want.kind === 'read' && want.object === object && want.op === undefined && typeof key === 'string' && want.key === key);
  }

  /**
   * Read mode free (OD2): a read is answered from the recorded value of its key, whatever its position, and leaves no
   * event (the order is compared without reads). A key the recording never read cannot be answered: inconclusive.
   */
  freeRead(construction, fields) {
    const key = readKeyOf(construction, fields.object, fields.op, typeof fields.key === 'string' ? fields.key : `<${JSON.stringify(typeof fields.key === 'symbol' ? String(fields.key) : fields.key)}>`);
    const found = this.reads.table.get(key);
    if (!found) return this.stop({ outcome: 'inconclusive', check: 'option-unread', reason: 'option-unread', detail: `read mode free: the candidate reads ${key}, which the recording never read` });
    this.freeReads += 1;
    const want = found.event;
    const options = want.object === 'options';
    const place = { construction, context: options && fields.op === undefined ? 'option' : 'data', key: fields.key, supplied: want.supplied === true };
    if (fields.op === 'own') return { found: want.found, value: want.found && 'value' in want ? this.decodeIn(want.value, place) : undefined };
    return this.decodeIn(want.value, place);
  }

  /** Answers an input the candidate asks for from the event at the cursor, and records it. */
  ask(construction, kind, fields) {
    if (this.stopped || !this.live) throw new ReplayStop();
    if (kind === 'read' && this.reads) return this.freeRead(construction, fields);
    const index = this.produced.length;
    const want = this.expected[index];
    const scalars = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'symbol' ? String(value) : value]));
    const asked = `in ${kind} ${JSON.stringify(scalars)} (construction ${construction})`;
    // What the candidate asked for where the recording has something else is kept (its value never served), so the
    // comparer sees where the candidate went and names it.
    const keep = () => { const seq = (this.seq.get(construction) ?? 0) + 1; this.seq.set(construction, seq); this.produced.push({ c: construction, entry: { seq, at: index + 1, dir: 'in', kind, ...scalars, asked: true } }); };
    if (!want) { keep(); this.stop({ outcome: 'different', check: 'extra', at: index + 1, detail: `the candidate asked for ${asked} after the recording's last event`, got: asked }); }
    const mismatch = (check = 'order') => { keep(); this.stop({ outcome: 'different', check, at: index + 1, detail: `the candidate asked for ${asked} where the recording has ${describe(want, want.c)}`, expected: describe(want, want.c), got: asked }); };
    if (want.c !== construction || want.dir !== 'in' || want.kind !== kind) mismatch();
    switch (kind) {
      case 'read': {
        if (want.object !== fields.object || want.op !== fields.op) mismatch();
        if (fields.op !== 'keys' && !sameKey(want.key, fields.key, this.resolveTree)) mismatch();
        const options = want.object === 'options';
        const place = { construction, context: options && fields.op === undefined ? 'option' : 'data', key: fields.key, supplied: want.supplied === true };
        if (fields.op === 'own') {
          const value = want.found && 'value' in want ? this.decodeIn(want.value, place) : undefined;
          this.input(construction, 'read', { object: fields.object, op: 'own', key: this.keyField(construction, fields.key), found: want.found, ...('value' in want ? { value: this.slot(construction, value, 'in') } : {}) });
          return { found: want.found, value };
        }
        const value = this.decodeIn(want.value, place);
        const event = fields.op === undefined ? { object: fields.object, key: this.keyField(construction, fields.key) } : fields.op === 'has' ? { object: fields.object, op: 'has', key: this.keyField(construction, fields.key) } : { object: fields.object, op: 'keys' };
        this.input(construction, 'read', { ...event, value: this.slot(construction, value, 'in'), ...(want.supplied ? { supplied: true } : {}) });
        return value;
      }
      case 'clock': {
        if (want.source !== fields.source || want.site !== fields.site) mismatch();
        const value = this.decodeIn(want.value, { construction, context: 'data' });
        this.input(construction, 'clock', { source: fields.source, ...(fields.site !== undefined ? { site: fields.site } : {}), value: this.slot(construction, value, 'in') });
        return value;
      }
      case 'draw': {
        if (want.site !== fields.site) mismatch('draw');
        if (want.source !== fields.source) mismatch();
        const queue = this.draws.get(`${construction}:${fields.site}`);
        if (!queue?.length) this.stop({ outcome: 'different', check: 'draw', detail: `the candidate drew at ${fields.site} more often than the recording did` });
        const value = this.decodeIn(queue.shift(), { construction, context: 'data' });
        this.input(construction, 'draw', { site: fields.site, source: fields.source, value: this.slot(construction, value, 'in') });
        return value;
      }
      case 'env': {
        if (want.site !== fields.site || want.name !== fields.name) mismatch();
        const value = this.decodeIn(want.value, { construction, context: 'data' });
        this.input(construction, 'env', { site: fields.site, name: fields.name, value: this.slot(construction, value, 'in') });
        return value;
      }
      default: return mismatch();
    }
  }

  keyField(construction, key) { return typeof key === 'string' ? key : this.slot(construction, key, 'in'); }

  /** After a port call: the inputs the recording places inside it, then its answer (return, throw, promise). */
  portAnswer(construction, port) {
    if (this.stopped || !this.live) throw new ReplayStop();
    if (!this.portStack.has(construction)) this.portStack.set(construction, []);
    const stack = this.portStack.get(construction);
    stack.push(port);
    try {
      for (;;) {
        const index = this.produced.length;
        const want = this.expected[index];
        if (!want) break;
        if (want.c === construction && want.dir === 'in' && want.kind === 'answer' && want.port === port && ['return', 'throw', 'promise'].includes(want.outcome)) break;
        // Anything the recording has before this port's answer arrived while the port's code was on the stack.
        if (!isArrived(want) || this.delivered.has(index)) {
          // Not an input: only the candidate's own microtasks can have made it, run while the port's code was on the
          // stack (Bun's expect().rejects drains the microtask queue). Checked by running them here: if that
          // produces it, the case is unrecordable for that reason; if not, the order differs.
          drainMicrotasks?.();
          if (this.stopped) throw new ReplayStop();
          if (this.produced.length === index) break;
          this.inPortMicrotasks ??= { port, construction, index };
          continue;
        }
        this.deliverAt(index, 'during');
        if (this.stopped) throw new ReplayStop();
      }
    } finally {
      stack.pop();
    }
    const index = this.produced.length;
    const want = this.expected[index];
    if (!want || want.c !== construction || want.dir !== 'in' || want.kind !== 'answer' || want.port !== port || !['return', 'throw', 'promise'].includes(want.outcome)) {
      const shown = `in answer of port ${port} (construction ${construction})`;
      if (want && isArrived(want) && !this.delivered.has(index)) {
        this.stop({ outcome: 'different', check: 'order', detail: `port ${port} of construction ${construction} answered where the recording has ${describe(want, want.c)}` });
      }
      this.stop({ outcome: 'different', check: want ? 'order' : 'extra', detail: `the candidate wants ${shown} where the recording has ${want ? describe(want, want.c) : 'nothing'}`, expected: want ? describe(want, want.c) : null, got: shown });
    }
    if (want.outcome === 'promise') {
      // The recording says the test's promise was already settled when the port returned (`settled`): the host's is too.
      this.input(construction, 'answer', { port, outcome: 'promise', ...(want.settled ? { settled: want.settled } : {}) });
      const settled = this.settledAt.get(`${construction}:${port}`);
      if (want.settled && settled !== undefined && this.expected[settled].outcome === want.settled) {
        const at = this.expected[settled];
        this.delivered.add(settled);
        this.audit.push({ index: settled, kind: 'answer', how: 'at-return', quiet: false, produced: this.produced.length });
        return { outcome: 'promise', settle: { outcome: at.outcome, value: this.decodeIn(at.value, { construction, context: 'data', field: 'value', signals: at.signals }) } };
      }
      return { outcome: 'promise' };
    }
    const value = this.decodeIn(want.value, { construction, context: 'data' });
    this.input(construction, 'answer', { port, outcome: want.outcome, value: this.slot(construction, value, 'in') });
    return { outcome: want.outcome, value };
  }

  // ---------------------------------------------------------------- arrived inputs

  /** Delivers the recording's arrived input at `index` (how: `quiescent`, `group`, `during`), checked by the placement audit. */
  deliverAt(index, how) {
    const want = this.expected[index];
    // Nothing at or after the first busy input is delivered: where it arrived is not in the recording.
    if (index >= this.limit) { this.stopped ??= { outcome: 'partial' }; throw new ReplayStop(); }
    this.delivered.add(index);
    const quiet = this.quietAt === this.activity;
    this.audit.push({ index, kind: want.kind, how, quiet, produced: this.produced.length });
    // placement: an input delivered on its own must find the candidate quiescent (the drain before it confirmed so).
    if (how === 'quiescent' && !quiet) this.stop({ outcome: 'different', check: 'placement', detail: `${describe(want, want.c)} (#${index + 1}) was delivered while the candidate was not quiescent` });
    let input;
    try {
      input = this.inputOf(want);
    } catch (error) {
      if (error instanceof Unplaceable) return this.stop({ outcome: 'unrecordable', check: 'unplaceable', reason: error.reason, detail: `${describe(want, want.c)}: ${error.reason}` });
      throw error;
    }
    if (input === null) {
      // A step marker: the group it lists follows in one macrotask, in marker order, with no microtask between.
      const group = this.markerInputs(index);
      this.input(want.c, 'step', { step: want.step, now: want.now, inputs: want.inputs });
      const open = { value: true };
      queueMicrotask(() => { open.value = false; });
      for (const at of group) {
        if (!open.value) this.note('placement', `the group of step ${want.step} was split by a microtask`);
        this.deliverAt(at, 'group');
      }
      return undefined;
    }
    try {
      this.candidate.deliver(input);
    } catch (error) {
      if (error instanceof ReplayInputError) this.stop({ outcome: 'different', check: 'input', detail: `${describe(want, want.c)}: ${error.message}` });
      if (error instanceof ReplayStop) throw error;
      throw error;
    }
    // The recording places the next input in the same synchronous run as this call's return (or throw), with nothing
    // between: it is delivered now, before any microtask runs.
    const next = this.produced.length;
    const following = this.expected[next];
    const returned = this.expected[next - 1];
    if (following && next < this.limit && isArrived(following) && following.place === 'with' && !this.delivered.has(next)
      && (returned?.kind === 'return' || returned?.kind === 'throw') && returned.c === want.c && returned.call === want.call && following.after === want.call) {
      this.deliverAt(next, 'with');
    }
    return undefined;
  }

  /** The live input for a recorded arrived input (values decoded, stand-ins made, signals placed). */
  inputOf(want) {
    const c = want.c;
    switch (want.kind) {
      case 'step': return null;
      case 'call':
        if (want.call === 0) return { kind: 'construct', construction: c, args: this.decodeIn(want.args, { construction: c, context: 'construct', field: 'args', signals: want.signals }) };
        return { kind: 'call', construction: c, member: want.member, args: this.decodeIn(want.args, { construction: c, context: 'args', prefix: `${want.member}#${want.call}`, field: 'args', signals: want.signals }) };
      case 'control': return { kind: 'control', construction: c, of: want.of, method: want.method, args: this.decodeIn(want.args, { construction: c, context: 'args', prefix: `control#${want.call}`, field: 'args', signals: want.signals }) };
      case 'callback': return { kind: 'callback', construction: c, of: want.of, path: want.path, args: this.decodeIn(want.args, { construction: c, context: 'args', prefix: `callback#${want.call}`, field: 'args', signals: want.signals }) };
      case 'fire': return { kind: 'fire', construction: c, timer: want.timer };
      case 'answer': return { kind: 'answer', construction: c, port: want.port, outcome: want.outcome, value: this.decodeIn(want.value, { construction: c, context: 'data', field: 'value', signals: want.signals }) };
      case 'abort': {
        const held = this.inSignals.get(c)?.get(want.signal);
        if (!held?.controller) throw new Unplaceable(`signal ${want.signal} aborted, but no controller the host holds made it (a signal the test aborts without a controller)`);
        return { kind: 'abort', construction: c, controller: held.controller, reason: this.decodeIn(want.reason, { construction: c, context: 'data', field: 'reason' }) };
      }
      default: throw new Unplaceable(`no arrived input ${want.kind}`);
    }
  }

  /** Decodes a recorded value into the live value the candidate gets (the rules of `decodeValue`). */
  decodeIn(ref, place) {
    const tree = this.resolveTree(ref);
    return decodeValue(tree, {
      codec: this.codec,
      bindings: this.bindings,
      copyClass: (name) => {
        const made = this.copy.exports[name];
        return typeof made === 'function' && made.prototype && Object.prototype.isPrototypeOf.call(Error.prototype, made.prototype) ? made.prototype : null;
      },
      signalAt: (at, make) => this.signalAt(place, at, make),
      materialize: (leaf, at) => this.materialize(leaf, at, place),
    });
  }

  /** A signal the recording lists at path `at` of this value: the host's own (a controller it holds, numbered as recorded). */
  signalAt(place, at, make) {
    const listed = (place.signals ?? []).find((entry) => entry.in === place.field && Array.isArray(entry.at) && entry.at.length === at.length && entry.at.every((key, index) => key === at[index]));
    if (!listed) return null;
    const c = place.construction;
    if (!this.inSignals.has(c)) this.inSignals.set(c, new Map());
    const held = this.inSignals.get(c);
    if (!held.has(listed.signal)) held.set(listed.signal, make());
    return held.get(listed.signal);
  }

  /** A stand-in for a function or port the trace names at `at` of a value (`place` says which value). */
  materialize(leaf, at, place) {
    const { candidate } = this;
    const c = place.construction;
    if (place.context === 'construct' && at.length === 2 && at[0] === 0 && typeof at[1] === 'string') return this.optionStandIn(c, at[1], leaf, false);
    if (place.context === 'option' && at.length === 0) return this.optionStandIn(c, place.key, leaf, place.supplied);
    if (place.context === 'args' && at.length === 1 && typeof at[0] === 'number') {
      if (leaf[TAG] === 'function') return candidate.portFunction(c, `${place.prefix}.arg${at[0]}`, leaf.name);
      return candidate.portObject(c, leaf.name);
    }
    throw new Unplaceable(`a ${leaf[TAG]} ${JSON.stringify(leaf.name)} at ${JSON.stringify(at)} of a ${place.context} value has no stand-in`);
  }

  optionStandIn(c, key, leaf, supplied) {
    if (leaf[TAG] === 'port') return this.candidate.portObject(c, leaf.name);
    if (['now', 'scheduleTimeout', 'cancelTimeout', 'createTaskId', 'createLeaseToken', 'createWaveId'].includes(key)) return this.candidate.optionValue(c, key, { supplied });
    return this.candidate.portFunction(c, key, leaf.name);
  }

  // ---------------------------------------------------------------- the run

  /** Drains the event loop until two turns in a row show no activity (bounded). */
  async drain() {
    let quiet = 0;
    for (let turns = 0; quiet < 2; turns += 1) {
      const before = this.activity;
      await boundary();
      if (this.stopped) return;
      quiet = this.activity === before && this.candidate.isQuiet() ? quiet + 1 : 0;
      if (turns > 100_000) { this.note('quiescence', 'the candidate never became quiescent'); return; }
    }
    this.quietAt = this.activity;
  }

  /** The inputs a step marker lists, as indices of the recording's events, in delivery order. */
  markerInputs(markerIndex) {
    const marker = this.expected[markerIndex];
    const used = new Set();
    return marker.inputs.map((item) => {
      const found = this.expected.findIndex((event, index) => index > markerIndex && !used.has(index) && !this.delivered.has(index) && event.c === item.construction && event.dir === 'in' && event.kind === item.kind && event.place === 'group'
        && (item.kind === 'answer' ? event.port === item.port && event.outcome === item.outcome
          : item.kind === 'abort' ? event.signal === item.signal
            : event.call === item.call));
      if (found < 0) this.stop({ outcome: 'different', check: 'input', detail: `step ${marker.step} lists ${item.label}, which the recording has no event for` });
      used.add(found);
      return found;
    });
  }

  async run() {
    try {
      while (this.produced.length < this.limit) {
        await this.drain();
        if (this.stopped || this.produced.length >= this.limit) break;
        const index = this.produced.length;
        const want = this.expected[index];
        if (!isArrived(want) || this.delivered.has(index)) {
          this.stop({ outcome: 'different', check: 'missing', detail: `the candidate is quiescent, and the recording has ${describe(want, want.c)} next`, expected: describe(want, want.c) });
        }
        if (want.place !== 'rest') {
          // An input placed in a settlement's continuation, at a port's return, in a port call or a group is delivered there, by its mechanism.
          this.stop({ outcome: 'different', check: 'missing', detail: `the candidate is quiescent, and the recording has ${describe(want, want.c)} next, placed ${want.place}${want.place === 'settle' ? ` after call ${want.after}` : ''}: the candidate did not reach where it arrived`, expected: describe(want, want.c) });
        }
        this.deliverAt(index, 'quiescent');
      }
      if (!this.stopped) await this.drain();
    } catch (error) {
      if (!(error instanceof ReplayStop)) throw error;
    }
    const partial = this.stopped?.outcome === 'partial';
    // A candidate stopped for `missing` was quiescent: its trace is complete up to there.
    if (this.stopped && !partial) return this.judged(this.result(), this.stopped.check === 'missing');
    // The whole case, or its compared prefix: the final checks run on what was compared. A candidate in another
    // process first writes what it holds into the live objects that crossed (process-candidate.mjs).
    try { this.candidate.settleValues?.(); } catch (error) {
      if (!(error instanceof ReplayStop)) { this.stopped = { outcome: 'different', check: 'candidate-process', detail: String(error?.message ?? error), at: this.produced.length + 1 }; return this.judged(this.result(), false); }
    }
    const found = this.finalChecks();
    if (found) { this.stopped = { outcome: 'different', ...found }; return this.judged(this.result(), false); }
    if (partial && this.produced.length !== this.limit) { this.stopped = { outcome: 'different', check: 'missing', detail: `the compared prefix ends after ${this.limit} events; the candidate produced ${this.produced.length}`, at: this.produced.length + 1 }; return this.judged(this.result(), false); }
    if (this.inPortMicrotasks) {
      const { port, construction, index } = this.inPortMicrotasks;
      this.stopped = { outcome: 'unrecordable', check: 'microtasks-inside-port', reason: 'microtasks-inside-port', at: index + 1, detail: `the recording has the scheduler's own microtasks running while port ${port} of construction ${construction} was on the stack (#${index + 1}): Bun's expect().rejects runs the microtask queue inside a test's function; reproduced only by running it there, which a replay cannot place` };
    }
    return this.judged(this.result(), true);
  }

  /**
   * The comparer on what was compared, after, for a case the replay found different, the candidate's run past the
   * first difference (`observePast`), which only the comparer's launch-latency oracle and its capacity and admitLaunch
   * assertions read.
   */
  async judged(result, complete) {
    const observed = result.outcome === 'different' && this.mode.compare !== false && this.mode.observe !== false && this.launchesFrom(Math.max(0, this.produced.length - 1)) ? await this.observePast() : null;
    return this.compared(result, complete, observed);
  }

  /** Whether the compared part of the recording launches anything at or after recorded index `from`. */
  launchesFrom(from) {
    return this.recorded.slice(from, this.limit).some((event) => event.kind === 'port' && LAUNCH_PORTS.includes(event.name));
  }

  /** A fresh candidate run past the first difference (ObserveHost), as the comparer reads it; null when it cannot start. */
  async observePast() {
    const observer = new ObserveHost({ ...this.options, expected: this.recorded.slice() });
    try {
      const run = await observer.observe();
      const trees = emitSlots(observer.snaps);
      const resolve = (item) => (isRef(item) ? trees[item.slot] : observer.resolveTree(item));
      return { ...run, events: observer.produced.map(({ c, entry }) => compareEvent({ ...entry, c }, resolve)) };
    } finally {
      observer.close();
    }
  }

  /**
   * The comparer (compare.mjs) on what was compared: the recording's events (in the recorded order: a move the
   * independence table allowed is found again, and reported, by the comparer itself) against the candidate's, cut where
   * the replay stopped, and `observed`, the candidate's run past a difference. The verdict is `judgeComparison`'s.
   */
  compared(result, complete, observed = null) {
    const uses = this.independenceUses;
    const readMode = this.reads ? { recorded: this.reads.count, served: this.freeReads } : null;
    if (this.mode.compare === false || result.outcome === 'unrecordable' || result.outcome === 'not-ported') return { ...result, ...(uses.length ? { independence: uses.length } : {}), ...(readMode ? { readMode } : {}) };
    return judgeComparison(result, {
      uses: uses.length,
      readMode,
      observed: observed ? { through: observed.through, complete: observed.complete, stopped: observed.stopped, skipped: observed.skipped } : null,
      run: () => {
        const slotTrees = emitSlots(this.snaps);
        const resolve = (item) => (isRef(item) ? slotTrees[item.slot] : this.resolveTree(item));
        const candidate = this.produced.map(({ c, entry }) => compareEvent({ ...entry, c }, resolve));
        const reference = this.recorded.map((event) => compareEvent(event, this.resolveTree));
        return compareCase({ reference, candidate, limit: this.limit, complete, mode: { independence: this.mode.independence ?? [], reads: 'exact' }, observed });
      },
    });
  }

  /**
   * The checks of what was compared (the whole case, or its prefix): every save's ledger digest, every object that
   * crossed still holding what it held then, and the values in one identity scope. Returns the first finding
   * `{ check, detail, at }`, or null.
   */
  finalChecks() {
    const where = (index) => describe(this.expected[index], this.expected[index].c);
    for (const [index, { entry }] of this.produced.entries()) {
      if (!entry.ledger) continue;
      let digest;
      try { digest = sha256(this.reference.encode(entry.ledger.pending)); } catch (error) { digest = { error: String(error?.message ?? error) }; }
      const want = this.expected[index].ledger;
      if (JSON.stringify(digest) !== JSON.stringify(want)) return { check: 'ledger', at: index + 1, expected: where(index), detail: `${where(index)}: the saved state's reference bytes are ${JSON.stringify(digest)}, the recording's ${JSON.stringify(want)}` };
    }
    for (const [slot, value] of this.slotValues.entries()) {
      if (value === null || this.rawOf.get(value) !== undefined) continue;
      const again = snapshot(value, createCodecContext({ names: this.names, unwrap: (item) => this.rawOf.get(item) }));
      if (contentText(again) === contentText(this.snaps[slot])) continue;
      const [index, field] = this.slotPlaces[slot] ?? [];
      const want = index === undefined ? null : this.expected[index];
      if (want && [...(want.mutatedByReceiver ?? []), ...(want.mutated ?? [])].includes(field)) continue;
      return { check: 'mutated', at: index === undefined ? null : index + 1, expected: want ? where(index) : null, detail: `${want ? where(index) : `slot ${slot}`}: its ${field} had other content when the ${this.limit < this.expected.length ? 'compared prefix' : 'case'} ended (the candidate changed it after it crossed)` };
    }
    // Identity across events: the produced values emitted in one scope against the recording's, each list with the
    // identity numbers that occur once in it unwrapped and the rest numbered by first sight (the recording numbered
    // its whole case; a prefix sees part of it).
    const trees = emitSlots(this.snaps);
    const produced = [];
    const recorded = [];
    for (const [index, { entry }] of this.produced.entries()) {
      for (const [key, item] of Object.entries(entry)) {
        if (!isRef(item)) continue;
        produced.push({ index, key, tree: trees[item.slot] });
        recorded.push({ index, key, tree: this.resolveTree(this.expected[index][key]) });
      }
    }
    const left = identityForm(recorded.map((entry) => entry.tree));
    const right = identityForm(produced.map((entry) => entry.tree));
    for (const [position, entry] of recorded.entries()) {
      if (stringifyTree(left[position]) !== stringifyTree(right[position])) return { check: 'case-bytes', at: entry.index + 1, expected: where(entry.index), detail: `${where(entry.index)}: ${entry.key} ${treeDifference(left[position], right[position])}` };
    }
    return null;
  }

  result() {
    const delivered = { quiescent: 0, group: 0, during: 0, with: 0, 'at-return': 0, 'after-settle': 0 };
    for (const entry of this.audit) delivered[entry.how] += 1;
    const unhandledRejections = this.unhandled;
    if (!this.stopped) return { outcome: 'reproduced', produced: this.produced.length, delivered, unhandledRejections };
    return { ...this.stopped, produced: this.produced.length, delivered, unhandledRejections };
  }
}

// ------------------------------------------------------------------ past the first difference

const CALL_KINDS = new Set(['call', 'control', 'callback', 'fire']);
/** The position of the first entry above `value` in an ascending list (its length when there is none). */
const firstAbove = (list, value) => {
  let low = 0;
  let high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle] > value) high = middle; else low = middle + 1; }
  return low;
};

/**
 * The candidate's run past the first difference (package O0d fix round 1, S1), for the comparer's launch-latency
 * oracle and its capacity and admitLaunch assertions, never for the verdict: the case is already different (OD1),
 * and nothing here is compared. A fresh candidate is given the arrived inputs of the compared part in their recorded
 * order: a step marker with its group, an input placed `rest` at quiescence, one placed in a port call, at a port's
 * return, with a call's return or in a settlement's continuation where the candidate reaches that place (else it is
 * skipped). Past the difference positions no longer match, so what the candidate asks for and the inputs it is given
 * are matched by identity, not by position:
 * - a port call is the recording's call with the same construction, port name and task (`taskId` of its first
 *   argument), in call order; its synchronous answer is that call's, the answers and the control and callback calls
 *   of that call go to it, and a call the recording has no counterpart of gets the latest synchronous answer of that
 *   port name, or a promise never settled;
 * - a timer is the recording's timer of the same construction and delay, in set order; a recorded fire fires it
 *   when it is still live;
 * - a clock, option, data or environment read is answered with the recording's value of that key in the current
 *   step (the first such read after the latest input delivered, else the latest before it); identifiers come from
 *   their site's queue;
 * - what cannot be answered (a key never read, a site's draws used up, a value naming an object never seen) stops
 *   the run, and the launches it did not reach are not judged.
 * The run is bounded (events, and the drains' own bound). `observe()` resolves `{ recOf, through, complete,
 * stopped, skipped }` beside `produced`: `recOf[i]` the recorded index of the arrived input produced as event i,
 * `through` the last recorded index before which every input was delivered (or skipped) and drained.
 */
class ObserveHost extends Host {
  constructor(options) {
    super(options);
    const { expected, limit } = this;
    this.recOf = [];
    this.pendingRec = null;
    this.currentRec = -1;
    this.answerRec = new Map(); // `${c}:${candidate port}` -> recorded index of the settlement delivered to it
    this.callRec = new Map(); // `${c}:${candidate call}` -> the recorded call number delivered as it
    this.portOf = new Map(); // `${c}:${recorded port}` -> candidate port
    this.portRec = new Map(); // `${c}:${candidate port}` -> recorded port
    this.portNames = new Map(); // `${c}:${candidate port}` -> its name
    this.portCounts = new Map();
    this.timerOf = new Map(); // `${c}:${recorded timer}` -> candidate timer
    this.timerCounts = new Map();
    this.timerDone = new Set(); // `${c}:${candidate timer}` fired or cleared
    this.skipped = 0;
    this.through = -1;
    this.complete = false;
    this.cap = expected.length * 4 + 10_000;
    this.arrived = [];
    this.recordedPorts = new Map(); // key -> recorded port numbers in call order
    this.byName = new Map(); // `${c}|${name}` -> recorded port numbers
    this.syncAnswer = new Map(); // `${c}:${recorded port}` -> index of its synchronous answer
    this.duringOf = new Map(); // `${c}:${recorded port}` -> indices of the inputs placed inside it
    this.settleOf = new Map(); // `${c}:${recorded call}` -> index of its settlement
    this.recordedTimers = new Map(); // `${c}|${delay}` -> recorded timer numbers in set order
    this.handles = new Map(); // c -> the handle kind of its first recorded timer
    this.asks = new Map(); // key -> indices of the recording's asked inputs of that key
    const add = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
    for (const [index, event] of expected.entries()) {
      const c = event.c;
      if (index < limit && isArrived(event)) this.arrived.push(index);
      if (event.kind === 'port') {
        add(this.recordedPorts, `${c}|${event.name}|${this.recordedTask(event)}`, event.port);
        add(this.byName, `${c}|${event.name}`, event.port);
      } else if (event.kind === 'answer' && ['return', 'throw', 'promise'].includes(event.outcome)) this.syncAnswer.set(`${c}:${event.port}`, index);
      else if (event.kind === 'settle') this.settleOf.set(`${c}:${event.call}`, index);
      else if (event.kind === 'timer.set') {
        add(this.recordedTimers, `${c}|${plain(this.resolveTree(event.delay))}`, event.timer);
        if (!this.handles.has(c)) this.handles.set(c, event.handle);
      } else if (event.dir === 'in' && ['read', 'clock', 'env'].includes(event.kind)) add(this.asks, this.askKey(c, event.kind, event), index);
      if (isArrived(event) && event.place === 'during' && typeof event.during === 'number') add(this.duringOf, `${c}:${event.during}`, index);
    }
  }

  /** The task a recorded port call's first argument names (`taskId`), or ''. */
  recordedTask(event) {
    try { const first = plain(this.resolveTree(event.args))?.[0]; return typeof first?.taskId === 'string' ? first.taskId : ''; } catch { return ''; }
  }

  /** The key of an asked input: kind, construction and what it asks for (the recorded event's fields, or the candidate's). */
  askKey(c, kind, fields) {
    if (kind === 'clock') return `clock|${c}|${fields.source}|${fields.site ?? ''}`;
    if (kind === 'env') return `env|${c}|${fields.site}|${fields.name}`;
    const key = fields.op === 'keys' ? '' : typeof fields.key === 'string' && !SLOT.test(fields.key) ? fields.key : '<value>';
    return `read|${c}|${fields.object}|${fields.op ?? 'get'}|${key}`;
  }

  /** Stops the observed run: what it did not reach is not judged. */
  halt(reason) {
    this.stopped ??= { outcome: 'observed', detail: reason };
    throw new ReplayStop();
  }

  note(check, detail) { this.stopped ??= { outcome: 'observed', check, detail }; }

  event(construction, dir, kind, fields) {
    if (this.stopped || !this.live) throw new ReplayStop();
    if (this.produced.length >= this.cap) this.halt(`the candidate produced more than ${this.cap} events`);
    const { index, entry } = this.record(construction, dir, kind, fields);
    if (dir === 'in' && (CALL_KINDS.has(kind) || kind === 'abort' || kind === 'step' || (kind === 'answer' && (fields.outcome === 'resolve' || fields.outcome === 'reject')))) {
      const rec = kind === 'answer' ? this.answerRec.get(`${construction}:${fields.port}`) : this.pendingRec;
      if (rec !== undefined && rec !== null) this.recOf[index] = rec;
      if (CALL_KINDS.has(kind) && this.pendingRec !== null) this.callRec.set(`${construction}:${fields.call}`, this.expected[this.pendingRec].call);
    }
    if (dir === 'out' && kind === 'port') {
      const first = isRef(fields.args) ? this.slotValues[fields.args.slot]?.[0] : undefined;
      const task = first !== null && typeof first === 'object' && this.rawOf.get(first) === undefined && typeof first.taskId === 'string' ? first.taskId : '';
      const key = `${construction}|${fields.name}|${task}`;
      const n = (this.portCounts.get(key) ?? 0) + 1;
      this.portCounts.set(key, n);
      this.portNames.set(`${construction}:${fields.port}`, fields.name);
      const recorded = this.recordedPorts.get(key)?.[n - 1];
      if (recorded !== undefined) { this.portOf.set(`${construction}:${recorded}`, fields.port); this.portRec.set(`${construction}:${fields.port}`, recorded); }
    }
    if (dir === 'out' && kind === 'timer.set') {
      const delay = isRef(fields.delay) ? plain(emitSlots([this.snaps[fields.delay.slot]])[0]) : fields.delay;
      const key = `${construction}|${delay}`;
      const n = (this.timerCounts.get(key) ?? 0) + 1;
      this.timerCounts.set(key, n);
      const recorded = this.recordedTimers.get(key)?.[n - 1];
      if (recorded !== undefined) this.timerOf.set(`${construction}:${recorded}`, fields.timer);
    }
    if (kind === 'timer.clear' && fields.timer !== null) this.timerDone.add(`${construction}:${fields.timer}`);
    if (dir === 'in' && kind === 'fire') this.timerDone.add(`${construction}:${fields.timer}`);
    return entry;
  }

  timerHandle(c) { return this.handles.get(c) ?? 'object'; }

  nextIsRead(construction, object, key) {
    if (this.reads) return super.nextIsRead(construction, object, key);
    return typeof key === 'string' && this.asks.has(`read|${construction}|${object}|get|${key}`);
  }

  /** The recorded asked input of `key` that answers now (the current step's), or undefined. */
  answering(key) {
    const list = this.asks.get(key);
    if (!list) return undefined;
    const cursor = this.currentRec;
    const nextInput = this.arrived[firstAbove(this.arrived, cursor)] ?? Number.POSITIVE_INFINITY;
    const after = firstAbove(list, cursor);
    if (after < list.length && list[after] < nextInput) return list[after];
    return after > 0 ? list[after - 1] : list[0];
  }

  ask(construction, kind, fields) {
    if (this.stopped || !this.live) throw new ReplayStop();
    if (kind === 'read' && this.reads) return this.freeRead(construction, fields);
    try {
      if (kind === 'draw') {
        const queue = this.draws.get([construction, fields.site].join(':'));
        if (!queue?.length) this.halt(`the candidate drew at ${fields.site} more often than the recording did`);
        const value = this.decodeIn(queue.shift(), { construction, context: 'data' });
        this.input(construction, 'draw', { site: fields.site, source: fields.source, value: this.slot(construction, value, 'in') });
        return value;
      }
      const at = this.answering(this.askKey(construction, kind, fields));
      if (at === undefined) this.halt(`the candidate asked for ${kind} ${this.askKey(construction, kind, fields)}, which the recording never answered`);
      const want = this.expected[at];
      if (kind === 'read') {
        const place = { construction, context: want.object === 'options' && fields.op === undefined ? 'option' : 'data', key: fields.key, supplied: want.supplied === true };
        if (fields.op === 'own') {
          const value = want.found && 'value' in want ? this.decodeIn(want.value, place) : undefined;
          this.input(construction, 'read', { object: fields.object, op: 'own', key: this.keyField(construction, fields.key), found: want.found, ...('value' in want ? { value: this.slot(construction, value, 'in') } : {}) });
          return { found: want.found, value };
        }
        const value = this.decodeIn(want.value, place);
        const shown = fields.op === undefined ? { object: fields.object, key: this.keyField(construction, fields.key) } : fields.op === 'has' ? { object: fields.object, op: 'has', key: this.keyField(construction, fields.key) } : { object: fields.object, op: 'keys' };
        this.input(construction, 'read', { ...shown, value: this.slot(construction, value, 'in'), ...(want.supplied ? { supplied: true } : {}) });
        return value;
      }
      const value = this.decodeIn(want.value, { construction, context: 'data' });
      this.input(construction, kind, kind === 'clock' ? { source: fields.source, ...(fields.site !== undefined ? { site: fields.site } : {}), value: this.slot(construction, value, 'in') } : { site: fields.site, name: fields.name, value: this.slot(construction, value, 'in') });
      return value;
    } catch (error) {
      if (error instanceof Unplaceable) this.halt(`a value the candidate asked for cannot be placed: ${error.reason}`);
      throw error;
    }
  }

  portAnswer(construction, port) {
    if (this.stopped || !this.live) throw new ReplayStop();
    const recorded = this.portRec.get(`${construction}:${port}`);
    if (recorded !== undefined) {
      if (!this.portStack.has(construction)) this.portStack.set(construction, []);
      const stack = this.portStack.get(construction);
      stack.push(port);
      try {
        for (const index of this.duringOf.get(`${construction}:${recorded}`) ?? []) if (index < this.limit) this.deliverObserved(index);
      } finally { stack.pop(); }
    }
    let at = recorded === undefined ? undefined : this.syncAnswer.get(`${construction}:${recorded}`);
    let matched = at !== undefined;
    if (!matched) {
      // No counterpart in the recording: the latest synchronous answer of that port name, or a promise never settled.
      const list = this.byName.get(`${construction}|${this.portNames.get(`${construction}:${port}`)}`) ?? [];
      const last = list.length ? this.syncAnswer.get(`${construction}:${list[list.length - 1]}`) : undefined;
      if (last === undefined) { this.input(construction, 'answer', { port, outcome: 'return', value: this.slot(construction, undefined, 'in') }); return { outcome: 'return', value: undefined }; }
      at = last;
      matched = false;
    }
    const want = this.expected[at];
    try {
      if (want.outcome === 'promise') {
        this.input(construction, 'answer', { port, outcome: 'promise' });
        const settled = matched && want.settled ? this.settledAt.get(`${construction}:${recorded}`) : undefined;
        if (settled !== undefined && settled < this.limit && this.expected[settled].outcome === want.settled && !this.delivered.has(settled)) {
          const event = this.expected[settled];
          this.delivered.add(settled);
          this.answerRec.set(`${construction}:${port}`, settled);
          return { outcome: 'promise', settle: { outcome: event.outcome, value: this.decodeIn(event.value, { construction, context: 'data', field: 'value', signals: event.signals }) } };
        }
        return { outcome: 'promise' };
      }
      const value = this.decodeIn(want.value, { construction, context: 'data' });
      this.input(construction, 'answer', { port, outcome: want.outcome, value: this.slot(construction, value, 'in') });
      return { outcome: want.outcome, value };
    } catch (error) {
      if (error instanceof Unplaceable) this.halt(`the answer of port ${port} cannot be placed: ${error.reason}`);
      throw error;
    }
  }

  returnedPromise(c, call, promise) {
    const recorded = this.callRec.get(`${c}:${call}`);
    const settle = recorded === undefined ? undefined : this.settleOf.get(`${c}:${recorded}`);
    if (settle === undefined) return;
    const next = settle + 1;
    const following = this.expected[next];
    if (!following || next >= this.limit || !isArrived(following) || following.place !== 'settle' || following.after !== recorded) return;
    const later = () => {
      if (this.stopped || !this.live || this.delivered.has(next)) return;
      try { this.deliverObserved(next); } catch (error) { if (!(error instanceof ReplayStop)) throw error; }
    };
    Promise.prototype.then.call(promise, () => { queueMicrotask(later); }, () => { queueMicrotask(later); });
  }

  /** The live input for a recorded arrived input, matched to the candidate's own port, call or timer; null when it has none. */
  observedInput(want) {
    if (want.kind === 'answer') {
      const port = this.portOf.get(`${want.c}:${want.port}`);
      return port === undefined ? null : { kind: 'answer', construction: want.c, port, outcome: want.outcome, value: this.decodeIn(want.value, { construction: want.c, context: 'data', field: 'value', signals: want.signals }) };
    }
    if (want.kind === 'control' || want.kind === 'callback') {
      const port = this.portOf.get(`${want.c}:${want.of}`);
      return port === undefined ? null : { ...this.inputOf(want), of: port };
    }
    if (want.kind === 'fire') {
      const timer = this.timerOf.get(`${want.c}:${want.timer}`);
      return timer === undefined || this.timerDone.has(`${want.c}:${timer}`) ? null : { kind: 'fire', construction: want.c, timer };
    }
    return this.inputOf(want);
  }

  /** Delivers the recorded arrived input `index` (and, for a marker, its group), or skips it. */
  deliverObserved(index) {
    if (this.delivered.has(index)) return;
    this.delivered.add(index);
    if (index > this.currentRec) this.currentRec = index;
    const want = this.expected[index];
    const previous = this.pendingRec;
    if (want.kind === 'step') {
      this.pendingRec = index;
      try { this.input(want.c, 'step', { step: want.step, now: want.now, inputs: want.inputs }); } finally { this.pendingRec = previous; }
      for (const at of this.groupOf(index)) this.deliverObserved(at);
      return;
    }
    let input;
    try { input = this.observedInput(want); } catch (error) { if (!(error instanceof Unplaceable)) throw error; input = null; }
    if (input === null) { this.skipped += 1; return; }
    this.pendingRec = index;
    if (want.kind === 'answer') this.answerRec.set(`${want.c}:${input.port}`, index);
    try {
      this.candidate.deliver(input);
    } catch (error) {
      if (!(error instanceof ReplayInputError)) throw error;
      this.skipped += 1;
    } finally { this.pendingRec = previous; }
    if (CALL_KINDS.has(want.kind)) {
      const next = this.arrived[firstAbove(this.arrived, index)];
      const following = next === undefined ? null : this.expected[next];
      if (following && following.c === want.c && following.place === 'with' && following.after === want.call) this.deliverObserved(next);
    }
  }

  /** The inputs a step marker lists that the recording has, in delivery order (one it has no event for is left out). */
  groupOf(markerIndex) {
    const marker = this.expected[markerIndex];
    const used = new Set();
    const out = [];
    for (const item of marker.inputs ?? []) {
      const found = this.expected.findIndex((event, index) => index > markerIndex && index < this.limit && !used.has(index) && !this.delivered.has(index) && event.c === item.construction && event.dir === 'in' && event.kind === item.kind && event.place === 'group'
        && (item.kind === 'answer' ? event.port === item.port && event.outcome === item.outcome : item.kind === 'abort' ? event.signal === item.signal : event.call === item.call));
      if (found >= 0) { used.add(found); out.push(found); }
    }
    return out;
  }

  /** The observed run: every arrived input of the compared part in recorded order, each at quiescence or at its place. */
  async observe() {
    try {
      for (const index of this.arrived) {
        if (this.delivered.has(index)) continue;
        const event = this.expected[index];
        if (event.place === 'group' && event.kind !== 'step') continue;
        await this.drain();
        if (this.stopped) break;
        this.through = index - 1;
        if (this.delivered.has(index)) continue;
        if (event.kind !== 'step' && event.place !== 'rest') { this.delivered.add(index); this.skipped += 1; continue; }
        this.deliverObserved(index);
      }
      if (!this.stopped) await this.drain();
      if (!this.stopped) { this.through = this.limit - 1; this.complete = true; }
    } catch (error) {
      if (!(error instanceof ReplayStop)) throw error;
    }
    return { recOf: this.recOf, through: this.through, complete: this.complete, stopped: this.stopped ? String(this.stopped.detail ?? this.stopped.check ?? 'stopped').slice(0, 300) : null, skipped: this.skipped };
  }
}

// ------------------------------------------------------------------ the replay's verdict

/**
 * The replay's verdict from the comparer's (pure: the comparer's self-test feeds it fixed inputs). `run` runs the comparer;
 * a throw is a failure named `compare`, never a pass. `uses` the moves the replay made by the independence table,
 * which must equal the comparer's own (the table is applied twice, independently), else `independence` fails. A
 * reproduced or partial case with a failure becomes different (`check: compare`, its first rule); one with an
 * inconclusive finding becomes inconclusive; a different case keeps its check and gets the rules named. Nothing here
 * turns a case out of `different`.
 */
export function judgeComparison(result, { run, uses = 0, readMode = null, observed = null }) {
  let outcome;
  try {
    outcome = run();
  } catch (error) {
    outcome = { verdict: 'fail', findings: [{ rule: 'compare', kind: 'fail', detail: `the comparer failed: ${String(error?.stack ?? error).slice(0, 600)}` }], info: [] };
  }
  const fails = outcome.findings.filter((finding) => finding.kind === 'fail');
  const inconclusive = outcome.findings.filter((finding) => finding.kind === 'inconclusive');
  const infoByRule = {};
  for (const item of outcome.info) infoByRule[item.rule] = (infoByRule[item.rule] ?? 0) + 1;
  const usesFound = outcome.info.filter((item) => item.rule === 'independence');
  if (usesFound.length !== uses) fails.push({ rule: 'independence', kind: 'fail', detail: `the replay moved ${uses} unit(s) by the independence table, the comparer found ${usesFound.length}` });
  const summary = {
    verdict: fails.length ? 'fail' : inconclusive.length ? 'inconclusive' : outcome.verdict,
    rules: [...new Set(fails.map((finding) => finding.rule))],
    findings: [...fails, ...inconclusive].slice(0, 8).map((finding) => ({ rule: finding.rule, kind: finding.kind, at: finding.at ?? null, detail: String(finding.detail ?? '').slice(0, 500), ...(finding.needsOwner ? { needsOwner: true } : {}) })),
    info: infoByRule,
    ...(usesFound.length || uses ? { independence: { replay: uses, comparer: usesFound.length, uses: usesFound.slice(0, 4).map((use) => ({ at: use.at, lanes: use.lanes, cite: use.cite })) } } : {}),
    ...(readMode ? { readMode } : {}),
    ...(observed ? { observed } : {}),
  };
  const first = fails[0];
  if ((result.outcome === 'reproduced' || result.outcome === 'partial') && first) {
    return { ...result, outcome: 'different', check: 'compare', rule: first.rule, at: first.at ?? null, detail: `(${first.rule}) ${first.detail}`, compare: summary };
  }
  if ((result.outcome === 'reproduced' || result.outcome === 'partial') && inconclusive.length) {
    return { ...result, outcome: 'inconclusive', check: inconclusive[0].rule, reason: inconclusive[0].rule, detail: inconclusive[0].detail, compare: summary };
  }
  return { ...result, ...(result.outcome === 'different' && first ? { rule: first.rule } : {}), compare: summary };
}

// ------------------------------------------------------------------ helpers

/** One line for an event, values left out. */
function describe(event, construction) {
  if (!event) return '(no event)';
  const fields = Object.entries(event).filter(([key]) => !['seq', 'at', 'dir', 'kind', 'c', 'signals', 'ledger', ...ANNOTATIONS].includes(key)).map(([key, value]) => `${key}=${isRef(value) || (typeof value === 'string' && SLOT.test(value)) ? '…' : JSON.stringify(value)}`);
  return `${event.dir} ${event.kind}${fields.length ? ` ${fields.join(' ')}` : ''} [construction ${construction}]`;
}

/**
 * Trees of one identity scope in a form that keeps only which objects are shared across them: an identity number
 * that occurs once in the list is unwrapped (that object is not shared within the list), the others are numbered
 * again in order of first sight.
 */
function identityForm(trees) {
  const counts = new Map();
  const walk = (tree) => {
    if (Array.isArray(tree)) { tree.forEach(walk); return; }
    if (tree === null || typeof tree !== 'object') return;
    if ((tree[TAG] === 'id' || tree[TAG] === 'ref') && typeof tree.n === 'number') counts.set(tree.n, (counts.get(tree.n) ?? 0) + 1);
    for (const key of Object.keys(tree)) walk(tree[key]);
  };
  trees.forEach(walk);
  const numbers = new Map();
  const rewrite = (tree) => {
    if (Array.isArray(tree)) return tree.map(rewrite);
    if (tree === null || typeof tree !== 'object') return tree;
    if (tree[TAG] === 'id' && typeof tree.n === 'number') {
      if (counts.get(tree.n) === 1) return rewrite(tree.value);
      if (!numbers.has(tree.n)) numbers.set(tree.n, numbers.size + 1);
      return { [TAG]: 'id', n: numbers.get(tree.n), value: rewrite(tree.value) };
    }
    if (tree[TAG] === 'ref' && typeof tree.n === 'number') {
      if (!numbers.has(tree.n)) numbers.set(tree.n, numbers.size + 1);
      return { [TAG]: 'ref', n: numbers.get(tree.n) };
    }
    const out = {};
    for (const key of Object.keys(tree)) out[key] = rewrite(tree[key]);
    return out;
  };
  return trees.map(rewrite);
}

function sameKey(recorded, asked, resolve) {
  if (typeof asked === 'string') return recorded === asked;
  if (typeof recorded !== 'string' || !SLOT.test(recorded)) return false;
  const tree = resolve(recorded);
  return typeof asked === 'symbol' && tree && tree[TAG] === 'symbol' && (tree.key === Symbol.keyFor(asked) || tree.description === asked.description);
}

// ------------------------------------------------------------------ a replay process

/** Replays every case of the given containers against a copy; one result per case, and each container's provenance. */
export async function replayContainers({ files, copyDir }) {
  installReplayHooks();
  const copy = await loadCopy(copyDir);
  const reference = await loadReference();
  const results = [];
  const containers = [];
  for (const file of files) {
    const read = readContainer(readFileSync(file, 'utf8'));
    const header = read.header;
    const provenance = copyProvenance(header, copy);
    containers.push({ file, testFile: header.testFile, cases: read.cases.length, end: read.end, provenance });
    for (const record of read.cases) {
      const started = Date.now();
      const result = await replayCase({ record, resolve: read.resolve, header, copy, reference });
      results.push({ ...result, testFile: header.testFile, ms: Date.now() - started });
    }
  }
  return { containers, results };
}

/** Whether the copy is the code the recording ran, and provably another module graph (closure inside the copy). */
export function copyProvenance(header, copy) {
  const problems = [];
  const keys = (object) => Object.keys(object ?? {}).sort().join(',');
  if (keys(header.modules) !== keys(copy.modules)) problems.push(`the copy's closure ${keys(copy.modules)} is not the recording's ${keys(header.modules)}`);
  for (const [file, digest] of Object.entries(copy.modules)) if (header.modules?.[file] !== undefined && header.modules[file] !== digest) problems.push(`${file} differs from the recorded module`);
  if (copy.outside.length) problems.push(`the copy's closure reaches outside it: ${copy.outside.join(', ')}`);
  if (copy.dir === realpathSync(PACKAGE_DIR) || copy.dir.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) problems.push('the copy is inside the repository, not in the run root');
  return { same: problems.length === 0, problems };
}

async function main(argv) {
  const options = {};
  const files = [];
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match) options[match[1]] = match[2]; else files.push(arg);
  }
  if (!options.copy || !existsSync(options.copy) || files.length === 0) {
    console.error('usage: bun replay.mjs --copy=<package copy> [--json=<out>] <container>...');
    return 64;
  }
  const outcome = await replayContainers({ files, copyDir: options.copy });
  const text = `${JSON.stringify(outcome)}\n`;
  if (options.json) writeFileSync(options.json, text); else process.stdout.write(text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
