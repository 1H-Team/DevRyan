#!/usr/bin/env node
// The product's ledger worker as a stdio process (the dual-run harness's
// ledger process), with the runtime it builds replaced by the conformance
// stub (proto-stub-runtime.mjs beside this file):
//
//   node proto-js-process.mjs <lib directory>
//
// Only the worker's own import of the runtime module is redirected; the
// execution context, the I/O pool and the wire codec are the product's.
import * as nodeModule from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const libDirectory = path.resolve(process.argv[2] ?? '');
const workerURL = pathToFileURL(path.join(libDirectory, 'session-mutation-worker.js')).href;
const stubURL = new URL('./proto-stub-runtime.mjs', import.meta.url).href;
const redirect = (specifier, context) => specifier === './session-mutations.js' && context.parentURL === workerURL;
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ resolve: (specifier, context, next) => (redirect(specifier, context) ? { url: stubURL, shortCircuit: true } : next(specifier, context)) });
} else {
  throw new Error('proto-js-process needs module.registerHooks (Node 22.15 or later)');
}
await import('../ledger-dual-run/ledger-process.mjs');
