// The product's ledger worker (packages/harness-runtime/lib/session-mutation-worker.js,
// unchanged) as a process of its own, speaking the seam protocol over stdio:
// the transport a native ledger process implements (see stdio-protocol in
// docs/TESTING.md, "Ledger dual-run harness").
//
//   node ledger-process.mjs <lib directory>
//
// stdin: one JSON line per host -> ledger message, the first being
//   {"type":"init","workerData":{...}} (what the host passes as workerData);
// stdout: one JSON line per ledger -> host message (`ready` first). Values use
// the tagged JSON of dual-run-codec.mjs. stderr is free for logs. The process exits
// when stdin closes.
//
// A module hook gives the worker file a `node:worker_threads` whose
// `parentPort` is this pipe and whose `workerData` came from `init`; every
// other module, the worker file included, is the product's own.
import * as nodeModule from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeLine, encodeLine, lineReader } from './dual-run-codec.mjs';

const libDirectory = path.resolve(process.argv[2] ?? '');
const workerURL = pathToFileURL(path.join(libDirectory, 'session-mutation-worker.js')).href;
const shimURL = new URL('./worker-threads-shim.mjs', import.meta.url).href;
// In-thread hooks where Node has them (22.15+), else the off-thread form.
const redirect = (specifier, context) => (specifier === 'node:worker_threads' || specifier === 'worker_threads') && context.parentURL === workerURL;
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ resolve: (specifier, context, next) => (redirect(specifier, context) ? { url: shimURL, shortCircuit: true } : next(specifier, context)) });
} else {
  nodeModule.register(new URL('./ledger-process-hooks.mjs', import.meta.url).href, { data: { workerURL, shimURL } });
}

// stdout carries the protocol only; anything the ledger would print goes to stderr.
const writeProtocol = process.stdout.write.bind(process.stdout);
for (const name of ['log', 'info', 'debug']) console[name] = (...args) => console.error(...args);
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);

const listeners = new Set();
const queued = [];
// The harness preload (when loaded) scopes each call's work to its seam call.
const dispatch = (message) => {
  const run = () => { for (const fn of listeners) fn(message); };
  const scope = globalThis.__ledgerDualRunCallScope;
  return scope ? scope(message, run) : run();
};
const port = {
  postMessage: (message) => { writeProtocol(encodeLine(message)); },
  on(event, listener) {
    if (event !== 'message') return port;
    listeners.add(listener);
    if (queued.length) setImmediate(() => { for (const message of queued.splice(0)) dispatch(message); });
    return port;
  },
};
let started = null;
const onLine = (line) => {
  const message = decodeLine(line);
  if (!started) {
    if (message?.type !== 'init') throw new Error('ledger-process: the first message must be init');
    globalThis.__ledgerDualRunPort = { parentPort: port, workerData: message.workerData ?? {} };
    started = import(workerURL);
    started.catch((cause) => { console.error(cause); process.exit(70); });
    return;
  }
  if (!listeners.size) { queued.push(message); return; }
  dispatch(message);
};
process.stdin.on('data', lineReader(onLine));
process.stdin.on('end', () => process.exit(0));
