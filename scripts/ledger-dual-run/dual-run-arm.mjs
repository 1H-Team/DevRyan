// One arm of a dual run: a child process that stands where the server's
// ledger host stands. The parent (dual-run-harness.mjs) sends it commands over IPC.
//
// mode "record": the product host (createSessionMutationHost, worker thread
// and all, exactly as the server creates it) with a tap on its Worker: every
// message that crosses session-mutation-host.js in either direction is logged,
// and each host method call is tied to the seam call it posted.
//
// mode "replay": no product host. The arm itself is the host side of the
// protocol: it starts an implementation (the product worker file on a worker
// thread as the product starts it, or a ledger process over stdio), posts the
// recorded `call` messages, answers `callback`s with the recorded host results,
// pulls result streams to the end, and logs every message the same way.
//
// Either way the arm returns, per call, the seam messages of that call, so the
// parent compares like with like.
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import workerThreads from 'node:worker_threads';
import { createCensus, decodeLine, decodeValue, encodeLine, encodeValue, lineReader } from './dual-run-codec.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const census = createCensus();
const log = [];
let sequence = 0;
const started = performance.now();
const note = (direction, message) => {
  log.push({ seq: sequence++, dir: direction, ms: Math.round((performance.now() - started) * 1000) / 1000, message: encodeValue(message, census) });
};
const send = (reply) => process.send(reply);
const errorFields = ['name', 'message', 'code', 'status', 'committed', 'rollbackFailed', 'retryable', 'reason'];
const describeError = (error) => {
  if (!(error instanceof Error)) return { message: String(error) };
  const out = {};
  for (const field of errorFields) if (error[field] !== undefined) out[field] = error[field];
  if (Array.isArray(error.errors)) out.errors = error.errors.map(describeError);
  if (error.cause !== undefined) out.cause = describeError(error.cause);
  return out;
};

let state = null;

// ---------------------------------------------------------------- record mode
async function startRecord({ libDir, options }) {
  let posted = null;
  const Base = workerThreads.Worker;
  // The tap: the host's own Worker, with its traffic logged. Installed before
  // the host module loads, so its `import { Worker }` binds to this class.
  class TappedWorker extends Base {
    constructor(filename, workerOptions) {
      super(filename, workerOptions);
      state.workerData = workerOptions?.workerData ?? null;
      state.workers.push(this);
    }
    postMessage(message, transfer) {
      note('h2w', message);
      if (message?.type === 'call' && posted === null) posted = message.id;
      return super.postMessage(message, transfer);
    }
    emit(event, ...args) {
      if (event === 'message') note('w2h', args[0]);
      else if (event === 'exit') note('exit', { code: args[0] });
      return super.emit(event, ...args);
    }
  }
  workerThreads.Worker = TappedWorker;
  syncBuiltinESMExports();
  const lib = (name) => pathToFileURL(path.join(libDir, name)).href;
  const { createSessionMutationHost } = await import(lib('session-mutation-host.js'));
  const { withExecutionAdmission, withExecutionTiming } = await import(lib('execution-admission.js'));
  const observed = { diagnostics: [], changes: [], materialized: [], lockTimings: [] };
  state = { mode: 'record', workers: [], workerData: null, observed, withExecutionAdmission, withExecutionTiming,
    take: () => { const id = posted; posted = null; return id; } };
  state.host = createSessionMutationHost({ ...options,
    onChange: (change) => { observed.changes.push(encodeValue(change, census)); },
    onMaterialize: (row) => { observed.materialized.push(encodeValue(row, census)); },
    onDiagnostic: (record) => { observed.diagnostics.push(encodeValue(record, census)); },
    onLockTiming: (timing) => { observed.lockTimings.push(encodeValue(timing, census)); } });
}

// Result streams (receipt bytes) are read to the end, as a caller would.
// `limit` reads only that many chunks of each stream and then stops it, as a
// caller that gives up early (the host then posts `stream-return`).
async function settleStreams(value, limit) {
  if (value && typeof value === 'object' && typeof value[Symbol.asyncIterator] === 'function' && !ArrayBuffer.isView(value)) {
    const chunks = [];
    for await (const chunk of value) { chunks.push(Buffer.from(chunk)); if (Number.isInteger(limit) && chunks.length >= limit) break; }
    return { $stream: Buffer.concat(chunks) };
  }
  if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await settleStreams(item, limit)); return out; }
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = await settleStreams(entry, limit);
    return out;
  }
  return value;
}

// Scenario inputs name host functions declaratively: {"$fn":"noop"},
// {"$fn":"throw","code":"..."} or {"$fn":"value","value":<json>}; the
// recording keeps what each returned.
const materializeFunctions = (value) => {
  if (Array.isArray(value)) return value.map(materializeFunctions);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    if (value.$fn === 'noop') return () => undefined;
    if (value.$fn === 'throw') return () => { throw Object.assign(new Error(value.code), { code: value.code }); };
    if (value.$fn === 'value') return () => value.value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materializeFunctions(entry)]));
  }
  return value;
};

// A call runs as the server runs it: inside an execution summary (journal
// records cross the seam), or with `how.admission` inside an execution
// admission (cancellable, metered, a deadline `deadlineMs` from now), aborted
// by its caller right after it was posted when `abort` is set.
async function recordCall({ label, method, args, how = {} }) {
  const input = materializeFunctions(decodeValue(args));
  const identity = input[0] && typeof input[0] === 'object' ? input[0] : {};
  let seamID = null;
  const onDiagnostic = (record) => { state.observed.diagnostics.push(encodeValue(record, census)); };
  try {
    const controller = new AbortController();
    const action = () => {
      const pending = state.host[method](...input);
      seamID = state.take();
      if (how.admission?.abort) controller.abort(Object.assign(new Error('ledger_dual_run_aborted'), { code: 'ledger_dual_run_aborted' }));
      return pending;
    };
    const value = how.admission
      ? await state.withExecutionAdmission(identity, action, { timeoutMs: how.admission.deadlineMs, signal: controller.signal, onDiagnostic,
        summary: { minMs: 0, slowMs: 600_000 }, phase: 'ledger_dual_run' })
      : await state.withExecutionTiming(identity, action, { phase: 'ledger_dual_run', onDiagnostic, minMs: 0, slowMs: 600_000 });
    return { label, seamID, ok: true, value: encodeValue(await settleStreams(value, how.chunks), census) };
  } catch (error) {
    return { label, seamID: seamID ?? state.take(), ok: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------- replay mode
function startImplementation({ libDir, implementation, workerData, instrumented }) {
  const listeners = new Set();
  const exits = new Set();
  const env = { ...process.env };
  if (implementation.kind === 'worker') {
    // As session-mutation-host.js starts it: the worker file beside the host,
    // the host's workerData, the host's (inherited) Node flags and environment
    // (a crash point reaches it through this process's own --require and env).
    const worker = new workerThreads.Worker(path.join(libDir, 'session-mutation-worker.js'), { workerData });
    worker.on('message', (message) => { for (const fn of listeners) fn(message); });
    worker.on('error', (error) => { note('exit', { error: describeError(error) }); });
    worker.on('exit', (code) => { note('exit', { code }); for (const fn of exits) fn(code); });
    return { post: (message) => worker.postMessage(message), onMessage: (fn) => listeners.add(fn), onExit: (fn) => exits.add(fn),
      stop: () => worker.terminate(), pid: process.pid };
  }
  // A ledger process over stdio: ledger-process.mjs (the product worker in a
  // process) or any executable that speaks the same protocol.
  const command = implementation.command ?? process.execPath;
  const commandArgs = implementation.args ?? [...(instrumented ? ['--require', path.join(here, 'ledger-preload.cjs')] : []), path.join(here, 'ledger-process.mjs'), libDir];
  const child = spawn(command, commandArgs, { env: { ...env, LEDGER_DUAL_RUN_LEDGER_PROCESS: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdout.on('data', lineReader((line) => { const message = decodeLine(line); for (const fn of listeners) fn(message); }));
  child.on('exit', (code, signal) => { note('exit', { code, signal }); for (const fn of exits) fn(code ?? signal); });
  child.stdin.on('error', () => {});
  child.stdin.write(encodeLine({ type: 'init', workerData }));
  return { post: (message) => { if (child.stdin.writable) child.stdin.write(encodeLine(message)); }, onMessage: (fn) => listeners.add(fn), onExit: (fn) => exits.add(fn),
    stop: () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } child.once('exit', resolve); child.stdin.end(); }),
    pid: child.pid };
}

async function startReplay({ libDir, implementation, workerData, instrumented }) {
  const endpoint = startImplementation({ libDir, implementation, workerData, instrumented });
  const pending = new Map(), pulls = new Map();
  state = { mode: 'replay', endpoint, pending, pulls, callbacks: new Map(), counting: new Map() };
  const post = (message) => { note('h2w', message); endpoint.post(message); };
  state.post = post;
  endpoint.onMessage((message) => {
    note('w2h', message);
    // `abort` after the same number of the call's own messages as in the
    // recording (progress, which follows timing, and chunks not counted).
    if (message && !['chunk', 'progress', 'result', 'ready'].includes(message.type)) {
      const owner = message.type === 'callback' ? (message.target?.call ?? message.target?.cause) : message.type === 'observe' ? message.cause : message.id;
      const counter = owner === undefined ? null : state.counting.get(owner);
      if (counter) { counter.left -= 1; if (counter.left === 0) { state.counting.delete(owner); counter.then(); } }
    }
    switch (message?.type) {
      case 'result': pending.get(message.id)?.(message); return;
      case 'callback': {
        // The host's observers (onChange, onMaterialize) return nothing: answered
        // as the host answers them, tied to a call or not.
        if (message.target?.observer !== undefined) { post({ type: 'callback-result', id: message.id, failed: false, value: undefined }); return; }
        const queue = state.callbacks.get(message.target?.call) ?? [];
        const answer = queue.shift();
        // An answer the recording does not have: the host would have had no
        // such function. The comparer reports the extra callback itself.
        post(answer ? { type: 'callback-result', id: message.id, ...answer }
          : { type: 'callback-result', id: message.id, failed: true, error: { __devryanError: true, name: 'Error', message: 'mutation_runtime_unavailable', code: 'mutation_runtime_unavailable', status: 503 } });
        return;
      }
      case 'chunk': { const resolve = pulls.get(message.stream); pulls.delete(message.stream); resolve?.(message); return; }
      default:
    }
  });
  endpoint.onExit(() => {
    for (const [id, resolve] of pending) resolve({ type: 'result', id, failed: true, exited: true,
      error: { __devryanError: true, name: 'Error', message: 'mutation_runtime_unavailable', code: 'mutation_runtime_unavailable', status: 503 } });
    pending.clear();
    for (const resolve of pulls.values()) resolve({ done: true, exited: true });
    pulls.clear();
  });
}

const streamIDs = (value, found = []) => {
  if (Array.isArray(value)) { for (const item of value) streamIDs(item, found); return found; }
  if (value && typeof value === 'object') {
    if (typeof value.__devryanStream === 'number') { found.push(value.__devryanStream); return found; }
    for (const entry of Object.values(value)) streamIDs(entry, found);
  }
  return found;
};

// Replays one call as the recording's host made it: the same `call` (its
// deadline re-based on this clock), the recorded answers to its input
// functions, `abort` after as many of the call's own messages as the host
// had seen, and per result stream as many pulls as the host made, then
// `stream-return` if it stopped early.
async function replayCall({ label, message, answers, conduct = {}, deadlineOffset = null }) {
  const call = decodeValue(message);
  if (Number.isFinite(deadlineOffset) && call.context) call.context = { ...call.context, deadline: Date.now() + deadlineOffset };
  state.callbacks.set(call.id, (answers ?? []).map((answer) => decodeValue(answer)));
  const abortAfter = Number.isInteger(conduct.abortAfter) ? conduct.abortAfter : null;
  const abort = () => state.post({ type: 'abort', id: call.id, reason: { __devryanError: true, name: 'Error', message: 'ledger_dual_run_aborted', code: 'ledger_dual_run_aborted' } });
  const result = await new Promise((resolve) => {
    state.pending.set(call.id, resolve);
    if (abortAfter !== null && abortAfter > 0) state.counting.set(call.id, { left: abortAfter, then: abort });
    state.post(call);
    if (abortAfter === 0) abort();
  });
  state.pending.delete(call.id);
  state.counting.delete(call.id);
  if (!result.failed) {
    const plan = conduct.streams ?? [];
    for (const [index, stream] of streamIDs(result.value).entries()) {
      const limit = plan[index] ?? null;
      for (let pulls = 0; ; pulls += 1) {
        if (limit && pulls >= limit.pulls) { if (limit.returned) state.post({ type: 'stream-return', stream }); break; }
        const chunk = await new Promise((resolve) => { state.pulls.set(stream, resolve); state.post({ type: 'pull', stream }); });
        if (chunk.done || chunk.error || chunk.exited) break;
      }
    }
  }
  return { label, seamID: call.id, exited: result.exited === true };
}

// A live call (no recording): contention between implementations.
let nextInvoke = 1_000_000;
async function invokeCall({ label, method, args }) {
  const id = nextInvoke++;
  const result = await new Promise((resolve) => { state.pending.set(id, resolve); state.post({ type: 'call', id, method, input: decodeValue(args), context: null }); });
  state.pending.delete(id);
  return { label, seamID: id, ok: !result.failed, value: result.failed ? null : encodeValue(result.value, census), error: result.failed ? result.error : null, exited: result.exited === true };
}

// ---------------------------------------------------------------- commands
process.on('message', async (command) => {
  try {
    switch (command.op) {
      case 'init':
        if (command.mode === 'record') await startRecord(command);
        else await startReplay(command);
        send({ op: 'ready', pid: process.pid, ledgerPid: state.endpoint?.pid ?? process.pid });
        return;
      case 'call': send({ op: 'done', ...(await recordCall(command)) }); return;
      case 'replay': send({ op: 'done', ...(await replayCall(command)) }); return;
      case 'invoke': send({ op: 'done', ...(await invokeCall(command)) }); return;
      case 'replay-group':
        for (const call of command.calls) {
          replayCall(call).then((reply) => send({ op: 'done', ...reply }),
            (error) => send({ op: 'done', label: call.label, seamID: null, exited: true, error: describeError(error) }));
        }
        return;
      case 'log': {
        const entries = log.splice(0);
        const extra = state?.mode === 'record' ? { observed: state.observed, workerData: encodeValue(state.workerData, census) } : {};
        if (state?.mode === 'record') state.observed = { diagnostics: [], changes: [], materialized: [], lockTimings: [] };
        send({ op: 'log', entries, census: census.counts, ...extra });
        return;
      }
      case 'stop-ledger': {
        // Ends the ledger, keeps this host process (the worker-death case).
        if (state.mode === 'record') await Promise.all(state.workers.map((worker) => worker.terminate()));
        else await state.endpoint.stop();
        send({ op: 'stopped' });
        return;
      }
      case 'close': {
        if (state?.mode === 'record') await state.host.close?.();
        else await state?.endpoint?.stop();
        send({ op: 'closed' });
        process.disconnect();
        return;
      }
      default: send({ op: 'error', error: `unknown op ${command.op}` });
    }
  } catch (error) {
    send({ op: 'error', error: describeError(error), stack: error?.stack });
  }
});
process.on('disconnect', () => process.exit(0));
