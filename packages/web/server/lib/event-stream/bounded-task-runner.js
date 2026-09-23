/** Runs observational background work with bounded concurrency and backlog.
 * Callers never wait: when the backlog is full the oldest queued task is
 * dropped and counted, so a slow dependency cannot grow memory without bound. */
export function createBoundedTaskRunner({ concurrency = 64, maxQueued = 2_000, onError = () => {}, onDrop = () => {} } = {}) {
  const queue = [];
  let active = 0;
  let dropped = 0;
  const pump = () => {
    while (active < concurrency && queue.length) {
      const task = queue.shift();
      active += 1;
      Promise.resolve().then(task).catch(onError).finally(() => { active -= 1; pump(); });
    }
  };
  return Object.freeze({
    run(task) {
      if (typeof task !== 'function') return;
      queue.push(task);
      while (queue.length > maxQueued) {
        queue.shift(); dropped += 1;
        try { onDrop(dropped); } catch { /* Observer only. */ }
      }
      pump();
    },
    stats: () => ({ active, queued: queue.length, dropped }),
  });
}
