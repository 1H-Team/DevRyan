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
// The generator draws only integers (xorshift32), so its programs are the
// same on every platform and Node version.

/** A seeded generator of random programs. */
export function generatePrograms(seed, count) {
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
    const name = () => `L${label++}`;
    const target = () => (chance(55) ? { reg: pick(regs) } : { val: `v${below(9)}` });
    const handlerBody = (depth, fromFn) => {
      const body = [];
      for (let n = below(3); n > 0; n--) body.push(syncStmt(depth + 1, fromFn));
      if (chance(25)) body.push({ s: 'throw', v: { val: `e${below(9)}` } });
      else if (chance(70)) body.push({ s: 'give', v: chance(40) ? { arg: true } : target() });
      return [{ s: 'log', l: name(), v: { arg: true } }, ...body];
    };
    const syncStmt = (depth, fromFn) => {
      const choices = depth > 2 ? ['log', 'settle', 'resolve', 'reject', 'clear', 'handle', 'call', 'abort', 'unlisten', 'reason'] : [
        'log', 'log', 'call', 'call', 'new', 'settle', 'settle', 'then', 'then', 'catch', 'finally', 'all', 'allSettled', 'race',
        'resolve', 'reject', 'handle', 'tick', 'micro', 'timeout', 'timeout', 'interval', 'clear', 'immediate', 'clearImmediate', 'block',
        'run', 'run', 'exit', 'snap', 'replay', 'ctl', 'ctl', 'any', 'listen', 'listen', 'unlisten', 'abort', 'abort', 'reason'];
      const nested = () => {
        const body = [];
        for (let n = 1 + below(2); n > 0; n--) body.push(syncStmt(depth + 1, fromFn));
        return body;
      };
      switch (pick(choices)) {
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
          body: [{ s: 'log', l: name() }, ...(chance(60) ? [syncStmt(depth + 1, fromFn)] : [])] };
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
        case 'then': return { s: 'then', p: pick([...regs, ...deferred]), as: pick(regs), ...(chance(80) ? { ok: handlerBody(depth, fromFn) } : {}), ...(chance(50) ? { err: handlerBody(depth, fromFn) } : {}) };
        case 'catch': return { s: 'catch', p: pick([...regs, ...deferred]), as: pick(regs), err: handlerBody(depth, fromFn) };
        case 'finally': return { s: 'finally', p: pick([...regs, ...deferred]), as: pick(regs), body: handlerBody(depth, fromFn) };
        case 'all': case 'allSettled': case 'race': {
          const of = [];
          for (let n = below(4); n > 0; n--) of.push(chance(70) ? { reg: pick([...regs, ...deferred]) } : { val: `v${below(9)}` });
          return { s: pick(['all', 'allSettled', 'race']), of, as: pick(regs) };
        }
        case 'resolve': return { s: 'resolve', v: target(), as: pick(regs) };
        case 'reject': return { s: 'reject', v: { val: `e${below(9)}` }, as: pick(regs) };
        case 'handle': return { s: 'handle', p: pick([...regs, ...deferred]) };
        case 'tick': case 'micro': return { s: pick(['tick', 'micro']), body: [{ s: 'log', l: name() }, ...(chance(60) ? [syncStmt(depth + 1, fromFn)] : [])] };
        case 'timeout': return { s: 'timeout', n: pick(timers), ms: pick(DELAYS), ...(chance(20) ? { unref: true } : {}), body: [{ s: 'log', l: name() }, ...(chance(60) ? [syncStmt(depth + 1, fromFn)] : [])] };
        case 'interval': return { s: 'interval', n: pick(timers), ms: pick(DELAYS), times: 1 + below(3), ...(chance(20) ? { unref: true } : {}), body: [{ s: 'log', l: name() }, ...(chance(50) ? [syncStmt(depth + 1, fromFn)] : [])] };
        case 'clear': return { s: 'clear', n: pick(timers) };
        case 'block': return { s: 'block', ms: 1 + below(4) };
        case 'immediate': return { s: 'immediate', n: pick(immediates), body: [{ s: 'log', l: name() }, ...(chance(50) ? [syncStmt(depth + 1, fromFn)] : [])] };
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
    const fns = [];
    for (let f = 0; f < fnCount; f++) {
      const body = [{ s: 'log', l: name() }];
      for (let n = 1 + below(5); n > 0; n--) body.push(asyncStmt(0, f));
      if (chance(50)) body.push({ s: pick(['ret', 'retAwait']), v: target() });
      fns.push({ body });
    }
    const main = [];
    for (let n = 2 + below(6); n > 0; n--) main.push(syncStmt(0, -1));
    main.push({ s: 'call', f: 0, as: pick(regs) });
    const messages = [];
    for (let n = below(3); n > 0; n--) messages.push({ at: below(12), body: [syncStmt(0, -1), syncStmt(0, -1)] });
    // The listener's own statements never reject (a rejection there would be
    // reported to it again, for ever): a log, a tick, a microtask, a timer.
    const onUnhandled = chance(15) ? [{ s: 'log', l: name() },
      { s: pick(['tick', 'micro', 'timeout']), n: pick(timers), ms: pick(DELAYS), body: [{ s: 'log', l: name() }] }] : undefined;
    programs.push({ fns, main, messages, until: 40, ...(onUnhandled ? { onUnhandled } : {}) });
  }
  return programs;
}

const log = (l, v) => (v === undefined ? { s: 'log', l } : { s: 'log', l, v });
const reg = (name) => ({ reg: name });
const val = (value) => ({ val: value });

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
];
