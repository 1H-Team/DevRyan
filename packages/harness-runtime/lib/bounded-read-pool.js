// Read-only work sharing. Callers authorize each subscriber before joining.
// The queue retains callbacks/keys, never fetched response bodies.
export function createBoundedReadPool({ concurrency = 2, maxQueued = 16 } = {}) {
  const entries = new Map();
  const queue = [];
  let active = 0;
  let closed = false;
  const unavailable = () => Object.assign(new Error('reconciliation_busy'), { code: 'reconciliation_busy', status: 503 });
  const pump = () => {
    while (!closed && active < concurrency && queue.length) {
      const entry = queue.shift();
      if (entry.controller.signal.aborted) { entry.reject(unavailable()); entries.delete(entry.key); continue; }
      active++;
      const release = () => {
        active--; entries.delete(entry.key); pump();
      };
      Promise.resolve().then(() => entry.run(entry.controller.signal)).then(
        (value) => { release(); entry.resolve(value); },
        (error) => { release(); entry.reject(error); },
      );
    }
  };
  return {
    run(key, run, signal) {
      if (closed || signal?.aborted) return Promise.reject(signal?.reason ?? unavailable());
      let entry = entries.get(key);
      if (entry?.controller.signal.aborted) return Promise.reject(unavailable());
      if (!entry) {
        if (queue.length >= maxQueued && active >= concurrency) return Promise.reject(unavailable());
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        entry = { key, run, promise, resolve, reject, controller: new AbortController(), subscribers: 0 };
        entries.set(key, entry); queue.push(entry); pump();
      }
      if (entry.subscribers >= 128) return Promise.reject(unavailable());
      entry.subscribers++;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true; signal?.removeEventListener('abort', abort);
          if (--entry.subscribers === 0) entry.controller.abort();
          fn(value);
        };
        const abort = () => finish(reject, signal.reason ?? unavailable());
        signal?.addEventListener('abort', abort, { once: true });
        entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
        if (signal?.aborted) abort();
      });
    },
    snapshot: () => ({ active, queued: queue.length, scopes: entries.size }),
    async drain() {
      closed = true;
      for (const entry of entries.values()) entry.controller.abort();
      for (const entry of queue.splice(0)) { entry.reject(unavailable()); entries.delete(entry.key); }
      await Promise.allSettled([...entries.values()].map((entry) => entry.promise));
    },
  };
}
