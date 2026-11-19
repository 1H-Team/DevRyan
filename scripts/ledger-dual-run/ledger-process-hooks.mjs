// Module resolution hook for ledger-process.mjs: only the product's worker
// file gets the stdio-backed `node:worker_threads`; every other import,
// including that module for anything else, resolves normally.
let workerURL = '', shimURL = '';
export function initialize(data) { ({ workerURL, shimURL } = data); }
export async function resolve(specifier, context, next) {
  if ((specifier === 'node:worker_threads' || specifier === 'worker_threads') && context.parentURL === workerURL) {
    return { url: shimURL, shortCircuit: true };
  }
  return next(specifier, context);
}
