// The first module of the thread proto-thread-process.mjs starts: redirects
// the product worker's import of its runtime to the conformance stub
// (proto-stub-runtime.mjs beside this file), as proto-js-process.mjs does
// for the stdio process, then loads the product's worker file, which reads
// this thread's real `parentPort` and `workerData`. What the worker posts is
// encoded here with the stdio transport's line codec, as the stdio process
// encodes it (an unencodable value throws the codec's error at the
// `postMessage` call), and the line crosses to the main thread as text: the
// thread supplies the real port's delivery, the transport stays stdio's. A
// runtime that refuses its options ends the thread with 70, as it ends the
// stdio process.
import * as nodeModule from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';
import { encodeLine } from '../ledger-dual-run/dual-run-codec.mjs';

const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message) => post(encodeLine(message));

const libDirectory = path.resolve(process.argv.at(-1) ?? '');
const workerURL = pathToFileURL(path.join(libDirectory, 'session-mutation-worker.js')).href;
const stubURL = new URL('./proto-stub-runtime.mjs', import.meta.url).href;
nodeModule.registerHooks({ resolve: (specifier, context, next) => (specifier === './session-mutations.js' && context.parentURL === workerURL
  ? { url: stubURL, shortCircuit: true } : next(specifier, context)) });
try { await import(workerURL); } catch (cause) { console.error(cause); process.exit(70); }
