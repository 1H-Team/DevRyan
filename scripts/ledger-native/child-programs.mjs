// The child-process programs of the native ledger's child-process
// differential test (child-differential.mjs): children spawned with a
// listener on every event of every source, `git()`-shaped calls (spawn,
// `pipeline` into stdin, `for await` over stdout, `await writing`, `await
// done`, a `finally` that kills), file calls, promise chains, ticks,
// microtasks, immediates, timers, an `AsyncLocalStorage` frame and async
// functions. One program is JSON; the JavaScript arm (`child-js-arm.mjs
// programs`) and the Rust arm (`ledger-native-probe child-programs`,
// `child_program.rs`) interpret it.
//
// A program: `{ files: [{ name, size, seed }], fns: [{ body }], main, until }`.
// Statements of any body:
//   { s: 'log' | 'chain' | 'tick' | 'micro' | 'immediate' | 'timeout' | 'run' | 'call' }   as in fs-programs.mjs
//   { s: 'block', until, ms }   the loop blocked (a long checkpoint) until the file `until` exists, within `ms`
//   { s: 'io', op, a, l, body }      a file call: lstat, readFile, readdir, writeFile
//   { s: 'spawn', l, file, args, env, input, consume, kill, onExit, onClose, onEnd }
//        logs `l>`; every event is an entry of its own strand: `l.spawn`, `l.error=<code>`,
//        `l.exit=<code>,<signal>,<stdin destroyed>`, `l.close=<code>,<signal>`, and per stdio
//        stream `l.<fd>.d` (each data event), `.end`, `.finish`, `.error=<code>`, `.close=<hadError>`;
//        `l.w=ok|!<code>` (a pipeline's settlement), `l.wcb=…` (a write's callback);
//        `kill: 'spawn' | 'data' | 'exit' | 'close'` logs `l.kill=<returned>` where it runs.
//        input: 'none' (stdin left open) | 'end' | { pipe } | { gen } | 'empty' | { write }
//        consume: 'data' (listeners on stdout and stderr) | 'none' (flushStdio drains them at the exit)
// and in an async function also:
//   { s: 'await' }, { s: 'sleep', ms }, { s: 'awaitIo', op, a, l }
//   { s: 'pgit', l, args, kind, abort, input, delimiter, breakAt }   the Git runner itself (the
//        product's `git()`/`gitTokens()`, the Rust's port) in a cancellable execution context:
//        `l=ok:<bytes or tokens>` or `l=!<code>` in strand `l` (in the caller's strand when
//        aborted before the call: no I/O happened)
//   { s: 'ptrees', l, commits: [[[key, data | null], …], …] }   the product's
//        `commitTreeChanges` (the Rust's port) with in-memory objects and the
//        `readTree` arrow of `commitDirect`: no I/O, `l=<tree id>` in the caller's strand
//   { s: 'git', l, file, args, env, input, exit }   `git()`'s shape; its entries are strand `l`:
//        `l.c` (each chunk), `l.broke`, `l.done`, `l.writing=ok`, `l.resolved`, `l.caught=<code>`,
//        `l.kill=<returned>` (when the loop ended normally), `l.end`; the function goes on in strand `l`.
// `env` starts with what the test sets (the PATH it runs with); `<dir>` in it
// is the program's directory. A child that starts a grandchild writes its pid
// to `<dir>/gc.pid`; the arm kills it (SIGKILL) as soon as the program is
// over. Every entry that
// descends from an event is `io:<strand>:<entry>`; every entry ends
// `#<unit>` (the arm's checkpoint).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { fileBytes } from './fs-programs.mjs';

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

/** Makes a program's directory: its files and `w/` (for writeFile). */
export function prepareDir(dir, program) {
  mkdirSync(path.join(dir, 'w'), { recursive: true });
  for (const file of program.files ?? []) writeFileSync(path.join(dir, file.name), fileBytes(file.size, file.seed ?? 0));
}

/** The children: `sh -c` scripts (found on PATH), each deterministic in its output. */
export const COMMANDS = Object.freeze({
  out: { script: 'printf abc; printf de >&2' },
  exit3: { script: 'printf x; exit 3' },
  quiet: { script: 'exit 0' },
  term: { script: 'kill -TERM $$' },
  big: { script: 'head -c 150000 /dev/zero', big: true },
  cat: { script: 'cat', reads: true },
  wait: { script: 'read line; printf "%s" "$line"', reads: true },
  printwait: { script: 'printf x; read y', reads: true, prints: true },
  missing: { file: 'devryan-o2e-missing-program' },
});

/** A statement's file and arguments for a command. */
export const command = (name) => {
  const entry = COMMANDS[name];
  return entry.file ? { file: entry.file, args: [] } : { file: 'sh', args: ['-c', entry.script] };
};

/** Puts `env` (`[[key, value]]`) before every child statement's own environment. */
export function withEnv(program, env) {
  const walk = (body) => (body ?? []).map((st) => {
    const out = { ...st };
    if (st.s === 'spawn' || st.s === 'git') out.env = [...env, ...(st.env ?? [])];
    for (const key of ['body', 'onExit', 'onClose', 'onEnd']) if (st[key]) out[key] = walk(st[key]);
    return out;
  });
  return { ...program, main: walk(program.main), fns: (program.fns ?? []).map((fn) => ({ ...fn, body: walk(fn.body) })) };
}

/** `count` seeded random programs. */
export function generatePrograms(seed, count) {
  const rng = random(seed);
  return Array.from({ length: count }, () => generateProgram(rng));
}

function generateProgram(rng) {
  let labels = 0;
  const fresh = (prefix) => `${prefix}${labels++}`;
  const files = [{ name: 'f0', size: rng.pick([0, 10, 70000]) }];
  const fnCount = rng.below(3);
  const fns = [];
  const called = new Set();
  const small = (depth) => {
    const out = [];
    for (let at = rng.below(3); at > 0; at--) {
      const roll = rng.below(6);
      if (roll === 0) out.push({ s: 'log', l: fresh('p') });
      else if (roll === 1) out.push({ s: 'chain', n: 1 + rng.below(6), l: fresh('c') });
      else if (roll === 2) out.push({ s: 'tick', body: [{ s: 'log', l: fresh('t') }, ...(depth < 1 ? small(depth + 1) : [])] });
      else if (roll === 3) out.push({ s: 'micro', body: [{ s: 'log', l: fresh('q') }] });
      else if (roll === 4) out.push({ s: 'immediate', body: [{ s: 'log', l: fresh('m') }] });
      else out.push({ s: 'timeout', ms: rng.below(8), body: [{ s: 'log', l: fresh('o') }] });
    }
    return out;
  };
  const spawnStatement = () => {
    const name = rng.pick(Object.keys(COMMANDS));
    const entry = COMMANDS[name];
    const st = { s: 'spawn', l: fresh('k'), ...command(name) };
    if (entry.reads) {
      const roll = rng.below(entry.prints ? 7 : 6);
      if (roll === 0) st.input = 'end';
      else if (roll === 1) st.input = { pipe: 'one line\n' };
      else if (roll === 2) st.input = { gen: ['a\n', 'b', 'c\n'] };
      else if (roll === 3) st.input = 'empty';
      else if (roll === 4) st.input = { write: 'hi\n' };
      else if (roll === 5) { st.input = 'none'; st.kill = 'spawn'; }
      else { st.input = 'none'; st.kill = 'data'; }
    } else {
      st.input = rng.pick(['none', 'end']);
    }
    if (!st.kill && rng.next() < 0.3) st.kill = rng.pick(['exit', 'close']);
    st.consume = entry.big || st.kill === 'data' || rng.next() < 0.7 ? 'data' : 'none';
    if (rng.next() < 0.4) st.onExit = small(0);
    if (rng.next() < 0.4) st.onClose = small(0);
    if (rng.next() < 0.2) st.onEnd = small(0);
    return st;
  };
  const gitStatement = () => {
    const name = rng.pick(['out', 'exit3', 'quiet', 'big', 'cat', 'missing']);
    const st = { s: 'git', l: fresh('g'), ...command(name) };
    if (name === 'cat') st.input = rng.pick([{ pipe: 'x\0y\0' }, { gen: ['r1\0', 'r2\0'] }, 'empty']);
    if ((name === 'big' || name === 'out' || name === 'cat') && rng.next() < 0.3) st.exit = { at: 0, kind: rng.pick(['break', 'throw']) };
    return st;
  };
  const body = (depth, inFn, owner) => {
    const statements = [];
    const length = depth === 0 ? 2 + rng.below(4) : rng.below(3);
    for (let at = 0; at < length; at++) {
      const roll = rng.below(inFn ? 14 : 11);
      const nested = () => (depth < 1 ? body(depth + 1, false, owner) : []);
      if (roll <= 1) statements.push(spawnStatement());
      else if (roll === 2) statements.push({ s: 'log', l: fresh('p') });
      else if (roll === 3) statements.push({ s: 'chain', n: 1 + rng.below(8), l: fresh('c') });
      else if (roll === 4) statements.push({ s: 'tick', body: [{ s: 'log', l: fresh('t') }, ...nested()] });
      else if (roll === 5) statements.push({ s: 'immediate', body: [{ s: 'log', l: fresh('m') }, ...nested()] });
      else if (roll === 6) statements.push({ s: 'timeout', ms: rng.below(10), body: [{ s: 'log', l: fresh('o') }, ...nested()] });
      else if (roll === 7) { const inner = nested(); statements.push({ s: 'run', v: fresh('R'), body: inner.length ? inner : [spawnStatement()] }); }
      else if (roll === 8) statements.push({ s: 'io', op: rng.pick(['lstat', 'readFile', 'readdir', 'writeFile']), a: rng.pick(['f0', 'nope', '.']), l: fresh('i'), body: depth < 1 && rng.next() < 0.5 ? small(0) : [] });
      else if (roll <= 10) {
        const free = [...Array(fnCount).keys()].filter((f) => f > owner && !called.has(f));
        if (!free.length) { statements.push({ s: 'chain', n: 2, l: fresh('c') }); continue; }
        const f = rng.pick(free);
        called.add(f);
        statements.push({ s: 'call', f });
      } else if (roll <= 12) statements.push(gitStatement());
      else statements.push(rng.next() < 0.5 ? { s: 'await' } : { s: 'awaitIo', op: rng.pick(['lstat', 'readFile']), a: 'f0', l: fresh('a') });
    }
    return statements;
  };
  for (let f = 0; f < fnCount; f++) fns.push({ body: body(0, true, f) });
  const main = body(0, false, -1);
  for (let f = 0; f < fnCount; f++) if (!called.has(f)) { called.add(f); main.push({ s: 'call', f }); }
  return { files, fns, main, until: 60 };
}

const spawnOf = (name, extra) => ({ s: 'spawn', ...command(name), ...extra });
const gitOf = (name, extra) => ({ s: 'git', ...command(name), ...extra });

/** The hand-written programs: one per rule and per shape the ledger's sites take. */
export const FIXED_PROGRAMS = Object.freeze([
  // Node's write tries the socket at once (`uv_try_write`): when the child
  // closed its stdin during the checkpoint that spawned it, the write fails
  // EPIPE synchronously and the error comes on a tick of that checkpoint.
  { name: 'rule 1 exception: a child closes its stdin during the long checkpoint that spawned it: EPIPE in that checkpoint', program: {
    main: [{ s: 'spawn', l: 'k0', file: 'sh', args: ['-c', 'exec 0<&-; : > "$EPIPE_MARK"'], env: [['EPIPE_MARK', '<dir>/stdin-closed']], input: { gen: ['a\n', 'b'] }, consume: 'data' },
      { s: 'block', until: '<dir>/stdin-closed', ms: 30_000 }, { s: 'immediate', body: [{ s: 'log', l: 'next-turn' }] }, { s: 'log', l: 'after' }] } },
  { name: 'rule 1: Promise.all of a child\'s close and five jobs: the jobs first', program: {
    main: [spawnOf('out', { l: 'k0', input: 'none', consume: 'data', onClose: [{ s: 'log', l: 'drawA' }] }), { s: 'chain', n: 5, l: 'drawB' }] } },
  { name: 'rule 1: spawn is on a tick of its checkpoint, every other event later, after a long chain', program: {
    main: [spawnOf('out', { l: 'k0', input: 'end', consume: 'data' }), { s: 'chain', n: 40, l: 'fence' }, { s: 'tick', body: [{ s: 'micro', body: [{ s: 'log', l: 'late' }] }] }] } },
  { name: 'rule 1: a missing program\'s error is on a tick of its checkpoint; its close waits for both outputs', program: {
    main: [spawnOf('missing', { l: 'k0', input: 'none', consume: 'data' }), { s: 'chain', n: 10, l: 'fence' }] } },
  { name: 'rule 1: a write that goes at once calls back on a tick of its checkpoint (Node\'s req.async false)', program: {
    main: [spawnOf('cat', { l: 'k0', input: { write: 'hello\n' }, consume: 'data' }), { s: 'chain', n: 8, l: 'fence' }] } },
  { name: 'rule 1: a pipeline into cat settles after its checkpoint, after stdin finished', program: {
    main: [spawnOf('cat', { l: 'k0', input: { pipe: 'one\ntwo\n' }, consume: 'data' }), { s: 'chain', n: 8, l: 'fence' }] } },
  { name: 'rule 1: a generator pipeline (update-index\'s rows)', program: {
    main: [spawnOf('cat', { l: 'k0', input: { gen: ['a\0', 'b\0', 'c\0'] }, consume: 'data' })] } },
  { name: 'rule 2: exit before close, with the stdin destroyed at the exit', program: {
    main: [spawnOf('exit3', { l: 'k0', input: 'none', consume: 'data', onExit: [{ s: 'chain', n: 3, l: 'afterExit' }], onClose: [{ s: 'tick', body: [{ s: 'log', l: 'afterClose' }] }] })] } },
  { name: 'rule 2: kill at spawn (a child waiting on stdin): SIGKILL; kill in exit and close are no-ops', program: {
    main: [spawnOf('wait', { l: 'k0', input: 'none', consume: 'data', kill: 'spawn' }), spawnOf('wait', { l: 'k1', input: { pipe: 'x\n' }, consume: 'data', kill: 'exit' }),
      spawnOf('wait', { l: 'k2', input: 'end', consume: 'data', kill: 'close' })] } },
  { name: 'rule 2: kill in the first data listener', program: {
    main: [spawnOf('printwait', { l: 'k0', input: 'none', consume: 'data', kill: 'data' })] } },
  { name: 'rule 2: a child that signals itself (SIGTERM)', program: { main: [spawnOf('term', { l: 'k0', input: 'none', consume: 'data' })] } },
  { name: 'rule 2: output nobody reads is drained at the exit (flushStdio)', program: { main: [spawnOf('out', { l: 'k0', input: 'none', consume: 'none' })] } },
  { name: 'rule 2: many chunks to a data listener, then end, finish, close', program: { main: [spawnOf('big', { l: 'k0', input: 'none', consume: 'data', onEnd: [{ s: 'chain', n: 4, l: 'afterEnd' }] })] } },
  { name: 'rule 2: listeners run in the frame of the spawn call', program: {
    main: [{ s: 'run', v: 'A', body: [spawnOf('out', { l: 'k0', input: 'none', consume: 'data', onClose: [{ s: 'tick', body: [{ s: 'log', l: 'inA' }] }] })] }, { s: 'run', v: 'B', body: [{ s: 'log', l: 'inB' }] }] } },
  { name: 'git(): output, writing, done, kill in finally (false)', program: {
    fns: [{ body: [gitOf('out', { l: 'g0' }), { s: 'log', l: 'after' }, { s: 'chain', n: 3, l: 'c0' }] }], main: [{ s: 'call', f: 0 }, { s: 'chain', n: 6, l: 'outside' }] } },
  { name: 'git(): a failing exit rejects done', program: { fns: [{ body: [gitOf('exit3', { l: 'g0' }), { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'git(): a missing program rejects done with ENOENT', program: { fns: [{ body: [gitOf('missing', { l: 'g0' })] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'git(): input piped through cat, and a generator', program: {
    fns: [{ body: [gitOf('cat', { l: 'g0', input: { pipe: 'a/\0b/\0' } }), gitOf('cat', { l: 'g1', input: { gen: ['r1\0', 'r2\0'] } })] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'gitTokens(): the consumer breaks after the first chunk; the finally kills', program: {
    fns: [{ body: [gitOf('big', { l: 'g0', exit: { at: 0, kind: 'break' } }), { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'git(): the loop body throws at the first chunk', program: {
    fns: [{ body: [gitOf('out', { l: 'g0', exit: { at: 0, kind: 'throw' } }), { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  // F1 of the O2e review, kept as today's JavaScript has it: a child that
  // exits while a grandchild holds its stdin leaves a write waiting; the
  // exit cancels it (ECANCELED), which start()'s catch does not swallow, so
  // git() throws it raw instead of its classified error.
  { name: 'git(): a child exits while a grandchild holds its stdin: writing rejects with ECANCELED, which git() throws raw (F1)', program: {
    fns: [{ body: [{ s: 'git', l: 'g0', file: 'sh', args: ['-c', 'exec 3<&0; sleep 120 >/dev/null 2>&1 & echo $! > "$GC_PID_FILE"; exit 0'], env: [['GC_PID_FILE', '<dir>/gc.pid']], input: { pipeBytes: 1 << 20 } },
      { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  // The Git runner itself (plan package L3b): the product's `git()` and
  // `gitTokens()` on the JavaScript arm, their port on the Rust arm, each in
  // a cancellable execution context, beside chains of every length so the
  // pure part pins where each continuation lands.
  { name: 'ported git(): aborted before the call, it rejects with no process, a job count the chains pin', program: {
    fns: [{ body: [{ s: 'pgit', l: 'p0', args: ['--version'], abort: 'before' }, { s: 'log', l: 'after' }, { s: 'chain', n: 2, l: 'c0' }] }],
    main: [{ s: 'call', f: 0 }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14].map((n) => ({ s: 'chain', n, l: `o${n}` }))] } },
  { name: 'ported gitTokens(): aborted before its first next, the generator rejects', program: {
    fns: [{ body: [{ s: 'pgit', l: 'p0', kind: 'tokens', args: ['--version'], abort: 'before' }, { s: 'log', l: 'after' }] }],
    main: [{ s: 'call', f: 0 }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14].map((n) => ({ s: 'chain', n, l: `o${n}` }))] } },
  { name: 'ported git(): output, then the continuation and its chains in the strand', program: {
    fns: [{ body: [{ s: 'pgit', l: 'p0', args: ['--version'] }, { s: 'log', l: 'after' }, { s: 'chain', n: 3, l: 'c0' }] }], main: [{ s: 'call', f: 0 }, { s: 'chain', n: 6, l: 'outside' }] } },
  { name: 'ported git(): a failing Git (not a repository) rejects classified', program: {
    fns: [{ body: [{ s: 'pgit', l: 'p0', args: ['--git-dir', '<dir>/none', 'rev-parse', 'HEAD'] }, { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'ported git(): input through stdin (hash-object --stdin)', program: {
    fns: [{ body: [{ s: 'pgit', l: 'p0', args: ['hash-object', '--stdin'], input: 'some bytes\n' }, { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  { name: 'ported gitTokens(): newline tokens, a break after the first', program: {
    fns: [{ body: [{ s: 'pgit', l: 'p0', kind: 'tokens', args: ['--version'], delimiter: 10 }, { s: 'pgit', l: 'p1', kind: 'tokens', args: ['--help'], delimiter: 10, breakAt: 1 }, { s: 'log', l: 'after' }] }], main: [{ s: 'call', f: 0 }] } },
  // The direct tree commit (L3b review S6): one job per async function on
  // the commit path (`readTree`'s arrow included), pinned by chains of every
  // length beside it.
  { name: 'ported commitTreeChanges(): a tree built, then changed (its trees read through readTree), against chains', program: {
    fns: [{ body: [{ s: 'ptrees', l: 't0', commits: [[['a/b/c.json', '1'], ['a/d.json', '2'], ['e.json', '3']], [['a/b/c.json', null], ['a/b/f.json', '4'], ['a/d.json', '2'], ['g/h.json', '5']]] }, { s: 'log', l: 'after' }] }],
    main: [{ s: 'call', f: 0 }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64].map((n) => ({ s: 'chain', n, l: `o${n}` }))] } },
  { name: 'ported commitTreeChanges(): a removal that empties a subtree, and a refusal (a file over a directory)', program: {
    fns: [{ body: [{ s: 'ptrees', l: 't0', commits: [[['a/b/c.json', '1']], [['a/b/c.json', null]]] }, { s: 'log', l: 'mid' }, { s: 'ptrees', l: 't1', commits: [[['a/b.json', '1']], [['a/b.json/c.json', '2']]] }, { s: 'log', l: 'after' }] }],
    main: [{ s: 'call', f: 0 }, ...[1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map((n) => ({ s: 'chain', n, l: `o${n}` }))] } },
  { name: 'two children, a file call and timers at once keep their own orders', program: {
    files: [{ name: 'f0', size: 70000 }],
    fns: [{ body: [gitOf('out', { l: 'g0' }), { s: 'awaitIo', op: 'readFile', a: 'f0', l: 'a0' }, { s: 'sleep', ms: 3 }, gitOf('cat', { l: 'g1', input: 'empty' })] }],
    main: [{ s: 'call', f: 0 }, spawnOf('exit3', { l: 'k0', input: 'end', consume: 'data' }), { s: 'io', op: 'lstat', a: 'f0', l: 'i0' }, { s: 'timeout', ms: 2, body: [{ s: 'log', l: 'o' }] }] } },
]);
