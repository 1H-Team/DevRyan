// Recorder of the scheduler conformance harness (design file 30, package
// O0a), a `bun test --preload`. It changes no product file: a Bun plugin
// serves the scheduler module through a facade that re-exports every export
// of the real module unchanged except the factory, which it wraps. Each
// construction gets its own trace (trace.mjs has the format), one total
// order of what crosses the scheduler's boundary:
// - the options: the scheduler gets a forwarding proxy over the test's own
//   options object, so it sees a later change by the test as it would without
//   the recorder, and every member it reads is an input (`read`); every
//   function option and every method of an object option (executor,
//   persistence, logger, autoResume, the hooks, publishEvent) is a port: its
//   arguments, its answer and the settlement of a promise answer are
//   recorded; functions the scheduler hands a port (the task control object
//   of executor calls, persistence's onProgress) are inputs when called;
// - the clock and timers: `now`, `scheduleTimeout`, `cancelTimeout`;
// - the identifier factories: `createTaskId`, `createLeaseToken`, `createWaveId`;
// - every public member the factory returns, called with arguments that the
//   recorder hands on unchanged except for functions in them (callbacks the
//   test passes: authorize, recheck, an action), which become ports;
// - every AbortSignal that crosses, in any value, numbered per construction:
//   one that reaches the scheduler aborts as an input, one the scheduler
//   hands out (to a port, or to the test) aborts as an output, each with its
//   reason, written before the signal dispatches (AbortController.prototype.abort
//   is wrapped for watched signals), so a listener's effect follows its abort;
//   the event that carried a signal names its number and its path;
// - the hidden inputs of design §3.1 point 2, served and recorded only when
//   the code that reads them is a product module of the scheduler and a
//   construction's chain is running: crypto.randomUUID (served from
//   trace.mjs servedUuid), performance.now() (served from the case's nominal
//   clock) and the environment variables of the target (read, not changed),
//   each named by a site of the target spec (target.json), never by a
//   source position. A read in product code at a line no site names is a
//   recorder error, and so is a read by product code whose own frame a proper
//   tail call removed, and a read by product code outside any construction's
//   chain (an event listener, which runs without the chain's store), in any
//   case, unless it is at a line of a product helper the spec lets tests call
//   directly (`direct`) and the code that called the helper is no product
//   module: the value is then real, and the run says so.
// Objects are handed on as they are; only functions and objects holding
// functions are wrapped, so what a test compares by identity (a task, a
// signal, an error) is the object the scheduler gave or got. A function met
// anywhere else in a recorded value, one the recorder did not wrap, flags its
// case (`unwrapped-function`; `handed-code` in what a member returns): code
// could cross there with no input recorded. Every object that crossed is
// taken again when its case ends; content that changed since flags the case
// (`mutated-after-crossing`), unless the value went out and none of its
// objects crossed again in the case: that is what the scheduler handed over
// then, and the case keeps its outcome with the note `mutated-by-receiver`.
//
// Nominal clock (DEVRYAN_SCHEDULER_CONFORMANCE_CLOCK=nominal, the default).
// Each case (a test, or the hooks between two tests) has a virtual time that
// starts at EPOCH. A scheduler built without `now` reads it, and so do
// `Date.now()` and `new Date()` anywhere in the test file, so values the test
// computes from the clock stay consistent with the scheduler's. Timers keep
// real scheduling: when a timer the recorder set for a scheduler built
// without `scheduleTimeout` fires, its case's time moves to the timer's
// virtual due time, never backward. A test that injects its own timers or
// clock drives them itself. Time never moves while a test reads the clock:
// `Date.now()` returning the same nominal time SPIN_LIMIT times in a row,
// with nothing recorded in between, throws (and is a recorder error), since a
// loop waiting for real time to pass would never end. With `real`, the
// default `now` and the hidden performance reads use the real clocks (still
// recorded) and Date is left alone.
//
// Where inputs arrived. Every input that arrives on its own is written with
// its `place` ("the rest rule" below: rest, during, group, return, with,
// settle, or busy when the recorder cannot show where it arrived), a promise
// a port returned with `settled` when it was already settled, a timer.set
// with the kind of handle scheduleTimeout returned; a replay reads these and
// nothing else to deliver an input, and compares a case only up to its first
// busy input.
//
// Cases and late effects. One test is one case; what runs outside a test is a
// hooks case numbered by the tests before it. A construction belongs to the
// case that was running when it was built, and everything it does or
// receives later stays in that case, marked late after its test ended. Cases
// are written when the file ends; an event after that is counted in a
// `<stem>.unplaced.json` beside the raw recording, and its case becomes
// unrecordable (`late-after-write`).
//
// Settings: DEVRYAN_CONFORMANCE_OUT (a raw `<stem>.raw.json` per test file;
// without it nothing is written), DEVRYAN_CONFORMANCE_BASE (recorded paths
// are relative to it; default the repository), DEVRYAN_SCHEDULER_CONFORMANCE_TARGET
// (the target spec; default target.json beside this file).
import * as bunTest from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEC_VERSION, createCodecContext, emitSlots, hashText, snapshot, stringifyTree } from '../client-conformance/codec.mjs';
import { pathStem } from '../client-conformance/container.mjs';
import { EPOCH, importClosure, loadTarget, PERFORMANCE_ORIGIN, RAW_VERSION, RECORDING_VERSION, servedUuid, SPIN_LIMIT } from './trace.mjs';

const RealProxy = Proxy;
const RealPromise = Promise;
const RealError = Error;
const RealDate = Date;
const RealMap = Map;
const RealSet = Set;
const RealWeakMap = WeakMap;
const { apply, construct: reflectConstruct, get: reflectGet, has: reflectHas, ownKeys, set: reflectSet, deleteProperty: reflectDelete, defineProperty: reflectDefine } = Reflect;
const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf, create } = Object;
const PromiseThen = Promise.prototype.then;
const isPrototypeOf = Object.prototype.isPrototypeOf;
const WeakMapGet = WeakMap.prototype.get;
const WeakMapSet = WeakMap.prototype.set;
const RealAbortSignal = AbortSignal;
const addEventListener = EventTarget.prototype.addEventListener;
const abortReason = getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get;
const abortedState = getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realDateNow = Date.now;
const realCrypto = globalThis.crypto;
const realRandomUUID = realCrypto.randomUUID;
const realPerformance = globalThis.performance;
const realPerformanceNow = realPerformance.now;
const realConsole = globalThis.console;
const realSetImmediate = globalThis.setImmediate;
const realQueueMicrotask = globalThis.queueMicrotask;
const peekStatus = Bun.peek.status;
const { afterAll, afterEach, beforeEach } = bunTest;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(process.env.DEVRYAN_CONFORMANCE_BASE || path.resolve(HERE, '../..'));
const OUT = process.env.DEVRYAN_CONFORMANCE_OUT || '';
const CLOCK = process.env.DEVRYAN_SCHEDULER_CONFORMANCE_CLOCK === 'real' ? 'real' : 'nominal';
const TARGET = loadTarget(process.env.DEVRYAN_SCHEDULER_CONFORMANCE_TARGET || path.join(HERE, 'target.json'));
const API = Symbol.for('devryan.scheduler-conformance');
const REAL_QUERY = 'scheduler-conformance-real';
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const TEST_FILE = relative(Bun.main);
const errors = [];
const lateErrors = []; // noted after the recording was written: kept in the `.unplaced.json` beside it
const noteError = (message) => {
  if (errors.includes(message) || lateErrors.includes(message)) return;
  if (!written) { errors.push(message); return; }
  lateErrors.push(message);
  writeUnplaced();
};
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// ---------------------------------------------------------------- provenance

const MODULE_FILES = importClosure(TARGET.module);
const PRODUCT_FILES = new Set(MODULE_FILES);
const MODULES = Object.fromEntries(MODULE_FILES.map((file) => [relative(file), sha(readFileSync(file))]));
const RECORDER = sha([path.join(HERE, 'recorder.mjs'), path.join(HERE, 'trace.mjs'), path.join(HERE, '../client-conformance/codec.mjs'), path.join(HERE, '../client-conformance/container.mjs')]
  .map((file) => `${path.basename(path.dirname(file))}/${path.basename(file)} ${sha(readFileSync(file))}`).join('\n'));
// The reference bytes of a saved state (design §4.4): the target's ledger encoder, when its spec names one.
const LEDGER = TARGET.savedState ? (await import(pathToFileURL(TARGET.savedState.file).href))[TARGET.savedState.export] : null;
if (TARGET.savedState && typeof LEDGER !== 'function') throw new TypeError(`scheduler-conformance target: ${TARGET.savedState.export} is not a function of ${TARGET.savedState.file}`);

// --------------------------------------------------------------- cases

const als = new AsyncLocalStorage();
let testsSeen = 0;
let openTests = 0;
let written = false;
let eventsSeen = 0;
const cases = [];
const lateCases = new Set();
let unplaced = 0;
const writeUnplaced = () => { if (OUT) writeFileSync(path.join(OUT, `${pathStem(TEST_FILE)}.unplaced.json`), JSON.stringify({ unplaced, cases: [...lateCases], errors: lateErrors })); };
const portNames = new RealWeakMap(); // a recorder proxy -> its port name (the codec writes {"$dr":"port"})
const rawOf = new RealWeakMap(); // a recorder wrapper -> what it wraps
const isWrapper = (item) => apply(WeakMapGet, rawOf, [item]) !== undefined;
const ownWrapper = (wrapper) => { apply(WeakMapSet, rawOf, [wrapper, wrapper]); return wrapper; };

function newCase(kind, number) {
  const record = { kind, ordinal: kind === 'test' ? number : null, hooks: kind === 'hooks' ? number : null, closed: false, flags: new Set(), notes: new Set(), constructions: [], clock: EPOCH, at: 0, snaps: [], crossed: [], dirs: [], sightings: new RealMap(), changed: [], checked: 0, marks: new RealMap(), codec: createCodecContext({ names: portNames, unwrap: (item) => apply(WeakMapGet, rawOf, [item]) }) };
  cases.push(record);
  return record;
}
let current = newCase('hooks', 0);
const keyOf = (record) => (record.kind === 'test' ? `test:${record.ordinal}` : `hooks:${record.hooks}`);
const ownerNow = () => als.getStore()?.inst?.case ?? current;

const isSignal = (value) => value !== null && typeof value === 'object' && apply(isPrototypeOf, RealAbortSignal.prototype, [value]);

/**
 * A slot: the value's content now, kept open for identity across the case
 * (emitted when the case is written). `dir` says which way the value
 * crosses ('in' reaches the scheduler, 'out' leaves it): every AbortSignal
 * in it is watched (first sight decides who aborts it), and a function the
 * recorder did not wrap flags the case (`flag`).
 */
function slot(inst, value, dir, flag = 'unwrapped-function') {
  const record = inst.case;
  let snap;
  try {
    snap = snapshot(value, record.codec);
  } catch (error) {
    noteError(`encode: ${error?.message ?? error}`);
    snap = snapshot({ unencodable: String(error?.message ?? error) }, record.codec);
  }
  record.snaps.push(snap);
  record.crossed.push(value !== null && (typeof value === 'object' || typeof value === 'function') ? value : null);
  record.dirs.push(dir);
  const ref = { slot: record.snaps.length - 1 };
  let signals = null;
  for (const item of snap.nodes.keys()) {
    if (isWrapper(item)) continue;
    // In how many of the case's slots each object crossed: an out value whose objects cross again is not the receiver's alone.
    if (typeof item === 'object') record.sightings.set(item, (record.sightings.get(item) ?? 0) + 1);
    if (typeof item === 'function') { record.flags.add(flag); mark(record, ref.slot, 'unwrapped'); continue; }
    if (isSignal(item)) { (signals ??= []).push(item); continue; }
    if (dir === 'in' && isPromise(item)) freshPromises.push(item);
    const prototype = getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item) && holdsFunctions(item)) { record.flags.add(flag); mark(record, ref.slot, 'unwrapped'); }
  }
  if (signals && dir) ref.signals = signals.map((signal) => ({ signal: watch(inst, signal, dir), at: pathTo(value, signal) }));
  return ref;
}

/** Marks a slot: the event that holds it lists the field under `mark` when the case is written (`unwrapped`, `mutated`). */
const mark = (record, index, name) => { if (!record.marks.has(index)) record.marks.set(index, new RealSet()); record.marks.get(index).add(name); };

/** The member path from `value` to `target` (own enumerable data members, array items, at any depth), or null. */
function pathTo(value, target) {
  const seen = new RealSet();
  const walk = (item, trail) => {
    if (item === target) return trail;
    if (item === null || typeof item !== 'object' || seen.has(item) || isWrapper(item) || isSignal(item)) return null;
    seen.add(item);
    for (const key of ownKeys(item)) {
      if (typeof key !== 'string') continue;
      const descriptor = getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) continue;
      const found = walk(descriptor.value, [...trail, Array.isArray(item) && /^\d+$/.test(key) ? Number(key) : key]);
      if (found) return found;
    }
    return null;
  };
  return walk(value, []);
}

function event(inst, dir, kind, fields) {
  const record = inst.case;
  eventsSeen += 1;
  if (kind !== 'step') record.lastActivity = (activity += 1);
  scheduleProbe();
  if (written) {
    unplaced += 1;
    lateCases.add(keyOf(record));
    writeUnplaced();
    return null;
  }
  const entry = { seq: (inst.seq += 1), at: (record.at += 1), dir, kind };
  let signals;
  for (const key of Object.keys(fields)) {
    const item = fields[key];
    if (item && typeof item === 'object' && typeof item.slot === 'number' && item.signals) { signals = [...(signals ?? []), ...item.signals.map((entry) => ({ ...entry, in: key }))]; entry[key] = { slot: item.slot }; } else entry[key] = item;
  }
  if (signals) entry.signals = signals;
  if (record.closed) entry.late = true;
  inst.events.push(entry);
  return entry;
}
const ARRIVED = new Set(['call', 'control', 'callback', 'fire', 'abort', 'step']);
/**
 * An input. One that arrived on its own (a call, control, callback, fire,
 * abort, a step marker; an answer's settlement through `settledAnswer`) is
 * written with its `place` (see "the rest rule" below), decided now, before
 * the input's event is counted: what the recorder can show about where it
 * arrived. `except` is the promise whose settlement this input is.
 */
const input = (inst, kind, fields, except = null) => {
  const during = inst.portStack.length ? inst.portStack[inst.portStack.length - 1] : undefined;
  const placed = ARRIVED.has(kind) || except !== null ? placeOf(inst, kind, fields, during, except) : null;
  // Promises in this input's values are watched from now on, with the state they have now.
  for (const promise of freshPromises.splice(0)) if (!watchedIn.has(promise)) { watchedIn.set(promise, inst.case); restPoint.statuses.set(promise, peekStatus(promise)); }
  return event(inst, 'in', kind, { ...fields, ...(during === undefined ? {} : { during }), ...placed });
};
const freshPromises = []; // promises met in values that went in, since the last input event
const output = (inst, kind, fields) => event(inst, 'out', kind, fields);

// --------------------------------------------------------------- the rest rule
//
// Where an arrived input reached the scheduler, as the recorder can show it
// (the replayer delivers each input where its mark says, and compares a case
// only up to its first input marked `busy`). Every arrived input gets one
// `place`, the first of these that holds:
// - `during`: a port call of its construction was on the stack (the test's port
//   code called it synchronously): the position is the port call's. A port
//   answer's settlement written then is `busy` instead: it was written by a
//   reaction, so microtasks ran inside the port.
// - `group`: the scripted driver listed it in the latest step marker's group
//   (driver.mjs delivers a group in one macrotask, at quiescence it confirmed).
// - `return`: the settlement of a promise a port returned already settled
//   (`settled` on its `answer promise`; Bun.peek.status, which runs no job): the
//   recorder's reaction, registered first, was queued when the port returned.
// - `with` with `after: <call>`: it arrived in the same synchronous run as call
//   `<call>`'s return (or throw), with nothing written between. Shown by: the
//   event just written was that call's `return` or `throw`; the microtask the
//   recorder queued at that return has not run yet; and the caller's async
//   context holds the stamp the recorder entered (AsyncLocalStorage
//   `enterWith`, a new object per call) right where it queued that microtask.
//   A job other than the one that made the return could hold that stamp only
//   if its context was captured after the stamp was entered, and every such
//   job is queued after that microtask, so it runs after it.
// - `settle` with `after: <call>`: it arrived in a reaction job that the
//   settlement of call `<call>` queued, and nothing was written since that
//   settlement. The caller never holds the scheduler's promise: it holds one
//   the recorder made at the return, settled only by the recorder's reaction to
//   the scheduler's (registered first, at the return), which writes the
//   `settle` event, queues an opener microtask, settles the caller's promise
//   (queuing exactly the reactions registered on it so far) and queues a
//   closer microtask (`settledWindow`). The microtask queue runs in order, so
//   the jobs between opener and closer are exactly those reactions: a job the
//   test queued before (a chain of awaits that runs alongside, however long) is
//   ahead of the opener, one queued later (an await after the continuation, a
//   `.then` of a `.then`, the continuation of a function that awaited the
//   call) is behind the closer. Shown by: the window of that call is open, the
//   input is of its case, and no event was written since its `settle`.
// - `rest`: the scheduler had come to rest. A rest point is a moment at which
//   the microtask queue is empty: a `setImmediate` callback the recorder queues
//   after any event, and the entry of a timer callback of a real timer the
//   recorder set or the test set (Bun runs the microtask queue to the end between any two timer or
//   immediate callbacks). At a rest point every job the scheduler could run has
//   run: what makes it run again is an input. The input is at rest when its
//   case wrote no event since the latest rest point (step markers left out)
//   and no promise its schedulers may await silently changed state since: every
//   promise a port of the case returned pending whose settlement is not
//   recorded yet, and every promise met in a value that went in in the case,
//   has the state it had at that rest point (`except`, the promise this input
//   is the settlement of, aside). Per case, because the schedulers of other
//   cases share nothing with it (the scheduler's modules hold no mutable
//   state; a test's own shared objects reach it only through recorded inputs
//   and through promises, which are watched); a replay has only its case.
//   The entry of a real timer callback of the test's own is a rest point as
//   well: without it, whether the recorder's probe ran before such a timer,
//   or a real timer of the scheduler's fired just before it in the same timer
//   phase, would decide between `rest` and `busy`, and a mark must not depend
//   on load. Each of these is a rest point only when the event loop itself
//   entered the callback (no frame below it) and, for a timer, the test
//   runner's fake timers are off: a fake clock calls timer callbacks from
//   the test's own code with microtasks still queued (`enteredFromEventLoop`).
//   Both kinds rest on the scheduler queuing no macrotask of its own (no
//   timer, immediate, sleep or message outside its options): a case in
//   which product code queues one gives no `rest` mark from then on
//   (`ownMacrotask`, note `own-macrotask`).
// - `busy`: nothing above shows it; the scheduler may have had work queued when
//   it arrived. Doubt is `busy`, never the reverse.
let activity = 0; // events written, step markers left out (a case's `lastActivity` is this count at its latest event)
const restPoint = { activity: 0, statuses: new RealMap() };
const outstanding = new RealMap(); // a promise a port returned pending, settlement not recorded yet -> its case
const watchedIn = new RealMap(); // a promise met in a value that went in -> its case
let probePending = false;
/** `wrapper` with every own property of `real` (its name and length, util.promisify's custom function: the same values). */
function sameShape(real, wrapper) {
  for (const key of ownKeys(real)) {
    if (key === 'prototype') continue;
    try { defineProperty(wrapper, key, getOwnPropertyDescriptor(real, key)); } catch { /* a property the wrapper cannot take: kept as it is */ }
  }
  return wrapper;
}
// Whether the test runner's fake timers are installed: bun:test's switches (`jest` and `vi`) are wrapped, and the
// runner's own answer counts too, for a switch the recorder did not see. While they are, a timer callback runs when
// whatever advances the fake clock calls it, synchronously, with microtasks still queued, so no timer entry is a
// rest point (O0c review 3, B1).
const fakeTimers = { installed: false };
const runnerIsFake = typeof bunTest.jest?.isFakeTimers === 'function' ? bunTest.jest.isFakeTimers : null;
const fakeTimersOn = () => fakeTimers.installed || (runnerIsFake !== null && apply(runnerIsFake, bunTest.jest, []) === true);
for (const holder of [bunTest.jest, bunTest.vi]) {
  if (!holder || typeof holder !== 'object') continue;
  for (const name of ['useFakeTimers', 'useRealTimers']) {
    const real = holder[name];
    if (typeof real !== 'function') continue;
    holder[name] = sameShape(real, function (...args) {
      const result = apply(real, this, args);
      fakeTimers.installed = name === 'useFakeTimers';
      if (fakeTimers.installed) ownerNow().notes.add('fake-timers');
      return result;
    });
  }
}
/**
 * Whether the callback that called this was entered from the event loop: no frame below it. Anything that calls a
 * timer callback synchronously (a fake clock's advance, a test calling a Timeout's `_onTimeout`) is a frame below
 * it; only from the event loop is the microtask queue known to be empty at the entry. A timer entry (`timer`) also
 * needs the runner's fake timers off. Doubt (a stack the recorder cannot read) is no rest point.
 */
function enteredFromEventLoop(timer) {
  if (timer && fakeTimersOn()) {
    ownerNow().notes.add('fake-timers');
    return false;
  }
  const limit = RealError.stackTraceLimit;
  const prepare = RealError.prepareStackTrace;
  RealError.stackTraceLimit = 3;
  if (prepare !== undefined) RealError.prepareStackTrace = undefined;
  let stack;
  try { stack = new RealError().stack; } finally {
    RealError.stackTraceLimit = limit;
    if (prepare !== undefined) RealError.prepareStackTrace = prepare;
  }
  // This function's frame and the callback's, nothing below.
  return typeof stack === 'string' && stack.split('\n').filter((line) => line.trim().startsWith('at ')).length === 2;
}
/**
 * A macrotask queued by the scheduler's own code: a frame of its module closure called a timer, setImmediate,
 * Bun.sleep or a MessagePort's postMessage directly, not through an option. Its callback could run the scheduler
 * after a rest point with no input recorded, so the case gives no `rest` mark from then on (`own-macrotask`, a note;
 * O0c review 3, S4). The frame that called is found as for a hidden read: the first one below the recorder's own,
 * or, when product code called it in tail position, the recorder line that called that code.
 */
function ownMacrotask(route) {
  const frames = stackFrames();
  let at = 0;
  for (; at < frames.length && RECORDER_FILES.has(frames[at].file); at += 1) {
    if (CALLS_TEST.has(frames[at].line)) return;
    if (CALLS_PRODUCT.has(frames[at].line)) break;
  }
  if (at >= frames.length || (!RECORDER_FILES.has(frames[at].file) && !PRODUCT_FILES.has(frames[at].file))) return;
  const record = als.getStore()?.inst?.case ?? current;
  record.ownMacrotask = route;
  record.notes.add('own-macrotask');
}
// A real timer of the test's own (setTimeout, setInterval) is a rest point at its callback's entry too, as the
// recorder's own timers are: whether the recorder's probe ran before it, or a real timer of the scheduler's fired
// just before it in the same timer phase, is the wall clock's choice, and a mark must not depend on it. Only an
// entry from the event loop, with fake timers off, is one.
for (const name of ['setTimeout', 'setInterval']) {
  const real = globalThis[name];
  globalThis[name] = sameShape(real, function (handler, ...rest) {
    ownMacrotask(name);
    if (typeof handler !== 'function') return apply(real, this, [handler, ...rest]);
    return apply(real, this, [function (...args) { if (enteredFromEventLoop(true)) markRest(); return apply(handler, this, args); }, ...rest]);
  });
}
// The other ways to queue a macrotask, watched for the scheduler's own calls (queueMicrotask and process.nextTick
// queue jobs Bun runs to the end before any timer or immediate callback: no rest point is passed while one waits).
globalThis.setImmediate = sameShape(realSetImmediate, function (...args) { ownMacrotask('setImmediate'); return apply(realSetImmediate, this, args); });
const realSleep = Bun.sleep;
Bun.sleep = sameShape(realSleep, function (...args) { ownMacrotask('Bun.sleep'); return apply(realSleep, this, args); });
if (typeof MessagePort === 'function') {
  const realPostMessage = MessagePort.prototype.postMessage;
  defineProperty(MessagePort.prototype, 'postMessage', { ...getOwnPropertyDescriptor(MessagePort.prototype, 'postMessage'), value: sameShape(realPostMessage, function (...args) { ownMacrotask('postMessage'); return apply(realPostMessage, this, args); }) });
}
function markRest() {
  restPoint.activity = activity;
  restPoint.statuses = new RealMap();
  for (const promise of outstanding.keys()) restPoint.statuses.set(promise, peekStatus(promise));
  // A settled promise never changes again: it is no longer watched.
  for (const promise of [...watchedIn.keys()]) { const status = peekStatus(promise); if (status === 'pending') restPoint.statuses.set(promise, status); else watchedIn.delete(promise); }
}
function scheduleProbe() {
  if (probePending || written) return;
  probePending = true;
  apply(realSetImmediate, globalThis, [() => { probePending = false; if (enteredFromEventLoop(false)) markRest(); }]);
}
const unchangedSinceRest = (record, except) => {
  for (const watched of [outstanding, watchedIn]) {
    for (const [promise, owner] of watched) if (owner === record && promise !== except && restPoint.statuses.get(promise) !== peekStatus(promise)) return false;
  }
  return true;
};
// The caller's flow: a stamp per call of a member (or handed function, timer, construction), entered on its return.
const callerAls = new AsyncLocalStorage();
let lastSettle = null; // { case, call, activity } of a settlement whose window is open (between its opener and closer microtasks)
let lastReturn = null; // { activity, stamp } of the return just made, until the microtask queued then runs
const stepItems = new RealWeakMap(); // a step marker's input item -> matched
function groupMatch(inst, kind, fields) {
  const marker = inst.case.stepMarker;
  if (!marker || kind === 'step') return false;
  const item = marker.inputs.find((entry) => !apply(WeakMapGet, stepItems, [entry]) && entry.construction === inst.n && entry.kind === kind
    && (kind === 'answer' ? entry.port === fields.port && entry.outcome === fields.outcome : kind === 'abort' ? entry.signal === fields.signal : entry.call === fields.call));
  if (!item) return false;
  apply(WeakMapSet, stepItems, [item, true]);
  return true;
}
function placeOf(inst, kind, fields, during, except) {
  // A settlement is written by a reaction: one written while a port call is on the stack ran in microtasks the test's
  // code ran inside the port (Bun's expect().rejects does), a position no replay can give it.
  if (during !== undefined) return { place: except !== null ? 'busy' : 'during' };
  if (groupMatch(inst, kind, fields)) return { place: 'group' };
  if (except !== null && apply(WeakMapGet, settledAtReturn, [except])) return { place: 'return' };
  const flow = callerAls.getStore();
  if (lastReturn && lastReturn.activity === activity && flow === lastReturn.stamp) return { place: 'with', after: lastReturn.stamp.call };
  if (lastSettle && lastSettle.activity === activity && lastSettle.case === inst.case) return { place: 'settle', after: lastSettle.call };
  if (!inst.case.ownMacrotask && (inst.case.lastActivity ?? 0) <= restPoint.activity && unchangedSinceRest(inst.case, except)) return { place: 'rest' };
  return { place: 'busy' };
}
const settledAtReturn = new RealWeakMap(); // a promise a port returned -> its state then, when already settled
/** The settlement of a promise a port returned, as an input placed by the rest rule. */
function settledAnswer(inst, port, promise, outcome, value) {
  const entry = input(inst, 'answer', { port, outcome, value }, promise);
  outstanding.delete(promise);
  return entry;
}
/**
 * Right after a member's (or handed function's) settle event, in the recorder's reaction to the scheduler's promise:
 * queues the microtask that opens the window, settles the promise the caller holds (which queues every reaction
 * registered on it, and nothing else), and queues the microtask that closes the window. The jobs that run while it
 * is open are exactly those reactions: every job queued before this reaction ran precedes the opener, every job
 * queued after it follows the closer.
 */
function settledWindow(inst, call, settle) {
  const mark = { case: inst.case, call, activity };
  apply(realQueueMicrotask, globalThis, [() => { lastSettle = mark; }]);
  settle();
  apply(realQueueMicrotask, globalThis, [() => { if (lastSettle === mark) lastSettle = null; }]);
}
/** Right after a call returned (or threw) to its caller: a stamp for the caller's flow, and a microtask that ends the synchronous run's window. */
function noteReturn(inst, call) {
  const stamp = { inst, call };
  callerAls.enterWith(stamp);
  const mark = { activity, stamp };
  lastReturn = mark;
  apply(realQueueMicrotask, globalThis, [() => { if (lastReturn === mark) lastReturn = null; }]);
}

/**
 * An AbortSignal's number in its construction; on first sight it is watched:
 * its abort is an input when it reached the scheduler, an output when the
 * scheduler handed it out. The event is written before the signal
 * dispatches when a controller aborts it (the wrapped abort below), so a
 * listener the scheduler put on its own signal before handing it out acts
 * after the abort that caused it; a signal no controller aborts
 * (AbortSignal.timeout, AbortSignal.any) is written by the listener.
 */
function watch(inst, signal, dir) {
  let number = inst.signals.get(signal);
  if (number !== undefined) return number;
  number = inst.signals.size + 1;
  inst.signals.set(signal, number);
  if (!apply(abortedState, signal, [])) {
    let done = false;
    const write = (reason) => {
      if (done) return;
      done = true;
      if (dir === 'in') input(inst, 'abort', { signal: number, reason: slot(inst, reason, 'in') });
      else output(inst, 'abort', { signal: number, reason: slot(inst, reason, 'out') });
    };
    const list = apply(WeakMapGet, abortWriters, [signal]);
    if (list) list.push(write); else apply(WeakMapSet, abortWriters, [signal, [write]]);
    apply(addEventListener, signal, ['abort', () => { write(apply(abortReason, signal, [])); }, { once: true }]);
  }
  return number;
}
// AbortController.prototype.abort, wrapped: for a watched signal its abort events are written first, with the reason the
// signal will carry (the platform's AbortError, made the way the platform makes it, when none is given), then it dispatches.
const abortWriters = new RealWeakMap(); // a watched signal -> the writers of its abort events
const realAbort = AbortController.prototype.abort;
const controllerSignal = getOwnPropertyDescriptor(AbortController.prototype, 'signal').get;
const RealDOMException = DOMException;
const defaultAbort = (() => { const probe = new AbortController(); apply(realAbort, probe, []); const reason = apply(abortReason, apply(controllerSignal, probe, []), []); return { message: reason.message, name: reason.name }; })();
defineProperty(AbortController.prototype, 'abort', {
  configurable: true, writable: true, enumerable: true,
  value: function abort(...args) {
    let signal;
    try { signal = apply(controllerSignal, this, []); } catch { return apply(realAbort, this, args); }
    const writers = apply(WeakMapGet, abortWriters, [signal]);
    if (!writers || apply(abortedState, signal, [])) return apply(realAbort, this, args);
    const reason = args[0] === undefined ? new RealDOMException(defaultAbort.message, defaultAbort.name) : args[0];
    for (const write of writers) write(reason);
    return apply(realAbort, this, [reason]);
  },
});

const isPromise = (value) => value !== null && typeof value === 'object' && apply(isPrototypeOf, RealPromise.prototype, [value]);
/** A reaction registered before anyone else's, so the settlement is recorded before the code that awaited it runs. */
const observe = (promise, onValue, onError) => { apply(PromiseThen, promise, [onValue, onError]); };

// --------------------------------------------------------------- wrappers

// Platform objects keep their identity and brand: never wrapped, whatever methods their prototype has.
const BUILTIN_PROTOTYPES = new Set([Array, Map, Set, WeakMap, WeakSet, Date, RegExp, Error, Promise, ArrayBuffer, DataView, EventTarget, URL, URLSearchParams, Headers, Request, Response, Blob, TextEncoder, TextDecoder]
  .filter((constructor) => typeof constructor === 'function').map((constructor) => constructor.prototype).concat([getPrototypeOf(Int8Array.prototype)]));
const isPlainish = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !isSignal(value) && !isPromise(value);
/** Whether an object holds a function the scheduler (or the test) may call: own or inherited from a prototype of its own (a class), never a platform object nor a recorder wrapper. */
function holdsFunctions(value) {
  if (!isPlainish(value) || isWrapper(value)) return false;
  for (let object = getPrototypeOf(value), depth = 0; object && depth < 16; object = getPrototypeOf(object), depth += 1) if (BUILTIN_PROTOTYPES.has(object)) return false;
  for (let object = value, depth = 0; object && object !== Object.prototype && depth < 8; object = getPrototypeOf(object), depth += 1) {
    for (const key of ownKeys(object)) {
      const descriptor = getOwnPropertyDescriptor(object, key);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function' && key !== 'constructor') return true;
    }
  }
  return false;
}

// Lines of this file that call into product code (the scheduler) or into the test's code. A hidden read whose
// first frame below the recorder's own is one of them comes from a frame a proper tail call removed.
const MARK = '// conformance:';
const OWN_SOURCE = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
const markedLines = (tag) => new Set(OWN_SOURCE.flatMap((line, index) => (line.trimEnd().endsWith(`${MARK}${tag}`) ? [index + 1] : [])));
const CALLS_PRODUCT = markedLines('product');
const CALLS_TEST = markedLines('test');

const handedFor = new RealWeakMap(); // a promise a member (or handed function) returned -> the promise its callers get
/** Runs scheduler code for an input `call`, recording its return, throw or settlement. */
function deliver(inst, call, thunk, name = null, transform = null) {
  let result;
  inst.delivering.push(name);
  try {
    result = als.run(inst.store, thunk); // conformance:product
    if (transform) result = transform(result);
  } catch (error) {
    inst.delivering.pop();
    output(inst, 'throw', { call, error: slot(inst, error, 'out') });
    throw error;
  }
  inst.delivering.pop();
  // What a public member returns to the test: code in it is handed to the test (`handed-code`).
  const flag = typeof name === 'string' ? 'handed-code' : 'unwrapped-function';
  if (isPromise(result)) {
    output(inst, 'return', { call, promise: true });
    // The caller gets a promise of the recorder's own, settled by the recorder's reaction to the scheduler's: the
    // reactions the caller registered on it are then queued inside that reaction, between the two microtasks that
    // open and close the settlement's window (`settledWindow`, "the rest rule"). One promise of the recorder's per
    // promise of the scheduler's, so two calls the scheduler answers with one promise (a memoised shutdown) answer
    // with one promise here too; the first settlement settles it.
    let settleHanded = null;
    const known = apply(WeakMapGet, handedFor, [result]);
    const handed = known ?? new RealPromise((resolve, reject) => { settleHanded = { resolve, reject }; });
    if (!known) apply(WeakMapSet, handedFor, [result, handed]);
    observe(result, (value) => { output(inst, 'settle', { call, outcome: 'resolve', value: slot(inst, value, 'out', flag) }); settledWindow(inst, call, () => { settleHanded?.resolve(value); }); }, (error) => { output(inst, 'settle', { call, outcome: 'reject', value: slot(inst, error, 'out', flag) }); settledWindow(inst, call, () => { settleHanded?.reject(error); }); });
    return handed;
  } else {
    output(inst, 'return', { call, value: slot(inst, result, 'out', flag) });
  }
  return result;
}

/** A function the scheduler calls (an option, a method of an object option, a callback the caller passed a member). */
function portFunction(inst, name, fn, receiver = (self) => self) {
  const wrapper = function (...args) {
    const port = (inst.ports += 1);
    const handed = handToPort(inst, name, port, args);
    const fields = { port, name, args: slot(inst, handed, 'out') };
    if (LEDGER && name === TARGET.savedState.port) fields.ledger = new PendingLedger(handed[TARGET.savedState.arg ?? 0]);
    output(inst, 'port', fields);
    inst.portStack.push(port);
    let result;
    try {
      result = apply(fn, receiver(this), handed); // conformance:test
    } catch (error) {
      inst.portStack.pop();
      input(inst, 'answer', { port, outcome: 'throw', value: slot(inst, error, 'in') });
      throw error;
    }
    inst.portStack.pop();
    if (isPromise(result)) {
      // Whether the promise was already settled when the port returned (Bun.peek.status runs no job). Only a native
      // promise: awaiting a subclass's takes jobs of its own (its `then`), which a replay settling a native one lacks.
      const status = getPrototypeOf(result) === RealPromise.prototype ? peekStatus(result) : 'pending';
      const settled = status === 'fulfilled' ? 'resolve' : status === 'rejected' ? 'reject' : null;
      if (settled) apply(WeakMapSet, settledAtReturn, [result, settled]); else outstanding.set(result, inst.case);
      input(inst, 'answer', { port, outcome: 'promise', ...(settled ? { settled } : {}) });
      observe(result, (value) => { settledAnswer(inst, port, result, 'resolve', slot(inst, value, 'in')); }, (error) => { settledAnswer(inst, port, result, 'reject', slot(inst, error, 'in')); });
    } else input(inst, 'answer', { port, outcome: 'return', value: slot(inst, result, 'in') });
    return result;
  };
  apply(WeakMapSet, rawOf, [wrapper, fn]);
  return wrapper;
}
/** A saved state whose reference bytes are digested when its case is written, outside the test's time (an object changed since is flagged `mutated-after-crossing`). */
class PendingLedger { constructor(state) { this.state = state; } }
/** The digest of a saved state's reference bytes (the target's ledger encoder, outside any construction's chain), or what it threw. */
function ledgerDigest(state) {
  try {
    return sha(als.exit(() => apply(LEDGER, undefined, [state])));
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

// Reads the runtime makes on its own (a thenable check, conversions) are not inputs.
const IMPLICIT_READS = new Set(['then', 'constructor', 'toJSON']);
const isImplicitKey = (key) => (typeof key === 'symbol' ? Symbol.keyFor(key) === undefined && key.description?.startsWith('Symbol.') : IMPLICIT_READS.has(key));
const keyField = (inst, key) => (typeof key === 'string' ? key : slot(inst, key, 'in'));
/** An own-member check (hasOwnProperty, a descriptor, a spread): whether the member is there, and its value when it is a data member. */
const ownFields = (inst, descriptor) => (descriptor === undefined ? { found: false } : 'value' in descriptor ? { found: true, value: slot(inst, descriptor.value, 'in') } : { found: true });
/**
 * An object whose functions are ports `<name>.<key>`; a read of any other
 * member by the scheduler is an input (`read`), and so are `in` (`op: has`)
 * and listing its keys (`op: keys`), since a value encodes such an object
 * only as `{"$dr":"port","name":...}`.
 */
function portObject(inst, name, target) {
  // One proxy per object and construction, so an object that crosses twice is the same object both times, as without the recorder.
  const known = apply(WeakMapGet, inst.portObjects, [target]);
  if (known) return known;
  const cache = new RealMap();
  let proxy;
  const wrapped = (key, value) => {
    if (typeof value !== 'function' || key === 'constructor' || typeof key !== 'string') return value;
    let entry = cache.get(key);
    if (!entry || entry.fn !== value) { entry = { fn: value, wrapper: portFunction(inst, `${name}.${key}`, value, (self) => (self === proxy || self === undefined ? target : self)) }; cache.set(key, entry); }
    return entry.wrapper;
  };
  proxy = new RealProxy(target, {
    get(object, key) {
      const value = reflectGet(object, key, object);
      if (typeof value !== 'function' || key === 'constructor') {
        if (!isImplicitKey(key)) input(inst, 'read', { object: name, key: keyField(inst, key), value: slot(inst, value, 'in') });
        return value;
      }
      return wrapped(key, value);
    },
    has(object, key) {
      const found = reflectHas(object, key);
      if (!isImplicitKey(key)) input(inst, 'read', { object: name, op: 'has', key: keyField(inst, key), value: slot(inst, found, 'in') });
      return found;
    },
    ownKeys(object) {
      const keys = ownKeys(object);
      input(inst, 'read', { object: name, op: 'keys', value: slot(inst, keys, 'in') });
      return keys;
    },
    getOwnPropertyDescriptor(object, key) {
      const descriptor = getOwnPropertyDescriptor(object, key);
      const out = descriptor && 'value' in descriptor && descriptor.configurable && typeof descriptor.value === 'function' ? { ...descriptor, value: wrapped(key, descriptor.value) } : descriptor;
      if (!isImplicitKey(key)) input(inst, 'read', { object: name, op: 'own', key: keyField(inst, key), ...ownFields(inst, out) });
      return out;
    },
  });
  apply(WeakMapSet, portNames, [proxy, name]);
  apply(WeakMapSet, rawOf, [proxy, target]);
  apply(WeakMapSet, inst.portObjects, [target, proxy]);
  return proxy;
}

/** Functions the scheduler hands a port are inputs when the port calls them: the executor's control object, onProgress, ... */
function handToPort(inst, portName, port, args) {
  let changed = false;
  const out = args.map((arg, index) => {
    if (isWrapper(arg)) return arg;
    if (typeof arg === 'function') { changed = true; return handedFunction(inst, port, `${index}`, null, arg); }
    if (!holdsFunctions(arg)) return arg;
    changed = true;
    const control = portName.startsWith('executor.') && index === 1;
    return handedObject(inst, port, `${index}`, control, arg);
  });
  return changed ? out : args;
}
const handedProxies = new RealWeakMap();
function handedObject(inst, port, at, control, target) {
  const known = apply(WeakMapGet, handedProxies, [target]);
  if (known && known.inst === inst) return known.proxy;
  const cache = new RealMap();
  const proxy = new RealProxy(target, {
    get(object, key) {
      const value = reflectGet(object, key, object);
      if (typeof value !== 'function' || typeof key !== 'string' || key === 'constructor') return value;
      let entry = cache.get(key);
      if (!entry || entry.fn !== value) { entry = { fn: value, wrapper: handedFunction(inst, port, `${at}.${key}`, control ? key : null, value, object) }; cache.set(key, entry); }
      return entry.wrapper;
    },
  });
  apply(WeakMapSet, handedProxies, [target, { inst, proxy }]);
  apply(WeakMapSet, portNames, [proxy, `${control ? 'control' : 'handed'}#${port}.${at}`]);
  apply(WeakMapSet, rawOf, [proxy, target]);
  return proxy;
}
function handedFunction(inst, port, at, method, fn, holder) {
  const wrapper = function (...args) {
    const call = (inst.calls += 1);
    // What the port passes in is the test's: its functions are ports, as in a member's arguments.
    const handed = handFromTest(inst, method !== null ? 'control' : 'callback', call, args);
    if (method !== null) input(inst, 'control', { call, of: port, method, args: slot(inst, handed, 'in') });
    else input(inst, 'callback', { call, of: port, path: at, args: slot(inst, handed, 'in') });
    try {
      return deliver(inst, call, () => apply(fn, holder === undefined ? this : holder, handed));
    } finally {
      noteReturn(inst, call);
    }
  };
  apply(WeakMapSet, rawOf, [wrapper, fn]);
  return wrapper;
}

/** Callbacks a test passes a member become ports. */
function handFromTest(inst, member, call, args) {
  let changed = false;
  const out = args.map((arg, index) => {
    if (isWrapper(arg)) return arg;
    if (typeof arg === 'function') { changed = true; return portFunction(inst, `${member}#${call}.arg${index}`, arg); }
    if (!holdsFunctions(arg)) return arg;
    changed = true;
    return portObject(inst, `${member}#${call}.arg${index}`, arg);
  });
  return changed ? out : args;
}

// --------------------------------------------------------------- the clock and timers

const effectiveDelay = (delay) => {
  const number = Number(delay);
  return Number.isFinite(number) && number >= 1 && number <= 2147483647 ? Math.trunc(number) : 1;
};
const advance = (record, due) => { if (due > record.clock) record.clock = due; };

/** The construction's timers: one numbering, over the test's own scheduleTimeout/cancelTimeout or the real ones. */
function timerOptions(inst) {
  const ids = new RealWeakMap();
  const primitive = new RealMap(); // a primitive handle -> the timers it stands for, oldest first
  const isObjectHandle = (handle) => handle !== null && (typeof handle === 'object' || typeof handle === 'function');
  const remember = (handle, id) => { if (isObjectHandle(handle)) apply(WeakMapSet, ids, [handle, id]); else primitive.set(handle, [...(primitive.get(handle) ?? []), id]); };
  const forget = (handle, id) => { if (!isObjectHandle(handle) && primitive.has(handle)) primitive.set(handle, primitive.get(handle).filter((entry) => entry !== id)); };
  const schedule = (injectedSet) => ownWrapper(function scheduleTimeout(fn, delay, ...rest) {
    const timer = (inst.timers += 1);
    const set = output(inst, 'timer.set', { timer, delay: slot(inst, delay, 'out') });
    const setAt = inst.case.clock;
    let handle;
    const fire = function (...args) {
      // A timer the recorder set really: its callback is a macrotask of its own, entered with the microtask queue empty
      // when the event loop entered it (not a fake clock's advance).
      if (!injectedSet && enteredFromEventLoop(true)) markRest();
      const call = (inst.calls += 1);
      forget(handle, timer);
      // A real timer: its virtual due time has come. A test that fires its own timers moves no time.
      if (!injectedSet && CLOCK === 'nominal') advance(inst.case, setAt + effectiveDelay(delay));
      input(inst, 'fire', { call, timer });
      try {
        return deliver(inst, call, () => apply(fn, this, args));
      } finally {
        noteReturn(inst, call);
      }
    };
    apply(WeakMapSet, rawOf, [fire, fn]);
    handle = injectedSet ? apply(injectedSet, undefined, [fire, delay, ...rest]) : apply(realSetTimeout, globalThis, [fire, delay, ...rest]); // conformance:test
    remember(handle, timer);
    // What the handle is decides how a clear through it is attributed (a primitive one is forgotten when its timer fires).
    if (set) set.handle = isObjectHandle(handle) ? 'object' : 'primitive';
    return handle;
  });
  const cancel = (injectedClear) => ownWrapper(function cancelTimeout(handle) {
    if (isObjectHandle(handle)) output(inst, 'timer.clear', { timer: apply(WeakMapGet, ids, [handle]) ?? null });
    else {
      // A primitive handle several live timers share (a stub returning a constant) cannot say which it clears.
      const live = primitive.get(handle) ?? [];
      output(inst, 'timer.clear', live.length > 1 ? { timer: live[live.length - 1], ambiguous: [...live] } : { timer: live[0] ?? null });
      if (live.length) primitive.set(handle, live.slice(0, -1));
    }
    return injectedClear ? apply(injectedClear, undefined, [handle]) : apply(realClearTimeout, globalThis, [handle]); // conformance:test
  });
  return { schedule, cancel };
}

// --------------------------------------------------------------- hidden inputs

const FRAME = /\(?((?:\/|[A-Za-z]:\\)[^():?]+)(?:\?[^():]*)?:(\d+)(?::\d+)?\)?\s*$/;
const SITES = new RealMap(TARGET.sites.map((entry) => [`${entry.file}:${entry.line}:${entry.kind}`, entry]));
const SITE_NAMES = new Set(TARGET.sites.map((entry) => `${entry.site}:${entry.kind}`));
const RECORDER_FILES = new Set([fileURLToPath(import.meta.url), realpathSync(fileURLToPath(import.meta.url))]);
const HELPERS = new Set(TARGET.sites.filter((entry) => entry.kind === 'helper').map((entry) => `${entry.file}:${entry.line}`));
function stackFrames() {
  const limit = RealError.stackTraceLimit;
  RealError.stackTraceLimit = 24;
  const stack = new RealError().stack ?? '';
  RealError.stackTraceLimit = limit;
  const frames = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = FRAME.exec(line.trim());
    if (match) frames.push({ file: match[1], line: Number(match[2]) });
  }
  return frames;
}
const where = (frames) => frames.slice(0, 6).map((frame) => `${relative(frame.file)}:${frame.line}`).join(' < ');
/**
 * The site of a hidden read, or null when the code that read it is no
 * product module (a test's stub): the frame just below the recorder's own
 * must be product code; helper frames (createRandomId) pass the question to
 * their caller. An unnamed product line is a recorder error, and so is a
 * read whose reading frame a proper tail call removed (the first frame below
 * the recorder's own is the recorder delivering a scheduler input).
 */
function siteOf(kind, inst) {
  const frames = stackFrames();
  let outside = 0;
  // The recorder's own frames on top (stackFrames, siteOf, the read's wrapper) carry no mark; the first marked one
  // says whose code the removed frame was.
  for (; outside < frames.length && RECORDER_FILES.has(frames[outside].file); outside += 1) {
    if (CALLS_TEST.has(frames[outside].line)) return null; // a test function in tail position read it
    if (CALLS_PRODUCT.has(frames[outside].line)) {
      // A default parameter of a public member keeps no frame of its own, nor does product code in tail position:
      // the member being delivered names it when the spec has a site of that name; otherwise it is unnamed.
      const member = inst.delivering[inst.delivering.length - 1];
      if (typeof member === 'string' && SITE_NAMES.has(`${member}:${kind}`)) return member;
      noteError(`a ${kind} read by product code whose frame is gone (a tail call) has no site in the target spec (frames ${where(frames.slice(outside))})`);
      return null;
    }
  }
  if (outside >= frames.length || !PRODUCT_FILES.has(frames[outside].file)) return null;
  for (const [index, frame] of frames.slice(outside).entries()) {
    if (!PRODUCT_FILES.has(frame.file)) {
      const member = inst.delivering[inst.delivering.length - 1];
      if (index > 0 && RECORDER_FILES.has(frame.file) && typeof member === 'string' && SITE_NAMES.has(`${member}:${kind}`)) return member;
      break;
    }
    if (HELPERS.has(`${frame.file}:${frame.line}`)) continue;
    const entry = SITES.get(`${frame.file}:${frame.line}:${kind}`);
    if (entry) return entry.site;
    noteError(`a ${kind} read at ${relative(frame.file)}:${frame.line} has no site in the target spec`);
    return null;
  }
  noteError(`a ${kind} read in product code has no site in the target spec (frames ${where(frames)})`);
  return null;
}
const DIRECT = new Set(TARGET.direct.map((entry) => `${entry.file}:${entry.line}`));
/**
 * A hidden read with no construction's chain running: an error when product
 * code made it (an event listener runs without the chain's store), in any
 * case, a hooks case or one that built no scheduler included. The one
 * exemption is by function: a line of a product helper the target spec lets
 * tests call directly (`direct`), when the code that called the helper is no
 * product module (a test calling it is no scheduler input).
 */
function unownedRead(kind) {
  const frames = stackFrames();
  const at = frames.findIndex((frame) => !RECORDER_FILES.has(frame.file));
  if (at < 0 || !PRODUCT_FILES.has(frames[at].file)) return;
  const caller = frames[at + 1];
  if (DIRECT.has(`${frames[at].file}:${frames[at].line}`) && caller && !PRODUCT_FILES.has(caller.file)) return;
  noteError(`a ${kind} read in product code outside any construction's chain (an event listener?) at ${relative(frames[at].file)}:${frames[at].line} in ${keyOf(current)}: the real value was used`);
}
function hiddenDraw(inst, site) {
  const count = (inst.draws.get(site) ?? 0) + 1;
  inst.draws.set(site, count);
  const value = servedUuid(`${keyOf(inst.case)}:${inst.n}:${site}:${count}`);
  input(inst, 'draw', { site, source: 'hidden', value: slot(inst, value, 'in') });
  return value;
}
defineProperty(realCrypto, 'randomUUID', {
  configurable: true, writable: true, enumerable: false,
  value: function randomUUID() {
    const inst = als.getStore()?.inst;
    if (inst) { const site = siteOf('draw', inst); if (site) return hiddenDraw(inst, site); } else unownedRead('draw');
    return apply(realRandomUUID, realCrypto, []);
  },
});
const nominalPerformance = (record) => PERFORMANCE_ORIGIN + (record.clock - EPOCH);
defineProperty(realPerformance, 'now', {
  configurable: true, writable: true, enumerable: true,
  value: function now() {
    const inst = als.getStore()?.inst;
    if (inst) {
      const site = siteOf('clock', inst);
      if (site) {
        const value = CLOCK === 'nominal' ? nominalPerformance(inst.case) : apply(realPerformanceNow, realPerformance, []);
        input(inst, 'clock', { source: 'performance', site, value: slot(inst, value, 'in') });
        return value;
      }
    } else unownedRead('clock');
    return apply(realPerformanceNow, realPerformance, []);
  },
});
const ENV_NAMES = new Set(TARGET.env);
if (ENV_NAMES.size) {
  const realEnv = process.env;
  process.env = new RealProxy(realEnv, {
    get(object, key) {
      const value = reflectGet(object, key);
      if (typeof key === 'string' && ENV_NAMES.has(key)) {
        const inst = als.getStore()?.inst;
        if (inst) { const site = siteOf('env', inst); if (site) input(inst, 'env', { site, name: key, value: slot(inst, value, 'in') }); } else unownedRead('env');
      }
      return value;
    },
  });
}
if (CLOCK === 'nominal') {
  // Time moves only by the rule above, never while the test reads it: a loop reading Date.now() until real time
  // has passed would spin for ever, so the same nominal time read SPIN_LIMIT times in a row, with no event between,
  // throws (deterministically: it depends only on what the test did).
  const spin = { record: null, value: Number.NaN, events: -1, count: 0 };
  RealDate.now = function now() {
    const record = ownerNow();
    const value = record.clock;
    if (spin.record === record && spin.value === value && spin.events === eventsSeen) spin.count += 1;
    else { spin.record = record; spin.value = value; spin.events = eventsSeen; spin.count = 1; }
    if (spin.count >= SPIN_LIMIT) {
      spin.count = 0;
      const message = `scheduler-conformance: Date.now() returned the nominal time ${value} ${SPIN_LIMIT} times in a row with nothing recorded between; under the nominal clock time moves only when a recorder timer fires, so a loop waiting for real time to pass cannot end`;
      noteError(message);
      throw new RealError(message);
    }
    return value;
  };
  // `new Date()` and `Date()` read the same nominal time as Date.now(); every other form, the statics and the
  // prototype are the real Date's (the proxy forwards them), and instances are real Dates.
  const NominalDate = new RealProxy(RealDate, {
    construct(target, args, newTarget) { return reflectConstruct(target, args.length === 0 ? [RealDate.now()] : args, newTarget === NominalDate ? target : newTarget); },
    apply() { return new RealDate(RealDate.now()).toString(); },
  });
  defineProperty(RealDate.prototype, 'constructor', { value: NominalDate, writable: true, enumerable: false, configurable: true });
  globalThis.Date = NominalDate;
}

// --------------------------------------------------------------- the construction

const FACTORIES = ['createTaskId', 'createLeaseToken', 'createWaveId'];
/** The scheduler's own default persistence, member for member (the target spec anchors its source, so a change there fails loudly). */
const defaultPersistence = () => ({ async load() { return null; }, async save() {} });

function construct(real, thisArg, args) {
  const record = ownerNow();
  const inst = { case: record, n: record.constructions.length + 1, seq: 0, calls: 0, ports: 0, timers: 0, signals: new Map(), portObjects: new RealWeakMap(), draws: new Map(), portStack: [], delivering: [], events: [], defaulted: [] };
  inst.store = { inst };
  record.constructions.push(inst);
  const options = args[0];
  if (options === null || typeof options !== 'object') {
    input(inst, 'call', { call: 0, member: TARGET.export, args: slot(inst, args, 'in') });
    try {
      return deliver(inst, 0, () => apply(real, thisArg, args), null, (scheduler) => members(inst, scheduler));
    } finally {
      noteReturn(inst, 0);
    }
  }
  const timers = timerOptions(inst);
  const supplied = new RealMap();
  supplied.set('now', ownWrapper(function now() {
    const value = CLOCK === 'nominal' ? inst.case.clock : apply(realDateNow, RealDate, []);
    input(inst, 'clock', { source: CLOCK, value: slot(inst, value, 'in') });
    return value;
  }));
  supplied.set('scheduleTimeout', timers.schedule(null));
  supplied.set('cancelTimeout', timers.cancel(null));
  for (const site of FACTORIES) {
    const prefix = TARGET.defaults[site];
    if (typeof prefix !== 'string') continue;
    supplied.set(site, ownWrapper(function draw() {
      const count = (inst.draws.get(site) ?? 0) + 1;
      inst.draws.set(site, count);
      const value = `${prefix}${servedUuid(`${keyOf(inst.case)}:${inst.n}:${site}:${count}`).replaceAll('-', '')}`;
      input(inst, 'draw', { site, source: 'default', value: slot(inst, value, 'in') });
      return value;
    }));
  }
  supplied.set('publishEvent', portFunction(inst, 'publishEvent', () => undefined));
  supplied.set('logger', portObject(inst, 'logger', realConsole));
  // Without a persistence the scheduler would keep its own in-memory one; the recorder supplies the same one as a port, so every save crosses.
  if (TARGET.defaultPersistence) supplied.set('persistence', portObject(inst, 'persistence', defaultPersistence()));
  const handed = [optionsPort(inst, options, timers, supplied), ...args.slice(1)];
  // The options as the scheduler gets them at construction: functions by name, objects with functions as ports, data inline.
  input(inst, 'call', { call: 0, member: TARGET.export, args: slot(inst, [optionsView(inst, options), ...args.slice(1)], 'in') });
  // The construction returns the scheduler's members as inputs; its own return value is that proxy (a port, by name).
  try {
    return deliver(inst, 0, () => apply(real, thisArg, handed), null, (scheduler) => members(inst, scheduler));
  } finally {
    noteReturn(inst, 0);
  }
}

/** What the scheduler gets for one option member: a recorded clock, timers or factory, a port, or the data itself. */
function wrapOption(inst, key, value, timers) {
  if (key === 'now' && typeof value === 'function') {
    return ownWrapper(function now(...args) {
      const result = apply(value, this, args); // conformance:test
      input(inst, 'clock', { source: 'option', value: slot(inst, result, 'in') });
      return result;
    });
  }
  if (key === 'scheduleTimeout' && typeof value === 'function') return timers.schedule(value);
  if (key === 'cancelTimeout' && typeof value === 'function') return timers.cancel(value);
  if (FACTORIES.includes(key) && typeof value === 'function') {
    return ownWrapper(function draw(...args) {
      const result = apply(value, this, args); // conformance:test
      input(inst, 'draw', { site: key, source: 'option', value: slot(inst, result, 'in') });
      return result;
    });
  }
  if (typeof value === 'function') return portFunction(inst, key, value, (self) => (self === inst.options ? inst.optionsTarget : self));
  if (holdsFunctions(value)) return portObject(inst, key, value);
  return value;
}

/**
 * The options object the scheduler gets: a forwarding proxy over the test's
 * own, so a member the test changes later is what the scheduler reads then.
 * Every member read is an input (`read`, with `supplied: true` when the test
 * left it out and the recorder supplied the scheduler's default); `in` and
 * key listing are inputs too, and answer as the test's object does.
 */
function optionsPort(inst, options, timers, supplied) {
  const cache = new RealMap();
  const memberValue = (key, value) => {
    if (typeof key !== 'string') return value;
    const entry = cache.get(key);
    if (entry && entry.raw === value) return entry.wrapped;
    const made = wrapOption(inst, key, value, timers);
    cache.set(key, { raw: value, wrapped: made });
    return made;
  };
  inst.memberValue = memberValue;
  const proxy = new RealProxy(create(getPrototypeOf(options)), {
    get(object, key) {
      let value = reflectGet(options, key, options);
      let fromRecorder = false;
      // The scheduler falls back to its defaults with `??`: null is a member left out, as undefined is.
      if ((value === undefined || value === null) && typeof key === 'string' && supplied.has(key)) {
        value = supplied.get(key);
        fromRecorder = true;
        if (!inst.defaulted.includes(key)) inst.defaulted.push(key);
      } else {
        // A target without a default-persistence anchor keeps the scheduler's in-memory one: its saves never cross.
        if (key === 'persistence' && (value === undefined || value === null) && !inst.defaulted.includes('persistence:internal')) inst.defaulted.push('persistence:internal');
        value = memberValue(key, value);
      }
      if (!isImplicitKey(key)) input(inst, 'read', { object: 'options', key: keyField(inst, key), value: slot(inst, value, 'in'), ...(fromRecorder ? { supplied: true } : {}) });
      return value;
    },
    has(object, key) {
      const found = reflectHas(options, key);
      if (!isImplicitKey(key)) input(inst, 'read', { object: 'options', op: 'has', key: keyField(inst, key), value: slot(inst, found, 'in') });
      return found;
    },
    ownKeys() {
      const keys = ownKeys(options);
      input(inst, 'read', { object: 'options', op: 'keys', value: slot(inst, keys, 'in') });
      return keys;
    },
    getOwnPropertyDescriptor(object, key) {
      const descriptor = getOwnPropertyDescriptor(options, key);
      const out = !descriptor ? undefined : 'value' in descriptor ? { ...descriptor, value: memberValue(key, descriptor.value), configurable: true } : { ...descriptor, configurable: true };
      if (!isImplicitKey(key)) input(inst, 'read', { object: 'options', op: 'own', key: keyField(inst, key), ...ownFields(inst, out) });
      return out;
    },
    set(object, key, value) { return reflectSet(options, key, value, options); },
    deleteProperty(object, key) { return reflectDelete(options, key); },
    defineProperty(object, key, descriptor) { return reflectDefine(options, key, descriptor); },
  });
  inst.options = proxy;
  inst.optionsTarget = options;
  apply(WeakMapSet, rawOf, [proxy, options]);
  return proxy;
}

/** The options at construction, as the scheduler would read them: own data members wrapped as the proxy wraps them (accessors stay accessors, never called). */
function optionsView(inst, options) {
  const view = create(getPrototypeOf(options));
  for (const key of ownKeys(options)) {
    const descriptor = getOwnPropertyDescriptor(options, key);
    if (!('value' in descriptor) || typeof key !== 'string') { defineProperty(view, key, descriptor); continue; }
    defineProperty(view, key, { ...descriptor, value: inst.memberValue(key, descriptor.value) });
  }
  return view;
}

/** The returned scheduler: every function member is an input `call`. */
function members(inst, scheduler) {
  if (scheduler === null || typeof scheduler !== 'object') return scheduler;
  const cache = new RealMap();
  const proxy = new RealProxy(scheduler, {
    get(object, key) {
      const value = reflectGet(object, key, object);
      if (typeof value !== 'function' || typeof key !== 'string') return value;
      let entry = cache.get(key);
      if (!entry || entry.fn !== value) {
        const member = function (...args) {
          const call = (inst.calls += 1);
          const handed = handFromTest(inst, key, call, args);
          input(inst, 'call', { call, member: key, args: slot(inst, handed, 'in') });
          try {
            return deliver(inst, call, () => apply(value, object, handed), key);
          } finally {
            noteReturn(inst, call);
          }
        };
        apply(WeakMapSet, rawOf, [member, value]);
        entry = { fn: value, wrapper: member };
        cache.set(key, entry);
      }
      return entry.wrapper;
    },
  });
  apply(WeakMapSet, portNames, [proxy, `scheduler#${inst.n}`]);
  apply(WeakMapSet, rawOf, [proxy, scheduler]);
  return proxy;
}

// --------------------------------------------------------------- the facade

defineProperty(globalThis, API, {
  configurable: true, enumerable: false, writable: false,
  value: Object.freeze({
    wrap(real) {
      return function createManagedTaskScheduler(...args) { return construct(real, this, args); };
    },
    // The scripted driver (driver.mjs) marks where each input group begins: an `in step` event in the latest
    // construction of the running case, with plain data only (the step's number, the virtual time). The driver then
    // lists each input of the group with `stepInput`, in delivery order, just before it delivers it: structured
    // (`kind`, `label`, the construction it reaches and this recorder's own numbers for it, which the driver reads
    // with the four lookups below). A marker or input with no construction to hold it, or that is not plain data,
    // is a recorder error.
    step({ step, now, inputs }) {
      const record = ownerNow();
      const inst = record.constructions[record.constructions.length - 1];
      if (!inst) { noteError(`a driver step marker (step ${step}) in ${keyOf(record)}, which built no scheduler`); return; }
      if (!Number.isSafeInteger(step) || !Number.isFinite(now) || !Array.isArray(inputs) || inputs.length !== 0) {
        noteError(`a driver step marker that is not plain data (step ${step})`);
        return;
      }
      const marker = { step, now, inputs: [] };
      input(inst, 'step', marker);
      record.stepMarker = marker;
    },
    stepInput(described) {
      const record = ownerNow();
      const marker = record.stepMarker;
      const plain = described !== null && typeof described === 'object' && typeof described.kind === 'string' && typeof described.label === 'string'
        && Object.values(described).every((value) => value === null || typeof value === 'string' || Number.isSafeInteger(value))
        && !Object.values(described).some((value) => typeof value === 'string' && /^=[0-9a-f]{16}$/.test(value));
      if (!marker) { noteError(`a driver step input (${described?.label}) in ${keyOf(record)} with no step marker`); return; }
      if (!plain) { noteError(`a driver step input that is not plain data (step ${marker.step})`); return; }
      marker.inputs.push({ ...described });
    },
    // The driver's lookups: the port call now on a construction's stack, its next input call number, its latest timer, a signal's number.
    portOnStack(construction) {
      const inst = ownerNow().constructions[construction - 1];
      return inst && inst.portStack.length ? inst.portStack[inst.portStack.length - 1] : null;
    },
    nextCall(construction) {
      const inst = ownerNow().constructions[construction - 1];
      return inst ? inst.calls + 1 : null;
    },
    lastTimer(construction) {
      const inst = ownerNow().constructions[construction - 1];
      return inst ? inst.timers : null;
    },
    signalNumber(construction, signal) {
      const inst = ownerNow().constructions[construction - 1];
      return inst?.signals.get(signal) ?? null;
    },
  }),
});
const MODULE = realpathSync(TARGET.module);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
Bun.plugin({
  name: 'devryan-scheduler-conformance',
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escape(MODULE)}(?:\\?${REAL_QUERY})?$`) }, (args) => {
      const [file, query] = args.path.split('?');
      const source = readFileSync(file, 'utf8');
      if (query === REAL_QUERY) return { contents: source, loader: 'js' };
      const real = JSON.stringify(`${file}?${REAL_QUERY}`);
      const lines = [`import * as __real from ${real};`, `const __api = globalThis[Symbol.for('devryan.scheduler-conformance')];`];
      for (const name of new Bun.Transpiler({ loader: 'js' }).scan(source).exports) {
        if (name === TARGET.export) lines.push(`export const ${name} = __api.wrap(__real.${name});`);
        else if (name === 'default') lines.push(`export { default } from ${real};`);
        else lines.push(`export { ${name} } from ${real};`);
      }
      return { contents: lines.join('\n'), loader: 'js' };
    });
  },
});

// --------------------------------------------------------------- the case lifecycle

/** A slot's content alone, AbortSignal states left out (an abort is its own event). */
function contentText(snap) {
  const strip = (tree) => {
    if (Array.isArray(tree)) return tree.map(strip);
    if (tree && typeof tree === 'object') {
      if (tree.$dr === 'abortsignal') return { $dr: 'abortsignal' };
      const out = {};
      for (const key of Object.keys(tree)) out[key] = strip(tree[key]);
      return out;
    }
    return tree;
  };
  return stringifyTree(strip(emitSlots([snap])[0]));
}
/** Takes every object that crossed in the case since the last check again: one whose content changed is kept for `classifyChanged`. */
function checkCrossed(record) {
  for (; record.checked < record.snaps.length; record.checked += 1) {
    const value = record.crossed[record.checked];
    if (value === null || isWrapper(value)) continue;
    try {
      const again = snapshot(value, createCodecContext({ names: portNames, unwrap: (item) => apply(WeakMapGet, rawOf, [item]) }));
      if (contentText(again) !== contentText(record.snaps[record.checked])) record.changed.push(record.checked);
    } catch (error) {
      noteError(`encode again: ${error?.message ?? error}`);
    }
    record.crossed[record.checked] = null;
  }
}
/**
 * When the case is written (every crossing known): a changed value that went
 * in, or went out and has an object that crossed again in the case, flags it
 * (`mutated-after-crossing`); a changed value that went out and whose objects
 * never crossed again is what the scheduler handed over then, changed later
 * by whoever received it (`mutated-by-receiver`, a note: the case keeps its
 * outcome).
 */
function classifyChanged(record) {
  for (const index of record.changed) {
    let again = record.dirs[index] !== 'out';
    if (!again) for (const item of record.snaps[index].nodes.keys()) if (typeof item === 'object' && !isWrapper(item) && (record.sightings.get(item) ?? 0) > 1) { again = true; break; }
    if (again) { record.flags.add('mutated-after-crossing'); mark(record, index, 'mutated'); } else { record.notes.add('mutated-by-receiver'); mark(record, index, 'mutatedByReceiver'); }
  }
  record.changed = [];
}
const closeCase = (record) => { record.closed = true; checkCrossed(record); };

// Closing a case takes every object that crossed in it again (O(the case's recorded size)): its own timeout.
const CASE_TIMEOUT_MS = 600_000;
const MAIN = Bun.main;
beforeEach(() => {
  if (Bun.main !== MAIN) noteError(`two test files in one process (${relative(MAIN)}, then ${relative(Bun.main)}): run bun test with --parallel`);
  openTests += 1;
  const overlap = openTests > 1;
  if (overlap) current.flags.add('concurrent');
  closeCase(current);
  current = newCase('test', (testsSeen += 1));
  if (overlap) current.flags.add('concurrent');
}, CASE_TIMEOUT_MS);
afterEach(() => {
  openTests = Math.max(0, openTests - 1);
  closeCase(current);
  current = newCase('hooks', testsSeen);
  if (openTests > 0) current.flags.add('concurrent');
}, CASE_TIMEOUT_MS);

/** The written form of a case: its slots emitted together (one identity scope), each a hash into the value table. */
function finalize(record, values) {
  checkCrossed(record);
  classifyChanged(record);
  let trees;
  try {
    trees = emitSlots(record.snaps);
  } catch (error) {
    noteError(`encode: ${error?.message ?? error}`);
    trees = record.snaps.map(() => ({ $dr: 'unencodable', reason: 'emit' }));
  }
  const refs = trees.map((tree) => {
    const text = stringifyTree(tree);
    const hash = hashText(text);
    if (values[hash] !== undefined && values[hash] !== text) noteError(`hash collision at ${hash}`);
    values[hash] = text;
    return `=${hash}`;
  });
  // Each event lists the fields whose value held an unwrapped function or changed after crossing (by the receiver alone, or not).
  const marked = (entry) => {
    const out = { ...entry };
    for (const key of Object.keys(entry)) {
      const marks = entry[key] && typeof entry[key] === 'object' && typeof entry[key].slot === 'number' ? record.marks.get(entry[key].slot) : undefined;
      for (const name of marks ?? []) out[name] = [...(out[name] ?? []), key];
    }
    return out;
  };
  const resolve = (item) => {
    if (item instanceof PendingLedger) return ledgerDigest(item.state);
    if (Array.isArray(item)) return item.map(resolve);
    if (item && typeof item === 'object') {
      if (Object.keys(item).length === 1 && typeof item.slot === 'number') return refs[item.slot];
      const out = {};
      for (const key of Object.keys(item)) out[key] = resolve(item[key]);
      return out;
    }
    return item;
  };
  return {
    kind: record.kind, ...(record.kind === 'test' ? { ordinal: record.ordinal } : { hooks: record.hooks }),
    flags: [...record.codec.flags, ...record.flags].filter((flag, index, list) => list.indexOf(flag) === index).sort(),
    notes: [...record.notes].sort(),
    // The case's own count of the events it wrote (every construction's), kept apart from the events: a reader checks one against the other.
    events: record.at,
    constructions: record.constructions.map((inst) => ({ n: inst.n, defaulted: [...inst.defaulted], events: resolve(record.marks.size ? inst.events.map(marked) : inst.events) })),
  };
}

// Writing is O(recorded size): a test that saves a large ledger once per transition records it every time
// (a file of the package records 190 MB of saved states), so the hook gets its own generous timeout.
const WRITE_TIMEOUT_MS = 600_000;
afterAll(() => {
  current.closed = true;
  const values = {};
  const kept = cases.filter((record) => record.kind === 'test' || record.constructions.length > 0).map((record) => finalize(record, values));
  written = true;
  if (!OUT) return;
  const head = {
    version: RAW_VERSION, recording: RECORDING_VERSION, codec: CODEC_VERSION, file: TEST_FILE, bun: Bun.version, recorder: RECORDER, modules: MODULES,
    target: relative(TARGET.module), clock: CLOCK, epoch: EPOCH, cases: kept, errors, unplaced,
  };
  mkdirSync(OUT, { recursive: true });
  // Never overwrite: two test files must never share a recording. Values are written as the JSON they are, one at a time.
  const descriptor = openSync(path.join(OUT, `${pathStem(TEST_FILE)}.raw.json`), 'wx');
  try {
    writeSync(descriptor, `${JSON.stringify(head).slice(0, -1)},"values":{`);
    let first = true;
    for (const hash of Object.keys(values)) { writeSync(descriptor, `${first ? '' : ','}${JSON.stringify(hash)}:${values[hash]}`); first = false; }
    writeSync(descriptor, '}}');
  } finally {
    closeSync(descriptor);
  }
}, WRITE_TIMEOUT_MS);
