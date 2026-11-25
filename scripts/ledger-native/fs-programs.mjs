// The I/O programs of the `node` module's differential test
// (fs-differential.mjs): file calls (`fs.promises` and a `FileHandle`),
// read streams consumed by `for await` or by listeners, `zlib.deflate`,
// mixed with promise chains, ticks, microtasks, immediates, timers, an
// `AsyncLocalStorage` frame and async functions. One program is JSON; the
// JavaScript arm (`fs-js-arm.mjs programs`) and the Rust arm
// (`ledger-native-probe fs-programs`, `io_program.rs`) interpret it.
//
// A program: `{ files: [{ name, size, seed }], fns: [{ body }], main, until }`.
// Statements of any body:
//   { s: 'log', l }                         an entry `l@<time>`
//   { s: 'chain', n, l }                    `Promise.resolve()` then n thens, the last logs `l`
//   { s: 'tick' | 'micro' | 'immediate', body }, { s: 'timeout', ms, body }
//   { s: 'run', v, body }                   `store.run(v, body)`: entries show `~v`
//   { s: 'call', f }                        calls `fns[f]` (each function is called once)
//   { s: 'io', op, a, l, body }             logs `l>`, starts a file call on `a`, logs `l=<result>` when it settles, then runs body
//   { s: 'stream', a, hwm, l, destroyAt }   `createReadStream(a, { highWaterMark })` with data/end/error/close listeners
// and in an async function also:
//   { s: 'await' }, { s: 'sleep', ms }
//   { s: 'awaitIo', op, a, l, h }           `l>`, `await` of a file call, `l=<result>`
//   { s: 'forAwait', a, hwm, l, exit, body } `for await` over a read stream; `exit: { at, kind: 'break' | 'throw' }`
// Ops: lstat, stat, readFile, readFileUtf8, readdir, access, realpath, writeFile, mkdir, rm, deflate, handle (open, read 16 at 0, close),
// and a handle's methods each awaited on its own: hopen (open `a` 'r', the handle named by the statement's label),
// hread (read 16 at 0), hstat, hclose of the handle `h` (a block of them in an async function, always closed).
//
// Every entry that descends from an I/O completion is `io:<strand>:<entry>`;
// every entry ends `#<unit>` (the arm's checkpoint).
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 32-bit FNV-1a of a chunk (its Rust twin is `io_program::fnv`). */
export function fnv(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

/** The bytes of a program's file (`size` bytes; byte i is `(i * 31 + seed) & 255`). */
export function fileBytes(size, seed) {
  const bytes = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + seed) & 255;
  return bytes;
}

/** Makes a program's directory: its files, `d/` (with `a` and `b`), `w/`, `m/`, and `ln` → the first file. */
export function prepareDir(dir, program) {
  mkdirSync(path.join(dir, 'd'), { recursive: true });
  mkdirSync(path.join(dir, 'w'));
  mkdirSync(path.join(dir, 'm'));
  writeFileSync(path.join(dir, 'd', 'a'), 'a');
  writeFileSync(path.join(dir, 'd', 'b'), 'bb');
  for (const file of program.files ?? []) writeFileSync(path.join(dir, file.name), fileBytes(file.size, file.seed ?? 0));
  symlinkSync(program.files?.[0]?.name ?? 'd', path.join(dir, 'ln'));
}

/** mulberry32, as the other generators use it. */
function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const below = (n) => Math.floor(next() * n);
  const pick = (items) => items[below(items.length)];
  return { next, below, pick };
}

const SIZES = [0, 1, 1000, 65535, 65536, 70000, 131071, 131072, 131073, 200000, 300000];
const HWMS = [4096, 16384, 65536, 131072];

/** `count` seeded random programs. */
export function generatePrograms(seed, count) {
  const rng = random(seed);
  const programs = [];
  for (let index = 0; index < count; index++) programs.push(generateProgram(rng));
  return programs;
}

function generateProgram(rng) {
  let labels = 0;
  const fresh = (prefix) => `${prefix}${labels++}`;
  const files = Array.from({ length: 1 + rng.below(3) }, (_, at) => ({ name: `f${at}`, size: rng.pick(SIZES), seed: rng.below(256) }));
  const fileNames = files.map((file) => file.name);
  const target = (op) => {
    const roll = rng.next();
    if (roll < 0.12) return 'nope';
    if (roll < 0.2) return op === 'readdir' ? 'd' : rng.pick(['d', 'ln']);
    if (op === 'readdir') return rng.next() < 0.7 ? 'd' : rng.pick(fileNames);
    return rng.pick(fileNames);
  };
  const OPS = ['lstat', 'stat', 'readFile', 'readFileUtf8', 'readdir', 'access', 'realpath', 'writeFile', 'mkdir', 'rm', 'deflate', 'handle'];
  // A stream's file: small enough at its high-water mark to keep traces short.
  const streamOf = () => {
    const roll = rng.next();
    const name = roll < 0.08 ? 'nope' : roll < 0.14 ? 'd' : rng.pick(fileNames);
    const size = files.find((file) => file.name === name)?.size ?? 0;
    const hwm = HWMS.filter((value) => size / value <= 24);
    return { a: name, hwm: rng.pick(hwm.length ? hwm : [131072]) };
  };
  const fnCount = rng.below(3);
  const fns = [];
  const called = new Set();
  // `owner`: the function whose body this is (-1 for main and its
  // callbacks' bodies): it calls only functions after it, so every function
  // runs (the uncalled ones are called from main at its end).
  const body = (depth, inFn, owner) => {
    const statements = [];
    const length = depth === 0 ? 2 + rng.below(5) : rng.below(3);
    for (let at = 0; at < length; at++) {
      const made = statement(depth, inFn, owner);
      if (Array.isArray(made)) statements.push(...made);
      else statements.push(made);
    }
    return statements;
  };
  const statement = (depth, inFn, owner) => {
    const roll = rng.below(inFn ? 17 : 12);
    const nested = () => (depth < 2 ? body(depth + 1, false, owner) : []);
    switch (roll) {
      case 0: return { s: 'log', l: fresh('p') };
      case 1: return { s: 'chain', n: 1 + rng.below(8), l: fresh('c') };
      case 2: return { s: 'tick', body: [{ s: 'log', l: fresh('t') }, ...nested()] };
      case 3: return { s: 'micro', body: [{ s: 'log', l: fresh('q') }, ...nested()] };
      case 4: return { s: 'immediate', body: [{ s: 'log', l: fresh('m') }, ...nested()] };
      case 5: return { s: 'timeout', ms: rng.below(12), body: [{ s: 'log', l: fresh('o') }, ...nested()] };
      case 6: { const inner = nested(); return { s: 'run', v: fresh('R'), body: inner.length ? inner : [{ s: 'log', l: fresh('r') }] }; }
      case 7:
      case 8: { const op = rng.pick(OPS); return { s: 'io', op, a: target(op), l: fresh('i'), body: depth < 2 && rng.next() < 0.5 ? body(depth + 1, false, owner) : [] }; }
      case 9: { const stream = streamOf(); return { s: 'stream', ...stream, l: fresh('s'), ...(rng.next() < 0.2 ? { destroyAt: rng.below(3) } : {}) }; }
      case 10:
      case 11: {
        const free = [...Array(fnCount).keys()].filter((f) => f > owner && !called.has(f));
        if (!free.length) return { s: 'chain', n: 1 + rng.below(4), l: fresh('c') };
        const f = rng.pick(free);
        called.add(f);
        return { s: 'call', f };
      }
      case 12: return rng.next() < 0.5 ? { s: 'await' } : { s: 'sleep', ms: rng.below(10) };
      case 13:
      case 14: { const op = rng.pick(OPS); return { s: 'awaitIo', op, a: target(op), l: fresh('a') }; }
      case 16: {
        // A handle opened, read or stat'ed once or twice, closed: each its own await.
        const h = fresh('h');
        const uses = Array.from({ length: 1 + rng.below(2) }, () => ({ s: 'awaitIo', op: rng.pick(['hread', 'hstat']), a: '', h, l: fresh('a') }));
        return [{ s: 'awaitIo', op: 'hopen', a: rng.pick([...fileNames, 'd']), l: h }, ...uses, { s: 'awaitIo', op: 'hclose', a: '', h, l: fresh('a') }];
      }
      default: {
        const stream = streamOf();
        const exit = rng.next() < 0.4 ? { exit: { at: rng.below(3), kind: rng.pick(['break', 'throw']) } } : {};
        return { s: 'forAwait', ...stream, l: fresh('g'), ...exit, body: rng.next() < 0.3 ? [{ s: 'chain', n: 1 + rng.below(3), l: fresh('c') }] : [] };
      }
    }
  };
  for (let f = 0; f < fnCount; f++) fns.push({ body: body(0, true, f) });
  const main = body(0, false, -1);
  for (let f = 0; f < fnCount; f++) if (!called.has(f)) { called.add(f); main.push({ s: 'call', f }); }
  return { files, fns, main, until: 60 };
}

const one = (size = 300_000) => [{ name: 'f0', size, seed: 7 }];

/**
 * The hand-written programs: one per rule and per shape the ledger's sites
 * take (`name`, `program`). The comparison is the same for all.
 */
export const FIXED_PROGRAMS = Object.freeze([
  { name: 'rule 1: Promise.all([lstat(a).then(drawA), five jobs.then(drawB)]) draws B first', program: {
    files: one(10), main: [{ s: 'io', op: 'lstat', a: 'f0', l: 'i0', body: [{ s: 'log', l: 'drawA' }] }, { s: 'chain', n: 5, l: 'drawB' }] } },
  { name: 'rule 1: every call kind continues after a long chain of its starting checkpoint', program: {
    files: one(1000), main: [
      ...['lstat', 'stat', 'readFile', 'readFileUtf8', 'readdir', 'access', 'realpath', 'writeFile', 'mkdir', 'rm', 'deflate', 'handle']
        .map((op, at) => ({ s: 'io', op, a: op === 'readdir' ? 'd' : 'f0', l: `i${at}` })),
      { s: 'chain', n: 40, l: 'fence' }, { s: 'tick', body: [{ s: 'micro', body: [{ s: 'log', l: 'late' }] }] }] } },
  { name: 'rule 1: a failed call continues in a later checkpoint too', program: {
    files: one(10), main: [{ s: 'io', op: 'lstat', a: 'nope', l: 'i0' }, { s: 'io', op: 'readFile', a: 'd', l: 'i1' }, { s: 'chain', n: 20, l: 'fence' }] } },
  { name: 'rule 1: a composite call (readFile) and an immediate queued before it', program: {
    files: one(700_000), main: [{ s: 'immediate', body: [{ s: 'log', l: 'imm' }] }, { s: 'io', op: 'readFile', a: 'f0', l: 'i0' }] } },
  { name: 'rule 1: calls started in a tick, a microtask, an immediate and a timer', program: {
    files: one(10), main: [
      { s: 'tick', body: [{ s: 'io', op: 'lstat', a: 'f0', l: 'it' }, { s: 'chain', n: 3, l: 'ct' }] },
      { s: 'micro', body: [{ s: 'io', op: 'stat', a: 'f0', l: 'iq' }, { s: 'chain', n: 3, l: 'cq' }] },
      { s: 'immediate', body: [{ s: 'io', op: 'readdir', a: 'd', l: 'im' }, { s: 'chain', n: 3, l: 'cm' }] },
      { s: 'timeout', ms: 4, body: [{ s: 'io', op: 'access', a: 'nope', l: 'io' }, { s: 'chain', n: 3, l: 'co' }] }] } },
  { name: 'rule 1: an async function awaits calls in sequence (lstat, readFile, a handle)', program: {
    files: one(5000), fns: [{ body: [{ s: 'awaitIo', op: 'lstat', a: 'f0', l: 'a0' }, { s: 'chain', n: 2, l: 'c0' }, { s: 'awaitIo', op: 'readFile', a: 'f0', l: 'a1' }, { s: 'awaitIo', op: 'handle', a: 'f0', l: 'a2' }, { s: 'log', l: 'end' }] }],
    main: [{ s: 'call', f: 0 }, { s: 'chain', n: 6, l: 'outside' }] } },
  { name: 'rule 1: a handle\'s open, read, stat and close, each awaited on its own, each continue after a long chain of its starting checkpoint', program: {
    files: one(1000), fns: [{ body: [
      { s: 'chain', n: 12, l: 'k0' }, { s: 'awaitIo', op: 'hopen', a: 'f0', l: 'h0' },
      { s: 'chain', n: 12, l: 'k1' }, { s: 'awaitIo', op: 'hread', a: '', h: 'h0', l: 'a1' },
      { s: 'chain', n: 12, l: 'k2' }, { s: 'awaitIo', op: 'hstat', a: '', h: 'h0', l: 'a2' },
      { s: 'chain', n: 12, l: 'k3' }, { s: 'awaitIo', op: 'hread', a: '', h: 'h0', l: 'a3' },
      { s: 'chain', n: 12, l: 'k4' }, { s: 'awaitIo', op: 'hclose', a: '', h: 'h0', l: 'a4' }, { s: 'log', l: 'end' }] }],
    main: [{ s: 'call', f: 0 }, { s: 'chain', n: 30, l: 'outside' }] } },
  { name: 'rule 1: a directory\'s handle: its read fails (EISDIR) in a later checkpoint, then it closes', program: {
    files: one(10), fns: [{ body: [{ s: 'awaitIo', op: 'hopen', a: 'd', l: 'h0' }, { s: 'chain', n: 6, l: 'k0' }, { s: 'awaitIo', op: 'hread', a: '', h: 'h0', l: 'a1' },
      { s: 'chain', n: 6, l: 'k1' }, { s: 'awaitIo', op: 'hstat', a: '', h: 'h0', l: 'a2' }, { s: 'awaitIo', op: 'hclose', a: '', h: 'h0', l: 'a3' }] }],
    main: [{ s: 'call', f: 0 }] } },
  { name: 'rule 1: continuations keep the frame of the code that awaits', program: {
    files: one(10), fns: [{ body: [{ s: 'awaitIo', op: 'stat', a: 'f0', l: 'a0' }, { s: 'log', l: 'after' }] }],
    main: [{ s: 'run', v: 'A', body: [{ s: 'io', op: 'lstat', a: 'f0', l: 'i0', body: [{ s: 'tick', body: [{ s: 'log', l: 'inA' }] }] }] }, { s: 'run', v: 'B', body: [{ s: 'call', f: 0 }] }] } },
  { name: 'rule 1: a timer made in a completion fires at the completion\'s time', program: {
    files: one(10), main: [{ s: 'timeout', ms: 5, body: [{ s: 'log', l: 'pure5' }] }, { s: 'io', op: 'lstat', a: 'f0', l: 'i0', body: [{ s: 'timeout', ms: 5, body: [{ s: 'log', l: 'io5' }] }] }] } },
  { name: 'rule 2: listeners see the values in order, then end, then close', program: {
    files: one(300_000), main: [{ s: 'stream', a: 'f0', hwm: 65536, l: 's0' }] } },
  { name: 'rule 2: an empty file gives end and close, no data', program: {
    files: one(0), main: [{ s: 'stream', a: 'f0', hwm: 65536, l: 's0' }] } },
  { name: 'rule 2: a stream destroyed in its second data listener gives close, no end', program: {
    files: one(300_000), main: [{ s: 'stream', a: 'f0', hwm: 65536, l: 's0', destroyAt: 1 }] } },
  { name: 'rule 2: a missing file gives error, then close', program: {
    files: one(10), main: [{ s: 'stream', a: 'nope', hwm: 65536, l: 's0' }] } },
  { name: 'rule 2: a directory opens, then its read fails: error, then close', program: {
    files: one(10), main: [{ s: 'stream', a: 'd', hwm: 65536, l: 's0' }] } },
  { name: 'rule 2: for await reads every value, then ends', program: {
    files: one(300_000), fns: [{ body: [{ s: 'forAwait', a: 'f0', hwm: 131072, l: 'g0' }, { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'rule 2: for await left by break after the first value', program: {
    files: one(300_000), fns: [{ body: [{ s: 'forAwait', a: 'f0', hwm: 65536, l: 'g0', exit: { at: 0, kind: 'break' } }, { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'rule 2: for await left by a throw in its second body', program: {
    files: one(300_000), fns: [{ body: [{ s: 'forAwait', a: 'f0', hwm: 65536, l: 'g0', exit: { at: 1, kind: 'throw' } }, { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'rule 2: for await over a missing file throws its error', program: {
    files: one(10), fns: [{ body: [{ s: 'forAwait', a: 'nope', hwm: 65536, l: 'g0' }] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'rule 2 and 3: two streams of one file at once keep their own order and cut', program: {
    files: one(400_000), fns: [{ body: [{ s: 'forAwait', a: 'f0', hwm: 131072, l: 'g0', body: [{ s: 'chain', n: 2, l: 'cg' }] }] }],
    main: [{ s: 'call', f: 0 }, { s: 'stream', a: 'f0', hwm: 65536, l: 's0' }, { s: 'io', op: 'readFile', a: 'f0', l: 'i0' }] } },
  { name: 'rule 3: the receipt site\'s cut (128 KiB) of a file one byte past two reads', program: {
    files: one(262_145), fns: [{ body: [{ s: 'sleep', ms: 3 }, { s: 'forAwait', a: 'f0', hwm: 131072, l: 'g0' }] }], main: [{ s: 'call', f: 0 }] } },
]);
