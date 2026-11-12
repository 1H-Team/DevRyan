// Harness-owned toy timer module (self-test corpus of the client conformance
// harness): a debouncer that batches items behind a timer, flushes early on
// request (clearing the timer) and runs a heartbeat interval. It reads
// Date.now() and performance.now(). Product code never imports it.
let created = 0;

export function snapshotState() {
  return { created };
}

export function createDebouncer({ delay, onFlush }) {
  created += 1;
  let pending = [];
  let timer = null;
  let flushedAt = null;
  const flush = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const batch = pending;
    pending = [];
    if (batch.length === 0) return 0;
    flushedAt = Date.now();
    onFlush(batch, flushedAt);
    return batch.length;
  };
  return {
    push(item) {
      pending.push({ item, at: Date.now() });
      if (timer === null) timer = setTimeout(flush, delay);
      return pending.length;
    },
    flush,
    heartbeat(interval) {
      const id = setInterval(() => { onFlush([], performance.now()); }, interval);
      return () => clearInterval(id);
    },
    state() { return { pending: pending.length, armed: timer !== null, flushedAt }; },
  };
}
