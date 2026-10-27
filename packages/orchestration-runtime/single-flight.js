/** Detach one observer; the operation retains its own lifetime/budget. */
export const waitForSharedOperation = (operation, { signal } = {}) => {
  if (!signal) return Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new Error('Observation cancelled'));
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

export const createKeyedSingleFlight = () => {
  const pending = new Map();

  const run = (key, operation, { signal } = {}) => {
    if (typeof key !== 'string' || !key) {
      throw new TypeError('single-flight key must be a non-empty string');
    }
    if (typeof operation !== 'function') {
      throw new TypeError('single-flight operation must be a function');
    }

    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Observation cancelled'));
    const existing = pending.get(key);
    if (existing) return signal ? waitForSharedOperation(existing, { signal }) : existing;

    // Start through a promise turn so a synchronous operation failure is shared
    // by every overlapping caller and follows the same cleanup path as a normal
    // asynchronous rejection.
    const promise = Promise.resolve().then(operation);
    pending.set(key, promise);

    const cleanup = () => {
      if (pending.get(key) === promise) pending.delete(key);
    };
    void promise.then(cleanup, cleanup);
    return signal ? waitForSharedOperation(promise, { signal }) : promise;
  };

  return Object.freeze({ run });
};
