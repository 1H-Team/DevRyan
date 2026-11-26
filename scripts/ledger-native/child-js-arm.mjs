#!/usr/bin/env node
// The JavaScript arm of the native ledger's child-process differential test
// (child-differential.mjs): Node's own `child_process.spawn`, its stdio
// sockets and `pipeline` into its stdin, as the ledger's worker uses them
// (`session-changes-git.js`). Its Rust twin is `ledger-native-probe
// child-cases` / `child-programs` (ledger-native/src/child_program.rs).
//
//   node --expose-internals child-js-arm.mjs cases      stdin: one case per line (child-spec.mjs); stdout: its record per line
//   node --expose-internals child-js-arm.mjs programs   stdin: one {dir, program} per line (child-programs.mjs); stdout: its trace per line
//   node --expose-internals child-js-arm.mjs emfile-uncaught   (under `ulimit -n 256`) a spawn at the descriptor
//                   limit with no 'error' listener: the process dies of the uncaught EMFILE (F2 of the O2e review)
//
// Cases run on Node's real loop and clock. Programs run on V8's promises and
// Node's own task queue, timers and immediates under a virtual libuv clock
// (as fs-js-arm.mjs runs them): while a child, one of its sockets or a file
// call is still open and no immediate is queued, the driver returns to the
// real loop until it answers (the virtual clock does not move meanwhile).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

import { fnv } from './fs-programs.mjs';

const descriptors = () => fs.readdirSync('/dev/fd').length - 1;

const errorShape = (error) => {
  if (!(error instanceof Error)) return { value: String(error) };
  const out = { name: error.name, message: error.message };
  for (const key of ['errno', 'code', 'syscall', 'path', 'spawnargs']) if (error[key] !== undefined) out[key] = error[key];
  return out;
};

/** Takes descriptors until EMFILE, then gives `free` of them back; the rest, to close after the spawn. */
function holdDescriptors(free) {
  const held = [];
  for (;;) {
    try { held.push(fs.openSync('/dev/null', 'r')); } catch (error) { if (error.code !== 'EMFILE') throw error; break; }
  }
  for (let at = 0; at < free; at++) fs.closeSync(held.pop());
  return held;
}

/** Blocks the loop `ms` milliseconds (a consumer slower than its child). */
const blockLoop = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** What a case feeds the child's stdin with, as `start()` builds it (`exited`: the child's exit). */
function inputOf(input, exited) {
  if (input?.pipe !== undefined) return Readable.from([input.pipe]);
  if (input?.pipeBytes !== undefined) return Readable.from([Buffer.alloc(input.pipeBytes, 0x61)]);
  if (input?.gen !== undefined) {
    return (async function* rows() {
      for (let at = 0; at < input.gen.length; at++) {
        if (input.throwAt === at) throw Object.assign(new Error('the rows failed'), { code: 'ROWS_FAILED' });
        if (input.waitExitAt === at) await exited;
        await null;
        yield input.gen[at];
      }
    })();
  }
  if (input === 'empty') return Readable.from([]);
  return null;
}

/** One case, to its end: the record. */
function runCase(c) {
  return new Promise((finish) => {
    const events = [];
    const event = (source, name, value) => events.push(value === undefined ? [source, name] : [source, name, value]);
    const record = { events };
    const env = Object.fromEntries(c.env);
    let child;
    const held = c.free !== undefined ? holdDescriptors(c.free) : [];
    try {
      child = spawn(c.file, c.args, { cwd: c.cwd, env, stdio: c.stdio ?? ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      record.thrown = errorShape(error);
      finish(record);
      return;
    } finally {
      for (const fd of held) fs.closeSync(fd);
    }
    record.pid = typeof child.pid;
    record.stdio = [child.stdin, child.stdout, child.stderr].map((socket) => (socket ? 'socket' : 'null')).join(',');
    let exited;
    const exit = new Promise((resolve) => { exited = resolve; });
    const destroys = (at) => {
      for (const entry of c.destroy ?? []) if (entry.at === at) { event('destroy', entry.stream); child[entry.stream].destroy(); }
    };
    const kills = (at) => {
      for (const kill of c.kill ?? []) if (kill.at === at) event('kill', at, child.kill(kill.signal));
    };
    child.on('spawn', () => event('child', 'spawn'));
    child.on('exit', (code, signal) => { event('child', 'exit', `${code},${signal},${child.stdin?.destroyed ?? null}`); kills('exit'); destroys('exit'); exited(); });
    let closed = false;
    const done = new Promise((resolve, reject) => {
      child.on('error', (error) => { event('child', 'error', error.code); record.error = errorShape(error); reject(error); });
      child.on('close', (code, signal) => { event('child', 'close', `${code},${signal}`); kills('close'); closed = true; resolve(); });
    });
    done.catch(() => {});
    const sockets = { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr };
    const socketClosed = {};
    for (const [name, socket] of Object.entries(sockets)) {
      if (!socket) continue;
      socketClosed[name] = false;
      for (const kind of ['end', 'finish', 'error', 'close']) {
        if (kind === 'end' && name === 'stdin') continue;
        socket.on(kind, (value) => {
          event(name, kind, kind === 'error' ? value.code : kind === 'close' ? value : undefined);
          if (kind === 'close') socketClosed[name] = true;
        });
      }
    }
    let out = Buffer.alloc(0), err = '';
    const onOut = (chunk) => { out = Buffer.concat([out, chunk]); };
    if (child.stderr && c.stderr === 'data') child.stderr.on('data', (chunk) => { event('stderr', 'data'); err += chunk.toString(); });
    let firstData = true;
    if (child.stdout && c.stdout === 'data') {
      child.stdout.on('data', (chunk) => {
        event('stdout', 'data'); onOut(chunk);
        if (firstData) { firstData = false; kills('data'); }
      });
    }
    let writing = null, writingDone = true;
    const source = inputOf(c.input, exit);
    if (child.stdin && source) {
      writingDone = false;
      writing = pipeline(source, child.stdin).then(() => { event('writing', 'ok'); record.writing = 'ok'; }, (error) => {
        event('writing', 'err', error.code); record.writing = error.code; record.writingError = errorShape(error); });
      writing.finally(() => { writingDone = true; });
    } else if (child.stdin && (c.input?.write || c.input?.writeBytes)) {
      const chunks = c.input.write ?? c.input.writeBytes.map((size) => Buffer.alloc(size, 0x62));
      for (const chunk of chunks) event('wcb', 'returned', child.stdin.write(chunk, (error) => event('wcb', 'called', error ? error.code : 'ok')));
      if (c.input.end) child.stdin.end();
    } else if (child.stdin && c.input === 'end') {
      child.stdin.end();
    }
    kills('spawn');
    const timers = (c.kill ?? []).filter((kill) => kill.at === 'timer').map((kill) => setTimeout(() => {
      if (kill.check) event('watch', 'check', fs.existsSync(kill.check));
      event('kill', 'timer', child.kill(kill.signal));
    }, kill.ms));
    const reading = (async () => {
      if (!child.stdout || typeof c.stdout !== 'object' && c.stdout !== 'forAwait') return;
      const limit = c.stdout.limit, breakAt = c.stdout.breakAt, { blockMs, watch, total } = c.stdout;
      let index = 0, broke = false;
      try {
        for await (const chunk of child.stdout) {
          event('stdout', 'data'); onOut(chunk);
          if (watch && record.ahead === undefined && fs.existsSync(watch)) record.ahead = total - out.length;
          if (blockMs) blockLoop(blockMs);
          if (limit !== undefined && out.length > limit) throw Object.assign(new Error('too large'), { code: 'change_record_too_large' });
          // gitTokens' consumer leaving at a yield: straight to its finally.
          if (breakAt === index) { event('loop', 'break'); broke = true; break; }
          index += 1;
        }
        if (!broke) {
          event('loop', 'done');
          await writing;
          await done;
          event('loop', 'resolved');
        }
      } catch (error) {
        event('loop', 'threw', error.code);
      } finally {
        kills('finally');
        await Promise.allSettled([done, writing]);
      }
    })();
    const allClosed = () => Object.values(socketClosed).every(Boolean);
    const started = Date.now();
    const check = () => {
      if (closed && allClosed() && writingDone) {
        for (const timer of timers) clearTimeout(timer);
        reading.then(() => {
          if (c.stdout?.watch && record.ahead === undefined) record.ahead = 0;
          // The grandchild the case started: its own, killed now the case is over.
          if (c.reap) {
            const pid = Number(fs.readFileSync(c.reap, 'utf8').trim());
            if (Number.isInteger(pid) && pid > 1) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
          record.out = { length: out.length, fnv: fnv(out), ...(out.length <= 200 ? { text: out.toString('latin1') } : {}) };
          record.err = err;
          record.final = { exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed };
          record.pidNumber = child.pid ?? null;
          setImmediate(() => finish(record));
        });
        return;
      }
      if (Date.now() - started > 30_000) {
        const open = [`closed ${closed}`, ...Object.entries(socketClosed).map(([name, done]) => `${name} closed ${done}`), `writing settled ${writingDone}`].join(', ');
        record.timeout = `the case did not finish within 30 s (waited for the child's close, every socket's close and the pipeline: ${open}): ${JSON.stringify(events).slice(0, 2000)}`;
        // Its own child, stuck: killed, so nothing of the case outlives it.
        child.kill('SIGKILL');
        setTimeout(() => finish(record), 500);
        return;
      }
      setTimeout(check, 2);
    };
    check();
  });
}

async function cases() {
  const lines = [];
  let buffered = '', running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    while (lines.length) {
      const request = JSON.parse(lines.shift());
      let answer;
      if (request.op === 'census') answer = { fds: descriptors(), pid: process.pid };
      else answer = await runCase(request.case);
      process.stdout.write(`${JSON.stringify(answer)}\n`);
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
      if (line.trim()) lines.push(line);
    }
    void pump();
  });
}

/** `emfile-uncaught`: a piped spawn at the descriptor limit without an 'error' listener (F2): the process dies. */
function emfileUncaught() {
  holdDescriptors(1);
  spawn('sh', ['-c', 'exit 0'], { stdio: ['pipe', 'pipe', 'pipe'] });
  setTimeout(() => { process.stdout.write('survived\n'); }, 500);
}

/** The program runner (its Rust twin is `child_program::run_program`). */
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
  let trace = [], unit = 0, open = 0, dir = '', fns = [];
  const bump = () => { unit += 1; };
  const log = (ctx, entry) => {
    const frame = FRAME.getStore();
    trace.push(`${ctx.strand !== undefined ? `io:${ctx.strand}:` : ''}${entry}@${now}${frame !== undefined ? `~${frame}` : ''}#${unit}`);
  };
  const pure = {};
  const io = (label) => ({ strand: label });
  const pathOf = (name) => `${dir}/${name}`;
  const OPS = {
    lstat: (target) => fs.promises.lstat(pathOf(target)).then((stats) => (stats.isFile() ? `f:${stats.size}` : stats.isDirectory() ? 'd' : 'o')),
    readFile: (target) => fs.promises.readFile(pathOf(target)).then((bytes) => String(bytes.length)),
    readdir: (target) => fs.promises.readdir(pathOf(target)).then((names) => names.join(',')),
    writeFile: (target, label) => fs.promises.writeFile(pathOf(`w/${label}`), label).then(() => 'ok'),
  };
  const startIo = (op, target, label) => {
    open += 1;
    return OPS[op](target, label).then((value) => { open -= 1; return value; }, (error) => { open -= 1; return `!${error.code}`; });
  };
  // Every child, socket and pipeline counts as open until its last event.
  const opened = () => { open += 1; let once = false; return () => { if (!once) { once = true; open -= 1; } }; };
  const status = (code, signal) => `${code},${signal}`;
  /** `spawn` with listeners on every event of every source, each event its own strand. */
  const spawnStatement = (ctx, st) => {
    log(ctx, `${st.l}>`);
    const child = spawn(st.file, st.args, { env: Object.fromEntries(st.env ?? []), stdio: ['pipe', 'pipe', 'pipe'] });
    const childOpen = opened();
    const strand = (name) => io(`${st.l}.${name}`);
    const killHere = (at, inner) => { if (st.kill === at) log(inner, `${st.l}.kill=${child.kill('SIGKILL')}`); };
    child.on('spawn', () => log(strand('spawn'), `${st.l}.spawn`));
    child.on('error', (error) => log(strand('error'), `${st.l}.error=${error.code}`));
    child.on('exit', (code, signal) => {
      bump(); const inner = strand('exit');
      log(inner, `${st.l}.exit=${status(code, signal)},${child.stdin.destroyed}`);
      killHere('exit', inner); exec(inner, st.onExit);
    });
    child.on('close', (code, signal) => {
      bump(); const inner = strand('close');
      log(inner, `${st.l}.close=${status(code, signal)}`);
      killHere('close', inner); exec(inner, st.onClose); childOpen();
    });
    for (const [at, socket] of [[0, child.stdin], [1, child.stdout], [2, child.stderr]]) {
      const inner = strand(String(at)), socketOpen = opened();
      let first = true;
      if (at > 0 && st.consume === 'data') {
        socket.on('data', () => {
          bump(); log(inner, `${st.l}.${at}.d`);
          if (first && at === 1) { first = false; killHere('data', inner); }
        });
      }
      if (at > 0) socket.on('end', () => { bump(); log(inner, `${st.l}.${at}.end`); if (at === 1) exec(strand('end'), st.onEnd); });
      socket.on('finish', () => { bump(); log(inner, `${st.l}.${at}.finish`); });
      socket.on('error', (error) => { bump(); log(inner, `${st.l}.${at}.error=${error.code}`); });
      socket.on('close', (hadError) => { bump(); log(inner, `${st.l}.${at}.close=${hadError}`); socketOpen(); });
    }
    feed(child, st, ctx, strand);
    killHere('spawn', ctx);
  };
  /** The statement's stdin: left open, ended, written (its callback a strand), or a pipeline (its settlement a strand). */
  const feed = (child, st, ctx, strand) => {
    const input = st.input;
    if (input === 'end') child.stdin.end();
    else if (input?.write !== undefined) {
      log(ctx, `${st.l}.wrote=${child.stdin.write(input.write, (error) => log(strand('wcb'), `${st.l}.wcb=${error ? error.code : 'ok'}`))}`);
      child.stdin.end();
    } else {
      const source = inputOf(input);
      if (!source) return null;
      const writingOpen = opened();
      const writing = pipeline(source, child.stdin);
      writing.then(() => { bump(); log(strand('w'), `${st.l}.w=ok`); writingOpen(); }, (error) => { bump(); log(strand('w'), `${st.l}.w=!${error.code}`); writingOpen(); });
      return writing;
    }
    return null;
  };
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
        startIo(st.op, st.a, st.l).then((result) => { bump(); const inner = io(st.l); log(inner, `${st.l}=${result}`); exec(inner, st.body); });
        return;
      }
      case 'spawn': spawnStatement(ctx, st); return;
      default: throw new TypeError(`a child program statement not known: ${st.s}`);
    }
  }
  /** `git(cwd, args, options)` of session-changes-git.js, as the statement's shape: spawn, pipeline, for await, await writing, await done, kill in finally. */
  async function git(ctx, st) {
    log(ctx, `${st.l}>`);
    const child = spawn(st.file, st.args, { env: Object.fromEntries(st.env ?? []), stdio: ['pipe', 'pipe', 'pipe'] });
    const childOpen = opened(), socketsOpen = [opened(), opened(), opened()];
    [child.stdin, child.stdout, child.stderr].forEach((socket, at) => socket.on('close', () => socketsOpen[at]()));
    child.stderr.on('data', () => {});
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => { childOpen(); if (code === 0) resolve(); else reject(Object.assign(new Error('failed'), { code: `exit_${code ?? signal}` })); });
    });
    void done.catch(() => {});
    const writingOpen = opened();
    const writing = pipeline(inputOf(st.input) ?? Readable.from([]), child.stdin).catch((error) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
    });
    writing.finally(() => writingOpen()).catch(() => {});
    const inner = io(st.l);
    let index = 0, early = false;
    try {
      for await (const chunk of child.stdout) {
        bump();
        log(inner, `${st.l}.c`);
        if (chunk.length && st.exit && st.exit.at === index) {
          early = true;
          // gitTokens' consumer leaving at a yield: straight to its finally.
          if (st.exit.kind === 'break') { log(inner, `${st.l}.broke`); break; }
          throw Object.assign(new Error('thrown'), { code: `X${st.l}` });
        }
        index += 1;
      }
      if (!early) {
        bump(); log(inner, `${st.l}.done`);
        await writing; bump(); log(inner, `${st.l}.writing=ok`);
        await done; bump(); log(inner, `${st.l}.resolved`);
      }
    } catch (error) {
      bump(); log(inner, `${st.l}.caught=${error.code}`);
    } finally {
      const killed = child.kill('SIGKILL');
      if (!early) log(inner, `${st.l}.kill=${killed}`);
      await Promise.allSettled([done, writing]);
      bump();
    }
    log(inner, `${st.l}.end`);
    return inner;
  }
  async function callFn(start, index) {
    let ctx = start;
    for (const st of fns[index]?.body ?? []) {
      switch (st.s) {
        case 'await': await undefined; break;
        case 'sleep': await new Promise((resolve) => setTimeout(() => { bump(); resolve(); }, st.ms)); break;
        case 'awaitIo': {
          log(ctx, `${st.l}>`);
          const result = await startIo(st.op, st.a, st.l);
          bump(); ctx = io(st.l); log(ctx, `${st.l}=${result}`);
          break;
        }
        case 'git': ctx = await git(ctx, st); break;
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
  function runProgram(input, done) {
    trace = []; unit = 0; open = 0; dir = input.dir; fns = input.program.fns ?? [];
    resetLoop(1000);
    const until = 1000 + (input.program.until ?? 50);
    try { exec(pure, input.program.main); } catch (error) { trace.push(`X:${String(error)}`); }
    runNextTicks();
    timersPhase();
    const started = performance.now();
    const turn = () => {
      for (let turns = 0; turns < 1_000_000; turns++) {
        if (immediateInfo[immediateInfoFields.kCount] > 0) { processImmediate(); runNextTicks(); timersPhase(); continue; }
        if (open > 0) {
          if (performance.now() - started > 20_000) { done(`!${open} children, sockets or calls of the program did not finish within 20 s`, true); return; }
          fs.stat('.', () => turn());
          return;
        }
        const next = timerListQueue.peek()?.expiry ?? Infinity;
        if (next > until) break;
        now = Math.max(now, next);
        timersPhase();
      }
      // A grandchild the program started (its pid in gc.pid): its own, killed now it is over.
      const pidFile = `${dir}/gc.pid`;
      const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : NaN;
      if (Number.isInteger(pid) && pid > 1) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
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
    // A program stuck past its deadline ends the run: the rest would wait out theirs too.
    runProgram(JSON.parse(queue.shift()), (line, stuck) => { process.stdout.write(`${line}\n`, () => { if (stuck) process.exit(0); }); busy = false; if (!stuck) next(); });
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
if (mode === 'cases') void cases();
else if (mode === 'programs') programs();
else if (mode === 'emfile-uncaught') emfileUncaught();
else if (mode !== undefined) { process.stderr.write('usage: child-js-arm.mjs cases | programs | emfile-uncaught\n'); process.exitCode = 2; }
