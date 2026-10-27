const SERVER_STREAM_GRACE_MS = 1000;

export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    globalMessageStreamHub,
    sessionRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    getManagedOrchestrationRuntime,
    getBrowserLeaseRuntime,
    getCursorSdkRuntime,
    getSessionExecutionHost,
    getSessionTitleRuntime,
    shouldSkipOpenCodeStop,
    getOpenCodePort,
    getOpenCodeProcess,
    setOpenCodeProcess,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
    getHarnessRuntime,
    closeNativeRuntime,
    closeFeatureRoutes,
    onShutdownComplete,
  } = dependencies;

  const gracefulShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();
    const harnessRuntime = typeof getHarnessRuntime === 'function' ? getHarnessRuntime() : null;
    harnessRuntime?.beginDrain?.();
    // Native close needs the journal, scheduler and private execution bridge
    // alive until its scope, supervisors and durable ACK barrier have settled.
    if (closeNativeRuntime || closeFeatureRoutes) {
      try { await closeNativeRuntime?.(); await closeFeatureRoutes?.(); }
      catch (cause) {
        // Admission stays drained, but a refused native settlement must be
        // retryable once its owner confirms exit and durable recovery.
        setIsShuttingDown(false);
        syncToHmrState();
        throw cause;
      }
    }

    openCodeWatcherRuntime.stop();
    globalMessageStreamHub?.stop();
    sessionRuntime.dispose();
    scheduledTasksRuntime?.stop?.();

    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) {
      clearHealthCheckInterval(healthCheckInterval);
    }

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try {
        await terminalRuntime.shutdown();
      } catch {
      } finally {
        setTerminalRuntime(null);
      }
    }

    const messageStreamRuntime = getMessageStreamRuntime();
    if (messageStreamRuntime) {
      try {
        await messageStreamRuntime.close();
      } catch {
      } finally {
        setMessageStreamRuntime(null);
      }
    }

    if (harnessRuntime && typeof harnessRuntime.drain === 'function') {
      let harnessDrainTimeout = null;
      try {
        await Promise.race([
          harnessRuntime.drain(),
          new Promise((resolve) => {
            harnessDrainTimeout = setTimeout(() => {
              console.warn('Harness drain timeout reached, continuing shutdown');
              resolve();
            }, 5000);
          }),
        ]);
      } catch (error) {
        console.warn('Error draining harness runtime:', error);
      } finally {
        if (harnessDrainTimeout) clearTimeout(harnessDrainTimeout);
      }
    }

    const browserLeaseRuntime = typeof getBrowserLeaseRuntime === 'function'
      ? getBrowserLeaseRuntime()
      : null;
    if (browserLeaseRuntime && typeof browserLeaseRuntime.closeAll === 'function') {
      try {
        await browserLeaseRuntime.closeAll('shutdown');
      } catch (error) {
        console.warn('Error stopping agent browser leases:', error);
      }
    }

    const managedOrchestrationRuntime = typeof getManagedOrchestrationRuntime === 'function'
      ? getManagedOrchestrationRuntime()
      : null;
    if (managedOrchestrationRuntime && typeof managedOrchestrationRuntime.shutdown === 'function') {
      try {
        await managedOrchestrationRuntime.shutdown();
      } catch (error) {
        console.warn('Error stopping managed orchestration runtime:', error);
      }
    }

    const cursorSdkRuntime = typeof getCursorSdkRuntime === 'function' ? getCursorSdkRuntime() : null;
    if (cursorSdkRuntime && typeof cursorSdkRuntime.dispose === 'function') {
      try {
        await cursorSdkRuntime.dispose();
      } catch {
      }
    }

    const executionHost = getSessionExecutionHost?.();
    if (executionHost) {
      try { await executionHost.drain(); }
      catch (error) { console.warn('Error draining execution preparation:', error?.code || 'execution_cleanup_failed'); }
    }

    const sessionTitleRuntime = typeof getSessionTitleRuntime === 'function'
      ? getSessionTitleRuntime()
      : null;
    if (sessionTitleRuntime && typeof sessionTitleRuntime.dispose === 'function') {
      try {
        await sessionTitleRuntime.dispose();
      } catch (error) {
        console.warn('Error stopping session title runtime:', error);
      }
    }

    if (closeNativeRuntime) {
      setOpenCodeProcess(null);
    } else if (!shouldSkipOpenCodeStop()) {
      const openCodeProcess = getOpenCodeProcess();

      if (openCodeProcess) {
        console.log('Stopping OpenCode process...');
        let openCodeCloseTimeout = null;
        try {
          await Promise.race([
            openCodeProcess.close(),
            new Promise((resolve) => {
              openCodeCloseTimeout = setTimeout(() => {
                console.warn('OpenCode close timeout reached, continuing shutdown');
                resolve();
              }, Math.min(shutdownTimeoutMs, 4000));
            }),
          ]);
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        } finally {
          if (openCodeCloseTimeout) {
            clearTimeout(openCodeCloseTimeout);
          }
        }
        setOpenCodeProcess(null);
      }

    } else {
      console.log('Skipping OpenCode shutdown (external server)');
    }

    const server = getServer();
    if (server) {
      let closeTimeout = null, streamTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
            // Live streams (the desktop renderer's events) never end on their
            // own, so close used to wait out the whole shutdown bound, longer
            // than the desktop updater's cleanup bound. End them after a grace.
            server.closeIdleConnections?.();
            streamTimeout = setTimeout(() => server.closeAllConnections?.(), Math.min(shutdownTimeoutMs, SERVER_STREAM_GRACE_MS));
          }),
          new Promise((resolve) => {
            closeTimeout = setTimeout(() => {
              console.warn('Server close timeout reached, forcing shutdown');
              resolve();
            }, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) {
          clearTimeout(closeTimeout);
        }
        if (streamTimeout) clearTimeout(streamTimeout);
      }
    }

    // A failing auth disposal still rejects shutdown, but never before the
    // tunnel is stopped (an orphaned cloudflared outlives this host).
    try {
      const uiAuthController = getUiAuthController();
      if (uiAuthController) {
        await uiAuthController.dispose();
        setUiAuthController(null);
      }
    } finally {
      const activeTunnelController = getActiveTunnelController();
      if (activeTunnelController) {
        console.log('Stopping active tunnel...');
        void Promise.resolve(activeTunnelController.stop())
          .catch((error) => console.warn('Error stopping active tunnel:', error?.message || error));
        setActiveTunnelController(null);
        // Restart suspends transport; only the explicit Stop action revokes
        // durable tunnel grants and sessions.
        if (tunnelAuthController.suspendActiveTunnel) tunnelAuthController.suspendActiveTunnel();
        else tunnelAuthController.clearActiveTunnel();
      }
    }

    console.log('Graceful shutdown complete');
    onShutdownComplete?.();
    if (exitProcess) {
      process.exit(0);
    }
  };

  return {
    gracefulShutdown,
  };
};
