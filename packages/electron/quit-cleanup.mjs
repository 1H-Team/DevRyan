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
  owner = 'app',
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
        return owner === 'updater' ? 'failed' : 'clean';
      },
    );

  const result = await Promise.race([cleanup, timeout]);
  if (result === 'timeout') {
    if (owner === 'updater') {
      // The installer owns the eventual quit. Never force-exit it or start
      // installation while checkpoints/owned processes are still unsettled.
      onCleanupError(Object.assign(new Error('Update cleanup timed out; installation has not started.'), {
        code: 'update_cleanup_timeout',
      }));
      return 'blocked';
    }
    forceExit();
    return 'forced';
  }

  cancelTimeout(timeoutHandle);
  if (result === 'failed') return 'blocked';
  requestQuit();
  return 'quit';
};

export { DEFAULT_QUIT_CLEANUP_TIMEOUT_MS };
