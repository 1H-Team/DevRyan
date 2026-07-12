const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 10_000;

export const finishQuitAfterCleanup = async ({
  cleanupOwnedResources,
  requestQuit,
  forceExit,
  onCleanupError = () => {},
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  timeoutMs = DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
}) => {
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = scheduleTimeout(() => resolve('timeout'), timeoutMs);
    timeoutHandle?.unref?.();
  });
  const cleanup = Promise.resolve()
    .then(() => cleanupOwnedResources())
    .then(
      () => 'clean',
      (error) => {
        try {
          onCleanupError(error);
        } catch {
        }
        return 'clean';
      },
    );

  const result = await Promise.race([cleanup, timeout]);
  if (result === 'timeout') {
    forceExit();
    return 'forced';
  }

  cancelTimeout(timeoutHandle);
  requestQuit();
  return 'quit';
};

export { DEFAULT_QUIT_CLEANUP_TIMEOUT_MS };
