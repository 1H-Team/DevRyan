// The process candidate of the scheduler conformance harness (plan package
// OR2): a scheduler in another process (the Rust core) behind the same
// interface as the JavaScript candidate (candidate.mjs), so the replayer's
// Host, every check, the comparer and its oracles judge it unchanged.
//
// The Host is synchronous (an option read, a port call and its answer happen
// inside the candidate's own call stack), so the process is spoken to
// synchronously: a worker thread owns the child (process-worker.mjs), the main
// thread writes a line and blocks in `Atomics.wait` until the worker has
// posted the child's next line, which it takes with `receiveMessageOnPort`.
// Every wait has a deadline and names what it waited for.
//
// The protocol (`devryan-scheduler-candidate`, version 1) is one JSON object
// per line, in both directions. A request carries `t` (to the process) or `q`
// (from it); its answer is `{ r }`. Either side may make requests of the other
// while it waits for an answer, so a request is answered only after the
// requests it caused (a port call made while a member runs, an option read).
//
//   to the process:   hello {protocol, version}
//                     construct {c, args}             the factory, call 0
//                     call {c, call, member, args}    a member of construction c's scheduler
//                     invoke {c, call, fn, args}      a function it handed out (control, callback, timer)
//                     answer {c, port, outcome, value}  a port's promise settles
//                     run {}                          its jobs run (one microtask of this thread)
//                     sync {}                         every object it holds, as it is now
//   answers:          {r: {return: v} | {throw: v} | {promise: true}, pending}  (pending: jobs are queued)
//   from the process: get {c, h, key}                 a member of an object the host handed it
//                     callHost {c, h, args}           a function the host handed it (a port, an option)
//                     ask {c, kind, fields}           a hidden read (draw, clock, env)
//                     settle {c, call, outcome, value}  a member's promise settled (its own observer)
//                     answered {c, port, outcome}     a port's promise settled (its own observer)
//                     unhandled {c}                   a rejection nothing handled
//                     refuse {c, detail}              what it does not reproduce: the case is not-ported
//   a fatal error of the process:  {x: message}
//
// Values cross as JSON with tags under `$`: `u` undefined, `n` a number JSON
// cannot hold (`v`: NaN, Infinity, -Infinity, -0), `o` an object and `a` an
// array (`id`, own members in order), `r` an object already crossed (`id`),
// `e` an error (`id`, `cls`, `message`, own members), `f` a function of the
// process (`id`, `name`), `h` a stand-in of the host (`id`, kind `k`), `s` the
// construction's scheduler, `x` a value the process cannot hold (`id`, `what`).
// An object keeps one id for good (the host's negative, the process's
// positive), so identity crosses both ways; content crosses whole each time
// and is written into the one live object in place.
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { ReplayInputError } from './candidate.mjs';

export const PROTOCOL = 'devryan-scheduler-candidate';
export const PROTOCOL_VERSION = 1;
const WORKER_URL = new URL('./process-worker.mjs', import.meta.url);
const DEFAULT_DEADLINE_MS = 60_000;
const RealProxy = Proxy;
const { apply, get: reflectGet, has: reflectHas } = Reflect;
const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf } = Object;
const isPrototypeOf = Object.prototype.isPrototypeOf;
const hrMs = () => Number(process.hrtime.bigint() / 1_000_000n);

/** A failure of the process or of the protocol (never a judgement of the scheduler: the case is not judged). */
export class CandidateProcessError extends Error {
  constructor(message) { super(`scheduler process candidate: ${message}`); this.name = 'CandidateProcessError'; }
}

// ------------------------------------------------------------------ the synchronous channel

/** Spawns `command args` under a worker thread; `exchange(message, onRequest)` sends one request and returns its answer. */
export function openChannel({ command, args = [], deadlineMs = DEFAULT_DEADLINE_MS }) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_URL, { workerData: { command, args, port: port2, signal }, transferList: [port2] });
  worker.unref();
  let closed = null;
  let open = true;
  let depth = 0;
  let abandoned = false; // an exchange was left by a throw: the process waits for an answer it will not get

  /** The next message of the worker, waiting at most `ms` for `what`. */
  function next(what, ms = deadlineMs) {
    const until = hrMs() + ms;
    for (;;) {
      const seen = Atomics.load(signal, 0);
      const got = receiveMessageOnPort(port1);
      if (got) return got.message;
      const left = until - hrMs();
      if (left <= 0 || Atomics.wait(signal, 0, seen, left) === 'timed-out') {
        const late = receiveMessageOnPort(port1);
        if (late) return late.message;
        throw new CandidateProcessError(`no line from ${command} within ${ms} ms while waiting for ${what}`);
      }
    }
  }

  function line(what) {
    for (;;) {
      if (closed) throw new CandidateProcessError(`${command} ended (code ${closed.code}, signal ${closed.signal}) while waiting for ${what}${closed.stderr ? `; stderr: ${closed.stderr.slice(-2000)}` : ''}`);
      const message = next(what);
      if (message.spawned !== undefined) continue;
      if (message.closed) { closed = message.closed; continue; }
      if (typeof message.line === 'string') return message.line;
    }
  }

  const write = (message) => { port1.postMessage({ write: `${JSON.stringify(message)}\n` }); };

  /** Sends `message` and returns its answer; requests of the process meanwhile go to `onRequest`, whose result answers them. */
  function exchange(message, onRequest) {
    if (!open) throw new CandidateProcessError('the channel is closed');
    depth += 1;
    try { return exchangeOnce(message, onRequest); } catch (error) { abandoned = true; throw error; } finally { depth -= 1; }
  }

  function exchangeOnce(message, onRequest) {
    write(message);
    const what = `the answer to ${message.t ?? 'a request'}`;
    for (;;) {
      const text = line(what);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new CandidateProcessError(`a line that is no JSON: ${text.slice(0, 200)}`); }
      if (parsed === null || typeof parsed !== 'object') throw new CandidateProcessError(`a line that is no object: ${text.slice(0, 200)}`);
      if ('x' in parsed) throw new CandidateProcessError(`the process failed: ${String(parsed.x).slice(0, 2000)}`);
      if ('r' in parsed) return parsed;
      if (typeof parsed.q !== 'string') throw new CandidateProcessError(`a line that is neither an answer nor a request: ${text.slice(0, 200)}`);
      write({ r: onRequest(parsed) });
    }
  }

  /** Ends the process: stdin closed, its end awaited (bounded), killed if it does not end. The worker ends with it. */
  function close() {
    if (!open) return closed;
    open = false;
    port1.postMessage({ end: true });
    try {
      while (!closed) { const message = next(`${command} to exit after stdin closed`, 5_000); if (message.closed) closed = message.closed; }
    } catch {
      port1.postMessage({ kill: true });
      try { while (!closed) { const message = next(`${command} to exit after SIGKILL`, 5_000); if (message.closed) closed = message.closed; } } catch { /* reported below */ }
    }
    port1.close();
    void worker.terminate();
    return closed;
  }

  return { exchange, close, get closed() { return closed; }, get abandoned() { return abandoned && depth === 0; } };
}

// ------------------------------------------------------------------ the candidate

const isSignal = (value) => value !== null && typeof value === 'object' && apply(isPrototypeOf, AbortSignal.prototype, [value]);
const IMPLICIT_READS = new Set(['then', 'constructor', 'toJSON']);
const isImplicitKey = (key) => (typeof key === 'symbol' ? Symbol.keyFor(key) === undefined && key.description?.startsWith('Symbol.') : IMPLICIT_READS.has(key));
const FACTORIES = ['createTaskId', 'createLeaseToken', 'createWaveId'];

/**
 * A `makeCandidate` for the replayer (replay.mjs `replayCase`): each case gets
 * its own process `command args`, which must speak the protocol above.
 */
export function processCandidate({ command, args = [], deadlineMs = DEFAULT_DEADLINE_MS }) {
  return (context) => createProcessCandidate({ ...context, command, args, deadlineMs });
}

export function createProcessCandidate({ host, names, rawOf, clock, sites = null, exports = {}, exportName = 'createManagedTaskScheduler', savedState = null, command, args = [], deadlineMs = DEFAULT_DEADLINE_MS }) {
  const errorClasses = { ManagedOrchestrationError: exports.ManagedOrchestrationError };
  const channel = openChannel({ command, args, deadlineMs });
  const insts = new Map();
  const byId = new Map(); // id -> live object (both sides' ids)
  const idOf = new WeakMap(); // live object -> id
  const standIns = new Map(); // id -> { kind, construction, name, key, supplied }
  const stubs = new Map(); // process function id -> its stub
  let hostIds = 0;
  let running = 0;
  let scheduled = false;
  let stopped = false;

  const instOf = (construction) => {
    let inst = insts.get(construction);
    if (!inst) {
      inst = { n: construction, calls: 0, ports: 0, timers: 0, timerFns: new Map(), timerIds: new WeakMap(), livePrimitive: new Set(), portArgs: new Map(), answers: new Map(), portObjects: new Map(), handed: new WeakMap(), scheduler: null };
      insts.set(construction, inst);
    }
    return inst;
  };
  const isWrapper = (item) => rawOf.get(item) !== undefined;
  const ownWrapper = (wrapper) => { rawOf.set(wrapper, wrapper); return wrapper; };
  const register = (item, id) => { byId.set(id, item); idOf.set(item, id); return item; };
  const hostId = (item) => { let id = idOf.get(item); if (id === undefined) { hostIds -= 1; id = hostIds; register(item, id); } return id; };
  const standIn = (item, record) => { const id = hostId(item); standIns.set(id, record); return item; };

  // ---------------------------------------------------------------- values

  function encode(value, seen = new Set()) {
    if (value === undefined) return { $: 'u' };
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return { $: 'n', v: 'NaN' };
      if (value === Infinity) return { $: 'n', v: 'Infinity' };
      if (value === -Infinity) return { $: 'n', v: '-Infinity' };
      if (Object.is(value, -0)) return { $: 'n', v: '-0' };
      return value;
    }
    if (typeof value !== 'object' && typeof value !== 'function') return opaque(value, typeof value);
    const known = idOf.get(value);
    if (known !== undefined && standIns.has(known)) { const record = standIns.get(known); return { $: 'h', id: known, k: record.kind, ...(record.name !== undefined ? { name: record.name } : {}), ...(record.key !== undefined ? { key: record.key } : {}) }; }
    if (known !== undefined && stubs.get(known) === value) return { $: 'f', id: known };
    if (typeof value === 'function') {
      const raw = rawOf.get(value);
      if (raw !== undefined && raw !== value) return encode(raw, seen);
      return opaque(value, 'function');
    }
    // A proxy the candidate made over something it handed a port: what it stands for.
    const raw = rawOf.get(value);
    if (raw !== undefined && raw !== value && idOf.has(raw)) return encode(raw, seen);
    if (insts.size && [...insts.values()].some((inst) => inst.scheduler === value)) return { $: 's' };
    if (isSignal(value)) return opaque(value, 'AbortSignal');
    const id = hostId(value);
    if (seen.has(value)) return { $: 'r', id };
    seen.add(value);
    if (value instanceof Error) {
      const own = Reflect.ownKeys(value).filter((key) => typeof key === 'string' && key !== 'message' && key !== 'stack');
      return { $: 'e', id, cls: value.constructor?.name ?? 'Error', name: String(value.name), message: String(value.message), p: own.map((key) => [key, encode(value[key], seen)]) };
    }
    if (Array.isArray(value)) return { $: 'a', id, i: value.map((item) => encode(item, seen)) };
    const prototype = getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return opaque(value, prototype?.constructor?.name ?? 'object');
    const members = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return opaque(value, 'object with a symbol key');
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!('value' in descriptor)) return opaque(value, 'object with an accessor');
      members.push([key, encode(descriptor.value, seen)]);
    }
    return { $: 'o', id, p: members };
  }

  function opaque(value, what) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return { $: 'x', what };
    return { $: 'x', id: hostId(value), what };
  }

  function decode(wire, construction) {
    if (wire === null || typeof wire !== 'object') return wire;
    if (Array.isArray(wire)) throw new CandidateProcessError('a bare array on the wire');
    switch (wire.$) {
      case 'u': return undefined;
      case 'n': return { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 }[wire.v];
      case 'r': case 'x': case 'h': {
        if (!byId.has(wire.id)) throw new CandidateProcessError(`a reference to object ${wire.id}, which never crossed`);
        return byId.get(wire.id);
      }
      case 's': return instOf(construction).scheduler;
      case 'f': {
        let stub = stubs.get(wire.id);
        if (!stub) {
          const name = typeof wire.name === 'string' ? wire.name : '';
          stub = { [name]: function () { throw new TypeError('scheduler process candidate: a function of the process is called by the host, through deliver'); } }[name];
          if (stub.name !== name) defineProperty(stub, 'name', { value: name, configurable: true });
          stubs.set(wire.id, stub);
          register(stub, wire.id);
        }
        return stub;
      }
      case 'a': {
        let array = byId.get(wire.id);
        if (!array) array = register([], wire.id); else array.length = 0;
        for (const item of wire.i) array.push(decode(item, construction));
        return array;
      }
      case 'o': {
        let object = byId.get(wire.id);
        if (!object) object = register({}, wire.id); else for (const key of Reflect.ownKeys(object)) delete object[key];
        for (const [key, item] of wire.p) object[key] = decode(item, construction);
        return object;
      }
      case 'e': {
        let error = byId.get(wire.id);
        if (!error) {
          const Made = errorClasses[wire.cls] ?? globalThis[wire.cls];
          const made = typeof Made === 'function' && Made.prototype instanceof Error || Made === Error ? Made : Error;
          error = made === errorClasses.ManagedOrchestrationError ? new made(undefined, wire.message) : new made(wire.message);
          register(error, wire.id);
        }
        for (const [key, item] of wire.p) error[key] = decode(item, construction);
        return error;
      }
      default: throw new CandidateProcessError(`an unknown value tag ${JSON.stringify(wire.$)}`);
    }
  }

  // ---------------------------------------------------------------- requests of the process

  function refuse(detail) {
    stopped = true;
    return host.stop({ outcome: 'not-ported', check: 'not-ported', detail: `the candidate does not reproduce ${detail}` });
  }

  function onRequest(request) {
    const c = request.c;
    switch (request.q) {
      case 'get': return encode(memberOf(c, request.h, request.key));
      case 'callHost': return callHost(c, request.h, (request.args ?? []).map((item) => decode(item, c)));
      case 'ask': return encode(host.ask(c, request.kind, request.fields));
      case 'settle': {
        const value = decode(request.value, c);
        host.output(c, 'settle', { call: request.call, outcome: request.outcome, value: host.slot(c, value, 'out') });
        return null;
      }
      case 'answered': {
        const inst = instOf(c);
        if (!inst.answers.has(request.port)) throw new CandidateProcessError(`port ${request.port} settled with no answer delivered`);
        const value = inst.answers.get(request.port);
        inst.answers.delete(request.port);
        host.input(c, 'answer', { port: request.port, outcome: request.outcome, value: host.slot(c, value, 'in') });
        return null;
      }
      case 'unhandled': host.unhandled += 1; return null;
      case 'refuse': return refuse(String(request.detail));
      default: throw new CandidateProcessError(`an unknown request ${JSON.stringify(request.q)}`);
    }
  }

  /** A member of an object the host handed the process: the options (each a read the host answers) or a port object. */
  function memberOf(c, handle, key) {
    const record = standIns.get(handle);
    if (!record) throw new CandidateProcessError(`a member of ${handle}, which is no stand-in of the host`);
    if (typeof key !== 'string') throw new CandidateProcessError('a member key that is no string');
    if (record.kind === 'options') return host.ask(c, 'read', { object: 'options', key });
    if (record.kind !== 'port-object') return refuse(`a member read of a ${record.kind}`);
    const inst = instOf(c);
    if (isImplicitKey(key)) return undefined;
    if (host.nextIsRead(c, record.name, key)) return host.ask(c, 'read', { object: record.name, key });
    const cache = inst.portObjects.get(record.name) ?? new Map();
    inst.portObjects.set(record.name, cache);
    if (!cache.has(key)) cache.set(key, portFunction(c, `${record.name}.${key}`, key));
    return cache.get(key);
  }

  /** A call of a function the host handed the process. */
  function callHost(c, handle, args) {
    const record = standIns.get(handle);
    if (!record) throw new CandidateProcessError(`a call of ${handle}, which is no stand-in of the host`);
    if (record.kind === 'port-function') return portCall(instOf(c), record.name, args);
    if (record.kind !== 'option') return refuse(`a call of a ${record.kind}`);
    try {
      return { return: encode(apply(byId.get(handle), undefined, args)) };
    } catch (error) {
      if (error?.name === 'ReplayStop' || stopped) throw error;
      return { throw: encode(error) };
    }
  }

  /** What the process hands a port: its functions and objects holding functions stand for inputs (candidate.mjs `handToPort`). */
  function handToPort(inst, portName, port, args) {
    let changed = false;
    const holds = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !isWrapper(value) && Object.values(value).some((item) => typeof item === 'function');
    const out = args.map((arg, index) => {
      if (isWrapper(arg)) return arg;
      if (typeof arg === 'function') {
        changed = true;
        const wrapper = function handed() { throw new TypeError('scheduler replay: a handed function is called by the host, through deliver'); };
        rawOf.set(wrapper, arg);
        return wrapper;
      }
      if (!holds(arg)) return arg;
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

  /** A port call: the effect, the inputs the recording places inside it, its answer (candidate.mjs `portCall`). */
  function portCall(inst, name, args) {
    const port = (inst.ports += 1);
    const handed = handToPort(inst, name, port, args);
    const fields = { port, name, args: host.slot(inst.n, handed, 'out') };
    if (savedState && name === savedState.port) fields.ledger = { pending: handed[savedState.arg ?? 0] };
    host.output(inst.n, 'port', fields);
    inst.portArgs.set(port, args);
    running += 1;
    let answer;
    try { answer = host.portAnswer(inst.n, port); } finally { running -= 1; }
    if (answer.outcome === 'return') return { return: encode(answer.value) };
    if (answer.outcome === 'throw') return { throw: encode(answer.value) };
    if (answer.settle) {
      inst.answers.set(port, answer.settle.value);
      return { promise: port, settle: { outcome: answer.settle.outcome, value: encode(answer.settle.value) } };
    }
    return { promise: port };
  }

  // ---------------------------------------------------------------- stand-ins the host asks for

  function portFunction(construction, name, displayName) {
    const wrapper = function () { throw new TypeError('scheduler process candidate: a port stand-in is called by the process'); };
    defineProperty(wrapper, 'name', { value: displayName, configurable: true });
    return standIn(ownWrapper(wrapper), { kind: 'port-function', construction, name });
  }

  function portObject(construction, name) {
    const target = {};
    const proxy = new RealProxy(target, {
      get(object, key) { return isImplicitKey(key) ? reflectGet(object, key, object) : refuse(`a read of ${name} by the host`); },
      has(object, key) { return isImplicitKey(key) ? reflectHas(object, key) : refuse(`a read of ${name} by the host`); },
    });
    names.set(proxy, name);
    rawOf.set(proxy, target);
    return standIn(proxy, { kind: 'port-object', construction, name });
  }

  /** The option members the recorder wraps (candidate.mjs `optionValue`), here called by the process through `callHost`. */
  function optionValue(construction, key, { supplied = false } = {}) {
    const inst = instOf(construction);
    const record = { kind: 'option', construction, key, supplied };
    if (key === 'now') return standIn(ownWrapper(function now() { return host.ask(inst.n, 'clock', { source: supplied ? clock : 'option' }); }), record);
    if (key === 'scheduleTimeout') {
      return standIn(ownWrapper(function scheduleTimeout(fn, delay) {
        const timer = (inst.timers += 1);
        const handleKind = host.timerHandle(inst.n);
        host.output(inst.n, 'timer.set', { timer, delay: host.slot(inst.n, delay, 'out'), handle: handleKind });
        inst.timerFns.set(timer, fn);
        if (handleKind === 'primitive') { inst.livePrimitive.add(timer); return timer; }
        const handle = { replayTimer: timer };
        inst.timerIds.set(handle, timer);
        return handle;
      }), record);
    }
    if (key === 'cancelTimeout') {
      return standIn(ownWrapper(function cancelTimeout(handle) {
        let id = null;
        if (handle !== null && typeof handle === 'object') id = inst.timerIds.get(handle) ?? null;
        else if (inst.livePrimitive.has(handle)) { id = handle; inst.livePrimitive.delete(handle); }
        host.output(inst.n, 'timer.clear', { timer: id });
      }), record);
    }
    if (FACTORIES.includes(key)) return standIn(ownWrapper(function draw() { return host.ask(inst.n, 'draw', { site: key, source: supplied ? 'default' : 'option' }); }), record);
    throw new TypeError(`scheduler replay: ${key} is no option the candidate makes`);
  }

  // ---------------------------------------------------------------- inputs

  /** Sends one input to the process and reports what the call did (candidate.mjs `run`). */
  function send(inst, call, message) {
    running += 1;
    let answer;
    try { answer = channel.exchange(message, onRequest); } finally { running -= 1; }
    if (answer.pending) schedule();
    if (call === null) return undefined;
    const result = answer.r;
    if ('throw' in result) { host.output(inst.n, 'throw', { call, error: host.slot(inst.n, decode(result.throw, inst.n), 'out') }); return undefined; }
    if (result.promise === true) {
      host.output(inst.n, 'return', { call, promise: true });
      if (host.continuationPlaced?.(inst.n, call)) refuse(`an input the recording places in the continuation of call ${call} (placed settle)`);
      return undefined;
    }
    const value = decode(result.return, inst.n);
    host.output(inst.n, 'return', { call, value: host.slot(inst.n, value, 'out') });
    return value;
  }

  /** The process's jobs run in one microtask of this thread, queued after the deliveries that queued them. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped || !host.live || host.stopped || channel.abandoned) return;
      running += 1;
      try { channel.exchange({ t: 'run' }, onRequest); } catch (error) { if (error?.name !== 'ReplayStop') host.note('candidate-process', String(error?.message ?? error)); } finally { running -= 1; }
    });
  }

  function deliver(input) {
    if (channel.abandoned) return host.stop({ outcome: 'different', check: 'candidate-process', detail: 'an input after the process was left waiting for an answer' });
    try { return deliverInput(input); } catch (error) {
      if (error instanceof CandidateProcessError) host.stop({ outcome: 'different', check: 'candidate-process', detail: error.message });
      throw error;
    }
  }

  function deliverInput(input) {
    const inst = instOf(input.construction);
    switch (input.kind) {
      case 'construct': {
        host.input(inst.n, 'call', { call: 0, member: exportName, args: host.slot(inst.n, input.args, 'in') });
        const [options, ...rest] = input.args;
        const wired = [options !== null && typeof options === 'object' ? encode(standIn(options, { kind: 'options', construction: inst.n })) : encode(options), ...rest.map((item) => encode(item))];
        const scheduler = new RealProxy({}, {});
        names.set(scheduler, `scheduler#${inst.n}`);
        rawOf.set(scheduler, scheduler);
        inst.scheduler = scheduler;
        return send(inst, 0, { t: 'construct', c: inst.n, args: wired });
      }
      case 'call': {
        const call = (inst.calls += 1);
        host.input(inst.n, 'call', { call, member: input.member, args: host.slot(inst.n, input.args, 'in') });
        return send(inst, call, { t: 'call', c: inst.n, call, member: input.member, args: input.args.map((item) => encode(item)) });
      }
      case 'control':
      case 'callback': {
        const call = (inst.calls += 1);
        const fn = handedTarget(inst, input);
        if (input.kind === 'control') host.input(inst.n, 'control', { call, of: input.of, method: input.method, args: host.slot(inst.n, input.args, 'in') });
        else host.input(inst.n, 'callback', { call, of: input.of, path: input.path, args: host.slot(inst.n, input.args, 'in') });
        return send(inst, call, { t: 'invoke', c: inst.n, call, fn: idOf.get(fn), args: input.args.map((item) => encode(item)) });
      }
      case 'fire': {
        const call = (inst.calls += 1);
        const fn = inst.timerFns.get(input.timer);
        if (typeof fn !== 'function') throw new ReplayInputError(`fired unknown timer ${input.timer} of construction ${inst.n}`);
        inst.livePrimitive.delete(input.timer);
        host.input(inst.n, 'fire', { call, timer: input.timer });
        if (!stubs.has(idOf.get(fn))) return refuse(`a timer whose function is not the process's`);
        return send(inst, call, { t: 'invoke', c: inst.n, call, fn: idOf.get(fn), args: [] });
      }
      case 'answer': {
        if (inst.answers.has(input.port)) throw new ReplayInputError(`answered port ${input.port} of construction ${inst.n} twice`);
        inst.answers.set(input.port, input.value);
        return send(inst, null, { t: 'answer', c: inst.n, port: input.port, outcome: input.outcome, value: encode(input.value) });
      }
      case 'abort': return refuse('an abort through a signal the host holds');
      default: throw new ReplayInputError(`no input kind ${input.kind}`);
    }
  }

  /** The process function a control or callback input calls (candidate.mjs `handedTarget`). */
  function handedTarget(inst, input) {
    const args = inst.portArgs.get(input.of);
    if (!args) throw new ReplayInputError(`${input.kind} of port ${input.of}, which construction ${inst.n} never called`);
    let fn;
    if (input.kind === 'control') fn = args[1]?.[input.method];
    else {
      const [index, key] = String(input.path).split('.');
      fn = key === undefined ? args[Number(index)] : args[Number(index)]?.[key];
    }
    if (typeof fn !== 'function' || !stubs.has(idOf.get(fn))) throw new ReplayInputError(`${input.kind} ${input.method ?? input.path} of port ${input.of} is no function of the process`);
    return fn;
  }

  // ---------------------------------------------------------------- the start

  const hello = channel.exchange({ t: 'hello', protocol: PROTOCOL, version: PROTOCOL_VERSION }, onRequest).r;
  if (hello?.protocol !== PROTOCOL || hello?.version !== PROTOCOL_VERSION) {
    channel.close();
    throw new CandidateProcessError(`${command} speaks ${JSON.stringify(hello)}, not ${PROTOCOL} ${PROTOCOL_VERSION}`);
  }

  return {
    deliver,
    optionValue,
    portFunction,
    portObject,
    isQuiet: () => running === 0 && !scheduled,
    current: () => null,
    sites,
    members: hello.members ?? [],
    /** Every object the process holds, written into its live object as it is now (before the final checks). */
    settleValues() {
      if (channel.closed) return;
      // A process left waiting (the host stopped inside one of its requests) still answers `sync` there.
      const answer = channel.exchange({ t: 'sync' }, () => { throw new CandidateProcessError('a request of the process while it syncs'); });
      for (const wire of answer.r ?? []) decode(wire, 0);
    },
    close() { return channel.close(); },
  };
}
