// Recorder core of the client engine conformance harness (design file 29 §2),
// a `bun test --preload`. It sits below the tests: what a test installs (a
// fake fetch, a fake WebSocket, a timer trap, a mocked module, a Date.now
// stub, a spy, fake timers) is layered on top of the recorder's version and
// is still seen by it. It never calls a user-defined getter and does not
// change what a test observes, except where docs/TESTING.md lists it.
//
// What it does, per layer (DEVRYAN_CONFORMANCE_LAYERS, default all):
// - clock: a nominal clock. Timers keep real scheduling; Date.now(), new
//   Date() and performance.now() read a virtual time that starts at EPOCH and
//   moves, when a timer fires, to that timer's nominal due time (its virtual
//   set time plus its delay), never backward. setSystemTime sets it; under
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
//   mocks are recorded as ports.
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
// Cases. One test is one case. What runs outside a test (module load, a
// beforeAll, a describe's afterAll, the file's afterAll) is a hooks case
// numbered by the tests that ran before it, so nothing is lost or misfiled.
// Tests that overlap (test.concurrent) are marked unrecordable. Cases are
// written when the file ends: what an engine chain does after its test ended
// goes to that test's case, marked late; after the file's recording is
// written it is counted as unplaced, never dropped silently.
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
import { createCodecContext, emitSlots, hashText, snapshot, stringifyTree } from './codec.mjs';
import { pathStem } from './container.mjs';
import { loadPortMap } from './port-map.mjs';

export const EPOCH = 1700000000000;
export const PERFORMANCE_ORIGIN = 1000;
export const RAW_VERSION = 3;
// The recording's semantics: bumped by hand whenever what a recording says changes (attribution, late effects, flags).
export const RECORDING_VERSION = 3;
export const LAYERS = Object.freeze(['clock', 'random', 'globals', 'mock-module', 'entries']);
const API = Symbol.for('devryan.client-conformance');

// Intrinsics: tests replace globalThis.Map, Date, setTimeout and others.
const RealMap = Map;
const RealSet = Set;
const RealWeakMap = WeakMap;
const RealProxy = Proxy;
const RealError = Error;
const RealDate = Date;
const RealPromise = Promise;
const RealUint8Array = Uint8Array;
const { apply, construct, get: reflectGet, set: reflectSet, ownKeys, defineProperty: reflectDefineProperty, getOwnPropertyDescriptor: reflectDescriptor } = Reflect;
const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf, hasOwn, entries: objectEntries } = Object;
const ObjectPrototype = Object.prototype;
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
const realIsFakeTimers = bunTest.jest?.isFakeTimers;
const isFakeTimers = typeof realIsFakeTimers === 'function' ? () => apply(realIsFakeTimers, bunTest.jest, []) : () => false;

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
for (const name of layerList) if (!LAYERS.includes(name)) throw new Error(`client-conformance recorder: unknown layer ${name}`);
const layers = new RealSet(layerList);
const PORT_MAP_FILE = setting('DEVRYAN_CONFORMANCE_PORT_MAP');
const portMap = PORT_MAP_FILE && layers.has('entries') ? loadPortMap(PORT_MAP_FILE, { root: ROOT }) : null;

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
let virtualNow = EPOCH;
// performance.now() is a monotonic clock: it moves only with the nominal schedule, never with setSystemTime.
let virtualPerformance = PERFORMANCE_ORIGIN;

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
function newCase({ ordinal = null, hooks = null }) {
  const label = ordinal !== null ? String(ordinal) : `hooks:${hooks}`;
  const seed = createHash('sha256').update(`${TEST_FILE}#${ordinal !== null ? ordinal : label}`).digest();
  return {
    kind: ordinal !== null ? 'test' : 'hooks', ordinal, hooks, label, seed: seed.toString('hex').slice(0, 32), families: new RealMap(), context: [],
    codec: createCodecContext({ names: portNames, unwrap }), flags: new RealSet(), testTimers: 0, testCalls: 0, expired: [],
    entryNow: virtualNow, endNow: null, entryState: {}, endState: {}, random: sfc32(seed), out: null,
  };
}

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

const storeNow = () => als.getStore();
/** Who is running: engine (a chain of a case, the current one or an earlier one), port, harness or test. */
function originOf(store) {
  if (!store) return 'test';
  return store.kind;
}

function familyRecord(name, owner = current) {
  let record = apply(MapGet, owner.families, [name]);
  if (!record) { record = { steps: [], timers: 0, portCalls: 0, objects: 0 }; apply(MapSet, owner.families, [name, record]); }
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
const portStore = (caller = null) => ({ kind: 'port', case: caller?.case ?? current, caller, active: true });
/** Runs `fn` as port code called by `caller`. */
function inPort(caller, fn) {
  const store = portStore(caller);
  try { return als.run(store, fn); } finally { store.active = false; }
}
const reentrant = (opener) => opener?.kind === 'port' && opener.active === true;
const runIn = (store, fn) => (store ? als.run(store, fn) : als.exit(fn));

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
  const list = window.case.expired;
  list.push(window);
  if (list.length > EXPIRED_KEPT) list.shift();
}
/** What a release is attributed to: the resolving engine chain's step, or null for test and port code; null for harness code. */
function releaseTag() {
  const store = storeNow();
  const origin = originOf(store);
  if (origin === 'harness' || stepSeq === 0) return null;
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
  let window = null;
  for (const entry of activeWindows) if (!window || entry.id > window.id) window = entry;
  const seq = stepNumber(store.step);
  let placed = false;
  if (window !== null) {
    window.lastActive = window.generation;
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

/** Opens a step of `family` in case `owner`; `opener` is the store the input arrives in (re-entrance is `during`). */
function openStep(family, input, opener = storeNow(), owner = current) {
  if (written) { noteUnplaced(input.kind); return null; }
  const record = familyRecord(family, owner);
  const step = { n: record.steps.length + 1, input: { ...input, now: readNow() }, effects: [] };
  // An input that arrives after its case's test ended (a timer, an answer, a resolve) is still the case's: marked late.
  if (owner.endNow !== null) step.late = true;
  apply(WeakMapSet, seqOf, [step, (stepSeq += 1)]);
  const caller = reentrant(opener) ? opener.caller : null;
  if (caller && caller.kind === 'engine' && caller.case === owner && caller.family === family) step.input.during = caller.step.n;
  record.steps.push(step);
  return step;
}

/** Puts an effect in `step` of case `owner`; one that arrives after the test ended is marked late. */
function place(step, owner, effect) {
  if (written) { noteUnplaced(effect.kind); return false; }
  if (owner.endNow !== null && step.late !== true) effect.late = true;
  step.effects.push(effect);
  return true;
}

/** Records an effect where it belongs: the step of the engine chain running it (in its own case), else the case context. */
function record(effect, store = storeNow()) {
  const origin = originOf(store);
  if (origin === 'port' || origin === 'harness') return false;
  if (origin === 'engine') return place(stepOf(store), store.case, effect);
  checkOutside();
  effect.origin = 'test';
  current.context.push(effect);
  return true;
}

const isPromise = (value) => value !== null && typeof value === 'object' && apply(isPrototypeOf, RealPromise.prototype, [value]);
/** Observes a settlement without changing the promise the caller gets (it is marked handled; docs/TESTING.md). */
function observeSettle(promise, onSettle) {
  apply(PromiseThen, promise, [(value) => { guard('settle', () => onSettle('fulfilled', value)); }, (reason) => { guard('settle', () => onSettle('rejected', reason)); }]);
}

/** Paths of every container object in a draft, by identity, through own enumerable data members only. */
function identityPaths(root) {
  const paths = [];
  const visited = new RealSet();
  const walk = (value, where) => {
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
const streamNow = () => caseOf(storeNow()).random;
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
/** The frames of the running code with a file, newest first, as `[file, line]`; the recorder's own are left out. */
const DEFAULT_STACK = RealError.stackTraceLimit;
function frames(limit) {
  const saved = RealError.stackTraceLimit;
  let stack = '';
  try { RealError.stackTraceLimit = limit; stack = String(new RealError().stack ?? ''); } finally { RealError.stackTraceLimit = saved; }
  const out = [];
  for (const line of stack.split('\n').slice(1)) {
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
// callback), or that ran at module load. What it does is no step of any input, so the case it happens in
// is flagged `outside-chain`. Two detectors:
// - a call of a family's port (a module port, or a member of a port object of particular families) with
//   no engine chain running is always flagged, whoever makes it: the stack cannot tell the test from
//   engine code, because JavaScriptCore's proper tail calls drop the frame of `() => port(...)`;
// - any other effect with no engine chain running (a timer, a clock read, a draw, a global port's call or
//   read) is flagged when a frame of a family's module is on the stack. That one is best effort: a tail
//   call or code in a module the family imports leaves no frame of the family's own module.
const FAMILY_FILES = portMap ? new RealSet(portMap.families.map((family) => family.module)) : null;
const STACK_DEPTH = 200;
/** Whether code of a family's module is on the stack. */
function familyOnStack() {
  for (const [file] of frames(STACK_DEPTH)) if (apply(SetHas, FAMILY_FILES, [file])) return true;
  return false;
}
/** With no engine chain running: flags the current case when family code is running anyway. */
function checkOutside() {
  if (FAMILY_FILES && guard('outside', () => familyOnStack(), false)) current.flags.add('outside-chain');
}
/** A family's port used with no engine chain running. */
const flagOutside = () => { current.flags.add('outside-chain'); };

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

let nominalBeforeOverride = null; // the nominal time when a test first set the system time
let overrideSetAt = 0;
let fakePerformance = null; // { real, nominal } when fake timers started
const fakeTimersOn = () => { try { return isFakeTimers() === true; } catch { return false; } };
function advance(due) { if (due > virtualNow) { virtualPerformance += due - virtualNow; virtualNow = due; } }
/** The time an input or a clock read sees: the nominal clock, or under fake timers the fake clock (started at it). */
const readNow = () => (fakeTimersOn() ? apply(RealDateNow, RealDate, []) : virtualNow);
function readPerformanceNow() {
  if (fakeTimersOn() && fakePerformance) return fakePerformance.nominal + (apply(RealPerformanceNow, realPerformance, []) - fakePerformance.real);
  return virtualPerformance;
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
      if (time === undefined || time === null) {
        if (nominalBeforeOverride !== null) { virtualNow = nominalBeforeOverride + Math.max(0, virtualNow - overrideSetAt); nominalBeforeOverride = null; }
        return;
      }
      const value = apply(DateGetTime, new RealDate(time), []);
      if (value !== value) return;
      if (nominalBeforeOverride === null) nominalBeforeOverride = virtualNow;
      overrideSetAt = value;
      virtualNow = value;
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
      if (!(options && typeof options === 'object' && hasOwn(options, 'now'))) apply(realSetSystemTime, bunTest, [virtualNow]);
      fakePerformance = { real: apply(RealPerformanceNow, realPerformance, []), nominal: virtualPerformance, date: apply(RealDateNow, RealDate, []) };
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
    if (reached !== null) guard('useRealTimers', () => { if (reached.date > virtualNow) virtualNow = reached.date; if (reached.performance > virtualPerformance) virtualPerformance = reached.performance; fakePerformance = null; });
    return result;
  } }.useRealTimers;
  apply(WeakMapSet, rawOf, [wrapper, real]);
  return wrapper;
}

// ------------------------------------------------------------------ the timers

const timerIds = new RealWeakMap(); // object handle -> { id, case, family }
const primitiveTimerIds = new RealMap(); // number handle (a trap's answer) -> the same, or { ambiguous }
const timerWrappers = { setTimeout: new RealWeakMap(), setInterval: new RealWeakMap(), clearTimeout: new RealWeakMap(), clearInterval: new RealWeakMap() };

function setTimerWrapper(kind, underlying) {
  const cache = timerWrappers[kind];
  if (apply(WeakMapHas, cache, [underlying])) return apply(WeakMapGet, cache, [underlying]);
  const repeat = kind === 'setInterval';
  const native = underlying === nativeTimers[kind];
  const wrapper = { [kind](callback, delay, ...rest) {
    const store = storeNow();
    const origin = originOf(store);
    if (origin === 'harness') return apply(underlying, native ? globalThis : this, [callback, delay, ...rest]);
    const counted = origin !== 'port';
    const engine = origin === 'engine';
    // Engine timers are numbered 1, 2, ... per family; the test's own are t1, t2, ... so they never shift the engine's.
    const id = !counted ? null : engine ? (familyRecord(store.family, store.case).timers += 1) : `t${(current.testTimers += 1)}`;
    const owner = engine ? store.case : current;
    const setAt = virtualNow;
    const span = typeof delay === 'number' && delay > 0 ? delay : 0;
    let fires = 0;
    const fire = typeof callback === 'function' ? function (...args) {
      fires += 1;
      if (layers.has('clock')) advance(setAt + span * fires);
      const opener = storeNow();
      // An engine timer's firing is an input of the case that set it, even after that test ended (marked late).
      const step = counted && engine ? guard('timer.fire', () => openStep(store.family, { kind: 'timer', id }, opener, store.case), null) : null;
      if (!step) {
        if (counted && !engine) guard('timer.fire', () => current.context.push({ kind: 'timer.fire', id, origin: owner === current ? 'test' : `test:${owner.label}` }));
        return runIn(store, () => apply(callback, this, args));
      }
      // The chain that set the timer moves to its firing (an await on it resumes there), except for a re-entrant firing.
      const nested = reentrant(opener);
      const previous = store.step;
      store.step = step;
      try { return als.run(engineStore(store.family, step, store.case), () => apply(callback, this, args)); } finally { if (nested) store.step = previous; }
    } : callback;
    if (counted) guard('timer.set', () => record({ kind: 'timer.set', id, delay: ref(delay), repeat }, store));
    const handle = inPort(engine ? store : null, () => apply(underlying, native ? globalThis : this, [fire, delay, ...rest]));
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
    if (origin !== 'harness' && origin !== 'port' && handle !== undefined && handle !== null) {
      guard('timer.clear', () => {
        const object = typeof handle === 'object' || typeof handle === 'function';
        const known = object ? apply(WeakMapGet, timerIds, [handle]) : apply(MapGet, primitiveTimerIds, [handle]);
        if (!object) apply(MapDelete, primitiveTimerIds, [handle]);
        let effect;
        if (!known) effect = { kind: 'timer.clear', id: null };
        else if (known.ambiguous) effect = { kind: 'timer.clear', id: null, ambiguous: true };
        else if (known.case !== caseOf(origin === 'engine' ? store : null)) effect = { kind: 'timer.clear', id: known.id, fromCase: known.case.label };
        else if (origin === 'engine' && known.family !== store.family) effect = { kind: 'timer.clear', id: known.id, family: known.family };
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
      const kase = caseOf(store);
      guard('callback', () => { for (const arg of args) markForeign(arg); });
      const step = guard('callback', () => openStep(family, { kind: 'callback', port: name, args: ref(listOf(args), kase) }, store, kase), null);
      if (!step) return apply(target, thisArg, args);
      // An asynchronous invocation moves the chain that handed the callback out (a promise it resolves resumes there).
      if (!reentrant(store) && owner && owner.case === kase) owner.step = step;
      const chain = engineStore(family, step, kase);
      let result;
      try {
        result = als.run(chain, () => apply(target, thisArg, args));
      } catch (error) {
        guard('callback', () => { step.throws = ref(error); });
        throw error;
      }
      guard('callback', () => { step.returns = ref(result); if (isPromise(result)) observeSettle(result, (outcome, value) => settledOutput(chain, step, outcome, value)); });
      return result;
    },
  });
  apply(WeakMapSet, callbackWrappers, [fn, wrapper]);
  apply(WeakMapSet, rawOf, [wrapper, fn]);
  return wrapper;
}

/** An output: a promise the engine returned settled. It belongs to the step the returning chain is in when it settles. */
function settledOutput(chain, step, outcome, value) {
  place(stepOf(chain), chain.case, { kind: 'settled', step: step.n, outcome, value: ref(value, chain.case) });
}

/** A port answer settled: a step of the calling chain's family (in the chain's case), and the chain moves to it. */
function settleStep(chain, name, call, outcome, value) {
  markForeign(value);
  const step = openStep(chain.family, { kind: 'settle', port: name, call, outcome, value: ref(value, chain.case) }, null, chain.case);
  if (step) chain.step = step;
}

const portFunctions = new RealWeakMap(); // target -> Map(name -> wrapper)
/**
 * A port function: calls are effects, a sync answer is part of the effect,
 * a promise answer opens a step when it settles, and functions the engine
 * passes are wrapped as callbacks. `thisArg` binds a method to its owner.
 * `families` limits whose port it is: other families inline it.
 */
function portFunction(name, target, { thisArg, wrapAnswers = false, families = null } = {}) {
  let byName = apply(WeakMapGet, portFunctions, [target]);
  if (!byName) { byName = new RealMap(); apply(WeakMapSet, portFunctions, [target, byName]); }
  const cacheKey = thisArg === undefined ? name : null;
  if (cacheKey && apply(MapHas, byName, [cacheKey])) return apply(MapGet, byName, [cacheKey]);
  const call = (fnTarget, receiver, args, newTarget) => {
    const store = storeNow();
    const origin = originOf(store);
    const isNew = newTarget !== undefined;
    const invoke = (finalArgs) => (isNew ? construct(fnTarget, finalArgs) : apply(fnTarget, thisArg === undefined ? receiver : thisArg, finalArgs));
    if (origin === 'port' || origin === 'harness') return invoke(args);
    if (origin === 'engine' && families && !apply(SetHas, families, [store.family])) return invoke(args); // inlined for this family
    const engine = origin === 'engine';
    if (!engine && families) flagOutside();
    // Engine calls are numbered 1, 2, ... per family; the test's own t1, t2, ... so they never shift the engine's.
    const effect = guard('port', () => ({ kind: isNew ? 'new' : 'port', port: name, call: engine ? (familyRecord(store.family, store.case).portCalls += 1) : `t${(current.testCalls += 1)}`, args: ref(listOf(args)) }), null);
    if (effect) guard('port', () => record(effect, store));
    const finalArgs = engine ? args.map((arg, index) => (typeof arg === 'function' ? callbackFor(store.family, `${name}:${index}`, arg, store) : arg)) : args;
    let result;
    try {
      result = inPort(engine ? store : null, () => invoke(finalArgs));
    } catch (error) {
      if (effect) guard('port', () => { effect.throws = ref(error); });
      throw error;
    }
    if (!effect) return result;
    guard('port', () => { effect.answer = ref(result); });
    if (!engine) return result;
    guard('port', () => markForeign(result));
    const family = store.family;
    if (isPromise(result)) {
      guard('port', () => observeSettle(result, (outcome, value) => settleStep(store, name, effect.call, outcome, value)));
      if (wrapAnswers) return apply(PromiseThen, result, [(value) => (answerLike(value) ? portObject(`${name}#${effect.call}`, value, { wrapAnswers }) : value)]);
      return result;
    }
    if (isNew || portLike(result) || (wrapAnswers && answerLike(result))) return portObject(`${name}#${effect.call}`, result, { wrapAnswers });
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
      if (typeof value === 'function' && key !== 'prototype' && key !== 'constructor' && substitutable(fnTarget, key)) return portFunction(`${name}.${String(key)}`, value, { thisArg: fnTarget, families, wrapAnswers });
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
function portObject(name, target, { families = null, wrapAnswers = false } = {}) {
  if (apply(WeakMapHas, portObjects, [target])) return apply(WeakMapGet, portObjects, [target]);
  const methods = new RealMap();
  const proxy = new RealProxy(target, {
    get(object, key) {
      const value = reflectGet(object, key);
      if (!substitutable(object, key)) return value;
      if (typeof value === 'function') {
        let byValue = apply(MapGet, methods, [key]);
        if (!byValue || byValue.value !== value) { byValue = { value, wrapper: portFunction(`${name}.${String(key)}`, value, { thisArg: object, families, wrapAnswers }) }; apply(MapSet, methods, [key, byValue]); }
        return byValue.wrapper;
      }
      const answer = typeof key === 'string' && (portLike(value) || (wrapAnswers && answerLike(value))) ? portObject(`${name}.${key}`, value, { families, wrapAnswers }) : value;
      if (typeof key === 'string' && !apply(SetHas, IMPLICIT_READS, [key])) {
        const store = storeNow();
        const origin = originOf(store);
        if (origin === 'engine' && (!families || apply(SetHas, families, [store.family]))) guard('port.read', () => record({ kind: 'read', port: name, key: ref(key), value: ref(answer) }, store));
        else if (origin === 'test') { if (families) flagOutside(); else checkOutside(); }
      }
      return answer;
    },
    set(object, key, value) {
      const store = storeNow();
      let stored = value;
      if (originOf(store) === 'test') { if (families) flagOutside(); else checkOutside(); }
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
  let portEffect = null;
  if (origin === 'engine') {
    if (store.family === family || !crossing || !apply(SetHas, crossing.families, [store.family])) return invoke(args); // inlined
    portEffect = guard('entry', () => ({ kind: 'port', port: crossing.name, call: (familyRecord(store.family, store.case).portCalls += 1), args: ref(listOf(args)) }), null);
    if (portEffect) guard('entry', () => record(portEffect, store));
  }
  // A call from a chain of an earlier case (a late crossing) is that case's input.
  const kase = caseOf(portEffect ? store : null);
  // What the test hands in is the test's, never engine code to hand back out wrapped.
  if (!portEffect) guard('entry', () => { for (const arg of args) markForeign(arg); });
  const input = { kind: spec.input ?? (newTarget !== undefined ? 'new' : 'call'), entry: label, args: ref(listOf(args), kase) };
  if (portEffect) input.caller = store.family;
  const step = guard('entry', () => openStep(family, input, portEffect ? null : store, kase), null);
  if (!step) return invoke(args);
  const draft = spec.draft;
  const before = draft !== undefined ? guard('entry', () => identityPaths(args[draft]), null) : null;
  const finalArgs = guard('entry', () => injectPorts(family, spec, args), args);
  const chain = engineStore(family, step, kase);
  const finish = (fields) => guard('entry', () => {
    Object.assign(step, fields);
    step.after = ref(listOf(args), kase);
    if (before) step.changes = ref(changedPaths(before, args[draft]), kase);
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
  return handOut(family, label, result, kase, whole);
}

function injectPorts(family, spec, args) {
  const injected = spec.injected;
  if (!injected?.length) return args;
  const out = [...args];
  for (const item of injected) {
    const arg = out[item.arg];
    if (arg === null || (typeof arg !== 'object' && typeof arg !== 'function')) continue;
    const options = { wrapAnswers: item.wrapAnswers === true };
    if (item.key === undefined) { out[item.arg] = typeof arg === 'function' ? portFunction(item.name, arg, options) : portObject(item.name, arg, options); continue; }
    const inner = guard('inject', () => { const descriptor = getOwnPropertyDescriptor(arg, item.key); return descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined; });
    if (inner === null || (typeof inner !== 'object' && typeof inner !== 'function')) continue;
    const wrappedInner = typeof inner === 'function' ? portFunction(item.name, inner, options) : portObject(item.name, inner, options);
    const proxy = new RealProxy(arg, { get: (object, key) => (key === item.key && substitutable(object, key) ? wrappedInner : reflectGet(object, key)) });
    apply(WeakMapSet, rawOf, [proxy, arg]);
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
function engineWrapper(family, name, target, owner, parent) {
  const members = new RealMap(); // key -> { value, wrapper }
  let proxy = null;
  const handler = { get: (object, key) => memberOf(family, name, object, proxy, key, owner, members) };
  if (typeof target === 'function') {
    handler.apply = (fn, thisArg, args) => callEntry(family, {}, name, fn, parent && thisArg === parent.proxy ? parent.object : thisArg, args, undefined, null);
    handler.construct = (fn, args, newTarget) => (newTarget === proxy ? callEntry(family, {}, name, fn, undefined, args, fn, null) : construct(fn, args, newTarget));
  }
  proxy = new RealProxy(target, handler);
  if (!parent) apply(WeakMapSet, handedOut, [target, proxy]);
  apply(WeakMapSet, rawOf, [proxy, target]);
  return proxy;
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
    return callEntry(family, { input: 'get' }, label, descriptor.get, object, [], undefined, null);
  }
  const value = descriptor.value;
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || key === 'constructor' || (typeof object === 'function' && key === 'prototype')) return value;
  if (holder === object && !substitutable(object, key)) {
    if (originOf(storeNow()) === 'test' && guard('hand-out', () => carriesCode(value), false)) current.flags.add('unwrappable');
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

// ------------------------------------------------------- facades for the map

const loadedFamilies = new RealMap(); // family -> real module namespace
if (portMap) {
  const injectedByEntry = new RealMap();
  for (const family of portMap.families) for (const item of family.injected ?? []) {
    const key = `${family.name}:${item.entry}`;
    if (!apply(MapHas, injectedByEntry, [key])) apply(MapSet, injectedByEntry, [key, []]);
    apply(MapGet, injectedByEntry, [key]).push(item);
  }
  const api = {
    loaded(file, namespace) { for (const name of portMap.modules.get(file)?.families ?? []) apply(MapSet, loadedFamilies, [name, namespace]); },
    wrap(file, exportName, value) {
      const target = portMap.modules.get(file);
      const entry = target?.entries.get(exportName);
      const port = target?.ports.get(exportName);
      const crossing = port ? { name: port.name, families: new RealSet(port.families), wrapAnswers: port.wrapAnswers === true } : null;
      if (entry) {
        const spec = { ...entry.spec, injected: apply(MapGet, injectedByEntry, [`${entry.family}:${exportName}`]) };
        return wrapEntry(entry.family, spec, exportName, value, crossing);
      }
      if (port && typeof value === 'function') return portFunction(port.name, value, { families: crossing.families, wrapAnswers: crossing.wrapAnswers });
      if (port && portLike(value)) return portObject(port.name, value, { families: crossing.families, wrapAnswers: crossing.wrapAnswers });
      return value;
    },
  };
  defineProperty(globalThis, API, { value: api, configurable: true, enumerable: false, writable: false });
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const files = [...portMap.modules.keys()];
  const filter = new RegExp(`^(?:${files.map(escape).join('|')})(?:\\?conformance-real)?$`);
  const loaderFor = (file) => (file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts') ? 'ts' : file.endsWith('.jsx') ? 'jsx' : 'js');
  Bun.plugin({
    name: 'devryan-client-conformance',
    setup(build) {
      build.onLoad({ filter }, (args) => {
        const [file, query] = args.path.split('?');
        const source = readFileSync(file, 'utf8');
        if (query === 'conformance-real' || !portMap.modules.has(file)) return { contents: source, loader: loaderFor(file) };
        const target = portMap.modules.get(file);
        const exports = new Bun.Transpiler({ loader: loaderFor(file) }).scan(source).exports;
        const real = JSON.stringify(`${file}?conformance-real`);
        const key = JSON.stringify(file);
        const lines = [`import * as __real from ${real};`, `const __api = globalThis[Symbol.for('devryan.client-conformance')];`, `__api.loaded(${key}, __real);`, `export * from ${real};`];
        for (const name of exports) {
          const wrapped = target.entries.has(name) || target.ports.has(name);
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
  const wrapExports = (name, exports) => {
    if (exports === null || typeof exports !== 'object') return exports;
    return guard('mock.module', () => {
      const out = {};
      for (const key of ownKeys(exports)) {
        const descriptor = getOwnPropertyDescriptor(exports, key);
        if (!descriptor) continue;
        if (hasOwn(descriptor, 'value') && typeof key === 'string') {
          const value = descriptor.value;
          if (typeof value === 'function') descriptor.value = portFunction(`${name}#${key}`, value);
          else if (portLike(value)) descriptor.value = portObject(`${name}#${key}`, value);
        }
        defineProperty(out, key, descriptor);
      }
      return out;
    }, exports);
  };
  const wrappedModule = { module(specifier, factory) {
    if (typeof factory !== 'function') return apply(realModule, this, [specifier, factory]);
    const name = guard('mock.module', () => mockName(specifier), `mock:${String(specifier)}`);
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
  const accessor = {
    configurable: true, enumerable,
    get() { return wrapped; },
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
  installGlobal('fetch', (value) => (typeof value === 'function' ? portFunction('fetch', value, { wrapAnswers: answers('fetch') }) : value));
  for (const name of ['WebSocket', 'EventSource']) installGlobal(name, (value) => (typeof value === 'function' ? portFunction(name, value) : value));
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
  realModuleOf(mock)('bun:test', () => ({ ...bunTest, spyOn, setSystemTime }));
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

function snapshotStates(target) {
  if (!portMap) return;
  for (const family of portMap.families) {
    if (!family.state || !apply(MapHas, loadedFamilies, [family.name])) continue;
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
function finalizeFamily(entry, steps, end, context) {
  const parts = { entryState: entry ?? null, steps, endState: end ?? null, context };
  const pending = [];
  collectPending(parts, pending);
  const trees = emitSlots(pending.map((item) => item.taken));
  const slots = new RealMap();
  pending.forEach((item, index) => {
    const text = stringifyTree(trees[index]);
    const hash = hashText(text);
    if (!apply(MapHas, values, [hash])) apply(MapSet, values, [hash, text]);
    apply(MapSet, slots, [item, `=${hash}`]);
  });
  return resolveRecord(parts, slots);
}

function closeCase() {
  if (current.endNow !== null) return;
  current.endNow = virtualNow;
  snapshotStates(current.endState);
  // A case stays open to effects that arrive after its test ended (marked late); it is written with the file.
  closed.push(current);
}

/** The written form of a closed case: every family's line and its flags. */
function finalizeCase(record) {
  const families = {};
  apply(MapForEach, record.families, [(entry, name) => { families[name] = guard('case.write', () => finalizeFamily(record.entryState[name], entry.steps, record.endState[name], record.context), null); }]);
  const flags = [...record.codec.flags, ...record.flags].filter((flag, index, list) => list.indexOf(flag) === index).sort();
  record.out = { kind: record.kind, ...(record.kind === 'test' ? { ordinal: record.ordinal } : { hooks: record.hooks }), seed: record.seed, entryNow: record.entryNow, endNow: record.endNow, flags, families, contextRecords: record.context.length };
  return record.kind === 'test' || ownKeys(families).length > 0 || record.out.contextRecords > 0;
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
    current = newCase({ ordinal: (testsSeen += 1) });
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
    current = newCase({ hooks: testsSeen });
    if (openTests > 0) current.flags.add('concurrent');
    snapshotStates(current.entryState);
  });
  rearmGlobals();
  guard('case.close', () => checkGlobals(current));
});

/** For each family, a digest of the sources of its module and its port modules (the code a recording is of). */
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
  if (!OUT) return;
  const raw = {
    version: RAW_VERSION, recording: RECORDING_VERSION, file: TEST_FILE, bun: Bun.version, layers: [...layers], portMap: portMap?.digest ?? null, modules: MODULES, epoch: EPOCH,
    cases: kept.map((entry) => entry.out), values: Object.fromEntries(values), errors, unplaced,
  };
  mkdirSync(OUT, { recursive: true });
  // Never overwrite: two test files must never share a recording.
  writeFileSync(path.join(OUT, `${pathStem(TEST_FILE)}.raw.json`), JSON.stringify(raw), { flag: 'wx' });
});
