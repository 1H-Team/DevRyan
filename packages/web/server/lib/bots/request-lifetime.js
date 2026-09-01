// Abort even when a transport or injected dependency ignores its signal. The
// underlying operation still receives the signal and owns late-result cleanup.
export const withBotAbort = (promise, signal) => {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
};

export const botRequestSignal = (signal, lifetime, timeoutMs = 15_000) => (
  AbortSignal.any([signal, lifetime, AbortSignal.timeout(timeoutMs)].filter(Boolean))
);
