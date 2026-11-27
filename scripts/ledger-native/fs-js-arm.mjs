#!/usr/bin/env node
// The JavaScript arm of the native ledger's `node` module differential test
// (fs-differential.mjs): Node's own `fs.promises`, `FileHandle`,
// `fs.createReadStream` and `zlib.deflate`, as the ledger's worker calls them.
// Its Rust twin is `ledger-native-probe fs-steps` / `fs-programs`
// (ledger-native/src/io_program.rs).
//
//   node --expose-internals fs-js-arm.mjs steps      stdin: one step per line; stdout: its outcome per line
//   node --expose-internals fs-js-arm.mjs programs   stdin: one {dir, program} per line; stdout: its trace per line
//
// Programs run on V8's own promises, Node's own task queue, timers and
// immediates under a virtual libuv clock (as jobs-js-arm.mjs runs them), and
// on Node's real file system: while a file call or a read stream's request
// is in flight and no immediate is queued, the driver returns to the real
// loop until it answers (the virtual clock does not move meanwhile). Entries
// carry `#<unit>`, the unit of work they ran in as Node's construction gives
// it (a timer, an immediate, a completion, a stream event); the Rust arm
// prints its measured checkpoint epoch there instead.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { fnv } from './fs-programs.mjs';

const deflate = promisify(zlib.deflate);
const fsp = fs.promises;


const errorShape = (error) => {
  if (!(error instanceof Error)) return { value: String(error) };
  const out = { name: error.name, message: error.message };
  for (const key of ['errno', 'code', 'syscall', 'path', 'dest']) if (error[key] !== undefined) out[key] = error[key];
  return out;
};

const statShape = (stats) => {
  const type = stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : stats.isSymbolicLink() ? 'link' : stats.isFIFO() ? 'fifo'
    : stats.isSocket() ? 'socket' : stats.isCharacterDevice() ? 'char' : stats.isBlockDevice() ? 'block' : 'other';
  const bigint = typeof stats.dev === 'bigint';
  const out = { type, bigint };
  const fields = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs'];
  for (const key of bigint ? [...fields, 'atimeNs', 'mtimeNs', 'ctimeNs'] : fields) out[key] = bigint ? String(stats[key]) : stats[key];
  return out;
};

const bytesOf = (step) => (step.b64 !== undefined ? Buffer.from(step.b64, 'base64') : Buffer.from(step.text ?? '', 'utf8'));
const dataOf = (step) => (step.b64 !== undefined ? Buffer.from(step.b64, 'base64') : step.text ?? '');
const writeOptions = (step) => ({ ...(step.mode !== undefined ? { mode: step.mode } : {}), ...(step.flag !== undefined ? { flag: step.flag } : {}) });
// A time is a Date's milliseconds, or seconds (`'NaN'`, `'Infinity'` and `'-Infinity'` as text, which JSON cannot carry).
const timeOf = (value) => (value.date !== undefined ? new Date(value.date) : Number(value.seconds));
const direntShape = (entries) => entries.map((entry) => ({
  name: entry.name, type: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : entry.isFIFO() ? 'fifo'
    : entry.isSocket() ? 'socket' : entry.isCharacterDevice() ? 'char' : entry.isBlockDevice() ? 'block' : 'unknown',
  parentPath: entry.parentPath }));

/** The step server (its Rust twin is `io_program::serve_steps`). */
async function steps() {
  const handles = new Map(), paths = new Map(), streams = new Map();
  let startUmask;
  // What a write's continuation finds on disk: a write acknowledged before its bytes are there shows here.
  const onDisk = (file) => { let sizeAfter = -1; try { sizeAfter = fs.lstatSync(file).size; } catch { /* missing */ } return { sizeAfter }; };
  const kIsPerformingIO = (stream) => {
    const symbol = Object.getOwnPropertySymbols(stream).find((key) => key.description === 'kIsPerformingIO');
    return Boolean(symbol && stream[symbol]);
  };
  // Waits (polling once per loop turn) until `done()`, with a deadline.
  const until = (done, why) => new Promise((resolve) => {
    const deadline = Date.now() + 30_000;
    const poll = () => (done() ? resolve(null) : Date.now() > deadline ? resolve({ timeout: why }) : setImmediate(poll));
    poll();
  });
  const ops = {
    access: (s) => fsp.access(s.path, s.mode).then(() => null),
    appendFile: (s) => fsp.appendFile(s.path, dataOf(s), writeOptions(s)).then(() => onDisk(s.path)),
    chmod: (s) => fsp.chmod(s.path, s.mode).then(() => null),
    copyFile: (s) => fsp.copyFile(s.src, s.dest, s.mode).then(() => onDisk(s.dest)),
    link: (s) => fsp.link(s.src, s.dest).then(() => null),
    lstat: (s) => fsp.lstat(s.path, { bigint: Boolean(s.bigint) }).then(statShape),
    stat: (s) => fsp.stat(s.path, { bigint: Boolean(s.bigint) }).then(statShape),
    statfs: (s) => fsp.statfs(s.path, { bigint: Boolean(s.bigint) }).then((v) => {
      const out = {};
      for (const key of ['type', 'bsize', 'blocks', 'bfree', 'bavail', 'files', 'ffree']) out[key] = s.bigint ? String(v[key]) : v[key];
      return out;
    }),
    mkdir: (s) => fsp.mkdir(s.path, { recursive: Boolean(s.recursive), ...(s.mode !== undefined ? { mode: s.mode } : {}) }).then((first) => (first === undefined ? undefined : first)),
    readdir: (s) => (s.types ? fsp.readdir(s.path, { withFileTypes: true }).then(direntShape) : fsp.readdir(s.path)),
    // The synchronous calls, inline (a throw is the step's error).
    lstatSync: (s) => Promise.resolve().then(() => statShape(fs.lstatSync(s.path, { bigint: Boolean(s.bigint) }))),
    readdirSync: (s) => Promise.resolve().then(() => direntShape(fs.readdirSync(s.path, { withFileTypes: true }))),
    // `process.umask(mask)`; without a mask, the one the server started with again.
    umask: (s) => { const old = process.umask(s.mask ?? startUmask ?? 0o022); startUmask ??= old; return Promise.resolve(null); },
    readFile: (s) => (s.utf8 ? fsp.readFile(s.path, 'utf8') : fsp.readFile(s.path).then((bytes) => bytes.toString('base64'))),
    readlink: (s) => (s.buffer ? fsp.readlink(s.path, { encoding: 'buffer' }).then((bytes) => ({ hex: bytes.toString('hex') })) : fsp.readlink(s.path)),
    realpath: (s) => fsp.realpath(s.path),
    rename: (s) => fsp.rename(s.src, s.dest).then(() => null),
    rm: (s) => fsp.rm(s.path, { recursive: Boolean(s.recursive), force: Boolean(s.force) }).then(() => null),
    rmdir: (s) => fsp.rmdir(s.path).then(() => null),
    symlink: (s) => fsp.symlink(s.targetHex !== undefined ? Buffer.from(s.targetHex, 'hex') : s.target, s.path, s.type).then(() => null),
    unlink: (s) => fsp.unlink(s.path).then(() => null),
    utimes: (s) => fsp.utimes(s.path, timeOf(s.atime), timeOf(s.mtime)).then(() => null),
    writeFile: (s) => fsp.writeFile(s.path, dataOf(s), writeOptions(s)).then(() => onDisk(s.path)),
    deflate: (s) => deflate(bytesOf(s)).then((bytes) => bytes.toString('base64')),
    open: (s) => fsp.open(s.path, s.flags, s.mode).then((handle) => { handles.set(s.as, handle); paths.set(s.as, s.path); return null; }),
    'h.read': (s) => handles.get(s.h).read(Buffer.alloc(s.length), 0, s.length, s.position ?? null)
      .then(({ bytesRead, buffer }) => ({ bytesRead, b64: buffer.subarray(0, bytesRead).toString('base64') })),
    'h.write': (s) => { const bytes = bytesOf(s), offset = s.offset ?? 0; return handles.get(s.h).write(bytes, offset, s.length ?? bytes.length - offset, s.position ?? null).then(({ bytesWritten }) => ({ bytesWritten, ...onDisk(paths.get(s.h)) })); },
    'h.writeFile': (s) => handles.get(s.h).writeFile(dataOf(s)).then(() => onDisk(paths.get(s.h))),
    'h.stat': (s) => handles.get(s.h).stat({ bigint: Boolean(s.bigint) }).then(statShape),
    'h.chmod': (s) => handles.get(s.h).chmod(s.mode).then(() => null),
    'h.sync': (s) => handles.get(s.h).sync().then(() => null),
    'h.close': (s) => handles.get(s.h).close().then(() => null),
    // `for await` gets the iterator and calls its `next()` at once (so its
    // end-of-stream listener is there before the open can fail): so does
    // `rs.create`, and the first `rs.next` takes that call's promise.
    'rs.create': (s) => {
      const stream = fs.createReadStream(s.path, { highWaterMark: s.hwm }), iterator = stream[Symbol.asyncIterator]();
      const first = iterator.next();
      first.catch(() => {});
      streams.set(s.s, { stream, iterator, first });
      return Promise.resolve(null);
    },
    'rs.next': (s) => {
      const entry = streams.get(s.s), call = entry.first ?? entry.iterator.next();
      entry.first = null;
      return call.then((item) => (item.done ? { done: true } : { done: false, length: item.value.length, fnv: fnv(item.value) }));
    },
    'rs.return': (s) => streams.get(s.s).iterator.return().then((item) => ({ done: item.done })),
    'rs.state': (s) => { const { stream } = streams.get(s.s); return Promise.resolve({ destroyed: stream.destroyed, closed: stream.closed, bytesRead: stream.bytesRead }); },
    'rs.idle': (s) => until(() => !kIsPerformingIO(streams.get(s.s).stream), 'the stream\'s read did not answer within 30 s'),
    'rs.waitClosed': (s) => until(() => streams.get(s.s).stream.closed, 'the stream\'s descriptor was not closed within 30 s'),
    fds: () => Promise.resolve(fs.readdirSync('/dev/fd').length - 1),
  };
  let buffered = '';
  const pending = [];
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    while (pending.length) {
      const step = JSON.parse(pending.shift());
      let line;
      try {
        const value = await ops[step.op](step);
        line = value && value.timeout ? value : { ok: value === undefined ? undefined : value };
        if (value === undefined) line = { ok: undefined };
      } catch (error) {
        line = { err: errorShape(error) };
      }
      process.stdout.write(`${JSON.stringify(line, (key, value) => (value === undefined ? null : value))}\n`);
    }
    running = false;
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line.trim()) pending.push(line);
    }
    void pump();
  });
}

/** The program runner (its Rust twin is `io_program::run_program`). */
function programs() {
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
  const FRAME = new AsyncLocalStorage();
  let trace = [], unit = 0, inFlight = 0, liveStreams = [], dir = '', fns = [];
  const bump = () => { unit += 1; };
  const log = (ctx, entry) => {
    const frame = FRAME.getStore();
    trace.push(`${ctx.strand !== undefined ? `io:${ctx.strand}:` : ''}${entry}@${now}${frame !== undefined ? `~${frame}` : ''}#${unit}`);
  };
  const pure = {};
  const io = (label) => ({ strand: label });
  const pathOf = (name) => `${dir}/${name}`;
  const kindOf = (stats) => (stats.isFile() ? `f:${stats.size}` : stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : 'o');
  let programHandles = new Map();
  const withHandle = (h, apply) => { const handle = programHandles.get(h); return handle ? apply(handle) : Promise.reject(Object.assign(new Error('no handle'), { code: 'NOHANDLE' })); };
  const readHead = async (file) => {
    const handle = await fsp.open(file, 'r');
    try {
      const { bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
      return String(bytesRead);
    } finally { await handle.close(); }
  };
  const OPS = {
    lstat: (target) => fsp.lstat(pathOf(target)).then(kindOf),
    stat: (target) => fsp.stat(pathOf(target)).then(kindOf),
    readFile: (target) => fsp.readFile(pathOf(target)).then((bytes) => String(bytes.length)),
    readFileUtf8: (target) => fsp.readFile(pathOf(target), 'utf8').then((text) => String(text.length)),
    readdir: (target) => fsp.readdir(pathOf(target)).then((names) => names.join(',')),
    access: (target) => fsp.access(pathOf(target)).then(() => 'ok'),
    realpath: (target) => fsp.realpath(pathOf(target)).then((resolved) => resolved.split('/').pop()),
    writeFile: (target, label) => fsp.writeFile(pathOf(`w/${label}`), label).then(() => 'ok'),
    mkdir: (target, label) => fsp.mkdir(pathOf(`m/${label}/x`), { recursive: true }).then((first) => (first === undefined ? 'undefined' : first.startsWith(`${dir}/`) ? first.slice(dir.length + 1) : first)),
    rm: (target, label) => fsp.rm(pathOf(`w/${label}.gone`), { force: true }).then(() => 'ok'),
    deflate: (target, label) => deflate(Buffer.from(label)).then(() => 'ok'),
    handle: (target) => readHead(pathOf(target)),
    // A handle's methods as separate awaited calls (`h` names the `hopen` that opened it).
    hopen: (target, label) => fsp.open(pathOf(target), 'r').then((handle) => { programHandles.set(label, handle); return 'ok'; }),
    hread: (target, label, h) => withHandle(h, (handle) => handle.read(Buffer.alloc(16), 0, 16, 0).then(({ bytesRead }) => String(bytesRead))),
    hstat: (target, label, h) => withHandle(h, (handle) => handle.stat().then(kindOf)),
    hclose: (target, label, h) => withHandle(h, (handle) => handle.close().then(() => 'ok')),
  };
  // A file call: its result text, or `!<code>`; `inFlight` counts it until its first reaction.
  const startIo = (op, target, label, h) => {
    inFlight += 1;
    const run = OPS[op];
    if (!run) throw new TypeError(`an I/O program op not known: ${op}`);
    return run(target, label, h).then((value) => { inFlight -= 1; return value; }, (error) => { inFlight -= 1; return `!${error.code}`; });
  };
  const isPerformingIO = (stream) => {
    const symbol = Object.getOwnPropertySymbols(stream).find((key) => key.description === 'kIsPerformingIO');
    return Boolean(symbol && stream[symbol]);
  };
  const streamPending = (stream) => (!stream.destroyed && stream.pending) || isPerformingIO(stream) || (stream.destroyed && !stream.closed);
  const pending = () => inFlight + liveStreams.filter(streamPending).length;
  const exec = (ctx, statements) => { for (const st of statements ?? []) step(ctx, st); };
  function step(ctx, st) {
    switch (st.s) {
      case 'log': log(ctx, st.l); return;
      case 'chain': {
        let promise = Promise.resolve();
        for (let index = 1; index < Math.max(st.n, 1); index++) promise = promise.then(() => undefined);
        promise.then(() => { log(ctx, st.l); });
        return;
      }
      case 'tick': process.nextTick(() => exec(ctx, st.body)); return;
      case 'micro': queueMicrotask(() => exec(ctx, st.body)); return;
      case 'immediate': setImmediate(() => { bump(); exec(ctx, st.body); }); return;
      case 'timeout': setTimeout(() => { bump(); exec(ctx, st.body); }, st.ms); return;
      case 'run': FRAME.run(st.v, () => exec(ctx, st.body)); return;
      case 'call': void callFn(ctx, st.f); return;
      case 'io': {
        log(ctx, `${st.l}>`);
        startIo(st.op, st.a, st.l, st.h).then((result) => {
          bump();
          const inner = io(st.l);
          log(inner, `${st.l}=${result}`);
          exec(inner, st.body);
        });
        return;
      }
      case 'stream': {
        log(ctx, `${st.l}>`);
        const stream = fs.createReadStream(pathOf(st.a), { highWaterMark: st.hwm });
        liveStreams.push(stream);
        const inner = io(st.l);
        let index = 0;
        stream.on('data', (chunk) => {
          bump();
          log(inner, `${st.l}.d${index}=${chunk.length}`);
          if (st.destroyAt === index) stream.destroy();
          index += 1;
        });
        stream.on('end', () => { bump(); log(inner, `${st.l}.end`); });
        stream.on('error', (error) => { bump(); log(inner, `${st.l}.err=${error.code}`); });
        stream.on('close', () => { bump(); log(inner, `${st.l}.close`); });
        return;
      }
      default: throw new TypeError(`an I/O program statement not known: ${st.s}`);
    }
  }
  async function callFn(start, index) {
    let ctx = start;
    for (const st of fns[index]?.body ?? []) {
      switch (st.s) {
        case 'await': await undefined; break;
        case 'sleep': await new Promise((resolve) => setTimeout(() => { bump(); resolve(); }, st.ms)); break;
        case 'awaitIo': {
          log(ctx, `${st.l}>`);
          const result = await startIo(st.op, st.a, st.l, st.h);
          bump();
          ctx = io(st.l);
          log(ctx, `${st.l}=${result}`);
          break;
        }
        case 'forAwait': {
          log(ctx, `${st.l}>`);
          const stream = fs.createReadStream(pathOf(st.a), { highWaterMark: st.hwm });
          liveStreams.push(stream);
          try {
            let index = 0;
            for await (const chunk of stream) {
              bump();
              ctx = io(st.l);
              log(ctx, `${st.l}.c${index}=${chunk.length}`);
              exec(ctx, st.body);
              if (st.exit && st.exit.at === index) {
                if (st.exit.kind === 'break') break;
                throw `X${st.l}`;
              }
              index += 1;
            }
            bump();
            ctx = io(st.l);
            log(ctx, `${st.l}.done`);
          } catch (error) {
            bump();
            ctx = io(st.l);
            log(ctx, `${st.l}.caught=${error?.code ?? String(error)}`);
          }
          break;
        }
        default: step(ctx, st);
      }
    }
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
  const timersPhase = () => { const first = timerListQueue.peek(); if (first && first.expiry <= now) { processTimers(now); runNextTicks(); } };
  // One program: the main body as a unit, then the virtual loop; real I/O is waited for by returning to the real loop.
  function runProgram(input, done) {
    trace = []; unit = 0; inFlight = 0; liveStreams = []; dir = input.dir; fns = input.program.fns ?? []; programHandles = new Map();
    resetLoop(1000);
    const until = 1000 + (input.program.until ?? 50);
    try { exec(pure, input.program.main); } catch (error) { trace.push(`X:${String(error)}`); }
    runNextTicks();
    timersPhase();
    const started = performance.now();
    const turn = () => {
      for (let turns = 0; turns < 1_000_000; turns++) {
        if (immediateInfo[immediateInfoFields.kCount] > 0) { processImmediate(); runNextTicks(); timersPhase(); continue; }
        if (pending() > 0) {
          if (performance.now() - started > 60_000) { done(`!${pending()} file calls of the program did not answer within 60 s`); return; }
          // Back to the real loop for one round: its completions run there.
          fs.stat('.', () => turn());
          return;
        }
        const next = timerListQueue.peek()?.expiry ?? Infinity;
        if (next > until) break;
        now = Math.max(now, next);
        timersPhase();
      }
      done(trace.join(' '));
    };
    turn();
  }
  let buffered = '';
  const queue = [];
  let busy = false;
  const next = () => {
    if (busy || !queue.length) return;
    busy = true;
    runProgram(JSON.parse(queue.shift()), (line) => { process.stdout.write(`${line}\n`); busy = false; next(); });
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line.trim()) queue.push(line);
    }
    next();
  });
}

const mode = process.argv[2];
if (mode === 'steps') void steps();
else if (mode === 'programs') programs();
else if (mode !== undefined) { process.stderr.write('usage: fs-js-arm.mjs steps | programs\n'); process.exitCode = 2; }
