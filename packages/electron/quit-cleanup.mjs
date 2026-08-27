const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 10_000;

export const finishQuitAfterCleanup = async ({
  checkpointBotRuns = () => {},
  stopBotDispatcher = () => {},
  stopBotIndexerRequests = () => {},
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
    .then(async () => {
      let firstError = null;
      for (const operation of [
        checkpointBotRuns,
        stopBotDispatcher,
        stopBotIndexerRequests,
        cleanupOwnedResources,
      ]) {
        try {
          const result = operation();
          if (result && typeof result.then === 'function') await result;
        } catch (error) {
          firstError ||= error;
        }
      }
      if (firstError) throw firstError;
    })
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
