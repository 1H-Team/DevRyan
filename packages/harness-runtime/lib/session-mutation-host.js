import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { captureExecutionContext, remoteExecutionTarget } from './execution-admission.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { decodeWireError, decodeWireValue, encodeWireError, encodeWireValue } from './session-mutation-wire.js';

// The session mutation runtime behind a worker thread of this process (not a
// sidecar): the same methods, results and errors as
// createSessionMutationRuntime, with ledger work off the host's event loop.
// In the 2026-10-24 live QA, two parallel editing subagents drove the Electron
// main thread to 231% CPU while it also served UI IPC and SSE.
//
// Each call carries the caller's execution context (deadline, cancellation,
// journal reports, progress meter, summary steps); the worker runs it in an
// equivalent context and forwards progress and steps back, so admission, idle
// and stall timers see remote work exactly like local work. Functions in an
// input (a native permit guard, a removal's `beforeCommit`) and the observers
// run here; result streams (receipt bytes) are pulled on demand.
// `onWorkerStall` observes stalls of 1 s or more of the worker's own event
// loop (`stallClock: { tickMs, stallMs }` tunes that clock for tests); inline,
// the host's stall clock already covers the ledger.
//
// If the worker exits, pending calls fail with `mutation_runtime_unavailable`
// and the next call starts a new worker; durable recovery runs under the next
// lock, as after a host crash. Inline (no worker): DEVRYAN_LEDGER_WORKER=0,
// Windows, a Windows owner or launcher, or an injected Git runner (tests).
// Under Bun (development servers and `bun test`) the runtime stays inline
// unless DEVRYAN_LEDGER_WORKER=1: the packaged host is Electron's Node, and
// `bun test` ends a test body early around `expect(promise).rejects`, then
// terminates the worker under the still-pending call.
export const SESSION_MUTATION_METHODS = Object.freeze(['projectDirectories', 'projectDirectory', 'assertAdmission', 'registerNativeSession',
  'nativeAdmissionState', 'holdNativeAdmission', 'releaseNativeAdmission', 'recoverNativeTransientHolds', 'beginNativeRemoval',
  'recoverNativeRemovalOwnership', 'abandonQuietNativeRemoval', 'nativeRetentionHolds', 'commitNativeRemoval', 'prepareNativeRemovalMembers',
  'nativeRemoval', 'nativeRemovals', 'stageNativeRemovalMember', 'acknowledgeNativeRemoval', 'completeNativeRemoval', 'deferNativeContinuation',
  'nativeContinuations', 'nativeShellContinuations', 'nativeExecutionContinuations', 'nativeTransactionHolds', 'acknowledgeNativeContinuation',
  'bindNativeShellJob', 'nativeShellJob', 'bindNativeShellNotification', 'acknowledgeNativeShellCompletion', 'registerPrompt', 'reservePromptBoundary', 'pendingPromptBoundary', 'registerChild', 'prewarmView',
  'reserve', 'prepare', 'warm', 'begin', 'admitDirect', 'finishDirect', 'claimLease', 'finish', 'cleanupLease', 'executionReceipt', 'aliasCalls',
  'prepareRevert', 'prepareRedo', 'previewFileRestore', 'prepareFileRestore', 'settleRevert', 'leaseForCall', 'transaction', 'updateTransaction', 'pendingTransactions',
  'capturedSessionState', 'restoreForeign', 'cancelLease', 'cancelUnstartedCall', 'activeLeases', 'pendingCleanup', 'executionOutcomes',
  'viewFreshness', 'maintainLedger', 'drain']);

export const sessionMutationWorkerEnabled = (options = {}) => {
  const setting = process.env.DEVRYAN_LEDGER_WORKER;
  if (setting === '0' || process.platform === 'win32' || options.windowsOwner || options.windowsLauncher || options.gitRunner) return false;
  return setting === '1' || !process.versions.bun;
};

// Packaged apps load this module from app.asar; the worker script is one of
// the unpacked files beside it.
const workerScript = () => {
  const file = fileURLToPath(new URL('./session-mutation-worker.js', import.meta.url));
  const unpacked = file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return unpacked !== file && existsSync(unpacked) ? unpacked : file;
};

// A worker inherits the host's Node flags. Those that describe an inline entry
// (`node --input-type=module -e …`) are invalid for a file entry and fail the
// worker before it loads, so they are dropped. Otherwise the flags stay
// inherited: an explicit list is validated, and Node rejects process-wide
// flags in it that it silently skips when inheriting.
const ENTRY_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const entryFlag = (arg) => arg.startsWith('--input-type') || ENTRY_FLAGS.has(arg) || /^(?:--eval|--print)=/.test(arg);
export const workerExecArgv = (argv = process.execArgv) => (argv.some(entryFlag)
  ? argv.filter((arg, index) => !entryFlag(arg) && !ENTRY_FLAGS.has(argv[index - 1]))
  : undefined);

const unavailable = (cause) => Object.assign(new Error('mutation_runtime_unavailable', cause ? { cause } : undefined),
  { code: 'mutation_runtime_unavailable', status: 503 });

export function createSessionMutationHost(options = {}) {
  if (!sessionMutationWorkerEnabled(options)) return createSessionMutationRuntime(options);
  const { onChange, onMaterialize, onDiagnostic, onLockTiming, onWorkerStall } = options;
  const observers = { onChange, onMaterialize, onDiagnostic, onLockTiming, onWorkerStall };
  let worker = null, nextCall = 1, nextFunction = 1;
  const calls = new Map(), pulls = new Map();
  let closed = false;
  // Only outstanding work keeps the host process alive.
  const hold = () => { if (!worker) return; if (calls.size || pulls.size) worker.ref(); else worker.unref(); };
  const fail = (cause) => {
    const error = unavailable(cause);
    for (const call of calls.values()) { call.settle(); call.reject(error); }
    calls.clear();
    for (const pending of pulls.values()) pending.reject(error);
    pulls.clear();
  };
  const post = (message) => worker?.postMessage(message);
  // Host-side functions run in the context of the call that caused them, as
  // they would inline: a native permit guard asserts its controller there.
  const inContext = (callID, action) => {
    const run = calls.get(callID)?.context;
    return run ? run(action) : action();
  };
  const onMessage = async (message) => {
    switch (message?.type) {
      case 'result': {
        const call = calls.get(message.id);
        if (!call) return;
        calls.delete(message.id);
        call.target.steps(message.steps ?? []);
        call.settle();
        if (message.failed) call.reject(decodeWireError(message.error));
        else call.resolve(decodeWireValue(message.value, { toStream }));
        hold();
        return;
      }
      case 'report': calls.get(message.id)?.target.report(message.record); return;
      case 'progress': calls.get(message.id)?.target.progress({ waiting: message.waiting === true }); return;
      case 'observe': try { inContext(message.cause, () => observers[message.observer]?.(message.payload)); } catch { /* Observer only. */ } return;
      case 'callback': {
        const { id, target } = message;
        try {
          const fn = target?.observer ? observers[target.observer] : calls.get(target?.call)?.functions.get(target?.fn);
          if (typeof fn !== 'function') throw unavailable();
          const args = decodeWireValue(message.args ?? []);
          const value = await inContext(target?.call ?? target?.cause, () => fn(...args));
          post({ type: 'callback-result', id, failed: false, value: encodeWireValue(value) });
        } catch (cause) { post({ type: 'callback-result', id, failed: true, error: encodeWireError(cause) }); }
        return;
      }
      case 'chunk': {
        const pending = pulls.get(message.stream);
        if (!pending) return;
        pulls.delete(message.stream);
        hold();
        if (message.error) pending.reject(decodeWireError(message.error)); else pending.resolve(message);
        return;
      }
      default:
    }
  };
  const start = () => {
    if (worker) return worker;
    if (closed) throw unavailable();
    const current = new Worker(workerScript(), { ...(workerExecArgv() ? { execArgv: workerExecArgv() } : {}), workerData: {
      directory: options.directory,
      ...(options.maintenance ? { maintenance: options.maintenance } : {}),
      ...(options.batching ? { batching: options.batching } : {}),
      ...(options.complexity ? { complexity: options.complexity } : {}),
      ...(options.stallClock ? { stallClock: options.stallClock } : {}),
      observers: Object.fromEntries(Object.entries(observers).map(([name, fn]) => [name, typeof fn === 'function'])),
    } });
    worker = current;
    current.on('message', onMessage);
    const stop = (cause) => { if (worker !== current) return; worker = null; fail(cause); };
    current.on('error', stop);
    current.on('exit', (code) => stop(code ? Object.assign(new Error(`worker exited with ${code}`), { code: 'worker_exit' }) : undefined));
    current.unref();
    return current;
  };
  const toStream = (stream) => (async function* () {
    let finished = false;
    try {
      for (;;) {
        const chunk = await new Promise((resolve, reject) => {
          pulls.set(stream, { resolve, reject });
          hold();
          post({ type: 'pull', stream });
        });
        if (chunk.done) { finished = true; return; }
        yield Buffer.isBuffer(chunk.value) || !(chunk.value instanceof Uint8Array) ? chunk.value
          : Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
      }
    } finally { if (!finished) post({ type: 'stream-return', stream }); }
  })();
  const call = (method, args) => new Promise((resolve, reject) => {
    const target = remoteExecutionTarget();
    try { target.signal?.throwIfAborted(); } catch (cause) { reject(cause); return; }
    let current;
    try { current = start(); } catch (cause) { reject(cause); return; }
    const id = nextCall++, functions = new Map();
    let input;
    try { input = encodeWireValue(args, { onFunction: (fn) => { const fnID = nextFunction++; functions.set(fnID, fn); return fnID; } }); }
    catch (cause) { reject(cause); return; }
    const onAbort = () => post({ type: 'abort', id, reason: encodeWireError(target.signal.reason) });
    target.signal?.addEventListener('abort', onAbort, { once: true });
    calls.set(id, { target, functions, resolve, reject, context: AsyncLocalStorage.snapshot(),
      settle: () => { target.signal?.removeEventListener('abort', onAbort); target.settle(); } });
    hold();
    current.postMessage({ type: 'call', id, method, input, context: captureExecutionContext() });
  });
  const host = Object.fromEntries(SESSION_MUTATION_METHODS.map((method) => [method, (...args) => call(method, args)]));
  // Diagnostics: whether the worker runs, its outstanding calls and its heap
  // (the ledger's caches live there, not in the host's heap).
  host.workerStatus = async () => {
    const current = worker;
    const heap = current ? await current.getHeapStatistics?.().catch(() => null) : null;
    const mb = (bytes) => (Number.isFinite(bytes) ? Math.round(bytes / 1024 / 1024) : null);
    return { running: Boolean(current), pendingCalls: calls.size, heapUsedMB: mb(heap?.used_heap_size), heapTotalMB: mb(heap?.total_heap_size) };
  };
  // Tests and host shutdown: stops the worker; later calls fail.
  host.close = async () => {
    closed = true;
    const current = worker;
    worker = null;
    fail();
    await current?.terminate();
  };
  return host;
}
