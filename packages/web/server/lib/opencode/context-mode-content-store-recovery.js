const CONTEXT_MODE_IOERR_PATTERNS = [
  /\bSQLITE_IOERR\b/i,
  /\bdisk I\/O error\b/i,
];

const PASSTHROUGH_METHODS = new Set(['cleanup', 'close', 'setDenyChecker']);

const failureText = (error) => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : '';
};

export const isRecoverableContextModeStoreError = (error) => (
  CONTEXT_MODE_IOERR_PATTERNS.some((pattern) => pattern.test(failureText(error)))
);

/**
 * Wrap a synchronous ContentStore without changing any successful method shape.
 * A failed generation is replaced at most once, so concurrent promise failures
 * from the same generation all reuse the same replacement handle.
 */
export const createRecoveringContentStore = ({ createStore, onRecovery = () => {} }) => {
  if (typeof createStore !== 'function') {
    throw new TypeError('createStore must be a function');
  }

  let currentStore = createStore();
  let generation = 0;
  let denyChecker;
  let closed = false;

  const replaceFailedGeneration = (failedStore, failedGeneration, error) => {
    if (closed) throw error;
    if (currentStore !== failedStore || generation !== failedGeneration) {
      return currentStore;
    }

    try {
      failedStore.close?.();
    } catch {
      // The handle is already poisoned. Closing is best-effort and must never
      // trigger file deletion or prevent reopening the same database.
    }

    const replacement = createStore();
    if (denyChecker !== undefined) replacement.setDenyChecker?.(denyChecker);
    currentStore = replacement;
    generation += 1;
    onRecovery({ generation, error });
    return replacement;
  };

  const invoke = (method, args, retryAllowed = true) => {
    const store = currentStore;
    const storeGeneration = generation;
    let result;
    try {
      result = Reflect.apply(store[method], store, args);
    } catch (error) {
      if (!retryAllowed || !isRecoverableContextModeStoreError(error)) throw error;
      const replacement = replaceFailedGeneration(store, storeGeneration, error);
      return Reflect.apply(replacement[method], replacement, args);
    }

    if (!result || typeof result.then !== 'function') return result;
    return result.catch((error) => {
      if (!retryAllowed || !isRecoverableContextModeStoreError(error)) throw error;
      const replacement = replaceFailedGeneration(store, storeGeneration, error);
      return Reflect.apply(replacement[method], replacement, args);
    });
  };

  return new Proxy({}, {
    get(_target, property) {
      if (property === 'setDenyChecker') {
        return (checker) => {
          denyChecker = checker;
          return currentStore.setDenyChecker?.(checker);
        };
      }
      if (property === 'close') {
        return (...args) => {
          closed = true;
          return Reflect.apply(currentStore[property], currentStore, args);
        };
      }
      if (property === 'cleanup') {
        return (...args) => Reflect.apply(currentStore[property], currentStore, args);
      }

      const value = currentStore[property];
      if (typeof value !== 'function') return value;
      return (...args) => invoke(property, args, !PASSTHROUGH_METHODS.has(property));
    },
  });
};
