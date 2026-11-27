// The candidate adapter of the scheduler conformance harness (design file 30
// §4.3 and §6, package O0c): what a scheduler under test sits behind while
// the replayer (replay.mjs) feeds it a recording's inputs. The interface is
// narrow on purpose, since a Rust core (design §6) will later sit behind the
// same one: inputs in, ordered effects out, and the inputs the candidate asks
// for answered by the host from the trace.
//
// A candidate is made per replayed case by `createJsCandidate(...)` (the
// JavaScript scheduler, here a second copy of the package loaded from the run
// root) and offers:
//
//   candidate.deliver(input)   one arrived input, delivered synchronously; the
//                              inputs of one group are delivered one after the
//                              other in one macrotask, with no microtask between
//                              them. `input.kind` is one of
//                                construct {construction, args}       call 0: build construction `construction`
//                                call      {construction, member, args}
//                                control   {construction, of, method, args}   a method of the control object
//                                                                              the candidate handed port call `of`
//                                callback  {construction, of, path, args}     another function it handed port call `of`
//                                fire      {construction, timer}
//                                answer    {construction, port, outcome: resolve | reject, value}
//                                abort     {construction, controller, reason}  a signal the host handed it
//                              Values are live: the host decodes them and makes
//                              the stand-ins below for what the trace names.
//   candidate.optionValue(construction, key, {supplied, name})
//   candidate.portFunction(construction, name, displayName)
//   candidate.portObject(construction, name)
//                              stand-ins for an option member (now, the timers,
//                              the identifier factories), a function the test
//                              handed it (a port), an object of such functions
//                              (a port object): the host asks for them while it
//                              decodes a value, so identity across values is
//                              the host's (one stand-in per recorded object).
//   candidate.isQuiet()        nothing of the candidate's is running now
//                              (synchronously; the host drains the event loop).
//
// and calls back into the host, synchronously, in the order things happen:
//
//   host.slot(construction, value, dir)   a value crossing the boundary (`in` or `out`)
//   host.input(construction, kind, fields) where an arrived input took effect (call,
//                                          control, callback, fire, answer resolve | reject)
//   host.output(construction, kind, fields) an effect: port, timer.set, timer.clear,
//                                          return, throw, settle (abort is the host's: it
//                                          watches every signal that crosses)
//   host.ask(construction, kind, fields)  an input the candidate asks for: read, clock,
//                                          draw, env; the host answers it from the trace
//                                          and records it
//   host.portAnswer(construction, port)   after a port call: the host delivers the inputs
//                                          the recording places inside it (`during`), then
//                                          answers it: {outcome: return | throw | promise, value,
//                                          settle?}; settle {outcome, value}: the promise is
//                                          already settled when the port returns (the test's was)
//   host.timerHandle(construction)        what the timer being set returns as its handle,
//                                          object | primitive (the test's scheduleTimeout's)
//   host.returnedPromise(construction, call, promise)  a member's promise, right after the
//                                          candidate's own observer: the host may deliver the
//                                          input the recording places in its settlement's
//                                          continuation by a reaction registered there
//
// The events the adapter reports are the recorder's (trace.mjs), at the
// points the recorder writes them (recorder.mjs), so a reproduction is a
// trace equal to the recording, event for event. The JavaScript adapter
// mirrors the recorder's boundary code with the test's side replaced by the
// host: an option read asks the host instead of reading the test's object, a
// port call asks for its answer instead of calling the test's function. A
// Rust core would sit behind a thin shell that maps its effects to the same
// calls (`NeedDraw {site}` to host.ask, `PortCall` to host.output and
// host.portAnswer).
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RealProxy = Proxy;
const RealPromise = Promise;
const RealError = Error;
const { apply, get: reflectGet, has: reflectHas, set: reflectSet, deleteProperty: reflectDelete, defineProperty: reflectDefine } = Reflect;
const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf, create } = Object;
const PromiseThen = Promise.prototype.then;
const isPrototypeOf = Object.prototype.isPrototypeOf;

export const CANDIDATE_FILE = realpathSync(fileURLToPath(import.meta.url));
export const INPUT_KINDS = Object.freeze(['construct', 'call', 'control', 'callback', 'fire', 'answer', 'abort']);
export const OPTION_FUNCTIONS = Object.freeze(['now', 'scheduleTimeout', 'cancelTimeout', 'createTaskId', 'createLeaseToken', 'createWaveId']);
const FACTORIES = ['createTaskId', 'createLeaseToken', 'createWaveId'];
/** The chain of the construction whose code is running: `{ inst, host, candidate }` (the host's hidden-read hooks read it). */
export const candidateAls = new AsyncLocalStorage();

const isSignal = (value) => value !== null && typeof value === 'object' && apply(isPrototypeOf, AbortSignal.prototype, [value]);
const isPromise = (value) => value !== null && typeof value === 'object' && apply(isPrototypeOf, RealPromise.prototype, [value]);
const observe = (promise, onValue, onError) => { apply(PromiseThen, promise, [onValue, onError]); };

// Reads the runtime makes on its own (a thenable check, conversions) are no inputs, as in the recorder.
const IMPLICIT_READS = new Set(['then', 'constructor', 'toJSON']);
export const isImplicitKey = (key) => (typeof key === 'symbol' ? Symbol.keyFor(key) === undefined && key.description?.startsWith('Symbol.') : IMPLICIT_READS.has(key));

// Platform objects keep their identity and brand: never wrapped (recorder.mjs `holdsFunctions`).
const BUILTIN_PROTOTYPES = new Set([Array, Map, Set, WeakMap, WeakSet, Date, RegExp, Error, Promise, ArrayBuffer, DataView, EventTarget, URL, URLSearchParams, Headers, Request, Response, Blob, TextEncoder, TextDecoder]
  .filter((constructor) => typeof constructor === 'function').map((constructor) => constructor.prototype).concat([getPrototypeOf(Int8Array.prototype)]));
const isPlainish = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !isSignal(value) && !isPromise(value);

/**
 * The JavaScript candidate over a copy of the scheduler package. `factory`
 * is the copy's `createManagedTaskScheduler`; `host` the replayer; `names`
 * and `rawOf` are the case's codec maps (a stand-in the codec writes as a
 * port, and what a wrapper stands for); `clock` is the recording's clock mode
 * (the source of a `now` the recorder supplied); `sites` names the hidden
 * reads of the copy by file and line (replay.mjs `copySites`); `exportName`
 * the factory's name in the trace.
 */
export function createJsCandidate({ factory, host, names, rawOf, clock, sites, exportName = 'createManagedTaskScheduler', savedState = null }) {
  const als = candidateAls;
  const insts = new Map();
  let api = null;
  const isWrapper = (item) => rawOf.get(item) !== undefined;
  const ownWrapper = (wrapper) => { rawOf.set(wrapper, wrapper); return wrapper; };
  let running = 0; // candidate code on the stack (a delivery, a port call returning)

  const instOf = (construction) => {
    let inst = insts.get(construction);
    if (!inst) {
      inst = { n: construction, calls: 0, ports: 0, timers: 0, timerFns: new Map(), timerIds: new WeakMap(), livePrimitive: new Set(), portArgs: new Map(), deferreds: new Map(), portObjects: new Map(), handed: new WeakMap(), delivering: [], scheduler: null, options: null };
      inst.store = { inst, host, get candidate() { return api; } };
      insts.set(construction, inst);
    }
    return inst;
  };

  /** Runs candidate code for an arrived input `call` and reports its return, throw or settlement (recorder.mjs `deliver`). */
  function run(inst, call, thunk, name = null, transform = null) {
    let result;
    inst.delivering.push(name);
    running += 1;
    try {
      result = als.run(inst.store, thunk);
      if (transform) result = transform(result);
    } catch (error) {
      inst.delivering.pop();
      running -= 1;
      host.output(inst.n, 'throw', { call, error: host.slot(inst.n, error, 'out') });
      return undefined;
    }
    inst.delivering.pop();
    running -= 1;
    if (isPromise(result)) {
      host.output(inst.n, 'return', { call, promise: true });
      observe(result, (value) => { host.output(inst.n, 'settle', { call, outcome: 'resolve', value: host.slot(inst.n, value, 'out') }); }, (error) => { host.output(inst.n, 'settle', { call, outcome: 'reject', value: host.slot(inst.n, error, 'out') }); });
      host.returnedPromise?.(inst.n, call, result);
    } else {
      host.output(inst.n, 'return', { call, value: host.slot(inst.n, result, 'out') });
    }
    return result;
  }

  // ------------------------------------------------------------ ports

  /** Whether an object holds a function the other side may call (recorder.mjs `holdsFunctions`). */
  function holdsFunctions(value) {
    if (!isPlainish(value) || isWrapper(value)) return false;
    for (let object = getPrototypeOf(value), depth = 0; object && depth < 16; object = getPrototypeOf(object), depth += 1) if (BUILTIN_PROTOTYPES.has(object)) return false;
    for (let object = value, depth = 0; object && object !== Object.prototype && depth < 8; object = getPrototypeOf(object), depth += 1) {
      for (const key of Reflect.ownKeys(object)) {
        const descriptor = getOwnPropertyDescriptor(object, key);
        if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function' && key !== 'constructor') return true;
      }
    }
    return false;
  }

  /** What the candidate hands a port: its functions, and objects holding functions, stand for inputs (control, callback) when the host calls them. */
  function handToPort(inst, portName, port, args) {
    let changed = false;
    const out = args.map((arg, index) => {
      if (isWrapper(arg)) return arg;
      if (typeof arg === 'function') {
        changed = true;
        const wrapper = function handed() { throw new TypeError('scheduler replay: a handed function is called by the host, through deliver'); };
        rawOf.set(wrapper, arg);
        return wrapper;
      }
      if (!holdsFunctions(arg)) return arg;
      changed = true;
      const known = inst.handed.get(arg);
      if (known) return known;
      const control = portName.startsWith('executor.') && index === 1;
      const proxy = new RealProxy(arg, {});
      names.set(proxy, `${control ? 'control' : 'handed'}#${port}.${index}`);
      rawOf.set(proxy, arg);
      inst.handed.set(arg, proxy);
      return proxy;
    });
    return changed ? out : args;
  }

  /** A port call: the effect, then the inputs the recording places inside it, then its answer. */
  function portCall(inst, name, args) {
    const port = (inst.ports += 1);
    const handed = handToPort(inst, name, port, args);
    const fields = { port, name, args: host.slot(inst.n, handed, 'out') };
    if (savedState && name === savedState.port) fields.ledger = { pending: handed[savedState.arg ?? 0] };
    host.output(inst.n, 'port', fields);
    inst.portArgs.set(port, args);
    const answer = host.portAnswer(inst.n, port);
    if (answer.outcome === 'return') return answer.value;
    if (answer.outcome === 'throw') throw answer.value;
    let resolve;
    let reject;
    const promise = new RealPromise((done, failed) => { resolve = done; reject = failed; });
    inst.deferreds.set(port, { resolve, reject });
    observe(promise, (value) => { host.input(inst.n, 'answer', { port, outcome: 'resolve', value: host.slot(inst.n, value, 'in') }); }, (error) => { host.input(inst.n, 'answer', { port, outcome: 'reject', value: host.slot(inst.n, error, 'in') }); });
    // A promise already settled when the port returns (the host's plan says so: a test's async function that finished at once).
    if (answer.settle) { inst.deferreds.delete(port); if (answer.settle.outcome === 'reject') reject(answer.settle.value); else resolve(answer.settle.value); }
    return promise;
  }

  function portFunction(construction, name, displayName) {
    const inst = instOf(construction);
    const wrapper = function (...args) { return portCall(inst, name, args); };
    defineProperty(wrapper, 'name', { value: displayName, configurable: true });
    return ownWrapper(wrapper);
  }

  /** An object whose functions are ports `<name>.<key>`; a read of any other member is an input (recorder.mjs `portObject`). */
  function portObject(construction, name) {
    const inst = instOf(construction);
    const cache = new Map();
    const target = {};
    const proxy = new RealProxy(target, {
      get(object, key) {
        if (isImplicitKey(key)) return reflectGet(object, key, object);
        // A member the recorder saw as data is a read in the trace; any other member was a function, a port.
        if (host.nextIsRead(inst.n, name, key)) return host.ask(inst.n, 'read', { object: name, key });
        if (typeof key !== 'string') return host.ask(inst.n, 'read', { object: name, key });
        if (!cache.has(key)) cache.set(key, portFunction(inst.n, `${name}.${key}`, key));
        return cache.get(key);
      },
      has(object, key) { return isImplicitKey(key) ? reflectHas(object, key) : host.ask(inst.n, 'read', { object: name, op: 'has', key }); },
      ownKeys() { return host.ask(inst.n, 'read', { object: name, op: 'keys' }); },
      getOwnPropertyDescriptor(object, key) {
        if (isImplicitKey(key)) return getOwnPropertyDescriptor(object, key);
        const found = host.ask(inst.n, 'read', { object: name, op: 'own', key });
        return found.found ? { value: found.value, writable: true, enumerable: true, configurable: true } : undefined;
      },
    });
    names.set(proxy, name);
    rawOf.set(proxy, target);
    return proxy;
  }

  // ------------------------------------------------------------ options

  /** The candidate's own clock, timers and identifier factories, as the recorder wraps them (named as the recorder's wrappers are). */
  function optionValue(construction, key, { supplied = false } = {}) {
    const inst = instOf(construction);
    if (key === 'now') {
      return ownWrapper(function now() { return host.ask(inst.n, 'clock', { source: supplied ? clock : 'option' }); });
    }
    // Handles are objects (the recorder attributes a clear through one to its timer for good), or, where the
    // recording says the test's scheduleTimeout returned a primitive (`handle` on timer.set, an answer of the test's,
    // which the host gives), numbers the recorder forgets once their timer fires or is cleared.
    if (key === 'scheduleTimeout') {
      return ownWrapper(function scheduleTimeout(fn, delay) {
        const timer = (inst.timers += 1);
        const handleKind = host.timerHandle(inst.n);
        host.output(inst.n, 'timer.set', { timer, delay: host.slot(inst.n, delay, 'out'), handle: handleKind });
        inst.timerFns.set(timer, fn);
        if (handleKind === 'primitive') { inst.livePrimitive.add(timer); return timer; }
        const handle = { replayTimer: timer };
        inst.timerIds.set(handle, timer);
        return handle;
      });
    }
    if (key === 'cancelTimeout') {
      return ownWrapper(function cancelTimeout(handle) {
        let id = null;
        if (handle !== null && typeof handle === 'object') id = inst.timerIds.get(handle) ?? null;
        else if (inst.livePrimitive.has(handle)) { id = handle; inst.livePrimitive.delete(handle); }
        host.output(inst.n, 'timer.clear', { timer: id });
      });
    }
    if (FACTORIES.includes(key)) {
      return ownWrapper(function draw() { return host.ask(inst.n, 'draw', { site: key, source: supplied ? 'default' : 'option' }); });
    }
    throw new TypeError(`scheduler replay: ${key} is no option the candidate makes`);
  }

  /** The options object the candidate gets: every member read is an input the host answers (recorder.mjs `optionsPort`). */
  function optionsProxy(inst, view) {
    const target = create(view === null || typeof view !== 'object' ? Object.prototype : getPrototypeOf(view));
    const proxy = new RealProxy(target, {
      get(object, key) { return isImplicitKey(key) ? reflectGet(view, key, view) : host.ask(inst.n, 'read', { object: 'options', key }); },
      has(object, key) { return isImplicitKey(key) ? reflectHas(view, key) : host.ask(inst.n, 'read', { object: 'options', op: 'has', key }); },
      ownKeys() { return host.ask(inst.n, 'read', { object: 'options', op: 'keys' }); },
      getOwnPropertyDescriptor(object, key) {
        if (isImplicitKey(key)) return getOwnPropertyDescriptor(view, key);
        const found = host.ask(inst.n, 'read', { object: 'options', op: 'own', key });
        return found.found ? { value: found.value, writable: true, enumerable: true, configurable: true } : undefined;
      },
      set(object, key, value) { return reflectSet(object, key, value); },
      deleteProperty(object, key) { return reflectDelete(object, key); },
      defineProperty(object, key, descriptor) { return reflectDefine(object, key, descriptor); },
    });
    rawOf.set(proxy, view);
    return proxy;
  }

  /** The scheduler the construction returns, written as the port `scheduler#n`. */
  function members(inst, scheduler) {
    inst.scheduler = scheduler;
    if (scheduler === null || typeof scheduler !== 'object') return scheduler;
    const proxy = new RealProxy(scheduler, {});
    names.set(proxy, `scheduler#${inst.n}`);
    rawOf.set(proxy, scheduler);
    return proxy;
  }

  // ------------------------------------------------------------ inputs

  function deliver(input) {
    const inst = instOf(input.construction);
    switch (input.kind) {
      case 'construct': {
        const options = input.args[0];
        host.input(inst.n, 'call', { call: 0, member: exportName, args: host.slot(inst.n, input.args, 'in') });
        const handed = options !== null && typeof options === 'object' ? [optionsProxy(inst, options), ...input.args.slice(1)] : input.args;
        inst.options = handed[0];
        return run(inst, 0, () => factory(...handed), null, (scheduler) => members(inst, scheduler));
      }
      case 'call': {
        const call = (inst.calls += 1);
        host.input(inst.n, 'call', { call, member: input.member, args: host.slot(inst.n, input.args, 'in') });
        const scheduler = inst.scheduler;
        return run(inst, call, () => apply(scheduler[input.member], scheduler, input.args), input.member);
      }
      case 'control':
      case 'callback': {
        const call = (inst.calls += 1);
        const { fn, holder } = handedTarget(inst, input);
        if (input.kind === 'control') host.input(inst.n, 'control', { call, of: input.of, method: input.method, args: host.slot(inst.n, input.args, 'in') });
        else host.input(inst.n, 'callback', { call, of: input.of, path: input.path, args: host.slot(inst.n, input.args, 'in') });
        return run(inst, call, () => apply(fn, holder, input.args));
      }
      case 'fire': {
        const call = (inst.calls += 1);
        const fn = inst.timerFns.get(input.timer);
        if (typeof fn !== 'function') throw new ReplayInputError(`fired unknown timer ${input.timer} of construction ${inst.n}`);
        inst.livePrimitive.delete(input.timer);
        host.input(inst.n, 'fire', { call, timer: input.timer });
        return run(inst, call, () => fn());
      }
      case 'answer': {
        const deferred = inst.deferreds.get(input.port);
        if (!deferred) throw new ReplayInputError(`answered port ${input.port} of construction ${inst.n}, which has no promise pending`);
        inst.deferreds.delete(input.port);
        if (input.outcome === 'reject') deferred.reject(input.value); else deferred.resolve(input.value);
        return undefined;
      }
      case 'abort': {
        running += 1;
        try { als.run(inst.store, () => input.controller.abort(input.reason)); } finally { running -= 1; }
        return undefined;
      }
      default: throw new ReplayInputError(`no input kind ${input.kind}`);
    }
  }

  /** The function a control or callback input calls: a member of what the candidate handed port call `of`. */
  function handedTarget(inst, input) {
    const args = inst.portArgs.get(input.of);
    if (!args) throw new ReplayInputError(`${input.kind} of port ${input.of}, which construction ${inst.n} never called`);
    if (input.kind === 'control') {
      const holder = args[1];
      const fn = holder?.[input.method];
      if (typeof fn !== 'function') throw new ReplayInputError(`control ${input.method} of port ${input.of} is no function`);
      return { fn, holder };
    }
    const [index, key] = String(input.path).split('.');
    const item = args[Number(index)];
    if (key === undefined) {
      if (typeof item !== 'function') throw new ReplayInputError(`callback ${input.path} of port ${input.of} is no function`);
      return { fn: item, holder: undefined };
    }
    if (typeof item?.[key] !== 'function') throw new ReplayInputError(`callback ${input.path} of port ${input.of} is no function`);
    return { fn: item[key], holder: item };
  }

  api = {
    deliver,
    optionValue,
    portFunction,
    portObject,
    isQuiet: () => running === 0,
    /** The construction whose chain is running (hidden reads), and the member it is delivering (a default parameter's site). */
    current: () => { const inst = als.getStore()?.inst; return inst ? { construction: inst.n, member: inst.delivering[inst.delivering.length - 1] ?? null } : null; },
    sites,
  };
  return api;
}

/** An input the host asked the candidate to deliver that it cannot (a harness or plan error, reported by the host). */
export class ReplayInputError extends RealError {
  constructor(message) {
    super(`scheduler replay input: ${message}`);
    this.name = 'ReplayInputError';
  }
}
