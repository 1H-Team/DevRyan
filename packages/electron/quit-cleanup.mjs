const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 10_000;

export const finishQuitAfterCleanup = async ({
  cleanupOwnedResources,
  afterCleanup,
  requestQuit,
  forceExit,
  relaunch = () => {},
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
      const result = cleanupOwnedResources();
      if (result && typeof result.then === 'function') await result;
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
      // installation while owned processes are still unsettled.
      onCleanupError(Object.assign(new Error('Update cleanup timed out; installation has not started.'), {
        code: 'update_cleanup_timeout',
      }));
      return 'blocked';
    }
    relaunch();
    forceExit();
    return 'forced';
  }

  cancelTimeout(timeoutHandle);
  if (result === 'failed') return 'blocked';
  // Runs only after cleanup settled in time. A cleanup that outlives its
  // timeout must not go on to start the installer or record the candidate
  // stopped: the owner reported 'blocked' and keeps running.
  if (afterCleanup) {
    try { await afterCleanup(); }
    catch (error) {
      try { onCleanupError(error); } catch { }
      if (owner === 'updater') return 'blocked';
    }
  }
  relaunch();
  requestQuit();
  return 'quit';
};

export { DEFAULT_QUIT_CLEANUP_TIMEOUT_MS };
