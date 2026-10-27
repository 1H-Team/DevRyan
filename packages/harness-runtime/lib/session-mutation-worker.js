// Worker thread that owns the session mutation ledger for its host process
// (session-mutation-host.js). Ledger work (reconciliation and view walks,
// hashing, ledger transactions and their Git processes) then never runs on the
// host's event loop, which in Electron also serves UI IPC and SSE. One worker
// owns every lock of the process, so the in-process lock queue stays exact.
import { AsyncLocalStorage } from 'node:async_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { runInRemoteExecutionContext } from './execution-admission.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { decodeWireError, decodeWireValue, encodeWireError, encodeWireValue } from './session-mutation-wire.js';

const port = parentPort;
if (!port) throw new Error('session-mutation-worker must run in a worker thread');

let nextCallback = 1, nextStream = 1;
const callbacks = new Map(), streams = new Map(), calls = new Map();
// The host call that caused the work in progress, so a host-side callback
// runs in that caller's own context (its permit guard, journal scope).
const activeCall = new AsyncLocalStorage();
// Host-side functions (an input's guard, a removal's `beforeCommit`, the
// runtime's observers) run in the host; their result returns here.
const callHost = (target, args) => new Promise((resolve, reject) => {
  const id = nextCallback++;
  callbacks.set(id, { resolve, reject });
  port.postMessage({ type: 'callback', id, target: { ...target, ...(target.call === undefined ? { cause: activeCall.getStore() } : {}) },
    args: encodeWireValue(args) });
});
const observe = (observer, payload) => port.postMessage({ type: 'observe', observer, payload, cause: activeCall.getStore() });
const observers = workerData?.observers ?? {};
const runtime = createSessionMutationRuntime({
  directory: workerData.directory,
  // This thread may block: walks use synchronous filesystem calls.
  synchronousWalks: true,
  ...(workerData.maintenance ? { maintenance: workerData.maintenance } : {}),
  ...(workerData.batching ? { batching: workerData.batching } : {}),
  ...(observers.onChange ? { onChange: (payload) => callHost({ observer: 'onChange' }, [payload]) } : {}),
  ...(observers.onMaterialize ? { onMaterialize: (row) => callHost({ observer: 'onMaterialize' }, [row]) } : {}),
  // Observers only: never awaited, as in the host.
  ...(observers.onDiagnostic ? { onDiagnostic: (record) => observe('onDiagnostic', record) } : {}),
  ...(observers.onLockTiming ? { onLockTiming: (timing) => observe('onLockTiming', timing) } : {}),
});
// A rejection nothing awaited is reported, not fatal: on the host's own event
// loop (Electron's main process) it only logs, and a worker exit would fail
// every call in flight.
process.on('unhandledRejection', (cause) => {
  if (observers.onDiagnostic) observe('onDiagnostic', { phase: 'ledger_worker', state: 'failed', code: typeof cause?.code === 'string' ? cause.code : 'unhandled_rejection' });
});
const methods = new Set(Object.keys(runtime).filter((name) => typeof runtime[name] === 'function'));

const encodeResult = (value) => encodeWireValue(value, { onStream: (iterable) => {
  const id = nextStream++;
  streams.set(id, iterable[Symbol.asyncIterator]());
  return id;
} });

port.on('message', async (message) => {
  switch (message?.type) {
    case 'call': {
      const { id, method } = message;
      if (!methods.has(method)) {
        port.postMessage({ type: 'result', id, failed: true, error: encodeWireError(Object.assign(new Error('mutation_method_unknown'), { code: 'mutation_method_unknown' })), steps: [] });
        return;
      }
      const controller = new AbortController();
      calls.set(id, controller);
      try {
        const input = decodeWireValue(message.input, { toFunction: (fn) => (...args) => callHost({ call: id, fn }, args) });
        const outcome = await runInRemoteExecutionContext(message.context, () => activeCall.run(id, () => runtime[method](...input)), {
          signal: controller.signal,
          onReport: (record) => port.postMessage({ type: 'report', id, record }),
          onProgress: (state) => port.postMessage({ type: 'progress', id, waiting: state.waiting }),
        });
        let value;
        try { value = outcome.failed ? undefined : encodeResult(outcome.result); }
        catch (cause) { outcome.failed = true; outcome.failure = cause; }
        port.postMessage({ type: 'result', id, failed: outcome.failed, value, steps: outcome.steps,
          ...(outcome.failed ? { error: encodeWireError(outcome.failure) } : {}) });
      } finally { calls.delete(id); }
      return;
    }
    case 'abort': calls.get(message.id)?.abort(decodeWireError(message.reason)); return;
    case 'callback-result': {
      const pending = callbacks.get(message.id);
      if (!pending) return;
      callbacks.delete(message.id);
      if (message.failed) pending.reject(decodeWireError(message.error)); else pending.resolve(decodeWireValue(message.value));
      return;
    }
    case 'pull': {
      const iterator = streams.get(message.stream);
      if (!iterator) { port.postMessage({ type: 'chunk', stream: message.stream, done: true }); return; }
      try {
        const step = await iterator.next();
        if (step.done) streams.delete(message.stream);
        port.postMessage({ type: 'chunk', stream: message.stream, done: Boolean(step.done), value: step.done ? undefined : step.value });
      } catch (cause) {
        streams.delete(message.stream);
        port.postMessage({ type: 'chunk', stream: message.stream, done: true, error: encodeWireError(cause) });
      }
      return;
    }
    case 'stream-return': {
      const iterator = streams.get(message.stream);
      streams.delete(message.stream);
      await iterator?.return?.().catch(() => {});
      return;
    }
    default:
  }
});
port.postMessage({ type: 'ready', methods: [...methods] });
