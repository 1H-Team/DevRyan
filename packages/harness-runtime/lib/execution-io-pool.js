import { executionSignal, withExecutionSlotWait } from './execution-admission.js';

// One FIFO across every preparation/observer of the canonical project. Waiting
// owns no filesystem operation and can be cancelled without leaving queued work.
const pools = new Map();
export async function withExecutionIO(root, action) {
  let pool = pools.get(root);
  if (!pool) { pool = { active: 0, pending: [] }; pools.set(root, pool); }
  const signal = executionSignal(); signal?.throwIfAborted();
  await withExecutionSlotWait(() => new Promise((resolve, reject) => {
    const row = { run: () => { signal?.removeEventListener('abort', abort); pool.active++; resolve(); } };
    const abort = () => { const index = pool.pending.indexOf(row); if (index >= 0) pool.pending.splice(index, 1); reject(signal.reason); };
    if (pool.active < 4) row.run();
    else { pool.pending.push(row); signal?.addEventListener('abort', abort, { once: true }); }
  }));
  try { signal?.throwIfAborted(); return await action(); }
  finally {
    pool.active--;
    pool.pending.shift()?.run();
    if (!pool.active && !pool.pending.length) pools.delete(root);
  }
}
