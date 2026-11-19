// Job-order programs for the native ledger's job layer (the crate's `js` and
// `host` modules), run by jobs-js-arm.mjs on Node and by
// `ledger-native-probe jobs` on the Rust; jobs-differential.mjs compares
// their traces. A program is JSON:
//
//   { fns: [{ body: [stmt] }], main: [stmt], messages: [{ at, body }], until, onUnhandled: [stmt] }
//
// `main` and message bodies, callbacks, executors, ticks, microtasks, timers
// and immediates are synchronous statement lists; a function body is an
// async function, which may also `await`, `sleep`, `ret`, `retAwait`, `try`.
// Statements: log, call, give, throw, new, settle, then, catch, finally,
// all, allSettled, race, resolve, reject, handle, tick, micro, timeout,
// interval, clear, immediate, clearImmediate, block (the callback holds the
// loop for `ms`, so the clock moves on meanwhile); the async context: run
// and exit (of store `a` or `b`), snap and replay (a snapshot); abort
// signals: ctl (a controller), any, listen (once or not), unlisten, abort,
// reason (logs `aborted:reason`), and in async functions checkAbort
// (`throwIfAborted`). Every entry a program logs carries the frame it runs
// in (`~a/b`). `onUnhandled` runs in the rejection listener after its
// report. A target is `{ val }`, `{ reg }` or `{ arg }` (a callback's
// argument).
//
// Iteration (`co`, compiled functions: `{ gen, body }`, an async generator
// when `gen`, else an async function; the JavaScript arm makes their source,
// the Rust runs them as a port is written): their bodies may also `yield`,
// `yieldStar` (`await` first when `await`), `forAwait` over `of` with a body
// whose `exit` (break, continue, ret, throw) fires at iteration `at`,
// `awaitCall` (an awaited `next`/`return`/`throw` of a generator), and `try`
// with `catch` and `fin` (finally). Statements anywhere: cocall (a compiled
// function's call: a generator object or a promise), gcall and burst
// (manual `next`/`return`/`throw`, logged, several at once), arr (an
// array), syncIt (a sync iterable whose `return` logs when `ret`, giving
// `retv`, not done when `retOpen`), asyncIt (an async iterator with no
// `throw`, and no `return` unless `ret`; `next` logs what it is sent); a
// `{ made }` target is a value made by kind (object, bigint, buffer, error,
// function, map …); `retBare` is a generator's `return;`; event
// emitters: em, on (mode on, once, prepend, prependOnce), onAgain (the same
// listener again), off, offAll, emit (logs whether it had listeners), count.
// What `for await` and `yield*` iterate is a generator, an array, a sync
// or an async iterable; anything else is an empty array.
//
// The generator draws only integers (xorshift32), so its programs are the
// same on every platform and Node version. `iteration` adds the statements
// above; without it the programs are exactly those of the job layer's first
// proof.

/** A seeded generator of random programs (with `iteration`, programs of async generators, `for await` and emitters too). */
export function generatePrograms(seed, count, { iteration = false } = {}) {
  let state = (seed >>> 0) || 1;
  const next = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state; };
  const below = (n) => next() % n;
  const chance = (percent) => below(100) < percent;
  const pick = (items) => items[below(items.length)];
  const DELAYS = [0, 1, 1, 2, 2.5, 3, 5, 10, null, -1, 1.5];
  const programs = [];
  for (let index = 0; index < count; index++) {
    let label = 0;
    const regs = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'];
    const deferred = ['p0', 'p1', 'p2'];
    const timers = ['t0', 't1', 't2', 't3'];
    const immediates = ['i0', 'i1'];
    const controllers = ['c0', 'c1', 'c2'];
    const signalNames = [...controllers, 's0', 's1'];
    const listenerIds = ['l0', 'l1', 'l2', 'l3'];
    const snapNames = ['f0', 'f1'];
    const fnCount = 1 + below(4);
    // Iteration: generator objects, arrays and sync iterables, emitters,
    // their events in rank order (a listener emits only events of a higher
    // rank, so an emit always ends), and the compiled functions.
    const gens = ['g0', 'g1', 'g2'];
    const iterables = ['a0', 'a1'];
    const emitterNames = ['e0', 'e1'];
    const events = ['x', 'y', 'error'];
    const handlerIds = ['h0', 'h1', 'h2', 'h3'];
    const coGen = iteration ? Array.from({ length: 1 + below(3) }, () => chance(65)) : [];
    const source = () => (chance(55) ? { reg: pick(gens) } : chance(75) ? { reg: pick(iterables) } : target());
    const name = () => `L${label++}`;
    const target = () => (chance(55) ? { reg: pick(regs) } : { val: `v${below(9)}` });
    const handlerBody = (depth, fromFn, at) => {
      const body = [];
      for (let n = below(3); n > 0; n--) body.push(syncStmt(depth + 1, fromFn, at));
      if (chance(25)) body.push({ s: 'throw', v: { val: `e${below(9)}` } });
      else if (chance(70)) body.push({ s: 'give', v: chance(40) ? { arg: true } : target() });
      return [{ s: 'log', l: name(), v: { arg: true } }, ...body];
    };
    // `at`: where the statement is. `fn` (an index of `fns`: none of the
    // iteration statements there), `co` (the compiled function it is in:
    // it calls only later ones), `minEmit` (the lowest event rank it may
    // emit) and `listener` (inside a listener: no compiled calls, which
    // could reach the listener again).
    const TOP = { co: -1, minEmit: 0, listener: false };
    const ITERATION_CHOICES = ['em', 'on', 'on', 'onAgain', 'off', 'offAll', 'emit', 'emit', 'emit', 'count', 'cocall', 'cocall', 'gcall', 'gcall', 'burst', 'burst', 'arr', 'syncIt', 'asyncIt'];
    // What a `yield` yields: every kind the frame rule tells apart (a
    // primitive or a plain object loses the frame on Electron's V8; an
    // array, a Buffer, an Error, a function, a generator object … keeps it).
    const MADE_KINDS = ['object', 'object', 'bigint', 'ownThen', 'nullProto', 'buffer', 'uint8', 'error', 'function', 'instance', 'map', 'set', 'date', 'boxed'];
    const yielded = () => {
      const roll = below(100);
      if (roll < 45) return target();
      if (roll < 65) return { made: pick(MADE_KINDS) };
      if (roll < 85) return { reg: pick(iterables) };
      return { reg: pick(gens) };
    };
    // A burst of requests, inside a store's frame more often than not (so
    // the frame a body then runs in is seen).
    const framed = (statement) => (chance(75) ? { s: 'run', st: pick(['a', 'b']), v: { val: `s${below(9)}` }, body: [statement] } : statement);
    const genCall = () => ({ k: pick(['next', 'next', 'next', 'return', 'throw']), v: target(), l: name() });
    const iterationStmt = (kind, depth, fromFn, at) => {
      switch (kind) {
        case 'em': return { s: 'em', n: pick(emitterNames) };
        case 'on': {
          const rank = below(events.length);
          const body = [{ s: 'log', l: name(), v: { arg: true } }];
          for (let n = below(3); n > 0; n--) body.push(syncStmt(depth + 1, fromFn, { ...at, minEmit: rank + 1, listener: true }));
          if (chance(15)) body.push({ s: 'throw', v: { val: `e${below(9)}` } });
          return { s: 'on', e: pick(emitterNames), ev: events[rank], id: pick(handlerIds), mode: pick(['on', 'on', 'once', 'prepend', 'prependOnce']), body };
        }
        case 'onAgain': return { s: 'onAgain', e: pick(emitterNames), ev: pick(events), id: pick(handlerIds), mode: pick(['on', 'once', 'prepend']) };
        case 'off': return { s: 'off', e: pick(emitterNames), ev: pick(events), id: pick(handlerIds) };
        case 'offAll': return chance(50) ? { s: 'offAll', e: pick(emitterNames) } : { s: 'offAll', e: pick(emitterNames), ev: pick(events) };
        case 'emit': {
          if (at.minEmit >= events.length) return { s: 'count', e: pick(emitterNames), ev: pick(events), l: name() };
          const ev = events[at.minEmit + below(events.length - at.minEmit)];
          return { s: 'emit', e: pick(emitterNames), ev, v: target(), l: name() };
        }
        case 'count': return { s: 'count', e: pick(emitterNames), ev: pick(events), l: name() };
        case 'cocall': {
          const lowest = at.co + 1;
          if (at.listener || lowest >= coGen.length) return { s: 'log', l: name() };
          const f = lowest + below(coGen.length - lowest);
          return { s: 'cocall', f, as: coGen[f] ? pick(gens) : pick(regs) };
        }
        case 'gcall': return { s: 'gcall', g: pick(gens), ...genCall() };
        case 'burst': {
          const of = [];
          for (let n = 2 + below(2); n > 0; n--) of.push(genCall());
          return framed({ s: 'burst', g: pick(gens), of });
        }
        case 'arr': case 'syncIt': case 'asyncIt': {
          const of = [];
          for (let n = below(4); n > 0; n--) of.push(chance(60) ? { reg: pick([...regs, ...deferred]) } : { val: `v${below(9)}` });
          if (kind === 'arr') return { s: 'arr', as: pick(iterables), of };
          if (kind === 'asyncIt') return { s: 'asyncIt', as: pick(iterables), of, ret: chance(50), l: name() };
          return { s: 'syncIt', as: pick(iterables), of, ret: chance(60), ...(chance(20) ? { retv: target() } : {}), l: name() };
        }
        default: throw new TypeError(kind);
      }
    };
    const syncStmt = (depth, fromFn, at = TOP) => {
      const plain = !iteration || fromFn >= 0;
      const choices = depth > 2 ? ['log', 'settle', 'resolve', 'reject', 'clear', 'handle', 'call', 'abort', 'unlisten', 'reason', ...(plain ? [] : ['emit', 'gcall', 'off'])] : [
        'log', 'log', 'call', 'call', 'new', 'settle', 'settle', 'then', 'then', 'catch', 'finally', 'all', 'allSettled', 'race',
        'resolve', 'reject', 'handle', 'tick', 'micro', 'timeout', 'timeout', 'interval', 'clear', 'immediate', 'clearImmediate', 'block',
        'run', 'run', 'exit', 'snap', 'replay', 'ctl', 'ctl', 'any', 'listen', 'listen', 'unlisten', 'abort', 'abort', 'reason', ...(plain ? [] : ITERATION_CHOICES)];
      const nested = () => {
        const body = [];
        for (let n = 1 + below(2); n > 0; n--) body.push(syncStmt(depth + 1, fromFn, at));
        return body;
      };
      const kind = pick(choices);
      if (ITERATION_CHOICES.includes(kind) && !(kind === 'emit' && plain) && !(kind === 'gcall' && plain) && !(kind === 'off' && plain)) return iterationStmt(kind, depth, fromFn, at);
      switch (kind) {
        case 'run': return { s: 'run', st: pick(['a', 'b']), v: chance(80) ? { val: `s${below(9)}` } : target(), body: nested() };
        case 'exit': return { s: 'exit', st: pick(['a', 'b']), body: nested() };
        case 'snap': return { s: 'snap', as: pick(snapNames) };
        case 'replay': return { s: 'replay', f: pick(snapNames), body: nested() };
        case 'ctl': return { s: 'ctl', n: pick(controllers) };
        case 'any': {
          const of = [];
          for (let n = below(4); n > 0; n--) of.push(pick(signalNames));
          return { s: 'any', n: pick(['s0', 's1']), of };
        }
        case 'listen': return { s: 'listen', g: pick(signalNames), id: pick(listenerIds), ...(chance(60) ? { once: true } : {}),
          body: [{ s: 'log', l: name() }, ...(chance(60) ? [syncStmt(depth + 1, fromFn, at)] : [])] };
        case 'unlisten': return { s: 'unlisten', id: pick(listenerIds) };
        case 'abort': return { s: 'abort', c: pick(controllers), v: { val: `a${below(9)}` } };
        case 'reason': return { s: 'reason', g: pick(signalNames), l: name() };
        case 'log': return chance(50) ? { s: 'log', l: name() } : { s: 'log', l: name(), v: target() };
        case 'call': {
          const lowest = fromFn + 1;
          if (lowest >= fnCount) return { s: 'log', l: name() };
          return { s: 'call', f: lowest + below(fnCount - lowest), as: pick(regs) };
        }
        case 'new': {
          const as = pick(deferred);
          const body = chance(50) ? [{ s: 'settle', p: as, ok: chance(70), v: target() }] : [];
          // An executor that throws: before settling it rejects, after it does nothing.
          if (chance(15)) body.push({ s: 'throw', v: { val: `e${below(9)}` } });
          return { s: 'new', as, body };
        }
        case 'settle': return { s: 'settle', p: pick(deferred), ok: chance(70), v: target() };
        case 'then': return { s: 'then', p: pick([...regs, ...deferred]), as: pick(regs), ...(chance(80) ? { ok: handlerBody(depth, fromFn, at) } : {}), ...(chance(50) ? { err: handlerBody(depth, fromFn, at) } : {}) };
        case 'catch': return { s: 'catch', p: pick([...regs, ...deferred]), as: pick(regs), err: handlerBody(depth, fromFn, at) };
        case 'finally': return { s: 'finally', p: pick([...regs, ...deferred]), as: pick(regs), body: handlerBody(depth, fromFn, at) };
        case 'all': case 'allSettled': case 'race': {
          const of = [];
          for (let n = below(4); n > 0; n--) of.push(chance(70) ? { reg: pick([...regs, ...deferred]) } : { val: `v${below(9)}` });
          return { s: pick(['all', 'allSettled', 'race']), of, as: pick(regs) };
        }
        case 'resolve': return { s: 'resolve', v: target(), as: pick(regs) };
        case 'reject': return { s: 'reject', v: { val: `e${below(9)}` }, as: pick(regs) };
        case 'handle': return { s: 'handle', p: pick([...regs, ...deferred]) };
        case 'tick': case 'micro': return { s: pick(['tick', 'micro']), body: [{ s: 'log', l: name() }, ...(chance(60) ? [syncStmt(depth + 1, fromFn, at)] : [])] };
        case 'timeout': return { s: 'timeout', n: pick(timers), ms: pick(DELAYS), ...(chance(20) ? { unref: true } : {}), body: [{ s: 'log', l: name() }, ...(chance(60) ? [syncStmt(depth + 1, fromFn, at)] : [])] };
        case 'interval': return { s: 'interval', n: pick(timers), ms: pick(DELAYS), times: 1 + below(3), ...(chance(20) ? { unref: true } : {}), body: [{ s: 'log', l: name() }, ...(chance(50) ? [syncStmt(depth + 1, fromFn, at)] : [])] };
        case 'clear': return { s: 'clear', n: pick(timers) };
        case 'block': return { s: 'block', ms: 1 + below(4) };
        case 'immediate': return { s: 'immediate', n: pick(immediates), body: [{ s: 'log', l: name() }, ...(chance(50) ? [syncStmt(depth + 1, fromFn, at)] : [])] };
        default: return { s: 'clearImmediate', n: pick(immediates) };
      }
    };
    const asyncStmt = (depth, fnIndex) => {
      const roll = below(100);
      if (roll < 30) return { s: 'await', v: target(), l: name(), ...(chance(30) ? { as: pick(regs) } : {}) };
      if (roll < 36) return { s: 'sleep', ms: pick(DELAYS) };
      if (roll < 42 && depth < 2) {
        const body = [], handler = [];
        for (let n = 1 + below(3); n > 0; n--) body.push(asyncStmt(depth + 1, fnIndex));
        for (let n = below(2); n > 0; n--) handler.push(asyncStmt(depth + 1, fnIndex));
        return { s: 'try', body, catch: handler, as: name() };
      }
      if (roll < 46) return { s: 'throw', v: { val: `e${below(9)}` } };
      if (roll < 48) return { s: 'checkAbort', g: pick(signalNames) };
      if (roll < 52) return { s: pick(['ret', 'retAwait']), v: target() };
      return syncStmt(depth, fnIndex);
    };
    // A statement of compiled function `co` (a generator when `gen`);
    // `inLoop`: inside a `for await` body, where exits may stand.
    const coStmt = (depth, co, gen, inLoop) => {
      const at = { ...TOP, co };
      // A fresh call of a later generator, or a target.
      const later = coGen.map((isGen, index) => index).filter((index) => index > co && coGen[index]);
      const iterated = (key) => (later.length && chance(50) ? { call: pick(later) } : { [key]: source() });
      const roll = below(100);
      if (roll < 18) return { s: 'await', v: target(), l: name(), ...(chance(30) ? { as: pick(regs) } : {}) };
      if (roll < 21) return { s: 'sleep', ms: pick(DELAYS) };
      if (roll < 29 && depth < 2) {
        const body = [];
        for (let n = 1 + below(3); n > 0; n--) body.push(coStmt(depth + 1, co, gen, inLoop));
        const statement = { s: 'try', body, as: name() };
        if (chance(60)) { statement.catch = []; for (let n = below(3); n > 0; n--) statement.catch.push(coStmt(depth + 1, co, gen, inLoop)); }
        if (!statement.catch || chance(50)) { statement.fin = []; for (let n = 1 + below(2); n > 0; n--) statement.fin.push(coStmt(depth + 1, co, gen, inLoop)); }
        return statement;
      }
      if (roll < 32) return { s: 'throw', v: { val: `e${below(9)}` } };
      if (roll < 35) return chance(15) ? { s: 'retBare' } : { s: pick(['ret', 'retAwait']), v: target() };
      if (gen && roll < 54) return { s: 'yield', v: yielded(), l: name(), ...(chance(20) ? { as: pick(regs) } : {}) };
      if (gen && roll < 60) return { s: 'yieldStar', ...iterated('v'), l: name(), ...(chance(15) ? { await: true } : {}) };
      if (roll < 68 && depth < 2) {
        const body = [];
        for (let n = 1 + below(3); n > 0; n--) body.push(coStmt(depth + 1, co, gen, true));
        return { s: 'forAwait', ...iterated('of'), l: name(), body };
      }
      if (inLoop && roll < 76) return { s: 'exit', kind: pick(['break', 'break', 'continue', 'ret', 'throw']), at: 1 + below(3), v: target() };
      if (roll < 80) return { s: 'awaitCall', g: pick(gens), ...genCall() };
      return syncStmt(depth, -1, at);
    };
    const co = coGen.map((gen, index) => {
      const body = [{ s: 'log', l: name() }];
      for (let n = 1 + below(5); n > 0; n--) body.push(coStmt(0, index, gen, false));
      return { gen, body };
    });
    const fns = [];
    for (let f = 0; f < fnCount; f++) {
      const body = [{ s: 'log', l: name() }];
      for (let n = 1 + below(5); n > 0; n--) body.push(asyncStmt(0, f));
      if (chance(50)) body.push({ s: pick(['ret', 'retAwait']), v: target() });
      fns.push({ body });
    }
    const main = [];
    if (iteration) {
      main.push({ s: 'em', n: 'e0' });
      // Every generator once, in a generator register of its own.
      coGen.forEach((isGen, f) => { if (isGen) main.push({ s: 'cocall', f, as: gens[f % gens.length] }); });
      if (chance(50)) main.push({ s: 'arr', as: 'a0', of: [{ val: 'v1' }, { reg: 'p0' }, { val: 'v2' }] });
      // Requests queued before the first settles, in a frame.
      const made = coGen.flatMap((isGen, f) => (isGen ? [gens[f % gens.length]] : []));
      main.push(framed({ s: 'burst', g: made.length ? pick(made) : pick(gens), of: Array.from({ length: 2 + below(3) }, genCall) }));
    }
    for (let n = 2 + below(6); n > 0; n--) main.push(syncStmt(0, -1));
    main.push({ s: 'call', f: 0, as: pick(regs) });
    if (iteration) main.push({ s: 'cocall', f: 0, as: coGen[0] ? pick(gens) : pick(regs) }, framed({ s: 'burst', g: pick(gens), of: [genCall(), genCall()] }));
    const messages = [];
    for (let n = below(3); n > 0; n--) messages.push({ at: below(12), body: [syncStmt(0, -1), syncStmt(0, -1)] });
    // The listener's own statements never reject (a rejection there would be
    // reported to it again, for ever): a log, a tick, a microtask, a timer.
    const onUnhandled = chance(15) ? [{ s: 'log', l: name() },
      { s: pick(['tick', 'micro', 'timeout']), n: pick(timers), ms: pick(DELAYS), body: [{ s: 'log', l: name() }] }] : undefined;
    programs.push({ fns, main, messages, until: 40, ...(onUnhandled ? { onUnhandled } : {}), ...(iteration ? { co } : {}) });
  }
  return programs;
}

const log = (l, v) => (v === undefined ? { s: 'log', l } : { s: 'log', l, v });
const reg = (name) => ({ reg: name });
const val = (value) => ({ val: value });

/** A chain of `n` microtasks, `m1` … `mn`: what a trace counts jobs against. */
function ladder(n, from = 1) {
  return from > n ? [] : [{ s: 'micro', body: [log(`m${from}`), ...ladder(n, from + 1)] }];
}
const yieldOf = (v, l) => ({ s: 'yield', v: typeof v === 'object' ? v : val(v), ...(l ? { l } : {}) });
const gen = (...body) => ({ gen: true, body });
const afn = (...body) => ({ gen: false, body });
/** `for await` over a fresh call of compiled function `of` (a number) or a target; each item is logged as `l` and kept in register `l`. */
const loop = (of, l, ...body) => ({ s: 'forAwait', ...(typeof of === 'number' ? { call: of } : { of }), l, as: l, body });
const exitAt = (kind, at, v) => ({ s: 'exit', kind, at, ...(v === undefined ? {} : { v: val(v) }) });
const next = (g, l, v) => ({ s: 'gcall', g, k: 'next', l, ...(v === undefined ? {} : { v: val(v) }) });
const gReturn = (g, l, v) => ({ s: 'gcall', g, k: 'return', l, ...(v === undefined ? {} : { v: typeof v === 'object' ? v : val(v) }) });
const gThrow = (g, l, v) => ({ s: 'gcall', g, k: 'throw', l, v: val(v) });
const cocall = (f, as) => ({ s: 'cocall', f, as });

const ITERATION_PROGRAMS = [
  { name: 'for await over a generator of three plain values: two jobs a value, one at the end', program: { fns: [],
    co: [gen(yieldOf('v1'), yieldOf('v2'), yieldOf('v3')), afn(loop(0, 'x'), log('end'))],
    main: [cocall(1), ...ladder(10)] } },
  { name: 'an await before each yield adds its job', program: { fns: [],
    co: [gen({ s: 'await', v: val(null) }, yieldOf('v1'), { s: 'await', v: val(null) }, yieldOf('v2')), afn(loop(0, 'x'), log('end'))],
    main: [cocall(1), ...ladder(10)] } },
  { name: 'yield awaits its operand: a settled promise adds no job over a plain value', program: { fns: [],
    co: [gen(yieldOf(reg('g')), yieldOf(reg('g'))), afn(loop(0, 'x'), log('end'))],
    main: [{ s: 'resolve', v: val('p'), as: 'g' }, cocall(1), ...ladder(10)] } },
  { name: 'yield of a pending promise waits for it', program: { fns: [],
    co: [gen(yieldOf(reg('p0')), yieldOf('after')), afn(loop(0, 'x'), log('end'))],
    main: [{ s: 'new', as: 'p0' }, cocall(1), { s: 'timeout', n: 't0', ms: 2, body: [{ s: 'settle', p: 'p0', ok: true, v: val('late') }, ...ladder(4)] }] } },
  { name: 'the first next runs the body synchronously inside it, the result two jobs later', program: { fns: [],
    co: [gen(log('body'), yieldOf('v1'))],
    main: [cocall(0, 'g0'), log('made'), next('g0', 'n1'), log('after next'), ...ladder(4)] } },
  { name: 'three next calls before the first settles are queued and answered in order', program: { fns: [],
    co: [gen(log('b'), { s: 'await', v: val(null) }, yieldOf('b2'))],
    main: [cocall(0, 'g0'), next('g0', 'p0'), next('g0', 'p1'), next('g0', 'p2'), log('queued'), ...ladder(6)] } },
  { name: 'next sends its value to the yield it resumes; the first value is dropped', program: { fns: [],
    co: [gen({ s: 'yield', v: val('a'), l: 'got1' }, { s: 'yield', v: val('b'), l: 'got2' })],
    main: [cocall(0, 'g0'), next('g0', 'n1', 'dropped'), next('g0', 'n2', 'sent1'), next('g0', 'n3', 'sent2')] } },
  { name: 'return at the suspended start awaits its value once (AsyncGeneratorAwaitReturn); the body never runs', program: { fns: [],
    co: [gen(log('never'), yieldOf('v1'))],
    main: [cocall(0, 'g0'), gReturn('g0', 'ret', 7), next('g0', 'after'), ...ladder(4)] } },
  { name: 'return of a promise at the suspended start follows it', program: { fns: [],
    co: [gen(log('never'))],
    main: [{ s: 'resolve', v: val(7), as: 'g' }, cocall(0, 'g0'), gReturn('g0', 'ret', reg('g')), ...ladder(4)] } },
  { name: 'return of a rejected promise at the suspended start rejects', program: { fns: [],
    co: [gen(log('never'))],
    main: [{ s: 'reject', v: val('no'), as: 'r' }, cocall(0, 'g0'), gReturn('g0', 'ret', reg('r')), ...ladder(4)] } },
  { name: 'return on a completed generator awaits once', program: { fns: [],
    co: [gen(log('body'))],
    main: [cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 5), next('g0', 'n2'), gThrow('g0', 'thr', 'late'), ...ladder(4)] }] } },
  { name: 'return at a yield inside try/finally with an await: the value is awaited, the finally runs', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1')], fin: [log('fin'), { s: 'await', v: val(null) }, log('fin2')] }, log('never'))],
    main: [cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 9), ...ladder(5)] }] } },
  { name: 'a yield inside finally while returning yields; the return goes on at the next request', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1')], fin: [log('fin'), { s: 'yield', v: val('from finally'), l: 'sent' }, log('fin end')] }, log('never'))],
    main: [cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 9), next('g0', 'n2', 'x'), next('g0', 'n3'), ...ladder(6)] }] } },
  { name: 'a return in finally overrides a received return', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1')], fin: [{ s: 'ret', v: val('override') }] })],
    main: [cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 9), ...ladder(5)] }] } },
  { name: 'return v in the body awaits v before the finally', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'ret', v: reg('p0') }], fin: [log('fin')] })],
    main: [{ s: 'new', as: 'p0' }, cocall(0, 'g0'), next('g0', 'n1'), log('started'), { s: 'timeout', n: 't0', ms: 1, body: [{ s: 'settle', p: 'p0', ok: true, v: val('v') }, ...ladder(4)] }] } },
  { name: 'break in for await closes the generator: its finally runs before the loop goes on', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1'), yieldOf('v2')], fin: [log('fin')] }), afn(loop(0, 'x', exitAt('break', 1)), log('after'))],
    main: [cocall(1), ...ladder(8)] } },
  { name: 'a throw in the loop body closes the iterator, awaits its return and keeps the thrown error', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1'), yieldOf('v2')], fin: [log('fin')] }), afn({ s: 'try', body: [loop(0, 'x', { s: 'throw', v: val('B') })], catch: [log('after catch')], as: 'c' })],
    main: [cocall(1), ...ladder(8)] } },
  { name: 'a throw in the loop body keeps its error when the iterator\'s return rejects', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1')], fin: [{ s: 'throw', v: val('from return') }] }), afn({ s: 'try', body: [loop(0, 'x', { s: 'throw', v: val('B') })], catch: [], as: 'c' })],
    main: [cocall(1), ...ladder(6)] } },
  { name: 'break when the iterator\'s return rejects: its error replaces the break', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1')], fin: [{ s: 'throw', v: val('from return') }] }), afn({ s: 'try', body: [loop(0, 'x', exitAt('break', 1)), log('not reached')], catch: [], as: 'c' })],
    main: [cocall(1), ...ladder(6)] } },
  { name: 'return from inside for await closes the iterator, then the function returns', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1'), yieldOf('v2')], fin: [log('fin')] }), afn(loop(0, 'x', exitAt('ret', 1, 'early')), log('not reached'))],
    main: [cocall(1, 'r0'), { s: 'then', p: 'r0', ok: [log('returned', { arg: true })], as: 'x' }, ...ladder(8)] } },
  { name: 'continue skips the rest of the body and does not close', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1'), yieldOf('v2'), yieldOf('v3')], fin: [log('fin')] }), afn(loop(0, 'x', exitAt('continue', 2), log('body')), log('after'))],
    main: [cocall(1), ...ladder(10)] } },
  { name: 'a rejected next ends the loop without closing the iterator', program: { fns: [],
    co: [gen(yieldOf('v1'), { s: 'throw', v: val('inside') }), afn({ s: 'try', body: [loop(0, 'x', log('body'))], catch: [log('caught')], as: 'c' })],
    main: [cocall(1), ...ladder(6)] } },
  { name: 'nested loops: an inner return closes the inner iterator, then the outer', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('a1'), yieldOf('a2')], fin: [log('outer fin')] }), gen({ s: 'try', body: [yieldOf('b1'), yieldOf('b2')], fin: [log('inner fin')] }),
      afn(loop(0, 'outer', loop(1, 'inner', exitAt('ret', 1, 'r'))))],
    main: [cocall(2), ...ladder(12)] } },
  { name: 'nested loops: an inner break, then the outer goes on', program: { fns: [],
    co: [gen(yieldOf('a1'), yieldOf('a2')), gen({ s: 'try', body: [yieldOf('b1'), yieldOf('b2')], fin: [log('inner fin')] }),
      afn(loop(0, 'outer', loop(1, 'inner', exitAt('break', 1)), log('outer body')), log('done'))],
    main: [cocall(2), ...ladder(16)] } },
  { name: 'throw at a yield inside try/catch is caught; the next yield answers it', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1')], catch: [log('caught'), yieldOf('v2')], as: 'c' })],
    main: [cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gThrow('g0', 't', 'E'), ...ladder(5)] }] } },
  { name: 'a return received at a yield is not caught by catch, only finally runs', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1'), log('not reached')], catch: [log('wrongly caught')], fin: [log('fin')], as: 'c' }, log('after try'))],
    main: [cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 'R'), ...ladder(4)] }] } },
  { name: 'throw at the suspended start completes it at once with a rejection', program: { fns: [],
    co: [gen(log('never'))],
    main: [cocall(0, 'g0'), gThrow('g0', 't', 'E'), next('g0', 'n'), ...ladder(3)] } },
  { name: 'the body throws while a second next is queued: the queued request is done', program: { fns: [],
    co: [gen({ s: 'await', v: val(null) }, { s: 'throw', v: val('X') })],
    main: [cocall(0, 'g0'), next('g0', 'a'), next('g0', 'b'), ...ladder(4)] } },
  { name: 'a return queued behind a running next is awaited after the body completes', program: { fns: [],
    co: [gen({ s: 'await', v: val(null) }, log('ran'))],
    main: [cocall(0, 'g0'), next('g0', 'a'), gReturn('g0', 'b', 'r'), next('g0', 'c'), ...ladder(6)] } },
  { name: 'yield* over a generator: three jobs a value', program: { fns: [],
    co: [gen(yieldOf('v1'), yieldOf('v2'), yieldOf('v3')), gen({ s: 'yieldStar', call: 0, l: 'inner returned' }), afn(loop(1, 'x'), log('end'))],
    main: [cocall(2), ...ladder(14)] } },
  { name: 'yield* gives the inner generator\'s return value', program: { fns: [],
    co: [gen(yieldOf('v1'), { s: 'ret', v: val('inner value') }), gen({ s: 'yieldStar', call: 0, l: 'got' }, yieldOf('after')), afn(loop(1, 'x'), log('end'))],
    main: [cocall(2), ...ladder(12)] } },
  { name: 'yield* forwards return to the inner generator; its finally runs', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1'), yieldOf('v2')], fin: [log('inner fin')] }), gen({ s: 'try', body: [{ s: 'yieldStar', call: 0 }], fin: [log('outer fin')] })],
    main: [cocall(1, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 'R'), ...ladder(8)] }] } },
  { name: 'yield* forwards throw to the inner generator, which may catch it', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v1')], catch: [log('inner caught'), yieldOf('v2')], as: 'c' }), gen({ s: 'yieldStar', call: 0, l: 'done' })],
    main: [cocall(1, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gThrow('g0', 't', 'E'), next('g0', 'n2'), ...ladder(8)] }] } },
  { name: 'yield* over an array, then throw: the array has no throw, so a TypeError', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yieldStar', v: reg('a0') }], catch: [log('caught')], as: 'c' })],
    main: [{ s: 'arr', as: 'a0', of: [val(1), val(2)] }, cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gThrow('g0', 't', 'E'), ...ladder(6)] }] } },
  { name: 'yield* over a sync iterable, then throw: it is closed (its return runs), then a TypeError', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yieldStar', v: reg('a0') }], catch: [log('caught')], as: 'c' })],
    main: [{ s: 'syncIt', as: 'a0', of: [val(1), val(2)], ret: true, l: 'closed' }, cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gThrow('g0', 't', 'E'), ...ladder(6)] }] } },
  { name: 'yield* over a sync iterable, then return: its return runs, the value is awaited', program: { fns: [],
    co: [gen({ s: 'yieldStar', v: reg('a0') })],
    main: [{ s: 'syncIt', as: 'a0', of: [val(1), val(2)], ret: true, l: 'closed' }, cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 'R'), ...ladder(8)] }] } },
  { name: 'for await over an array of values and promises (the async-from-sync iterator): two jobs a value and at the end', program: { fns: [],
    co: [afn(loop(reg('a0'), 'x'), log('end'))],
    main: [{ s: 'resolve', v: val('p'), as: 'g' }, { s: 'arr', as: 'a0', of: [val('v1'), reg('g'), val('v3')] }, cocall(0), ...ladder(10)] } },
  { name: 'for await over an array with a pending promise waits for it', program: { fns: [],
    co: [afn(loop(reg('a0'), 'x'), log('end'))],
    main: [{ s: 'new', as: 'p0' }, { s: 'arr', as: 'a0', of: [val('v1'), reg('p0'), val('v3')] }, cocall(0), { s: 'timeout', n: 't0', ms: 2, body: [{ s: 'settle', p: 'p0', ok: true, v: val('late') }, ...ladder(6)] }] } },
  { name: 'for await over a sync iterable whose value rejects closes it (its return runs) and throws', program: { fns: [],
    co: [afn({ s: 'try', body: [loop(reg('a0'), 'x', log('body'))], catch: [log('caught')], as: 'c' })],
    main: [{ s: 'reject', v: val('bad'), as: 'r' }, { s: 'syncIt', as: 'a0', of: [val('v1'), reg('r'), val('v3')], ret: true, l: 'closed' }, cocall(0), ...ladder(8)] } },
  { name: 'break out of for await over a sync iterable runs its return', program: { fns: [],
    co: [afn(loop(reg('a0'), 'x', exitAt('break', 2)), log('after'))],
    main: [{ s: 'syncIt', as: 'a0', of: [val('v1'), val('v2'), val('v3')], ret: true, l: 'closed' }, cocall(0), ...ladder(8)] } },
  { name: 'a generator that loops for await over another and yields: four jobs a value', program: { fns: [],
    co: [gen(yieldOf('v10'), yieldOf('v20')), gen(loop(0, 'in', { s: 'yield', v: reg('in') })), afn(loop(1, 'x'), log('end'))],
    main: [cocall(2), ...ladder(14)] } },
  { name: 'yield* of an awaited array (yield* await p)', program: { fns: [],
    co: [gen({ s: 'yieldStar', v: reg('all'), await: true }), afn(loop(0, 'x'), log('end'))],
    main: [{ s: 'all', of: [val(1), val(2)], as: 'all' }, cocall(1), ...ladder(10)] } },
  { name: 'await of a manual next, as a host pull does', program: { fns: [],
    co: [gen(yieldOf('v1'), yieldOf('v2')), afn({ s: 'awaitCall', g: 'g0', k: 'next', l: 'first' }, { s: 'awaitCall', g: 'g0', k: 'return', l: 'returned' }, { s: 'awaitCall', g: 'g0', k: 'next', l: 'after' })],
    main: [cocall(0, 'g0'), cocall(1), ...ladder(8)] } },
  { name: 'a generator body runs in the frame of the next that resumes it, and its awaits keep that frame', program: { fns: [],
    co: [gen(log('start'), { s: 'await', v: val(null) }, log('after await'), yieldOf(reg('g')), log('resumed'), { s: 'await', v: val(null) }, log('after second await'), yieldOf(reg('g')))],
    main: [{ s: 'resolve', v: val('p'), as: 'g' }, { s: 'run', st: 'a', v: val('made'), body: [cocall(0, 'g0')] },
      { s: 'run', st: 'a', v: val('next1'), body: [next('g0', 'n1')] }, { s: 'timeout', n: 't0', ms: 1, body: [{ s: 'run', st: 'b', v: val('next2'), body: [next('g0', 'n2')] }] }] } },
  { name: 'Electron\'s V8: what runs after a yield of a plain value with a request queued runs in the empty frame', electronOnly: 'Node 26.13\'s V8 keeps the frame after a yield of a primitive or a plain object', program: { fns: [],
    co: [gen(yieldOf('v1'), log('after plain'), { s: 'await', v: val(null) }, log('after await'), yieldOf(reg('g')), log('after promise'))],
    main: [{ s: 'resolve', v: val('p'), as: 'g' }, cocall(0, 'g0'), { s: 'run', st: 'a', v: val('nexts'), body: [next('g0', 'n1'), next('g0', 'n2'), next('g0', 'n3')] }] } },
  { name: 'a for await body runs in the frame of the loop, whatever frame resumes the generator', program: { fns: [],
    co: [gen(yieldOf('v1'), { s: 'sleep', ms: 1 }, yieldOf('v2')), afn(loop(0, 'x', log('body')), log('end'))],
    main: [{ s: 'run', st: 'b', v: val('loop'), body: [cocall(1)] }] } },
];

const on = (e, ev, id, body, mode = 'on') => ({ s: 'on', e, ev, id, mode, body: [log(id, { arg: true }), ...body] });
const emit = (e, ev, v, l) => ({ s: 'emit', e, ev, v: val(v), l });

const EMITTER_PROGRAMS = [
  { name: 'emit runs listeners synchronously in registration order; prepend goes first; it says whether any ran', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', []), on('e0', 'x', 'h1', []), on('e0', 'x', 'h2', [], 'prepend'), emit('e0', 'x', 1, 'had'), emit('e0', 'y', 2, 'had y'), log('after')] } },
  { name: 'once removes its listener before calling it', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', [{ s: 'count', e: 'e0', ev: 'x', l: 'inside' }], 'once'), on('e0', 'x', 'h1', [], 'prependOnce'), emit('e0', 'x', 1, 'first'), emit('e0', 'x', 2, 'second')] } },
  { name: 'a listener added during an emit does not run in it; one removed during it still runs', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', [{ s: 'off', e: 'e0', ev: 'x', id: 'h1' }, on('e0', 'x', 'h2', [])]), on('e0', 'x', 'h1', []),
      emit('e0', 'x', 1, 'first'), emit('e0', 'x', 2, 'second')] } },
  { name: 'a throw in a listener leaves emit at once; the later listeners do not run', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', [{ s: 'throw', v: val('boom') }]), on('e0', 'x', 'h1', []), emit('e0', 'x', 1, 'not logged'), log('not reached')],
    messages: [{ at: 1, body: [emit('e0', 'y', 2, 'no listener'), log('message goes on')] }] } },
  { name: 'emit of error with no listener throws ERR_UNHANDLED_ERROR with the value as context; with one, it is a listener call', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, { s: 'new', as: 'p0', body: [emit('e0', 'error', 'bad', 'x')] }, { s: 'catch', p: 'p0', err: [log('thrown', { arg: true })], as: 'c' },
      { s: 'new', as: 'p1', body: [{ s: 'emit', e: 'e0', ev: 'error', l: 'y' }] }, { s: 'catch', p: 'p1', err: [log('thrown bare', { arg: true })], as: 'd' },
      on('e0', 'error', 'h0', []), emit('e0', 'error', 'handled', 'had')] } },
  { name: 'the same listener added twice runs twice; off removes the last added; a once wrapper is removed by its listener', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', []), on('e0', 'x', 'h1', []), { s: 'onAgain', e: 'e0', ev: 'x', id: 'h0', mode: 'once' }, emit('e0', 'x', 1, 'a'),
      { s: 'onAgain', e: 'e0', ev: 'x', id: 'h0', mode: 'on' }, { s: 'onAgain', e: 'e0', ev: 'x', id: 'h1', mode: 'once' }, { s: 'off', e: 'e0', ev: 'x', id: 'h1' }, emit('e0', 'x', 2, 'b'),
      { s: 'off', e: 'e0', ev: 'x', id: 'h0' }, { s: 'count', e: 'e0', ev: 'x', l: 'count' }, emit('e0', 'x', 3, 'c')] } },
  { name: 'an emit inside a listener runs to its end first; a once listener reached again runs once', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', [emit('e0', 'y', 'inner', 'inner had')], 'once'), on('e0', 'y', 'h1', [emit('e0', 'x', 'again', 'again had')]), on('e0', 'x', 'h2', []),
      emit('e0', 'x', 'outer', 'outer had')] } },
  { name: 'listeners run in the frame of the emit, not of the registration', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, { s: 'run', st: 'a', v: val('registered'), body: [on('e0', 'x', 'h0', [{ s: 'micro', body: [log('queued by listener')] }])] },
      { s: 'run', st: 'b', v: val('emitting'), body: [emit('e0', 'x', 1, 'had')] }] } },
  { name: 'a once listener an inner emit already fired is skipped by the outer emit that still holds it', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', [emit('e0', 'x', 'inner', 'inner had')], 'once'), on('e0', 'x', 'h1', [], 'once'), emit('e0', 'x', 'outer', 'outer had'), emit('e0', 'x', 'third', 'third had')] } },
  { name: 'removeAllListeners of one event, then of all', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', []), on('e0', 'y', 'h1', []), { s: 'offAll', e: 'e0', ev: 'x' }, emit('e0', 'x', 1, 'x had'), emit('e0', 'y', 2, 'y had'),
      { s: 'offAll', e: 'e0' }, emit('e0', 'y', 3, 'y after'), { s: 'count', e: 'e0', ev: 'y', l: 'count' }] } },
  { name: 'eleven listeners on one event (past the default maximum) all run, in order', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, ...Array.from({ length: 11 }, (_, index) => on('e0', 'x', `h${index}`, [])), emit('e0', 'x', 1, 'had'), ...ladder(2)] } },
];

const LEDGER_SHAPE_PROGRAMS = [
  // The store's `entries` → `values(rows())`: rows skips
  // pending keys (`continue`), values batches rows and `yield* await
  // flush()` (a Promise.all of the reads), entries yields each row.
  { name: 'ledger shape: entries over values(rows()) with a Promise.all batch and yield* await flush()', program: { fns: [],
    co: [
      gen(yieldOf('k1'), yieldOf('k2'), yieldOf('k3')),
      gen(loop(0, 'tree', exitAt('continue', 2), { s: 'yield', v: reg('tree') })),
      gen(loop(1, 'row', { s: 'all', of: [reg('row'), reg('g')], as: 'batch' }, { s: 'yieldStar', v: reg('batch'), await: true })),
      gen(loop(2, 'value', { s: 'yield', v: reg('value') })),
      afn(loop(3, 'entry'), log('end')),
    ],
    main: [{ s: 'resolve', v: val('read'), as: 'g' }, cocall(4), ...ladder(30)] } },
  // `list`: for await over entries, `yield* value` of each array.
  { name: 'ledger shape: list yields each entry\'s array with yield*', program: { fns: [],
    co: [gen(yieldOf(reg('l1')), yieldOf(reg('l2'))), gen(loop(0, 'entry', { s: 'yieldStar', v: reg('entry') })), afn(loop(1, 'value'), log('end'))],
    main: [{ s: 'all', of: [val('a'), val('b')], as: 'l1' }, { s: 'all', of: [val('c')], as: 'l2' }, cocall(2), ...ladder(20)] } },
  // `pagesOf`: for await over the caller's values (an array or a
  // generator), a page yielded at the threshold and one at the end.
  { name: 'ledger shape: pagesOf over a caller\'s array yields at the threshold and at the end', program: { fns: [],
    co: [gen(loop(reg('a0'), 'value', exitAt('continue', 1), exitAt('continue', 3), { s: 'yield', v: reg('value') }), yieldOf('last page')), afn(loop(0, 'page'), log('end'))],
    main: [{ s: 'arr', as: 'a0', of: [val(1), val(2), val(3), val(4)] }, cocall(1), ...ladder(20)] } },
  // `setList`: removes every entry while iterating them, then writes pages.
  { name: 'ledger shape: setList loops over entries, then over pagesOf', program: { fns: [],
    co: [gen(yieldOf('k1'), yieldOf('k2')), gen(yieldOf('page1')), afn(loop(0, 'remove', { s: 'log', l: 'removed', v: reg('remove') }), loop(1, 'write'), log('end'))],
    main: [cocall(2), ...ladder(14)] } },
  // The Git runner's `gitTokens`: a generator over chunks whose
  // finally kills the child; the consumer breaks after the first token.
  { name: 'ledger shape: gitTokens broken after the first token runs its finally (the kill) before the loop goes on', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'sleep', ms: 1 }, yieldOf('tok:a'), yieldOf('tok:b'), { s: 'sleep', ms: 1 }, yieldOf('tok:c')], fin: [log('kill'), { s: 'await', v: val('settled') }, log('awaited done')] }),
      afn(loop(0, 'token', exitAt('break', 1)), log('after loop'))],
    main: [cocall(1), { s: 'timeout', n: 't0', ms: 1, body: ladder(8) }] } },
  // The mutations' `byteStream`: a generator over a file stream's
  // chunks, returned by the host (`stream-return`) while it is suspended
  // at a yield: its for await closes the inner stream, its finally runs.
  { name: 'ledger shape: byteStream returned mid-file closes the inner stream, then its own finally', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('c1'), yieldOf('c2'), yieldOf('c3')], fin: [log('stream destroyed')] }),
      gen({ s: 'try', body: [loop(0, 'chunk', { s: 'yield', v: reg('chunk') })], fin: [log('byteStream finally')] })],
    main: [cocall(1, 'g0'), next('g0', 'pull1'), { s: 'timeout', n: 't0', ms: 1, body: [next('g0', 'pull2'), gReturn('g0', 'stream-return'), ...ladder(10)] }] } },
  // `committedRows`: `if (tree) yield* treeRows(tree, prefix)`;
  // `treeRows` yields indexed rows in a plain loop, then returns.
  { name: 'ledger shape: committedRows yield* treeRows whose rows are yielded without awaits', program: { fns: [],
    co: [gen({ s: 'await', v: reg('g') }, yieldOf('r1'), yieldOf('r2'), { s: 'ret', v: val(undefined) }), gen({ s: 'yieldStar', call: 0 }), afn(loop(1, 'row'), log('end'))],
    main: [{ s: 'resolve', v: val('rows'), as: 'g' }, cocall(2), ...ladder(16)] } },
  // A recursive generator that yields to the loop between directories and
  // delegates to its subdirectories (`walkFiles` itself is breadth first,
  // with no `yield*`: its own shape is in FIX_PROGRAMS).
  { name: 'ledger shape: a recursive generator through yield* with a yield to the loop between levels', program: { fns: [],
    co: [gen(yieldOf('leaf')), gen(yieldOf('dir/a'), { s: 'sleep', ms: 0 }, { s: 'yieldStar', call: 0 }, yieldOf('dir/b')), gen(yieldOf('root'), { s: 'yieldStar', call: 1 }), afn(loop(2, 'file'), log('end'))],
    main: [cocall(3), { s: 'timeout', n: 't0', ms: 1, body: [log('loop turn'), ...ladder(4)] }] } },
  // A method that returns the first match: `for await (…) if (…) return`.
  { name: 'ledger shape: the first entry found returns from inside for await over the store', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('k1'), yieldOf('k2'), yieldOf('k3')], fin: [log('entries closed')] }), afn(loop(0, 'entry', exitAt('ret', 2, 'found')), { s: 'ret', v: val('none') })],
    main: [cocall(1, 'r0'), { s: 'then', p: 'r0', ok: [log('result', { arg: true })], as: 'x' }, ...ladder(12)] } },
];

// The review's fixes (reports/O2b-review.md, O2b-fix.md). An entry with
// `electronOnly` is compared with Electron's Node only: Node 26.13 differs
// from it there, in frames only, and the differential pins that it does.
const KEEPS = 'keeps the caller\'s frame on both Nodes';
const LOSES = 'runs the body in the empty frame on Electron\'s V8';
const NODE_26_KEEPS = 'Node 26.13\'s V8 keeps the frame after a yield of a primitive or a plain object';
/** `yield v` with two `next` queued inside store `a`'s frame, then a read of the frame, and one after an await. */
const frameAfterYield = (kind, v, loses, setup = [], co = []) => ({
  name: `frame rule: a yield of ${kind} with a next queued ${loses ? LOSES : KEEPS}`,
  ...(loses ? { electronOnly: NODE_26_KEEPS } : {}),
  program: { fns: [], co: [gen(v === undefined ? { s: 'yield' } : { s: 'yield', v }, log('after'), { s: 'await', v: val(null) }, log('after await')), ...co],
    main: [...setup, cocall(0, 'g0'), { s: 'run', st: 'a', v: val('C'), body: [next('g0', 'n1'), next('g0', 'n2')] }] },
});
const made = (kind) => ({ made: kind });
/** `return(v)` received at a `yield*` over `inner` (an async generator, a sync iterable with `return`, an array, an async iterator without `return`). */
const INNERS = {
  'an async generator': { co: [gen({ s: 'try', body: [{ s: 'yield', v: val('a'), l: 'in gave' }, yieldOf('b')], catch: [log('in caught')], as: 'c', fin: [log('in fin')] })], source: { call: 1 }, setup: [] },
  'a sync iterable with return': { co: [], source: { v: reg('s0') }, setup: [{ s: 'syncIt', as: 's0', of: [val('a'), val('b')], ret: true, l: 'sync' }] },
  'an array (no return)': { co: [], source: { v: reg('s0') }, setup: [{ s: 'arr', as: 's0', of: [val('a'), val('b')] }] },
  'an async iterator without return': { co: [], source: { v: reg('s0') }, setup: [{ s: 'asyncIt', as: 's0', of: [val('a'), val('b')], l: 'it' }] },
};
const RETURNED = {
  'a value': { make: [], v: val('V') },
  'a fulfilled promise': { make: [{ s: 'resolve', v: val('V'), as: 'r0' }], v: reg('r0') },
  'a rejected promise': { make: [{ s: 'reject', v: val('E'), as: 'r0' }], v: reg('r0') },
};
const returnAtYieldStar = (innerName, returnedName, queued = false) => {
  const inner = INNERS[innerName], returned = RETURNED[returnedName];
  const outer = gen({ s: 'try', body: [{ s: 'yieldStar', ...inner.source, l: 'ystar' }, log('after ystar')], catch: [log('out caught')], as: 'oc', fin: [log('out fin')] });
  const calls = [gReturn('g0', 'ret', returned.v), next('g0', 'n2'), ...ladder(10)];
  return {
    name: `return of ${returnedName} at a yield* over ${innerName}${queued ? ', queued behind the first next' : ''}${returnedName === 'a rejected promise' ? ': V8 sends the reason to the inner iterator as next(reason)' : ''}`,
    program: { fns: [], co: [outer, ...inner.co],
      main: queued ? [...inner.setup, ...returned.make, cocall(0, 'g0'), next('g0', 'n1'), ...calls]
        : [...inner.setup, cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [...returned.make, ...calls] }] },
  };
};
/** `immediate`, as `yieldToEventLoop` (`new Promise((resolve) => setImmediate(resolve))`) is awaited. */
const toLoop = (p) => [{ s: 'new', as: p, body: [{ s: 'immediate', n: 'i0', body: [{ s: 'settle', p, ok: true }] }] }, { s: 'await', v: reg(p) }];
/** `walkFiles` (session-mutations.js:1130), breadth first: per directory one `for…of` over an awaited listing, the admission check (it reads the `context` store) before each entry, `yield file`, the progress meter after the directory, then a yield to the loop per level. */
const walkFiles = gen({ s: 'await', v: reg('listing') }, log('admission'), { s: 'yield', v: val('a') }, log('admission'), { s: 'yield', v: val('b') }, log('progress'), ...toLoop('q0'),
  { s: 'await', v: reg('listing') }, log('admission'), { s: 'yield', v: val('dir/c') }, log('progress'), ...toLoop('q1'));

const FIX_PROGRAMS = [
  // B1: the frame rule, kind by kind (O2b-fix.md has the measured table).
  frameAfterYield('a number', val(1), true),
  frameAfterYield('a string', val('s'), true),
  frameAfterYield('null', val(null), true),
  frameAfterYield('a boolean', val(true), true),
  frameAfterYield('undefined', undefined, true),
  frameAfterYield('a bigint', made('bigint'), true),
  frameAfterYield('a plain object', made('object'), true),
  frameAfterYield('a sync iterable (a plain object with Symbol.iterator)', reg('s0'), true, [{ s: 'syncIt', as: 's0', of: [val(1)] }]),
  frameAfterYield('an async iterable (a plain object with Symbol.asyncIterator)', reg('s0'), true, [{ s: 'asyncIt', as: 's0', of: [val(1)] }]),
  frameAfterYield('a plain object with an own then (undefined)', made('ownThen'), false),
  frameAfterYield('an object with a null prototype', made('nullProto'), false),
  frameAfterYield('an array', reg('s0'), false, [{ s: 'arr', as: 's0', of: [val(1), val(2)] }]),
  frameAfterYield('a Buffer', made('buffer'), false),
  frameAfterYield('a Uint8Array', made('uint8'), false),
  frameAfterYield('an Error', made('error'), false),
  frameAfterYield('a function', made('function'), false),
  frameAfterYield('a class instance', made('instance'), false),
  frameAfterYield('a Map', made('map'), false),
  frameAfterYield('a Set', made('set'), false),
  frameAfterYield('a Date', made('date'), false),
  frameAfterYield('a boxed number', made('boxed'), false),
  frameAfterYield('a fulfilled promise', reg('p'), false, [{ s: 'resolve', v: val('p'), as: 'p' }]),
  frameAfterYield('a generator object', reg('g1'), false, [cocall(1, 'g1')], [gen(yieldOf('inner'))]),
  { name: 'frame rule: a return queued after a yield of an array runs the finally in the caller\'s frame', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yield', v: reg('s0') }, log('not reached')], fin: [log('fin')] })],
    main: [{ s: 'arr', as: 's0', of: [val(1)] }, cocall(0, 'g0'), { s: 'run', st: 'a', v: val('C'), body: [next('g0', 'n1'), gReturn('g0', 'ret', 'R')] }, ...ladder(4)] } },
  { name: 'frame rule: a return queued after a yield of a string runs the finally in the empty frame on Electron\'s V8', electronOnly: NODE_26_KEEPS, program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yield', v: val('s') }, log('not reached')], fin: [log('fin')] })],
    main: [cocall(0, 'g0'), { s: 'run', st: 'a', v: val('C'), body: [next('g0', 'n1'), gReturn('g0', 'ret', 'R')] }, ...ladder(4)] } },
  // The ledger's two non-plain shapes: `pagesOf` (session-changes-store.js:273) yields arrays of pages, `byteStream` (session-mutations.js:3113) Buffers.
  { name: 'ledger shape: pagesOf yields arrays: with a pull queued the body keeps the caller\'s frame', program: { fns: [],
    co: [gen({ s: 'yield', v: reg('page') }, log('page written'), { s: 'yield', v: reg('page') }, log('last page'))],
    main: [{ s: 'arr', as: 'page', of: [val('k1'), val('k2')] }, cocall(0, 'g0'), { s: 'run', st: 'a', v: val('C'), body: [next('g0', 'n1'), next('g0', 'n2'), next('g0', 'n3')] }] } },
  { name: 'ledger shape: byteStream yields Buffers: with a pull queued the body keeps the caller\'s frame', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yield', v: made('buffer') }, log('chunk read'), { s: 'yield', v: made('buffer') }, log('end of file')], fin: [log('stream destroyed')] })],
    main: [cocall(0, 'g0'), { s: 'run', st: 'a', v: val('C'), body: [next('g0', 'pull1'), next('g0', 'pull2'), gReturn('g0', 'stream-return')] }, ...ladder(6)] } },
  // walkFiles as it is (the review's M2), and the latent exposure the owner was told of.
  { name: 'ledger shape: walkFiles, breadth first, pulled by for await: the admission checks keep the frame', program: { fns: [], until: 40,
    co: [walkFiles, afn(loop(0, 'file'), log('end'))],
    main: [{ s: 'resolve', v: val('entries'), as: 'listing' }, { s: 'run', st: 'a', v: val('C'), body: [cocall(1)] }] } },
  { name: 'ledger shape: walkFiles pulled ahead (next queued): the admission check after yield file runs in the empty frame on Electron\'s V8', electronOnly: NODE_26_KEEPS, program: { fns: [], until: 40,
    co: [walkFiles],
    main: [{ s: 'resolve', v: val('entries'), as: 'listing' }, cocall(0, 'g0'), { s: 'run', st: 'a', v: val('C'), body: [next('g0', 'f1'), next('g0', 'f2'), next('g0', 'f3'), next('g0', 'f4')] }] } },
  // B2: return(v) received at a yield*.
  ...Object.keys(INNERS).flatMap((inner) => Object.keys(RETURNED).map((returned) => returnAtYieldStar(inner, returned))),
  returnAtYieldStar('an async generator', 'a rejected promise', true),
  returnAtYieldStar('a sync iterable with return', 'a rejected promise', true),
  // S2 and S3: `return;` and `break` in a generator body.
  { name: 'a bare return; in a generator takes no job; return undefined awaits once', program: { fns: [],
    co: [gen(yieldOf('v'), { s: 'retBare' }, yieldOf('never')), gen(yieldOf('v'), { s: 'ret' }, yieldOf('never'))],
    main: [cocall(0, 'g0'), cocall(1, 'g1'), next('g0', 'bare1'), next('g1', 'undef1'), next('g0', 'bare2'), next('g1', 'undef2'), ...ladder(6)] } },
  { name: 'a bare return; inside try/finally in a generator runs the finally, then completes', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('v'), { s: 'retBare' }, yieldOf('never')], fin: [log('fin'), { s: 'await', v: val(null) }, log('fin awaited')] }, yieldOf('never either'))],
    main: [cocall(0, 'g0'), next('g0', 'n1'), next('g0', 'n2'), next('g0', 'n3'), ...ladder(6)] } },
  { name: 'ledger shape: values, yield* runRecords(...) then return; (no job for the return)', program: { fns: [],
    co: [gen(yieldOf('r1'), yieldOf('r2')), gen({ s: 'yieldStar', call: 0 }, { s: 'retBare' }, yieldOf('never')), afn(loop(1, 'row'), log('end'))],
    main: [cocall(2), ...ladder(14)] } },
  { name: 'break out of for await inside a generator body closes the iterator, then the body goes on', program: { fns: [],
    co: [gen({ s: 'try', body: [yieldOf('a'), yieldOf('b'), yieldOf('c')], fin: [log('inner fin')] }), gen(loop(0, 'x', { s: 'yield', v: reg('x') }, exitAt('break', 2)), yieldOf('after loop')), afn(loop(1, 'y'), log('end'))],
    main: [cocall(2), ...ladder(16)] } },
  { name: 'continue in for await inside a generator body skips the rest of the iteration, the loop goes on', program: { fns: [],
    co: [gen(yieldOf('a'), yieldOf('b'), yieldOf('c')), gen(loop(0, 'x', exitAt('continue', 2), { s: 'yield', v: reg('x') }), yieldOf('after loop')), afn(loop(1, 'y'), log('end'))],
    main: [cocall(2), ...ladder(16)] } },
  // P12, P13, P17: iterators the earlier programs could not make.
  { name: 'yield* over an async iterator without return, then return: the value is awaited again', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yieldStar', v: reg('s0'), l: 'ystar' }], fin: [log('fin')] })],
    main: [{ s: 'asyncIt', as: 's0', of: [val('a'), val('b')], l: 'it' }, cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 'R'), ...ladder(6)] }] } },
  { name: 'yield* over an async iterator with return but no throw, then throw: it is closed, then a TypeError', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yieldStar', v: reg('s0'), l: 'ystar' }], catch: [log('caught')], as: 'c' })],
    main: [{ s: 'asyncIt', as: 's0', of: [val('a'), val('b')], ret: true, l: 'it' }, cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gThrow('g0', 't', 'E'), ...ladder(6)] }] } },
  { name: 'yield* over an async iterator without return or throw, then throw: a TypeError, nothing to close', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yieldStar', v: reg('s0'), l: 'ystar' }], catch: [log('caught')], as: 'c' })],
    main: [{ s: 'asyncIt', as: 's0', of: [val('a'), val('b')], l: 'it' }, cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gThrow('g0', 't', 'E'), ...ladder(6)] }] } },
  { name: 'for await over an async iterator without return: break closes nothing', program: { fns: [],
    co: [afn(loop(reg('s0'), 'x', exitAt('break', 1)), log('after'))],
    main: [{ s: 'asyncIt', as: 's0', of: [val('a'), val('b')], l: 'it' }, cocall(0), ...ladder(6)] } },
  { name: 'yield* over a sync iterable whose return gives a rejected promise, then return: it is closed once, the rejection is the result', program: { fns: [],
    co: [gen({ s: 'yieldStar', v: reg('s0') })],
    main: [{ s: 'reject', v: val('closing failed'), as: 'r0' }, { s: 'handle', p: 'r0' }, { s: 'syncIt', as: 's0', of: [val('a'), val('b')], ret: true, retv: reg('r0'), l: 'sync' },
      cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 'R'), next('g0', 'n2'), ...ladder(6)] }] } },
  { name: 'yield* over a sync iterable whose return gives a rejected value not done, then return: the rejection is not a reason to close it again', program: { fns: [],
    co: [gen({ s: 'try', body: [{ s: 'yieldStar', v: reg('s0') }], catch: [log('caught')], as: 'c' })],
    main: [{ s: 'reject', v: val('closing failed'), as: 'r0' }, { s: 'handle', p: 'r0' }, { s: 'syncIt', as: 's0', of: [val('a'), val('b')], ret: true, retv: reg('r0'), retOpen: true, l: 'sync' },
      cocall(0, 'g0'), next('g0', 'n1'), { s: 'timeout', n: 't0', ms: 1, body: [gReturn('g0', 'ret', 'R'), next('g0', 'n2'), ...ladder(6)] }] } },
  // E09, E10.
  { name: 'listenerCount counts once listeners too', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', []), on('e0', 'x', 'h1', [], 'once'), on('e0', 'x', 'h2', [], 'prependOnce'), { s: 'count', e: 'e0', ev: 'x', l: 'count' },
      emit('e0', 'x', 1, 'had'), { s: 'count', e: 'e0', ev: 'x', l: 'after emit' }] } },
  { name: 'removeAllListeners with no event removes the listeners of every event', program: { fns: [],
    main: [{ s: 'em', n: 'e0' }, on('e0', 'x', 'h0', []), on('e0', 'y', 'h1', []), on('e0', 'error', 'h2', []), { s: 'offAll', e: 'e0' },
      emit('e0', 'x', 1, 'x had'), emit('e0', 'y', 2, 'y had'), { s: 'count', e: 'e0', ev: 'x', l: 'x count' }, { s: 'count', e: 'e0', ev: 'y', l: 'y count' }] } },
];

/**
 * Hand-written programs: one per rule of the layer (named, so a failure
 * names the rule), the review's B1 timer programs and its B2 transcripts.
 */
export const FIXED_PROGRAMS = [
  { name: 'await of a settled promise yields one job', program: { fns: [{ body: [{ s: 'await', v: reg('g'), l: 'x' }] }],
    main: [{ s: 'resolve', v: val('g'), as: 'g' }, { s: 'call', f: 0 }, log('y')] } },
  { name: 'await of a plain value yields one job', program: { fns: [{ body: [{ s: 'await', v: val('p'), l: 'x' }] }, { body: [{ s: 'await', v: reg('g'), l: 'z' }] }],
    main: [{ s: 'resolve', v: val('g'), as: 'g' }, { s: 'call', f: 0 }, { s: 'call', f: 1 }, log('y')] } },
  { name: 'an async body runs at the call up to its first await', program: { fns: [{ body: [log('body'), { s: 'await', v: val(1) }, log('after')] }],
    main: [log('before'), { s: 'call', f: 0 }, log('caller')] } },
  { name: 'three awaits finish after one', program: { fns: [
    { body: [{ s: 'await', v: reg('g') }, { s: 'await', v: reg('g') }, { s: 'await', v: reg('g') }, log('three')] },
    { body: [{ s: 'await', v: reg('g') }, log('one')] }],
  main: [{ s: 'resolve', v: val('g'), as: 'g' }, { s: 'call', f: 0 }, { s: 'call', f: 1 }] } },
  { name: 'return of a promise takes two jobs more than return await', program: { fns: [
    { body: [{ s: 'ret', v: reg('g') }] }, { body: [{ s: 'retAwait', v: reg('g') }] }, { body: [{ s: 'ret', v: val('plain') }] }],
  main: [{ s: 'resolve', v: val('g'), as: 'g' }, { s: 'call', f: 0, as: 'a' }, { s: 'call', f: 1, as: 'b' }, { s: 'call', f: 2, as: 'c' },
    { s: 'then', p: 'a', ok: [log('a', { arg: true })], as: 'ta' }, { s: 'then', p: 'b', ok: [log('b', { arg: true })], as: 'tb' },
    { s: 'then', p: 'c', ok: [log('c', { arg: true })], as: 'tc' }] } },
  { name: 'resolving with a promise takes the thenable job and the reaction', program: { fns: [],
    main: [{ s: 'resolve', v: val('inner'), as: 'g' }, { s: 'new', as: 'p0', body: [{ s: 'settle', p: 'p0', ok: true, v: reg('g') }] },
      { s: 'new', as: 'p1', body: [{ s: 'settle', p: 'p1', ok: true, v: val('plain') }] },
      { s: 'then', p: 'p0', ok: [log('via promise')], as: 'x' }, { s: 'then', p: 'p1', ok: [log('plain')], as: 'y' },
      { s: 'micro', body: [log('m1')] }, { s: 'micro', body: [{ s: 'micro', body: [log('m2')] }] }] } },
  { name: 'reactions run in registration order', program: { fns: [],
    main: [{ s: 'new', as: 'p0' }, { s: 'then', p: 'p0', ok: [log('first')], as: 'a' }, { s: 'then', p: 'p0', ok: [log('second')], as: 'b' },
      { s: 'then', p: 'p0', ok: [log('third')], as: 'c' }, { s: 'settle', p: 'p0', ok: true, v: val(1) }] } },
  { name: 'ticks run before microtasks, all of them, then again', program: { fns: [],
    main: [{ s: 'micro', body: [log('m1'), { s: 'tick', body: [log('t3')] }] }, { s: 'tick', body: [log('t1'), { s: 'tick', body: [log('t2')] }, { s: 'micro', body: [log('m2')] }] }] } },
  { name: 'Promise.all settles one job after its last element', program: { fns: [],
    main: [{ s: 'resolve', v: val('a'), as: 'g' }, { s: 'all', of: [reg('g'), val('b')], as: 'all' }, { s: 'then', p: 'all', ok: [log('all', { arg: true })], as: 'x' },
      { s: 'then', p: 'g', ok: [log('g')], as: 'y' }, { s: 'micro', body: [log('m1'), { s: 'micro', body: [log('m2'), { s: 'micro', body: [log('m3')] }] }] }] } },
  { name: 'Promise.all of nothing fulfils at once', program: { fns: [],
    main: [{ s: 'all', of: [], as: 'all' }, { s: 'then', p: 'all', ok: [log('empty', { arg: true })], as: 'x' }, { s: 'micro', body: [log('m1')] }] } },
  { name: 'Promise.all of plain values still takes a job per element', program: { fns: [],
    main: [{ s: 'micro', body: [log('m0')] }, { s: 'all', of: [val('a'), val('b')], as: 'x' }, { s: 'then', p: 'x', ok: [log('all', { arg: true })], as: 'y' }, { s: 'micro', body: [log('m1')] }] } },
  { name: 'race settles with the first element to settle and ignores the rest', program: { fns: [],
    main: [{ s: 'resolve', v: val('a'), as: 'g' }, { s: 'resolve', v: val('b'), as: 'h' }, { s: 'race', of: [reg('g'), reg('h'), val('c')], as: 'r' },
      { s: 'then', p: 'r', ok: [log('race', { arg: true })], as: 'x' }] } },
  { name: 'allSettled keeps the order of its elements, not of their settling', program: { fns: [],
    main: [{ s: 'new', as: 'p0' }, { s: 'resolve', v: val('early'), as: 'g' }, { s: 'allSettled', of: [reg('p0'), reg('g')], as: 's' },
      { s: 'then', p: 's', ok: [log('settled', { arg: true })], as: 'x' }, { s: 'micro', body: [{ s: 'settle', p: 'p0', ok: false, v: val('late') }] }] } },
  { name: 'allSettled and race', program: { fns: [],
    main: [{ s: 'reject', v: val('e'), as: 'r' }, { s: 'resolve', v: val('a'), as: 'g' }, { s: 'allSettled', of: [reg('r'), reg('g'), val('c')], as: 's' },
      { s: 'then', p: 's', ok: [log('settled', { arg: true })], as: 'x' }, { s: 'race', of: [reg('r'), reg('g')], as: 'race' },
      { s: 'then', p: 'race', err: [log('race', { arg: true })], ok: [log('race won', { arg: true })], as: 'y' }] } },
  { name: 'finally takes its extra jobs and passes the value through', program: { fns: [],
    main: [{ s: 'resolve', v: val('a'), as: 'g' }, { s: 'finally', p: 'g', body: [log('cleanup')], as: 'f' }, { s: 'then', p: 'f', ok: [log('after finally', { arg: true })], as: 'x' },
      { s: 'then', p: 'g', ok: [log('then')], as: 'y' }, { s: 'then', p: 'y', ok: [log('then then')], as: 'z' },
      { s: 'then', p: 'z', ok: [log('then then then')], as: 'w' }, { s: 'then', p: 'w', ok: [log('four')], as: 'v' }] } },
  { name: 'catch handles, try catches an await', program: { fns: [{ body: [{ s: 'try', body: [{ s: 'await', v: reg('r') }, log('not reached')], catch: [log('caught')], as: 'c' }, log('after')] }],
    main: [{ s: 'reject', v: val('e1'), as: 'r' }, { s: 'call', f: 0 }, { s: 'catch', p: 'r', err: [log('catch', { arg: true })], as: 'x' }] } },
  { name: 'an unhandled rejection is reported after the ticks and microtasks; one handled in time is not', program: { fns: [],
    main: [{ s: 'reject', v: val('lost'), as: 'a' }, { s: 'reject', v: val('found'), as: 'b' }, { s: 'micro', body: [log('m'), { s: 'handle', p: 'b' }] }, { s: 'tick', body: [log('t')] }] } },
  { name: 'nextTick from a timer runs before the next timer', program: { fns: [],
    main: [{ s: 'timeout', n: 't0', ms: 5, body: [log('T0'), { s: 'tick', body: [log('tick')] }, { s: 'micro', body: [log('micro')] }] }, { s: 'timeout', n: 't1', ms: 5, body: [log('T1')] }] } },
  { name: 'immediates queued in the check phase wait for the next', program: { fns: [],
    main: [{ s: 'immediate', n: 'i0', body: [log('I0'), { s: 'immediate', n: 'i1', body: [log('I1')] }] }, { s: 'timeout', n: 't0', ms: 0, body: [log('T')] }] } },
  { name: 'an immediate cleared between two immediates is skipped', program: { fns: [],
    main: [{ s: 'immediate', n: 'i0', body: [log('I0'), { s: 'micro', body: [{ s: 'clearImmediate', n: 'i1' }] }] }, { s: 'immediate', n: 'i1', body: [log('I1')] }] } },
  { name: 'a message is handled in poll, before check and timers', program: { fns: [],
    main: [{ s: 'timeout', n: 't0', ms: 3, body: [log('T'), { s: 'immediate', n: 'i0', body: [log('I')] }] }], messages: [{ at: 3, body: [log('message')] }, { at: 3, body: [log('second message')] }] } },
  { name: 'a timer callback that makes a timer of its own duration runs it after the others (S3)', program: { fns: [],
    main: [{ s: 'interval', n: 't0', ms: 1, times: 2, body: [log('T1'), { s: 'timeout', n: 't1', ms: 1, body: [log('T2')] }] }] } },
  { name: 'an interval that fires late re-arms from the time read before its callback (n08)', program: { fns: [], until: 30,
    main: [{ s: 'interval', n: 't0', ms: 5, times: 3, body: [log('I')] }, { s: 'timeout', n: 't1', ms: 3, body: [log('block'), { s: 'block', ms: 4 }] }] } },
  { name: 'timers created by a timer of the same list, and lists of one expiry by id (n09)', program: { fns: [], until: 30,
    main: [{ s: 'timeout', n: 't0', ms: 4, body: [log('A'), { s: 'block', ms: 2 }, { s: 'timeout', n: 't2', ms: 4, body: [log('C')] }] },
      { s: 'timeout', n: 't1', ms: 2, body: [log('B'), { s: 'timeout', n: 't3', ms: 6, body: [log('D')] }] }, { s: 'timeout', n: 't4', ms: 8, body: [log('E')] }] } },
  { name: 'an emptied unrefed list stays until visited, a refed one goes (n09)', program: { fns: [], until: 30,
    main: [{ s: 'timeout', n: 'a', ms: 3, unref: true, body: [log('a')] }, { s: 'clear', n: 'a' }, { s: 'timeout', n: 'b', ms: 4, body: [log('b')] },
      { s: 'timeout', n: 'c', ms: 2, body: [log('c'), { s: 'block', ms: 2 }, { s: 'timeout', n: 'd', ms: 3, body: [log('d')] }, { s: 'timeout', n: 'e', ms: 1, body: [log('e')] }] }] } },
  { name: 'an emptied unrefed list is kept, so a timer of its duration joins it and re-arms with a later id', program: { fns: [], until: 30,
    main: [{ s: 'timeout', n: 'a', ms: 3, unref: true, body: [log('a')] }, { s: 'clear', n: 'a' },
      { s: 'timeout', n: 'one', ms: 1, body: [{ s: 'timeout', n: 'b', ms: 3, body: [log('B')] }] },
      { s: 'timeout', n: 'two', ms: 2, body: [{ s: 'timeout', n: 'c', ms: 2, body: [log('C')] }] }] } },
  { name: 'a fractional delay is truncated (2.5 ms is 2 ms, 0.5 is 1)', program: { fns: [], until: 30,
    main: [{ s: 'timeout', n: 'a', ms: 2.9, body: [log('a')] }, { s: 'timeout', n: 'b', ms: 2, body: [log('b')] }, { s: 'timeout', n: 'c', ms: 0.5, body: [log('c')] }, { s: 'timeout', n: 'd', ms: 1, body: [log('d')] }] } },
  { name: 'between two timer lists the checkpoint runs (n06)', program: { fns: [], until: 30,
    main: [{ s: 'timeout', n: 'a', ms: 2, body: [log('a'), { s: 'micro', body: [log('a micro')] }, { s: 'tick', body: [log('a tick')] }] }, { s: 'timeout', n: 'b', ms: 3, body: [log('b')] },
      { s: 'timeout', n: 'c', ms: 1, body: [log('c'), { s: 'block', ms: 3 }] }] } },
  { name: 'between two immediates the checkpoint runs', program: { fns: [],
    main: [{ s: 'immediate', n: 'i0', body: [log('I0'), { s: 'micro', body: [log('m')] }, { s: 'tick', body: [log('t')] }] }, { s: 'immediate', n: 'i1', body: [log('I1')] }] } },
  { name: 'sleep is a timer whose callback resolves a promise', program: { fns: [{ body: [{ s: 'sleep', ms: 2 }, log('slept')] }],
    main: [{ s: 'call', f: 0 }, { s: 'timeout', n: 't0', ms: 2, body: [log('T')] }] } },
  // B1 of the second review (mini.jsonl): a continuation of one timer
  // clears the next of its list; the timer after it must still fire.
  ...[
    { n: 'b1 clear in a continuation two jobs deep', clear: [{ s: 'micro', body: [{ s: 'micro', body: [{ s: 'clear', n: 'T1' }] }] }] },
    { n: 'b1 clear in the callback', clear: [{ s: 'clear', n: 'T1' }] },
    { n: 'b1 clear in a continuation, the other list unrefed', clear: [{ s: 'micro', body: [{ s: 'clear', n: 'T1' }] }], unref: true },
  ].map(({ n, clear, unref }) => ({ name: n, program: { fns: [], until: 20, main: [
    { s: 'interval', n: 'T1', ms: 1, times: 3, body: [log('T1')] },
    { s: 'interval', n: 'T2', ms: 1, times: 3, ...(unref ? { unref: true } : {}), body: [log('T2')] },
    { s: 'timeout', n: 'T6', ms: 2, body: [log('T6'), { s: 'timeout', n: 'T10', ms: 1, body: [log('T10'), ...clear] }] },
  ] } })),
  { name: 'b1 three timers of one list', program: { fns: [], until: 20, main: [
    { s: 'timeout', n: 'T1', ms: 1, body: [log('T1')] }, { s: 'timeout', n: 'T2', ms: 1, body: [log('T2')] }, { s: 'timeout', n: 'T3', ms: 1, body: [log('T3')] }] } },
  { name: 'b1 a timer clears an earlier-created one of another list', program: { fns: [], until: 20, main: [
    { s: 'timeout', n: 'A', ms: 5, body: [log('A')] }, { s: 'timeout', n: 'B', ms: 5, body: [log('B')] }, { s: 'timeout', n: 'C', ms: 3, body: [log('C'), { s: 'clear', n: 'A' }] }] } },
  { name: 'b1 the first timer of a list clears the second', program: { fns: [], until: 20, main: [
    { s: 'timeout', n: 'A', ms: 1, body: [log('A'), { s: 'clear', n: 'B' }] }, { s: 'timeout', n: 'B', ms: 1, body: [log('B')] }, { s: 'timeout', n: 'C', ms: 1, body: [log('C')] }] } },
  { name: 'b1 a continuation of the first timer clears the second', program: { fns: [], until: 20, main: [
    { s: 'timeout', n: 'A', ms: 1, body: [log('A'), { s: 'micro', body: [{ s: 'micro', body: [{ s: 'clear', n: 'B' }] }] }] }, { s: 'timeout', n: 'B', ms: 1, body: [log('B')] }, { s: 'timeout', n: 'C', ms: 1, body: [log('C')] }] } },
  { name: 'b1 the list emptied and made anew by a continuation', program: { fns: [], until: 20, main: [
    { s: 'timeout', n: 'A', ms: 1, body: [log('A'), { s: 'micro', body: [{ s: 'clear', n: 'B' }, { s: 'timeout', n: 'D', ms: 1, body: [log('D')] }] }] }, { s: 'timeout', n: 'B', ms: 1, body: [log('B')] }] } },
  // B2 of the second review, as programs.
  { name: 'b2 background await of an open gate, then a report', program: { fns: [{ body: [{ s: 'await', v: reg('g') }, log('x')] }],
    main: [{ s: 'resolve', v: val(1), as: 'g' }, { s: 'call', f: 0 }, log('y')] } },
  { name: 'b2 a body with no await inside an async wrapper', program: { fns: [{ body: [log('bg started'), { s: 'call', f: 1, as: 'inner' }, { s: 'await', v: reg('inner') }, log('bg completed')] }, { body: [] }],
    main: [{ s: 'call', f: 0 }, log('main')] } },
  // Promise steps the third review's planted bugs escaped (J03, J07, J11).
  { name: 'new Promise whose executor throws rejects; a throw after it settled is ignored (J11)', program: { fns: [],
    main: [{ s: 'new', as: 'p0', body: [{ s: 'throw', v: val('boom') }] }, { s: 'then', p: 'p0', ok: [log('ok', { arg: true })], err: [log('rejected', { arg: true })], as: 'x' },
      { s: 'new', as: 'p1', body: [{ s: 'settle', p: 'p1', ok: true, v: val('kept') }, { s: 'throw', v: val('ignored') }] }, { s: 'then', p: 'p1', ok: [log('fulfilled', { arg: true })], err: [log('wrong', { arg: true })], as: 'y' }] } },
  { name: 'finally on a rejection waits for its handler\'s result before it rethrows (J04)', program: { fns: [],
    main: [{ s: 'reject', v: val('e'), as: 'r' }, { s: 'finally', p: 'r', body: [log('cleanup')], as: 'f' }, { s: 'catch', p: 'f', err: [log('rethrown', { arg: true })], as: 'x' },
      { s: 'micro', body: [log('m1'), { s: 'micro', body: [log('m2'), { s: 'micro', body: [log('m3'), { s: 'micro', body: [log('m4'), { s: 'micro', body: [log('m5')] }] }] }] }] }] } },
  { name: 'reject after resolve with a pending promise is ignored (J07)', program: { fns: [],
    main: [{ s: 'new', as: 'p0' }, { s: 'new', as: 'p1' }, { s: 'settle', p: 'p0', ok: true, v: reg('p1') }, { s: 'settle', p: 'p0', ok: false, v: val('ignored') },
      { s: 'then', p: 'p0', ok: [log('follows', { arg: true })], err: [log('wrong', { arg: true })], as: 'x' }, { s: 'micro', body: [{ s: 'settle', p: 'p1', ok: true, v: val('late') }] }] } },
  { name: 'ticks and microtasks the rejection listener queues run before the next callback (J03)', program: { fns: [],
    onUnhandled: [log('listener'), { s: 'tick', body: [log('listener tick')] }, { s: 'micro', body: [log('listener micro')] }],
    main: [{ s: 'reject', v: val('lost'), as: 'r' }, { s: 'timeout', n: 't0', ms: 0, body: [log('T')] }, { s: 'immediate', n: 'i0', body: [log('I')] }] } },
  // Abort signals, as Node's EventTarget dispatches `abort` (O2c rows).
  { name: 'abort listeners run in registration order, once or not, the reason set before the first; a second abort does nothing', program: { fns: [],
    main: [{ s: 'ctl', n: 'c0' }, { s: 'listen', g: 'c0', id: 'l0', once: true, body: [{ s: 'reason', g: 'c0', l: 'first sees' }] },
      { s: 'listen', g: 'c0', id: 'l1', body: [log('second')] }, { s: 'listen', g: 'c0', id: 'l2', once: true, body: [log('third')] },
      { s: 'abort', c: 'c0', v: val('x') }, { s: 'abort', c: 'c0', v: val('y') }, { s: 'reason', g: 'c0', l: 'after' }] } },
  { name: 'a listener removed by an earlier one is skipped; one added by an earlier one runs (the review\'s B1)', program: { fns: [],
    main: [{ s: 'ctl', n: 'c0' },
      { s: 'listen', g: 'c0', id: 'l0', once: true, body: [log('a'), { s: 'unlisten', id: 'l1' }, { s: 'listen', g: 'c0', id: 'l3', once: true, body: [log('late')] }] },
      { s: 'listen', g: 'c0', id: 'l1', once: true, body: [log('b')] }, { s: 'listen', g: 'c0', id: 'l2', once: true, body: [log('c')] },
      { s: 'abort', c: 'c0', v: val('r') }] } },
  { name: 'a listener added by the last listener does not run', program: { fns: [],
    main: [{ s: 'ctl', n: 'c0' }, { s: 'listen', g: 'c0', id: 'l0', once: true, body: [log('last'), { s: 'listen', g: 'c0', id: 'l1', body: [log('never')] }] },
      { s: 'abort', c: 'c0', v: val('r') }] } },
  { name: 'removing every listener during the dispatch starts a new list it never reaches', program: { fns: [],
    main: [{ s: 'ctl', n: 'c0' },
      { s: 'listen', g: 'c0', id: 'l0', body: [log('a'), { s: 'unlisten', id: 'l0' }, { s: 'unlisten', id: 'l1' }, { s: 'listen', g: 'c0', id: 'l2', body: [log('never')] }] },
      { s: 'listen', g: 'c0', id: 'l1', once: true, body: [log('b')] }, { s: 'abort', c: 'c0', v: val('r') }] } },
  { name: 'a listener added after the abort never runs; throwIfAborted throws the reason itself', program: { fns: [{ body: [
    { s: 'try', body: [{ s: 'checkAbort', g: 'c0' }, log('not reached')], catch: [log('after catch')], as: 'caught' }] }],
  main: [{ s: 'ctl', n: 'c0' }, { s: 'checkAbort', g: 'c0' }, log('live'), { s: 'abort', c: 'c0', v: val('x') }, { s: 'listen', g: 'c0', id: 'l0', body: [log('never')] }, { s: 'call', f: 0 }] } },
  { name: 'AbortSignal.any: dependents take the reason first and dispatch after the source; nested any flattens', program: { fns: [],
    main: [{ s: 'ctl', n: 'c0' }, { s: 'ctl', n: 'c1' }, { s: 'any', n: 's0', of: ['c0', 'c1'] }, { s: 'any', n: 's1', of: ['s0', 'c1'] },
      { s: 'listen', g: 'c0', id: 'l0', body: [{ s: 'reason', g: 's0', l: 'any in source' }, { s: 'reason', g: 's1', l: 'nested in source' }] },
      { s: 'listen', g: 's0', id: 'l1', body: [log('any')] }, { s: 'listen', g: 's1', id: 'l2', body: [log('nested')] }, { s: 'listen', g: 'c1', id: 'l3', body: [log('c1')] },
      { s: 'abort', c: 'c0', v: val('x') }, { s: 'abort', c: 'c1', v: val('y') }, { s: 'reason', g: 's1', l: 'end' }] } },
  { name: 'AbortSignal.any of an aborted source is aborted; of nothing it never aborts', program: { fns: [],
    main: [{ s: 'ctl', n: 'c0' }, { s: 'abort', c: 'c0', v: val('x') }, { s: 'any', n: 's0', of: ['c0'] }, { s: 'reason', g: 's0', l: 'a' },
      { s: 'any', n: 's1', of: [] }, { s: 'reason', g: 's1', l: 'b' }] } },
  { name: 'a listener that aborts another controller runs that one\'s dependents inside its own dispatch', program: { fns: [],
    main: [{ s: 'ctl', n: 'c0' }, { s: 'ctl', n: 'c1' }, { s: 'any', n: 's0', of: ['c1'] },
      { s: 'listen', g: 'c0', id: 'l0', body: [log('a'), { s: 'abort', c: 'c1', v: val('z') }] }, { s: 'listen', g: 's0', id: 'l1', body: [log('s0')] },
      { s: 'listen', g: 'c0', id: 'l2', body: [log('c')] }, { s: 'abort', c: 'c0', v: val('x') }] } },
  // The async context frame (O2a rows, design section 2.4).
  { name: 'two stores keep their own values; exit clears one (the review\'s B2)', program: { fns: [],
    main: [{ s: 'run', st: 'a', v: val('callA'), body: [{ s: 'run', st: 'b', v: val(7), body: [log('both'), { s: 'exit', st: 'a', body: [log('b only')] }] }, log('a only')] }, log('none')] } },
  { name: 'a reaction and an await continuation run in the frame of the then and the await, not of the settling', program: { fns: [{ body: [{ s: 'await', v: reg('p0'), l: 'after await' }, log('continued')] }],
    main: [{ s: 'new', as: 'p0' }, { s: 'run', st: 'a', v: val('await'), body: [{ s: 'call', f: 0 }] }, { s: 'run', st: 'a', v: val('then'), body: [{ s: 'then', p: 'p0', ok: [log('reaction')], as: 'x' }] },
      { s: 'run', st: 'b', v: val('settle'), body: [{ s: 'settle', p: 'p0', ok: true, v: val(1) }] }] } },
  { name: 'microtasks, ticks, timers, intervals and immediates run in the frame that queued them', program: { fns: [], until: 20,
    main: [{ s: 'run', st: 'a', v: val('q'), body: [{ s: 'micro', body: [log('m')] }, { s: 'tick', body: [log('t')] }, { s: 'timeout', n: 't0', ms: 1, body: [log('T')] },
      { s: 'interval', n: 't1', ms: 2, times: 3, body: [log('I')] }, { s: 'immediate', n: 'i0', body: [log('Im')] }] }, log('outside')] } },
  { name: 'an unhandled rejection is reported in the frame of the rejection', program: { fns: [],
    onUnhandled: [{ s: 'micro', body: [log('listener micro')] }],
    main: [{ s: 'run', st: 'a', v: val('rejecting'), body: [{ s: 'reject', v: val('lost'), as: 'r' }] }, { s: 'run', st: 'b', v: val('other'), body: [log('x')] }] } },
  { name: 'a snapshot replays the frame it captured', program: { fns: [],
    main: [{ s: 'run', st: 'a', v: val('one'), body: [{ s: 'run', st: 'b', v: val('inner'), body: [{ s: 'snap', as: 'f0' }] }] },
      { s: 'run', st: 'a', v: val('two'), body: [{ s: 'replay', f: 'f0', body: [log('replayed'), { s: 'micro', body: [log('replayed micro')] }] }, log('two again')] }] } },
  { name: 'an abort listener runs in the frame of the code that aborts, not of the one that registered', program: { fns: [],
    main: [{ s: 'ctl', n: 'c0' }, { s: 'any', n: 's0', of: ['c0'] },
      { s: 'run', st: 'a', v: val('registered'), body: [{ s: 'listen', g: 'c0', id: 'l0', body: [log('listener')] }, { s: 'listen', g: 's0', id: 'l1', body: [log('any listener')] }] },
      { s: 'run', st: 'b', v: val('aborting'), body: [{ s: 'abort', c: 'c0', v: val('x') }] }] } },
  { name: 'an async function keeps the frame it was called in across awaits', program: { fns: [{ body: [log('start'), { s: 'await', v: val(1) }, log('one'), { s: 'sleep', ms: 2 }, log('slept'),
    { s: 'run', st: 'b', v: val('inner'), body: [log('inner')] }, { s: 'await', v: val(2) }, log('end')] }],
  main: [{ s: 'run', st: 'a', v: val('call'), body: [{ s: 'call', f: 0 }] }, log('caller')] } },

  // Async generators and `for await` (O2b, design section 2.1): one per
  // row of the specification behaviour relied on. `ladder(n)` is a chain of
  // n microtasks (m1 … mn) the trace counts jobs against.
  ...ITERATION_PROGRAMS,
  // Event emitters (O2b, design section 2.3).
  ...EMITTER_PROGRAMS,
  // The ledger's call shapes (design section 1.2).
  ...LEDGER_SHAPE_PROGRAMS,
  // The review's fixes (frame rule by kind, return at yield*, return;,
  // break, iterators without return or throw, emitter counts).
  ...FIX_PROGRAMS,
];
