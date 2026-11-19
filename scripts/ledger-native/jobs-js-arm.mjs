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
// with an explicit stack, and one `await` statement is one `await`. Two
// AsyncLocalStorage stores (`a`, `b`) tag every log entry with the frame it
// runs in; abort controllers, `AbortSignal.any` and abort listeners are
// Node's own.
//
//   node --expose-internals jobs-js-arm.mjs < programs (one JSON program per line)
//   stdout: one line per program, its trace joined by spaces
import { AsyncLocalStorage } from 'node:async_hooks';
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

const show = (value) => (value === undefined ? 'undefined' : JSON.stringify(value));
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
  const log = (entry) => trace.push(`${entry}${frameTag()}`);
  const fns = program.fns ?? [];
  const valueOf = (target, arg) => {
    if (target === undefined) return undefined;
    if (Object.hasOwn(target, 'val')) return target.val;
    if (Object.hasOwn(target, 'arg')) return arg;
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
      case 'tick': process.nextTick(() => { execSync(st.body); }); return null;
      case 'micro': queueMicrotask(() => { execSync(st.body); }); return null;
      case 'timeout': {
        const timer = setTimeout(() => { execSync(st.body); }, st.ms);
        if (st.unref) timer.unref();
        timers.set(st.n, timer);
        return null;
      }
      case 'interval': {
        let left = st.times;
        const timer = setInterval(() => {
          left -= 1;
          if (left <= 0) clearInterval(timer);
          execSync(st.body);
        }, st.ms);
        if (st.unref) timer.unref();
        timers.set(st.n, timer);
        return null;
      }
      case 'clear': clearTimeout(timers.get(st.n)); return null;
      case 'immediate': immediates.set(st.n, setImmediate(() => { execSync(st.body); })); return null;
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
        const listener = () => { execSync(st.body); };
        listeners.set(st.id, { signal, listener });
        signal.addEventListener('abort', listener, { once: Boolean(st.once) });
        return null;
      }
      case 'unlisten': { const entry = listeners.get(st.id); if (entry) entry.signal.removeEventListener('abort', entry.listener); return null; }
      case 'abort': controllers.get(st.c)?.abort(valueOf(st.v, arg)); return null;
      case 'checkAbort': signals.get(st.g)?.throwIfAborted(); return null;
      case 'reason': { const signal = signals.get(st.g); log(`${st.l}=${signal ? `${signal.aborted}:${show(signal.reason)}` : 'none'}`); return null; }
      default: throw new TypeError(`unknown statement ${st.s}`);
    }
  }
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
