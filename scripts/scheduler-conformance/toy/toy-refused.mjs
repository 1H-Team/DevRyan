// A module whose hidden reads the recorder must refuse (target-refused.json
// names no site): a read at a line no site names, a read whose own frame a
// proper tail call removes, and reads in event listeners, which run outside
// any construction's chain, whichever case is running when they fire (one
// that built no scheduler, the hooks after the last test, after the
// recording was written). `directId` is a helper the spec lets tests call
// directly: a test's call is no scheduler input, a product listener's is.
// (Its read is not in tail position: Bun folds `const id = ...; return id;` into a tail call, whose frame is gone.)
export const directId = () => {
  const id = globalThis.crypto.randomUUID(); // a helper tests may call
  return id.slice(0);
};

export const createManagedTaskScheduler = () => {
  const box = {};
  return {
    unnamed() {
      const id = globalThis.crypto.randomUUID();
      return id.length;
    },
    tail() {
      return globalThis.crypto.randomUUID();
    },
    listen(signal) {
      signal.addEventListener('abort', () => { box.id = globalThis.crypto.randomUUID(); });
      return true;
    },
    listenEnv(signal) {
      signal.addEventListener('abort', () => { box.env = process.env.DEVRYAN_SCHEDULER_CONFORMANCE_REFUSED; });
      return true;
    },
    listenDirect(signal) {
      signal.addEventListener('abort', () => { box.direct = directId(); });
      return true;
    },
    seen() { return typeof box.id; },
  };
};
