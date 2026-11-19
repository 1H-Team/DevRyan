#!/usr/bin/env node
// The JavaScript arm of the job-order differential test (jobs-differential.mjs):
// runs programs of jobs-programs.mjs on V8's own promises and async
// functions, Node's own tick queue and checkpoint (`runNextTicks`), Node's
// own timers and immediates (`processTimers`, `processImmediate` of
// lib/internal/timers.js), with only libuv's loop time replaced by a
// virtual clock. Its Rust twin is `ledger-native-probe jobs`, which runs the
// same programs on the crate's `js` and `host` modules under the same clock.
//
// The interpreter adds no job of its own: an async function of a program is
// one async function here, whose statements (try blocks included) run in it
// with an explicit stack, and one `await` statement is one `await`. A
// compiled function of a program (`co`: an async function or an async
// generator) is JavaScript source made from its statements, so `await`,
// `yield`, `yield*`, `for await` with its exits, `try`/`catch`/`finally` and
// `return` are the language's own, and every other statement is one call of
// the interpreter's synchronous step. Two AsyncLocalStorage stores (`a`,
// `b`) tag every log entry with the frame it runs in; abort controllers,
// `AbortSignal.any` and abort listeners are Node's own, and so are the
// event emitters (`node:events`).
//
//   node --expose-internals jobs-js-arm.mjs < programs (one JSON program per line)
//   stdout: one line per program, its trace joined by spaces
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { internalBinding } = require('internal/test/binding');
const binding = internalBinding('timers');
const { getTimerCallbacks, timerListMap, timerListQueue, immediateInfoFields, immediateQueue } = require('internal/timers');
const { setupTaskQueue } = require('internal/process/task_queues');
const linkedList = require('internal/linkedlist');

let now = 0;
binding.getLibuvNow = () => now;
binding.scheduleTimer = () => {};
binding.toggleTimerRef = () => {};
binding.toggleImmediateRef = () => {};
Date.now = () => now;
const { runNextTicks } = setupTaskQueue();
const { processTimers, processImmediate } = getTimerCallbacks(runNextTicks);
const immediateInfo = internalBinding('timers').immediateInfo;

let trace = [];
// The program's statements the rejection listener runs after its report.
let onUnhandled = () => {};
process.on('unhandledRejection', (reason) => { trace.push(`U:${show(reason)}${frameTag()}`); onUnhandled(); });

// The values a program makes by kind (`{ made }`), shown by kind: what
// `JSON.stringify` would make of a Buffer, a Map or a function says nothing
// the trace needs, and a bigint would throw. Every other value is shown as
// `JSON.stringify` shows it.
const MADE = new WeakMap();
class Instance {}
const MAKERS = {
  object: () => ({ a: 1 }), nullProto: () => Object.create(null), ownThen: () => ({ then: undefined }), buffer: () => Buffer.from('ab'),
  uint8: () => new Uint8Array(2), error: () => new Error('e'), function: () => () => {}, instance: () => new Instance(), map: () => new Map(),
  set: () => new Set(), date: () => new Date(0), boxed: () => new Number(1),
};
const make = (kind) => {
  if (kind === 'bigint') return 1n;
  const value = (MAKERS[kind] ?? MAKERS.object)();
  MADE.set(value, kind);
  return value;
};
function shown(key, value) {
  const original = this[key];
  if (typeof original === 'bigint') return '<bigint>';
  if (original !== null && (typeof original === 'object' || typeof original === 'function') && MADE.has(original)) return `<${MADE.get(original)}>`;
  return value;
}
const show = (value) => (value === undefined ? 'undefined' : JSON.stringify(value, shown));
const STORES = { a: new AsyncLocalStorage(), b: new AsyncLocalStorage() };
const storeOf = (name) => (name === 'b' ? STORES.b : STORES.a);
/** The frame an entry runs in: `~a/b` (`-` for a store without a value), nothing when neither has one. */
function frameTag() {
  const [a, b] = [STORES.a.getStore(), STORES.b.getStore()].map((value) => (value === undefined ? '-' : show(value)));
  return a === '-' && b === '-' ? '' : `~${a}/${b}`;
}

function resetLoop(time) {
  for (const key of Object.keys(timerListMap)) {
    const list = timerListMap[key];
    for (let timer = linkedList.peek(list); timer; timer = linkedList.peek(list)) {
      clearTimeout(timer);
      if (linkedList.peek(list) === timer) linkedList.remove(timer);
    }
    delete timerListMap[key];
  }
  while (timerListQueue.peek()) timerListQueue.shift();
  for (let immediate = immediateQueue.head; immediate; immediate = immediate._idleNext) clearImmediate(immediate);
  now = time;
}

function interpret(program) {
  const regs = new Map(), resolvers = new Map(), timers = new Map(), immediates = new Map();
  const controllers = new Map(), signals = new Map(), listeners = new Map(), snaps = new Map();
  const emitters = new Map(), handlers = new Map();
  // What the compiled functions made: generator objects and sync iterables.
  const generators = new WeakSet(), syncIterables = new WeakSet(), asyncIterables = new WeakSet();
  // What `for await` and `yield*` iterate: a generator, an array or a sync
  // iterable as it is, anything else as an empty array.
  const iterableOf = (value) => (generators.has(value) || syncIterables.has(value) || asyncIterables.has(value) || Array.isArray(value) ? value : []);
  const log = (entry) => trace.push(`${entry}${frameTag()}`);
  const fns = program.fns ?? [];
  const valueOf = (target, arg) => {
    if (target === undefined) return undefined;
    if (Object.hasOwn(target, 'val')) return target.val;
    if (Object.hasOwn(target, 'arg')) return arg;
    if (Object.hasOwn(target, 'made')) return make(target.made);
    return regs.has(target.reg) ? regs.get(target.reg) : 'missing';
  };
  const items = (list, arg) => list.map((target) => valueOf(target, arg));
  const settledOf = (outcomes) => outcomes.map((outcome) => (outcome.status === 'fulfilled' ? { ok: outcome.value } : { err: outcome.reason }));
  // A synchronous body: a callback, an executor, a timer, a tick. Returns `{ give }` or throws.
  const execSync = (stmts, arg) => {
    for (const st of stmts ?? []) {
      const out = step(st, arg);
      if (out) return out;
    }
    return { give: undefined };
  };
  const callback = (stmts) => (stmts === undefined ? undefined : (arg) => execSync(stmts, arg).give);
  // A callback of the loop or of a signal: what it throws (an emit's
  // unhandled error, a listener's throw) is logged, never uncaught.
  const guarded = (stmts) => { try { execSync(stmts); } catch (error) { log(`X:${show(error)}`); } };
  // One statement any body may run; `{ give }` ends a synchronous body.
  function step(st, arg) {
    switch (st.s) {
      case 'log': log(st.v ? `${st.l}=${show(valueOf(st.v, arg))}` : `${st.l}@${now}`); return null;
      case 'call': { const promise = runFn(st.f); if (st.as) regs.set(st.as, promise); return null; }
      case 'give': return { give: valueOf(st.v, arg) };
      case 'throw': throw valueOf(st.v, arg);
      case 'new': {
        const promise = new Promise((resolve, reject) => {
          resolvers.set(st.as, { resolve, reject });
          execSync(st.body, arg);
        });
        regs.set(st.as, promise);
        return null;
      }
      case 'settle': { const entry = resolvers.get(st.p); if (entry) (st.ok ? entry.resolve : entry.reject)(valueOf(st.v, arg)); return null; }
      case 'then': regs.set(st.as, promiseOf(st.p).then(callback(st.ok), callback(st.err))); return null;
      case 'catch': regs.set(st.as, promiseOf(st.p).catch(callback(st.err))); return null;
      case 'finally': regs.set(st.as, promiseOf(st.p).finally(callback(st.body))); return null;
      case 'all': regs.set(st.as, Promise.all(items(st.of, arg))); return null;
      case 'allSettled': regs.set(st.as, Promise.allSettled(items(st.of, arg)).then(settledOf)); return null;
      case 'race': regs.set(st.as, Promise.race(items(st.of, arg))); return null;
      case 'resolve': regs.set(st.as, Promise.resolve(valueOf(st.v, arg))); return null;
      case 'reject': regs.set(st.as, Promise.reject(valueOf(st.v, arg))); return null;
      case 'handle': promiseOf(st.p).catch(() => {}); return null;
      case 'tick': process.nextTick(() => { guarded(st.body); }); return null;
      case 'micro': queueMicrotask(() => { guarded(st.body); }); return null;
      case 'timeout': {
        const timer = setTimeout(() => { guarded(st.body); }, st.ms);
        if (st.unref) timer.unref();
        timers.set(st.n, timer);
        return null;
      }
      case 'interval': {
        let left = st.times;
        const timer = setInterval(() => {
          left -= 1;
          if (left <= 0) clearInterval(timer);
          guarded(st.body);
        }, st.ms);
        if (st.unref) timer.unref();
        timers.set(st.n, timer);
        return null;
      }
      case 'clear': clearTimeout(timers.get(st.n)); return null;
      case 'immediate': immediates.set(st.n, setImmediate(() => { guarded(st.body); })); return null;
      case 'clearImmediate': clearImmediate(immediates.get(st.n)); return null;
      // The callback blocks the loop for `ms`: the clock moves on meanwhile.
      case 'block': now += st.ms; return null;
      case 'run': storeOf(st.st).run(valueOf(st.v, arg), () => execSync(st.body, arg)); return null;
      case 'exit': storeOf(st.st).exit(() => execSync(st.body, arg)); return null;
      case 'snap': snaps.set(st.as, AsyncLocalStorage.snapshot()); return null;
      case 'replay': { const replay = snaps.get(st.f); if (replay) replay(() => execSync(st.body, arg)); else execSync(st.body, arg); return null; }
      case 'ctl': { const controller = new AbortController(); controllers.set(st.n, controller); signals.set(st.n, controller.signal); return null; }
      case 'any': signals.set(st.n, AbortSignal.any(st.of.map((name) => signals.get(name)).filter(Boolean))); return null;
      case 'listen': {
        const signal = signals.get(st.g);
        if (!signal) return null;
        const listener = () => { guarded(st.body); };
        listeners.set(st.id, { signal, listener });
        signal.addEventListener('abort', listener, { once: Boolean(st.once) });
        return null;
      }
      case 'unlisten': { const entry = listeners.get(st.id); if (entry) entry.signal.removeEventListener('abort', entry.listener); return null; }
      case 'abort': controllers.get(st.c)?.abort(valueOf(st.v, arg)); return null;
      case 'checkAbort': signals.get(st.g)?.throwIfAborted(); return null;
      case 'reason': { const signal = signals.get(st.g); log(`${st.l}=${signal ? `${signal.aborted}:${show(signal.reason)}` : 'none'}`); return null; }
      // Event emitters (Node's own).
      case 'em': emitters.set(st.n, new EventEmitter()); return null;
      case 'on': {
        const emitter = emitters.get(st.e);
        if (!emitter) return null;
        const listener = (value) => { execSync(st.body, value); };
        handlers.set(st.id, listener);
        addTo(emitter, st.mode, st.ev, listener);
        return null;
      }
      case 'onAgain': { const emitter = emitters.get(st.e), listener = handlers.get(st.id); if (emitter && listener) addTo(emitter, st.mode, st.ev, listener); return null; }
      case 'off': { const emitter = emitters.get(st.e), listener = handlers.get(st.id); if (emitter && listener) emitter.removeListener(st.ev, listener); return null; }
      case 'offAll': { const emitter = emitters.get(st.e); if (emitter) { if (st.ev === undefined) emitter.removeAllListeners(); else emitter.removeAllListeners(st.ev); } return null; }
      case 'emit': { const emitter = emitters.get(st.e); if (!emitter) return null; const had = emitter.emit(st.ev, valueOf(st.v, arg)); if (st.l) log(`${st.l}=${had}`); return null; }
      case 'count': { const emitter = emitters.get(st.e); log(`${st.l}=${emitter ? emitter.listenerCount(st.ev) : 'none'}`); return null; }
      // Compiled functions, generators and what they iterate.
      case 'cocall': { const made = callCompiled(st.f); if (st.as && made !== undefined) regs.set(st.as, made); return null; }
      case 'gcall': genCall(st, arg); return null;
      case 'burst': for (const call of st.of) genCall({ ...call, g: st.g }, arg); return null;
      case 'arr': regs.set(st.as, items(st.of, arg)); return null;
      case 'syncIt': {
        const values = items(st.of, arg), returned = valueOf(st.retv, arg);
        const iterable = { [Symbol.iterator]() {
          let at = 0;
          const iterator = { next: () => (at < values.length ? { value: values[at++], done: false } : { value: undefined, done: true }) };
          if (st.ret) iterator.return = () => { log(`${st.l}=ret`); return { value: returned, done: !st.retOpen }; };
          return iterator;
        } };
        syncIterables.add(iterable);
        regs.set(st.as, iterable);
        return null;
      }
      case 'asyncIt': {
        // An async iterator of `of` with no `throw` and, unless `ret`, no
        // `return`; each `next` logs what it was sent when `l`.
        const values = items(st.of, arg);
        const iterable = { [Symbol.asyncIterator]() {
          let at = 0;
          const iterator = { next: (sent) => {
            if (st.l) log(`${st.l}.next=${show(sent)}`);
            return Promise.resolve(at < values.length ? { value: values[at++], done: false } : { value: undefined, done: true });
          } };
          if (st.ret) iterator.return = (sent) => { log(`${st.l}.return=${show(sent)}`); return Promise.resolve({ value: sent, done: true }); };
          return iterator;
        } };
        asyncIterables.add(iterable);
        regs.set(st.as, iterable);
        return null;
      }
      default: throw new TypeError(`unknown statement ${st.s}`);
    }
  }
  function addTo(emitter, mode, event, listener) {
    if (mode === 'once') emitter.once(event, listener);
    else if (mode === 'prepend') emitter.prependListener(event, listener);
    else if (mode === 'prependOnce') emitter.prependOnceListener(event, listener);
    else emitter.on(event, listener);
  }
  // A compiled function called: its generator object or its promise.
  function callCompiled(index) {
    const fn = compiled[index];
    if (!fn) return undefined;
    const made = fn();
    if (program.co[index].gen) generators.add(made);
    return made;
  }
  const generatorIn = (reg) => { const held = regs.get(reg); return generators.has(held) ? held : undefined; };
  // `generator.next(v)`, `.return(v)` or `.throw(v)` (`k`).
  const callGenerator = (generator, st, arg) => generator[st.k === 'return' ? 'return' : st.k === 'throw' ? 'throw' : 'next'](valueOf(st.v, arg));
  // A manual call of a generator's method, its outcome logged.
  function genCall(st, arg) {
    const generator = generatorIn(st.g);
    if (!generator) return;
    const promise = callGenerator(generator, st, arg);
    if (st.l) promise.then((result) => log(`${st.l}=${show(result)}`), (reason) => log(`${st.l}!${show(reason)}`));
  }
  // The compiled functions' runtime: what their source calls.
  const runtime = {
    value: (st, key = 'v') => valueOf(st[key]),
    step: (st) => { step(st); },
    caught: (st, error) => { if (st.as) log(`${st.as}!${show(error)}`); },
    // What a `yield` or `yield*` gave, or a loop's item: logged and kept.
    sent: (st, value) => { if (st.l) log(`${st.l}=${show(value)}`); if (st.as) regs.set(st.as, value); },
    iterable: iterableOf,
    // What a loop or `yield*` iterates: a fresh call (`call`) or a target.
    source: (st, key) => (st.call === undefined ? valueOf(st[key]) : callCompiled(st.call)),
    generator: (st) => generatorIn(st.g),
    call: (generator, st) => callGenerator(generator, st),
  };
  const compiled = (program.co ?? []).map((definition, index) => compile(definition, index, runtime));
  // `then` on whatever a register holds: a promise, or a value wrapped.
  const promiseOf = (reg) => {
    const held = regs.has(reg) ? regs.get(reg) : 'missing';
    return held instanceof Promise ? held : Promise.resolve(held);
  };
  // One async function of the program: its statements, try blocks
  // included, run in this one function.
  async function runFn(index) {
    const frames = [{ stmts: fns[index]?.body ?? [], at: 0, handler: null }];
    let thrown = null, throwing = false;
    for (;;) {
      const frame = frames[frames.length - 1];
      if (throwing) {
        // Unwind to the nearest try block whose body is running.
        let handled = false;
        while (frames.length) {
          const top = frames.pop();
          if (top.handler) { frames.push({ stmts: top.handler.catch ?? [], at: 0, handler: null, caught: top.handler.as, reason: thrown }); handled = true; break; }
        }
        if (!handled) throw thrown;
        const caught = frames[frames.length - 1];
        if (caught.caught) log(`${caught.caught}!${show(thrown)}`);
        throwing = false; thrown = null;
        continue;
      }
      if (frame.at >= frame.stmts.length) {
        frames.pop();
        if (!frames.length) return undefined;
        continue;
      }
      const st = frame.stmts[frame.at++];
      try {
        switch (st.s) {
          case 'await': {
            const value = await valueOf(st.v);
            if (st.l) log(`${st.l}=${show(value)}`);
            if (st.as) regs.set(st.as, value);
            break;
          }
          case 'sleep': await new Promise((resolve) => setTimeout(resolve, st.ms)); break;
          case 'ret': return valueOf(st.v);
          case 'retAwait': return await valueOf(st.v);
          case 'try': frames.push({ stmts: st.body ?? [], at: 0, handler: st }); break;
          default: step(st);
        }
      } catch (error) {
        thrown = error; throwing = true;
      }
    }
  }
  return {
    runMain: () => execSync(program.main), runMessage: (body) => execSync(body), messages: program.messages ?? [],
    onUnhandled: () => { execSync(program.onUnhandled); },
  };
}

/**
 * A compiled function of a program as JavaScript source: control flow is
 * the language's, each other statement one synchronous step. `__S` holds the
 * statements, `__rt` the runtime; a loop counts its iterations for its exits.
 */
function compile(definition, index, runtime) {
  const table = [];
  const block = (stmts, loop) => (stmts ?? []).map((st) => statement(st, loop)).join('\n');
  const statement = (st, loop) => {
    table.push(st);
    const at = `__S[${table.length - 1}]`;
    switch (st.s) {
      case 'await': return `{ const __v = await __rt.value(${at}); __rt.sent(${at}, __v); }`;
      case 'sleep': return `await new Promise((resolve) => setTimeout(resolve, ${at}.ms));`;
      case 'ret': return `return __rt.value(${at});`;
      case 'retAwait': return `return await __rt.value(${at});`;
      case 'retBare': return 'return;';
      case 'throw': return `throw __rt.value(${at});`;
      case 'try': {
        let code = `try {\n${block(st.body, loop)}\n}`;
        if (st.catch) code += ` catch (__e) {\n__rt.caught(${at}, __e);\n${block(st.catch, loop)}\n}`;
        if (st.fin || !st.catch) code += ` finally {\n${block(st.fin, loop)}\n}`;
        return code;
      }
      case 'yield': return `__rt.sent(${at}, yield __rt.value(${at}));`;
      case 'yieldStar': return st.await
        ? `__rt.sent(${at}, yield* __rt.iterable(await __rt.source(${at}, 'v')));`
        : `__rt.sent(${at}, yield* __rt.iterable(__rt.source(${at}, 'v')));`;
      case 'forAwait': {
        const counter = `__i${table.length - 1}`;
        return `{ let ${counter} = 0; for await (const __x of __rt.iterable(__rt.source(${at}, 'of'))) { ${counter}++; __rt.sent(${at}, __x);\n${block(st.body, counter)}\n} }`;
      }
      case 'awaitCall': return `{ const __g = __rt.generator(${at}); if (__g) __rt.sent(${at}, await __rt.call(__g, ${at})); }`;
      case 'exit': {
        if (!loop) return '';
        const when = `if (${loop} === ${at}.at)`;
        if (st.kind === 'break') return `${when} break;`;
        if (st.kind === 'continue') return `${when} continue;`;
        if (st.kind === 'ret') return `${when} return __rt.value(${at});`;
        return `${when} throw __rt.value(${at});`;
      }
      default: return `__rt.step(${at});`;
    }
  };
  const body = block(definition.body);
  const kind = definition.gen ? 'async function*' : 'async function';
  return new Function('__S', '__rt', `return ${kind} co${index}() {\n${body}\n};`)(table, runtime);
}

function runAll(lines) {
  return lines.map((line) => {
    const program = JSON.parse(line);
    return runProgram(program, interpret(program));
  });
}

/** libuv's loop for one program, under the virtual clock: the main body as a unit, then iterations (poll, check, timers). */
function runProgram(program, made) {
  trace = [];
  onUnhandled = made.onUnhandled;
  resetLoop(1000);
  const until = 1000 + (program.until ?? 50);
  const pending = made.messages.map((message) => ({ ...message, at: 1000 + message.at })).sort((a, b) => a.at - b.at);
  const checkpointed = (fn) => { try { fn(); } catch (error) { trace.push(`X:${show(error)}`); } runNextTicks(); };
  checkpointed(made.runMain);
  const timersPhase = () => { const first = timerListQueue.peek(); if (first && first.expiry <= now) { processTimers(now); runNextTicks(); } };
  timersPhase();
  for (let turns = 0; turns < 10_000; turns++) {
    if (immediateInfo[immediateInfoFields.kCount] === 0) {
      const timer = timerListQueue.peek()?.expiry ?? Infinity;
      const message = pending[0]?.at ?? Infinity;
      const next = Math.min(timer, message);
      if (next > until) break;
      now = Math.max(now, next);
    }
    while (pending.length && pending[0].at <= now) {
      const message = pending.shift();
      checkpointed(() => { trace.push(`M@${now}`); made.runMessage(message.body); });
    }
    if (immediateInfo[immediateInfoFields.kCount] > 0) { processImmediate(); runNextTicks(); }
    timersPhase();
  }
  return trace.join(' ');
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const lines = input.split('\n').filter(Boolean);
// The driver runs synchronously inside one callback of the real loop (an fs
// callback, not a tick, a timer or an immediate), so only its own explicit
// checkpoints run jobs.
stat('.', () => { process.stdout.write(`${runAll(lines).join('\n')}\n`); });
