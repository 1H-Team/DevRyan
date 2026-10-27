/** Loads an ES module entry whose evaluation runs bootstrap work. A failed
 * evaluation is cached for the process lifetime: importing it again rethrows the
 * same error without re-running the module, so only a new process can retry it. */
export function createModuleEntryLoader(load) {
  let evaluationFailed = false;
  return {
    load: async () => {
      try {
        return await load();
      } catch (error) {
        evaluationFailed = true;
        throw error;
      }
    },
    requiresRelaunch: () => evaluationFailed,
  };
}

/** Startup Retry re-runs the desktop runtime in this process unless a cached
 * entry failure makes that impossible; then it relaunches the application. */
export function routeStartupRetry({ requiresRelaunch, relaunch, retryInProcess }) {
  if (requiresRelaunch()) {
    relaunch();
    return 'relaunch';
  }
  void retryInProcess();
  return 'in_process';
}
