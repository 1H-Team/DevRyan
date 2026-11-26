// Recorder core of the client engine conformance harness (design file 29 §2),
// a `bun test --preload`. It sits below the tests: what a test installs (a
// fake fetch, a fake WebSocket, a timer trap, a mocked module, a Date.now
// stub, a spy, fake timers) is layered on top of the recorder's version and
// is still seen by it. It never calls a user-defined getter and does not
// change what a test observes, except where docs/TESTING.md lists it.
//
// What it does, per layer (DEVRYAN_CONFORMANCE_LAYERS, default all):
// - clock: a nominal clock per case. Timers keep real scheduling; Date.now(),
//   new Date() and performance.now() read a virtual time that starts, for
//   case k of the file, at EPOCH + k × CASE_SPAN_MS (or where the previous
//   case closed, when that is later), and moves, when a timer the case set fires, to that
//   timer's nominal due time (its virtual set time plus its delay), never
//   backward; a timer an earlier case left moves that case's clock only. Test
//   bodies, the test file's hooks and test timers' callbacks run in a test
//   store of their case, so what they leave behind stays that case's; a timer
//   set by code with no known case that moves a clock flags the case
//   (`timer-owner-unknown`).
//   setSystemTime sets it; under
//   fake timers the fake clock (started at the virtual time) is read instead.
//   A clock stub a test installs answers, and its answers are recorded.
// - random: Math.random, crypto.getRandomValues and crypto.randomUUID draw
//   from a stream seeded per test (file and ordinal); every draw is recorded,
//   a test's stub's answers included.
// - globals: accessor properties on globalThis for fetch, timers, WebSocket,
//   EventSource, Date, performance, crypto, localStorage, sessionStorage,
//   document, window and navigator, so a stub a test assigns is wrapped as it
//   is set. A test's own definition of one (Object.defineProperty, an
//   accessor) flags every case it stands in (`global-defined:<name>`).
// - mock-module: mock.module is wrapped, so the exports of every module a test
//   mocks are recorded as ports; a call with no engine chain records nothing.
// - entries: the families of the port map (DEVRYAN_CONFORMANCE_PORT_MAP).
//   Their modules load through a facade (a Bun plugin) whose entry exports
//   are wrapped and whose port modules' exports are recorded; nothing loads
//   earlier than it would.
//
// Attribution (design §2.4: a step is one input delivered to the module, with
// everything the module did because of it). An AsyncLocalStorage store names
// the chain that is running: which family, which case, and the step the chain
// is in. A wrapped entry call, a port answer settling, a timer the engine set
// firing and a callback the engine handed out being invoked each open a step;
// the chain they start runs in a store of that step, and effects go to the
// step of the store they run in, never to whichever step opened last. An
// input delivered to an existing chain (the answer to a port call, the timer
// it set firing, a callback it handed out) moves that chain to the new step.
// A continuation another input made runnable (a promise it resolved) belongs
// to that input: see release windows. An input opened synchronously inside a
// port call of the same family (re-entrance) is marked `during` that step.
// Engine code an entry hands the test (a closure, an object's methods and
// getters, an iterator, a thenable) is wrapped, so running it is an input
// too (handed-out engine code). A call made with no engine store came from the
// test (recorded as context, not compared), unless engine code is found
// running there, which flags the case `outside-chain`. Port code runs under a
// "port" store, whose own calls are not effects.
//
// The caller rule. With no engine chain running, an entry call is a step only
// when its caller (the first frame outside the recorder) is test code by the
// naming rule; any other call (engine code no family maps yet) is passed
// through and counted per family and export and per caller file, and runs in
// a pass-through store for its synchronous extent only. The caller decides
// inside that store too, so a test callback the passed-through call runs is
// the test's; what it schedules runs with no store. A call with no frame at
// all flags its case `no-frame`, unless the census names it with its engine
// site (DEVRYAN_CONFORMANCE_NO_FRAME).
//
// Cases. One test is one case. What runs outside a test (module load, a
// beforeAll, a describe's afterAll, the file's afterAll) is a hooks case
// numbered by the tests that ran before it, so nothing is lost or misfiled.
// Tests that overlap (test.concurrent) are marked unrecordable. Cases are
// written when the file ends: what an engine chain does after its test ended
// goes to that test's case, marked late; after the file's recording is
// written it is counted as unplaced, never dropped silently. A timer that
// fires after its test ended is the exception (C0e fix round): the case
// records the timers still pending at its end, and what such a timer does,
// or releases, is recorded nowhere (lateStore).
//
// Output (DEVRYAN_CONFORMANCE_OUT): one `<path stem>.raw.json` per test file
// (container.mjs pathStem), cases in file order and a value table; the record
// tool names the cases from Bun's junit report and writes the containers. Without
// it, everything runs and nothing is written.
import * as bunTest from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodecContext, emitSlots, encode, encodeText, hashText, snapshot } from './codec.mjs';
import { pathStem, sliceTree } from './container.mjs';
import { entryOf, isTestPath, loadPortMap } from './port-map.mjs';

export const EPOCH = 1700000000000;
export const PERFORMANCE_ORIGIN = 1000;
/** The nominal time each case of a file is given: case k (0 the module load) opens at EPOCH + k × CASE_SPAN_MS at the earliest. */
export const CASE_SPAN_MS = 1000;
export const RAW_VERSION = 6;
// The recording's semantics: bumped by hand whenever what a recording says changes (attribution, late effects, flags).
// 7 (package C0e): a step with a synchronous part (a call, `new`, `get`, a timer firing, a callback) records
// `returnedAt`, the number of its effects made before that part returned or threw; the rest followed in the jobs it started.
// 8 (package C0f): platform timers of a case fire in the order of a timer clock of the case; engine reads of the
// transport and DOM globals are `read` inputs of the port `globalThis`; a function a port answers is a port; a port that
// wraps its answers is settled with the port object the engine got, on the promise the engine holds; inputs that arrive
// together are marked so; answers that settle in their call's drain are `immediate`; the platform's own transports flag
// `real-transport`; a signal the test aborts after handing it in flags `signal-aborted`.
export const RECORDING_VERSION = 9;
/** How long the recorder's own hook that writes a file's recording may take. */
export const WRITE_TIMEOUT_MS = 600000;
export const LAYERS = Object.freeze(['clock', 'random', 'globals', 'mock-module', 'entries']);
// `discover` alone: no layer at all; the facade only notes which mapped modules the test file loads (record.mjs discoverLoading).
const DISCOVER_LAYER = 'discover';
const API = Symbol.for('devryan.client-conformance');

// Intrinsics: tests replace globalThis.Map, Date, setTimeout and others.
const RealMap = Map;
const RealSet = Set;
const RealWeakMap = WeakMap;
const RealWeakSet = WeakSet;
const WeakSetAdd = WeakSet.prototype.add;
const WeakSetHas = WeakSet.prototype.has;
const RealProxy = Proxy;
const RealError = Error;
const RealDate = Date;
const RealPromise = Promise;
const RealUint8Array = Uint8Array;
const { apply, construct, get: reflectGet, set: reflectSet, ownKeys, defineProperty: reflectDefineProperty, getOwnPropertyDescriptor: reflectDescriptor } = Reflect;
const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf, hasOwn, entries: objectEntries } = Object;
const ObjectPrototype = Object.prototype;
const RealAbortSignal = typeof AbortSignal === 'function' ? AbortSignal : null;
const abortedGetter = RealAbortSignal ? getOwnPropertyDescriptor(RealAbortSignal.prototype, 'aborted')?.get : undefined;
const abortedOf = (signal) => (abortedGetter ? apply(abortedGetter, signal, []) : undefined);
const isPrototypeOf = Object.prototype.isPrototypeOf;
const PromiseThen = Promise.prototype.then;
const MapGet = Map.prototype.get;
const MapSet = Map.prototype.set;
const MapHas = Map.prototype.has;
const MapDelete = Map.prototype.delete;
const WeakMapGet = WeakMap.prototype.get;
const WeakMapSet = WeakMap.prototype.set;
const WeakMapHas = WeakMap.prototype.has;
const SetHas = Set.prototype.has;
const SetAdd = Set.prototype.add;
const SetForEach = Set.prototype.forEach;
const SetDelete = Set.prototype.delete;
const MapForEach = Map.prototype.forEach;
const ArrayIsArray = Array.isArray;
const DateGetTime = Date.prototype.getTime;
const RealDateNow = Date.now;
const realPerformance = globalThis.performance;
const RealPerformanceNow = realPerformance.now;
const typedArrayPrototype = getPrototypeOf(Int8Array.prototype);
const typedBuffer = getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedOffset = getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedLength = getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const { afterAll, afterEach, beforeEach, mock } = bunTest;
const originalMockModule = mock.module;
/** The mock.module Bun shipped, even after the mock-module layer wrapped it. */
const realModuleOf = (holder) => (...args) => apply(originalMockModule, holder, args);
const nativeTimers = {
  setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval,
};
const realSetSystemTime = bunTest.setSystemTime;
// The platform's own transports, as the process started (a test's fake replaces them).
const NATIVE_TRANSPORT = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource };
const realIsFakeTimers = bunTest.jest?.isFakeTimers;
const isFakeTimers = typeof realIsFakeTimers === 'function' ? () => apply(realIsFakeTimers, bunTest.jest, []) : () => false;

/** The globals whose reads by engine code are inputs (package C0f): the transports and the DOM objects a test may install. */
const READ_GLOBALS = new RealSet(['fetch', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'document', 'window', 'navigator']);
const RECORDER_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOY_DIR = path.join(RECORDER_DIR, 'toy') + path.sep;
// Settings come from the environment, or from a per-file object a preload shim set before importing the
// recorder (the self-test records many planted copies in one bun process, one test file per copy).
const CONFIG = globalThis[Symbol.for('devryan.client-conformance.config')] ?? null;
const setting = (name) => (CONFIG && hasOwn(CONFIG, name) ? CONFIG[name] : process.env[name]);
// The base the recorded paths are relative to (the isolation guard strips names ending in _ROOT).
const ROOT = realpathSync(setting('DEVRYAN_CONFORMANCE_BASE') || path.resolve(RECORDER_DIR, '../..'));
const OUT = setting('DEVRYAN_CONFORMANCE_OUT') || '';
const layerList = (setting('DEVRYAN_CONFORMANCE_LAYERS') || LAYERS.join(',')).split(',').map((name) => name.trim()).filter(Boolean);
const DISCOVER = layerList.length === 1 && layerList[0] === DISCOVER_LAYER;
for (const name of layerList) if (!LAYERS.includes(name) && !DISCOVER) throw new Error(`client-conformance recorder: unknown layer ${name}${name === DISCOVER_LAYER ? ' (discover runs alone)' : ''}`);
const layers = new RealSet(DISCOVER ? [] : layerList);
const PORT_MAP_FILE = setting('DEVRYAN_CONFORMANCE_PORT_MAP');
const portMap = PORT_MAP_FILE && layers.has('entries') ? loadPortMap(PORT_MAP_FILE, { root: ROOT }) : null;
/** The families of the map by name; a stateful one (package C0e) names a `store` export or `moduleState` bindings. */
const FAMILY_BY_NAME = new RealMap((portMap?.families ?? []).map((family) => [family.name, family]));
const isStateful = (name) => { const family = apply(MapGet, FAMILY_BY_NAME, [name]); return Boolean(family && (family.store || family.moduleState)); };
// The entries engine code calls with no frame at all, which the census names with the engine site (`family#export`, comma-separated):
// such a call is passed through and counted; any other call with no frame flags its case `no-frame`.
const NO_FRAME_ALLOWED = new RealSet(String(setting('DEVRYAN_CONFORMANCE_NO_FRAME') ?? '').split(',').map((item) => item.trim()).filter(Boolean));

const relative = (absolute) => {
  const clean = absolute.replace(/\?.*$/, '');
  const resolved = path.relative(ROOT, clean).split(path.sep).join('/');
  return resolved.startsWith('../') || path.isAbsolute(resolved) ? '<outside>' : resolved;
};
const TEST_FILE = relative(Bun.main);

// ---------------------------------------------------------------- bookkeeping

const als = new AsyncLocalStorage();
const portNames = new RealWeakMap(); // wrapper or port object -> port name (the codec writes {"$dr":"port"})
const rawOf = new RealWeakMap(); // wrapper -> what it wraps
const errors = [];
const values = new RealMap(); // hash -> canonical text
/**
 * A nominal clock: `now` (Date) and `performance` (performance.now(), monotonic: it moves only with the
 * schedule, never with setSystemTime), and the time a test's setSystemTime override began. Each case has its
 * own, and only the timers that case set move it (see the clock).
 */
const newClock = (from = null) => (from ? { ...from } : { now: EPOCH, performance: PERFORMANCE_ORIGIN, beforeOverride: null, overrideSetAt: 0 });
let casesOpened = 0;
/**
 * The clock case number `index` opens with: its own slot of the file's time, EPOCH + index × CASE_SPAN_MS,
 * so it does not depend on how far the case before it got (a test that polls until its own timer fires
 * ends a millisecond earlier or later by load); never earlier than the previous case's clock as it closed,
 * so time never runs backward within a file; and, while a test's setSystemTime stands, the time it set.
 */
function openClock(previous, index) {
  if (!previous) return newClock();
  const clock = newClock(previous.clock);
  if (clock.beforeOverride !== null) return clock;
  clock.now = Math.max(clock.now, EPOCH + index * CASE_SPAN_MS);
  clock.performance = Math.max(clock.performance, PERFORMANCE_ORIGIN + index * CASE_SPAN_MS);
  return clock;
}

const guard = (what, fn, fallback) => {
  try { return fn(); } catch (error) {
    if (errors.length < 50) errors.push(`${what}: ${String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ')}`);
    return fallback;
  }
};
if (TEST_FILE === '<outside>') errors.push(`the test file is outside ${ROOT}: its recording cannot be named`);

const unwrap = (item) => apply(WeakMapGet, rawOf, [item]);
let testsSeen = 0;
/** A case: one test (`ordinal`) or the hooks that ran after `hooks` tests. */
function newCase({ ordinal = null, hooks = null }, previous = null) {
  const clock = openClock(previous, casesOpened);
  casesOpened += 1;
  const label = ordinal !== null ? String(ordinal) : `hooks:${hooks}`;
  const seed = createHash('sha256').update(`${TEST_FILE}#${ordinal !== null ? ordinal : label}`).digest();
  return {
    kind: ordinal !== null ? 'test' : 'hooks', ordinal, hooks, label, seed: seed.toString('hex').slice(0, 32), families: new RealMap(), context: [], moved: new RealSet(), touched: new RealSet(),
    codec: createCodecContext({ names: portNames, unwrap, unifyWrapped: true }), flags: new RealSet(), testTimers: 0, testCalls: 0, expired: [],
    clock, entryNow: clock.now, endNow: null, entryState: {}, endState: {}, random: sfc32(seed), out: null,
  };
}

// Microtask drains (never written): `drain` counts the macrotasks the recorder sees begin (package C0f).
let drain = 0;
let drainPending = false;
// step -> the later step it forwards to (never a member of the step: steps are written as they are).
const forwardOf = new RealWeakMap();
const drainOf = new RealWeakMap(); // step -> the drain it opened in
const familyOfStep = new RealWeakMap(); // step -> its family
const stepFamily = (step) => apply(WeakMapGet, familyOfStep, [step]);
// A nested input (`during` a port call of the outer step): once its synchronous part has returned, what it started is
// the outer step's, as a replay that delivers it inside that port call and then runs the outer step on sees it (C0f).
const outerOf = new RealWeakMap(); // nested step -> the outer step
const nestEnded = (step) => { const outer = apply(WeakMapGet, outerOf, [step]); if (outer) apply(WeakMapSet, forwardOf, [step, outer]); };
// The order steps opened in (never written): a release window moves a chain only forward.
let stepSeq = 0;
const seqOf = new RealWeakMap(); // step -> its opening number
const stepNumber = (step) => apply(WeakMapGet, seqOf, [step]) ?? 0;
// Once the file's recording is written, an engine effect or input has nowhere to go: it is counted, never dropped silently.
let written = false;
let unplaced = 0;
function noteUnplaced(kind) {
  unplaced += 1;
  if (OUT) guard('unplaced', () => writeFileSync(path.join(OUT, `${pathStem(TEST_FILE)}.unplaced.json`), JSON.stringify({ file: TEST_FILE, unplaced, last: String(kind) })));
}

/** The case a store belongs to: an engine or port store's own case, else the current one. */
const caseOf = (store) => (store && store.case ? store.case : current);
/** A value taken now, written when its case is written (codec.mjs: one identity scope per case line). */
class Pending { constructor(taken) { this.taken = taken; } }
function ref(value, owner = caseOf(storeNow())) {
  try { return new Pending(snapshot(value, owner.codec)); } catch (error) {
    owner.codec.flags.add('unencodable');
    return new Pending(snapshot(`unencodable: ${String(error?.message ?? error)}`, owner.codec));
  }
}
/** A copy of an argument list: the trap's own array is not the engine's, so its identity is not recorded. */
const listOf = (args) => { const out = []; for (let index = 0; index < args.length; index += 1) out[index] = args[index]; return out; };

let current = newCase({ hooks: 0 });
const closed = [];

/**
 * The store of the running code. A pass-through store (passThrough) holds only
 * while its call runs synchronously: a timer, a promise job or a callback that
 * call scheduled inherits the store object, but runs with no store, as test
 * code would, so what the test does there is the test's.
 */
const storeNow = () => {
  const store = als.getStore();
  return store !== undefined && store.kind === 'passthrough' && store.active !== true ? undefined : store;
};
/** Who is running: engine (a chain of a case, the current one or an earlier one), port, harness or test. */
function originOf(store) {
  if (!store) return 'test';
  return store.kind;
}

function familyRecord(name, owner = current) {
  let record = apply(MapGet, owner.families, [name]);
  if (!record) { record = { steps: [], timers: 0, portCalls: 0, objects: 0, flags: new RealSet(), live: new RealMap(), pending: [], signals: [] }; apply(MapSet, owner.families, [name, record]); }
  return record;
}

// Activity order: every time a chain places something, and every release, takes the next number.
let activity = 0;
/** A store for a chain of `family` in case `owner`, in `step`; `tick` is when the chain last placed something. */
const engineStore = (family, step, owner = current) => ({ kind: 'engine', family, case: owner, step, tick: (activity += 1) });
/**
 * A store for port (test) code; `caller` is the engine chain that called the
 * port, if any. It is `active` while the port call runs synchronously: what
 * the port starts asynchronously inherits the store, but is no re-entrance.
 */
const portStore = (caller = null, effect = null) => ({ kind: 'port', case: caller?.case ?? current, caller, active: true, effect });
/** Runs `fn` as port code called by `caller`. */
function inPort(caller, fn, effect = null) {
  const store = portStore(caller, effect);
  try { return als.run(store, fn); } finally { store.active = false; }
}
const reentrant = (opener) => opener?.kind === 'port' && opener.active === true;
const runIn = (store, fn) => (store ? als.run(store, fn) : als.exit(fn));
/**
 * A store for test code of case `kase`: a test body, a hook the test file registered, and a test timer's
 * callback run in one, so what they start (a promise job, a timer, a timer set from a timer) belongs to that
 * case even when it runs after its test ended. Test code with no store (a test API the recorder could not
 * wrap, code a module ran at load) runs for the current case.
 */
const testStore = (kase) => ({ kind: 'test', case: kase });
/**
 * A timer that fires after its case's test ended is no step (C0e fix round, an owner decision): whether it
 * fires before the file's recording is written is decided by real time, so it may never be part of what a
 * recording says. Its case records the timers still pending at its end instead (`end.pending`: which timer,
 * the delay it was set with, the step that set it), and the callback runs in a late store of that case:
 * nothing it does, and nothing it releases (its release windows are late too), is recorded for that case.
 * What it does to a stateful family's state while a later case runs is that case's `state-moved`.
 */
const lateStore = (kase, family = null) => ({ kind: 'late', case: kase, family });
/** Whether a release window of a late timer of ended case `kase` is running now. */
function lateWindowFor(kase) {
  if (kase.endNow === null) return false;
  for (const window of activeWindows) if (window.late === true && window.case === kase) return true;
  return false;
}
/** Whether code running in `store` runs for a late timer (a late store, or an engine or test chain such a timer released). */
function isLate(store) {
  if (!store) return false;
  if (store.kind === 'late' || store.late === true) return true;
  if ((store.kind === 'engine' || store.kind === 'test') && store.case && lateWindowFor(store.case)) { store.late = true; return true; }
  return false;
}

// ------------------------------------------------------------ release windows
//
// An `await` resumes in the store it was registered in, so a continuation
// that a later input made runnable (a gate a later call opens, a timer that
// resolves a waiter) would land in the step that registered it. A promise
// resolved by engine code therefore opens a release window: marker jobs are
// queued just before and just after the real resolve, so the jobs between
// them are exactly the reactions that resolve made runnable; each generation
// re-queues its markers, so the jobs between generation k's markers are
// exactly the jobs those reactions queued, and so on. Engine code that runs
// inside a window belongs to the step that resolved: its chain moves there
// (forward only). A window ends after SILENT_GENERATIONS generations in which
// no engine code ran. Markers are no-op jobs, so the program's own jobs keep
// their order. A promise test code resolves opens a window too: an engine
// continuation it releases was caused by no input of its family, so its case
// is flagged `released` (unrecordable), as is one released by another
// family's or another case's input. So is one that port code (a test's stub)
// released. A window that expired is remembered: a chain of its family and
// case that wakes later, still in a step older than the window's and idle
// since before the window opened, may be a continuation the window lost
// track of (more than SILENT_GENERATIONS silent generations from its
// release), so its case is flagged `release-expired` instead of misplacing it.
export const SILENT_GENERATIONS = 64;
const EXPIRED_KEPT = 64;
const RESOLVED = RealPromise.resolve();
const enqueue = (job) => { apply(PromiseThen, RESOLVED, [job]); };
const activeWindows = []; // windows whose current generation is running
let windowCount = 0;
function windowStart(window, generation) {
  if (window.done) return;
  window.generation = generation;
  activeWindows.push(window);
  enqueue(() => windowStart(window, generation + 1));
}
function windowEnd(window, generation) {
  const index = activeWindows.indexOf(window);
  if (index >= 0) activeWindows.splice(index, 1);
  if (generation - window.lastActive >= SILENT_GENERATIONS) { window.done = true; noteExpired(window); return; }
  enqueue(() => windowEnd(window, generation + 1));
}
function noteExpired(window) {
  if (window.late === true) return;
  const list = window.case.expired;
  list.push(window);
  if (list.length > EXPIRED_KEPT) list.shift();
}
/** What a release is attributed to: the resolving engine chain's step, or null for test and port code; null for harness code. */
function releaseTag() {
  const store = storeNow();
  const origin = originOf(store);
  if (origin === 'harness' || stepSeq === 0) return null;
  // What a late timer releases is late too: never a step, never a flag of its ended case.
  if (isLate(store)) return { step: null, family: store.family ?? null, case: store.case, late: true, openSeq: stepSeq, openTick: (activity += 1) };
  return guard('release', () => {
    const engine = origin === 'engine';
    return { step: engine ? stepOf(store) : null, family: engine ? store.family : null, case: caseOf(store), openSeq: stepSeq, openTick: (activity += 1) };
  }, null);
}
/** Runs `fn` (a real resolve, or a reaction registered on a promise a tag resolved) inside a release window of `tag`. */
function inWindow(tag, fn) {
  const window = { id: (windowCount += 1), ...tag, generation: 0, lastActive: 0, done: false };
  enqueue(() => windowStart(window, 0));
  try { return fn(); } finally { enqueue(() => windowEnd(window, 0)); }
}
// A promise a windowed resolver settled -> its release tag. A reaction an older engine chain registers on it
// afterwards (the job that adopts a returned promise registers one tick late) is released by that tag too.
const resolvedBy = new RealWeakMap();
/** A reaction registered now on `promise`: inside a window of the release that settled it, when the registering chain predates that release. */
function registeredLate(promise) {
  const tag = promise !== null && typeof promise === 'object' ? apply(WeakMapGet, resolvedBy, [promise]) : undefined;
  if (tag === undefined) return null;
  const store = storeNow();
  if (originOf(store) !== 'engine') return null;
  const seq = stepNumber(store.step);
  return (tag.step !== null ? seq < stepNumber(tag.step) : seq <= tag.openSeq) ? tag : null;
}

/**
 * The step an engine chain's code belongs to now. Inside a release window (the
 * latest opened, if several: load-bearing, since nested windows resolve
 * innermost first), a chain whose step is older than the window's moves to the
 * window's step; a chain of another family or case, or one released by test
 * or port code, is flagged `released`. Outside one, a chain that a window may
 * have lost is flagged `release-expired`.
 */
function stepOf(store) {
  if (store.late === true) return store.step;
  let window = null;
  for (const entry of activeWindows) if (!window || entry.id > window.id) window = entry;
  const seq = stepNumber(store.step);
  let placed = false;
  if (window !== null) {
    window.lastActive = window.generation;
    // A chain a late timer of its own case released is late from here on: what it does is recorded nowhere.
    if (window.late === true && window.case === store.case) { store.late = true; return store.step; }
    if (window.step !== null && window.case === store.case && window.family === store.family) {
      if (seq < stepNumber(window.step)) store.step = window.step;
      placed = store.step === window.step;
    } else if (seq <= window.openSeq) { store.case.flags.add('released'); placed = true; }
  }
  if (!placed) checkExpired(store, seq);
  store.tick = (activity += 1);
  return store.step;
}
/** Flags the chain's case when an expired window of its family (or of test or port code) released something after the chain last ran, in a later step. */
function checkExpired(store, seq) {
  for (const window of store.case.expired) {
    if (window.family !== null && window.family !== store.family) continue;
    const releasedIn = window.step !== null ? stepNumber(window.step) : window.openSeq + 1;
    if (seq < releasedIn && store.tick < window.openTick) { store.case.flags.add('release-expired'); return; }
  }
}

/**
 * AbortSignals the test hands the family (an argument, or a member of one; package C0f): whether one is aborted is
 * read through a platform getter no port sees, so a signal the test aborts after handing it in changes what the
 * engine reads with no input of the recording. Each is checked when a later step of the family opens and when its
 * case closes; one found aborted that was not when handed in flags the case `signal-aborted`.
 */
function watchSignals(family, kase, args) {
  const record = familyRecord(family, kase);
  const look = (value, depth) => {
    if (value === null || typeof value !== 'object') return;
    if (RealAbortSignal && apply(isPrototypeOf, RealAbortSignal.prototype, [value])) { if (abortedOf(value) === false) record.signals.push(value); return; }
    if (depth === 0 || ArrayIsArray(value) || getPrototypeOf(value) !== ObjectPrototype) return;
    for (const key of ownKeys(value)) { const descriptor = getOwnPropertyDescriptor(value, key); if (descriptor && hasOwn(descriptor, 'value')) look(descriptor.value, depth - 1); }
  };
  for (const arg of args) look(arg, 1);
}
function checkSignals(record) {
  if (!record.signals.length) return;
  if (record.signals.some((signal) => abortedOf(signal) === true)) record.flags.add('signal-aborted');
  record.signals = record.signals.filter((signal) => abortedOf(signal) !== true);
}

/** Opens a step of `family` in case `owner`; `opener` is the store the input arrives in (re-entrance is `during`). */
function openStep(family, input, opener = storeNow(), owner = current) {
  if (written) { noteUnplaced(input.kind); return null; }
  // A signal the test handed in and then aborted is an input no step holds (watchSignals); one the engine's own step
  // aborts is the engine's, so the check runs as the step opens, before its own code.
  guard('signals', () => checkSignals(familyRecord(family, owner)));
  // A stateful family's entry state, taken before its first step in the case (before the step's own input is read).
  if (isStateful(family) && !hasOwn(owner.entryState, family) && owner.endNow === null) owner.entryState[family] = guard('state', () => ref(familyState(family), owner), null);
  const record = familyRecord(family, owner);
  const step = { n: record.steps.length + 1, input: { ...input, now: readNow(owner) }, effects: [] };
  // An input that arrives after its case's test ended (a timer, an answer, a resolve) is still the case's: marked late.
  if (owner.endNow !== null) step.late = true;
  apply(WeakMapSet, seqOf, [step, (stepSeq += 1)]);
  const caller = reentrant(opener) ? opener.caller : null;
  if (caller && caller.kind === 'engine' && caller.case === owner && caller.family === family) {
    step.input.during = caller.step.n;
    apply(WeakMapSet, outerOf, [step, caller.step]);
    // Which port call of that step it arrived in (its number), so a replay delivers it inside that very call.
    if (opener.effect && opener.effect.call !== undefined) step.input.duringCall = opener.effect.call;
  }
  // Inputs that arrive together (package C0f). A marker job is queued when each step opens; an input of the same
  // family and case that arrives before the previous one's marker ran came before any microtask that input started
  // had run (the test's synchronous calls in a row, answers settling in one turn, frames a fake emits at once). It is
  // marked `together`, and the previous step forwards to it: whatever lands in that step from then on is this step's,
  // so the effects of a group are those of its last input, made after every input of the group was delivered, as a
  // replay that delivers the group at once makes them. Any other input is delivered by a replay once the step before
  // has run out (an immediate answer, settleStep, excepted), with its effects where its chain puts them.
  const previous = record.lastOpened;
  if (previous && previous.marker.ran !== true && step.input.during === undefined && previous.step.input.during === undefined && previous.step.late !== true && step.late !== true) {
    step.input.together = true;
    apply(WeakMapSet, forwardOf, [previous.step, step]);
  }
  const marker = { ran: false };
  enqueue(() => { marker.ran = true; });
  record.lastOpened = { step, marker };
  // The microtask drain the step opened in: a drain ends at the next macrotask (an immediate the recorder schedules, or
  // a platform timer's callback), when every job queued before it has run.
  apply(WeakMapSet, drainOf, [step, drain]);
  if (!drainPending) { drainPending = true; apply(realSetImmediate, globalThis, [() => { drain += 1; drainPending = false; }]); }
  apply(WeakMapSet, familyOfStep, [step, family]);
  record.steps.push(step);
  return step;
}

/** Puts an effect in `step` of case `owner`; one that arrives after the test ended is marked late. */
function place(step, owner, effect) {
  if (written) { noteUnplaced(effect.kind); return false; }
  // A step that an input arriving together with it forwards to (or a nested input that returned, to its outer step):
  // what lands in it is the later step's.
  for (let next = apply(WeakMapGet, forwardOf, [step]); next; next = apply(WeakMapGet, forwardOf, [step])) step = next;
  // Interleaved inputs (package C0f): an effect of an earlier step landing after a later step of its family opened in
  // the same microtask drain (their continuations interleave, as answers that come at once do while the input before
  // is still running) belongs to that step only by microtask order, which a replay that gives what follows an input
  // to that input cannot follow: the case is flagged `interleaved`.
  const record = apply(MapGet, owner.families, [stepFamily(step)]);
  const latest = record?.lastOpened?.step;
  if (latest && latest !== step && step.input.during === undefined && apply(WeakMapGet, drainOf, [latest]) === drain && apply(WeakMapGet, outerOf, [latest]) === undefined) record.flags.add('interleaved');
  if (owner.endNow !== null && step.late !== true) effect.late = true;
  step.effects.push(effect);
  return true;
}

/** Records an effect where it belongs: the step of the engine chain running it (in its own case), else the case context. */
function record(effect, store = storeNow()) {
  const origin = originOf(store);
  if (origin === 'port' || origin === 'harness' || origin === 'late') return false;
  if (origin === 'engine') {
    const step = stepOf(store);
    return isLate(store) ? false : place(step, store.case, effect);
  }
  // Test code a late timer released (a reaction of the test's on what the timer resolved) is late too.
  if (isLate(store)) return false;
  checkOutside();
  // Test code runs for the case whose test (or test timer) set it in motion (a test store), else for the current case.
  const kase = caseOf(store);
  effect.origin = 'test';
  if (kase.endNow !== null) effect.late = true;
  kase.context.push(effect);
  return true;
}

const isPromise = (value) => value !== null && typeof value === 'object' && apply(isPrototypeOf, RealPromise.prototype, [value]);
/** Observes a settlement without changing the promise the caller gets (it is marked handled; docs/TESTING.md). */
function observeSettle(promise, onSettle) {
  apply(PromiseThen, promise, [(value) => { guard('settle', () => onSettle('fulfilled', value)); }, (reason) => { guard('settle', () => onSettle('rejected', reason)); }]);
}

/** What a recorder wrapper that is no port stands for (the codec gives the two one identity); anything else is itself. */
const canonical = (value) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || apply(WeakMapHas, portNames, [value])) return value;
  const raw = apply(WeakMapGet, rawOf, [value]);
  return raw !== undefined && raw !== null && (typeof raw === 'object' || typeof raw === 'function') && !apply(WeakMapHas, portNames, [raw]) ? raw : value;
};
/** Paths of every container object in a draft, by identity, through own enumerable data members only. */
function identityPaths(root) {
  const paths = [];
  const visited = new RealSet();
  const walk = (given, where) => {
    const value = canonical(given);
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    paths.push([where, value]);
    if (apply(SetHas, visited, [value]) || typeof value === 'function') return;
    apply(SetAdd, visited, [value]);
    if (apply(isPrototypeOf, RealMap.prototype, [value])) {
      apply(MapForEach, value, [(entry, key) => walk(entry, [...where, { map: key }])]);
      return;
    }
    for (const key of ownKeys(value)) {
      if (typeof key !== 'string') continue;
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) continue;
      walk(descriptor.value, [...where, ArrayIsArray(value) && /^\d+$/.test(key) ? Number(key) : key]);
    }
  };
  walk(root, []);
  return paths;
}
// Map keys are compared by identity (SameValueZero), path members by value.
function pathKey(where, keys) {
  return where.map((part) => {
    if (part === null || typeof part !== 'object') return JSON.stringify(part);
    let id = apply(MapGet, keys, [part.map]);
    if (id === undefined) { id = keys.size; apply(MapSet, keys, [part.map, id]); }
    return `{map:${id}}`;
  }).join('/');
}
function changedPaths(before, root) {
  const keys = new RealMap();
  const known = new RealMap();
  for (const [where, value] of before) apply(MapSet, known, [pathKey(where, keys), value]);
  return identityPaths(root).filter(([where, value]) => apply(MapGet, known, [pathKey(where, keys)]) !== value).map(([where]) => where);
}

// --------------------------------------------------------------- seeded random

function sfc32(seed) {
  let a = seed.readUInt32LE(0) | 0; let b = seed.readUInt32LE(4) | 0; let c = seed.readUInt32LE(8) | 0; let d = seed.readUInt32LE(12) | 0;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let index = 0; index < 12; index += 1) next();
  return next;
}
// 2^26 and 2^53, written out: harness output must not depend on Math.pow.
const TWO_26 = 67108864;
const TWO_53 = 9007199254740992;
// A draw comes from the stream of the case whose code draws (an engine chain's own case, even after its test ended).
// A module's own code drawing with no chain and no test store (a module drawing an id while it loads, package C0f)
// draws from a stream of its own draw site instead: which case is current when a module loads (a dynamic import
// resolves) is a matter of real time, and the value it draws must not be.
const siteStreams = new RealMap(); // draw site -> its stream
function streamNow() {
  const store = storeNow();
  if (store !== undefined) return caseOf(store).random;
  const site = guard('draw', () => drawSite(), null);
  const file = site === null ? null : site.slice(0, site.lastIndexOf(':'));
  if (file === null || file === '<unknown>' || file === '<outside>' || isTestPath(file)) return current.random;
  if (!apply(MapHas, siteStreams, [site])) apply(MapSet, siteStreams, [site, sfc32(createHash('sha256').update(`${TEST_FILE}#site#${site}`).digest())]);
  return apply(MapGet, siteStreams, [site]);
}
const drawFloat = () => { const random = streamNow(); return ((random() >>> 5) * TWO_26 + (random() >>> 6)) / TWO_53; };
function drawBytes(length) {
  const bytes = new RealUint8Array(length);
  const random = streamNow();
  for (let index = 0; index < length; index += 4) {
    const word = random();
    for (let offset = 0; offset < 4 && index + offset < length; offset += 1) bytes[index + offset] = (word >>> (offset * 8)) & 255;
  }
  return bytes;
}

const FRAME = /\(?((?:\/|[A-Za-z]:\\)[^():]+(?:\?[^():]*)?):(\d+)(?::\d+)?\)?\s*$/;
const DEFAULT_STACK = RealError.stackTraceLimit;
/** The running code's stack as an Error gives it, `limit` frames deep (the first line is the Error's own). */
function stackText(limit) {
  const saved = RealError.stackTraceLimit;
  try { RealError.stackTraceLimit = limit; return String(new RealError().stack ?? ''); } finally { RealError.stackTraceLimit = saved; }
}
/** The frames of the running code with a file, newest first, as `[file, line]`; the recorder's own are left out. `text`: a stack already taken. */
function frames(limit, text = stackText(limit)) {
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const file = match[1].replace(/\?.*$/, '');
    if (file.startsWith(RECORDER_DIR + path.sep) && !file.startsWith(TOY_DIR)) continue;
    out.push([file, match[2]]);
  }
  return out;
}
function drawSite() {
  // As many frames as an Error carries by default, plus this helper's own.
  const [first] = frames(DEFAULT_STACK + 1);
  return first ? `${relative(first[0])}:${first[1]}` : '<unknown>';
}

// Engine code running outside any engine chain: code of a family that the test reached through a value
// the recorder could not wrap (a function deep inside returned data, one the engine passed to a test
// callback), or that ran at module load. What it does is no step of any input, so it is flagged
// `outside-chain`, and never lost: a family the flag names gets a line in the case (with no step) if it has
// none, so the case is written, unrecordable, for that family. Two detectors:
// - a call of a family's port (a module port, or a member of a port object of particular families) with no
//   engine chain running (flagOutside), decided by its caller, the first frame outside the recorder: a
//   frame of a family's own module is that family's engine code, which flags that family; test code flags
//   the port's families that have a line, and gives each that has none a line flagged `port-no-line`,
//   since JavaScriptCore's proper tail calls drop the frame of `() => port(...)`, so a closure of the
//   family can look like the test's own call; engine code no family maps (or anything inside a
//   pass-through call) is that code's own dependency: passed through and counted (`passed.ports`);
// - any other effect with no engine chain running (a timer, a clock read, a draw, a global port's call or
//   read) flags the case when a frame of a family's module is on the stack (checkOutside), and gives each
//   such family a line. That one is best effort: a tail call or code in a module the family imports
//   leaves no frame of the family's own module.
const FAMILY_FILES = portMap ? new RealMap(portMap.families.map((family) => [family.module, portMap.modules.get(family.module)?.families ?? [family.name]])) : null;
const STACK_DEPTH = 200;
/** The families whose module has code on the stack. */
function familiesOnStack() {
  const found = [];
  // Most checks find no family module at all: its path in the stack's text is needed for a frame of it.
  const text = stackText(STACK_DEPTH);
  let named = false;
  apply(MapForEach, FAMILY_FILES, [(_names, file) => { if (!named && text.includes(file)) named = true; }]);
  if (!named) return found;
  for (const [file] of frames(STACK_DEPTH, text)) for (const name of apply(MapGet, FAMILY_FILES, [file]) ?? []) if (!found.includes(name)) found.push(name);
  return found;
}
/** Flags `flag` on the line of `name` in the current case, making the line (with no step) when there is none. */
function flagFamily(name, flag) {
  familyRecord(name).flags.add(flag);
}
/** With no engine chain running: flags the current case when family code is running anyway, and gives each such family a line. */
function checkOutside() {
  if (originOf(storeNow()) === 'passthrough') return;
  if (!FAMILY_FILES) return;
  const found = guard('outside', () => familiesOnStack(), []);
  if (found.length === 0) return;
  current.flags.add('outside-chain');
  for (const name of found) familyRecord(name);
}
/** A family's port used with no engine chain running (see above). `port` is its name. */
function flagOutside(families, port) {
  const passing = originOf(storeNow()) === 'passthrough';
  const [first] = guard('caller', () => frames(CALLER_FRAMES), []);
  const file = first ? first[0] : null;
  const test = file !== null && isTestCode(file);
  const own = file !== null ? apply(MapGet, FAMILY_FILES, [file]) : undefined;
  if (!test && (passing || own === undefined)) { notePassedPort(port, file, passing); return; }
  if (own !== undefined) for (const name of own) flagFamily(name, 'outside-chain');
  apply(SetForEach, families, [(name) => {
    const record = apply(MapGet, current.families, [name]);
    // A line that only an earlier port-no-line made has no engine code of its own: another such use is the same.
    const lineOnly = record !== undefined && record.steps.length === 0 && record.flags.has('port-no-line');
    if (record && !(test && lineOnly)) record.flags.add('outside-chain');
    else if (test) flagFamily(name, 'port-no-line');
  }]);
}

function noteDraw(source, value, store = storeNow()) {
  const origin = originOf(store);
  if (origin === 'port' || origin === 'harness') return;
  record(origin === 'engine' ? { kind: 'draw', source, value: ref(value), site: drawSite() } : { kind: 'draw', source, value: ref(value) }, store);
}

const seededRandom = function random() {
  const value = drawFloat();
  guard('draw', () => noteDraw('Math.random', value));
  return value;
};
const seededGetRandomValues = function getRandomValues(array) {
  if (!apply(isPrototypeOf, typedArrayPrototype, [array])) throw new TypeError('getRandomValues expects an integer typed array');
  const view = new RealUint8Array(apply(typedBuffer, array, []), apply(typedOffset, array, []), apply(typedLength, array, []));
  const bytes = drawBytes(view.length);
  view.set(bytes);
  guard('draw', () => noteDraw('crypto.getRandomValues', bytes));
  return array;
};
const seededRandomUUID = function randomUUID() {
  const bytes = drawBytes(16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => (byte < 16 ? '0' : '') + byte.toString(16)).join('');
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  guard('draw', () => noteDraw('crypto.randomUUID', value));
  return value;
};

// ------------------------------------------------------------------- the clock

// The clock is per case (newClock), so what a case reads depends only on what the case did: a case opens
// in its own slot of the file's time (openClock), and from then on only a timer the case itself set (its test code, its engine chains or its port code) moves it, when it fires, to
// that timer's nominal due time (its set time on the case's clock plus its delay). A timer an earlier case
// left running moves that case's clock only, so it fires as a late input of its own case and never shifts
// the time a later case sees, however real time interleaves the two. Code reads the clock of the case it
// runs for: an engine or port chain its own case's, test code the current case's.
let fakePerformance = null; // { real, nominal } when fake timers started
const fakeTimersOn = () => { try { return isFakeTimers() === true; } catch { return false; } };
/** The clock that running code reads and sets: that of the case its chain belongs to, else the current case's. */
const clockOf = (store = storeNow()) => caseOf(store).clock;
function advance(clock, due) { if (due > clock.now) { clock.performance += due - clock.now; clock.now = due; } }
/** The time an input or a clock read sees: the nominal clock of `kase`, or under fake timers the fake clock (started at it). */
const readNow = (kase = caseOf(storeNow())) => (fakeTimersOn() ? apply(RealDateNow, RealDate, []) : kase.clock.now);
function readPerformanceNow() {
  if (fakeTimersOn() && fakePerformance) return fakePerformance.nominal + (apply(RealPerformanceNow, realPerformance, []) - fakePerformance.real);
  return clockOf().performance;
}
function noteClock(source, value, store = storeNow()) {
  guard('clock', () => {
    const origin = originOf(store);
    if (origin === 'engine') record({ kind: 'clock', source, value: ref(value) }, store);
    else if (origin === 'test') checkOutside();
  });
}
const nominalNow = function now() { const value = readNow(); noteClock('Date.now', value); return value; };
const nominalPerformanceNow = function now() { const value = readPerformanceNow(); noteClock('performance.now', value); return value; };

/** A clock or random stub a test installed: it answers (as port code), and its answer is recorded. */
const stubWrappers = new RealWeakMap();
function stubWrapper(stub, source, kind) {
  if (typeof stub !== 'function') return stub;
  if (apply(WeakMapHas, rawOf, [stub])) return stub;
  const cached = apply(WeakMapGet, stubWrappers, [stub]);
  if (cached && cached.source === source) return cached.wrapper;
  const wrapper = { [source.split('.').pop()](...args) {
    const store = storeNow();
    const origin = originOf(store);
    const answer = origin === 'engine' ? inPort(store, () => apply(stub, this, args)) : apply(stub, this, args);
    if (kind === 'clock') noteClock(source, answer, store);
    else guard('draw', () => noteDraw(source, answer, store));
    return answer;
  } }[source.split('.').pop()];
  apply(WeakMapSet, rawOf, [wrapper, stub]);
  apply(WeakMapSet, stubWrappers, [stub, { source, wrapper }]);
  return wrapper;
}

// Date is a Proxy over the real Date. Its `now` lives on the real Date (so a
// spy, an assignment and a restore behave as without the recorder); reading it
// gives the nominal clock, or a wrapper of whatever stub the test put there.
const dateNowOf = (target) => {
  const descriptor = reflectDescriptor(target, 'now');
  const value = descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  if (value === RealDateNow) return layers.has('clock') ? nominalNow : RealDateNow;
  return stubWrapper(value, 'Date.now', 'clock');
};
const dateNowStored = (value) => {
  if (value === nominalNow) return RealDateNow;
  const raw = apply(WeakMapGet, rawOf, [value]);
  return raw !== undefined && apply(WeakMapHas, stubWrappers, [raw]) ? raw : value;
};
const NominalDate = new RealProxy(RealDate, {
  construct(target, args, newTarget) {
    const made = newTarget === NominalDate ? target : newTarget;
    if (args.length === 0 && layers.has('clock')) { const value = readNow(); noteClock('new Date', value); return construct(target, [value], made); }
    return construct(target, args, made);
  },
  apply(target, thisArg, args) {
    if (!layers.has('clock')) return apply(target, thisArg, args);
    const value = readNow();
    noteClock('Date()', value);
    return new RealDate(value).toString();
  },
  get(target, key, receiver) {
    if (key === 'now') return dateNowOf(target);
    return reflectGet(target, key, receiver);
  },
  set(target, key, value, receiver) {
    if (key === 'now') return reflectSet(target, key, dateNowStored(value));
    return reflectSet(target, key, value, receiver);
  },
  defineProperty(target, key, descriptor) {
    if (key === 'now' && hasOwn(descriptor, 'value')) return reflectDefineProperty(target, key, { ...descriptor, value: dateNowStored(descriptor.value) });
    return reflectDefineProperty(target, key, descriptor);
  },
  getOwnPropertyDescriptor(target, key) {
    const descriptor = reflectDescriptor(target, key);
    if (key === 'now' && descriptor && hasOwn(descriptor, 'value') && descriptor.configurable) return { ...descriptor, value: dateNowOf(target) };
    return descriptor;
  },
});
apply(WeakMapSet, rawOf, [NominalDate, RealDate]);

function setSystemTimeWrapper(real) {
  const wrapper = { setSystemTime(time, ...rest) {
    if (layers.has('clock')) guard('setSystemTime', () => {
      const clock = clockOf();
      if (time === undefined || time === null) {
        if (clock.beforeOverride !== null) { clock.now = clock.beforeOverride + Math.max(0, clock.now - clock.overrideSetAt); clock.beforeOverride = null; }
        return;
      }
      const value = apply(DateGetTime, new RealDate(time), []);
      if (value !== value) return;
      if (clock.beforeOverride === null) clock.beforeOverride = clock.now;
      clock.overrideSetAt = value;
      clock.now = value;
    });
    return apply(real, this, [time, ...rest]);
  } }.setSystemTime;
  apply(WeakMapSet, rawOf, [wrapper, real]);
  return wrapper;
}
/** Fake timers start their clock at the nominal time; leaving them carries the time they reached back. */
function useFakeTimersWrapper(real) {
  const wrapper = { useFakeTimers(...args) {
    const result = apply(real, this, args);
    if (layers.has('clock')) guard('useFakeTimers', () => {
      const options = args[0];
      const clock = clockOf();
      if (!(options && typeof options === 'object' && hasOwn(options, 'now'))) apply(realSetSystemTime, bunTest, [clock.now]);
      fakePerformance = { real: apply(RealPerformanceNow, realPerformance, []), nominal: clock.performance, date: apply(RealDateNow, RealDate, []) };
    });
    return result;
  } }.useFakeTimers;
  apply(WeakMapSet, rawOf, [wrapper, real]);
  return wrapper;
}
function useRealTimersWrapper(real) {
  const wrapper = { useRealTimers(...args) {
    const reached = layers.has('clock') && fakeTimersOn() && fakePerformance ? { date: apply(RealDateNow, RealDate, []), performance: readPerformanceNow() } : null;
    const result = apply(real, this, args);
    if (reached !== null) guard('useRealTimers', () => { const clock = clockOf(); if (reached.date > clock.now) clock.now = reached.date; if (reached.performance > clock.performance) clock.performance = reached.performance; fakePerformance = null; });
    return result;
  } }.useRealTimers;
  apply(WeakMapSet, rawOf, [wrapper, real]);
  return wrapper;
}

// ------------------------------------------------------------------ the timers

const timerIds = new RealWeakMap(); // object handle -> { id, case, family }
const primitiveTimerIds = new RealMap(); // number handle (a trap's answer) -> the same, or { ambiguous }
const timerWrappers = { setTimeout: new RealWeakMap(), setInterval: new RealWeakMap(), clearTimeout: new RealWeakMap(), clearInterval: new RealWeakMap() };

// Timer order (package C0f). Real timers fire in the order of their real due times, and a timer's real set
// time carries every lateness before it (a timer set from a late callback is set late), so two timers can fire
// in one order on a quiet machine and in the other under load. The recorder therefore releases the platform
// timers of one case (the engine's, the test's and port code's alike) in the order of their due times on a timer
// clock of the case's own: a timer is due its delay after it was set, at least 1 ms (the platform's own floor),
// and the timer clock moves to a timer's due time when it fires, so a chain of zero-delay timers (a poll) moves it
// on as it moves real time on, and a longer timer the poll waits for still comes due; ties go by the order the
// timers were set. (The nominal clock the engine reads is not this one: a zero-delay timer does not move it.)
// A real firing whose timer still has a timer of its case due earlier (or as early, and set before it) pending is
// held, and runs, in its own macrotask, once every such timer has fired or been cleared. A timer still fires no
// earlier than its real due time, so real work the clock cannot see (a module load, I/O) keeps its real head start
// (the rejected auto-advancing clock, design §2.5). Fake timers (the test's) are not held. What this does not
// order: work that is no timer (real I/O, a module load, setImmediate jobs) against the timers, and whether a timer
// fires before its test ends (C0e fix round: one that fires after is no step).
const realSetImmediate = globalThis.setImmediate;
let timerSeq = 0;
const gateEntries = new RealWeakMap(); // object handle -> its gate entry
const primitiveGateEntries = new RealMap(); // number handle -> its gate entry
const gateOf = (kase) => (kase.timerGate ??= { pending: new RealSet(), held: [], releasing: false, now: 0 });
const dueBefore = (left, right) => left.due < right.due || (left.due === right.due && left.seq < right.seq);
function gateBlocked(gate, entry) {
  let blocked = false;
  apply(SetForEach, gate.pending, [(other) => { if (!blocked && other !== entry && !other.done && dueBefore(other, entry)) blocked = true; }]);
  return blocked;
}
/** Runs, one per macrotask, the held firings of `kase` that nothing pending is due before (all of them once its test ended). */
function scheduleRelease(kase) {
  const gate = kase.timerGate;
  if (!gate || gate.releasing || gate.held.length === 0) return;
  gate.releasing = true;
  apply(realSetImmediate, globalThis, [() => {
    gate.releasing = false;
    gate.held = gate.held.filter((item) => item.entry.done !== true);
    gate.held.sort((left, right) => (dueBefore(left.entry, right.entry) ? -1 : dueBefore(right.entry, left.entry) ? 1 : left.order - right.order));
    const held = gate.held.findIndex((item) => kase.endNow !== null || !gateBlocked(gate, item.entry));
    if (held < 0) return;
    const [item] = gate.held.splice(held, 1);
    item.run();
    scheduleRelease(kase);
  }]);
}
const gateEntryOf = (handle) => (handle !== null && (typeof handle === 'object' || typeof handle === 'function') ? apply(WeakMapGet, gateEntries, [handle]) : apply(MapGet, primitiveGateEntries, [handle]));
function gateCleared(handle) {
  const entry = gateEntryOf(handle);
  if (!entry || entry.done) return;
  entry.done = true;
  apply(SetDelete, entry.gate.pending, [entry]);
  entry.gate.held = entry.gate.held.filter((item) => item.entry !== entry);
  scheduleRelease(entry.case);
}

function setTimerWrapper(kind, underlying) {
  const cache = timerWrappers[kind];
  if (apply(WeakMapHas, cache, [underlying])) return apply(WeakMapGet, cache, [underlying]);
  const repeat = kind === 'setInterval';
  const native = underlying === nativeTimers[kind];
  const wrapper = { [kind](callback, delay, ...rest) {
    const store = storeNow();
    const origin = originOf(store);
    if (origin === 'harness') return apply(underlying, native ? globalThis : this, [callback, delay, ...rest]);
    // A timer late code sets is late code's: it runs in that late store, and nothing is recorded of it.
    if (isLate(store)) return apply(underlying, native ? globalThis : this, [typeof callback === 'function' ? function (...args) { return als.run(store, () => apply(callback, this, args)); } : callback, delay, ...rest]);
    const counted = origin !== 'port';
    const engine = origin === 'engine';
    // Engine timers are numbered 1, 2, ... per family; the test's own are t1, t2, ... so they never shift the engine's.
    // A test timer belongs to the case whose test code set it in motion (its test store). Code with no store
    // (a test API the recorder could not wrap, a job a module started at load, a job of a pass-through call)
    // has no known owner: the current case is taken, and if the timer then moves that case's clock, the case
    // is flagged (`timer-owner-unknown`), never moved silently.
    const owner = caseOf(store);
    const unowned = store === undefined;
    const id = !counted ? null : engine ? (familyRecord(store.family, store.case).timers += 1) : `t${(owner.testTimers += 1)}`;
    // The case whose clock the timer moves: the one whose code set it (a port's caller's, for port code).
    const timed = caseOf(store);
    const setAt = timed.clock.now;
    const span = typeof delay === 'number' && delay > 0 ? delay : 0;
    let fires = 0;
    // Timer order (package C0f): a platform timer's firing is released in timer-clock order within its case (above).
    const setStore = als.getStore();
    const gateSpan = Math.max(1, span);
    const gateEntry = native && typeof callback === 'function' && !fakeTimersOn() ? { case: timed, gate: gateOf(timed), seq: (timerSeq += 1), due: gateOf(timed).now + gateSpan, repeat, done: false } : null;
    const settleEntry = () => {
      if (!gateEntry) return;
      if (repeat) gateEntry.due += gateSpan;
      else if (!gateEntry.done) { gateEntry.done = true; apply(SetDelete, gateEntry.gate.pending, [gateEntry]); }
      scheduleRelease(timed);
    };
    const run = typeof callback === 'function' ? function (...args) {
      if (gateEntry && gateEntry.due > gateEntry.gate.now) gateEntry.gate.now = gateEntry.due;
      try { return apply(body, this, args); } finally { settleEntry(); }
    } : callback;
    const fire = gateEntry ? function (...args) {
      if (gateEntry.done) return undefined;
      if (timed.endNow === null && gateBlocked(gateEntry.gate, gateEntry)) {
        const self = this;
        gateEntry.gate.held.push({ entry: gateEntry, order: (timerSeq += 1), run: () => (setStore !== undefined ? als.run(setStore, () => apply(run, self, args)) : als.exit(() => apply(run, self, args))) });
        return undefined;
      }
      return apply(run, this, args);
    } : run;
    const body = typeof callback === 'function' ? function (...args) {
      fires += 1;
      drain += 1; // a timer's callback begins a macrotask: every job queued before it has run
      // A timer that fires after its case's test ended is no step and no context of that case: it was recorded as
      // pending at the case's end, and what its callback does now is recorded nowhere (see lateStore).
      if (counted && timed.endNow !== null) return runLate(engine ? store.family : null, owner, () => apply(callback, this, args));
      if (counted && engine && !repeat) guard('timer.fire', () => { apply(MapDelete, familyRecord(store.family, store.case).live, [id]); });
      if (layers.has('clock')) {
        if (unowned && counted && timed.kind === 'test' && setAt + span * fires > timed.clock.now) guard('timer.fire', () => timed.flags.add('timer-owner-unknown'));
        advance(timed.clock, setAt + span * fires);
      }
      const opener = storeNow();
      // An engine timer's firing is an input of the case that set it, even after that test ended (marked late).
      const step = counted && engine ? guard('timer.fire', () => openStep(store.family, { kind: 'timer', id }, opener, store.case), null) : null;
      if (!step) {
        // A test timer is context of the case whose test set it; one that fires after that test ended is that case's, late.
        if (counted && !engine) guard('timer.fire', () => owner.context.push(owner.endNow !== null ? { kind: 'timer.fire', id, origin: 'test', late: true } : { kind: 'timer.fire', id, origin: 'test' }));
        // A test timer's callback is test code of its own case: a timer it sets, or a job it starts, is that case's too.
        return runIn(origin === 'test' ? testStore(owner) : store, () => apply(callback, this, args));
      }
      // The chain that set the timer moves to its firing (an await on it resumes there), except for a re-entrant firing.
      const nested = reentrant(opener);
      const previous = store.step;
      store.step = step;
      const beforeState = stateBefore(store.family);
      try { return als.run(engineStore(store.family, step, store.case), () => apply(callback, this, args)); } finally {
        if (nested) store.step = previous;
        step.returnedAt = step.effects.length;
        stateAfter(store.family, step, beforeState, store.case);
      }
    } : callback;
    if (counted) guard('timer.set', () => record({ kind: 'timer.set', id, delay: ref(delay), repeat }, store));
    // An engine timer is pending until it fires (a timeout) or is cleared; those still pending at the case's end are written there.
    if (counted && engine && store.case.endNow === null) guard('timer.set', () => { apply(MapSet, familyRecord(store.family, store.case).live, [id, { id, delay: ref(delay, store.case), repeat, step: store.step ? store.step.n : null }]); });
    const handle = inPort(engine ? store : null, () => apply(underlying, native ? globalThis : this, [fire, delay, ...rest]));
    if (gateEntry && handle !== undefined && handle !== null) {
      apply(SetAdd, gateEntry.gate.pending, [gateEntry]);
      if (typeof handle === 'object' || typeof handle === 'function') apply(WeakMapSet, gateEntries, [handle, gateEntry]); else apply(MapSet, primitiveGateEntries, [handle, gateEntry]);
    }
    if (counted && handle !== undefined && handle !== null) guard('timer.id', () => {
      const entry = { id, case: owner, family: engine ? store.family : null };
      if (typeof handle === 'object' || typeof handle === 'function') apply(WeakMapSet, timerIds, [handle, entry]);
      else apply(MapSet, primitiveTimerIds, [handle, apply(MapHas, primitiveTimerIds, [handle]) ? { ambiguous: true } : entry]);
    });
    return handle;
  } }[kind];
  apply(WeakMapSet, cache, [underlying, wrapper]);
  apply(WeakMapSet, rawOf, [wrapper, underlying]);
  return wrapper;
}

function clearTimerWrapper(kind, underlying) {
  const cache = timerWrappers[kind];
  if (apply(WeakMapHas, cache, [underlying])) return apply(WeakMapGet, cache, [underlying]);
  const native = underlying === nativeTimers[kind];
  const wrapper = { [kind](handle) {
    const store = storeNow();
    const origin = originOf(store);
    // A cleared platform timer no longer holds back the timers of its case due after it (timer order, C0f).
    if (origin !== 'harness' && handle !== undefined && handle !== null) guard('timer.clear', () => gateCleared(handle));
    if (origin !== 'harness' && origin !== 'port' && handle !== undefined && handle !== null) {
      guard('timer.clear', () => {
        const object = typeof handle === 'object' || typeof handle === 'function';
        const known = object ? apply(WeakMapGet, timerIds, [handle]) : apply(MapGet, primitiveTimerIds, [handle]);
        if (!object) apply(MapDelete, primitiveTimerIds, [handle]);
        // A cleared engine timer is no longer pending, whoever clears it.
        if (known && !known.ambiguous && known.family !== null && known.case.endNow === null) apply(MapDelete, familyRecord(known.family, known.case).live, [known.id]);
        if (isLate(store)) return;
        // A timer that is no own timer of the clearing chain (one the test or another family set, an unknown handle, one an
        // earlier case set) is named by its handle, a value of the case, not by another side's numbering (package C0e).
        let effect;
        if (!known) effect = { kind: 'timer.clear', id: null, handle: ref(handle) };
        else if (known.ambiguous) effect = { kind: 'timer.clear', id: null, ambiguous: true };
        else if (known.case !== caseOf(origin === 'engine' ? store : null)) effect = { kind: 'timer.clear', id: null, handle: ref(handle), earlier: true };
        else if (origin === 'engine' && known.family !== store.family) effect = { kind: 'timer.clear', id: null, handle: ref(handle) };
        else effect = { kind: 'timer.clear', id: known.id };
        record(effect, store);
      });
    }
    return inPort(origin === 'engine' ? store : null, () => apply(underlying, native ? globalThis : this, [handle]));
  } }[kind];
  apply(WeakMapSet, cache, [underlying, wrapper]);
  apply(WeakMapSet, rawOf, [wrapper, underlying]);
  return wrapper;
}

// ------------------------------------------------------------------- the ports

/** A Proxy get trap may substitute a value only where the invariants allow it. */
function substitutable(target, key) {
  const descriptor = getOwnPropertyDescriptor(target, key);
  return !descriptor || descriptor.configurable || (hasOwn(descriptor, 'value') && descriptor.writable === true);
}

const DATA_CLASSES = [Map, Set, Date, RegExp, Error, ArrayBuffer, typedArrayPrototype.constructor, Promise, WeakMap, WeakSet]
  .map((constructor) => constructor.prototype);
/** Whether an answer looks like something with behaviour (methods, iteration) rather than data. */
function portLike(value) {
  if (value === null || typeof value !== 'object' || ArrayIsArray(value) || apply(WeakMapHas, portNames, [value])) return false;
  for (const prototype of DATA_CLASSES) if (apply(isPrototypeOf, prototype, [value])) return false;
  const prototype = getPrototypeOf(value);
  if (prototype !== ObjectPrototype && prototype !== null) return true;
  for (const key of ownKeys(value)) {
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'function') return true;
  }
  return false;
}

const callbackWrappers = new RealWeakMap(); // engine function -> wrapper handed to a port
/** A function the engine hands to a port: its invocation from outside is an input. `owner` is the chain that handed it out. */
function callbackFor(family, name, fn, owner) {
  if (apply(WeakMapHas, callbackWrappers, [fn])) return apply(WeakMapGet, callbackWrappers, [fn]);
  if (apply(WeakMapHas, rawOf, [fn])) return fn;
  const wrapper = new RealProxy(fn, {
    apply(target, thisArg, args) {
      const store = storeNow();
      const origin = originOf(store);
      if (origin === 'engine' || origin === 'harness') return apply(target, thisArg, args);
      // Late code (see lateStore) calling back a function the engine handed a port: no step of the ended case.
      if (isLate(store)) return runLate(family, store.case, () => apply(target, thisArg, args));
      const kase = caseOf(store);
      guard('callback', () => { for (const arg of args) markForeign(arg); });
      // `target` is the engine's function itself, the one the port was handed (its identity names which one).
      const step = guard('callback', () => openStep(family, { kind: 'callback', port: name, args: ref(listOf(args), kase), target: ref(target, kase) }, store, kase), null);
      if (!step) return apply(target, thisArg, args);
      // An asynchronous invocation moves the chain that handed the callback out (a promise it resolves resumes there).
      if (!reentrant(store) && owner && owner.case === kase) owner.step = step;
      const chain = engineStore(family, step, kase);
      const beforeState = stateBefore(family);
      let result;
      try {
        result = als.run(chain, () => apply(target, thisArg, args));
      } catch (error) {
        guard('callback', () => { step.returnedAt = step.effects.length; step.throws = ref(error); });
        stateAfter(family, step, beforeState, kase);
        nestEnded(step);
        throw error;
      }
      stateAfter(family, step, beforeState, kase);
      guard('callback', () => { step.returnedAt = step.effects.length; step.returns = ref(result); if (isPromise(result)) observeSettle(result, (outcome, value) => settledOutput(chain, step, outcome, value)); });
      nestEnded(step);
      return result;
    },
  });
  apply(WeakMapSet, callbackWrappers, [fn, wrapper]);
  apply(WeakMapSet, rawOf, [wrapper, fn]);
  return wrapper;
}

/**
 * A plain object the engine hands a port that carries its own functions (an SDK call's options with onSseEvent and
 * onSseError, package C0f): the port reads it through a view whose function members are callbacks (`<port>:<i>.<key>`),
 * so the port calling one back is an input, as a function handed in whole is. The view has the object's identity.
 */
function callbacksIn(store, name, arg) {
  if (arg === null || typeof arg !== 'object' || ArrayIsArray(arg) || apply(WeakMapHas, rawOf, [arg]) || apply(WeakMapHas, portNames, [arg])) return arg;
  const prototype = getPrototypeOf(arg);
  if (prototype !== ObjectPrototype && prototype !== null) return arg;
  const holds = ownKeys(arg).some((key) => { const descriptor = getOwnPropertyDescriptor(arg, key); return typeof key === 'string' && descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'; });
  if (!holds) return arg;
  const view = new RealProxy(arg, {
    get(object, key, receiver) {
      const value = reflectGet(object, key, receiver);
      return typeof value === 'function' && typeof key === 'string' && substitutable(object, key) && !apply(WeakMapHas, rawOf, [value]) ? callbackFor(store.family, `${name}.${key}`, value, store) : value;
    },
  });
  apply(WeakMapSet, rawOf, [view, arg]);
  return view;
}

/** An output: a promise the engine returned settled. It belongs to the step the returning chain is in when it settles. */
function settledOutput(chain, step, outcome, value) {
  const at = stepOf(chain);
  if (isLate(chain)) return;
  place(at, chain.case, { kind: 'settled', step: step.n, outcome, value: ref(value, chain.case) });
}

/** A port answer settled: a step of the calling chain's family (in the chain's case), and the chain moves to it. */
/**
 * How many microtask generations after its call an answer may settle and still be an immediate answer (package C0f).
 * The count runs one generation past it, so an answer at the cap is told from one past it: an answer that settles in
 * its call's drain later than that is flagged `immediate-expired` (C0f fix round), never recorded at the cap.
 */
export const IMMEDIATE_GENERATIONS = 64;
function settleStep(chain, name, call, outcome, value, probe = null) {
  markForeign(value);
  // An answer a late timer settled (its release window is running) is no step: the chain that waits on it is late.
  if (isLate(chain)) return;
  // In the drain of its call, within the count: an immediate answer, with the generation its port's promise settled at.
  const immediate = probe && probe.drain === drain && probe.raw !== null ? probe.raw : null;
  // In that drain but past the count (C0f fix round): at which generation is not known, and delivered once the step
  // before has run out it could come after work it preceded. Refused, never written as an answer at the cap.
  if (probe && probe.expired) guard('port', () => familyRecord(chain.family, chain.case).flags.add('immediate-expired'));
  const step = openStep(chain.family, { kind: 'settle', port: name, call, outcome, value: ref(value, chain.case), ...(immediate !== null ? { immediate } : {}) }, null, chain.case);
  if (step) chain.step = step;
}

const portFunctions = new RealWeakMap(); // target -> Map(name -> wrapper)
/**
 * A port function: calls are effects, a sync answer is part of the effect,
 * a promise answer opens a step when it settles, and functions the engine
 * passes are wrapped as callbacks. `thisArg` binds a method to its owner.
 * `families` limits whose port it is: other families inline it. `mocked`:
 * an export of a module the test mocked (the mock-module layer), whose calls
 * with no engine chain record nothing (see there).
 */
function portFunction(name, target, { thisArg, wrapAnswers = false, families = null, mocked = false, plainAnswers = false, realTransport = false } = {}) {
  let byName = apply(WeakMapGet, portFunctions, [target]);
  if (!byName) { byName = new RealMap(); apply(WeakMapSet, portFunctions, [target, byName]); }
  const cacheKey = thisArg === undefined ? name : null;
  if (cacheKey && apply(MapHas, byName, [cacheKey])) return apply(MapGet, byName, [cacheKey]);
  const call = (fnTarget, receiver, args, newTarget) => {
    const store = storeNow();
    const origin = originOf(store);
    const isNew = newTarget !== undefined;
    const invoke = (finalArgs) => (isNew ? construct(fnTarget, finalArgs) : apply(fnTarget, thisArg === undefined ? receiver : thisArg, finalArgs));
    if (origin === 'port' || origin === 'harness' || isLate(store)) return invoke(args);
    if (origin === 'engine' && families && !apply(SetHas, families, [store.family])) return invoke(args); // inlined for this family
    const engine = origin === 'engine';
    // A mocked module's export called with no engine chain (the test, or a component it renders, calling its own
    // stub) is no effect of any step: it records nothing and takes no copy of its arguments or answer, which on a
    // mounted test is every render's props and store state. Engine code found running there still flags its case.
    if (!engine && mocked) { checkOutside(); return invoke(args); }
    if (!engine && families) flagOutside(families, name);
    // The platform's own WebSocket, EventSource or fetch (no test fake): what it answers comes from the network stack at
    // real times (a refused connection's error and close, a response), which no rule of the recorder orders (C0f).
    if (engine && realTransport) guard('port', () => familyRecord(store.family, store.case).flags.add('real-transport'));
    // Engine calls are numbered 1, 2, ... per family; the test's own t1, t2, ... so they never shift the engine's.
    const effect = guard('port', () => ({ kind: isNew ? 'new' : 'port', port: name, call: engine ? (familyRecord(store.family, store.case).portCalls += 1) : `t${(caseOf(store).testCalls += 1)}`, args: ref(listOf(args)) }), null);
    if (effect) guard('port', () => record(effect, store));
    const finalArgs = engine ? args.map((arg, index) => (typeof arg === 'function' ? callbackFor(store.family, `${name}:${index}`, arg, store) : callbacksIn(store, `${name}:${index}`, arg))) : args;
    let result;
    try {
      result = inPort(engine ? store : null, () => invoke(finalArgs), effect);
    } catch (error) {
      if (effect) guard('port', () => { effect.throws = ref(error); });
      throw error;
    }
    if (!effect) return result;
    // The test's own call: its answer is context. One with behaviour (a storage) is written as the port it would be
    // to the engine (its name), not walked as data; the test still gets the value itself.
    // What the test's own call answered is not kept (package C0f): it is context, never replayed or compared, and an
    // API client's answer to the test can hold where the test runs (its isolated home), which differs every run.
    if (!engine) return result;
    guard('port', () => markForeign(result));
    const family = store.family;
    if (isPromise(result)) {
      guard('port', () => { effect.answer = ref(result); });
      // A port that wraps its answers hands the engine the port object, not the value: the settle input is that port
      // object (package C0f), whose reads and calls are then effects, never data the engine was not given. The step
      // opens when the promise the engine holds settles (the wrapped one, a microtask after the port's own), so the
      // engine's continuation is the next job after it, as for any other port: opened on the port's own promise, two
      // answers settling in one turn would open both steps before the first continuation ran, and misplace it.
      // Immediate answers (package C0f): the microtask generation, counted from the call by a chain of no-op marker
      // jobs, at which the port's own promise settled (as its first reaction sees it: 0 for a promise that had settled
      // when the call returned, as a fake's async function's has). An answer that settles in the drain it was asked in
      // is then given by a replay at that generation, through the same promises (the port's own, then the wrapped one).
      // The marker chain runs one generation past the cap, so a port promise its first reaction sees settled at the cap
      // is told from one that settled later in the same drain (`expired`, C0f fix round); one settled in a later drain is neither.
      const probe = { generations: 0, raw: null, expired: false, drain };
      const sawRaw = () => {
        if (probe.raw !== null || probe.expired || probe.drain !== drain) return;
        if (probe.generations <= IMMEDIATE_GENERATIONS) probe.raw = probe.generations; else probe.expired = true;
      };
      apply(PromiseThen, result, [sawRaw, sawRaw]);
      const held = wrapAnswers ? apply(PromiseThen, result, [(value) => (answerLike(value) ? portObject(`${name}#${effect.call}`, value, { wrapAnswers }) : value)]) : result;
      const tick = () => { if (probe.raw !== null || probe.expired) return; probe.generations += 1; if (probe.generations <= IMMEDIATE_GENERATIONS) enqueue(tick); };
      enqueue(tick);
      guard('port', () => observeSettle(held, (outcome, value) => settleStep(store, name, effect.call, outcome, value, probe)));
      return held;
    }
    // A function a port answers (an unsubscribe, an unregister) is a port of its own, `<port>#<call>`: calling it is an
    // effect with an answer, never port code run as if it were the engine's (package C0f). Engine code handed back (a
    // recorder wrapper) stays what it is.
    if (!plainAnswers && typeof result === 'function' && !apply(WeakMapHas, rawOf, [result]) && !apply(WeakMapHas, portNames, [result])) {
      const answered = portFunction(`${name}#${effect.call}`, result, { families, wrapAnswers, mocked });
      guard('port', () => { effect.answer = ref(answered); });
      return answered;
    }
    // An answer the engine gets as a port object is recorded as that port (its name): the engine never sees its
    // contents as data, it reads and calls them through the port, and those reads and calls are effects (package C0e).
    // A port whose answer is data by its nature (a store updater's next state, which carries the store's actions) never answers a port object.
    if (!plainAnswers && (isNew || portLike(result) || (wrapAnswers && answerLike(result)))) {
      const answered = portObject(`${name}#${effect.call}`, result, { wrapAnswers });
      guard('port', () => { effect.answer = ref(answered); });
      return answered;
    }
    guard('port', () => { effect.answer = ref(result); });
    return result;
  };
  const handler = {
    apply(fnTarget, receiver, args) { return call(fnTarget, receiver, args, undefined); },
    construct(fnTarget, args, newTarget) {
      if (newTarget !== wrapper) return construct(fnTarget, args, newTarget);
      return call(fnTarget, undefined, args, newTarget);
    },
    get(fnTarget, key) {
      const value = reflectGet(fnTarget, key);
      if (typeof value === 'function' && key !== 'prototype' && key !== 'constructor' && substitutable(fnTarget, key)) return portFunction(`${name}.${String(key)}`, value, { thisArg: fnTarget, families, wrapAnswers, mocked });
      return value;
    },
  };
  const wrapper = new RealProxy(target, handler);
  apply(WeakMapSet, portNames, [wrapper, name]);
  apply(WeakMapSet, rawOf, [wrapper, target]);
  if (cacheKey) apply(MapSet, byName, [cacheKey, wrapper]);
  return wrapper;
}

// Reads the runtime makes on its own (an await's thenable check, iteration and conversion protocols) are not inputs.
const IMPLICIT_READS = new RealSet(['then']);
const portObjects = new RealWeakMap(); // target -> proxy
/**
 * An answer worth wrapping when a port wraps its answers (`wrapAnswers`): one with behaviour, or a plain
 * object or array one of whose own members has behaviour (`{ items: <async iterator> }`).
 */
function answerLike(value) {
  if (portLike(value)) return true;
  if (value === null || typeof value !== 'object' || apply(WeakMapHas, portNames, [value]) || isPromise(value)) return false;
  for (const key of ownKeys(value)) {
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (descriptor && hasOwn(descriptor, 'value') && (typeof descriptor.value === 'function' || portLike(descriptor.value))) return true;
  }
  return false;
}

/** An object with behaviour handed to or answered to the engine: method calls are effects, data reads are inputs. */
function portObject(name, target, { families = null, wrapAnswers = false, mocked = false } = {}) {
  if (apply(WeakMapHas, portObjects, [target])) return apply(WeakMapGet, portObjects, [target]);
  const methods = new RealMap();
  const proxy = new RealProxy(target, {
    get(object, key) {
      const value = reflectGet(object, key);
      if (!substitutable(object, key)) return value;
      if (typeof value === 'function') {
        let byValue = apply(MapGet, methods, [key]);
        if (!byValue || byValue.value !== value) { byValue = { value, wrapper: portFunction(`${name}.${String(key)}`, value, { thisArg: object, families, wrapAnswers, mocked }) }; apply(MapSet, methods, [key, byValue]); }
        return byValue.wrapper;
      }
      const answer = typeof key === 'string' && (portLike(value) || (wrapAnswers && answerLike(value))) ? portObject(`${name}.${key}`, value, { families, wrapAnswers, mocked }) : value;
      if (typeof key === 'string' && !apply(SetHas, IMPLICIT_READS, [key])) {
        const store = storeNow();
        const origin = originOf(store);
        if (origin === 'engine' && (!families || apply(SetHas, families, [store.family]))) guard('port.read', () => record({ kind: 'read', port: name, key: ref(key), value: ref(answer) }, store));
        else if (origin === 'test' || origin === 'passthrough') { if (families) flagOutside(families, name); else checkOutside(); }
      }
      return answer;
    },
    set(object, key, value) {
      const store = storeNow();
      let stored = value;
      if (originOf(store) === 'test' || originOf(store) === 'passthrough') { if (families) flagOutside(families, name); else checkOutside(); }
      if (originOf(store) === 'engine' && (!families || apply(SetHas, families, [store.family]))) {
        guard('port.set', () => record({ kind: 'set', port: name, key: ref(key), value: ref(value) }, store));
        if (typeof value === 'function') stored = callbackFor(store.family, `${name}.${String(key)}`, value, store);
      }
      return reflectSet(object, key, stored);
    },
  });
  apply(WeakMapSet, portObjects, [target, proxy]);
  apply(WeakMapSet, portNames, [proxy, name]);
  apply(WeakMapSet, rawOf, [proxy, target]);
  return proxy;
}

// ------------------------------------------------------------- entry points

/**
 * Calls one entry point: opens a step, runs the engine in a chain of that
 * step, records the result, the arguments after, the change set. A call from
 * the engine of another family that lists this export as a port is that
 * family's port call and this family's input (`crossing`).
 */
function callEntry(family, spec, label, target, thisArg, args, newTarget, crossing) {
  const store = storeNow();
  const origin = originOf(store);
  const invoke = (finalArgs) => (newTarget !== undefined ? construct(target, finalArgs, newTarget) : apply(target, thisArg, finalArgs));
  if (origin === 'harness') return invoke(args);
  // Late code (a timer that fired after its case's test ended, and what it released) calls an entry: no step.
  if (isLate(store)) return runLate(family, store.case, () => invoke(args));
  // With no engine chain running, the caller frame decides, inside a pass-through call too: test code's call
  // is recorded; any other caller's (engine code no family maps) is passed through and counted, never a step.
  // Engine code an entry handed the test (spec.handedOut) is the test's when no frame shows a caller: the
  // runtime itself runs it (an `await` calling a thenable's then), and only the test was handed it.
  if (origin === 'test' || origin === 'passthrough') {
    const caller = guard('caller', () => callerOf(), null);
    if (caller === null ? spec.handedOut !== true : !caller.test) return passThrough(family, label, caller, origin === 'passthrough', () => invoke(args));
  }
  let portEffect = null;
  if (origin === 'engine') {
    if (store.family === family || !crossing || !apply(SetHas, crossing.families, [store.family])) {
      // Inlined: another family's chain that runs a stateful family's entry and changes its state moves it outside its steps.
      if (store.family === family || !isStateful(family)) return invoke(args);
      const watched = stateText(family);
      const moved = () => { if (stateText(family) !== watched) noteMoved(family, store); };
      let result;
      try { result = invoke(args); } finally { moved(); }
      if (isPromise(result)) guard('state', () => observeSettle(result, moved));
      return result;
    }
    portEffect = guard('entry', () => ({ kind: 'port', port: crossing.name, call: (familyRecord(store.family, store.case).portCalls += 1), args: ref(listOf(args)) }), null);
    if (portEffect) guard('entry', () => record(portEffect, store));
  }
  // A call from a chain of an earlier case (a late crossing) is that case's input.
  // A call from test code of an earlier case (a job or a timer its test started) is that case's input too, late.
  const kase = caseOf(portEffect || origin === 'test' ? store : null);
  // What the test hands in is the test's, never engine code to hand back out wrapped.
  if (!portEffect) guard('entry', () => { for (const arg of args) markForeign(arg); });
  // A function the test hands in that no injected port wraps (an argument, or a member of one) is opaque: what it
  // answers the engine, and any family call it makes inside the chain, would be lost silently. The family's line
  // is flagged `test-function` (unrecordable, listed by test) until the map declares it as a port.
  if (!portEffect && guard('entry', () => opaqueTestFunction(spec, args), false)) familyRecord(family, kase).flags.add('test-function');
  const input = { kind: spec.input ?? (newTarget !== undefined ? 'new' : 'call'), entry: label, args: ref(listOf(args), kase) };
  if (portEffect) input.caller = store.family;
  const step = guard('entry', () => openStep(family, input, portEffect ? null : store, kase), null);
  if (step) guard('entry', () => watchSignals(family, kase, args));
  if (!step) return invoke(args);
  const draft = spec.draft;
  const before = draft !== undefined ? guard('entry', () => identityPaths(args[draft]), null) : null;
  const beforeState = stateBefore(family);
  // A store state the recorder's getState handed the test (a view) is the state itself to the engine: zustand's
  // own `Object.is(next, state)` must see the very object (setState(getState()) notifies nothing).
  for (let index = 0; index < args.length; index += 1) if (args[index] !== null && typeof args[index] === 'object' && apply(WeakSetHas, viewedStates, [args[index]])) args[index] = apply(WeakMapGet, rawOf, [args[index]]);
  const finalArgs = guard('entry', () => injectPorts(family, spec.injected?.some((item) => item.perStep) ? { ...spec, injected: spec.injected.map((item) => (item.perStep ? { ...item, name: `${item.name}@${step.n}` } : item)) } : spec, args), args);
  const chain = engineStore(family, step, kase);
  const finish = (fields) => guard('entry', () => {
    // Which of the step's effects came before the entry returned or threw (the rest follow in the jobs it started).
    step.returnedAt = step.effects.length;
    Object.assign(step, fields);
    step.after = ref(listOf(args), kase);
    if (before) step.changes = ref(changedPaths(before, args[draft]), kase);
    stateAfter(family, step, beforeState, kase);
    nestEnded(step);
  });
  let result;
  try {
    result = als.run(chain, () => invoke(finalArgs));
  } catch (error) {
    finish({ throws: ref(error, kase) });
    if (portEffect) guard('entry', () => { portEffect.throws = ref(error); });
    throw error;
  }
  finish({ returns: ref(result, kase) });
  if (portEffect) guard('entry', () => { portEffect.answer = ref(result); });
  if (isPromise(result)) {
    guard('entry', () => observeSettle(result, (outcome, value) => settledOutput(chain, step, outcome, value)));
    if (portEffect) guard('entry', () => observeSettle(result, (outcome, value) => settleStep(store, crossing.name, portEffect.call, outcome, value)));
  }
  const whole = spec.returns === 'entry-object';
  // Another family's engine gets what it asked for: what one engine family hands another is inlined.
  if (portEffect) return whole && result !== null && typeof result === 'object' && !isPromise(result) ? handOut(family, label, result, kase, true) : result;
  // An async entry-object factory: its resolved value is handed out, through a derived promise (one microtask later).
  if (whole && isPromise(result)) return apply(PromiseThen, result, [(value) => handOut(family, label, value, kase, true)]);
  // What the test is handed as engine code is named `<label>#<n>` from here on: the step says which n (a later step
  // calls `<label>#<n>…`), so a replay binds the name to the value its own step returned.
  const counted = familyRecord(family, kase).objects;
  const out = handOut(family, label, result, kase, whole);
  const numbered = familyRecord(family, kase).objects;
  if (numbered !== counted) guard('entry', () => { step.handedOut = numbered; });
  return out;
}

// Who called an entry with no engine chain running: test code (the test file, or a file the naming rule
// calls test code: port-map.mjs isTestPath, a hard rule in docs/TESTING.md; a toy test `*.toy.mjs`), or
// engine code that no family of the map owns yet (a product module, a library). Only the test's calls are
// a family's cases: what an unmapped engine module does with an entry is that module's behaviour, recorded
// with its own family once it is mapped (where the entry is inlined), so here it is passed through and
// counted (passThrough). The caller is the first frame outside the recorder; a frame that a proper tail
// call removed shows the caller's caller, so a product function that tail-calls an entry for the test
// counts as the test's call (a genuine call either way).
const MAIN_FILE = (() => { try { return realpathSync(Bun.main); } catch { return Bun.main; } })();
const testFiles = new RealMap(); // file -> whether it is test code
function isTestCode(file) {
  let known = apply(MapGet, testFiles, [file]);
  if (known === undefined) {
    const at = relative(file);
    known = file === Bun.main || file === MAIN_FILE || (at !== '<outside>' && isTestPath(at)) || (file.startsWith(TOY_DIR) && file.endsWith('.toy.mjs'));
    apply(MapSet, testFiles, [file, known]);
  }
  return known;
}
// Enough frames to get past the recorder's own (its traps, promise windows and guards) to the caller.
const CALLER_FRAMES = 40;
/** The caller of a trap: `{ file, test }` for the first frame outside the recorder, or null when no frame has a file. */
function callerOf() {
  if (!FAMILY_FILES) return { file: null, test: true };
  const [first] = frames(CALLER_FRAMES);
  return first ? { file: first[0], test: isTestCode(first[0]) } : null;
}

// What is passed through, counted (written in the raw; the family command prints it and judges it):
// - `unmapped`: family -> export -> calls;
// - `callers`: caller file (repository-relative, `<outside>` beyond the root, `<no frame>`) -> `family#export` -> calls;
// - `portCallers`: caller file -> port -> uses (a family's port used by engine code no family maps, or inside a pass-through call);
// - `noFrame`: `family#export` -> calls that had no frame with a file at all;
// - `passed`: the totals (`calls`, `nested`: made inside a pass-through call, `noFrame`, `ports`, `portsNested`).
const unmapped = {};
const callers = {};
const portCallers = {};
const noFrame = {};
const passed = { calls: 0, nested: 0, noFrame: 0, ports: 0, portsNested: 0 };
const callerName = (file) => (file === null ? '<no frame>' : relative(file));
const bump = (table, key, inner) => { const row = (table[key] ??= {}); row[inner] = (row[inner] ?? 0) + 1; };
/**
 * Passes an entry call through: counted, never a step. Outside a pass-through call it runs in a
 * pass-through store, so what it does in turn (another family's entry, a debug flag read, a port) is
 * that module's, never a flag; the store holds for the call's synchronous extent only (storeNow). A call
 * with no frame at all (a bound entry a job runs, an engine continuation whose only frame a tail call
 * removed) may be the test's: unless the census names it as one engine code calls so (NO_FRAME_ALLOWED,
 * with the engine site), its family's line in the current case is flagged `no-frame`.
 */
function passThrough(family, label, caller, nested, run) {
  guard('unmapped', () => {
    const name = String(label);
    const key = `${family}#${baseExport(name)}`;
    bump(unmapped, family, name);
    bump(callers, callerName(caller?.file ?? null), key);
    passed.calls += 1;
    if (nested) passed.nested += 1;
    if (caller === null) {
      passed.noFrame += 1;
      noFrame[key] = (noFrame[key] ?? 0) + 1;
      if (!apply(SetHas, NO_FRAME_ALLOWED, [key])) flagFamily(family, 'no-frame');
    }
  });
  // A passed-through call of engine code a family handed the test (its objects' state, which the family does not
  // record) may change those objects: flagged `handed-out-touched`. One of a stateful family's own entry moves
  // its state only when it changes it: its content is compared across the call's synchronous part, and, for an
  // answer that is a promise, again when it settles (a continuation the call started); a read moves nothing.
  const handed = String(label).includes('#');
  if (handed) noteTouched(family, null);
  const kase = current;
  const watched = !handed && isStateful(family) ? stateText(family) : null;
  const moved = () => { if (stateText(family) !== watched) noteMoved(family, { kind: 'passthrough', case: kase }); };
  const watch = (result) => {
    if (watched === null) return result;
    moved();
    if (isPromise(result)) guard('state', () => observeSettle(result, moved));
    return result;
  };
  const store = nested ? null : { kind: 'passthrough', case: current, active: true };
  let result;
  try {
    result = store ? als.run(store, run) : run();
  } catch (error) {
    if (store) store.active = false;
    if (watched !== null) moved();
    throw error;
  }
  if (store) store.active = false;
  return watch(result);
}
/** A family's port passed through (flagOutside): counted by its caller. */
function notePassedPort(port, file, nested) {
  guard('unmapped', () => {
    passed.ports += 1;
    if (nested) passed.portsNested += 1;
    bump(portCallers, callerName(file), String(port));
  });
}
const baseExport = (label) => String(label).split('#')[0].split('.')[0];

// Engine code handed back in (a handed-out wrapper, a port) and platform functions are no test function.
const opaqueFunction = (value) => typeof value === 'function' && !apply(WeakMapHas, rawOf, [value]) && !apply(WeakMapHas, portNames, [value]) && !isNative(value);
/**
 * Whether the test's arguments hold a function, at the top or as an own data
 * member of one other than the draft, that `spec.injected` does not declare a port.
 */
function opaqueTestFunction(spec, args) {
  const injected = spec.injected ?? [];
  const declared = (index, key) => injected.some((item) => item.arg === index && item.key === key);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (declared(index, undefined)) continue;
    if (opaqueFunction(arg)) return true;
    // The draft is state: a store's own actions in it are the store's, no callback the test hands in.
    if (index === spec.draft || arg === null || typeof arg !== 'object' || isPromise(arg) || apply(WeakMapHas, rawOf, [arg]) || apply(WeakMapHas, portNames, [arg]) || (ArrayIsArray(arg) && arg.length > 64)) continue;
    for (const key of ownKeys(arg)) {
      if (declared(index, key)) continue;
      const descriptor = getOwnPropertyDescriptor(arg, key);
      if (descriptor && hasOwn(descriptor, 'value') && opaqueFunction(descriptor.value)) return true;
    }
  }
  return false;
}

const injectedHolders = new RealWeakSet(); // an argument wrapper injectPorts made around a port at one of its keys
function injectPorts(family, spec, args) {
  const injected = spec.injected;
  if (!injected?.length) return args;
  const out = [...args];
  for (const item of injected) {
    const arg = out[item.arg];
    if (arg === null || (typeof arg !== 'object' && typeof arg !== 'function')) continue;
    if (item.onlyFunction && item.key === undefined && typeof arg !== 'function') continue;
    const options = { wrapAnswers: item.wrapAnswers === true, plainAnswers: item.plainAnswers === true };
    if (item.key === undefined) { out[item.arg] = typeof arg === 'function' ? portFunction(item.name, arg, options) : portObject(item.name, arg, options); continue; }
    const inner = guard('inject', () => { const descriptor = getOwnPropertyDescriptor(arg, item.key); return descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined; });
    if (inner === null || (typeof inner !== 'object' && typeof inner !== 'function')) continue;
    const wrappedInner = typeof inner === 'function' ? portFunction(item.name, inner, options) : portObject(item.name, inner, options);
    const proxy = new RealProxy(arg, { get: (object, key) => (key === item.key && substitutable(object, key) ? wrappedInner : reflectGet(object, key)) });
    // Two ports injected at keys of one argument wrap it twice: the outer wrapper is the test's object too, identity
    // included (C0f fix round), as the replay engine's codec writes it, never a copy of the inner wrapper.
    apply(WeakMapSet, rawOf, [proxy, apply(WeakSetHas, injectedHolders, [arg]) ? apply(WeakMapGet, rawOf, [arg]) : arg]);
    apply(WeakSetAdd, injectedHolders, [proxy]);
    out[item.arg] = proxy;
  }
  return out;
}

function wrapEntry(family, spec, label, target, crossing) {
  if (typeof target !== 'function') return target;
  const wrapper = new RealProxy(target, {
    apply(fn, thisArg, args) { return callEntry(family, spec, label, fn, thisArg, args, undefined, crossing); },
    construct(fn, args, newTarget) {
      if (newTarget !== wrapper) return construct(fn, args, newTarget);
      return callEntry(family, spec, label, fn, undefined, args, fn, crossing);
    },
  });
  apply(WeakMapSet, rawOf, [wrapper, target]);
  return wrapper;
}

// ------------------------------------------------------- handed-out engine code
//
// What an entry gives the test may hold engine code the test runs later: a
// closure (an unsubscribe), an object whose methods or getters it calls, an
// iterator it loops over (`for await`), a thenable it awaits. Each is handed
// out wrapped, so running it is an input of the family that produced it: a
// call of `<entry>#<n>` (a function), of `<entry>#<n>.<member>` (a method or
// an array's function element), or a `get` of `<entry>#<n>.<getter>`, each in
// a step of its own; what they give back is handed out the same way, and so
// are members that hold engine code. One wrapper per object, so a test that
// compares references sees the same one. A member a Proxy may not replace (a
// non-configurable, non-writable property, as on a frozen object) cannot be
// wrapped: reading one that holds engine code from test code flags the case
// `unwrappable`. Platform methods inherited by an engine object are called on
// the object itself, so brand checks hold. What came from the test (its
// arguments, a port's answers) is never handed out as engine code.
const handedOut = new RealWeakMap(); // target -> its wrapper
const HANDED_OUT = Object.freeze({ handedOut: true });
const HANDED_OUT_GET = Object.freeze({ input: 'get', handedOut: true });
const foreign = new RealWeakMap(); // value the test or a port supplied -> true
const FunctionToString = Function.prototype.toString;
const NATIVE_SOURCE = /\{\s*\[native code\]\s*\}\s*$/;
const isNative = (fn) => { try { return NATIVE_SOURCE.test(apply(FunctionToString, fn, [])); } catch { return true; } };
const GeneratorPrototype = getPrototypeOf(getPrototypeOf((function* generator() {})()));
const AsyncGeneratorPrototype = getPrototypeOf(getPrototypeOf((async function* generator() {})()));
// A generator's next, return and throw are native, but they run the generator's body: engine code.
const GENERATOR_HOLDERS = new RealSet([GeneratorPrototype, AsyncGeneratorPrototype]);
// Native methods that work on any receiver (a Proxy included): returned as they are.
const GENERIC_HOLDERS = new RealSet([ObjectPrototype, Array.prototype, Function.prototype, getPrototypeOf(GeneratorPrototype), getPrototypeOf(AsyncGeneratorPrototype)]);

/** Marks a value (and its own data members) as the test's or a port's. */
function markForeign(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  apply(WeakMapSet, foreign, [value, true]);
  if (typeof value !== 'object' || ArrayIsArray(value) && value.length > 64) return;
  for (const key of ownKeys(value)) {
    const descriptor = getOwnPropertyDescriptor(value, key);
    const member = descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    if (member !== null && (typeof member === 'object' || typeof member === 'function')) apply(WeakMapSet, foreign, [member, true]);
  }
}

/** Whether a value holds engine code a test could run: a function, or an object with engine methods, getters or such members. */
function carriesCode(value, depth = 1) {
  if (typeof value === 'function') return true;
  if (value === null || typeof value !== 'object' || isPromise(value)) return false;
  if (apply(WeakMapHas, portNames, [value]) || apply(WeakMapHas, rawOf, [value]) || apply(WeakMapHas, foreign, [value])) return false;
  for (const prototype of DATA_CLASSES) if (apply(isPrototypeOf, prototype, [value])) return false;
  for (const key of ownKeys(value)) {
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!hasOwn(descriptor, 'value')) { if (typeof descriptor.get === 'function' && !isNative(descriptor.get)) return true; continue; }
    const member = descriptor.value;
    if (typeof member === 'function') { if (!apply(WeakMapHas, foreign, [member])) return true; continue; }
    if (depth > 0 && member !== null && typeof member === 'object' && carriesCode(member, depth - 1)) return true;
  }
  for (let prototype = getPrototypeOf(value); prototype !== null; prototype = getPrototypeOf(prototype)) {
    if (apply(SetHas, GENERATOR_HOLDERS, [prototype])) return true;
    if (apply(SetHas, GENERIC_HOLDERS, [prototype])) continue;
    for (const key of ownKeys(prototype)) {
      if (key === 'constructor') continue;
      const descriptor = getOwnPropertyDescriptor(prototype, key);
      const code = descriptor && (hasOwn(descriptor, 'value') ? descriptor.value : descriptor.get);
      if (typeof code === 'function' && !isNative(code)) return true;
    }
  }
  return false;
}

/** What an entry gives back to the test: wrapped when it holds engine code (`whole`: an entry-object, wrapped even as plain data). */
function handOut(family, label, value, owner, whole = false) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const known = apply(WeakMapGet, handedOut, [value]);
  if (known) return known;
  if (apply(WeakMapHas, rawOf, [value]) || apply(WeakMapHas, portNames, [value]) || apply(WeakMapHas, foreign, [value])) return value;
  if (typeof value === 'object' && (isPromise(value) || !(whole || carriesCode(value)))) return value;
  return guard('hand-out', () => engineWrapper(family, `${label}#${(familyRecord(family, owner).objects += 1)}`, value, owner, null), value);
}

/**
 * A wrapper of engine code handed to the test. `parent` (`{ proxy, object }`)
 * makes it a method: called on the parent's wrapper, it runs on the object.
 */
/** Stores (getState, setState, subscribe) a family handed the test, with the recorder's listener on them. */
const watchedStores = new RealWeakMap();
/**
 * A store a family hands the test (ChildStoreManager's directory stores): the recorder listens to it, so a
 * change that no step of the family makes (engine code no family maps writing to it through its own reference)
 * marks the family's state moved in that case (`state-moved`), as for a stateful family's own store.
 */
function watchHandedStore(family, value, owner) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || apply(WeakMapHas, watchedStores, [value])) return;
  const fields = guard('hand-out', () => ['getState', 'setState', 'subscribe'].every((key) => { const descriptor = getOwnPropertyDescriptor(value, key); return descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'; }), false);
  if (!fields) return;
  apply(WeakMapSet, watchedStores, [value, true]);
  guard('hand-out', () => als.run({ kind: 'harness' }, () => value.subscribe(() => {
    const store = storeNow();
    if (store && store.kind === 'harness') return;
    // A late timer of the case that was handed the store writes it after that case's end: recorded nowhere.
    if (isLate(store)) { if (store.case === owner) return; }
    else if (store && store.kind === 'engine' && store.family === family) return;
    noteTouched(family, store);
  })));
}
function engineWrapper(family, name, target, owner, parent) {
  watchHandedStore(family, target, owner);
  const members = new RealMap(); // key -> { value, wrapper }
  let proxy = null;
  const handler = { get: (object, key) => memberOf(family, name, object, proxy, key, owner, members) };
  if (typeof target === 'function') {
    const spec = memberSpec(family, name, HANDED_OUT);
    handler.apply = (fn, thisArg, args) => callEntry(family, spec, name, fn, parent && thisArg === parent.proxy ? parent.object : thisArg, args, undefined, null);
    handler.construct = (fn, args, newTarget) => (newTarget === proxy ? callEntry(family, spec, name, fn, undefined, args, fn, null) : construct(fn, args, newTarget));
  }
  proxy = new RealProxy(target, handler);
  if (!parent) apply(WeakMapSet, handedOut, [target, proxy]);
  apply(WeakMapSet, rawOf, [proxy, target]);
  return proxy;
}

/** Injected ports of a method of handed-out engine code (`member` in the map), by family, entry and member name. */
const injectedByMember = new RealMap();
/** The spec of handed-out engine code named `label` (`<entry>#<n>.<member>…`): `base`, with the injected ports the map gives its last member. */
function memberSpec(family, label, base) {
  const parts = String(label).split('.');
  if (parts.length < 2) return base;
  const injected = apply(MapGet, injectedByMember, [`${family}:${parts[0].split('#')[0]}:${parts[parts.length - 1].split('#')[0]}`]);
  return injected ? { ...base, injected } : base;
}

/** A member read through a handed-out wrapper. */
function memberOf(family, name, object, proxy, key, owner, members) {
  let holder = object;
  let descriptor;
  while (holder !== null) {
    descriptor = reflectDescriptor(holder, key);
    if (descriptor) break;
    holder = getPrototypeOf(holder);
  }
  if (!descriptor) return reflectGet(object, key);
  const label = `${name}.${String(key)}`;
  if (!hasOwn(descriptor, 'value')) {
    // An engine getter read from outside the engine is an input; a platform getter reads the object itself.
    if (typeof descriptor.get !== 'function' || isNative(descriptor.get)) return reflectGet(object, key);
    return callEntry(family, HANDED_OUT_GET, label, descriptor.get, object, [], undefined, null);
  }
  const value = descriptor.value;
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || key === 'constructor' || (typeof object === 'function' && key === 'prototype')) return value;
  if (holder === object && !substitutable(object, key)) {
    // The family gets a line in the current case, so the flag is never on a case that is written for no family.
    if (originOf(storeNow()) === 'test' && guard('hand-out', () => carriesCode(value), false)) { current.flags.add('unwrappable'); familyRecord(family); }
    return value;
  }
  if (typeof value !== 'function') return handOut(family, label, value, owner);
  if (holder !== object && !apply(SetHas, GENERATOR_HOLDERS, [holder]) && isNative(value) && (apply(SetHas, GENERIC_HOLDERS, [holder]) || typeof object === 'function')) return value;
  if (apply(WeakMapHas, foreign, [value])) return value;
  let byKey = apply(MapGet, members, [key]);
  if (!byKey || byKey.value !== value) {
    let wrapper;
    if (holder !== object && !apply(SetHas, GENERATOR_HOLDERS, [holder]) && isNative(value)) {
      // A platform method an engine object inherits (EventTarget's): called on the object itself, no input of its own.
      wrapper = new RealProxy(value, { apply: (fn, thisArg, args) => apply(fn, thisArg === proxy ? object : thisArg, args) });
      apply(WeakMapSet, rawOf, [wrapper, value]);
    } else wrapper = engineWrapper(family, label, value, owner, { proxy, object });
    byKey = { value, wrapper };
    apply(MapSet, members, [key, byKey]);
  }
  return byKey.wrapper;
}


// ------------------------------------------------------- stateful families (C0e)
//
// A stateful family names a zustand store export (`store`) and/or module-level
// bindings no export exposes (`moduleState`). Its state, `{ store?: getState(),
// module?: { binding: value } }`, is recorded at case entry and end, after the
// synchronous part of every step (`state`) with that part's change set
// (`stateChanges`: every path below the root whose object identity changed),
// and every notification of its store is an effect (`notify`, with the state
// and the previous state the store handed its listeners). The bindings are read
// through a function the loader appends to the module's own source (the
// product file is never written); the store is read through its own getState.
// The test's calls of an action (`<store>.<action>`), of setState and of
// subscribe are steps; a function handed to setState is the port `updater`, a
// subscriber the port `subscriber` (its calls are what each subscriber saw, in
// order), and the unsubscribe handed back is engine code (`<store>.subscribe#n`).
// State that changes inside a case by code that is no step of the family (an
// unmapped module calling an entry, another family inlining one, a notification
// with none of its steps running) flags the case `state-moved`.
const moduleStates = new RealMap(); // module file -> () => { binding: value }
/** The state of a stateful family as it is now, read as harness code (nothing is recorded while it is read). */
function familyState(name) {
  return als.run({ kind: 'harness' }, () => {
    const family = apply(MapGet, FAMILY_BY_NAME, [name]);
    const namespace = apply(MapGet, loadedFamilies, [name]);
    const out = {};
    if (family.store) {
      const store = namespace ? namespace[family.store] : undefined;
      out.store = store !== null && store !== undefined && typeof store.getState === 'function' ? store.getState() : undefined;
    }
    if (family.moduleState) {
      const read = apply(MapGet, moduleStates, [family.module]);
      if (!read) throw new RealError(`the module state of ${name} was never registered: did its module load through the facade?`);
      out.module = read();
    }
    return out;
  });
}
/** The identity paths of a family's state below its root (the root is a fresh object at every read). */
// The root and its `module` member are fresh objects at every read: no identity of the family's.
const freshPath = (where) => where.length === 0 || (where.length === 1 && where[0] === 'module');
const statePaths = (name) => identityPaths(familyState(name)).filter(([where]) => !freshPath(where));
const stateChangesOf = (before, name, state) => changedPaths(before, state).filter((where) => !freshPath(where));
/** Before a step's synchronous part: what the family's state is, by identity (null for a family without state). */
const stateBefore = (family) => (isStateful(family) ? guard('state', () => statePaths(family), null) : null);
/** After it: the state and the change set, written into the step. */
function stateAfter(family, step, before, kase) {
  if (!isStateful(family)) return;
  guard('state', () => {
    const state = familyState(family);
    step.state = ref(state, kase);
    if (before) step.stateChanges = ref(stateChangesOf(before, family, state), kase);
  });
}
/**
 * Code that is no step of `family` changed its state in the case `store` runs for (see above). Late code (a
 * timer that fired after its case's test ended) moves it in the case running now, never in its own ended case.
 */
function noteMoved(family, store) {
  guard('state', () => {
    let kase = caseOf(store);
    if (isLate(store)) {
      kase = current;
      if (kase === store.case || kase.endNow !== null) return;
    }
    apply(SetAdd, kase.moved, [family]);
  });
}
/**
 * The content of a stateful family's state as text (codec, a throwaway identity scope): two texts differ
 * exactly when a value in the state differs, a Map's or a Set's order included. Read as harness code.
 */
function stateText(family) {
  return guard('state', () => encodeText(familyState(family), createCodecContext({ names: portNames, unwrap, unifyWrapped: true })), null);
}
/**
 * Runs `fn` as code of a late timer of ended case `kase` (see lateStore). Nothing it does is recorded; if it
 * changes the state of stateful `family` (the timer's own), that is a move in the case running now.
 */
function runLate(family, kase, fn) {
  const watched = family !== null && isStateful(family) ? stateText(family) : null;
  const store = lateStore(kase, family);
  try { return als.run(store, fn); } finally {
    if (watched !== null && stateText(family) !== watched) noteMoved(family, store);
  }
}
/**
 * Engine code no family maps called engine code `family` handed the test (`<entry>#<n>…`: an object's method or
 * getter, a closure), or wrote a store the family handed out, in the case `store` runs for. The family records no
 * state of those objects (they are its instances, not its store or module state), so whether the call changed
 * them is not known: the case is flagged `handed-out-touched`.
 */
function noteTouched(family, store) {
  guard('state', () => {
    let kase = caseOf(store);
    if (isLate(store)) {
      kase = current;
      if (kase === store.case || kase.endNow !== null) return;
    }
    apply(SetAdd, kase.touched, [family]);
  });
}
/** A notification of a stateful family's store, seen by the recorder's own listener (subscribed first, when the module loads). */
function noteNotify(family, state, previous) {
  guard('notify', () => {
    const store = storeNow();
    if (store && store.kind === 'engine' && store.family === family && !isLate(store)) { record({ kind: 'notify', state: ref(state, store.case), previous: ref(previous, store.case) }, store); return; }
    if (store && store.kind === 'harness') return;
    noteMoved(family, store);
  });
}
const stateViews = new RealWeakMap(); // a store state -> the view handed to the test
const viewedStates = new RealWeakSet(); // the views themselves
const actionWrappers = new RealWeakMap(); // an action -> its entry wrapper
/** Whether a plain object holds functions of its own (a store state's `actions` group). */
const holdsActions = (value) => value !== null && typeof value === 'object' && !ArrayIsArray(value) && getPrototypeOf(value) === ObjectPrototype
  && ownKeys(value).some((key) => typeof key === 'string' && typeof getOwnPropertyDescriptor(value, key)?.value === 'function');
/** What getState hands the test: the state itself, its actions wrapped as entries `<store>.<action>` (and `<store>.<group>.<action>`). */
function stateView(family, label, state) {
  if (state === null || typeof state !== 'object') return state;
  const known = apply(WeakMapGet, stateViews, [state]);
  if (known) return known;
  const view = new RealProxy(state, {
    get(object, key) {
      const value = reflectGet(object, key);
      // A group of actions in the state (`state.actions.set`) is a view too, its actions named below it.
      if (typeof key === 'string' && holdsActions(value) && substitutable(object, key)) return stateView(family, `${label}.${key}`, value);
      if (typeof value !== 'function' || typeof key !== 'string' || !substitutable(object, key)) return value;
      let wrapper = apply(WeakMapGet, actionWrappers, [value]);
      if (!wrapper) { wrapper = wrapEntry(family, { export: `${label}.${key}` }, `${label}.${key}`, value, null); apply(WeakMapSet, actionWrappers, [value, wrapper]); }
      return wrapper;
    },
  });
  apply(WeakMapSet, stateViews, [state, view]);
  apply(WeakMapSet, rawOf, [view, state]);
  apply(WeakSetAdd, viewedStates, [view]);
  return view;
}
/** The store export of a stateful family: called as a hook it is an entry; getState, setState and subscribe as above. */
function storeWrapper(family, spec, label, target, crossing) {
  if (target === null || (typeof target !== 'function' && typeof target !== 'object')) return target;
  const members = new RealMap();
  const member = (key, value, make) => {
    const known = apply(MapGet, members, [key]);
    if (known && known.value === value) return known.wrapper;
    const wrapper = make();
    apply(MapSet, members, [key, { value, wrapper }]);
    return wrapper;
  };
  const handler = {
    get(object, key) {
      const value = reflectGet(object, key);
      if (typeof value !== 'function' || !substitutable(object, key)) return value;
      if (key === 'getState') {
        return member(key, value, () => {
          const getter = { getState(...args) { return stateView(family, label, apply(value, this === proxy ? object : this, args)); } }.getState;
          apply(WeakMapSet, rawOf, [getter, value]);
          return getter;
        });
      }
      if (key === 'setState') return member(key, value, () => wrapEntry(family, { export: `${label}.setState`, injected: [{ arg: 0, name: 'updater', onlyFunction: true, plainAnswers: true }] }, `${label}.setState`, value, null));
      // Each subscriber is a port of its own, named by the step that subscribed it (`subscriber@<n>`): the order the store
      // calls its subscribers in is then in the effects.
      if (key === 'subscribe') return member(key, value, () => wrapEntry(family, { export: `${label}.subscribe`, injected: [{ arg: 0, name: 'subscriber', onlyFunction: true, perStep: true }, { arg: 1, name: 'subscriber.listener', onlyFunction: true, perStep: true }] }, `${label}.subscribe`, value, null));
      return value;
    },
  };
  if (typeof target === 'function') handler.apply = (fn, thisArg, args) => callEntry(family, spec, label, fn, thisArg, args, undefined, crossing);
  const proxy = new RealProxy(target, handler);
  apply(WeakMapSet, rawOf, [proxy, target]);
  return proxy;
}
/** The stateful family whose store export `name` of a mapped module is, or null. */
const storeOf = (target, name) => (target?.families ?? []).find((family) => apply(MapGet, FAMILY_BY_NAME, [family])?.store === name) ?? null;
/** The actions of every store a mapped module made (`<store>.<action>`, read from its state when it loaded), for the census. */
const storeActions = new RealMap(); // module file -> { '<store>.<action>': 'function' }
/** Subscribes the recorder's own listener to the store of every stateful family of a module that just loaded. */
function listenToStores(file, namespace) {
  for (const name of portMap.modules.get(file)?.families ?? []) {
    const family = apply(MapGet, FAMILY_BY_NAME, [name]);
    if (!family?.store) continue;
    guard('notify', () => {
      const store = namespace[family.store];
      if (store === null || store === undefined || typeof store.subscribe !== 'function') throw new RealError(`the store ${family.store} of ${name} has no subscribe`);
      als.run({ kind: 'harness' }, () => {
        store.subscribe((state, previous) => noteNotify(name, state, previous));
        const state = store.getState();
        const actions = {};
        const collect = (object, prefix, depth) => {
          for (const key of ownKeys(object).filter((item) => typeof item === 'string').sort()) {
            const value = getOwnPropertyDescriptor(object, key)?.value;
            if (typeof value === 'function') actions[`${prefix}.${key}`] = 'function';
            else if (depth > 0 && holdsActions(value)) collect(value, `${prefix}.${key}`, depth - 1);
          }
        };
        if (state !== null && typeof state === 'object') collect(state, family.store, 1);
        apply(MapSet, storeActions, [file, actions]);
      });
    });
  }
}
/** The source a module's real load gets appended, registering a reader of its module-state bindings (the file is never written). */
function moduleStateSource(file) {
  const bindings = [];
  for (const name of portMap.modules.get(file)?.families ?? []) for (const binding of apply(MapGet, FAMILY_BY_NAME, [name])?.moduleState?.bindings ?? []) if (!bindings.includes(binding)) bindings.push(binding);
  if (bindings.length === 0) return '';
  return `\n;globalThis[Symbol.for(${JSON.stringify(API.description)})].moduleState(${JSON.stringify(file)}, () => ({ ${bindings.map((binding) => `${JSON.stringify(binding)}: ${binding}`).join(', ')} }));\n`;
}

// ------------------------------------------------------- facades for the map

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const loaderFor = (file) => (file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts') ? 'ts' : file.endsWith('.jsx') ? 'jsx' : 'js');
// Discovery (the `discover` layer alone): which family modules this test file loads, and how often test code
// (by the caller rule) calls their function exports, or anything calls one with no frame. Nothing else is
// wrapped or recorded. The report is written as soon as the file starts and again whenever it changes, so a
// file that stops part-way still reports what it did.
if (DISCOVER && PORT_MAP_FILE && OUT) {
  const families = loadPortMap(PORT_MAP_FILE, { root: ROOT }).families;
  // `callers`: every other caller file -> `module#export` -> calls, so the family command can apply the
  // unclassified-caller rule to a file whose test code reaches a family only through such a caller.
  const report = { file: TEST_FILE, loaded: [], testCalls: 0, noFrame: 0, callers: {} };
  let pending = false;
  const write = () => guard('discover', () => writeFileSync(path.join(OUT, `${pathStem(TEST_FILE)}.loaded.json`), JSON.stringify(report)));
  // Counts are written once per turn of the event loop at most, and when the file ends.
  const changed = () => { if (pending) return; pending = true; nativeTimers.setTimeout(() => { pending = false; write(); }, 0); };
  mkdirSync(OUT, { recursive: true });
  write();
  afterAll(() => { write(); });
  const note = (key) => guard('discover', () => {
    const [first] = frames(CALLER_FRAMES);
    if (!first) report.noFrame += 1; else if (isTestCode(first[0])) report.testCalls += 1;
    else {
      // Counted in memory; written when a caller or an export is new to this file, and when the file ends.
      const row = (report.callers[relative(first[0])] ??= {});
      const seen = hasOwn(row, key);
      row[key] = (seen ? row[key] : 0) + 1;
      if (seen) return;
    }
    changed();
  });
  const counted = (fn, key) => new RealProxy(fn, { apply(target, thisArg, args) { note(key); return apply(target, thisArg, args); } });
  // A stateful family's store (C0e): its setState, subscribe and the actions getState hands out are its entries too.
  const storeExports = new RealSet(families.filter((family) => family.store).map((family) => `${relative(family.module)}#${family.store}`));
  const stateViews = new RealWeakMap();
  const storeCounter = (store, key) => new RealProxy(store, {
    ...(typeof store === 'function' ? { apply(target, thisArg, args) { note(key); return apply(target, thisArg, args); } } : {}),
    get(target, member) {
      const value = reflectGet(target, member);
      if (typeof value !== 'function' || !substitutable(target, member)) return value;
      if (member === 'setState' || member === 'subscribe') return counted(value, `${key}.${member}`);
      if (member !== 'getState') return value;
      return (...args) => {
        const state = apply(value, target, args);
        if (state === null || typeof state !== 'object') return state;
        if (!apply(WeakMapHas, stateViews, [state])) apply(WeakMapSet, stateViews, [state, new RealProxy(state, { get: (object, name) => { const item = reflectGet(object, name); return typeof item === 'function' && typeof name === 'string' && substitutable(object, name) ? counted(item, `${key}.${name}`) : item; } })]);
        return apply(WeakMapGet, stateViews, [state]);
      };
    },
  });
  const api = {
    wrap(value, key) {
      if (storeExports.has(key) && value !== null && (typeof value === 'function' || typeof value === 'object')) return storeCounter(value, key);
      if (typeof value !== 'function') return value;
      return counted(value, key);
    },
  };
  defineProperty(globalThis, Symbol.for('devryan.client-conformance.discover'), { value: api, configurable: true, enumerable: false, writable: false });
  const files = families.map((family) => family.module);
  const filter = new RegExp(`^(?:${files.map(escapeRegExp).join('|')})(?:\\?conformance-real)?$`);
  Bun.plugin({
    name: 'devryan-client-conformance-discover',
    setup(build) {
      build.onLoad({ filter }, (args) => {
        const [file, query] = args.path.split('?');
        const source = readFileSync(file, 'utf8');
        if (query === 'conformance-real') return { contents: source, loader: loaderFor(file) };
        const name = relative(file);
        if (!report.loaded.includes(name)) { report.loaded.push(name); report.loaded.sort(); write(); }
        const real = JSON.stringify(`${file}?conformance-real`);
        const lines = [`import * as __real from ${real};`, "const __api = globalThis[Symbol.for('devryan.client-conformance.discover')];", `export * from ${real};`];
        for (const exported of new Bun.Transpiler({ loader: loaderFor(file) }).scan(source).exports) {
          const key = JSON.stringify(`${name}#${exported}`);
          if (exported === 'default') lines.push(`export default __api.wrap(__real.default, ${key});`);
          else lines.push(`export const ${exported} = __api.wrap(__real.${exported}, ${key});`);
        }
        return { contents: lines.join('\n'), loader: 'js' };
      });
    },
  });
}

const loadedFamilies = new RealMap(); // family -> real module namespace
const portData = new RealMap(); // a data port export's name -> { families that list it, its codec tree as the module exported it }
const loadedModules = new RealMap(); // mapped module file -> real module namespace (its exports are reported for the census)
const scannedModules = new RealMap(); // mapped module file -> the export names its source declares (Bun's scan, at load)
if (portMap) {
  const injectedByEntry = new RealMap();
  for (const family of portMap.families) for (const item of family.injected ?? []) {
    if (item.member !== undefined) {
      const byMember = `${family.name}:${item.entry}:${item.member}`;
      if (!apply(MapHas, injectedByMember, [byMember])) apply(MapSet, injectedByMember, [byMember, []]);
      apply(MapGet, injectedByMember, [byMember]).push(item);
      continue;
    }
    const key = `${family.name}:${item.entry}`;
    if (!apply(MapHas, injectedByEntry, [key])) apply(MapSet, injectedByEntry, [key, []]);
    apply(MapGet, injectedByEntry, [key]).push(item);
  }
  const api = {
    loaded(file, namespace) {
      apply(MapSet, loadedModules, [file, namespace]);
      for (const name of portMap.modules.get(file)?.families ?? []) apply(MapSet, loadedFamilies, [name, namespace]);
      listenToStores(file, namespace);
    },
    moduleState(file, read) { apply(MapSet, moduleStates, [file, read]); },
    wrap(file, exportName, value) {
      const target = portMap.modules.get(file);
      // A stateful family's store export (a zustand hook, a function, or a vanilla store object).
      const storeFamily = storeOf(target, exportName);
      if (storeFamily) {
        const listed = entryOf(target, exportName);
        const spec = { ...(listed?.spec ?? { export: exportName }), injected: apply(MapGet, injectedByEntry, [`${storeFamily}:${exportName}`]) };
        const port = target?.ports.get(exportName);
        return storeWrapper(storeFamily, spec, exportName, value, port ? { name: port.name, families: new RealSet(port.families), wrapAnswers: port.wrapAnswers === true } : null);
      }
      const entry = typeof value === 'function' ? entryOf(target, exportName) : null;
      const port = target?.ports.get(exportName);
      const crossing = port ? { name: port.name, families: new RealSet(port.families), wrapAnswers: port.wrapAnswers === true } : null;
      if (entry) {
        const spec = { ...entry.spec, injected: apply(MapGet, injectedByEntry, [`${entry.family}:${exportName}`]) };
        return wrapEntry(entry.family, spec, exportName, value, crossing);
      }
      if (port && typeof value === 'function') return portFunction(port.name, value, { families: crossing.families, wrapAnswers: crossing.wrapAnswers });
      // A namespace of methods (syncDebug: { pipeline: { flush } }) has behaviour one level down: a port object too (C0f).
      if (port && (portLike(value) || answerLike(value))) return portObject(port.name, value, { families: crossing.families, wrapAnswers: crossing.wrapAnswers });
      // A port export that is data (a client id the module drew when it loaded) is an input of every case: its value
      // as the module exported it is written with the recording (`portData`), so a replay's module gets that very value
      // (package C0f). The module's own load is no step, so nothing else of it is recorded.
      if (port) guard('port.data', () => { if (!apply(MapHas, portData, [port.name])) apply(MapSet, portData, [port.name, { families: [...port.families].sort(), value: encode(value) }]); });
      return value;
    },
  };
  defineProperty(globalThis, API, { value: api, configurable: true, enumerable: false, writable: false });
  const files = [...portMap.modules.keys()];
  const filter = new RegExp(`^(?:${files.map(escapeRegExp).join('|')})(?:\\?conformance-real)?$`);
  Bun.plugin({
    name: 'devryan-client-conformance',
    setup(build) {
      build.onLoad({ filter }, (args) => {
        const [file, query] = args.path.split('?');
        const source = readFileSync(file, 'utf8');
        if (query === 'conformance-real' || !portMap.modules.has(file)) return { contents: portMap.modules.has(file) ? source + moduleStateSource(file) : source, loader: loaderFor(file) };
        const target = portMap.modules.get(file);
        const exports = new Bun.Transpiler({ loader: loaderFor(file) }).scan(source).exports;
        apply(MapSet, scannedModules, [file, [...exports].sort()]);
        const real = JSON.stringify(`${file}?conformance-real`);
        const key = JSON.stringify(file);
        const lines = [`import * as __real from ${real};`, `const __api = globalThis[Symbol.for('devryan.client-conformance')];`, `__api.loaded(${key}, __real);`, `export * from ${real};`];
        for (const name of exports) {
          const wrapped = target.entries.has(name) || target.ports.has(name) || entryOf(target, name) !== null || storeOf(target, name) !== null;
          if (name === 'default') lines.push(wrapped ? `export default __api.wrap(${key}, "default", __real.default);` : `export { default } from ${real};`);
          else if (wrapped) lines.push(`export const ${name} = __api.wrap(${key}, ${JSON.stringify(name)}, __real.${name});`);
        }
        return { contents: lines.join('\n'), loader: 'js' };
      });
    },
  });
}

// ---------------------------------------------------- mock.module, globals

if (layers.has('mock-module')) {
  const realModule = mock.module;
  const mockName = (specifier) => {
    try { return `module:${relative(realpathSync(Bun.resolveSync(specifier, path.dirname(Bun.main))))}`; } catch { return `mock:${specifier}`; }
  };
  const specifierOf = new RealMap(); // a mocked module's port name -> the specifier the test mocked it by
  const wrapExports = (name, exports) => {
    if (exports === null || typeof exports !== 'object') return exports;
    return guard('mock.module', () => {
      const out = {};
      for (const key of ownKeys(exports)) {
        const descriptor = getOwnPropertyDescriptor(exports, key);
        if (!descriptor) continue;
        if (hasOwn(descriptor, 'value') && typeof key === 'string') {
          const value = descriptor.value;
          if (typeof value === 'function') descriptor.value = portFunction(`${name}#${key}`, value, { mocked: true });
          else if (portLike(value)) descriptor.value = portObject(`${name}#${key}`, value, { mocked: true });
          // A data export of a mocked port module is the mock's (package C0f): the module that imports it after the mock
          // gets that value, so it is the recording's `portData` for the port (the last mock wins, as for mock.module).
          else guard('port.data', () => {
            const port = portMap?.modules.get(realpathSync(Bun.resolveSync(String(specifierOf.get(name) ?? ''), path.dirname(Bun.main))))?.ports.get(key);
            if (port) apply(MapSet, portData, [port.name, { families: [...port.families].sort(), value: encode(value) }]);
          });
        }
        defineProperty(out, key, descriptor);
      }
      return out;
    }, exports);
  };
  const wrappedModule = { module(specifier, factory) {
    if (typeof factory !== 'function') return apply(realModule, this, [specifier, factory]);
    const name = guard('mock.module', () => mockName(specifier), `mock:${String(specifier)}`);
    apply(MapSet, specifierOf, [name, specifier]);
    const wrappedFactory = function (...args) {
      const exports = apply(factory, this, args);
      if (isPromise(exports)) return apply(PromiseThen, exports, [(resolved) => wrapExports(name, resolved)]);
      return wrapExports(name, exports);
    };
    return apply(realModule, this, [specifier, wrappedFactory]);
  } }.module;
  mock.module = wrappedModule;
}

const controls = new RealMap(); // holder -> Map(key -> { armed(), disarm(), rearm(), foreign(), label })
/**
 * An accessor on `holder` for `key`: what a test assigns is wrapped as it is
 * set. Bun's spyOn refuses accessors and some tests define data properties
 * over it, so the accessor is lowered to a data property around spyOn and is
 * re-armed (with whatever value the data property then holds) right after
 * spyOn and at every test boundary. While a test's own definition stands (a
 * data property holding something the recorder did not wrap, or an accessor
 * the test defined, which is never re-armed: its getter is the test's), what
 * the engine does through it is not recorded, so every case it stands in is
 * flagged `global-defined:<name>` (checkGlobals).
 */
function installProperty(holder, key, wrap, { label = key } = {}) {
  const initial = getOwnPropertyDescriptor(holder, key);
  if (initial && !initial.configurable) return;
  const enumerable = initial ? initial.enumerable : false;
  let raw;
  let wrapped;
  const assign = (value) => {
    raw = apply(WeakMapHas, rawOf, [value]) ? apply(WeakMapGet, rawOf, [value]) : value;
    wrapped = raw === undefined || raw === null ? raw : guard(`property ${label}`, () => wrap(raw), raw);
  };
  const readsAreInputs = holder === globalThis && apply(SetHas, READ_GLOBALS, [key]);
  const accessor = {
    configurable: true, enumerable,
    get() {
      if (readsAreInputs) guard('global.read', () => noteGlobalRead(label, wrapped));
      return wrapped;
    },
    set(value) {
      assign(value);
      guard('global.set', () => current.context.push({ kind: 'global.set', name: label, origin: 'test' }));
    },
  };
  const armed = () => getOwnPropertyDescriptor(holder, key)?.get === accessor.get;
  const rearm = () => {
    const descriptor = getOwnPropertyDescriptor(holder, key);
    if (descriptor && !hasOwn(descriptor, 'value')) return; // ours, or an accessor a test defined: left alone
    if (descriptor && !descriptor.configurable) return;
    assign(descriptor ? descriptor.value : undefined);
    defineProperty(holder, key, accessor);
  };
  const disarm = () => { if (armed()) defineProperty(holder, key, { value: wrapped, writable: true, configurable: true, enumerable }); };
  /** Why the current definition hides the engine's use of the global, or null. */
  const foreign = () => {
    const descriptor = getOwnPropertyDescriptor(holder, key);
    if (!descriptor || descriptor.get === accessor.get) return null;
    if (!hasOwn(descriptor, 'value')) return 'accessor';
    const value = descriptor.value;
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || apply(WeakMapHas, rawOf, [value])) return null;
    return guard(`property ${label}`, () => wrap(value), null) === value ? null : 'value';
  };
  assign(initial ? (hasOwn(initial, 'value') ? initial.value : initial.get ? apply(initial.get, holder, []) : undefined) : undefined);
  defineProperty(holder, key, accessor);
  let byKey = apply(MapGet, controls, [holder]);
  if (!byKey) { byKey = new RealMap(); apply(MapSet, controls, [holder, byKey]); }
  apply(MapSet, byKey, [key, { armed, disarm, rearm, foreign, label }]);
}
const installGlobal = (name, wrap) => installProperty(globalThis, name, wrap);
/**
 * Engine code reading a transport or DOM global itself (`typeof document`, `new WebSocket`, `window.x`) reads an input:
 * whether the global is there, and what it is (package C0f). It is a `read` of the port `globalThis`, whose answer is
 * the port the engine then holds (or undefined); the test decides it, by installing a fake or not.
 */
function noteGlobalRead(name, value) {
  const store = storeNow();
  if (originOf(store) !== 'engine' || isLate(store)) return;
  record({ kind: 'read', port: 'globalThis', key: ref(name), value: ref(value) }, store);
}
const rearmGlobals = () => { apply(MapForEach, controls, [(byKey) => apply(MapForEach, byKey, [(control) => { guard('global.rearm', () => control.rearm()); }])]); };
/** Flags `kase` for every controlled global whose definition is the test's own (`keys` limits the check to one holder's keys). */
function checkGlobals(kase, holder = null, keys = null) {
  const visit = (byKey) => apply(MapForEach, byKey, [(control, key) => {
    if (keys && !keys.includes(key)) return;
    if (guard('global.check', () => control.foreign(), null)) kase.flags.add(`global-defined:${control.label}`);
  }]);
  if (holder) { const byKey = apply(MapGet, controls, [holder]); if (byKey) visit(byKey); return; }
  apply(MapForEach, controls, [visit]);
}
/**
 * Object.defineProperty, Object.defineProperties and Reflect.defineProperty,
 * observed: after a definition on a holder of controlled globals, the current
 * case is flagged if the definition is now the test's own. A Proxy over the
 * native function keeps its name, length and native-looking source.
 */
function observeDefinitions() {
  const watch = (holder, name, keysOf) => {
    const real = holder[name];
    const watched = new RealProxy(real, {
      apply(target, thisArg, args) {
        const result = apply(target, thisArg, args);
        const object = args[0];
        if (object !== null && (typeof object === 'object' || typeof object === 'function') && apply(MapHas, controls, [object])) {
          guard('global.define', () => checkGlobals(current, object, keysOf(args)));
        }
        return result;
      },
    });
    apply(WeakMapSet, rawOf, [watched, real]);
    defineProperty(holder, name, { value: watched, writable: true, configurable: true, enumerable: false });
  };
  watch(Object, 'defineProperty', (args) => [args[1]]);
  watch(Reflect, 'defineProperty', (args) => [args[1]]);
  watch(Object, 'defineProperties', (args) => (args[1] !== null && typeof args[1] === 'object' ? ownKeys(args[1]) : []));
}

/**
 * The test API the test file imports, with every function it registers (a test body, a hook) run in a test
 * store of the case current when the runner calls it (testStore), so a job or a timer it leaves behind is
 * filed under its own case. The function keeps its name and declared length (bun reads the length to tell a
 * `done` callback). `test.each(…)`, `test.skip` and the like are wrapped the same way; `describe` is not
 * (its body runs while the file loads, in the module-load case).
 */
const ownedBodies = new RealWeakMap();
function ownedBody(fn) {
  if (typeof fn !== 'function' || apply(WeakMapHas, rawOf, [fn])) return fn;
  const known = apply(WeakMapGet, ownedBodies, [fn]);
  if (known) return known;
  const body = { [fn.name](...args) { return als.run(testStore(current), () => apply(fn, this, args)); } }[fn.name];
  defineProperty(body, 'length', { value: fn.length, configurable: true });
  apply(WeakMapSet, ownedBodies, [fn, body]);
  apply(WeakMapSet, rawOf, [body, fn]);
  return body;
}
const ownedApis = new RealWeakMap();
const REGISTRAR_FACTORIES = new RealSet(['each', 'if', 'skipIf', 'todoIf', 'failingIf']);
function ownedApi(api) {
  if (typeof api !== 'function') return api;
  const known = apply(WeakMapGet, ownedApis, [api]);
  if (known) return known;
  const proxy = new RealProxy(api, {
    // A proper tail call: bun names a test by the line of the frame that registers it, which stays the test file's.
    apply(target, thisArg, args) { return apply(target, thisArg, args.map((arg) => ownedBody(arg))); },
    get(target, key) {
      const value = reflectGet(target, key);
      if (typeof value !== 'function' || key === 'prototype' || !substitutable(target, key)) return value;
      // `test.each(table)`, `test.if(condition)` and the like hand back the function that registers.
      if (REGISTRAR_FACTORIES.has(key)) return { [key](...args) { return ownedApi(apply(value, target, args)); } }[key];
      return ownedApi(value);
    },
  });
  apply(WeakMapSet, ownedApis, [api, proxy]);
  apply(WeakMapSet, rawOf, [proxy, api]);
  return proxy;
}
const ownedTestApi = () => {
  const out = {};
  for (const name of ['test', 'it', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']) if (typeof bunTest[name] === 'function') out[name] = ownedApi(bunTest[name]);
  return out;
};

/**
 * Bun's spyOn refuses accessor properties: around it, a recorder property is a
 * plain data property. It also installs nothing through a Proxy (it reads
 * through the traps and writes past them), so a spy on a recorder Proxy (the
 * nominal Date, a port object) goes on the object it wraps, where the Proxy
 * reads it.
 */
function spyOnWrapper(realSpyOn) {
  const wrapper = { spyOn(target, key, ...rest) {
    const unwrapped = target !== null && (typeof target === 'object' || typeof target === 'function') ? apply(WeakMapGet, rawOf, [target]) : undefined;
    const object = unwrapped !== undefined && (typeof unwrapped === 'object' || typeof unwrapped === 'function') ? unwrapped : target;
    const control = (typeof object === 'object' || typeof object === 'function') && object !== null ? apply(MapGet, controls, [object])?.get(key) : undefined;
    if (!control || !control.armed()) return apply(realSpyOn, this, [object, key, ...rest]);
    control.disarm();
    try { return apply(realSpyOn, this, [object, key, ...rest]); } finally { guard('spyOn', () => control.rearm()); }
  } }.spyOn;
  apply(WeakMapSet, rawOf, [wrapper, realSpyOn]);
  return wrapper;
}

const ours = (own, source, kind) => (value) => (value === own ? own : stubWrapper(value, source, kind));
if (layers.has('clock')) {
  guard('performance.now', () => {
    defineProperty(realPerformance, 'now', { value: nominalPerformanceNow, writable: true, configurable: true, enumerable: true });
    if (layers.has('globals')) installProperty(realPerformance, 'now', ours(nominalPerformanceNow, 'performance.now', 'clock'), { label: 'performance.now' });
  });
  // new Date().constructor === Date: instances are made by the real Date, whose prototype names the nominal one.
  guard('Date.prototype', () => defineProperty(RealDate.prototype, 'constructor', { value: NominalDate, writable: true, configurable: true, enumerable: false }));
}
if (layers.has('random')) {
  defineProperty(Math, 'random', { value: seededRandom, writable: true, configurable: true, enumerable: false });
  guard('crypto', () => {
    defineProperty(crypto, 'getRandomValues', { value: seededGetRandomValues, writable: true, configurable: true, enumerable: true });
    defineProperty(crypto, 'randomUUID', { value: seededRandomUUID, writable: true, configurable: true, enumerable: true });
  });
  if (layers.has('globals')) {
    installProperty(Math, 'random', ours(seededRandom, 'Math.random', 'draw'), { label: 'Math.random' });
    guard('crypto', () => {
      installProperty(crypto, 'getRandomValues', ours(seededGetRandomValues, 'crypto.getRandomValues', 'draw'), { label: 'crypto.getRandomValues' });
      installProperty(crypto, 'randomUUID', ours(seededRandomUUID, 'crypto.randomUUID', 'draw'), { label: 'crypto.randomUUID' });
    });
  }
}
if (layers.has('globals')) {
  const answers = (name) => Boolean(portMap?.globals?.[name]?.wrapAnswers);
  installGlobal('fetch', (value) => (typeof value === 'function' ? portFunction('fetch', value, { wrapAnswers: answers('fetch'), realTransport: value === NATIVE_TRANSPORT.fetch }) : value));
  for (const name of ['WebSocket', 'EventSource']) installGlobal(name, (value) => (typeof value === 'function' ? portFunction(name, value, { realTransport: value === NATIVE_TRANSPORT[name] }) : value));
  for (const name of ['setTimeout', 'setInterval']) installGlobal(name, (value) => (typeof value === 'function' ? setTimerWrapper(name, value) : value));
  for (const name of ['clearTimeout', 'clearInterval']) installGlobal(name, (value) => (typeof value === 'function' ? clearTimerWrapper(name, value) : value));
  for (const name of ['localStorage', 'sessionStorage', 'document', 'window', 'navigator']) installGlobal(name, (value) => (typeof value === 'object' ? portObject(name, value) : value));
  installGlobal('Date', (value) => (value === RealDate ? NominalDate : value));
  const original = { crypto: globalThis.crypto, performance: globalThis.performance };
  for (const name of ['crypto', 'performance']) installGlobal(name, (value) => (value === original[name] || typeof value !== 'object' ? value : portObject(name, value)));
  // spyOn(globalThis, 'fetch') must keep working: bun:test is re-exported with a spyOn that lowers the accessor around the call.
  const spyOn = spyOnWrapper(bunTest.spyOn);
  const setSystemTime = setSystemTimeWrapper(realSetSystemTime);
  for (const holder of [bunTest.jest, bunTest.vi]) {
    if (!holder) continue;
    if (getOwnPropertyDescriptor(holder, 'spyOn')?.writable) holder.spyOn = spyOn;
    for (const [key, make] of [['setSystemTime', setSystemTimeWrapper], ['useFakeTimers', useFakeTimersWrapper], ['useRealTimers', useRealTimersWrapper]]) {
      if (typeof holder[key] === 'function' && getOwnPropertyDescriptor(holder, key)?.writable) holder[key] = make(holder[key]);
    }
  }
  realModuleOf(mock)('bun:test', () => ({ ...bunTest, spyOn, setSystemTime, ...ownedTestApi() }));
  guard('defineProperty', () => observeDefinitions());
} else if (layers.has('clock')) {
  globalThis.Date = NominalDate;
}

// ------------------------------------------- promises resolve inside windows
//
// With families to record, globalThis.Promise is a Proxy over the real
// constructor whose construct trap hands the executor resolve and reject
// functions that call the real ones inside a release window (inWindow()).
// What it constructs is a real promise of the real constructor, so `await`
// takes its usual path and no job is added or reordered. Static methods run
// with the real constructor as receiver (Promise.resolve(p) still answers p);
// Promise.withResolvers hands out windowed functions too. Promises made by
// async functions and by the engine's internals are resolved where they run:
// a job inside a window carries what it releases with it.
function windowedResolvers(resolve, reject) {
  const pair = { promise: null, used: false, inExecutor: false, tag: null };
  const settle = (real, value) => {
    pair.tag = releaseTag();
    if (pair.tag && pair.promise) apply(WeakMapSet, resolvedBy, [pair.promise, pair.tag]);
    // A resolve called while the executor still runs has no reaction to release: it is called directly.
    if (!pair.tag || pair.inExecutor) return apply(real, undefined, [value]);
    return inWindow(pair.tag, () => apply(real, undefined, [value]));
  };
  const windowed = (real) => function (value) {
    if (pair.used) return apply(real, undefined, [value]);
    pair.used = true;
    return settle(real, value);
  };
  pair.resolve = windowed(resolve);
  pair.reject = windowed(reject);
  /** Names the promise once it exists (a resolve inside the executor came first). */
  pair.made = (promise) => { pair.promise = promise; if (pair.tag) apply(WeakMapSet, resolvedBy, [promise, pair.tag]); return promise; };
  return pair;
}
if (portMap && layers.has('globals')) {
  const statics = new RealMap();
  const realWithResolvers = RealPromise.withResolvers;
  let PromiseProxy = null;
  const receiverOf = (thisArg) => (thisArg === PromiseProxy ? RealPromise : thisArg);
  const withResolvers = typeof realWithResolvers === 'function' ? new RealProxy(realWithResolvers, {
    apply(target, thisArg, args) {
      const made = apply(target, receiverOf(thisArg), args);
      const pair = windowedResolvers(made.resolve, made.reject);
      pair.made(made.promise);
      made.resolve = pair.resolve;
      made.reject = pair.reject;
      return made;
    },
  }) : undefined;
  PromiseProxy = new RealProxy(RealPromise, {
    construct(target, args, newTarget) {
      const made = newTarget === PromiseProxy ? target : newTarget;
      const executor = args[0];
      if (typeof executor !== 'function') return construct(target, args, made);
      let pair = null;
      const windowedExecutor = function (resolve, reject) {
        pair = windowedResolvers(resolve, reject);
        pair.inExecutor = true;
        try { return apply(executor, this, [pair.resolve, pair.reject]); } finally { pair.inExecutor = false; }
      };
      const promise = construct(target, [windowedExecutor, ...args.slice(1)], made);
      return pair ? pair.made(promise) : promise;
    },
    get(target, key, receiver) {
      if (key === 'withResolvers' && withResolvers) return withResolvers;
      const value = reflectGet(target, key, receiver);
      if (typeof value !== 'function' || key === 'prototype' || key === 'constructor') return value;
      let wrapper = apply(MapGet, statics, [key]);
      if (!wrapper || apply(WeakMapGet, rawOf, [wrapper]) !== value) {
        wrapper = new RealProxy(value, { apply: (fn, thisArg, callArgs) => apply(fn, receiverOf(thisArg), callArgs) });
        apply(WeakMapSet, rawOf, [wrapper, value]);
        apply(MapSet, statics, [key, wrapper]);
      }
      return wrapper;
    },
  });
  apply(WeakMapSet, rawOf, [PromiseProxy, RealPromise]);
  defineProperty(globalThis, 'Promise', { value: PromiseProxy, writable: true, configurable: true, enumerable: false });
  // then (and catch and finally, which call it): a late registration on a released promise joins the release.
  const windowedThen = new RealProxy(PromiseThen, {
    apply(target, thisArg, args) {
      const tag = guard('release', () => registeredLate(thisArg), null);
      return tag ? inWindow(tag, () => apply(target, thisArg, args)) : apply(target, thisArg, args);
    },
  });
  apply(WeakMapSet, rawOf, [windowedThen, PromiseThen]);
  defineProperty(RealPromise.prototype, 'then', { value: windowedThen, writable: true, configurable: true, enumerable: false });
}

// ------------------------------------------------------------ case lifecycle

function snapshotStates(target, owner = null) {
  if (!portMap) return;
  for (const family of portMap.families) {
    if (!apply(MapHas, loadedFamilies, [family.name])) continue;
    // A stateful family's state is taken only for a case in which the family has a line: at its first step (entry,
    // openStep) and when the case closes (end). Taking it for every case would put its values (and their codec
    // flags) into cases the family never ran in.
    if (family.store || family.moduleState) {
      if (owner && apply(MapHas, owner.families, [family.name])) target[family.name] = guard('state', () => ref(familyState(family.name), owner), null);
      continue;
    }
    if (!family.state) continue;
    const namespace = apply(MapGet, loadedFamilies, [family.name]);
    target[family.name] = guard('state', () => ref(als.run({ kind: 'harness' }, () => namespace[family.state]())), null);
  }
}

/** Replaces every Pending value of `record` (a plain JSON-like tree) through `slots`. */
function resolveRecord(item, slots) {
  if (item instanceof Pending) return apply(MapGet, slots, [item]);
  if (ArrayIsArray(item)) return item.map((entry) => resolveRecord(entry, slots));
  if (item === null || typeof item !== 'object') return item;
  const out = {};
  for (const [key, entry] of objectEntries(item)) out[key] = resolveRecord(entry, slots);
  return out;
}
function collectPending(item, into) {
  if (item instanceof Pending) { into.push(item); return; }
  if (ArrayIsArray(item)) { for (const entry of item) collectPending(entry, into); return; }
  if (item === null || typeof item !== 'object') return;
  for (const key of ownKeys(item)) collectPending(item[key], into);
}
/** One container line's worth of a family: its slots emitted as one identity scope, in written order. */
/** Whether a tree holds a node of one of `tags`. */
function holdsNode(tree, tags) {
  if (tree === null || typeof tree !== 'object') return false;
  if (ArrayIsArray(tree)) return tree.some((item) => holdsNode(item, tags));
  if (typeof tree.$dr === 'string' && tags.includes(tree.$dr)) return true;
  return ownKeys(tree).some((key) => holdsNode(tree[key], tags));
}
// The test isolation guard's private root of this run, as given and as its real path (as the isolation check writes it).
const ISOLATION_ROOTS = (() => {
  const root = process.env.DEVRYAN_TEST_ISOLATION_ROOT;
  if (!root) return [];
  let real = root;
  try { real = realpathSync(root); } catch { /* the given path */ }
  return [...new RealSet([real, root])].sort((left, right) => right.length - left.length);
})();
function withoutIsolationRoot(tree) {
  if (typeof tree === 'string') { let text = tree; for (const root of ISOLATION_ROOTS) text = text.split(root).join('<isolation-root>'); return text; }
  if (tree === null || typeof tree !== 'object') return tree;
  if (ArrayIsArray(tree)) return tree.map(withoutIsolationRoot);
  const out = {};
  for (const key of ownKeys(tree)) defineProperty(out, key, { value: withoutIsolationRoot(tree[key]), writable: true, enumerable: true, configurable: true });
  return out;
}
function finalizeFamily(entry, steps, end, context, flags = null, pendingTimers = []) {
  const parts = { entryState: entry ?? null, steps, endState: end ?? null, context, ...(pendingTimers.length ? { pending: pendingTimers } : {}) };
  const pending = [];
  collectPending(parts, pending);
  const trees = emitSlots(pending.map((item) => item.taken));
  if (flags) {
    // What a replay could not rebuild (package C0e): a platform object the codec writes as opaque (a Blob, a File)
    // anywhere in the family's line, and a pending promise in the state the case starts from (work an earlier case
    // started), which a case replayed alone would wait on for ever.
    const core = [];
    collectPending({ entryState: entry ?? null, steps, endState: end ?? null }, core);
    if (trees.slice(0, core.length).some((tree) => holdsNode(tree, ['opaque']))) flags.add('opaque');
    const entryCount = [];
    collectPending({ entryState: entry ?? null }, entryCount);
    if (trees.slice(0, entryCount.length).some((tree) => holdsNode(tree, ['promise']))) flags.add('state-promise');
  }
  const slots = new RealMap();
  // The test's own context (never replayed or compared) is written with the run's isolated root as `<isolation-root>`
  // (package C0f): a test hands its own calls paths under its private HOME, which is another directory every run.
  const contextItems = [];
  collectPending({ context }, contextItems);
  const contextSet = new RealSet(contextItems);
  pending.forEach((item, index) => {
    const tree = ISOLATION_ROOTS.length && apply(SetHas, contextSet, [item]) ? withoutIsolationRoot(trees[index]) : trees[index];
    // Large subtrees and strings are stored once, as slices (container.mjs).
    const text = sliceTree(tree, (sliceHash, sliceText) => { if (!apply(MapHas, values, [sliceHash])) apply(MapSet, values, [sliceHash, sliceText]); });
    const hash = hashText(text);
    if (!apply(MapHas, values, [hash])) apply(MapSet, values, [hash, text]);
    apply(MapSet, slots, [item, `=${hash}`]);
  });
  return resolveRecord(parts, slots);
}

function closeCase() {
  if (current.endNow !== null) return;
  current.endNow = current.clock.now;
  snapshotStates(current.endState, current);
  // The engine timers still pending when the test ended, in the order they were set: what each would have done is
  // never recorded (a late firing is no step), so the case says which they are, their delay and the step that set them.
  apply(MapForEach, current.families, [(entry) => {
    const pending = [];
    apply(MapForEach, entry.live, [(timer) => { pending.push({ timer: timer.id, delay: timer.delay, repeat: timer.repeat, step: timer.step }); }]);
    entry.pending = pending;
  }]);
  apply(MapForEach, current.families, [(entry) => { guard('signals', () => checkSignals(entry)); }]);
  // A case stays open to effects that arrive after its test ended (marked late); it is written with the file.
  closed.push(current);
  // Timers of the case held back by the timer order now fire as they come (each one late: no step).
  guard('timer.release', () => scheduleRelease(current));
}

/** The written form of a closed case: every family's line and its flags. */
function finalizeCase(record) {
  const families = {};
  apply(MapForEach, record.families, [(entry, name) => { families[name] = guard('case.write', () => finalizeFamily(record.entryState[name], entry.steps, record.endState[name], record.context, entry.flags, entry.pending), null); }]);
  const flags = [...record.codec.flags, ...record.flags].filter((flag, index, list) => list.indexOf(flag) === index).sort();
  // A stateful family whose state code outside its steps changed inside the case cannot be replayed past that point.
  apply(MapForEach, record.families, [(entry, name) => { if (entry.steps.length && apply(SetHas, record.moved, [name])) entry.flags.add('state-moved'); }]);
  // Handed-out engine code of the family called, or a store it handed out written, by code no family maps (noteTouched).
  apply(MapForEach, record.families, [(entry, name) => { if (entry.steps.length && apply(SetHas, record.touched, [name])) entry.flags.add('handed-out-touched'); }]);
  const familyFlags = {};
  apply(MapForEach, record.families, [(entry, name) => { if (entry.flags.size) familyFlags[name] = [...entry.flags].sort(); }]);
  record.out = { kind: record.kind, ...(record.kind === 'test' ? { ordinal: record.ordinal } : { hooks: record.hooks }), seed: record.seed, entryNow: record.entryNow, endNow: record.endNow, flags, familyFlags, families, contextRecords: record.context.length };
  // A hooks case is kept when anything happened in it, a flag included (record.mjs refuses a flag that no family's line carries).
  return record.kind === 'test' || ownKeys(families).length > 0 || record.out.contextRecords > 0 || flags.length > 0;
}

// Tests that overlap (test.concurrent) cannot be told apart: while more than
// one test is open, every case that is current (tests and hooks alike) is
// flagged, so nothing that ran during the overlap is ever named by order.
// At every boundary the controlled globals are checked before they are
// re-armed (the closing case) and after (the opening case: an accessor a test
// defined stays), so a case in which a test's own definition stood is flagged.
let openTests = 0;
const MAIN = Bun.main;
beforeEach(() => {
  // One recorder serves one test file: without --parallel, bun runs the next file in the same process.
  if (Bun.main !== MAIN && !errors.some((line) => line.startsWith('two test files'))) errors.push(`two test files in one process (${relative(MAIN)}, then ${relative(Bun.main)}): run bun test with --parallel`);
  guard('case.open', () => checkGlobals(current));
  rearmGlobals();
  guard('case.open', () => {
    openTests += 1;
    const overlap = openTests > 1;
    if (overlap) current.flags.add('concurrent');
    closeCase();
    current = newCase({ ordinal: (testsSeen += 1) }, current);
    if (overlap) current.flags.add('concurrent');
    checkGlobals(current);
    snapshotStates(current.entryState);
  });
});
afterEach(() => {
  guard('case.close', () => {
    openTests = Math.max(0, openTests - 1);
    if (current.kind !== 'test' && !(openTests === 0 && current.flags.has('concurrent'))) return;
    checkGlobals(current);
    closeCase();
    current = newCase({ hooks: testsSeen }, current);
    if (openTests > 0) current.flags.add('concurrent');
    snapshotStates(current.entryState);
  });
  rearmGlobals();
  guard('case.close', () => checkGlobals(current));
});

/** For each family, a digest of the sources of its module and its port modules (the code a recording is of). */
/**
 * The runtime exports of every mapped module this file loaded, as `{ module:
 * { name: kind } }` (kind: `function`, `class` or `data`), read from the real
 * namespace when the file ends; the census derives export lists from them, so
 * nothing in a tracked file lists what a module exports.
 */
function moduleExports() {
  const out = {};
  apply(MapForEach, loadedModules, [(namespace, file) => {
    // Only a family's own module: a port module's exports are not judged, and a test may mock it (package C0f: the API
    // client is a port of the pipeline, and component tests mock it, so two files would see two namespaces).
    if (!(portMap?.modules.get(file)?.families.length > 0)) return;
    const kinds = {};
    for (const name of ownKeys(namespace).filter((key) => typeof key === 'string').sort()) {
      kinds[name] = guard('exports', () => {
        const value = namespace[name];
        if (typeof value !== 'function') return 'data';
        return /^class\b/.test(apply(FunctionToString, value, [])) ? 'class' : 'function';
      }, 'unknown');
    }
    out[relative(file)] = kinds;
  }]);
  return out;
}

const scannedExports = () => {
  const out = {};
  apply(MapForEach, scannedModules, [(names, file) => { if (apply(MapHas, loadedModules, [file]) && portMap?.modules.get(file)?.families.length > 0) out[relative(file)] = names; }]);
  return out;
};
/** A table of tables with its keys sorted at both levels (the raw's bytes do not depend on call order). */
const sortedTable = (table) => {
  const out = {};
  for (const key of ownKeys(table).sort()) {
    const row = table[key];
    if (row === null || typeof row !== 'object') { out[key] = row; continue; }
    out[key] = {};
    for (const inner of ownKeys(row).sort()) out[key][inner] = row[inner];
  }
  return out;
};

function moduleDigests() {
  if (!portMap) return null;
  const out = {};
  for (const family of portMap.families) {
    const files = [family.module, ...(family.ports ?? []).map((port) => realpathSync(path.resolve(path.dirname(realpathSync(portMap.file)), port.module)))];
    const lines = files.map((file) => `${relative(file)} ${createHash('sha256').update(readFileSync(file)).digest('hex')}`).sort();
    out[family.name] = `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
  }
  return out;
}
const MODULES = guard('modules', () => moduleDigests(), null);

afterAll(() => {
  guard('case.close', () => { checkGlobals(current); closeCase(); });
  const kept = closed.filter((entry) => guard('case.write', () => finalizeCase(entry), true));
  written = true;
  if (!OUT || DISCOVER) return;
  const raw = {
    version: RAW_VERSION, recording: RECORDING_VERSION, file: TEST_FILE, bun: Bun.version, layers: [...layers], portMap: portMap?.digest ?? null, modules: MODULES, epoch: EPOCH,
    exports: guard('exports', () => moduleExports(), {}), scanned: guard('exports', () => scannedExports(), {}),
    actions: guard('exports', () => { const out = {}; apply(MapForEach, storeActions, [(actions, file) => { out[relative(file)] = actions; }]); return out; }, {}),
    passed, unmapped: sortedTable(unmapped), callers: sortedTable(callers), portCallers: sortedTable(portCallers), noFrame: sortedTable(noFrame),
    cases: kept.map((entry) => entry.out), values: Object.fromEntries(values), errors, unplaced, portData: Object.fromEntries(portData),
  };
  mkdirSync(OUT, { recursive: true });
  // Never overwrite: two test files must never share a recording.
  writeFileSync(path.join(OUT, `${pathStem(TEST_FILE)}.raw.json`), JSON.stringify(raw), { flag: 'wx' });
// Writing a file's recording can take longer than a hook's default 5 s; its time is the recorder's, not the test's.
}, { timeout: WRITE_TIMEOUT_MS });
