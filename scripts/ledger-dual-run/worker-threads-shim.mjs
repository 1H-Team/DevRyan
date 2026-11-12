// `node:worker_threads` as the product's ledger worker sees it inside
// ledger-process.mjs: the parent port is the stdio pipe.
const bridge = globalThis.__ledgerDualRunPort;
if (!bridge) throw new Error('worker-threads-shim: load the ledger through ledger-process.mjs');
export const parentPort = bridge.parentPort;
export const workerData = bridge.workerData;
export const isMainThread = false;
export const threadId = 0;
