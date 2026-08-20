export const createKeyedSingleFlight = () => {
  const pending = new Map();

  const run = (key, operation) => {
    if (typeof key !== 'string' || !key) {
      throw new TypeError('single-flight key must be a non-empty string');
    }
    if (typeof operation !== 'function') {
      throw new TypeError('single-flight operation must be a function');
    }

    const existing = pending.get(key);
    if (existing) return existing;

    // Start through a promise turn so a synchronous operation failure is shared
    // by every overlapping caller and follows the same cleanup path as a normal
    // asynchronous rejection.
    const promise = Promise.resolve().then(operation);
    pending.set(key, promise);

    const cleanup = () => {
      if (pending.get(key) === promise) pending.delete(key);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  };

  return Object.freeze({ run });
};
